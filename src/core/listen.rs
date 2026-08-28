//! Transcribing recorded audio with the external `auris` speech-to-text
//! binary. This is the mirror of `speech.rs` — `speech.rs` turns mesa text
//! into audio for a browser to play; this turns audio a browser recorded
//! into text mesa can use — and it copies that module's shape closely: a
//! subprocess, not storage, invoked as argv with all three pipes drained for
//! the child's whole life.
//!
//! Unlike `speech::start`, this does **not** stream a channel back to the
//! caller. `speech::start` blocks only until the WAV header is in hand
//! because audio is elastic — a minute-long render is worth starting to
//! play after a couple of seconds. A transcript is the opposite shape: one
//! short string, produced only once the whole recording has been decoded, so
//! there is nothing earlier to hand back and nothing to gain from a channel.
//! [`transcribe`] collects the whole answer and returns it.
//!
//! **Nothing here is retained** (`docs/posture.md`, mesa task 930): the audio
//! is transcribed and dropped. It is never written to `live_turns` (which has
//! no column for it), never written to disk, and never logged — the speak
//! routes' "nothing is stored and nothing is cached" read backwards, with the
//! arrow of what goes in and what comes out reversed.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::core::speech::{drain_capped, list_names};

/// The speech-to-text binary to run. `MESA_AURIS_BIN` overrides it — the same
/// test seam as `speech::kokoro_bin`/`agents::claude_bin`, and how the
/// end-to-end checks drive this route against a stub instead of a real
/// recognizer.
pub fn auris_bin() -> String {
    std::env::var("MESA_AURIS_BIN").unwrap_or_else(|_| "auris".to_string())
}

/// The most models [`models`] will report. auris ships exactly one today
/// (`parakeet-tdt-0.6b-v2-int8`); the bound mirrors `speech::MAX_VOICES` for
/// the same reason — a binary that answers `--list-models` with something
/// else entirely must not be able to fill a dropdown, or the JSON a caller
/// reads, with its output. Small on purpose: unlike voices, mesa has no
/// reason to expect more than a handful of local models ever to exist here.
const MAX_MODELS: usize = 50;

/// The model names the installed recognizer offers, asked of the binary
/// itself (`auris --no-download --list-models`, one name per line) — the
/// `models()` mirror of `speech::voices()`; read that function first, this
/// copies its shape.
///
/// Empty when the binary is missing, fails, or answers with something that
/// isn't a list of names: an empty list means "mesa could not ask", never
/// "there are none". Callers must treat it as advisory.
///
/// Cached for the life of the process: this runs inside a `OnceLock`, so a
/// call that blocks blocks every later caller for the life of the process —
/// there is no cheap timeout here, so the fix is not to start anything that
/// can hang. Unlike `kokoro-rs --list-voices`, this cannot actually be that
/// call: auris's `--list-models` is a plain directory read that never
/// touches the network, and exits 0 with empty stdout when no model is
/// installed yet — it has nothing to download and nothing to hang on
/// (`auris/README.md` "`--no-download`", which names this function by name).
/// `--no-download` is passed anyway, matching `speech::voices()`, so listing
/// names can never become a fetch even if a future auris version changes
/// that. Both of the child's pipes are bounded (`list_names` →
/// `speech::spawn_and_drain`), so a `--list-models` that answers with
/// megabytes of noise costs one capped buffer, never an unbounded one.
pub fn models() -> &'static [String] {
    static MODELS: OnceLock<Vec<String>> = OnceLock::new();
    MODELS.get_or_init(|| {
        list_names(
            &auris_bin(),
            &["--no-download", "--list-models"],
            is_model_name,
            MAX_MODELS,
        )
    })
}

