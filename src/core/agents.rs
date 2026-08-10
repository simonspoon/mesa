//! Claude Code agents surface: list the live sessions running under a
//! project's folder and start new background ones, by shelling out to the
//! `claude` CLI (like the CLI's git calls and usage.rs's curl — no new
//! protocol dependency). This module reads/spawns EXTERNAL state only; nothing
//! here touches the mesa store. Errors are concise strings the API maps to
//! `unavailable` (the claude CLI missing or misbehaving is an upstream
//! problem, like a dead usage endpoint).

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::SystemTime;

use crate::core::cc;
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
pub fn is_under(cwd: &str, dir: &str) -> bool {
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
    let mut sessions = parse_sessions(&out.stdout)?;
    // Enrichment is a separate step from parsing, and happens here rather than
    // in `list_under` so a project-scoped read costs the same one `ps` as the
    // global one — and so both surfaces (and the `agents_cache` TTL in
    // `src/api.rs`, which caches whatever this returns) see the same numbers.
    enrich_liveness(&mut sessions);
    Ok(sessions)
}

/// Kept pure (bytes in, sessions out) so the payload contract is unit-testable
/// without a claude binary, like usage.rs's `parse`.
fn parse_sessions(bytes: &[u8]) -> Result<Vec<AgentSession>, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("unexpected claude agents payload: {e}"))
}

/// Programs a Claude Code Bash tool call runs as, by basename of `comm`.
///
/// An **allowlist**, deliberately not an "any child" rule: every working
/// session also carries a `caffeinate` child, which is not work. Claude Code
/// spawns one `/bin/zsh -c 'source …/shell-snapshots/… && eval …'` child per
/// Bash invocation — it is not a persistent shell — so a live shell child *is*
/// a Bash call in flight.
const SHELL_COMMS: [&str; 4] = ["zsh", "bash", "sh", "dash"];

/// One row of the process table: `(pid, ppid, comm)`.
type ProcRow = (i64, i64, String);

/// Fills in the two mesa-derived liveness counts on a parsed session list.
///
/// **Fails open in every direction**: no `ps`, no projects dir, an unreadable
/// folder or an unparseable row all leave the counts at `0`. This is a
/// best-effort liveness probe hanging off the agents endpoints and the todo
/// watcher — it must never turn either into an error or park a watcher.
fn enrich_liveness(sessions: &mut [AgentSession]) {
    if sessions.is_empty() {
        return;
    }
    let table = read_proc_table();
    let root = cc::projects_dir();
    let now = SystemTime::now();
    for session in sessions.iter_mut() {
        session.live_shells = match session.pid {
            Some(pid) => count_shell_children(pid, &table),
            None => 0,
        };
        session.live_subagents = match root.as_deref() {
            Some(root) => count_live_subagents(root, &session.session_id, now),
            None => 0,
        };
    }
}

/// One `ps -A` for the whole session list, not one call per pid. An absent or
/// failing `ps` (or a Windows box, which has none) yields an empty table, and
/// therefore zero shells everywhere.
fn read_proc_table() -> Vec<ProcRow> {
    let out = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,comm="])
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(out) if out.status.success() => parse_proc_table(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// Pure half of [`read_proc_table`]: `pid ppid comm` per line, unparseable
/// lines skipped. `comm` may itself contain spaces, so it is the *rest* of the
/// line rather than a third whitespace token.
fn parse_proc_table(stdout: &str) -> Vec<ProcRow> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim_start().splitn(3, char::is_whitespace);
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.trim_start().parse().ok()?;
            let comm = parts.next()?.trim();
            (!comm.is_empty()).then(|| (pid, ppid, comm.to_string()))
        })
        .collect()
}

/// Direct children of `pid` whose command is one of [`SHELL_COMMS`], compared
/// by **basename** (`ps` reports `/bin/zsh` on macOS, `zsh` on Linux).
fn count_shell_children(pid: i64, table: &[ProcRow]) -> u32 {
    table
        .iter()
        .filter(|(child, ppid, comm)| {
            *ppid == pid && *child != pid && SHELL_COMMS.contains(&basename(comm))
        })
        .count() as u32
}

fn basename(comm: &str) -> &str {
    comm.rsplit('/').next().unwrap_or(comm)
}

