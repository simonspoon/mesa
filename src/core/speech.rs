//! Speaking a piece of mesa text with the external `kokoro-rs` TTS binary.
//! Synthesis is a subprocess, not storage, so it lives beside `scripts.rs` and
//! `hooks.rs` and copies their shape. This is the **output** half of mesa's
//! speech; `core::listen` (mesa task 954) is its mirror, taking a browser's
//! recording in and handing text back via the external `auris` binary — the
//! audio path this module describes runs one way, but mesa's speech surface
//! as a whole does not.
//!
//! The load-bearing property: **the text is never a shell string and never an
//! argument**. It is written to the child's stdin (`kokoro-rs` reads stdin when
//! given no positional TEXT), which is stronger than `Command::arg` — a body
//! opening with `-o` or `--voice` cannot become an option, and a long body has
//! no `ARG_MAX` ceiling. There is no shell anywhere on this path.
//!
//! Audio comes back as bytes rather than being played on the host: the browser
//! that asked is the thing that should make noise, and under `serve --lan` the
//! host is a different machine entirely. `kokoro-rs -o -` is asked for a WAV on
//! stdout, the child is never timed out and never killed except when mesa can
//! no longer read its output at all (matching hooks/agents/scripts), and unlike
//! a script run a nonzero exit is **not** data — there is no audio to return,
//! so it is an `Err` the API answers `unavailable` with.
//!
//! The audio is **streamed, not collected** (task 816): `kokoro-rs` synthesises
//! sentence by sentence and writes each one as it lands, so a minute-long item
//! starts playing after the first few seconds instead of after the whole
//! render. [`start`] therefore blocks only until the WAV header is in hand —
//! which is also the last moment an outside-mesa failure can still be a 503 —
//! and hands back a channel the rest of the audio arrives on.
//!
//! Every pipe the child holds is drained by somebody for the child's whole
//! life: stdout by the reader below (even after the listener leaves), stderr by
//! its own thread. A pipe nobody reads fills at ~64 KiB and blocks the writer
//! forever, which is how a streaming reader deadlocks where a single
//! `wait_with_output` did not.

use std::io::{Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::OnceLock;
use std::thread::JoinHandle;

use tokio::sync::mpsc;

/// Bytes read from the synthesiser per chunk. Chunks are the unit the response
/// body is written in, so this trades syscalls against how promptly the first
/// audio reaches the browser; `kokoro-rs` writes in 4 KiB pieces.
const CHUNK: usize = 16 * 1024;

/// Cap on a drained stderr stream, shared with `listen.rs` — its `auris`
/// mirror. Only ever quoted back in an error message, so it takes the
/// `scripts::OUTPUT_CAP` size rather than anything larger.
pub(crate) const STDERR_CAP: usize = 64 * 1024;

/// Reads `reader` to EOF, keeping at most [`STDERR_CAP`] bytes. Bytes past the
/// cap are still read and discarded — never a reason to stop reading. A
/// child's stderr is drained on its own thread precisely so a chatty binary
/// can't block the writer forever on a full pipe; stopping short of EOF here
/// would reopen that same deadlock, just with a smaller backlog. Lossy UTF-8,
/// with the `scripts::capped` truncation marker appended when anything was
/// dropped.
pub(crate) fn drain_capped<R: Read>(mut reader: R) -> String {
    let mut kept = Vec::new();
    let mut total: usize = 0;
    let mut buf = [0u8; CHUNK];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        total += n;
        if kept.len() < STDERR_CAP {
            let room = STDERR_CAP - kept.len();
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
    }
    let cut = total > kept.len();
    // Cut at whatever byte the cap lands on — not, unlike `scripts::capped`,
    // snapped back to a char boundary. That is fine here: this only ever
    // feeds an error message, `String::from_utf8_lossy` turns a severed
    // multi-byte character into a single replacement character rather than
    // failing, and a cosmetic glyph at the very end of a diagnostic string is
    // not worth the extra bookkeeping.
    let mut s = String::from_utf8_lossy(&kept).into_owned();
    if cut {
        s.push_str("\n[truncated]");
    }
    s
}

/// Runs `cmd` with its stdio wired for a short, name-list-sized answer:
/// stdin closed, stdout and stderr both piped and both drained through
/// [`drain_capped`] for the child's whole life (stderr on its own thread, so
/// a chatty binary can't block on a full pipe the way `voices`/`models`'
/// callers already guard against for `start`). `None` on a spawn failure or a
/// nonzero exit; `Some` carries stdout, capped to [`STDERR_CAP`] bytes — a
/// bound on the *buffer* this reads into, not on how many names the answer
/// may claim to have (`MAX_VOICES`/`MAX_MODELS` filters the parsed list
/// afterwards, same as before this existed).
pub(crate) fn spawn_and_drain(mut cmd: Command) -> Option<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let stderr = child.stderr.take().expect("stderr was piped");
    let complaints = std::thread::spawn(move || drain_capped(stderr));
    let stdout = child.stdout.take().expect("stdout was piped");
    let out = drain_capped(stdout);
    let _ = complaints.join();
    let status = child.wait().ok()?;
    status.success().then_some(out)
}