/// Whether `name` is shaped like a model name: a bounded identifier that
/// cannot be mistaken for an option. Mirrors `speech::is_voice_name`, with
/// one deliberate difference — `.` is accepted as an interior character.
/// auris's only model today is named `parakeet-tdt-0.6b-v2-int8`, which
/// contains a `.`; `is_voice_name`'s rule would filter it straight out
/// (`auris/README.md` calls out that mesa's model-name check must allow
/// `.`). Every other property is unchanged: non-empty, <= 64 chars, must
/// start with an ASCII alphanumeric (so it can never be read as an option),
/// otherwise only ASCII alphanumerics, `_`, `-`, `.`.
pub fn is_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// How much of auris's stderr rides back in an error message when it produces
/// no transcript. Bounded for the same reason `look::STDERR_EXCERPT` is: this
/// lands in a JSON error, not a log file.
const STDERR_EXCERPT: usize = 400;

/// One JSON Lines record auris's `--format json` may emit. Only the
/// discriminator every reader must respect and the one field this reader
/// keeps are named; auris's own contract (`auris/README.md` "`--format
/// json`") is that an unrecognised `type` — or, here, any other field on a
/// recognised one — must be ignored rather than treated as an error, since
/// that is the whole of auris's extension mechanism. `#[serde(other)]` plus
/// `#[serde(default)]` on `text` is what makes an unparseable/unknown line a
/// no-op instead of a parse failure that would abort the read.
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Kind,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Transcript,
    #[serde(other)]
    Other,
}

/// The longest single stdout line mesa will hold from auris's JSON Lines
/// output before giving up on it. A byte cap on the *whole* stream would risk
/// discarding a legitimate final `transcript` line arriving after a long run
/// of `segment` lines — the opposite of `speech::STDERR_CAP`, which is fine to
/// truncate because it is only ever quoted back in an error. Bounding the
/// *line* length instead keeps memory bounded while still reading every line
/// auris writes, in order, to find the last `transcript`.
const LINE_CAP: usize = 1024 * 1024;

/// Reads `reader` line by line, keeping the text of the **last** `{"type":
/// "transcript", ...}` line seen — auris's contract (`auris/README.md`
/// "`--format json`") is that `transcript` is always the last line on a run
/// that produced one, so the last match is the answer even though `segment`
/// lines may run ahead of it in volume this function must not buffer as a
/// whole. A line longer than [`LINE_CAP`] cannot be a real JSON Lines record
/// from auris, so it is drained and discarded whole rather than parsed as a
/// truncated (and therefore invalid) fragment. Returns the read error, if
/// any, alongside whatever was found before it — mirroring `read_to_string`'s
/// contract of "partial data, then an error" as closely as a line reader can.
fn last_transcript<R: Read>(reader: R) -> (Option<String>, Option<std::io::Error>) {
    let mut reader = BufReader::new(reader);
    let mut transcript = None;
    loop {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(LINE_CAP as u64)
            .read_until(b'\n', &mut line);
        let n = match read {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return (transcript, Some(e)),
        };
        // Hitting the cap with no trailing newline is ambiguous on its own:
        // it is either a line still going (over-long, discard it) or a line
        // that happens to be exactly LINE_CAP bytes with the stream ending
        // right there (complete — nothing to discard). `drain_overlong`
        // resolves it by trying to read more.
        if n as u64 == LINE_CAP as u64 && line.last() != Some(&b'\n') {
            match drain_overlong(&mut reader) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(e) => return (transcript, Some(e)),
            }
        }
        let text = String::from_utf8_lossy(&line);
        let Ok(parsed) = serde_json::from_str::<Line>(text.trim_end()) else {
            continue;
        };
        if parsed.kind == Kind::Transcript {
            transcript = Some(parsed.text);
        }
    }
    (transcript, None)
}

