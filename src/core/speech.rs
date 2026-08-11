//! Speaking a piece of mesa text with the external `kokoro-rs` TTS binary.
//! Synthesis is a subprocess, not storage, so it lives beside `scripts.rs` and
//! `hooks.rs` and copies their shape.
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
//! stdout, the child runs to completion (no timeout, matching hooks/agents/
//! scripts), and unlike a script run a nonzero exit is **not** data — there is
//! no audio to return, so it is an `Err` the API answers `unavailable` with.

use std::io::Write;
use std::process::{Command, Stdio};

/// The TTS binary to run. `MESA_KOKORO_BIN` overrides it — the same test seam
/// as `agents::claude_bin`, and how `api-check.sh` drives this route against a
/// stub instead of a real 45 KB/second synthesiser.
pub fn kokoro_bin() -> String {
    std::env::var("MESA_KOKORO_BIN").unwrap_or_else(|_| "kokoro-rs".to_string())
}

/// Synthesises `text` to WAV bytes, or `Err` with whatever the binary said.
pub fn synthesize(text: &str) -> Result<Vec<u8>, String> {
    let bin = kokoro_bin();
    let mut child = Command::new(&bin)
        // `-q`: progress output on stderr is noise we'd only ever quote back in
        // an error. `-o -`: WAV on stdout instead of the host's speakers.
        .args(["-q", "-o", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    // Write stdin from a thread while `wait_with_output` drains stdout: the
    // audio is megabytes, so writing inline would deadlock against a full
    // stdout pipe on the first body longer than a pipe buffer
    // (`scripts.rs`/`hooks.rs` hold the same line for the same reason).
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let payload = text.as_bytes().to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&payload);
    });
    let out = child
        .wait_with_output()
        .map_err(|e| format!("failed to collect audio from {bin}: {e}"))?;
    let _ = writer.join();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            format!("{bin} failed")
        } else {
            format!("{bin} failed: {err}")
        });
    }
    let mut bytes = out.stdout;
    fix_wav_sizes(&mut bytes);
    Ok(bytes)
}

/// Patches the two `0xFFFFFFFF` placeholder lengths `kokoro-rs -o -` writes in
/// its *streaming* RIFF header (it can't know the length before synthesising).
/// Chrome tolerates them; Safari often won't play such a file at all. We hold
/// the whole buffer anyway, so the real sizes are free.
///
/// Deliberately conservative: anything that isn't a `RIFF….WAVE` header with a
/// `data` chunk whose size is the placeholder is left byte-identical, so a
/// future `kokoro-rs` that emits correct sizes makes this a no-op rather than a
/// corrupter.
fn fix_wav_sizes(bytes: &mut [u8]) {
    const PLACEHOLDER: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return;
    }
    // Walk the chunk list to the `data` header rather than assuming a fixed
    // offset — a `LIST`/`fact` chunk before it is legal WAV.
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);
        if id == b"data" {
            if size != u32::from_le_bytes(PLACEHOLDER) {
                return;
            }
            let Ok(data_len) = u32::try_from(bytes.len() - (at + 8)) else {
                return;
            };
            bytes[at + 4..at + 8].copy_from_slice(&data_len.to_le_bytes());
            if bytes[4..8] == PLACEHOLDER {
                let riff_len = u32::try_from(bytes.len() - 8).unwrap_or(u32::MAX);
                bytes[4..8].copy_from_slice(&riff_len.to_le_bytes());
            }
            return;
        }
        // Chunks are padded to even lengths.
        let Some(step) = (size as usize).checked_add(size as usize % 2) else {
            return;
        };
        let Some(next) = at.checked_add(8).and_then(|a| a.checked_add(step)) else {
            return;
        };
        at = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(u32::from_le_bytes(v[4..8].try_into().unwrap()), 136);
        assert_eq!(u32::from_le_bytes(v[40..44].try_into().unwrap()), 100);
    }

    #[test]
    fn leaves_a_correctly_sized_wav_alone() {
        let mut v = streaming_wav(100);
        fix_wav_sizes(&mut v);
        let once = v.clone();
        fix_wav_sizes(&mut v);
        assert_eq!(v, once, "patching is idempotent");
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
        assert_eq!(u32::from_le_bytes(v[28..32].try_into().unwrap()), 8);
        assert_eq!(u32::from_le_bytes(v[4..8].try_into().unwrap()), 32);
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

    #[test]
    fn synthesize_reports_a_failing_binary() {
        // A binary that cannot exist: the spawn error path, no stub needed.
        unsafe { std::env::set_var("MESA_KOKORO_BIN", "mesa-no-such-tts-binary") };
        let err = synthesize("hello").unwrap_err();
        unsafe { std::env::remove_var("MESA_KOKORO_BIN") };
        assert!(err.contains("mesa-no-such-tts-binary"), "{err}");
    }
}