/// Runs `bin args…` through [`spawn_and_drain`] and filters its stdout lines
/// into a bounded list of names — the shared body of `speech::voices` and
/// `listen::models`, which differ only in the binary, the argv, the name
/// shape and the cap. A spawn failure or nonzero exit is an empty list, same
/// as before this existed: "mesa could not ask", never "there are none".
pub(crate) fn list_names(
    bin: &str,
    args: &[&str],
    is_name: fn(&str) -> bool,
    max: usize,
) -> Vec<String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    let Some(out) = spawn_and_drain(cmd) else {
        return Vec::new();
    };
    out.lines()
        .map(str::trim)
        .filter(|line| is_name(line))
        .take(max)
        .map(str::to_string)
        .collect()
}

/// How many chunks may sit in the channel before the reader thread blocks.
/// Small on purpose: the backlog is memory, and a client that stopped
/// listening should stall the pipe rather than buffer a whole render.
const BACKLOG: usize = 8;

/// How far into the stream the `data` chunk header is still worth waiting for.
/// A WAV header is 44 bytes; a producer that has not reached `data` inside
/// 64 KiB is emitting something this module does not understand, and every byte
/// spent looking is a byte held back from the browser.
const HEADER_CAP: usize = 64 * 1024;

/// Ceiling on the no-WAV-header fallback below, which reads the whole of a
/// synthesiser's stdout when nothing recognisable as a `data` chunk turned up
/// within `HEADER_CAP`. That path can still carry a legitimate render — a
/// `data` chunk sitting past `HEADER_CAP` behind an oversized `LIST`/`fact`
/// chunk — so this is not a truncation point the way `STDERR_CAP` is: crossing
/// it is a failure of the whole call, never a shorter WAV handed back as if it
/// were complete.
const STDOUT_CAP: usize = 64 * 1024 * 1024;

/// The `data` length declared in a streamed WAV, whose real length is not
/// knowable when the header goes out. See [`fix_wav_sizes`]. Chosen so that the
/// RIFF size derived from it — this plus the header chunks ahead of the audio —
/// still fits in a positive `i32`, which is the property a strict player wants
/// of both fields.
const STREAM_DATA_LEN: u32 = 0x7fff_0000;

/// The TTS binary to run. `MESA_KOKORO_BIN` overrides it — the same test seam
/// as `agents::claude_bin`, and how `api-check.sh` drives this route against a
/// stub instead of a real 45 KB/second synthesiser.
pub fn kokoro_bin() -> String {
    std::env::var("MESA_KOKORO_BIN").unwrap_or_else(|_| "kokoro-rs".to_string())
}

