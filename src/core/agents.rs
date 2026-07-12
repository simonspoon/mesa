//! Claude Code agents surface: list the live sessions running under a
//! project's folder and start new background ones, by shelling out to the
//! `claude` CLI (like the CLI's git calls and usage.rs's curl — no new
//! protocol dependency). This module reads/spawns EXTERNAL state only; nothing
//! here touches the mesa store. Errors are concise strings the API maps to
//! `unavailable` (the claude CLI missing or misbehaving is an upstream
//! problem, like a dead usage endpoint).

use std::process::{Command, Stdio};

use crate::core::types::AgentSession;

/// The `claude` binary to drive; `MESA_CLAUDE_BIN` overrides it for tests
/// (pointing at a stub), mirroring `MESA_CC_*` in cc.rs/usage.rs. Public so
/// the API's attach bridge spawns the same binary.
pub fn claude_bin() -> String {
    std::env::var("MESA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// Lists live Claude Code sessions started under `dir` (prefix match done by
/// `claude agents --json --cwd <dir>` itself). Interactive sessions are
/// included; only ones with a short `id` (background) are attachable.
pub fn list_under(dir: &str) -> Result<Vec<AgentSession>, String> {
    list_sessions(&claude_bin(), Some(dir))
}

/// Lists every live Claude Code session on the machine, with no folder
/// filter — backs the global Agents sidebar, which shows sessions across
/// every project at once instead of one project's folder.
pub fn list_all() -> Result<Vec<AgentSession>, String> {
    list_sessions(&claude_bin(), None)
}

fn list_sessions(bin: &str, dir: Option<&str>) -> Result<Vec<AgentSession>, String> {
    let mut cmd = Command::new(bin);
    cmd.args(["agents", "--json"]);
    if let Some(dir) = dir {
        cmd.args(["--cwd", dir]);
    }
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run claude: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude agents failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_sessions(&out.stdout)
}

/// Kept pure (bytes in, sessions out) so the payload contract is unit-testable
/// without a claude binary, like usage.rs's `parse`.
fn parse_sessions(bytes: &[u8]) -> Result<Vec<AgentSession>, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("unexpected claude agents payload: {e}"))
}

/// Starts a detached background session (`claude --bg`) in `dir` and returns
/// its short job id. `prompt` is optional — without one the session starts
/// idle, ready for the first message over an attach. `claude --bg` prints a
/// human receipt, not JSON; the id is parsed from its "backgrounded · <id>"
/// line.
pub fn spawn_bg(dir: &str, prompt: Option<&str>) -> Result<String, String> {
    spawn_bg_with(&claude_bin(), dir, prompt)
}

