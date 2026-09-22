//! Claude Code agents surface: list the live sessions running under a
//! project's folder and start new background ones, by shelling out to the
//! `claude` CLI (like the CLI's git calls and usage.rs's curl — no new
//! protocol dependency). This module reads/spawns EXTERNAL state only; nothing
//! here touches the mesa store. Errors are concise strings the API maps to
//! `unavailable` (the claude CLI missing or misbehaving is an upstream
//! problem, like a dead usage endpoint).

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::core::cc;
use crate::core::config;
use crate::core::types::{AgentChild, AgentChildKind, AgentChildState, AgentSession};

/// The `claude` binary to drive; `MESA_CLAUDE_BIN` overrides it for tests
/// (pointing at a stub), mirroring `MESA_CC_*` in cc.rs/usage.rs. Public so
/// the API's attach bridge spawns the same binary.
///
/// Used directly by everything that is **not** a spawn template — listing
/// sessions, `claude stop`, the job lookup, the attach bridge and the terminal
/// pane. On the spawn path it is a **test seam, not a user lever** (mesa task
/// 1141): [`spawn_for`] substitutes it for the leading `claude` of a
/// **built-in default** template only ([`with_default_bin`]), so the check
/// scripts' stub binary keeps working, while a template the user configured
/// runs exactly as written, byte for byte. A user who wants a different binary
/// edits the line in Settings.
pub fn claude_bin() -> String {
    crate::core::env::var("CLAUDE_BIN").unwrap_or_else(|| "claude".to_string())
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
    enrich_pulse(&mut sessions);
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

/// One row of the process table.
struct ProcRow {
    pid: i64,
    ppid: i64,
    /// `ps`'s `etime` column in seconds — how long the process has been
    /// running. `None` for a row whose column did not parse; a child is still
    /// listed then, simply without a start time.
    elapsed_secs: Option<i64>,
    /// The program, as `ps -o comm=` reports it. macOS truncates this column
    /// to 16 characters once it is not the last one, which is why only its
    /// basename is ever read (`/bin/zsh` survives that cut intact).
    comm: String,
    /// The full command line (`ps -o args=`) — what a shell child's card is
    /// named by, since every Bash call runs the same `comm`.
    args: String,
}

/// Fills in the mesa-derived liveness fields on a parsed session list: the
/// two counts, and the list of children behind them (mesa task 1277).
///
/// **Fails open in every direction**: no `ps`, no projects dir, an unreadable
/// folder or an unparseable row all leave the counts at `0` and the list
/// empty. This is a best-effort liveness probe hanging off the agents
/// endpoints and the todo watcher — it must never turn either into an error
/// or park a watcher.
///
/// The counts are derived from the same walk that builds the list, so the
/// badge and the cards can never disagree — but they keep their exact
/// meanings: `live_subagents` counts only the **running** ones, while the
/// list also carries a finished subagent still inside the freshness window.
fn enrich_liveness(sessions: &mut [AgentSession]) {
    if sessions.is_empty() {
        return;
    }
    let table = read_proc_table();
    let root = cc::projects_dir();
    let now = SystemTime::now();
    for session in sessions.iter_mut() {
        let mut children = match root.as_deref() {
            Some(root) => subagent_children(root, &session.session_id, now),
            None => Vec::new(),
        };
        session.live_subagents = children
            .iter()
            .filter(|child| child.state == AgentChildState::Running)
            .count() as u32;
        let shells = match session.pid {
            Some(pid) => shell_children(pid, &table, now),
            None => Vec::new(),
        };
        session.live_shells = shells.len() as u32;
        children.extend(shells);
        session.children = children;
    }
}

/// Fills in the two mesa-derived pulse fields — what the session last said
/// and how much context it is holding — from each session's transcript
/// (task 869).
///
/// A sibling of [`enrich_liveness`] rather than part of it: the counts come
/// from `ps` and directory mtimes, these come from reading a file's tail, and
/// both are best-effort probes that must **fail open**. A session with no
/// transcript (never started, or a transcript Claude Code has removed) simply
/// keeps its `None`s — [`cc::session_pulse`] returns no error to swallow.
///
/// Runs on the same list, at the same place, for the same reason
/// [`enrich_liveness`] does: so `list_all` and `list_under` and the
/// `agents_cache` TTL in `src/api.rs` all see one set of numbers.
fn enrich_pulse(sessions: &mut [AgentSession]) {
    for session in sessions.iter_mut() {
        let pulse = cc::session_pulse(&session.session_id);
        session.last_response = pulse.last_response;
        session.context_tokens = pulse.context_tokens;
        session.model = pulse.model;
    }
}

/// One `ps -A` for the whole session list, not one call per pid. An absent or
/// failing `ps` (or a Windows box, which has none) yields an empty table, and
/// therefore zero shells everywhere.
fn read_proc_table() -> Vec<ProcRow> {
    let out = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,etime=,comm=,args="])
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(out) if out.status.success() => parse_proc_table(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// Pure half of [`read_proc_table`]: `pid ppid etime comm args…` per line,
/// unparseable lines skipped.
///
/// Fields are taken off the **front** one at a time rather than by splitting
/// the whole line, because `args` is the rest of it verbatim — spaces and
/// all — and `ps` right-aligns the columns before it (`"  501     1 …"`), so
/// every leading run of whitespace has to be stepped over rather than read as
/// an empty field. Getting that wrong silently drops every padded row, which
/// is most of them, and leaves the probe reporting zero shells on a real
/// machine while a single-spaced test fixture passes.
///
/// `comm` is one token here (it was the whole remainder while it was the last
/// column). A `comm` holding a space therefore loses its tail — but only a
/// row whose basename is one of [`SHELL_COMMS`] is ever read, and no shell's
/// path has a space in it.
fn parse_proc_table(stdout: &str) -> Vec<ProcRow> {
    stdout.lines().filter_map(parse_proc_row).collect()
}

fn parse_proc_row(line: &str) -> Option<ProcRow> {
    let (pid, rest) = next_field(line)?;
    let (ppid, rest) = next_field(rest)?;
    let (etime, rest) = next_field(rest)?;
    let (comm, rest) = next_field(rest)?;
    let args = rest.trim();
    Some(ProcRow {
        pid: pid.parse().ok()?,
        ppid: ppid.parse().ok()?,
        elapsed_secs: parse_etime(etime),
        comm: comm.to_string(),
        // A kernel thread has no argv at all; then the program is all there
        // is to say about it.
        args: if args.is_empty() { comm } else { args }.to_string(),
    })
}

/// The next whitespace-delimited token and the untouched remainder after it.
fn next_field(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    (end > 0).then(|| s.split_at(end))
}

/// `ps`'s `etime` — `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS` — as seconds.
/// `None` for anything else, including the `-` some systems print for a
/// process whose start time they cannot report.
fn parse_etime(etime: &str) -> Option<i64> {
    let (days, clock) = match etime.split_once('-') {
        Some((days, clock)) => (days.parse::<i64>().ok()?, clock),
        None => (0, etime),
    };
    let fields: Vec<&str> = clock.split(':').collect();
    if fields.len() < 2 || fields.len() > 3 {
        return None;
    }
    let mut secs = 0i64;
    for field in fields {
        secs = secs * 60 + field.parse::<i64>().ok()?;
    }
    Some(days * 86_400 + secs)
}

/// Direct children of `pid` whose command is one of [`SHELL_COMMS`], compared
/// by **basename** (`ps` reports `/bin/zsh` on macOS, `zsh` on Linux) — one
/// card each.
///
/// Every row here is `Running` by construction: Claude Code spawns one shell
/// per Bash call and it leaves the process table the moment the call returns,
/// so a finished one is simply not in `table`.
fn shell_children(pid: i64, table: &[ProcRow], now: SystemTime) -> Vec<AgentChild> {
    table
        .iter()
        .filter(|row| {
            row.ppid == pid && row.pid != pid && SHELL_COMMS.contains(&basename(&row.comm))
        })
        .map(|row| AgentChild {
            // A `ps` row is all there is of a shell child, and it holds
            // nothing that names a transcript — so there is nothing to open a
            // pane on but the command line already in `name`.
            id: None,
            kind: AgentChildKind::Shell,
            // Capped and stripped of control characters like every other
            // string mesa lifts out of something it does not own: this is a
            // command line someone wrote, rendered on a poll.
            name: cc::sanitize_capped(&row.args).unwrap_or_else(|| row.comm.clone()),
            // A Bash call in flight has returned nothing yet.
            detail: None,
            started_at: row.elapsed_secs.and_then(|secs| started_ago(now, secs)),
            context_tokens: None,
            // A shell has no transcript, so nothing names a model here.
            model: None,
            state: AgentChildState::Running,
        })
        .collect()
}

/// `now` minus `elapsed` seconds, as mesa's own stored timestamp text — so a
/// start time derived from `ps` reads exactly like one lifted off a
/// transcript, and the page parses both the same way.
fn started_ago(now: SystemTime, elapsed: i64) -> Option<String> {
    let epoch = now.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(cc::fmt_store_ts(epoch - elapsed))
}

fn basename(comm: &str) -> &str {
    comm.rsplit('/').next().unwrap_or(comm)
}

/// Subagent transcripts for `session_id` touched within [`cc::ACTIVE_SECS`].
///
/// Subagents run in-process, so there is no child to count; each one writes
/// `<projects_dir>/<slug>/<session_id>/subagents/agent-*.jsonl`, and a recent
/// mtime on one of those is the liveness signal — unless its last line shows
/// the subagent already ended its turn ([`subagent_finished`]), since a
/// supervisor closes its task seconds after reading the final report. The
/// project slug is unknown
/// here, so every slug directory is checked for the session — the same
/// glob-by-session-id shape `cc.rs` uses.
fn subagent_children(root: &Path, session_id: &str, now: SystemTime) -> Vec<AgentChild> {
    let mut out = Vec::new();
    let Ok(slugs) = std::fs::read_dir(root) else {
        return out;
    };
    for slug in slugs.flatten() {
        let dir = slug.path().join(session_id).join("subagents");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
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
            if !fresh {
                continue;
            }
            let pulse = cc::subagent_pulse(&path);
            out.push(AgentChild {
                // The transcript's file stem — free here, since this walk
                // already holds the path — and the id
                // `cc::subagent_chat` reads the run back by (mesa task 1278).
                id: path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|stem| stem.to_string()),
                kind: AgentChildKind::Subagent,
                name: subagent_name(&path),
                detail: pulse.detail,
                started_at: pulse.started_at,
                context_tokens: pulse.context_tokens,
                model: pulse.model,
                state: if subagent_finished(&path) {
                    AgentChildState::Finished
                } else {
                    AgentChildState::Running
                },
            });
        }
    }
    out
}

/// What a subagent run calls itself: the `agentType` of the `.meta.json`
/// sidecar Claude Code writes beside every `agent-<hash>.jsonl`. A missing,
/// unreadable or unparseable sidecar falls back to the file stem, so a run is
/// never listed nameless — the sidecar is another program's file and mesa
/// must not need it to be there.
fn subagent_name(path: &Path) -> String {
    meta_agent_type(path).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("subagent")
            .to_string()
    })
}