/// The most voices [`voices`] will report. `kokoro-rs` ships ~54; the bound is
/// there so a binary that answers `--list-voices` with something else entirely
/// cannot fill a dropdown — and the JSON every Settings load carries — with its
/// output. It bounds what mesa *keeps*, not what the child may write: the
/// answer is collected before it is filtered.
const MAX_VOICES: usize = 500;

/// The voice names the installed synthesiser offers, asked of the binary
/// itself (`kokoro-rs --list-voices`, one name per line) — mesa ships no list
/// of its own, because a voice set belongs to the model on this machine.
///
/// Empty when the binary is missing, fails, or answers with something that
/// isn't a list of names: an empty list means "mesa cannot offer a choice
/// here", never "there are no voices". Callers must treat it as advisory —
/// [`start`] passes whatever voice it is given.
///
/// Cached for the life of the process: the call costs ~1s, the answer changes
/// only when the binary does, and it is read on every Settings page load.
/// `--no-download`: listing names must never become a model fetch. This runs
/// inside a `OnceLock`, so a call that blocks blocks every later caller for
/// the life of the process — there is no cheap timeout here, so the fix is
/// not to start anything that can hang. Both of the child's pipes are bounded
/// (`list_names` → `spawn_and_drain`), so a `--list-voices` that answers with
/// megabytes of noise costs one capped buffer, never an unbounded one.
pub fn voices() -> &'static [String] {
    static VOICES: OnceLock<Vec<String>> = OnceLock::new();
    VOICES.get_or_init(|| {
        list_names(
            &kokoro_bin(),
            &["--no-download", "--list-voices"],
            is_voice_name,
            MAX_VOICES,
        )
    })
}

/// Whether `name` is shaped like a voice: a bounded identifier that cannot be
/// mistaken for an option. The one spelling of the rule, shared by the
/// `--list-voices` filter above and the config editor's save-time check
/// (`core::config::validate_voice`), so mesa can never store a name it would
/// then refuse to recognise.
pub fn is_voice_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The sentence the Settings page's voice **test** button speaks (mesa task
/// 824), so a voice can be heard before it is saved. Mesa's own words, not
/// anything a user or agent wrote: this is the one text on this path that is
/// not a mesa record, and keeping it a constant is what makes the preview route
/// carry no caller-supplied body at all. Short on purpose — it is a sample, and
/// every sentence is seconds of synthesis.
pub const SAMPLE: &str = "This is how mesa will read your inbox items aloud.";

/// A synthesis in flight: WAV bytes in the order they must be written, the
/// first chunk being the (size-patched) header. An `Err` item is a read that
/// failed mid-render, which ends the response body abnormally rather than
/// passing truncated audio off as complete.
pub struct Speech {
    pub chunks: mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
}

impl Speech {
    /// A synthesis that is already over: one chunk, then end of body.
    fn once(bytes: Vec<u8>) -> Speech {
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(Ok(bytes)).expect("a fresh channel has room");
        Speech { chunks: rx }
    }
}