/// Subagent transcripts for `session_id` touched within [`cc::ACTIVE_SECS`].
///
/// Subagents run in-process, so there is no child to count; each one writes
/// `<projects_dir>/<slug>/<session_id>/subagents/agent-*.jsonl`, and a recent
/// mtime on one of those is the liveness signal. The project slug is unknown
/// here, so every slug directory is checked for the session — the same
/// glob-by-session-id shape `cc.rs` uses.
fn count_live_subagents(root: &Path, session_id: &str, now: SystemTime) -> u32 {
    let Ok(slugs) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut live = 0u32;
    for slug in slugs.flatten() {
        let dir = slug.path().join(session_id).join("subagents");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .is_some_and(|mtime| match now.duration_since(mtime) {
                    Ok(age) => age.as_secs() as i64 <= cc::ACTIVE_SECS,
                    // mtime in the future (clock skew) is as live as it gets.
                    Err(_) => true,
                });
            if fresh {
                live += 1;
            }
        }
    }
    live
}

/// Resolves what to run for one spawn `action` (`config::TODO_WATCHER`,
/// `INBOX_WATCHER` or `AGENT_SPAWN`): the user's `~/.mesa/config.json`
/// template if it configures that action, else the built-in default. Both go
/// through the same resolver, so a missing config file yields exactly the argv
/// mesa hardcoded before the file existed. `{bin}`/`{agent}` are filled here,
/// from the env seams, rather than by callers.
///
/// A single-line value comes back as [`config::Spawn::Argv`]; a multi-line one
/// as [`config::Spawn::Script`], carrying the `MESA_*` environment the script
/// reads in place of placeholders (`docs/config.md`).
fn spawn_for(
    action: &str,
    id: Option<i64>,
    name: Option<&str>,
    prompt: Option<&str>,
) -> Result<config::Spawn, String> {
    let configured = config::command_for(action)?;
    let template = match &configured {
        Some(t) => t.as_str(),
        None => config::default_command(action)
            .ok_or_else(|| format!("no default command for {action}"))?,
    };
    let bin = claude_bin();
    let agent = claude_agent();
    config::resolve(
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
/// running the command [`spawn_for`] resolves for `action` — by default
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
    match spawn_for(action, id, name, prompt)? {
        config::Spawn::Argv(argv) => spawn_argv(&argv, dir),
        config::Spawn::Script { script, env } => spawn_script(&script, &env, dir),
    }
}

/// The argv is threaded in rather than resolved here so tests pin a whole
/// command line without mutating process-global env state.
fn spawn_argv(argv: &[String], dir: &str) -> Result<Option<String>, String> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "empty spawn command".to_string())?;
    let mut command = Command::new(program);
    command.args(args);
    run_spawn(command, program, dir)
}

/// Runs a configured **script** as `bash -c <script>`, with `env` set on the
/// child and every other `MESA_*` spawn variable explicitly removed.
///
/// Two properties this function exists to hold:
/// - The script text is handed to `bash` as one argument, **verbatim**. No
///   value is ever substituted into it, so a task name of `"; rm -rf / #` is
///   a string a script may read, never syntax a shell parses.
/// - A variable this action doesn't offer, or that has no value on this call,
///   is *removed* rather than left inherited or set empty — the script-mode
///   analogue of the argv drop rule (`docs/config.md`).
fn spawn_script(
    script: &str,
    env: &[(String, String)],
    dir: &str,
) -> Result<Option<String>, String> {
    let mut command = Command::new("bash");
    command.arg("-c").arg(script);
    for var in config::ALL_ENV_VARS {
        command.env_remove(var);
    }
    for (var, value) in env {
        command.env(var, value);
    }
    run_spawn(command, "bash", dir)
}

