//! Claude Code agents surface: list the live sessions running under a
//! project's folder and start new background ones, by shelling out to the
//! `claude` CLI (like the CLI's git calls and usage.rs's curl — no new
//! protocol dependency). This module reads/spawns EXTERNAL state only; nothing
//! here touches the mesa store. Errors are concise strings the API maps to
//! `unavailable` (the claude CLI missing or misbehaving is an upstream
//! problem, like a dead usage endpoint).

use std::process::{Command, Stdio};

use crate::core::config;
use crate::core::types::AgentSession;

/// The `claude` binary to drive; `MESA_CLAUDE_BIN` overrides it for tests
/// (pointing at a stub), mirroring `MESA_CC_*` in cc.rs/usage.rs. Public so
/// the API's attach bridge spawns the same binary.
///
/// This feeds `{bin}` in the spawn command templates
/// ([`crate::core::config`]) — which the built-in defaults use, so the env
/// seam keeps working untouched. A user template that hardcodes a program
/// name instead has simply opted out of it; the attach bridge, which starts
/// no session, always uses this.
pub fn claude_bin() -> String {
    std::env::var("MESA_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// Default agent persona for sessions mesa spawns (`claude --agent <name>`).
/// mesa auto-dispatches engineering work (todo-watcher, inbox-watcher) and the
/// generic assistant persona is the wrong front door for it.
const DEFAULT_CLAUDE_AGENT: &str = "swe";

/// The agent to spawn sessions under. `MESA_CLAUDE_AGENT` overrides it; set it
/// **empty** to omit `--agent` entirely and get a plain `claude` session (the
/// escape hatch for a machine with no `swe` agent installed — an unknown agent
/// name is a hard startup failure in the claude CLI, not a warning).
/// Read-only sessions (`claude agents --json`) and the attach bridge don't
/// start a session, so neither takes this flag.
///
/// This feeds `{agent}` in the spawn command templates; empty ⇒ unavailable
/// ⇒ the default templates' `--agent {agent}` pair drops out
/// ([`crate::core::config::expand`]).
pub fn claude_agent() -> Option<String> {
    match std::env::var("MESA_CLAUDE_AGENT") {
        Ok(v) if v.trim().is_empty() => None,
        Ok(v) => Some(v),
        Err(_) => Some(DEFAULT_CLAUDE_AGENT.to_string()),
    }
}

/// Lists live Claude Code sessions started under `dir`. Filtered here in
/// Rust against `list_all()`'s parsed `cwd` field, rather than trusting
/// `claude agents --json --cwd <dir>`'s own matching: live QA on mesa task
/// 310 found a real session whose cwd exactly equaled `dir` missing from the
/// `--cwd`-filtered output while still present unfiltered (mesa task 313).
/// A follow-up sweep (exact/prefix/trailing-slash/symlinked/worktree paths)
/// couldn't reproduce the discrepancy against the installed CLI, so the
/// exact trigger is uncharacterized — deterministic client-side filtering
/// sidesteps trusting that black box at all, and is unit-testable without a
/// claude binary. Interactive sessions are included; only ones with a short
/// `id` (background) are attachable.
pub fn list_under(dir: &str) -> Result<Vec<AgentSession>, String> {
    Ok(list_all()?
        .into_iter()
        .filter(|s| is_under(&s.cwd, dir))
        .collect())
}

/// True if `cwd` is `dir` itself or a path strictly inside it — boundary-safe
/// (`/tmp/mesa-31` must not match `/tmp/mesa-313`), unlike a plain
/// `str::starts_with`.
fn is_under(cwd: &str, dir: &str) -> bool {
    let cwd = cwd.trim_end_matches('/');
    let dir = dir.trim_end_matches('/');
    cwd == dir
        || cwd
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Lists every live Claude Code session on the machine, with no folder
/// filter — backs the global Agents sidebar, which shows sessions across
/// every project at once instead of one project's folder.
pub fn list_all() -> Result<Vec<AgentSession>, String> {
    list_sessions(&claude_bin())
}

fn list_sessions(bin: &str) -> Result<Vec<AgentSession>, String> {
    let out = Command::new(bin)
        .args(["agents", "--json"])
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

/// Resolves the argv for one spawn `action` (`config::TODO_WATCHER`,
/// `INBOX_WATCHER` or `AGENT_SPAWN`): the user's `~/.mesa/config.json`
/// template if it configures that action, else the built-in default. Both go
/// through the same expander, so a missing config file yields exactly the argv
/// mesa hardcoded before the file existed. `{bin}`/`{agent}` are filled here,
/// from the env seams, rather than by callers.
fn argv_for(
    action: &str,
    id: Option<i64>,
    name: Option<&str>,
    prompt: Option<&str>,
) -> Result<Vec<String>, String> {
    let configured = config::command_for(action)?;
    let template = match &configured {
        Some(t) => t.as_str(),
        None => config::default_command(action)
            .ok_or_else(|| format!("no default command for {action}"))?,
    };
    let bin = claude_bin();
    let agent = claude_agent();
    config::expand(
        action,
        template,
        &config::Vars {
            bin: Some(&bin),
            agent: agent.as_deref(),
            id,
            name,
            prompt,
        },
    )
}

/// Starts a detached background session in `dir` and returns its short job id,
/// running the command [`argv_for`] resolves for `action` — by default
/// `claude --bg …`, or whatever `~/.mesa/config.json` puts there.
///
/// `id`/`name` (the watchers) and `prompt` (the Agents surface) are the values
/// that action's placeholders may use; what the command *does* with them —
/// which slash command, whether to name the session at all — belongs to the
/// template, not to this function.
///
/// The id is `None` when the command exits 0 without printing a
/// `backgrounded · <id>` receipt: a replacement command is not obliged to
/// speak `claude`'s receipt format, and the session it started is real either
/// way (the Agents sidebar discovers it through `claude agents --json`). Only
/// a nonzero exit is an error. Without an id, mesa can't pre-open an attach
/// pane for that session — the one thing the receipt buys.
///
/// **Stub authors:** `Command::output()` below waits for stdout/stderr EOF,
/// not for the child to exit — so a stub `claude` whose `--bg` branch leaves
/// a background process holding the inherited pipes (`sleep 3600 &`, a fake
/// long-lived session) blocks this call for that child's whole lifetime, even
/// though the stub itself returned instantly. That, not any lock or
/// serialization in mesa, is what a slow spawn under stub conditions means
/// (mesa task 468: a 30s stub child → a 30.3s `output()`; measured against
/// the real CLI, `--bg` returns in ~1.0s idle and ~1.0s with a prompt,
/// because it detaches its stdio). Keep stub `--bg` branches fork-free.
pub fn spawn_bg(
    action: &str,
    dir: &str,
    id: Option<i64>,
    name: Option<&str>,
    prompt: Option<&str>,
) -> Result<Option<String>, String> {
    spawn_argv(&argv_for(action, id, name, prompt)?, dir)
}

/// The argv is threaded in rather than resolved here so tests pin a whole
/// command line without mutating process-global env state.
fn spawn_argv(argv: &[String], dir: &str) -> Result<Option<String>, String> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "empty spawn command".to_string())?;
    let out = Command::new(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(parse_spawn(&String::from_utf8_lossy(&out.stdout)))
}

/// Extracts the job id from `claude --bg` output. Observed forms:
/// `backgrounded · e34b8ed9 (idle — send a prompt to start)` and
/// `backgrounded · cf0c3945 · my-name`. The real `claude` CLI colorizes this
/// line (unlike the plain-text test stub), so ANSI escapes are stripped
/// first — otherwise the id token comes out wrapped in escape bytes.
///
/// `None` (not an error) when no such line is present — see [`spawn_bg`].
fn parse_spawn(stdout: &str) -> Option<String> {
    let clean = strip_ansi(stdout);
    clean.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("backgrounded · ")?;
        let id = rest.split_whitespace().next()?;
        (!id.is_empty()).then(|| id.to_string())
    })
}

/// Strips ANSI CSI escape sequences (`ESC '[' <params> <final byte>`, e.g.
/// SGR color codes like `\x1b[36m`). No crate dependency for one narrow use.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            while matches!(chars.peek(), Some(c2) if c2.is_ascii_digit() || matches!(c2, ';' | ':' | '?'))
            {
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
    fn is_under_matches_exact_and_nested_boundary_safe() {
        assert!(is_under("/repo", "/repo")); // exact cwd == dir
        assert!(is_under("/repo/sub", "/repo")); // nested
        assert!(is_under("/repo/", "/repo")); // trailing slash on cwd
        assert!(is_under("/repo", "/repo/")); // trailing slash on dir
        assert!(!is_under("/repo-other", "/repo")); // string-prefix, not path-prefix
        assert!(!is_under("/repo", "/repo/sub")); // parent is not under its child
        assert!(!is_under("/elsewhere", "/repo"));
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
        // No receipt is not a failure — a configured replacement command owes
        // mesa nothing on stdout.
        assert_eq!(parse_spawn("no receipt here"), None);
    }

    #[test]
    fn parse_spawn_ignores_a_receipt_like_prefix() {
        // Guards the lenient path: "no id" must mean no id, not a truncated
        // one lifted out of an unrelated line.
        assert_eq!(parse_spawn("backgrounded ·\n"), None);
        assert_eq!(parse_spawn("not backgrounded · abc\n"), None);
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
    fn list_all_runs_without_a_cwd_filter() {
        let dir = tempfile::tempdir().unwrap();
        // Asserts the argv is exactly `agents --json` — no --cwd anywhere:
        // list_under filters client-side instead of trusting claude's own
        // --cwd matching (mesa task 313), so no code path ever passes it.
        let bin = stub_claude(
            dir.path(),
            r#"[ "$*" = "agents --json" ] || { echo "bad argv: $*" >&2; exit 1; }
echo '[]'"#,
        );
        assert_eq!(list_sessions(&bin).unwrap(), vec![]);
    }

    #[test]
    fn list_under_filters_client_side_on_exact_and_prefix_cwd() {
        let dir = tempfile::tempdir().unwrap();
        // Never passes --cwd; three sessions differing only in cwd, to prove
        // exact match, nested-prefix match, and a boundary near-miss.
        let bin = stub_claude(
            dir.path(),
            r#"[ "$*" = "agents --json" ] || { echo "bad argv: $*" >&2; exit 1; }
cat <<'JSON'
[
  {"pid": 1, "id": "aaaaaaaa", "cwd": "/repo", "kind": "background", "startedAt": 1, "sessionId": "s1", "status": "idle"},
  {"pid": 2, "id": "bbbbbbbb", "cwd": "/repo/sub", "kind": "background", "startedAt": 2, "sessionId": "s2", "status": "idle"},
  {"pid": 3, "id": "cccccccc", "cwd": "/repo-other", "kind": "background", "startedAt": 3, "sessionId": "s3", "status": "idle"}
]
JSON"#,
        );
        let sessions = list_sessions(&bin).unwrap();
        let filtered: Vec<_> = sessions
            .into_iter()
            .filter(|s| is_under(&s.cwd, "/repo"))
            .map(|s| s.id.unwrap())
            .collect();
        assert_eq!(filtered, vec!["aaaaaaaa", "bbbbbbbb"]);
    }

    /// Expands one action's *default* template the way `spawn_bg` would, with
    /// `bin`/`agent` pinned instead of read from the env.
    fn default_argv(
        action: &str,
        bin: &str,
        agent: Option<&str>,
        id: Option<i64>,
        name: Option<&str>,
        prompt: Option<&str>,
    ) -> Vec<String> {
        config::expand(
            action,
            config::default_command(action).unwrap(),
            &config::Vars {
                bin: Some(bin),
                agent,
                id,
                name,
                prompt,
            },
        )
        .unwrap()
    }

    #[test]
    fn spawn_bg_runs_in_dir_and_parses_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] || exit 1; echo "backgrounded · deadbeef (idle — send a prompt to start)""#,
        );
        let argv = default_argv(config::AGENT_SPAWN, &bin, None, None, None, None);
        let id = spawn_argv(&argv, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn spawn_bg_tolerates_a_command_with_no_receipt() {
        // A replacement command that starts a session its own way still
        // succeeds; only its exit code is load-bearing.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"echo "started, no receipt for you""#);
        let argv = vec![bin.clone()];
        assert_eq!(spawn_argv(&argv, dir.path().to_str().unwrap()), Ok(None));
        let failing = stub_claude(dir.path(), r#"echo "nope" >&2; exit 4"#);
        let err = spawn_argv(&[failing], dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn spawn_bg_passes_agent_before_name_and_prompt() {
        // `--agent` must land after `--bg` and before the `--` separator, or a
        // prompt-leading `-` swallows it. The stub asserts the full argv.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--agent" ] && [ "$3" = "swe" ] &&
              [ "$4" = "--name" ] && [ "$5" = "n" ] && [ "$6" = "--" ] &&
              [ "$7" = "/execute-mesa-task 9" ] ||
              { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · 5we00000 · n""#,
        );
        let argv = default_argv(
            config::TODO_WATCHER,
            &bin,
            Some("swe"),
            Some(9),
            Some("n"),
            None,
        );
        let id = spawn_argv(&argv, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("5we00000"));
    }

    #[test]
    fn spawn_bg_runs_a_configured_command_instead_of_claude() {
        // The end-to-end seam: a config file with its own template, expanded
        // and executed. `{bin}`/`{agent}` are deliberately unused here — a
        // replacement command names its own program.
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("argv.log");
        let tool = stub_claude(
            dir.path(),
            &format!(r#"printf '%s\n' "$@" > "{}""#, log.display()),
        );
        let config_file = dir.path().join("config.json");
        std::fs::write(
            &config_file,
            serde_json::json!({
                "commands": {
                    "todo-watcher": format!("{tool} dispatch --task {{id}} --label {{name}}"),
                }
            })
            .to_string(),
        )
        .unwrap();
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &config_file) };
        let spawned = spawn_bg(
            config::TODO_WATCHER,
            dir.path().to_str().unwrap(),
            Some(42),
            Some("mesa: a name with spaces"),
            None,
        );
        // Untouched actions still fall through to the built-in default.
        let fallback = argv_for(config::INBOX_WATCHER, Some(7), Some("n"), None).unwrap();
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert_eq!(spawned, Ok(None));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "dispatch\n--task\n42\n--label\nmesa: a name with spaces\n"
        );
        assert!(
            fallback.iter().any(|a| a == "/inbox-triage 7"),
            "{fallback:?}"
        );
    }

    #[test]
    fn spawn_bg_surfaces_a_broken_config_before_running_anything() {
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let config_file = dir.path().join("config.json");
        std::fs::write(&config_file, "{ not json").unwrap();
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &config_file) };
        let broken = argv_for(config::TODO_WATCHER, Some(1), Some("n"), None);
        std::fs::write(
            &config_file,
            r#"{"commands": {"todo-watcher": "tool {oops}"}}"#,
        )
        .unwrap();
        let bad_placeholder = argv_for(config::TODO_WATCHER, Some(1), Some("n"), None);
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert!(
            broken.unwrap_err().contains("malformed mesa config"),
            "a broken config must not read as unconfigured"
        );
        let err = bad_placeholder.unwrap_err();
        assert!(err.contains("{oops}"), "{err}");
    }

    #[test]
    fn claude_agent_defaults_to_swe_and_empty_disables() {
        // Env-driven; `MESA_CLAUDE_AGENT` is process-global. Takes the
        // crate-wide lock, not a private one — api.rs's watcher test reads the
        // same var through `spawn_bg`, so a second mutex would let these two
        // run concurrently and flake.
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::remove_var("MESA_CLAUDE_AGENT") };
        assert_eq!(claude_agent().as_deref(), Some("swe"));
        unsafe { std::env::set_var("MESA_CLAUDE_AGENT", "reviewer") };
        assert_eq!(claude_agent().as_deref(), Some("reviewer"));
        unsafe { std::env::set_var("MESA_CLAUDE_AGENT", "  ") };
        assert_eq!(claude_agent(), None);
        unsafe { std::env::remove_var("MESA_CLAUDE_AGENT") };
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
        let argv = default_argv(
            config::AGENT_SPAWN,
            &bin,
            None,
            None,
            None,
            Some("--resume"),
        );
        let id = spawn_argv(&argv, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("abc00000"));
    }

    #[test]
    fn spawn_bg_passes_name_flag_before_prompt_separator() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--name" ] && [ "$3" = "proj: do the thing" ] && [ "$4" = "--" ] ||
              { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · cf0c3945 · proj: do the thing""#,
        );
        let argv = default_argv(
            config::TODO_WATCHER,
            &bin,
            None,
            Some(1),
            Some("proj: do the thing"),
            None,
        );
        let id = spawn_argv(&argv, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("cf0c3945"));
    }

    #[test]
    fn failures_surface_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"echo "kaboom" >&2; exit 3"#);
        let err = list_sessions(&bin).unwrap_err();
        assert!(err.contains("kaboom"), "{err}");
        let missing = list_sessions("/nonexistent/claude").unwrap_err();
        assert!(missing.contains("failed to run claude"), "{missing}");
    }
}