/// Starts synthesising `text` in `voice`, blocking only until the WAV header is
/// readable, and streams the audio from there. `Err` is a synthesiser that
/// produced no usable audio — the one failure the caller can still turn into a
/// status code.
///
/// `voice` is the user's configured voice (`core::config::speech_voice`, mesa
/// task 822) or `None` for "whatever the binary's own default is" — mesa does
/// not name a default of its own, so an unconfigured install runs the exact
/// argv it ran before the setting existed. The name is one `Command::arg`
/// after `-v`, never text spliced into anything.
///
/// Blocking: call it from `spawn_blocking`, not an async worker.
pub fn start(text: &str, voice: Option<&str>) -> Result<Speech, String> {
    let bin = kokoro_bin();
    let mut child = Command::new(&bin)
        // `-q`: progress output on stderr is noise we'd only ever quote back in
        // an error. `-o -`: WAV on stdout instead of the host's speakers.
        .args(["-q", "-o", "-"])
        .args(voice.map_or_else(Vec::new, |v| vec!["-v", v]))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    // Write stdin from a thread while stdout is drained: the audio is
    // megabytes, so writing inline would deadlock against a full stdout pipe on
    // the first body longer than a pipe buffer (`scripts.rs`/`hooks.rs` hold
    // the same line for the same reason).
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let payload = text.as_bytes().to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
    });
    // Drain stderr for the child's whole life, not just when we want to quote
    // it: a binary that says more than a pipe buffer's worth would otherwise
    // block there and never write the stdout byte this function is waiting for.
    let stderr = child.stderr.take().expect("stderr was piped");
    let complaints = std::thread::spawn(move || drain_capped(stderr));
    let mut stdout = child.stdout.take().expect("stdout was piped");

    // Read exactly far enough to patch the header, and no further: every byte
    // held here is a byte the browser is not yet playing.
    let mut head = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    while head.len() < HEADER_CAP && matches!(scan_header(&head), HeaderScan::NeedMore) {
        let n = match stdout.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                // The one early return that cannot ask the child anything: reap
                // it rather than leave a zombie for the life of `serve`.
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to read audio from {bin}: {e}"));
            }
        };
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buf[..n]);
    }

    // No WAV header in sight — end of output, or bytes this module does not
    // recognise (a failing binary printing on stdout looks exactly like that).
    // Fall back to the pre-816 shape: collect, and let the exit status decide
    // whether it was audio at all. Streaming is an optimisation for the case we
    // understand, never a reason to pass an error message off as `audio/wav`.
    if !matches!(scan_header(&head), HeaderScan::Ready(_)) {
        // Unlike the stderr drain, this path can legitimately carry real
        // audio — a `data` chunk that simply sat past `HEADER_CAP` behind an
        // oversized `LIST`/`fact` chunk — so `STDOUT_CAP` is a ceiling on a
        // runaway binary, not a truncation point: crossing it is an error,
        // never a shorter WAV. Still drained to EOF before `wait()`, exactly
        // like every other pipe here.
        let mut total = head.len();
        let mut buf = [0u8; CHUNK];
        loop {
            let n = match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            total += n;
            if head.len() < STDOUT_CAP {
                let room = STDOUT_CAP - head.len();
                head.extend_from_slice(&buf[..n.min(room)]);
            }
        }
        let status = child.wait();
        if total > head.len() {
            return Err(format!(
                "{bin} produced more than {STDOUT_CAP} bytes of unrecognised output"
            ));
        }
        let spoke = status.map(|s| s.success()).unwrap_or(false);
        if !spoke || head.is_empty() {
            return Err(failure(&bin, complaints));
        }
        // The whole buffer is in hand now, so a `data` chunk that was simply
        // further in than the cap is patchable after all — that is what the
        // pre-816 code did, and the placeholders are exactly what a strict
        // player refuses.
        fix_wav_sizes(&mut head);
        return Ok(Speech::once(head));
    }
    fix_wav_sizes(&mut head);
    Ok(Speech {
        chunks: stream(child, stdout, head),
    })
}

/// Pumps the rest of the render into a channel, chunk by chunk, and reaps the
/// child at the end.
fn stream(
    mut child: Child,
    mut stdout: ChildStdout,
    head: Vec<u8>,
) -> mpsc::Receiver<Result<Vec<u8>, std::io::Error>> {
    let (tx, rx) = mpsc::channel(BACKLOG);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        // Whether anyone is still listening. Once nobody is (stop, or a closed
        // tab) the audio is discarded — but reading does NOT stop: a
        // synthesiser whose stdout is never drained blocks on a full pipe and
        // hangs forever, taking this thread's `wait()` with it. Draining to EOF
        // is what makes "the in-flight synthesis finishes and its bytes are
        // discarded" (docs/inbox.md) actually true — including when the client
        // was already gone before the header went out.
        //
        // The header is the first thing on the wire; `BACKLOG` >= 1, so this
        // cannot block.
        let mut listening = tx.blocking_send(Ok(head)).is_ok();
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if listening && tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                        listening = false;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
        // A nonzero exit *after* audio is not reportable — the 200 went out
        // with the header — so the truncated audio is what the listener gets.
        let _ = child.wait();
    });
    rx
}