fn meta_agent_type(path: &Path) -> Option<String> {
    // `agent-<hash>.jsonl` -> `agent-<hash>.meta.json`.
    let text = std::fs::read_to_string(path.with_extension("meta.json")).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&text).ok()?;
    cc::sanitize_capped(meta.get("agentType")?.as_str()?)
}

/// True iff a subagent transcript's last non-empty line is an `assistant`
/// message with `stop_reason: "end_turn"` — the subagent has handed back its
/// report, however recent its mtime. Only the file's tail is read. Anything
/// else (unreadable, unparseable, a `tool_use` stop, a user line) is `false`,
/// so an uncertain file still counts as live.
fn subagent_finished(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 64 * 1024;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    let Some(last) = text.lines().rev().find(|l| !l.trim().is_empty()) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(last) else {
        return false;
    };
    v["type"] == "assistant" && v["message"]["stop_reason"] == "end_turn"
}

/// Resolves the script to run for one spawn `action` (`config::TODO_WATCHER`,
/// `INBOX_WATCHER` or `AGENT_SPAWN`): the user's `~/.mesa/config.json` hook
/// if it configures that action, else the built-in default. Both go through
/// the same resolver, so a missing config file yields exactly the command
/// line mesa hardcoded before the file existed.
///
/// The one thing the two paths do not share is the `MESA_CLAUDE_BIN` seam:
/// only a **default** template has its leading `claude` swapped for
/// [`claude_bin`] ([`with_default_bin`]). mesa wrote that program name itself,
/// so it may stand in for it; a configured template is the user's text and is
/// run as written — the env var must never be where a hook's binary silently
/// comes from (mesa task 1141).
fn spawn_for(
    action: &str,
    id: Option<i64>,
    name: Option<&str>,
    prompt: Option<&str>,
    prompts: &config::Prompts,
) -> Result<String, String> {
    let configured = config::command_for(action)?;
    let template = match &configured {
        Some(t) => t.as_str(),
        None => config::default_command(action)
            .ok_or_else(|| format!("no default command for {action}"))?,
    };
    let script = config::resolve(
        action,
        template,
        &config::Vars {
            id,
            name,
            prompt,
            prompts: Some(prompts),
        },
    )?;
    Ok(if configured.is_none() {
        with_default_bin(script, &claude_bin())
    } else {
        script
    })
}