/// The half both modes share: run in `dir` with stdin closed, treat a nonzero
/// exit as the only failure, and lift an optional `backgrounded · <id>` receipt
/// off stdout. Identical either way, deliberately — a script owes mesa exactly
/// what an argv does.
fn run_spawn(mut command: Command, program: &str, dir: &str) -> Result<Option<String>, String> {
    let out = command
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

    /// `spawn_for` in argv mode. Every built-in default is single-line, so the
    /// tests below that pin an argv assert the mode too, by construction.
    fn argv_for(
        action: &str,
        id: Option<i64>,
        name: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<Vec<String>, String> {
        match spawn_for(action, id, name, prompt)? {
            config::Spawn::Argv(argv) => Ok(argv),
            other => panic!("expected argv mode, got {other:?}"),
        }
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
    fn spawn_script_runs_bash_with_the_env_handoff() {
        // A multi-line value runs under bash — so `cd`, `export` and a
        // conditional all work — and reads its values as MESA_* variables.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("script.log");
        let script = format!(
            "set -euo pipefail\n\
             printf '%s|%s|%s\\n' \"$MESA_ID\" \"$MESA_NAME\" \"$(pwd)\" > {}\n\
             echo \"backgrounded · 5c819700 · $MESA_NAME\"",
            log.display()
        );
        let env = config::script_env(
            config::TODO_WATCHER,
            &config::Vars {
                bin: Some("claude"),
                agent: Some("swe"),
                id: Some(9),
                name: Some("A: do the thing"),
                ..Default::default()
            },
        );
        let dir_path = std::fs::canonicalize(dir.path()).unwrap();
        let id = spawn_script(&script, &env, dir_path.to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("5c819700"));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            format!("9|A: do the thing|{}\n", dir_path.display())
        );
    }

    #[test]
    fn spawn_script_never_parses_an_untrusted_value_as_shell() {
        // The whole safety claim of script mode: the body reaches bash
        // verbatim and values arrive out-of-band, so a name full of shell
        // syntax is one string, not code.
        let dir = tempfile::tempdir().unwrap();
        let pwned = dir.path().join("pwned");
        let log = dir.path().join("name.log");
        let hostile = format!("\"; touch {} #", pwned.display());
        let script = format!("set -eu\nprintf '%s' \"$MESA_NAME\" > {}", log.display());
        let env = config::script_env(
            config::TODO_WATCHER,
            &config::Vars {
                id: Some(1),
                name: Some(&hostile),
                ..Default::default()
            },
        );
        spawn_script(&script, &env, dir.path().to_str().unwrap()).unwrap();
        assert!(!pwned.exists(), "the injected command ran");
        assert_eq!(std::fs::read_to_string(&log).unwrap(), hostile);
    }

    #[test]
    fn spawn_script_leaves_an_absent_value_unset_not_empty() {
        // `set -u` is the test: an unavailable value must be *unset*, and a
        // variable the action never offers must not leak in from mesa's own
        // environment either.
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("MESA_PROMPT", "leaked from mesa's own env") };
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("unset.log");
        let script = format!(
            "set -u\nprintf '%s|%s|%s\\n' \"${{MESA_AGENT:-<unset>}}\" \
             \"${{MESA_NAME:-<unset>}}\" \"${{MESA_PROMPT:-<unset>}}\" > {}",
            log.display()
        );
        // No agent (MESA_CLAUDE_AGENT=""), no name — and todo-watcher never
        // offers a prompt at all.
        let env = config::script_env(
            config::TODO_WATCHER,
            &config::Vars {
                id: Some(1),
                ..Default::default()
            },
        );
        let spawned = spawn_script(&script, &env, dir.path().to_str().unwrap());
        unsafe { std::env::remove_var("MESA_PROMPT") };
        spawned.unwrap();
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "<unset>|<unset>|<unset>\n"
        );
    }

    #[test]
    fn spawn_script_reports_no_receipt_and_a_nonzero_exit_like_argv() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(
            spawn_script("echo starting\necho done", &[], path),
            Ok(None)
        );
        let err = spawn_script("echo nope >&2\nexit 4", &[], path).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn spawn_bg_runs_a_configured_script() {
        // End to end through the config file: a multi-line agent-spawn value
        // is detected, run under bash, and its receipt parsed exactly as an
        // argv command's would be.
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("spawn.log");
        let config_file = dir.path().join("config.json");
        std::fs::write(
            &config_file,
            serde_json::json!({
                "commands": {
                    "agent-spawn": format!(
                        "cd \"$(pwd)\"\nexport PICKED=yes\nprintf '%s|%s\\n' \"$PICKED\" \"$MESA_PROMPT\" > {}\necho 'backgrounded · 5c819701'",
                        log.display()
                    ),
                }
            })
            .to_string(),
        )
        .unwrap();
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &config_file) };
        let spawned = spawn_bg(
            config::AGENT_SPAWN,
            dir.path().to_str().unwrap(),
            None,
            None,
            Some("look at the tests"),
        );
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert_eq!(spawned, Ok(Some("5c819701".to_string())));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "yes|look at the tests\n"
        );
    }

    // ---- liveness enrichment (mesa task 802) ----------------------------

    /// macOS-style `ps -A -o pid=,ppid=,comm=`: right-aligned pids and an
    /// absolute `comm`. Linux prints a bare `zsh`; both must count.
    const PS_OUTPUT: &str = "\
  501     1 /sbin/launchd