/// The error for a synthesiser that produced no audio: whatever it said on
/// stderr, or a bare failure. The child has already been waited on, so its
/// stderr is closed and the draining thread has finished.
fn failure(bin: &str, complaints: JoinHandle<String>) -> String {
    let said = complaints.join().unwrap_or_default();
    let said = said.trim();
    if said.is_empty() {
        format!("{bin} produced no audio")
    } else {
        format!("{bin} failed: {said}")
    }
}

#[derive(PartialEq, Debug)]
enum HeaderScan {
    /// The `data` chunk header is buffered, at this offset: sizes can be
    /// patched.
    Ready(usize),
    /// Not (yet) a RIFF/WAVE stream we understand — pass the bytes through.
    Passthrough,
    NeedMore,
}

/// Whether enough of the stream is in hand to patch its sizes. Walks the chunk
/// list rather than assuming a fixed offset — a `LIST`/`fact` chunk before
/// `data` is legal WAV.
fn scan_header(bytes: &[u8]) -> HeaderScan {
    if bytes.len() < 12 {
        return HeaderScan::NeedMore;
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return HeaderScan::Passthrough;
    }
    let mut at: usize = 12;
    loop {
        if at.checked_add(8).is_none_or(|end| end > bytes.len()) {
            return HeaderScan::NeedMore;
        }
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);
        if &bytes[at..at + 4] == b"data" {
            return HeaderScan::Ready(at);
        }
        // Chunks are padded to even lengths.
        let step = (size as usize).saturating_add(size as usize % 2);
        let Some(next) = at.checked_add(8).and_then(|a| a.checked_add(step)) else {
            return HeaderScan::Passthrough;
        };
        at = next;
    }
}