/// The `MESA_CLAUDE_BIN` test seam for a **built-in default** template: the
/// `claude` word every default starts with becomes `bin`, single-quoted so a
/// path with a space or a `'` in it is still one word. Every default names
/// `claude` first, so any other first word is left alone — this only ever
/// rewrites what mesa itself wrote.
fn with_default_bin(script: String, bin: &str) -> String {
    match script.strip_prefix("claude") {
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => {
            format!("'{}'{rest}", bin.replace('\'', "'\\''"))
        }
        _ => script,
    }
}

/// Starts a detached background session in `dir` and returns its short job id,
/// running the script [`spawn_for`] resolves for `action` — by default
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
    prompts: &config::Prompts,
) -> Result<Option<String>, String> {
    run_script(&spawn_for(action, id, name, prompt, prompts)?, dir)
}

/// Stops the background session with short job id `job_id`
/// (`claude stop <id>`), the other end of [`spawn_bg`]'s receipt.
///
/// Deliberately **not** a config template: a template chooses which program
/// starts a session and what it is told to do, and mesa must be able to stop
/// exactly the session it started — `claude stop` takes the id `claude --bg`
/// printed, so both halves are the same binary ([`claude_bin`]) whatever the
/// start template says. A replacement command that prints no receipt leaves
/// mesa no id, and therefore nothing to stop; that is the same limitation the
/// attach pane already has.
///
/// Errors are the module's usual concise strings. Callers treat a failure as
/// best-effort: the store write that ended the conversation is the truth, and
/// an agent that outlives it stops itself on its next loop.
pub fn stop(job_id: &str) -> Result<(), String> {
    stop_session(&claude_bin(), job_id)
}

/// The short **background job id** of the session whose `sessionId` is
/// `session_id`, or `Ok(None)` when nothing on this machine names it.
///
/// The cost guard's other end (mesa task 1054): it knows a session by the uuid
/// its transcript is written under, and [`stop`] takes the short id
/// `claude --bg` printed. Only `claude agents` knows both, so this is a lookup
/// and never an inference — the two ids share a prefix on most rows
/// (`89dc6ccd` and `89dc6ccd-d3c1-…`) and slicing one out of the other would
/// be a guess that stops the wrong session on the row where it does not hold.
///
/// `--all` because a runaway is by definition not in the folder mesa is asking
/// from; an interactive session has no `id` at all, so it answers `None` and
/// the guard reports that it could not stop anything.
pub fn find_job_for_session(session_id: &str) -> Result<Option<String>, String> {
    find_job(&claude_bin(), session_id)
}

fn find_job(bin: &str, session_id: &str) -> Result<Option<String>, String> {
    job_for_session(&list_all_agents(bin)?, session_id)
}

/// The `sessionId` of the background session whose short job id is `job_id`,
/// or `Ok(None)` when no row names it — the reverse of
/// [`find_job_for_session`], for `mesa live context` (mesa task 1150): a live
/// session knows its agent by the receipt `claude --bg` printed, and the
/// transcript `cc::session_pulse` reads is filed under the uuid. Same lookup,
/// same reason it is never an inference.
pub fn find_session_for_job(job_id: &str) -> Result<Option<String>, String> {
    session_for_job(&list_all_agents(&claude_bin())?, job_id)
}

/// What the background job `job_id` is waiting on, when `claude agents`
/// reports it `blocked` — its `waitingFor` string ("permission prompt") — or
/// `Ok(None)` for a job that is working, done, or not listed. The one signal
/// behind `GET /api/live`'s derived `blocked` (mesa task 1157): the live
/// agent cannot report its own stuck state, so mesa reads it off the CLI's
/// own view of the job. Same lookup, same reason it is never an inference.
pub fn job_blocked_on(job_id: &str) -> Result<Option<String>, String> {
    blocked_on(&list_all_agents(&claude_bin())?, job_id)
}

/// Whether the background job `job_id` is still running, per `claude agents
/// --json --all`: a row with that short id whose `state` is not
/// `done`/`failed`/`stopped`. What a resting `listen` polls (mesa task 1155)
/// to learn the dream agent has finished. **Every failure is `false`** — a
/// missing binary, bad JSON, no such row — because a probe that cannot
/// answer must never keep a conversation waiting on a job it cannot see.
pub fn job_running(job_id: &str) -> bool {
    list_all_agents(&claude_bin())
        .map(|bytes| running(&bytes, job_id))
        .unwrap_or(false)
}

/// Pure half of [`job_running`]: bytes in, a verdict out, and unparseable
/// bytes are `false` for the reason above.
fn running(bytes: &[u8], job_id: &str) -> bool {
    let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(bytes) else {
        return false;
    };
    rows.iter().any(|row| {
        row.get("id").and_then(|v| v.as_str()) == Some(job_id)
            && !matches!(
                row.get("state").and_then(|v| v.as_str()),
                Some("done" | "failed" | "stopped")
            )
    })
}