/// Called only when a line has just hit [`LINE_CAP`] with no trailing
/// newline — drains whatever comes after it, in further `LINE_CAP`-bounded
/// reads, until a newline or EOF. `Ok(false)` means the very next read hit
/// EOF immediately: nothing followed, so the line the caller just read was
/// not truncated at all — it was exactly `LINE_CAP` bytes and the stream
/// simply ended there — and must be parsed normally rather than discarded.
/// `Ok(true)` means at least one more byte followed: the line genuinely
/// continues past the cap, so the caller's line (and everything drained here)
/// is discarded whole rather than parsed as a truncated fragment.
fn drain_overlong<R: BufRead>(reader: &mut R) -> std::io::Result<bool> {
    let mut discarded = false;
    loop {
        let mut sink = Vec::new();
        let n = (&mut *reader)
            .take(LINE_CAP as u64)
            .read_until(b'\n', &mut sink)?;
        if n == 0 {
            return Ok(discarded);
        }
        discarded = true;
        if (n as u64) < LINE_CAP as u64 || sink.last() == Some(&b'\n') {
            return Ok(true);
        }
        // Still no newline after another full LINE_CAP-bounded read: the
        // line keeps going, so keep draining.
    }
}

/// Transcribes `audio` (a whole WAV recording) by shelling out to `auris`.
///
/// The audio is **never a shell string and never a `Command::arg`** — the
/// same load-bearing property `speech.rs` states for the text it hands
/// `kokoro-rs`, and for the same reason: it is written to the child's stdin,
/// so a payload that happens to start with a flag-shaped byte can never be
/// parsed as one, and there is no `ARG_MAX` ceiling to hit. There is no shell
/// anywhere on this path.
///
/// Every pipe is drained for the child's whole life: stdin is written from a
/// dedicated thread (dropping it on that thread's exit is what signals EOF to
/// auris), stderr is drained on its own thread, and stdout is read on the
/// calling thread. An audio body is megabytes, not bytes — writing it inline
/// while also waiting on stdout would deadlock the first time either pipe's
/// ~64 KiB buffer filled, exactly the failure `speech.rs`'s own comment
/// documents for the render direction.
///
/// auris streams JSON Lines as it decodes (`auris/README.md` "`--format
/// json`"): a `segment` line per completed utterance, and a final
/// `transcript` line carrying the whole corrected text. This reads to EOF and
/// keeps the text from the **last** `transcript` line seen, ignoring
/// `segment` and anything else — `--format json` guarantees `transcript` is
/// always the last line on a run that produced one, so reading to EOF and
/// keeping the last match is a correct reader on its own.
///
/// A nonzero exit is **not** data here, unlike `scripts::run`: there is no
/// transcript to hand back on failure, so any run that lands nothing usable
/// on stdout is an `Err` — the same rule `speech::start` applies to a
/// kokoro-rs that produced no audio (and returns the same `Result<_, String>`
/// shape `speech::start` does, for the same reason: the caller maps it
/// straight to a 503 `unavailable`, exactly as `speak_live_turn` already does
/// with `speech::start`'s error). The exit status is only consulted once
/// nothing usable has landed on stdout, never as the primary signal
/// (mirroring `auris/README.md`'s own "Exit codes" contract) — a non-WAV or
/// unreadable body is auris's own exit-1 "no transcript" path, not a
/// distinct case this function has to detect itself.
///
/// Blocking: call it from `spawn_blocking`, not an async worker.
pub fn transcribe(audio: &[u8]) -> Result<String, String> {
    // Per-request vocabulary (hotword biasing / correction) is mesa task 955;
    // `--vocabulary-file` is documented but not yet implemented by auris, so
    // this call passes nothing for it.
    let bin = auris_bin();
    let mut child = Command::new(&bin)
        .args(["-q", "--format", "json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "failed to run {bin}: {e} (set MESA_AURIS_BIN to override the binary mesa runs)"
            )
        })?;

    let mut stdin = child.stdin.take().expect("stdin was piped");
    let payload = audio.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
        // `stdin` drops here, closing the pipe and signalling EOF to auris —
        // it cannot decode an offline utterance until it sees the end.
    });

    let stderr = child.stderr.take().expect("stderr was piped");
    let complaints = std::thread::spawn(move || drain_capped(stderr));

    let stdout = child.stdout.take().expect("stdout was piped");
    let (transcript, read_err) = last_transcript(stdout);

    let _ = writer.join();
    let status = child.wait();

    if let Some(text) = transcript {
        return Ok(text);
    }

    // Nothing usable landed on stdout: consult the exit status and stderr
    // only now, to explain the failure rather than to detect it.
    let said = complaints.join().unwrap_or_default();
    let said = said.trim();
    let excerpt: String = said.chars().take(STDERR_EXCERPT).collect();
    let reason = if !excerpt.is_empty() {
        format!("{bin} produced no transcript: {excerpt}")
    } else if let Some(e) = read_err {
        format!("failed to read output from {bin}: {e}")
    } else {
        match status {
            Ok(s) if !s.success() => format!("{bin} exited with {s}"),
            Ok(_) => format!("{bin} produced no transcript"),
            Err(e) => format!("failed to wait on {bin}: {e}"),
        }
    };
    Err(reason)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    use super::*;

    /// `MESA_AURIS_BIN` is a process-global env var and cargo runs tests in
    /// parallel, so the two tests that set it must not race each other.
    /// Poisoning (one test panicking while holding the lock) must not wedge
    /// the other — `unwrap_or_else` recovers the guard instead of unwrapping
    /// into a second panic.
    static ENV: Mutex<()> = Mutex::new(());

    /// A line that is exactly `LINE_CAP` bytes, has no trailing newline, and
    /// is genuinely the whole of the data (the stream ends right there) must
    /// still be parsed — not discarded as over-long. Regression for the case
    /// `drain_overlong` exists to resolve: hitting the cap with no newline is
    /// ambiguous until a further read proves whether anything follows.
    #[test]
    fn a_transcript_line_landing_exactly_on_line_cap_at_eof_is_kept() {
        let prefix = br#"{"type":"transcript","text":""#;
        let suffix = br#""}"#;
        let pad_len = LINE_CAP - prefix.len() - suffix.len();
        let mut line = Vec::with_capacity(LINE_CAP);
        line.extend_from_slice(prefix);
        line.extend(std::iter::repeat_n(b'x', pad_len));
        line.extend_from_slice(suffix);
        assert_eq!(line.len(), LINE_CAP);
        // No trailing newline: the stream ends exactly at LINE_CAP bytes.

        let (transcript, err) = last_transcript(std::io::Cursor::new(line.clone()));
        assert!(err.is_none());
        let expected = "x".repeat(pad_len);
        assert_eq!(transcript, Some(expected));
    }

    #[test]
    fn reports_a_missing_binary_as_an_error() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        // A binary that cannot exist: the spawn error path, no stub needed —
        // mirrors `speech::tests::start_reports_a_failing_binary`.
        unsafe { std::env::set_var("MESA_AURIS_BIN", "mesa-no-such-auris-binary") };
        let err = transcribe(b"not real audio").expect_err("no binary, no transcript");
        unsafe { std::env::remove_var("MESA_AURIS_BIN") };
        assert!(err.contains("mesa-no-such-auris-binary"), "{err}");
    }

    /// A payload well over a pipe's ~64 KiB buffer, with a stub that also
    /// writes more than a buffer's worth to stderr, must still complete.
    /// Without the dedicated stdin-writer thread, writing the payload inline
    /// while the stub blocks trying to write its own stderr backlog (nobody
    /// yet reading it) would deadlock: this call would sit forever pushing
    /// bytes into a stdin pipe the stub cannot drain because it is itself
    /// stuck writing stderr. Without the dedicated stderr-drain thread, the
    /// stub's stderr write would fill that pipe and block the stub before it
    /// ever reads all of stdin or reaches its stdout line, again forever.
    #[test]
    fn a_body_larger_than_a_pipe_buffer_does_not_deadlock() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = dir.path().join("auris-stub.sh");
        std::fs::write(
            &stub,
            "#!/bin/sh\n\
             cat > /dev/null\n\
             yes stderr-filler-line | head -c 200000 >&2\n\
             printf '%s\\n' '{\"type\":\"transcript\",\"text\":\"ok\"}'\n",
        )
        .expect("write stub");
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        unsafe { std::env::set_var("MESA_AURIS_BIN", &stub) };
        let payload = vec![0u8; 1024 * 1024];
        let result = transcribe(&payload);
        unsafe { std::env::remove_var("MESA_AURIS_BIN") };

        assert_eq!(result, Ok("ok".to_string()));
    }

    /// A `--list-models` stub flooding stdout with far more than
    /// `speech::STDERR_CAP` of noise must still return promptly with a
    /// bounded result. Mirrors
    /// `speech::tests::list_names_stays_bounded_against_a_flooding_stub` —
    /// exercises `list_names` directly rather than `models()`, whose
    /// `OnceLock` caches for the life of the process and would leak a stub
    /// answer into every other test that reads real models.
    #[test]
    fn list_names_stays_bounded_against_a_flooding_stub() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = dir.path().join("auris-flood-list-models.sh");
        std::fs::write(
            &stub,
            "#!/bin/sh\n\
             head -c 8388608 /dev/zero | tr '\\0' 'x'\n",
        )
        .expect("write stub");
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let names = list_names(
            stub.to_str().expect("utf8 path"),
            &["--no-download", "--list-models"],
            is_model_name,
            MAX_MODELS,
        );
        assert!(names.is_empty(), "flooded noise is not a model name");
    }

    /// The shape rule is what keeps a stored model name from ever being read
    /// as an option, and what filters a `--list-models` answer that isn't a
    /// list. Mirrors `speech::tests::voice_names_are_bounded_identifiers`.
    #[test]
    fn model_names_are_bounded_identifiers() {
        assert!(is_model_name("parakeet-tdt-0.6b-v2-int8"));
        for bad in ["", "-o", &"a".repeat(65), "a b", "a/b", "a;rm -rf /"] {
            assert!(!is_model_name(bad), "{bad:?} is not a model name");
        }
    }

    fn write_stub(dir: &std::path::Path, name: &str, script: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, script).expect("write stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    /// A stub that says far more than `speech::STDERR_CAP` on stderr and
    /// fails: the error must still terminate and stay bounded, proving stderr
    /// is capped rather than collected whole.
    #[test]
    fn a_noisy_failing_binary_produces_a_bounded_error() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = write_stub(
            dir.path(),
            "auris-noisy-stderr.sh",
            "#!/bin/sh\n\
             cat > /dev/null\n\
             head -c 8388608 /dev/zero | tr '\\0' 'x' >&2\n\
             exit 1\n",
        );

        unsafe { std::env::set_var("MESA_AURIS_BIN", &stub) };
        let err = transcribe(b"not real audio").expect_err("failing binary, no transcript");
        unsafe { std::env::remove_var("MESA_AURIS_BIN") };

        assert!(
            err.len() < crate::core::speech::STDERR_CAP + 4096,
            "error message was not bounded: {} bytes",
            err.len()
        );
    }

    /// A stub whose stdout carries far more than `LINE_CAP` of `segment`
    /// lines before its final `transcript` line: the last line must still
    /// win, proving the reader stays bounded without losing the answer.
    #[test]
    fn the_last_transcript_line_wins_over_a_flood_of_segments() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("tempdir");
        let stub = write_stub(
            dir.path(),
            "auris-flood-segments.sh",
            "#!/bin/sh\n\
             cat > /dev/null\n\
             i=0\n\
             while [ $i -lt 20000 ]; do\n\
             printf '{\"type\":\"segment\",\"text\":\"filler\"}\\n'\n\
             i=$((i + 1))\n\
             done\n\
             printf '{\"type\":\"transcript\",\"text\":\"the real answer\"}\\n'\n",
        );

        unsafe { std::env::set_var("MESA_AURIS_BIN", &stub) };
        let result = transcribe(b"not real audio");
        unsafe { std::env::remove_var("MESA_AURIS_BIN") };

        assert_eq!(result, Ok("the real answer".to_string()));
    }
}