/// Patches the two `0xFFFFFFFF` placeholder lengths `kokoro-rs -o -` writes in
/// its *streaming* RIFF header (it can't know the length before synthesising).
/// Chrome tolerates them; Safari often won't play such a file at all.
///
/// Since task 816 the audio is streamed rather than collected, so the real
/// length is not known when the header goes out: what replaces the placeholder
/// is [`STREAM_DATA_LEN`], the "as long as it turns out to be" declaration a
/// live WAV stream conventionally carries. Both patched fields stay positive
/// 31-bit values — the property a strict player wants — and playback ends where
/// the bytes do.
///
/// Deliberately conservative: anything that isn't a `RIFF….WAVE` header with a
/// `data` chunk whose size is the placeholder is left byte-identical, so a
/// future `kokoro-rs` that emits real sizes makes this a no-op rather than a
/// corrupter.
fn fix_wav_sizes(bytes: &mut [u8]) {
    const PLACEHOLDER: u32 = u32::from_le_bytes([0xff; 4]);
    let HeaderScan::Ready(at) = scan_header(bytes) else {
        return;
    };
    if u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
        != PLACEHOLDER
    {
        return;
    }
    bytes[at + 4..at + 8].copy_from_slice(&STREAM_DATA_LEN.to_le_bytes());
    if bytes[4..8] == PLACEHOLDER.to_le_bytes() {
        // RIFF counts everything after its own size field: the chunk headers
        // ahead of the audio plus the audio itself.
        let riff = STREAM_DATA_LEN.saturating_add(u32::try_from(at).unwrap_or(0));
        bytes[4..8].copy_from_slice(&riff.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    use super::*;

    /// `MESA_KOKORO_BIN` is a process-global env var and cargo runs tests in
    /// parallel, so every test that sets it must not race another — mirrors
    /// `listen::tests::ENV`.
    static ENV: Mutex<()> = Mutex::new(());

    /// A streaming header exactly as `kokoro-rs -o -` writes it, plus `n`
    /// bytes of audio.
    fn streaming_wav(n: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0xff; 4]);
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&[1, 0, 1, 0]); // PCM, mono
        v.extend_from_slice(&24000u32.to_le_bytes());
        v.extend_from_slice(&48000u32.to_le_bytes());
        v.extend_from_slice(&[2, 0, 16, 0]);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&[0xff; 4]);
        v.extend(std::iter::repeat_n(0u8, n));
        v
    }

    #[test]
    fn patches_both_placeholder_sizes() {
        let mut v = streaming_wav(100);
        fix_wav_sizes(&mut v);
        assert_eq!(
            u32::from_le_bytes(v[40..44].try_into().unwrap()),
            STREAM_DATA_LEN
        );
        assert_eq!(
            u32::from_le_bytes(v[4..8].try_into().unwrap()),
            STREAM_DATA_LEN + 36
        );
    }

    /// The sizes are a promise to a player, so both must read as positive in
    /// the signed arithmetic strict parsers use.
    #[test]
    fn both_patched_sizes_stay_positive_i32() {
        let mut v = streaming_wav(100);
        fix_wav_sizes(&mut v);
        for field in [&v[4..8], &v[40..44]] {
            let n = i32::from_le_bytes(field.try_into().unwrap());
            assert!(n > 0, "{n} must be a positive size");
        }
    }

    #[test]
    fn patching_is_idempotent() {
        let mut v = streaming_wav(100);
        fix_wav_sizes(&mut v);
        let once = v.clone();
        fix_wav_sizes(&mut v);
        assert_eq!(v, once, "a patched header is no longer a placeholder");
    }

    #[test]
    fn skips_a_data_chunk_behind_another_chunk() {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0xff; 4]);
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"LIST");
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(b"INFO");
        v.extend_from_slice(b"data");
        v.extend_from_slice(&[0xff; 4]);
        v.extend_from_slice(&[7u8; 8]);
        fix_wav_sizes(&mut v);
        assert_eq!(
            u32::from_le_bytes(v[28..32].try_into().unwrap()),
            STREAM_DATA_LEN
        );
        assert_eq!(
            u32::from_le_bytes(v[4..8].try_into().unwrap()),
            STREAM_DATA_LEN + 24
        );
    }

    #[test]
    fn leaves_non_wav_bytes_untouched() {
        for mut v in [
            b"not audio at all".to_vec(),
            b"RIFF".to_vec(),
            Vec::new(),
            {
                let mut v = streaming_wav(4);
                v[8..12].copy_from_slice(b"AVI ");
                v
            },
        ] {
            let before = v.clone();
            fix_wav_sizes(&mut v);
            assert_eq!(v, before);
        }
    }

    /// The header scan is what decides when `start` stops blocking, so a
    /// partial header must ask for more rather than being patched or waved
    /// through as raw bytes.
    #[test]
    fn a_partial_header_asks_for_more() {
        let full = streaming_wav(8);
        for cut in [0, 4, 11, 12, 20, 43] {
            assert_eq!(
                scan_header(&full[..cut]),
                HeaderScan::NeedMore,
                "{cut} bytes is not a complete header"
            );
        }
        assert_eq!(scan_header(&full[..44]), HeaderScan::Ready(36));
        assert_eq!(scan_header(b"not audio at all"), HeaderScan::Passthrough);
    }

    /// A chunk size that points past everything the producer will ever send
    /// would otherwise keep `start` reading — and holding — the whole render.
    #[test]
    fn an_absurd_chunk_size_never_becomes_ready() {
        let mut v = streaming_wav(8);
        v[16..20].copy_from_slice(&0xffff_fff0u32.to_le_bytes()); // fmt chunk size
        assert_eq!(scan_header(&v), HeaderScan::NeedMore);
        let before = v.clone();
        fix_wav_sizes(&mut v);
        assert_eq!(v, before, "nothing understood, nothing patched");
    }

    #[test]
    fn start_reports_a_failing_binary() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        // A binary that cannot exist: the spawn error path, no stub needed.
        unsafe { std::env::set_var("MESA_KOKORO_BIN", "mesa-no-such-tts-binary") };
        let err = start("hello", None).err().expect("no binary, no speech");
        unsafe { std::env::remove_var("MESA_KOKORO_BIN") };
        assert!(err.contains("mesa-no-such-tts-binary"), "{err}");
    }

    fn write_stub(dir: &std::path::Path, name: &str, script: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, script).expect("write stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    /// A stub that says far more than `STDERR_CAP` on stderr and produces no
    /// audio: `start` must still return `Err`, with the failure message
    /// bounded rather than carrying the whole complaint.
    #[test]
    fn a_noisy_failing_binary_produces_a_bounded_error() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = write_stub(
            dir.path(),
            "kokoro-noisy-stderr.sh",
            "#!/bin/sh\n\
             cat > /dev/null\n\
             head -c 8388608 /dev/zero | tr '\\0' 'x' >&2\n\
             exit 1\n",
        );

        unsafe { std::env::set_var("MESA_KOKORO_BIN", &stub) };
        let err = start("hello", None)
            .err()
            .expect("failing binary, no speech");
        unsafe { std::env::remove_var("MESA_KOKORO_BIN") };

        assert!(
            err.len() < STDERR_CAP + 4096,
            "error message was not bounded: {} bytes",
            err.len()
        );
    }

    /// A stub that writes far more than `STDOUT_CAP` of non-WAV bytes on
    /// stdout: the no-header fallback must refuse to collect it all rather
    /// than balloon memory, and `start` must still terminate with an `Err`.
    #[test]
    fn an_oversized_non_wav_stdout_is_rejected_rather_than_collected() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = write_stub(
            dir.path(),
            "kokoro-oversized-stdout.sh",
            "#!/bin/sh\n\
             cat > /dev/null\n\
             head -c 71303168 /dev/zero | tr '\\0' 'x'\n\
             exit 1\n",
        );

        unsafe { std::env::set_var("MESA_KOKORO_BIN", &stub) };
        let err = start("hello", None)
            .err()
            .expect("oversized non-WAV stdout, no speech");
        unsafe { std::env::remove_var("MESA_KOKORO_BIN") };

        assert!(err.contains("more than"), "{err}");
    }

    /// A `--list-voices` stub flooding stdout with far more than `STDERR_CAP`
    /// of noise (never a real voices answer — no newlines, so `is_voice_name`
    /// rejects the one giant "line" `list_names` sees) must still return
    /// promptly with a bounded result rather than growing without bound.
    /// Exercises `list_names` directly rather than `voices()`, whose
    /// `OnceLock` caches for the life of the process and would leak a stub
    /// answer into every other test that reads real voices.
    #[test]
    fn list_names_stays_bounded_against_a_flooding_stub() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = write_stub(
            dir.path(),
            "kokoro-flood-list-voices.sh",
            "#!/bin/sh\n\
             head -c 8388608 /dev/zero | tr '\\0' 'x'\n",
        );

        let names = list_names(
            stub.to_str().expect("utf8 path"),
            &["--no-download", "--list-voices"],
            is_voice_name,
            MAX_VOICES,
        );
        assert!(names.is_empty(), "flooded noise is not a voice name");
    }

    /// The shape rule is what keeps a stored voice from ever being read as an
    /// option, and what filters a `--list-voices` answer that isn't a list.
    #[test]
    fn voice_names_are_bounded_identifiers() {
        for good in ["af_heart", "bm_george", "zf_xiaoni", "v2", "a"] {
            assert!(is_voice_name(good), "{good} is a voice name");
        }
        for bad in [
            "",
            "-o",
            "_leading",
            "af heart",
            "af/heart",
            "af_heart;rm -rf /",
            &"a".repeat(65),
        ] {
            assert!(!is_voice_name(bad), "{bad:?} is not a voice name");
        }
    }
}