/// `claude agents --json --all`, raw — the payload both lookups above read.
fn list_all_agents(bin: &str) -> Result<Vec<u8>, String> {
    let out = Command::new(bin)
        .args(["agents", "--json", "--all"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude agents failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// Pure half of [`find_job_for_session`] — bytes in, job id out — so the
/// payload contract is unit-testable without a claude binary, like
/// [`parse_sessions`].
///
/// Rows are read as loose JSON rather than as [`AgentSession`]: this asks two
/// string keys of each row, and a payload that grew a field mesa's typed shape
/// rejects must not cost the guard its only way to stop anything. A row
/// missing either key is skipped; JSON that is not an array of objects is the
/// error.
fn job_for_session(bytes: &[u8], session_id: &str) -> Result<Option<String>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|e| format!("unexpected claude agents payload: {e}"))?;
    Ok(rows.into_iter().find_map(|row| {
        (row.get("sessionId").and_then(|v| v.as_str()) == Some(session_id))
            .then(|| row.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .flatten()
    }))
}

/// Pure half of [`find_session_for_job`], read as loosely as
/// [`job_for_session`] and for the same reason.
fn session_for_job(bytes: &[u8], job_id: &str) -> Result<Option<String>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|e| format!("unexpected claude agents payload: {e}"))?;
    Ok(rows.into_iter().find_map(|row| {
        (row.get("id").and_then(|v| v.as_str()) == Some(job_id))
            .then(|| {
                row.get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .flatten()
    }))
}

/// Pure half of [`job_blocked_on`], read as loosely as [`job_for_session`]
/// and for the same reason. `state: "blocked"` is upstream's single
/// `requires_action` bucket and covers five distinct reasons — a permission
/// prompt, a queued elicitation (`input needed`), a worker request, a sandbox
/// request and a plain open dialog, the last of which is exactly the shape an
/// idle background session sitting in a background `listen` presents. Only
/// the first is what the live notice speaks about, so the signal needs a
/// **positive** indication (mesa task 1293): `waitingFor` must be present and
/// name a permission, matched as a substring so a variant like `tool
/// permission prompt` still counts while the other four do not. A blocked row
/// that says nothing about why answers `None` — an unexplained block is not
/// evidence of a prompt.
fn blocked_on(bytes: &[u8], job_id: &str) -> Result<Option<String>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|e| format!("unexpected claude agents payload: {e}"))?;
    Ok(rows.into_iter().find_map(|row| {
        if row.get("id").and_then(|v| v.as_str()) != Some(job_id) {
            return None;
        }
        if row.get("state").and_then(|v| v.as_str()) != Some("blocked") {
            return None;
        }
        let waiting = row.get("waitingFor").and_then(|v| v.as_str())?;
        waiting
            .trim()
            .to_ascii_lowercase()
            .contains("permission")
            .then(|| waiting.to_string())
    }))
}