86593     1 /Applications/Claude.app/Contents/MacOS/claude
86601 86593 /usr/bin/caffeinate
86602 86593 /bin/zsh
86603 86593 /bin/zsh
86610 86593 node
90001     1 bash
";

    #[test]
    fn counts_only_allowlisted_shell_children() {
        let table = parse_proc_table(PS_OUTPUT);
        // Two zsh children; caffeinate (every working session has one) and
        // node are not work, and an unrelated top-level bash is not a child.
        assert_eq!(count_shell_children(86593, &table), 2);
        // A session with no children at all, and a pid nothing reports.
        assert_eq!(count_shell_children(86610, &table), 0);
        assert_eq!(count_shell_children(4242, &table), 0);
    }

    #[test]
    fn proc_table_parse_is_lenient_and_basename_matched() {
        // Garbage lines are skipped rather than failing the whole probe, and
        // a bare `bash` (Linux `comm`) counts the same as `/bin/bash`.
        let table = parse_proc_table("nope\n\n123 456 /bin/bash\n789 456 bash\nx y zsh\n");
        assert_eq!(table.len(), 2);
        assert_eq!(count_shell_children(456, &table), 2);
        assert_eq!(parse_proc_table(""), Vec::new());
    }

    #[test]
    fn a_process_is_not_its_own_shell_child() {
        // A self-parenting row (pid 1's ppid is itself on some systems) must
        // not make a session look busy.
        let table = parse_proc_table("7 7 /bin/zsh\n");
        assert_eq!(count_shell_children(7, &table), 0);
    }

    #[test]
    fn counts_subagent_transcripts_by_recent_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let session = "e34b8ed9-d391-4797-9d39-546d5b463357";
        let subagents = root.join("-Users-x-proj").join(session).join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(subagents.join("agent-1.jsonl"), "{}").unwrap();
        std::fs::write(subagents.join("agent-2.jsonl"), "{}").unwrap();
        // Not a transcript, and a *different* session's transcript.
        std::fs::write(subagents.join("notes.txt"), "x").unwrap();
        let other = root
            .join("-Users-x-other")
            .join("someone-else")
            .join("subagents");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("agent-9.jsonl"), "{}").unwrap();

        let now = SystemTime::now();
        assert_eq!(count_live_subagents(root, session, now), 2);
        // Same files, read from far enough in the future that every mtime is
        // older than the shared cc::ACTIVE_SECS window: nothing is live.
        let later = now + std::time::Duration::from_secs(cc::ACTIVE_SECS as u64 + 10);
        assert_eq!(count_live_subagents(root, session, later), 0);
        // Unknown session, and a projects dir that isn't there at all.
        assert_eq!(count_live_subagents(root, "no-such-session", now), 0);
        assert_eq!(count_live_subagents(&root.join("gone"), session, now), 0);
    }

    #[test]
    fn enrichment_fails_open_and_never_errors() {
        // No projects dir on disk and pids that don't exist: the counts are
        // simply 0 and the session list is still returned intact.
        let _guard = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("MESA_CC_PROJECTS_DIR", dir.path().join("absent")) };
        let bin = stub_claude(dir.path(), &format!("cat <<'JSON'\n{SESSIONS_JSON}\nJSON"));
        let sessions = list_sessions(&bin);
        unsafe { std::env::remove_var("MESA_CC_PROJECTS_DIR") };
        let sessions = sessions.unwrap();
        assert_eq!(sessions.len(), 2);
        // A missing projects dir is 0 subagents, not an Err. (`live_shells`
        // is asserted only through the pure counter above — these synthetic
        // pids could belong to anything on the machine running the tests.)
        assert!(sessions.iter().all(|s| s.live_subagents == 0));
    }

    #[test]
    fn liveness_counts_serialize_camel_case_and_default_when_absent() {
        // The CLI payload never carries these — parsing must not require them
        // — but the web UI reads them as `liveShells`/`liveSubagents`.
        let sessions = parse_sessions(SESSIONS_JSON.as_bytes()).unwrap();
        assert_eq!(sessions[0].live_shells, 0);
        assert_eq!(sessions[0].live_subagents, 0);
        let mut session = sessions[1].clone();
        session.live_shells = 3;
        session.live_subagents = 1;
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["liveShells"], 3);
        assert_eq!(json["liveSubagents"], 1);
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
