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

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde::Deserialize;

/// The speech-to-text binary to run. `MESA_AURIS_BIN` overrides it — the same
/// test seam as `speech::kokoro_bin`/`agents::claude_bin`, and how the
/// end-to-end checks drive this route against a stub instead of a real
/// recognizer.
pub fn auris_bin() -> String {
    std::env::var("MESA_AURIS_BIN").unwrap_or_else(|_| "auris".to_string())
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

    let mut stderr = child.stderr.take().expect("stderr was piped");
    let complaints = std::thread::spawn(move || {
        let mut said = String::new();
        let _ = stderr.read_to_string(&mut said);
        said
    });

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut out = String::new();
    let read_err = stdout.read_to_string(&mut out).err();

    let _ = writer.join();
    let status = child.wait();

    let mut transcript: Option<String> = None;
    for line in out.lines() {
        let Ok(parsed) = serde_json::from_str::<Line>(line) else {
            continue;
        };
        if parsed.kind == Kind::Transcript {
            transcript = Some(parsed.text);
        }
    }

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
    use super::*;

    #[test]
    fn reports_a_missing_binary_as_an_error() {
        // A binary that cannot exist: the spawn error path, no stub needed —
        // mirrors `speech::tests::start_reports_a_failing_binary`.
        unsafe { std::env::set_var("MESA_AURIS_BIN", "mesa-no-such-auris-binary") };
        let err = transcribe(b"not real audio").expect_err("no binary, no transcript");
        unsafe { std::env::remove_var("MESA_AURIS_BIN") };
        assert!(err.contains("mesa-no-such-auris-binary"), "{err}");
    }
}