/// The binary is threaded in — like `list_sessions` under `list_all` — so the
/// argv is unit-testable against a stub without mutating process-global env.
fn stop_session(bin: &str, job_id: &str) -> Result<(), String> {
    let out = Command::new(bin)
        .arg("stop")
        .arg(job_id)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run {bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude stop {job_id} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Runs a resolved hook script as `bash -c <script>` in `dir`, with stdin
/// closed, a nonzero exit the only failure, and an optional
/// `backgrounded · <id>` receipt lifted off stdout.
///
/// The script is handed to `bash` as one argument, and every value it carries
/// was placed there by `config::substitute_script` **shell-quoted for the
/// context it sits in** — a task name of `"; rm -rf / #` arrives as the
/// string literal `'"; rm -rf / #'`, one argument to whatever the script runs.
/// Nothing is set in the environment: there are no `MESA_*` variables any more
/// (mesa task 1143), so nothing has to be removed either. The script is threaded
/// in rather than resolved here so tests pin a whole command line without
/// mutating process-global env state.
fn run_script(script: &str, dir: &str) -> Result<Option<String>, String> {
    let out = Command::new("bash")
        .arg("-c")
        .arg(script)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run bash: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "bash failed: {}",
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

    /// `blocked_on` reads a job's `state`/`waitingFor` pair (mesa task 1157),
    /// and since mesa task 1293 only a reason naming a permission counts: the
    /// captured blocked row answers its prompt, a working row and an unknown
    /// id answer nothing, and a blocked row whose reason is one of the four
    /// other `requires_action` cases — or which gives no reason at all —
    /// answers nothing too.
    #[test]
    fn blocked_on_reads_the_waiting_for_string_of_a_blocked_job() {
        let bytes = SESSIONS_JSON.as_bytes();
        assert_eq!(
            blocked_on(bytes, "e34b8ed9").unwrap().as_deref(),
            Some("permission prompt")
        );
        assert_eq!(blocked_on(bytes, "nope").unwrap(), None);
        let working = br#"[{"id": "aaaa", "sessionId": "s", "state": "working"},
                           {"id": "bbbb", "sessionId": "t", "state": "blocked"}]"#;
        assert_eq!(blocked_on(working, "aaaa").unwrap(), None);
        assert_eq!(
            blocked_on(working, "bbbb").unwrap(),
            None,
            "a blocked row with no reason is not evidence of a prompt"
        );
        // The four `requires_action` reasons that are not a permission prompt
        // — `dialog open` being what an idle background `listen` presents.
        let others = br#"[{"id": "cccc", "state": "blocked", "waitingFor": "dialog open"},
                          {"id": "dddd", "state": "blocked", "waitingFor": "input needed"},
                          {"id": "eeee", "state": "blocked", "waitingFor": "worker request"},
                          {"id": "ffff", "state": "blocked", "waitingFor": "sandbox request"},
                          {"id": "gggg", "state": "blocked", "waitingFor": "Tool Permission Prompt"}]"#;
        assert_eq!(blocked_on(others, "cccc").unwrap(), None);
        assert_eq!(blocked_on(others, "dddd").unwrap(), None);
        assert_eq!(blocked_on(others, "eeee").unwrap(), None);
        assert_eq!(blocked_on(others, "ffff").unwrap(), None);
        assert_eq!(
            blocked_on(others, "gggg").unwrap().as_deref(),
            Some("Tool Permission Prompt"),
            "a variant naming a permission still counts, and comes back verbatim"
        );
        assert!(blocked_on(b"not json", "aaaa").is_err());
    }

    /// `running` (mesa task 1155): a listed job in any live state is running,
    /// a finished one and an unlisted one are not, and garbage is `false`
    /// rather than an error — the probe must never strand a conversation.
    #[test]
    fn running_is_true_only_for_a_listed_job_in_a_live_state() {
        assert!(running(SESSIONS_JSON.as_bytes(), "e34b8ed9"));
        assert!(!running(SESSIONS_JSON.as_bytes(), "nope"));
        let mixed = br#"[{"id": "aaaa", "state": "working"},
                         {"id": "bbbb", "state": "done"},
                         {"id": "cccc", "state": "failed"},
                         {"id": "dddd", "state": "stopped"},
                         {"id": "eeee"}]"#;
        assert!(running(mixed, "aaaa"));
        assert!(!running(mixed, "bbbb"));
        assert!(!running(mixed, "cccc"));
        assert!(!running(mixed, "dddd"));
        assert!(
            running(mixed, "eeee"),
            "no state at all is still a listed job"
        );
        assert!(!running(b"not json", "aaaa"));
        assert!(!running(b"[]", "aaaa"));
    }

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
    fn a_session_uuid_resolves_to_its_short_job_id() {
        let bytes = SESSIONS_JSON.as_bytes();
        // The background row: the short id is looked up, never sliced out of
        // the uuid — they only happen to share a prefix.
        assert_eq!(
            job_for_session(bytes, "e34b8ed9-d391-4797-9d39-546d5b463357").unwrap(),
            Some("e34b8ed9".to_string())
        );
        // An interactive session has no job id at all, so there is nothing to
        // stop — `None`, not an error.
        assert_eq!(
            job_for_session(bytes, "4230f7c7-5e6b-41a0-9f5e-7c6fa4e570f9").unwrap(),
            None
        );
        // A session no row names.
        assert_eq!(job_for_session(bytes, "c2b83256-1111").unwrap(), None);
        assert_eq!(job_for_session(b"[]", "anything").unwrap(), None);
        // A row shape mesa's typed `AgentSession` would reject still answers,
        // because the lookup asks for two string keys and nothing else.
        assert_eq!(
            job_for_session(br#"[{"id":"abc","sessionId":"zzz","brandNew":{}}]"#, "zzz").unwrap(),
            Some("abc".to_string())
        );
        // Rows missing either key are skipped rather than fatal, so the first
        // matching row that actually names a job is the answer.
        assert_eq!(
            job_for_session(
                br#"[{"sessionId":"zzz"},{"id":"abc","sessionId":"zzz"}]"#,
                "zzz"
            )
            .unwrap(),
            Some("abc".to_string())
        );
        assert!(job_for_session(b"not json", "zzz").is_err());
        assert!(job_for_session(br#"{"id":"abc"}"#, "zzz").is_err());
    }

    /// The reverse lookup (mesa task 1150): a short job id resolves to the
    /// uuid its transcript is filed under, and nothing else is inferred.
    #[test]
    fn a_short_job_id_resolves_to_its_session_uuid() {
        let bytes = SESSIONS_JSON.as_bytes();
        assert_eq!(
            session_for_job(bytes, "e34b8ed9").unwrap(),
            Some("e34b8ed9-d391-4797-9d39-546d5b463357".to_string())
        );
        assert_eq!(session_for_job(bytes, "nope").unwrap(), None);
        assert_eq!(session_for_job(b"[]", "e34b8ed9").unwrap(), None);
        assert_eq!(
            session_for_job(br#"[{"id":"abc"},{"id":"abc","sessionId":"zzz"}]"#, "abc").unwrap(),
            Some("zzz".to_string())
        );
        assert!(session_for_job(b"not json", "abc").is_err());
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

    /// mesa applies **no** state/command/pid filter to what `claude agents
    /// --json` reports — a `done` row sitting in the home folder stays listed,
    /// and the sidebar's DONE bucket (mesa task 861) is where it belongs.
    ///
    /// Measured (mesa task 1040): every `claude --bg` agent, running ones
    /// included, is a daemon-claimed process whose argv is `claude bg-spare
    /// --bg-spare <claim.sock>`, so filtering rows on that command line would
    /// hide every agent; and `claude agents --json` already omits an unclaimed
    /// spare, so an idle daemon worker never appears as a row in the first
    /// place. There is nothing left for mesa to filter out.
    #[test]
    fn list_all_keeps_done_rows_because_every_bg_agent_is_a_daemon_spare() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$*" = "agents --json" ] || { echo "bad argv: $*" >&2; exit 1; }
cat <<'JSON'
[
  {"pid": 11, "id": "dddddddd", "cwd": "/Users/someone", "kind": "background", "startedAt": 1, "sessionId": "s1", "state": "done"},
  {"pid": 12, "id": "eeeeeeee", "cwd": "/repo", "kind": "background", "startedAt": 2, "sessionId": "s2", "state": "working"}
]
JSON"#,
        );
        let sessions = list_sessions(&bin).unwrap();
        let rows: Vec<_> = sessions
            .iter()
            .map(|s| {
                (
                    s.id.as_deref().unwrap(),
                    s.state.as_deref().unwrap(),
                    s.cwd.as_str(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("dddddddd", "done", "/Users/someone"),
                ("eeeeeeee", "working", "/repo"),
            ]
        );
    }

    /// The other end of a spawn receipt: `claude stop <short id>`, the short
    /// job id and nothing else (the full `sessionId` UUID is not a job).
    #[test]
    fn stop_passes_the_short_job_id_to_claude_stop() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$*" = "stop e34b8ed9" ] || { echo "bad argv: $*" >&2; exit 1; }"#,
        );
        assert_eq!(stop_session(&bin, "e34b8ed9"), Ok(()));
    }

    /// A stop that fails surfaces the binary's stderr, so the caller's warning
    /// says what went wrong. (Callers treat it as best-effort — the ended
    /// session is already written.)
    #[test]
    fn stop_surfaces_stderr_on_a_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"echo "No job matching" >&2; exit 1"#);
        let err = stop_session(&bin, "nope").unwrap_err();
        assert!(err.contains("No job matching"), "{err}");
        assert!(err.contains("nope"), "{err}");
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

    /// `spawn_for` with an empty prompt library — the resolved script.
    fn script_for(
        action: &str,
        id: Option<i64>,
        name: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<String, String> {
        spawn_for(action, id, name, prompt, &config::Prompts::default())
    }

    /// Resolves one action's *default* template the way `spawn_bg` would, with
    /// the binary pinned to `bin` instead of read from `MESA_CLAUDE_BIN` —
    /// through the same [`with_default_bin`] seam the real path uses.
    fn default_script(
        action: &str,
        bin: &str,
        id: Option<i64>,
        name: Option<&str>,
        prompt: Option<&str>,
    ) -> String {
        let script = config::resolve(
            action,
            config::default_command(action).unwrap(),
            &config::Vars {
                id,
                name,
                prompt,
                ..Default::default()
            },
        )
        .unwrap();
        with_default_bin(script, bin)
    }

    #[test]
    fn spawn_bg_runs_in_dir_and_parses_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] || exit 1; echo "backgrounded · deadbeef (idle — send a prompt to start)""#,
        );
        let script = default_script(config::AGENT_SPAWN, &bin, None, None, None);
        let id = run_script(&script, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn spawn_bg_tolerates_a_command_with_no_receipt() {
        // A replacement command that starts a session its own way still
        // succeeds; only its exit code is load-bearing.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(dir.path(), r#"echo "started, no receipt for you""#);
        assert_eq!(run_script(&bin, dir.path().to_str().unwrap()), Ok(None));
        let failing = stub_claude(dir.path(), r#"echo "nope" >&2; exit 4"#);
        let err = run_script(&failing, dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn the_default_bin_seam_rewrites_only_a_defaults_leading_claude() {
        // Quoted, so a stub path with a space in it is one word; and only the
        // word `claude` at the very front — a configured first word, or a
        // `claude` that is a prefix of something else, is left alone.
        assert_eq!(
            with_default_bin("claude --bg -- 'p'".into(), "/tmp/my stub/claude"),
            "'/tmp/my stub/claude' --bg -- 'p'"
        );
        assert_eq!(with_default_bin("claude".into(), "/s/c"), "'/s/c'");
        assert_eq!(
            with_default_bin("claude-two --bg".into(), "/s/c"),
            "claude-two --bg"
        );
        assert_eq!(
            with_default_bin("mytool claude".into(), "/s/c"),
            "mytool claude"
        );
    }

    #[test]
    fn spawn_bg_passes_agent_before_name_and_prompt() {
        // `--agent` must land after `--bg` and before the `--` separator, or a
        // prompt-leading `-` swallows it. The stub asserts the full argv. The
        // agent is the literal `supervisor` since mesa task 1075.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--agent" ] && [ "$3" = "supervisor" ] &&
              [ "$4" = "--name" ] && [ "$5" = "n" ] && [ "$6" = "--" ] &&
              [ "$7" = "/execute-mesa-task 9" ] && [ "$#" = 7 ] ||
              { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · 5we00000 · n""#,
        );
        let script = default_script(config::TODO_WATCHER, &bin, Some(9), Some("n"), None);
        let id = run_script(&script, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("5we00000"));
    }

    #[test]
    fn spawn_bg_runs_a_configured_command_instead_of_claude() {
        // The end-to-end seam: a config file with its own hook, resolved and
        // executed. A replacement command names its own program, and a name
        // with spaces is one argument to it.
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
            &config::Prompts::default(),
        );
        // Untouched actions still fall through to the built-in default.
        let fallback = script_for(config::INBOX_WATCHER, Some(7), Some("n"), None).unwrap();
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert_eq!(spawned, Ok(None));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "dispatch\n--task\n42\n--label\nmesa: a name with spaces\n"
        );
        assert!(
            fallback.contains("\"Triage mesa inbox item 7.\""),
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
        let broken = script_for(config::TODO_WATCHER, Some(1), Some("n"), None);
        std::fs::write(
            &config_file,
            r#"{"commands": {"todo-watcher": "tool {oops}"}}"#,
        )
        .unwrap();
        let bad_placeholder = script_for(config::TODO_WATCHER, Some(1), Some("n"), None);
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert!(
            broken.unwrap_err().contains("malformed mesa config"),
            "a broken config must not read as unconfigured"
        );
        let err = bad_placeholder.unwrap_err();
        assert!(err.contains("{oops}"), "{err}");
    }

    #[test]
    fn spawn_bg_passes_dash_prompt_after_separator() {
        // A prompt beginning with `-` must reach claude as a positional, not a
        // flag: the stub asserts `--bg --model opus --agent supervisor --
        // <prompt>` and echoes the prompt back.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--model" ] && [ "$3" = "opus" ] &&
              [ "$4" = "--agent" ] && [ "$5" = "supervisor" ] && [ "$6" = "--" ] &&
              [ "$7" = "--resume" ] && [ "$#" = 7 ] || { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · abc00000""#,
        );
        let script = default_script(config::AGENT_SPAWN, &bin, None, None, Some("--resume"));
        let id = run_script(&script, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("abc00000"));
    }

    #[test]
    fn spawn_bg_passes_name_flag_before_prompt_separator() {
        // The todo-watcher default names its agent literally (mesa task
        // 1075), so `--agent supervisor` is there; what this pins is `--name`
        // landing before the `--`.
        let dir = tempfile::tempdir().unwrap();
        let bin = stub_claude(
            dir.path(),
            r#"[ "$1" = "--bg" ] && [ "$2" = "--agent" ] && [ "$3" = "supervisor" ] &&
              [ "$4" = "--name" ] && [ "$5" = "proj: do the thing" ] && [ "$6" = "--" ] ||
              { echo "bad argv: $*" >&2; exit 1; }
echo "backgrounded · cf0c3945 · proj: do the thing""#,
        );
        let script = default_script(
            config::TODO_WATCHER,
            &bin,
            Some(1),
            Some("proj: do the thing"),
            None,
        );
        let id = run_script(&script, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("cf0c3945"));
    }

    #[test]
    fn a_hook_runs_under_bash_with_its_values_in_place() {
        // A multi-line value runs under bash — so `cd`, `export` and a
        // conditional all work — with each `{placeholder}` already quoted
        // into the text.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("script.log");
        let template = format!(
            "set -euo pipefail\n\
             printf '%s|%s|%s\\n' {{id}} {{name}} \"$(pwd)\" > {}\n\
             echo \"backgrounded · 5c819700 · {{name}}\"",
            log.display()
        );
        let script = config::resolve(
            config::TODO_WATCHER,
            &template,
            &config::Vars {
                id: Some(9),
                name: Some("A: do the thing"),
                ..Default::default()
            },
        )
        .unwrap();
        let dir_path = std::fs::canonicalize(dir.path()).unwrap();
        let id = run_script(&script, dir_path.to_str().unwrap()).unwrap();
        assert_eq!(id.as_deref(), Some("5c819700"));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            format!("9|A: do the thing|{}\n", dir_path.display())
        );
    }

    #[test]
    fn spawn_script_never_parses_an_untrusted_value_as_shell() {
        // The whole safety claim: the value *is* in the script text now, but
        // as a quoted string literal, and it reaches the program as exactly
        // one argument with nothing in it executed. Every one of these runs
        // through a real `bash -c`, in the two positions a hook author writes.
        let dir = tempfile::tempdir().unwrap();
        let pwned = dir.path().join("pwned");
        for hostile in [
            format!("\"; touch {} #", pwned.display()),
            format!("`touch {}`", pwned.display()),
            format!("$(touch {})", pwned.display()),
            format!("'; touch {}; '", pwned.display()),
            "it's a name".to_string(),
            "a name with spaces and a \"quote\"".to_string(),
            format!("one line\ntouch {}", pwned.display()),
            "trailing backslash \\".to_string(),
        ] {
            let log = dir.path().join("name.log");
            let vars = config::Vars {
                id: Some(1),
                name: Some(&hostile),
                ..Default::default()
            };
            for position in ["{name}", "\"{name}\""] {
                let template = format!("set -eu\nprintf '%s' {position} > {}", log.display());
                let script = config::resolve(config::TODO_WATCHER, &template, &vars).unwrap();
                run_script(&script, dir.path().to_str().unwrap()).unwrap();
                assert!(!pwned.exists(), "the injected command ran: {hostile:?}");
                assert_eq!(
                    std::fs::read_to_string(&log).unwrap(),
                    hostile,
                    "{position}"
                );
            }
        }
    }

    #[test]
    fn spawn_script_reads_an_absent_value_as_the_empty_string() {
        // No name on this call, and todo-watcher never offers a prompt at
        // all: the slot is `''`, one empty argument, under `set -u` too.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("empty.log");
        let template = format!(
            "set -u\nprintf '[%s][%s]' {{name}} \"{{name}}\" > {}",
            log.display()
        );
        let script = config::resolve(
            config::TODO_WATCHER,
            &template,
            &config::Vars {
                id: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(script.contains("printf '[%s][%s]' '' \"\""), "{script}");
        run_script(&script, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "[][]");
    }

    #[test]
    fn spawn_script_reports_no_receipt_and_a_nonzero_exit_like_a_one_liner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(run_script("echo starting\necho done", path), Ok(None));
        let err = run_script("echo nope >&2\nexit 4", path).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn spawn_bg_runs_a_configured_script() {
        // End to end through the config file: a multi-line agent-spawn value
        // is run under bash, and its receipt parsed exactly as a one-line
        // command's would be.
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
                        "cd \"$(pwd)\"\nexport PICKED=yes\nprintf '%s|%s\\n' \"$PICKED\" \"{{prompt}}\" > {}\necho 'backgrounded · 5c819701'",
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
            &config::Prompts::default(),
        );
        unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        assert_eq!(spawned, Ok(Some("5c819701".to_string())));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "yes|look at the tests\n"
        );
    }

    // ---- liveness enrichment (mesa task 802) ----------------------------

    /// macOS-style `ps -A -o pid=,ppid=,etime=,comm=,args=`: right-aligned
    /// pids, an absolute `comm` (truncated to 16 chars once it is not the
    /// last column) and the full command line after it. Linux prints a bare
    /// `zsh`; both must count.
    const PS_OUTPUT: &str = "\
  501     1 01-00:27:14 /sbin/launchd    /sbin/launchd
86593     1    02:13:04 /Applications/Cl /Applications/Claude.app/Contents/MacOS/claude
86601 86593       03:20 /usr/bin/caffein /usr/bin/caffeinate -i
86602 86593       01:05 /bin/zsh         /bin/zsh -c ls -la /repo
86603 86593       00:07 /bin/zsh         /bin/zsh -c cargo test
86610 86593       04:00 node             node server.js
90001     1    09:09:09 bash             bash
";

    /// The count half of [`shell_children`], which is what `live_shells` is.
    fn shell_count(pid: i64, table: &[ProcRow]) -> usize {
        shell_children(pid, table, SystemTime::now()).len()
    }

    #[test]
    fn counts_only_allowlisted_shell_children() {
        let table = parse_proc_table(PS_OUTPUT);
        // Two zsh children; caffeinate (every working session has one) and
        // node are not work, and an unrelated top-level bash is not a child.
        assert_eq!(shell_count(86593, &table), 2);
        // A session with no children at all, and a pid nothing reports.
        assert_eq!(shell_count(86610, &table), 0);
        assert_eq!(shell_count(4242, &table), 0);
        // Every row survived the padded numeric columns `ps` actually emits —
        // a per-character split drops the padded ones and reports 0 shells on
        // a real machine while a single-spaced fixture passes (caught by
        // todo-watcher-check.sh, not by this test's shell rows).
        assert_eq!(table.len(), 7);
        assert_eq!(shell_count(1, &table), 1); // the top-level bash
    }

    /// The card each shell child renders as (mesa task 1277): the **command
    /// line**, not the program every Bash call shares, and a start time
    /// counted back from `etime` against the caller's own `now`.
    #[test]
    fn a_shell_child_is_named_by_its_command_line_and_dated_by_etime() {
        let table = parse_proc_table(PS_OUTPUT);
        let now = SystemTime::now();
        let children = shell_children(86593, &table, now);
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "/bin/zsh -c ls -la /repo");
        assert_eq!(children[1].name, "/bin/zsh -c cargo test");
        assert!(children.iter().all(|c| c.kind == AgentChildKind::Shell));
        assert!(children.iter().all(|c| c.state == AgentChildState::Running));
        // A running Bash call has produced nothing to show, and holds no
        // context window of its own.
        assert!(children.iter().all(|c| c.detail.is_none()));
        assert!(children.iter().all(|c| c.context_tokens.is_none()));
        // …and no id (mesa task 1278): a `ps` row carries nothing
        // transcript-derived, so a shell's whole identity is the command
        // line above. The pane a card opens keys itself off that.
        assert!(children.iter().all(|c| c.id.is_none()));
        // 01:05 ago and 00:07 ago, on mesa's own stored-timestamp clock.
        assert_eq!(children[0].started_at, started_ago(now, 65));
        assert_eq!(children[1].started_at, started_ago(now, 7));
        assert!(children[0].started_at < children[1].started_at);
    }

    #[test]
    fn etime_parses_every_shape_ps_prints() {
        assert_eq!(parse_etime("00:07"), Some(7));
        assert_eq!(parse_etime("01:05"), Some(65));
        assert_eq!(parse_etime("02:13:04"), Some(7_984));
        assert_eq!(parse_etime("01-00:27:14"), Some(88_034));
        // Anything else costs the row its start time, never the row itself.
        assert_eq!(parse_etime("-"), None);
        assert_eq!(parse_etime("7"), None);
        assert_eq!(parse_etime("a:b"), None);
    }

    #[test]
    fn proc_table_parse_is_lenient_and_basename_matched() {
        // Garbage lines are skipped rather than failing the whole probe, and
        // a bare `bash` (Linux `comm`) counts the same as `/bin/bash`.
        let table = parse_proc_table(
            "nope\n\n123 456 00:01 /bin/bash /bin/bash -c x\n789 456 00:02 bash bash\nx y z zsh zsh\n",
        );
        assert_eq!(table.len(), 2);
        assert_eq!(shell_count(456, &table), 2);
        // A row with no argv column at all is named by its program rather
        // than dropped.
        assert_eq!(
            shell_children(456, &table, SystemTime::now())[1].name,
            "bash"
        );
        assert!(parse_proc_table("").is_empty());
    }

    #[test]
    fn a_process_is_not_its_own_shell_child() {
        // A self-parenting row (pid 1's ppid is itself on some systems) must
        // not make a session look busy.
        let table = parse_proc_table("7 7 00:01 /bin/zsh /bin/zsh -c true\n");
        assert_eq!(shell_count(7, &table), 0);
    }

    /// What `live_subagents` counts: the **running** children only.
    fn live_subagents(root: &Path, session_id: &str, now: SystemTime) -> u32 {
        subagent_children(root, session_id, now)
            .iter()
            .filter(|child| child.state == AgentChildState::Running)
            .count() as u32
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
        assert_eq!(live_subagents(root, session, now), 2);
        // Same files, read from far enough in the future that every mtime is
        // older than the shared cc::ACTIVE_SECS window: nothing is live.
        let later = now + std::time::Duration::from_secs(cc::ACTIVE_SECS as u64 + 10);
        assert_eq!(live_subagents(root, session, later), 0);
        // A stale one is not listed as a card either — the window is what
        // makes a finished subagent eventually drop off.
        assert!(subagent_children(root, session, later).is_empty());
        // Unknown session, and a projects dir that isn't there at all.
        assert_eq!(live_subagents(root, "no-such-session", now), 0);
        assert_eq!(live_subagents(&root.join("gone"), session, now), 0);
    }

    #[test]
    fn a_fresh_subagent_that_ended_its_turn_is_not_live() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let session = "e34b8ed9-d391-4797-9d39-546d5b463357";
        let subagents = root.join("-Users-x-proj").join(session).join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
        let done = r#"{"type":"assistant","message":{"stop_reason":"end_turn"}}"#;
        let tool = r#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#;
        let now = SystemTime::now();

        // The last line is the subagent's final report: finished, not live.
        let path = subagents.join("agent-1.jsonl");
        std::fs::write(&path, format!("{user}\n{done}\n\n")).unwrap();
        assert_eq!(live_subagents(root, session, now), 0);
        // ...but it is still a card, marked finished, until its mtime falls
        // out of the window (mesa task 1277).
        let children = subagent_children(root, session, now);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].state, AgentChildState::Finished);

        // An end_turn earlier in the file, but a tool call last: still live.
        std::fs::write(&path, format!("{user}\n{done}\n{tool}\n")).unwrap();
        assert_eq!(live_subagents(root, session, now), 1);
        assert_eq!(
            subagent_children(root, session, now)[0].state,
            AgentChildState::Running
        );
    }

    /// A subagent's card (mesa task 1277): named by the `.meta.json`
    /// sidecar's `agentType`, dated by the transcript's first timestamp, and
    /// carrying the last thing it did plus the context it holds.
    #[test]
    fn a_subagent_child_reads_its_sidecar_and_its_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let session = "e34b8ed9-d391-4797-9d39-546d5b463357";
        let subagents = root.join("-Users-x-proj").join(session).join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let path = subagents.join("agent-9f3a.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","timestamp":"2026-09-21T13:00:15.500Z","message":{"role":"user","content":"go"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":"2026-09-21T13:00:20.000Z","message":{"stop_reason":"tool_use","usage":{"input_tokens":10,"cache_read_input_tokens":4000,"cache_creation_input_tokens":90},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            subagents.join("agent-9f3a.meta.json"),
            r#"{"agentType":"diff-reviewer","description":"review","spawnDepth":1}"#,
        )
        .unwrap();

        let now = SystemTime::now();
        let children = subagent_children(root, session, now);
        assert_eq!(children.len(), 1);
        let child = &children[0];
        assert_eq!(child.kind, AgentChildKind::Subagent);
        assert_eq!(child.name, "diff-reviewer");
        assert_eq!(child.state, AgentChildState::Running);
        // No prose on that line, so the tool it called is what it last did.
        assert_eq!(child.detail.as_deref(), Some("Bash"));
        assert_eq!(child.context_tokens, Some(4100));
        assert_eq!(child.started_at.as_deref(), Some("2026-09-21 13:00:15"));

        // A missing sidecar costs the card its label, never the card: the
        // file stem stands in.
        std::fs::remove_file(subagents.join("agent-9f3a.meta.json")).unwrap();
        assert_eq!(subagent_children(root, session, now)[0].name, "agent-9f3a");
        // ...and so does an unparseable one.
        std::fs::write(subagents.join("agent-9f3a.meta.json"), "{ not json").unwrap();
        assert_eq!(subagent_children(root, session, now)[0].name, "agent-9f3a");
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
        // Same rule for the pulse: no transcript to read is silence, not an
        // Err — the todo watcher reads this list.
        assert!(sessions.iter().all(|s| s.last_response.is_none()));
        assert!(sessions.iter().all(|s| s.context_tokens.is_none()));
        // Nothing to list either — an empty list, never a missing key.
        assert!(sessions.iter().all(|s| s.children.is_empty()));
    }

    #[test]
    fn liveness_counts_serialize_camel_case_and_default_when_absent() {
        // The CLI payload never carries these — parsing must not require them
        // — but the web UI reads them as `liveShells`/`liveSubagents`, and the
        // pulse pair as `lastResponse`/`contextTokens`.
        let sessions = parse_sessions(SESSIONS_JSON.as_bytes()).unwrap();
        assert_eq!(sessions[0].live_shells, 0);
        assert_eq!(sessions[0].live_subagents, 0);
        assert_eq!(sessions[0].last_response, None);
        assert_eq!(sessions[0].context_tokens, None);
        let mut session = sessions[1].clone();
        session.live_shells = 3;
        session.live_subagents = 1;
        session.last_response = Some("on it".into());
        session.context_tokens = Some(6000);
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["liveShells"], 3);
        assert_eq!(json["liveSubagents"], 1);
        assert_eq!(json["lastResponse"], "on it");
        assert_eq!(json["contextTokens"], 6000);
        // `children` is always on the wire, empty when nothing is live — the
        // page renders a list, not an optional one (mesa task 1277).
        assert_eq!(json["children"], serde_json::json!([]));
        session.children = vec![AgentChild {
            id: Some("agent-implementer-1a2b3c".into()),
            kind: AgentChildKind::Subagent,
            name: "implementer".into(),
            detail: Some("Edit".into()),
            started_at: Some("2026-09-21 13:00:15".into()),
            context_tokens: Some(4100),
            model: Some("claude-sonnet-5".into()),
            state: AgentChildState::Finished,
        }];
        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["children"][0]["kind"], "subagent");
        assert_eq!(json["children"][0]["state"], "finished");
        assert_eq!(json["children"][0]["startedAt"], "2026-09-21 13:00:15");
        assert_eq!(json["children"][0]["contextTokens"], 4100);
        // The pane id (mesa task 1278): the transcript stem for a subagent,
        // and explicitly null — not absent — for a shell, which has none.
        assert_eq!(json["children"][0]["id"], "agent-implementer-1a2b3c");
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