fn spawn_bg_with(bin: &str, dir: &str, prompt: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.arg("--bg").current_dir(dir).stdin(Stdio::null());
    if let Some(prompt) = prompt {
        // `--` ends option parsing so a prompt beginning with `-` (a markdown
        // bullet, or a token like `--resume`) is taken as prompt text, not
        // parsed by claude's CLI as a flag.
        cmd.arg("--").arg(prompt);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run claude: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude --bg failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_spawn(&String::from_utf8_lossy(&out.stdout))
}

/// Extracts the job id from `claude --bg` output. Observed forms:
/// `backgrounded · e34b8ed9 (idle — send a prompt to start)` and
/// `backgrounded · cf0c3945 · my-name`. The real `claude` CLI colorizes this
/// line (unlike the plain-text test stub), so ANSI escapes are stripped
/// first — otherwise the id token comes out wrapped in escape bytes.
fn parse_spawn(stdout: &str) -> Result<String, String> {
    let clean = strip_ansi(stdout);
    clean
        .lines()
        .find_map(|line| {
            let rest = line.trim().strip_prefix("backgrounded · ")?;
            let id = rest.split_whitespace().next()?;
            (!id.is_empty()).then(|| id.to_string())
        })
        .ok_or_else(|| format!("no job id in claude --bg output: {stdout:?}"))
}

/// Strips ANSI CSI escape sequences (`ESC '[' <params> <final byte>`, e.g.
/// SGR color codes like `\x1b[36m`). No crate dependency for one narrow use.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            while matches!(chars.peek(), Some(c2) if c2.is_ascii_digit() || matches!(c2, ';' | ':' | '?')) {
                chars.next();
            }
            if matches!(chars.peek(), Some(c2) if ('@'..='~').contains(c2)) {
                chars.next(); // consume the final byte
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    // Captured from `claude agents --json`: one interactive session (no short
    // id, no state) and one background session with every field populated.
    const SESSIONS_JSON: &str = r#"[
      {
        "pid": 83417,
        "cwd": "/Users/x/proj",
        "kind": "interactive",
        "startedAt": 1783046508696,
        "sessionId": "4230f7c7-5e6b-41a0-9f5e-7c6fa4e570f9",
        "name": "mesa-43",
        "status": "busy"
      },
      {
        "pid": 86593,
        "id": "e34b8ed9",
        "cwd": "/Users/x/proj/sub",
        "kind": "background",
        "startedAt": 1783047160571,
        "sessionId": "e34b8ed9-d391-4797-9d39-546d5b463357",
        "name": "do the thing",
        "status": "idle",
        "state": "blocked",
        "waitingFor": "permission prompt"
      }
    ]"#;

    #[test]
    fn parses_interactive_and_background_sessions() {
        let sessions = parse_sessions(SESSIONS_JSON.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 2);
        let interactive = &sessions[0];
        assert_eq!(interactive.kind, "interactive");
        assert_eq!(interactive.id, None);
        assert_eq!(interactive.state, None);
        assert_eq!(interactive.started_at, 1783046508696);
        let background = &sessions[1];
        assert_eq!(background.id.as_deref(), Some("e34b8ed9"));
        assert_eq!(background.state.as_deref(), Some("blocked"));
        assert_eq!(background.waiting_for.as_deref(), Some("permission prompt"));
    }

    #[test]
    fn parses_empty_list_and_rejects_garbage() {
        assert_eq!(parse_sessions(b"[]").unwrap(), vec![]);
        assert!(parse_sessions(b"not json").is_err());
    }

    #[test]
    fn session_serializes_back_to_camel_case() {
        // The API re-serves parsed sessions; the wire shape must round-trip.
        let sessions = parse_sessions(SESSIONS_JSON.as_bytes()).unwrap();
        let json = serde_json::to_value(&sessions[1]).unwrap();
        assert_eq!(json["sessionId"], "e34b8ed9-d391-4797-9d39-546d5b463357");
        assert_eq!(json["startedAt"], 1783047160571i64);
        assert_eq!(json["waitingFor"], "permission prompt");
    }

    #[test]
    fn parse_spawn_handles_both_receipt_forms() {
        let idle = "Starting background service…\n\
                    backgrounded · e34b8ed9 (idle — send a prompt to start)\n\
                    claude agents  list sessions\n";
        assert_eq!(parse_spawn(idle).unwrap(), "e34b8ed9");
        let named = "backgrounded · cf0c3945 · test-bg\n";
        assert_eq!(parse_spawn(named).unwrap(), "cf0c3945");
        assert!(parse_spawn("no receipt here").is_err());
    }

    #[test]
    fn parse_spawn_strips_ansi_color_codes() {
        // The real claude CLI colorizes the receipt (the id token itself
        // wrapped in an SGR color code); the plain-text stub above never
        // exercises this. Root-caused via live QA in mesa task 310/312.
        let colored = "\x1b[2mStarting background service…\x1b[0m\n\
                       backgrounded · \x1b[36me34b8ed9\x1b[0m (idle — send a prompt to start)\n";
        assert_eq!(parse_spawn(colored).unwrap(), "e34b8ed9");
    }

    /// Writes an executable stub `claude` into `dir` and returns its path.
    fn stub_claude(dir: &std::path::Path, script: &str) -> String {
        let path = dir.join("claude");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "#!/bin/sh\n{script}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn list_under_runs_the_binary_and_parses() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"[ "$1" = "agents" ] || exit 1; echo '[]'"#);
        assert_eq!(list_sessions(&bin, Some("/anywhere")).unwrap(), vec![]);
    }

    #[test]
    fn list_all_runs_without_a_cwd_filter() {
        let dir = tempfile::tempdir().unwrap();
        // Asserts the argv is exactly `agents --json` — no --cwd anywhere.
        let bin = stub_claude(
            dir.path(),
            r#"[ "$*" = "agents --json" ] || { echo "bad argv: $*" >&2; exit 1; }
echo '[]'"#,
        );
        assert_eq!(list_sessions(&bin, None).unwrap(), vec![]);
    }

    #[test]
    fn spawn_bg_runs_in_dir_and_parses_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] || exit 1; echo "backgrounded · deadbeef (idle — send a prompt to start)""#,
        );
        let id = spawn_bg_with(&bin, dir.path().to_str().unwrap(), None).unwrap();
        assert_eq!(id, "deadbeef");
    }

    #[test]
    fn spawn_bg_passes_dash_prompt_after_separator() {
        // A prompt beginning with `-` must reach claude as a positional, not a
        // flag: the stub asserts `--bg -- <prompt>` and echoes the prompt back.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--" ] || { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · abc00000"
echo "prompt was: $3" >&2"#,
        );
        let id = spawn_bg_with(&bin, dir.path().to_str().unwrap(), Some("--resume")).unwrap();
        assert_eq!(id, "abc00000");
    }

    #[test]
    fn failures_surface_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"echo "kaboom" >&2; exit 3"#);
        let err = list_sessions(&bin, Some("/anywhere")).unwrap_err();
        assert!(err.contains("kaboom"), "{err}");
        let missing = list_sessions("/nonexistent/claude", Some("/anywhere")).unwrap_err();
        assert!(missing.contains("failed to run claude"), "{missing}");
    }
}
