//! Hooks: user-configured shell commands fired on named events. The config is
//! a flat JSON map of hook name → command string in `hooks.json` beside the
//! database (`MESA_HOOKS_FILE` overrides it for tests, mirroring `MESA_DB`).
//! Running a hook is code execution by design — the command comes from the
//! user's own config file, never from a request — so the API gates the
//! trigger routes like the agents surface. Like agents.rs, errors are concise
//! strings the callers map onto the CLI/API error contract; a hook's own
//! nonzero exit is a *result* (captured in [`HookRun`]), not an error.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::core::types::{HookRun, Task};

/// The one hook point so far: the Execute button / `mesa task execute`.
pub const TASK_EXECUTE: &str = "task-execute";

/// Captured stdout/stderr are capped so a chatty hook can't balloon the JSON
/// response the UI and CLI print.
const OUTPUT_CAP: usize = 64 * 1024;

/// `MESA_HOOKS_FILE` if set, else `hooks.json` in the same directory as the
/// resolved database.
pub fn hooks_file() -> PathBuf {
    if let Ok(p) = std::env::var("MESA_HOOKS_FILE") {
        return PathBuf::from(p);
    }
    let mut path = crate::core::default_db_path();
    path.set_file_name("hooks.json");
    path
}

/// The configured command for `hook`: `Ok(None)` when the config file or the
/// key is absent (hook unconfigured), `Err` when the file exists but cannot
/// be read or parsed (the user should know their config is broken, not see
/// "unconfigured").
pub fn command_for(hook: &str) -> Result<Option<String>, String> {
    command_in(&hooks_file(), hook)
}

fn command_in(path: &Path, hook: &str) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let map: HashMap<String, String> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed hooks config {}: {e}", path.display()))?;
    Ok(map.get(hook).cloned())
}

/// Fires the `task-execute` hook for one task. Env/payload/cwd composition
/// lives here so the CLI and API contracts cannot diverge: the full task JSON
/// arrives on stdin, the commonly-scripted fields ride the environment, and
/// the command runs in the project's `local_path` when that folder exists
/// (else the server/CLI cwd is inherited).
pub fn run_task_execute(
    command: &str,
    task: &Task,
    project_dir: Option<&str>,
) -> Result<HookRun, String> {
    let payload = serde_json::to_string(task).map_err(|e| format!("task encode: {e}"))?;
    let env = [
        ("MESA_TASK_ID", task.id.to_string()),
        ("MESA_TASK_TITLE", task.title.clone()),
        ("MESA_PROJECT_ID", task.project_id.to_string()),
        // Explicit so a hook driving `mesa` itself hits the same database the
        // triggering process resolved, even under a MESA_DB override.
        (
            "MESA_DB",
            crate::core::default_db_path().display().to_string(),
        ),
    ];
    let cwd = project_dir.filter(|d| Path::new(d).is_dir());
    run(TASK_EXECUTE, command, cwd, &env, &payload)
}

/// Runs `command` under `sh -c` and captures the outcome. `Err` only when the
/// shell itself cannot be spawned; the hook exiting nonzero is reported in
/// `HookRun.exit_code`. There is deliberately no timeout (matching the
/// agents/usage subprocess calls): a hook that wants to outlive the request
/// should background itself (`… >/dev/null 2>&1 &`).
fn run(
    hook: &str,
    command: &str,
    cwd: Option<&str>,
    env: &[(&str, String)],
    payload: &str,
) -> Result<HookRun, String> {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", command])
        .env("MESA_HOOK", hook)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to run sh -c for the {hook} hook: {e}"))?;
    // Feed stdin from a thread while wait_with_output drains stdout/stderr;
    // writing inline could deadlock against a hook that fills its output pipe
    // before reading stdin. A hook that never reads stdin just EPIPEs the
    // write, which is ignored.
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let payload = payload.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
    });
    let out = child
        .wait_with_output()
        .map_err(|e| format!("failed to collect {hook} hook output: {e}"))?;
    let _ = writer.join();
    Ok(HookRun {
        hook: hook.to_string(),
        command: command.to_string(),
        // None = killed by a signal; -1 keeps exit_code a plain number in the
        // JSON contract.
        exit_code: out.status.code().unwrap_or(-1),
        stdout: capped(&out.stdout),
        stderr: capped(&out.stderr),
    })
}

/// Lossy UTF-8, truncated to [`OUTPUT_CAP`] on a char boundary.
fn capped(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() > OUTPUT_CAP {
        let cut = (0..=OUTPUT_CAP).rev().find(|i| s.is_char_boundary(*i));
        s.truncate(cut.unwrap_or(0));
        s.push_str("\n[truncated]");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, json: &str) -> PathBuf {
        let path = dir.join("hooks.json");
        std::fs::write(&path, json).unwrap();
        path
    }

    #[test]
    fn command_in_missing_file_is_unconfigured() {
        assert_eq!(command_in(Path::new("/nonexistent/hooks.json"), "x"), Ok(None));
    }

    #[test]
    fn command_in_reads_the_hook_and_misses_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"task-execute": "echo hi"}"#);
        assert_eq!(
            command_in(&path, TASK_EXECUTE).unwrap().as_deref(),
            Some("echo hi")
        );
        assert_eq!(command_in(&path, "other-hook").unwrap(), None);
    }

    #[test]
    fn command_in_rejects_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = command_in(&path, TASK_EXECUTE).unwrap_err();
        assert!(err.contains("malformed hooks config"), "{err}");
    }

    #[test]
    fn run_captures_output_env_stdin_and_exit() {
        let out = run(
            "test-hook",
            "cat; echo \"id=$MESA_TASK_ID hook=$MESA_HOOK\"; echo oops >&2; exit 3",
            None,
            &[("MESA_TASK_ID", "42".to_string())],
            "{\"payload\":true}",
        )
        .unwrap();
        assert_eq!(out.exit_code, 3);
        assert_eq!(out.stdout, "{\"payload\":true}id=42 hook=test-hook\n");
        assert_eq!(out.stderr, "oops\n");
        assert_eq!(out.hook, "test-hook");
    }

    #[test]
    fn run_honors_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let canon = dir.path().canonicalize().unwrap();
        let out = run(
            "test-hook",
            "pwd",
            Some(canon.to_str().unwrap()),
            &[],
            "",
        )
        .unwrap();
        assert_eq!(out.stdout.trim(), canon.to_str().unwrap());
    }

    #[test]
    fn run_survives_a_hook_that_ignores_stdin() {
        let out = run("test-hook", "exec 0<&-; echo ok", None, &[], "ignored").unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "ok\n");
    }

    #[test]
    fn capped_truncates_on_a_char_boundary() {
        let big = "é".repeat(OUTPUT_CAP); // 2 bytes each
        let cut = capped(big.as_bytes());
        assert!(cut.ends_with("[truncated]"));
        assert!(cut.len() <= OUTPUT_CAP + "\n[truncated]".len());
        assert_eq!(capped(b"small"), "small");
    }
}
