//! HTTP API: an axum router under `/api` over the same `Store` as the CLI.
//!
//! Contract (spec Requirements 7 and 8):
//! - Default (loopback) mode: bound to 127.0.0.1; requests whose `Host` header
//!   is not `localhost:<port>` or `127.0.0.1:<port>` are rejected (DNS
//!   rebinding).
//! - LAN mode (`serve --lan`): bound to 0.0.0.0 so other devices on the local
//!   network can reach it; the Host-header check is skipped (the user has opted
//!   into no-auth LAN trust — there is no enumerable allowlist of LAN hosts).
//! - Mutating methods (POST/PUT/PATCH/DELETE) require
//!   `Content-Type: application/json` (cross-site form posts) in BOTH modes.
//! - Status codes: 404 unknown path id, 422 validation errors and unknown
//!   body ids, 409 cycle. Error bodies use the CLI shape:
//!   `{"error": {"code": "...", "message": "..."}}`.
//! - The built frontend (`frontend/dist`, embedded at compile time) is served
//!   at `/`, with SPA fallback to `index.html` (spec Requirement 9).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Deserializer};
use serde_json::json;

use crate::core::{
    AgentSession, AgentSpawned, AnchorSide, CcDashboard, CcUsage, DiagramType, EdgePatch, Error,
    FileTreeEntry, FrameNew, FramePatch, FrameShape, GitCommit, GitCommitFile, GitFileDiff,
    GitRepoView, GitStatus, GitWorktree, InboxItem, MesaVersion, ModelRates, NextResult, Priority,
    ProjectAgents, ProjectFileTree, ProjectGitLog, ProjectGitStatus, ProjectGitView, ProjectPatch,
    ProjectVersion, Script, ScriptArg, ScriptPatch, Status, Store, StoryboardPatch, Task,
    TaskPatch, TaskSummary, Waypoint, agents, attachments, config, files, git, hooks, scripts,
    version,
};

/// The Vite build output, embedded into the binary at compile time.
/// `scripts/build.sh` guarantees `frontend/dist` is built before the release
/// compile; debug builds read the folder from disk at runtime instead.
#[derive(rust_embed::RustEmbed, Clone)]
#[folder = "frontend/dist"]
struct Assets;

// The nested cache maps below (each `Arc<Mutex<HashMap<K, (Instant, V)>>>` or
// similar) are deliberate and documented per-field; factoring them into named
// type aliases would not make the caching contracts any clearer.
#[allow(clippy::type_complexity)]
#[derive(Clone)]
struct AppState {
    store: Arc<Mutex<Store>>,
    port: u16,
    lan: bool,
    /// CC Dashboard cache, keyed by window. Each entry pairs the db-derived
    /// `cc_stamp` (persisted cc row counts) seen when it was built with the
    /// dashboard; a request re-aggregates only when the stamp moved — i.e.
    /// when any process's ingest added rows. File mtimes are deliberately not
    /// the key: they can't see a cross-process ingest, and a deleted
    /// transcript must keep serving the history-inclusive view.
    cc_cache: Arc<Mutex<HashMap<String, (i64, CcDashboard)>>>,
    /// Per-project CC Dashboard cache (its own map, not `cc_cache`), keyed by
    /// `(project_id, window)` so it can never collide with or be invalidated
    /// independently of the global dashboard's cache. Same stamp-gated
    /// staleness check as `cc_cache` — `Store::cc_stamp()` is a global
    /// counter, so any ingest anywhere conservatively invalidates every
    /// project's cached entry too.
    project_cc_cache: Arc<Mutex<HashMap<(i64, String), (i64, CcDashboard)>>>,
    /// Live subscription-usage cache: `(fetched_unix, data)`. The UI polls this,
    /// but each fetch hits Anthropic's usage endpoint, so a short TTL throttles
    /// outbound calls. Read-only live data — not the mesa store. Concurrent
    /// reads never multiply outbound calls: stale-but-present cache is served
    /// immediately while a single background refresh runs (see `get_cc_usage`).
    usage_cache: Arc<Mutex<Option<(i64, CcUsage)>>>,
    /// Single-flight guard for the upstream usage fetch: serializes the
    /// blocking `curl` so concurrent cold/refresh requests collapse to one
    /// outbound call instead of a thundering herd (the 429 source).
    usage_lock: Arc<tokio::sync::Mutex<()>>,
    /// True while a background (serve-stale) refresh is in flight, so repeated
    /// polls spawn at most one refresh task.
    usage_refreshing: Arc<AtomicBool>,
    /// Live Claude Code sessions per project folder, keyed by `local_path`.
    /// Each `claude agents --json` call costs ~0.5s of node startup, so a short
    /// TTL (see [`AGENTS_TTL`]) collapses concurrent polls — multiple open
    /// tabs, or several clients on the same folder — into one subprocess per
    /// window. A project that changes `local_path` orphans its old key; the
    /// insert path caps the map so those can't grow without bound.
    agents_cache: Arc<Mutex<HashMap<String, (Instant, Vec<AgentSession>)>>>,
    /// Working-tree git status per project folder, keyed by `local_path`
    /// (sidebar decoration). `None` is a cached miss — a folder that is not a
    /// repo — so non-repo paths don't respawn git on every poll. Same
    /// shape/TTL rationale as `agents_cache`: collapse concurrent polls into
    /// one subprocess per folder per window.
    git_cache: Arc<Mutex<HashMap<String, (Instant, Option<GitStatus>)>>>,
    /// Full working-tree view (branch + changed-file list) per project folder,
    /// keyed by `local_path` — backs the project git tab. Separate from
    /// `git_cache` (which stores the sidebar's `GitStatus`) so the two
    /// handlers stay decoupled; same TTL/shape rationale. `None` is a cached
    /// miss (not a repo). Diffs are not cached — on-demand, one file, cheap.
    git_view_cache: Arc<Mutex<HashMap<String, (Instant, Option<GitRepoView>)>>>,
    /// Every worktree of the repo behind a project folder, keyed by
    /// `local_path` (`git worktree list` always reports the full set
    /// regardless of which worktree it's run from, so `local_path` alone is
    /// the right cache key — not `(local_path, selected worktree)`). Backs
    /// the git tab's worktree selector and the `?worktree=` allowlist on the
    /// view/diff routes below. Same TTL/shape rationale as `git_view_cache`.
    git_worktrees_cache: Arc<Mutex<HashMap<String, (Instant, Option<Vec<GitWorktree>>)>>>,
    /// Recent commit log per project folder, keyed by `local_path`. Cached
    /// (S3) so refetch-on-focus doesn't respawn `git log` every render; same
    /// GIT_TTL/eviction-cap pattern as `git_view_cache`.
    git_log_cache: Arc<Mutex<HashMap<String, (Instant, Vec<GitCommit>)>>>,
    /// Per-commit changed-file list, keyed by (local_path, sha). Backs both
    /// the files route and the per-commit diff route's path allowlist (M7),
    /// so a commit selected then diffed doesn't re-run `git show
    /// --name-status` twice in a row. Commit content is immutable once made,
    /// so this cache never truly goes stale, but it reuses the same
    /// GIT_TTL/eviction-cap machinery as every other cache here rather than
    /// special-casing "cache forever" for one map.
    git_commit_files_cache: Arc<Mutex<HashMap<(String, String), (Instant, Vec<GitCommitFile>)>>>,
    /// One file's commit history, keyed by `(local_path, rel)` — backs the
    /// Files tab's per-file History pane. Separate map from `git_log_cache`
    /// (whole-repo log, keyed by folder alone) because the key shape differs;
    /// same GIT_TTL/eviction-cap pattern as every other cache here.
    git_file_log_cache: Arc<Mutex<HashMap<(String, String), (Instant, Vec<GitCommit>)>>>,
    /// Bumped whenever a spawn invalidates the list cache. A concurrent list
    /// whose subprocess started before the spawn checks this before caching,
    /// so it can't reinsert a pre-spawn snapshot after the invalidation and
    /// briefly hide the just-created session.
    agents_gen: Arc<AtomicU64>,
    /// Files tab tree listing, one directory level per entry, keyed by
    /// `(local_path, rel)` — `rel` is `""` for the root level itself — backs
    /// `GET /api/projects/{id}/files[?path=<rel>]`. `core::files::tree_level`
    /// lists one level (mesa task 410; bounded by `MAX_TREE_ENTRIES`, but
    /// still not free for a directory with many entries), so this reuses the
    /// same TTL/eviction-cap pattern as `git_view_cache`. File content reads
    /// are not cached (mirrors the git diff routes — on-demand, one file,
    /// cheap).
    files_tree_cache: Arc<Mutex<HashMap<(String, String), (Instant, (Vec<FileTreeEntry>, bool))>>>,
    /// Set by `restart_server` before it triggers graceful shutdown; `serve`
    /// checks it right after `axum::serve` returns to decide whether to
    /// relaunch the current binary.
    restart_requested: Arc<AtomicBool>,
    /// Taken (once) by `restart_server` to fire the graceful-shutdown signal
    /// `serve` is awaiting. `None` after the first request, so a second
    /// concurrent restart click reports "already restarting" instead of
    /// panicking on a consumed oneshot.
    shutdown_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Inbox item ids the inbox-watcher (`watch_inbox`) has already dispatched
    /// a triage agent for. The inbox-watcher's answer to the todo-watcher's
    /// `in_progress` claim — but in memory, not in the db, because an inbox
    /// item has no status column to claim with (`docs/inbox.md`: an item *is*
    /// the record, and assignment converts + deletes it). Pruned each tick to
    /// the ids still present in the inbox, so it can't grow unboundedly on a
    /// long-lived server. Deliberately not persisted: a restart re-triages
    /// whatever is still sitting in the inbox, which is the recoverable
    /// direction (a duplicate triage of an item is cheap; a permanently
    /// skipped item is not) — see `docs/inbox-watcher.md`.
    inbox_dispatched: Arc<Mutex<std::collections::HashSet<i64>>>,
    /// Task ids the refine-watcher (`watch_refine`) has already dispatched a
    /// refinement agent for. In memory for the same reason as
    /// [`AppState::inbox_dispatched`], not the same reason: a refine task
    /// *has* a status column, but the claim the todo-watcher makes
    /// (`in_progress`) would be a lie here — nobody is executing the task, and
    /// it would make the project read as busy to the todo-watcher. The refine
    /// agent's own move to `todo` is what ends the dispatch; until then this
    /// set is what stops a re-dispatch every tick. Pruned each tick to the ids
    /// still sitting in `refine`, so it can't grow unboundedly — and
    /// deliberately not persisted, so a restart re-refines whatever is still
    /// in the column (the recoverable direction, `docs/refine-watcher.md`).
    refine_dispatched: Arc<Mutex<std::collections::HashSet<i64>>>,
}

/// How often the todo-watcher (`watch_todo`) checks every project for
/// dispatchable work. Not user-configurable — a fixed background cadence,
/// not a request-driven poll like the UI's. `MESA_WATCH_TODO_TICK_MS`
/// overrides it for tests (mirrors `MESA_CLAUDE_BIN`'s test-seam precedent),
/// so a gate script isn't stuck waiting a full 60s per check.
const WATCH_TODO_TICK: Duration = Duration::from_secs(60);

fn watch_todo_tick() -> Duration {
    std::env::var("MESA_WATCH_TODO_TICK_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(WATCH_TODO_TICK)
}

/// How often the inbox-watcher (`watch_inbox`) checks the global inbox for
/// items to triage. Same fixed-cadence rationale as [`WATCH_TODO_TICK`];
/// `MESA_WATCH_INBOX_TICK_MS` is the matching test seam.
const WATCH_INBOX_TICK: Duration = Duration::from_secs(60);

fn watch_inbox_tick() -> Duration {
    std::env::var("MESA_WATCH_INBOX_TICK_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(WATCH_INBOX_TICK)
}

/// How often the refine-watcher (`watch_refine`) checks every project for a
/// task sitting in the `refine` column. Same fixed-cadence rationale as
/// [`WATCH_TODO_TICK`]; `MESA_WATCH_REFINE_TICK_MS` is the matching test seam.
const WATCH_REFINE_TICK: Duration = Duration::from_secs(60);

fn watch_refine_tick() -> Duration {
    std::env::var("MESA_WATCH_REFINE_TICK_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(WATCH_REFINE_TICK)
}

/// How much of an inbox body goes into an auto-dispatched session's name,
/// in `char`s (not bytes — bodies are free text and may be non-ASCII).
const INBOX_SESSION_NAME_CHARS: usize = 60;

/// Names an auto-dispatched triage session after the item it triages, so it
/// is identifiable in the prompt box, `/resume` picker, terminal title and
/// Agents sidebar — the same reason the todo-watcher names its sessions
/// `<project>: <title>`. Uses the body's first non-empty line, truncated;
/// inbox bodies are free-form markdown and may be long or multi-line.
///
/// The body is **untrusted data**: it reaches `claude` as a single `--name`
/// process argument (`Command::arg`, no shell), never interpolated into a
/// shell string, and nothing here interprets it.
fn inbox_session_name(item: &InboxItem) -> String {
    let first = item
        .body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if first.is_empty() {
        return format!("inbox {}", item.id);
    }
    let mut head: String = first.chars().take(INBOX_SESSION_NAME_CHARS).collect();
    if first.chars().count() > INBOX_SESSION_NAME_CHARS {
        head.push('…');
    }
    format!("inbox {}: {head}", item.id)
}

/// One inbox-watcher pass: dispatch a background `claude` agent running
/// `/inbox-triage <id>` for every pending inbox item this process has not
/// already dispatched. The inbox is one **global** queue that lives above
/// projects, so — unlike the todo-watcher, which is naturally capped at one
/// agent per project — every un-dispatched item goes out in the same tick.
///
/// cwd is `$HOME`, not a project folder: an inbox item belongs to no project
/// (`project_id` is null for its whole life) and the triage skill derives the
/// project itself, reading each candidate repo by absolute `local_path`. Same
/// `$HOME` the global Terminal page uses.
///
/// The dedup set (`AppState::inbox_dispatched`) stands in for the
/// todo-watcher's `in_progress` claim, which has no inbox equivalent — an
/// item has no status column. Two of the triage skill's three outcomes remove
/// the item (a viable request becomes a task and the item is deleted; a
/// non-viable one is converted by `assign_inbox_item`), but the third leaves
/// it **untouched** — no confident project match. Without the set, that third
/// outcome would re-dispatch an agent for the same item every single tick,
/// forever. Ids are claimed *before* the spawn (closing the window where a
/// second tick fires while `claude --bg` is still starting) and released
/// again only if the spawn failed, so a transient `claude` failure retries
/// next tick instead of silently dropping the item — the same shape as the
/// todo-watcher's revert-to-`todo`.
///
/// Two-phase, like [`todo_watcher_tick`] and `spawn_project_agent`: the store
/// lock is dropped before the blocking `claude --bg` shell-outs. Holding it
/// across a spawn would freeze every other API request for the duration of
/// each spawn — a regression this codebase has shipped once already.
fn inbox_watcher_tick(state: &AppState) {
    let Some(home) = directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf()) else {
        eprintln!("inbox-watcher: no home directory to dispatch in");
        return;
    };
    let home = home.to_string_lossy().into_owned();

    let items = {
        let store = match state.store.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        };
        match store.list_inbox_items(None) {
            Ok(items) => items,
            Err(e) => {
                eprintln!("inbox-watcher: list_inbox_items failed: {e}");
                return;
            }
        }
    };

    let pending: Vec<(i64, String)> = {
        let mut dispatched = match state.inbox_dispatched.lock() {
            Ok(d) => d,
            Err(e) => e.into_inner(),
        };
        let present: std::collections::HashSet<i64> = items.iter().map(|i| i.id).collect();
        dispatched.retain(|id| present.contains(id));
        items
            .iter()
            .filter(|item| dispatched.insert(item.id))
            .map(|item| (item.id, inbox_session_name(item)))
            .collect()
    };

    for (id, session_name) in pending {
        // The command — including which slash command triages an item — comes
        // from `~/.mesa/config.json`'s `inbox-watcher` entry, defaulting to
        // `claude --bg … -- /inbox-triage <id>`.
        if let Err(e) = agents::spawn_bg(
            config::INBOX_WATCHER,
            &home,
            Some(id),
            Some(&session_name),
            None,
        ) {
            eprintln!("inbox-watcher: spawn failed for inbox item {id}: {e}");
            let mut dispatched = match state.inbox_dispatched.lock() {
                Ok(d) => d,
                Err(e) => e.into_inner(),
            };
            dispatched.remove(&id);
        }
    }
}

/// Walks `task` down to the actionable task the todo watcher should really
/// dispatch: the top-ranked actionable descendant of `task`, recursively, or
/// `task` itself once nothing under it is actionable.
///
/// The watcher's unit of work is an actionable **leaf**. A task that still
/// has actionable subtasks is a *batch*, and claiming it would break the
/// umbrella rule from the other side: the very next tick would see an
/// `in_progress` task with children, treat it as an umbrella, and spawn a
/// second agent on one of its own children in the same repo (mesa task 570).
/// An epic therefore gets dispatched only once its subtree is exhausted —
/// which is exactly the roll-up moment its acceptance describes.
///
/// Still mandatory now that the ceiling is configurable (mesa task 777), and
/// for the same reason: an umbrella counts toward *nothing*, so a claimed
/// batch would be a slot the limit's accounting never sees — one agent over
/// the limit, every tick, forever.
///
/// Bounded, so a malformed `parent_id` cycle can only cost a few queries
/// rather than spinning the tick forever; real task trees are a few levels
/// deep at most.
fn deepest_actionable(store: &Store, mut task: Task) -> Result<Task, Error> {
    const MAX_DEPTH: usize = 16;
    for _ in 0..MAX_DEPTH {
        match store.next_subtask(&[task.id])? {
            Some(child) => task = child,
            None => break,
        }
    }
    Ok(task)
}

/// One todo-watcher pass: for every project with a live `local_path` and a
/// free dispatch slot, pick the next actionable task and dispatch a
/// background `claude` agent on it. Marks the task `in_progress`
/// itself *before* spawning — closing the race window between dispatch and
/// the agent's own `/execute-mesa-task` pickup step, so a second tick can't
/// double-dispatch the same task while the agent is still starting up. A
/// spawn failure reverts the task back to `todo` so the project isn't
/// wedged; a dispatched agent that later crashes without finishing is not
/// detected here (task-status, not live-session, is the "in process" signal)
/// and leaves that project quiet until someone intervenes — an accepted v1
/// tradeoff over polling `claude agents` for every project every tick.
///
/// "Busy" is a **count**, not a flag (mesa task 777): a project's occupied
/// slots are its `in_progress` **leaf** tasks, and the tick fills it up to
/// `config::todo_concurrency()` — the user's per-project ceiling, default 1,
/// so an unconfigured install behaves exactly as before. The limit is read
/// once at the top of every tick rather than at startup, the same
/// read-per-use rule the spawn templates follow, which is what makes an edit
/// land on the next tick with no restart. Lowering it never touches work in
/// flight: those tasks stay `in_progress` and the tick simply picks nothing
/// new for that project until the count falls back under the limit.
///
/// An `in_progress` task that has subtasks is an **umbrella**, not a worker,
/// so it occupies no slot (mesa task 570). A project whose only `in_progress`
/// tasks are umbrellas is fully idle by the count, but the pick narrows from
/// `Store::next_task` (any actionable todo in the project) to
/// `Store::next_subtask` (an actionable todo *under* one of those umbrellas)
/// — an open umbrella unblocks its own children and nothing else, so the
/// watcher never starts unrelated work alongside a parent someone is still
/// holding. That narrowing is decided once per project, before the fill loop:
/// a leaf claimed inside the loop is nobody's parent, so it cannot change the
/// answer mid-loop.
///
/// The invariant that keeps this to *at most* `limit` watcher-spawned agents
/// per project is [`deepest_actionable`]: whatever the pick, the watcher
/// claims an actionable *leaf*, which occupies a slot on the next tick. It
/// never claims a task that still has actionable subtasks — that task would
/// otherwise read as an umbrella one tick later, count toward nothing, and
/// get a further agent spawned on its own child *outside* the limit's
/// accounting. (Residual, inherent to the status-not-liveness signal: a *new*
/// subtask created under an already-`in_progress` task mid-run does turn it
/// into an umbrella, and the next tick dispatches that child alongside
/// whoever holds the parent.)
///
/// Claiming before the next pick is also what terminates the fill loop:
/// both picks filter `status = 'todo'`, so a just-claimed task is invisible
/// to the following iteration. (Residual of filling more than one slot at a
/// time: a parent whose *last* actionable child this loop just claimed is
/// itself actionable to the next iteration, so a limit above 1 can put an
/// agent on the roll-up while its child is still running. It stays inside
/// the limit and inside the umbrella rule — the parent counts as an umbrella
/// from the next tick on — and is the cost of "fill to the limit now"
/// rather than "one per tick".)
///
/// Two-phase, like `spawn_project_agent`: the store lock is held only long
/// enough to decide and claim (phase 1), then dropped before the blocking
/// `claude --bg` shell-outs (phase 2) — holding it across a spawn would
/// freeze every other API request (each needs the same lock) for as long as
/// `claude --bg` takes to start (node startup, ~0.5s+, per the Agents-tab
/// comments) times however many projects this tick dispatches.
fn todo_watcher_tick(state: &AppState) {
    // Read once per tick, before the lock. An unreadable/malformed config is
    // a skipped tick, never a dispatch under a guessed limit — the spawn
    // would fail on the same file a moment later anyway.
    let limit = match config::todo_concurrency() {
        Ok(limit) => limit as usize,
        Err(e) => {
            eprintln!("todo-watcher: {e}");
            return;
        }
    };
    let claimed: Vec<(i64, String, String)> = {
        let mut store = match state.store.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        };
        let projects = match store.list_projects() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("todo-watcher: list_projects failed: {e}");
                return;
            }
        };
        let tasks = match store.list_tasks(None) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("todo-watcher: list_tasks failed: {e}");
                return;
            }
        };
        // A task that is somebody's parent is an umbrella; only a *leaf*
        // in_progress task occupies one of the project's dispatch slots.
        let parents: std::collections::HashSet<i64> =
            tasks.iter().filter_map(|t| t.parent_id).collect();
        let mut busy_counts: HashMap<i64, usize> = HashMap::new();
        let mut umbrellas: std::collections::HashMap<i64, Vec<i64>> =
            std::collections::HashMap::new();
        for task in tasks.iter().filter(|t| t.status == Status::InProgress) {
            if parents.contains(&task.id) {
                umbrellas.entry(task.project_id).or_default().push(task.id);
            } else {
                *busy_counts.entry(task.project_id).or_default() += 1;
            }
        }
        let mut claimed = Vec::new();
        for project in projects {
            let Some(local_path) = project.local_path.as_deref() else {
                continue;
            };
            if !std::path::Path::new(local_path).is_dir() {
                continue;
            }
            // Free slots, never negative: a limit lowered below what is
            // already running dispatches nothing and cancels nothing.
            let slots = limit.saturating_sub(busy_counts.get(&project.id).copied().unwrap_or(0));
            if slots == 0 {
                continue;
            }
            // Open umbrella(s) → dispatch only from under them; otherwise the
            // project is idle and the whole backlog is fair game. Decided
            // once: a leaf claimed below is nobody's parent.
            let parent_ids = umbrellas.get(&project.id);
            for _ in 0..slots {
                let picked = match parent_ids {
                    Some(parent_ids) => match store.next_subtask(parent_ids) {
                        Ok(Some(task)) => task,
                        Ok(None) => break,
                        Err(e) => {
                            eprintln!(
                                "todo-watcher: next_subtask failed for project {}: {e}",
                                project.id
                            );
                            break;
                        }
                    },
                    None => match store.next_task(Some(project.id)) {
                        Ok(NextResult::Task(task)) => *task,
                        Ok(NextResult::None { .. }) => break,
                        Err(e) => {
                            eprintln!(
                                "todo-watcher: next_task failed for project {}: {e}",
                                project.id
                            );
                            break;
                        }
                    },
                };
                let task = match deepest_actionable(&store, picked) {
                    Ok(task) => task,
                    Err(e) => {
                        eprintln!(
                            "todo-watcher: next_subtask failed for project {}: {e}",
                            project.id
                        );
                        break;
                    }
                };
                let in_progress = TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                };
                if let Err(e) = store.update_task(task.id, &in_progress) {
                    eprintln!("todo-watcher: failed to claim task {}: {e}", task.id);
                    break;
                }
                let session_name = format!("{}: {}", project.name, task.name);
                claimed.push((task.id, local_path.to_string(), session_name));
            }
        }
        claimed
    };
    for (task_id, local_path, session_name) in claimed {
        // The command — including which slash command executes a task — comes
        // from `~/.mesa/config.json`'s `todo-watcher` entry, defaulting to
        // `claude --bg … -- /execute-mesa-task <id>`.
        if let Err(e) = agents::spawn_bg(
            config::TODO_WATCHER,
            &local_path,
            Some(task_id),
            Some(&session_name),
            None,
        ) {
            eprintln!("todo-watcher: spawn failed for task {task_id}: {e}");
            let mut store = match state.store.lock() {
                Ok(s) => s,
                Err(e) => e.into_inner(),
            };
            let revert = TaskPatch {
                status: Some(Status::Todo),
                ..Default::default()
            };
            let _ = store.update_task(task_id, &revert);
        }
    }
}

/// One refine-watcher pass: for every project with a live `local_path`,
/// dispatch a background `claude` agent on the top-ranked task sitting in the
/// `refine` column that this process has not already dispatched for.
///
/// Refine sits **before** `todo` on the board: a task lands there when its
/// description still needs sharpening, and the agent's job is to read it,
/// rewrite `description`/`acceptance`, and move it to `todo` — at which point
/// the todo-watcher may pick it up as ordinary work. The two watchers are
/// independent flags over disjoint statuses and never contend: `next_task`
/// and `next_subtask` both filter `status = 'todo'`, so a refine task is
/// invisible to the todo-watcher, and this tick only ever reads `refine`.
///
/// Three deliberate differences from [`todo_watcher_tick`]:
/// - **No status claim.** There is no intermediate status to flip to, and
///   `in_progress` would be a lie that also wedges the todo-watcher (a
///   non-umbrella `in_progress` leaf marks its whole project busy). The
///   in-memory `refine_dispatched` set is the claim instead, exactly as the
///   inbox-watcher does it, with the same restart behavior: a re-dispatch is
///   cheap, a permanently skipped task is not.
/// - **A busy project is not skipped.** Refinement is text work on a task
///   nobody is executing; parking it behind whatever the todo-watcher is
///   running would leave the column stuck for hours.
/// - **One dispatch per project per tick.** A backlog of forty refine tasks
///   must not become forty concurrent agents in one working folder, so the
///   column drains over consecutive ticks. `list_refine_tasks` hands them over
///   in priority-then-id order, the same rank the todo-watcher dispatches in.
///
/// Two-phase, like every other spawn site here: the store lock is dropped
/// before the blocking `claude --bg` shell-outs.
fn refine_watcher_tick(state: &AppState) {
    let candidates: Vec<(i64, String, String)> = {
        let store = match state.store.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        };
        let projects = match store.list_projects() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("refine-watcher: list_projects failed: {e}");
                return;
            }
        };
        let tasks = match store.list_refine_tasks(None) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("refine-watcher: list_refine_tasks failed: {e}");
                return;
            }
        };
        let mut dispatched = match state.refine_dispatched.lock() {
            Ok(d) => d,
            Err(e) => e.into_inner(),
        };
        // A task that left the column (refined, or moved by hand) drops out of
        // the set, so it can be refined again if it ever comes back.
        let present: std::collections::HashSet<i64> = tasks.iter().map(|t| t.id).collect();
        dispatched.retain(|id| present.contains(id));

        let mut picked = Vec::new();
        for project in projects {
            let Some(local_path) = project.local_path.as_deref() else {
                continue;
            };
            if !std::path::Path::new(local_path).is_dir() {
                continue;
            }
            // `list_refine_tasks` is already in priority-then-id order, so the
            // first undispatched task of this project is this tick's pick.
            let Some(task) = tasks
                .iter()
                .find(|t| t.project_id == project.id && !dispatched.contains(&t.id))
            else {
                continue;
            };
            dispatched.insert(task.id);
            picked.push((
                task.id,
                local_path.to_string(),
                format!("{}: {}", project.name, task.name),
            ));
        }
        picked
    };
    for (task_id, local_path, session_name) in candidates {
        // The command — including the whole refinement prompt — comes from
        // `~/.mesa/config.json`'s `refine-watcher` entry (`docs/config.md`).
        if let Err(e) = agents::spawn_bg(
            config::REFINE_WATCHER,
            &local_path,
            Some(task_id),
            Some(&session_name),
            None,
        ) {
            eprintln!("refine-watcher: spawn failed for task {task_id}: {e}");
            // Release the claim so a transient `claude` failure retries next
            // tick — the mirror of the todo-watcher's revert-to-`todo`.
            let mut dispatched = match state.refine_dispatched.lock() {
                Ok(d) => d,
                Err(e) => e.into_inner(),
            };
            dispatched.remove(&task_id);
        }
    }
}

/// Opens the default store and serves the API, blocking until the process is
/// killed. Binds 127.0.0.1 by default; with `lan`, binds 0.0.0.0 so other
/// devices on the local network can reach it (no auth — see `serve --help`).
/// `watch_todo` starts the periodic todo-watcher (see [`todo_watcher_tick`]),
/// `watch_refine` the periodic refine-watcher (see [`refine_watcher_tick`])
/// and `watch_inbox` the periodic inbox-watcher (see [`inbox_watcher_tick`]);
/// all off by default, all propagated across the web UI's Restart Server
/// action. They are independent flags over independent queues — none implies
/// another.
pub fn serve(
    port: u16,
    lan: bool,
    watch_todo: bool,
    watch_refine: bool,
    watch_inbox: bool,
) -> crate::core::Result<()> {
    let store = Store::open_default()?;
    let restart_requested = Arc::new(AtomicBool::new(false));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
        port,
        lan,
        cc_cache: Arc::new(Mutex::new(HashMap::new())),
        project_cc_cache: Arc::new(Mutex::new(HashMap::new())),
        usage_cache: Arc::new(Mutex::new(None)),
        usage_lock: Arc::new(tokio::sync::Mutex::new(())),
        usage_refreshing: Arc::new(AtomicBool::new(false)),
        agents_cache: Arc::new(Mutex::new(HashMap::new())),
        agents_gen: Arc::new(AtomicU64::new(0)),
        git_cache: Arc::new(Mutex::new(HashMap::new())),
        git_view_cache: Arc::new(Mutex::new(HashMap::new())),
        git_worktrees_cache: Arc::new(Mutex::new(HashMap::new())),
        git_log_cache: Arc::new(Mutex::new(HashMap::new())),
        git_commit_files_cache: Arc::new(Mutex::new(HashMap::new())),
        git_file_log_cache: Arc::new(Mutex::new(HashMap::new())),
        files_tree_cache: Arc::new(Mutex::new(HashMap::new())),
        restart_requested: restart_requested.clone(),
        shutdown_tx: Arc::new(Mutex::new(Some(shutdown_tx))),
        inbox_dispatched: Arc::new(Mutex::new(std::collections::HashSet::new())),
        refine_dispatched: Arc::new(Mutex::new(std::collections::HashSet::new())),
    };
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        if watch_todo {
            let watch_state = state.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(watch_todo_tick());
                loop {
                    ticker.tick().await;
                    let state = watch_state.clone();
                    let _ = tokio::task::spawn_blocking(move || todo_watcher_tick(&state)).await;
                }
            });
        }
        if watch_refine {
            let watch_state = state.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(watch_refine_tick());
                loop {
                    ticker.tick().await;
                    let state = watch_state.clone();
                    let _ = tokio::task::spawn_blocking(move || refine_watcher_tick(&state)).await;
                }
            });
        }
        if watch_inbox {
            let watch_state = state.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(watch_inbox_tick());
                loop {
                    ticker.tick().await;
                    let state = watch_state.clone();
                    let _ = tokio::task::spawn_blocking(move || inbox_watcher_tick(&state)).await;
                }
            });
        }
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        println!("{}", json!({"listening": format!("http://{host}:{port}")}));
        // ConnectInfo carries the peer address so the agent endpoints and
        // local_path writes can be gated on loopback in default mode (see
        // `require_agent_access` / `require_local_path_write`).
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await?;
        Ok::<(), crate::core::Error>(())
    })?;
    // `axum::serve` only returns once the listener (and thus the port) is
    // released — either on error (propagated above) or because
    // `restart_server` fired the graceful-shutdown signal. Only the latter
    // case relaunches: spawn the current binary with the same `serve` flags,
    // then exit so the new process is free to bind the now-released port.
    if restart_requested.load(Ordering::SeqCst) {
        let exe = std::env::current_exe()?;
        let mut args = vec!["serve".to_string(), "--port".to_string(), port.to_string()];
        if lan {
            args.push("--lan".to_string());
        }
        if watch_todo {
            args.push("--watch-todo".to_string());
        }
        if watch_refine {
            args.push("--watch-refine".to_string());
        }
        if watch_inbox {
            args.push("--watch-inbox".to_string());
        }
        std::process::Command::new(exe).args(args).spawn()?;
        std::process::exit(0);
    }
    Ok(())
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/resolve", get(resolve_project))
        .route(
            "/api/projects/{id}",
            get(show_project)
                .patch(update_project)
                .delete(delete_project),
        )
        .route("/api/projects/{id}/archive", post(archive_project))
        .route("/api/projects/{id}/unarchive", post(unarchive_project))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            get(show_task).patch(update_task).delete(delete_task),
        )
        // Fires the user-configured task-execute hook (a shell command from
        // the local hooks.json) — code execution, so it shares the agents'
        // mode-dependent access gate.
        .route("/api/tasks/{id}/execute", post(execute_task))
        .route("/api/tasks/{id}/claim", post(claim_task))
        .route("/api/tasks/{id}/release", post(release_task))
        .route("/api/tasks/{id}/block", post(block_task))
        .route("/api/tasks/{id}/unblock", post(unblock_task))
        .route("/api/tasks/{id}/dependencies", get(list_dependencies))
        .route("/api/tasks/{id}/dependents", get(list_dependents))
        // Attachments: file uploads/downloads scoped to a task. Upload is
        // JSON body + base64 content (not multipart), per arch.md §4 — that
        // keeps the route inside the existing Content-Type gate with no
        // carve-out (a multipart/raw-body exception would reopen the
        // form-CSRF hole the gate exists to close). The body-limit raise
        // below is required so an at-cap upload is rejected by `Store`'s own
        // size check (in the standard JSON error shape), not by axum's 2 MiB
        // default limit (a bare non-JSON 413).
        .route(
            "/api/tasks/{id}/attachments",
            get(list_task_attachments)
                .post(create_attachment)
                .layer(DefaultBodyLimit::max(ATTACHMENT_BODY_LIMIT)),
        )
        .route(
            "/api/attachments/{id}",
            get(show_attachment).delete(delete_attachment),
        )
        // GET, not mutating — the Content-Type gate doesn't apply (matches
        // the git-diff/agents-list GET precedent below).
        .route("/api/attachments/{id}/download", get(download_attachment))
        .route(
            "/api/storyboards",
            get(list_storyboards).post(create_storyboard),
        )
        .route(
            "/api/storyboards/{id}",
            get(show_storyboard)
                .patch(update_storyboard)
                .delete(delete_storyboard),
        )
        .route("/api/storyboards/{id}/frames", post(create_frame))
        .route("/api/storyboards/{id}/edges", post(create_edge))
        .route("/api/storyboards/{id}/events", get(list_storyboard_events))
        .route("/api/frames/{id}", patch(update_frame).delete(delete_frame))
        .route(
            "/api/edges/{id}",
            get(show_edge).patch(update_edge).delete(delete_edge),
        )
        .route("/api/inbox", get(list_inbox).post(create_inbox))
        .route(
            "/api/inbox/{id}",
            get(show_inbox).patch(assign_inbox).delete(delete_inbox),
        )
        // Scripts: user-authored shell run from a generated form. A script
        // body is a program mesa executes, so authoring is the strictest gate
        // in the file (`require_local_path_write`, loopback-only in BOTH
        // modes) while reading and *running* share the agents' code-execution
        // gate — a LAN peer may trigger a run but must never choose the
        // program. See `docs/scripts.md`.
        .route("/api/scripts", get(list_scripts).post(create_script))
        .route(
            "/api/scripts/{id}",
            get(show_script).patch(update_script).delete(delete_script),
        )
        .route("/api/scripts/{id}/run", post(run_script))
        // Agents: live Claude Code sessions under a project's folder. All
        // four routes share `require_agent_access` (terminal access = code
        // execution): loopback-only in default mode, LAN-page-authenticated
        // under `--lan`.
        .route(
            "/api/projects/{id}/agents",
            get(list_project_agents).post(spawn_project_agent),
        )
        // Global session list across every project folder — backs the
        // persistent Agents sidebar (unlike the per-project route above,
        // this has no `path`/empty-state wrapper: it is just the bare array).
        .route("/api/agents", get(list_all_agents))
        .route("/api/agents/{id}/attach", get(attach_agent))
        // Terminal page: a raw `$SHELL` PTY per connection, no session
        // registry (unlike the agent routes above). Shares
        // `require_agent_access` unchanged — see that fn's doc.
        .route("/api/terminal/attach", get(terminal_attach))
        // Sidebar decoration: working-tree git status of each project's
        // `local_path`. Read-only external state (shells `git status`).
        .route("/api/git-status", get(get_git_status))
        // Header decoration: mesa's own version. A compile-time constant —
        // no store, no gate (it leaks nothing and the header needs it under
        // `--lan` too).
        .route("/api/version", get(get_mesa_version))
        // Project git tab: working-tree view (branch + changed files) and a
        // per-file unified diff. Read-only external state like /api/git-status,
        // so the same standard guard only — no agent access gate.
        .route("/api/projects/{id}/git", get(get_project_git))
        // Project header decoration: the app version in `local_path`'s
        // manifest. Same read-only, standard-guard-only posture as the git
        // routes — a plain file read of the project's own folder, no cache
        // (this is a per-page fetch, not a poll).
        .route("/api/projects/{id}/version", get(get_project_version))
        .route("/api/projects/{id}/git/diff", get(get_project_git_diff))
        // Commit history: recent log, one commit's changed files, and one
        // commit-file's diff. Same read-only/standard-guard-only posture as
        // the two routes above — these execute nothing but `git` shell-outs.
        .route("/api/projects/{id}/git/log", get(get_project_git_log))
        // One file's commit history — the whole-repo log above, narrowed by
        // a pathspec. Backs the Files tab's History pane; same read-only,
        // standard-guard-only posture as its siblings.
        .route(
            "/api/projects/{id}/git/file-log",
            get(get_project_git_file_log),
        )
        .route(
            "/api/projects/{id}/git/commits/{sha}/files",
            get(get_project_git_commit_files),
        )
        .route(
            "/api/projects/{id}/git/commits/{sha}/diff",
            get(get_project_git_commit_diff),
        )
        // Files tab: tree listing + file-content reads rooted at the
        // project's `local_path`, like the git tab. The tree route stays a
        // plain read (standard guard only, GET so the Content-Type gate
        // doesn't apply). The content route's GET is the same; its PATCH
        // (task 327, edit-and-save) shares the agents/hooks `require_agent_
        // access` gate instead — writing into local_path is code-execution-
        // adjacent, the same capability class those routes already guard.
        .route("/api/projects/{id}/files", get(get_project_files))
        .route(
            "/api/projects/{id}/files/content",
            get(get_project_files_content)
                .patch(update_project_files_content)
                .post(create_project_file),
        )
        // The same file as raw bytes, for saving to disk (task 683). A
        // separate route rather than a flag on the one above because the two
        // return different things: that one a capped, binary-blanked JSON
        // *view*, this one the file. Still a plain read — standard guard only,
        // like its sibling's GET.
        .route(
            "/api/projects/{id}/files/download",
            get(download_project_file),
        )
        // The same file again, inline and typed, for previewing an image in
        // the Files tab (task 801). A THIRD route rather than a flag on
        // either sibling: the download route's fixed octet-stream +
        // `attachment` is a boundary that must not be relaxed. Still a plain
        // read — standard guard only, like both siblings' GETs.
        .route("/api/projects/{id}/files/raw", get(raw_project_file))
        // New-project folder picker: unscoped (not one project's local_path)
        // server-side directory listing, plus creating one folder to pick.
        // Loopback-only in BOTH serve modes, reusing `require_local_path_write`
        // as-is — see that fn's doc and `docs/fs-browse.md`. The GET skips the
        // Content-Type gate; the POST is inside it like every other mutation.
        .route("/api/fs/dirs", get(list_fs_dirs).post(create_fs_dir))
        // CC Dashboard: read-only Claude Code telemetry (no Store access).
        .route("/api/cc/usage", get(get_cc_usage))
        .route("/api/cc", get(get_cc_dashboard))
        // Live sessions: cheap, frequently-polled slice of the telemetry.
        .route("/api/cc/live", get(get_cc_live))
        // The drill-down pair: aggregate detail (the default) and the call tree.
        .route("/api/cc/sessions/{session_id}", get(get_cc_session_detail))
        .route(
            "/api/cc/sessions/{session_id}/graph",
            get(get_cc_session_graph),
        )
        // The one CC *write*: purge the stored telemetry and re-ingest from
        // the transcripts on disk. An explicit operator action (Settings →
        // Model pricing), never something a read can trigger — so it is a
        // POST, on its own route, loopback-only in BOTH modes.
        .route("/api/cc/reset", post(reset_cc_index))
        // Project-scoped CC Dashboard: same telemetry, filtered to sessions
        // whose cwd matches this project's local_path. Reads the store only
        // for the project's local_path (like the git tab), so the standard
        // guard only — no agent access gate, Content-Type gate doesn't apply
        // (read-only GET).
        .route("/api/projects/{id}/cc", get(get_project_cc_dashboard))
        // Relaunches the server on the current `mesa` binary on disk (so a
        // rebuilt/reinstalled binary takes effect without the user manually
        // stopping and restarting `mesa serve`). Kills every in-flight
        // connection on this process, so it shares the agents' access gate.
        .route("/api/restart", post(restart_server))
        // The Settings page's view of `~/.mesa/config.json` — the three
        // agent-spawn command templates. Both verbs sit in the agents'
        // capability class (see `get_config`/`update_config`), not task CRUD.
        .route("/api/config", get(get_config).put(update_config))
        // The same file's `pricing` section — the CC Dashboard's cost rates.
        // Separate routes so `/api/config`'s shape (a bare ConfigCommand[])
        // stays exactly what agents and config-check.sh already assert.
        .route(
            "/api/config/pricing",
            get(get_config_pricing).put(update_config_pricing),
        )
        // The same file's `watchers` section — the todo-watcher's per-project
        // agent ceiling. A third route for the same reason as `pricing`:
        // `/api/config` keeps its bare ConfigCommand[] shape.
        .route(
            "/api/config/watchers",
            get(get_config_watchers).put(update_config_watchers),
        )
        // Everything outside /api is the embedded SPA; unknown paths fall
        // back to index.html with 200 so client-side routes deep-link.
        .fallback_service(axum_embed::ServeEmbed::<Assets>::with_parameters(
            Some("index.html".to_owned()),
            axum_embed::FallbackBehavior::Ok,
            Some("index.html".to_owned()),
        ))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Requirement 7 middleware: Host allowlist + Content-Type gate.
///
/// The Host allowlist is enforced only in default (loopback) mode. In LAN mode
/// (`state.lan`) it is skipped — LAN hosts are not enumerable and the user has
/// opted into no-auth LAN trust. The Content-Type gate runs in both modes.
async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let port = state.port;
    if !state.lan {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if host != format!("localhost:{port}") && host != format!("127.0.0.1:{port}") {
            return ApiError {
                status: StatusCode::FORBIDDEN,
                code: "validation",
                message: format!(
                    "rejected Host header {host:?}: must be localhost:{port} or 127.0.0.1:{port}"
                ),
            }
            .into_response();
        }
    }
    let mutating = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if mutating {
        let content_type = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let is_json = content_type
            .split(';')
            .next()
            .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"));
        if !is_json {
            return ApiError {
                status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
                code: "validation",
                message: format!(
                    "rejected Content-Type {content_type:?}: mutating requests require \
                     Content-Type: application/json"
                ),
            }
            .into_response();
        }
    }
    next.run(req).await
}

// ---- errors ----

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl From<Error> for ApiError {
    fn from(err: Error) -> ApiError {
        let (status, code) = match &err {
            Error::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Error::Validation(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            Error::Cycle(_) => (StatusCode::CONFLICT, "cycle"),
            Error::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Error::Db(_) | Error::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "conflict"),
        };
        ApiError {
            status,
            code,
            message: err.to_string(),
        }
    }
}

/// Malformed JSON bodies (bad syntax, wrong field types) are 422 validation
/// errors in the contract body shape, not axum's plain-text default.
impl From<JsonRejection> for ApiError {
    fn from(rej: JsonRejection) -> ApiError {
        ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: rej.body_text(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({"error": {"code": self.code, "message": self.message}});
        (self.status, Json(body)).into_response()
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

/// `Some(None)` when the field is `null`, `Some(Some(v))` when present, and
/// (via `#[serde(default)]`) `None` when absent — so PATCH can distinguish
/// "clear" from "leave unchanged".
fn double_option<'de, T, D>(de: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

// ---- projects ----

#[derive(Deserialize)]
struct ProjectCreate {
    name: String,
    #[serde(default)]
    description: Option<String>,
    /// Optional root-commit binding. The caller computes the hash (the server
    /// has no cwd/git context); the API only stores and enforces uniqueness.
    #[serde(default)]
    root_commit: Option<String>,
    /// Optional working-folder binding; like `root_commit`, the caller knows
    /// where the project lives, the API only records it.
    #[serde(default)]
    local_path: Option<String>,
    /// Optional parent project (task 668); absent or `null` = top level.
    /// A missing parent is a 422 `validation`, self-parenting/a loop a 409
    /// `cycle` — no new error codes.
    #[serde(default)]
    parent_id: Option<i64>,
}

#[derive(Deserialize)]
struct ProjectUpdate {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    root_commit: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    local_path: Option<Option<String>>,
    /// Manual nav position (task 666). A plain `Option`, not a double one:
    /// the column is NOT NULL, so there is nothing to clear — absent leaves
    /// it unchanged, and an explicit `null` or a non-numeric value is a 422
    /// from serde rather than a silent no-op.
    #[serde(default)]
    sort_order: Option<f64>,
    /// Parent project (task 668). A double option, like the other clearable
    /// bindings above: absent leaves it alone, an explicit `null` detaches the
    /// project to top level.
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<i64>>,
}

#[derive(Deserialize)]
struct ProjectResolve {
    commit: String,
}

#[derive(Deserialize)]
struct ProjectQuery {
    #[serde(default)]
    include_archived: bool,
}

async fn list_projects(
    State(state): State<AppState>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    if q.include_archived {
        Ok(Json(store.list_projects_all()?).into_response())
    } else {
        Ok(Json(store.list_projects()?).into_response())
    }
}

async fn create_project(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<ProjectCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    if body.local_path.is_some() {
        require_local_path_write(
            &state,
            &addr,
            &headers,
            "local_path is an agent execution anchor; it can only be set from this machine",
        )?;
    }
    let mut store = state.store.lock().unwrap();
    let project = store.create_project(
        &body.name,
        body.description.as_deref(),
        body.root_commit.as_deref(),
        body.local_path.as_deref(),
        body.parent_id,
    )?;
    Ok((StatusCode::CREATED, Json(project)).into_response())
}

async fn resolve_project(
    State(state): State<AppState>,
    Query(q): Query<ProjectResolve>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.find_project_by_root_commit(&q.commit)?).into_response())
}

async fn show_project(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_project(id)?).into_response())
}

async fn update_project(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    body: Result<Json<ProjectUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    if body.local_path.is_some() {
        require_local_path_write(
            &state,
            &addr,
            &headers,
            "local_path is an agent execution anchor; it can only be set from this machine",
        )?;
    }
    let patch = ProjectPatch {
        name: body.name,
        description: body.description,
        root_commit: body.root_commit,
        local_path: body.local_path,
        sort_order: body.sort_order,
        parent_id: body.parent_id,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_project(id, &patch)?).into_response())
}

async fn delete_project(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    // The echo carries the whole destroyed subtree (task 668): `subprojects`
    // is the descendant projects the FK cascade took with this one, `[]` for a
    // leaf. It is the recovery transcript, so nothing destroyed may be absent
    // from it.
    let (project, subprojects, tasks) = store.delete_project(id)?;
    Ok(
        Json(json!({"project": project, "subprojects": subprojects, "tasks": tasks}))
            .into_response(),
    )
}

async fn archive_project(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.archive_project(id)?).into_response())
}

async fn unarchive_project(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.unarchive_project(id)?).into_response())
}

// ---- tasks ----

#[derive(Deserialize)]
struct TaskCreate {
    project_id: i64,
    /// Required since task 660 removed `title`: a task's description is its
    /// identity, and its first line is the `name` every surface displays.
    description: String,
    #[serde(default)]
    priority: Option<Priority>,
    #[serde(default)]
    status: Option<Status>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    parent_id: Option<i64>,
}

#[derive(Deserialize)]
struct TaskUpdate {
    // Still a `double_option` even though a description can no longer be
    // cleared: that is what lets an explicit `{"description": null}` be
    // *rejected* (422 `validation`) rather than silently read as "omitted".
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default)]
    status: Option<Status>,
    #[serde(default)]
    priority: Option<Priority>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<i64>>,
    // The three long-text fields the CLI has always been able to write
    // (`task update --acceptance/--artifact/--result`). `null` clears, an
    // omitted key leaves the stored value alone — same `double_option`
    // convention as `description`, and the counterpart of the CLI's
    // empty-string-clears (`clear_if_empty`).
    #[serde(default, deserialize_with = "double_option")]
    acceptance: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    artifact: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    result: Option<Option<String>>,
    #[serde(default)]
    sort_order: Option<f64>,
}

#[derive(Deserialize)]
struct TaskQuery {
    #[serde(default)]
    project: Option<i64>,
    #[serde(default)]
    status: Option<Status>,
    #[serde(default)]
    tag: Option<String>,
    /// Only subtasks of this parent task id, matching the CLI's `--parent`.
    #[serde(default)]
    parent: Option<i64>,
    #[serde(default)]
    unblocked: bool,
}

#[derive(Deserialize)]
struct BlockBody {
    /// The blocker task id, matching the CLI's `--on`.
    on: i64,
}

async fn list_tasks(
    State(state): State<AppState>,
    Query(q): Query<TaskQuery>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    let tasks: Vec<TaskSummary> = store
        .list_tasks(q.project)?
        .iter()
        .filter(|t| q.status.is_none_or(|s| t.status == s))
        .filter(|t| q.tag.as_ref().is_none_or(|g| t.tags.iter().any(|x| x == g)))
        .filter(|t| q.parent.is_none_or(|p| t.parent_id == Some(p)))
        .filter(|t| !q.unblocked || !t.blocked)
        .map(TaskSummary::from)
        .collect();
    Ok(Json(tasks).into_response())
}

async fn create_task(
    State(state): State<AppState>,
    body: Result<Json<TaskCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let task = store.create_task(
        body.project_id,
        &body.description,
        body.priority.unwrap_or(Priority::Medium),
        &body.tags,
        body.parent_id,
        None,
        None,
        Some(body.status.unwrap_or(Status::Backlog)),
    )?;
    Ok((StatusCode::CREATED, Json(task)).into_response())
}

async fn show_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_task(id)?).into_response())
}

async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<TaskUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    // A task's description is its identity (task 660), so unlike the other
    // free-text bodies it has no clear. Rejecting an explicit null keeps the
    // CLI and API on one error, per "CLI and API share `core` and never
    // diverge" — `mesa task update --description ""` fails the same way.
    let description = match body.description {
        Some(None) => {
            return Err(Error::Validation(
                "description cannot be cleared; it is the task's identity".into(),
            )
            .into());
        }
        other => other.flatten(),
    };
    let patch = TaskPatch {
        description,
        status: body.status,
        priority: body.priority,
        tags: body.tags,
        parent_id: body.parent_id,
        acceptance: body.acceptance,
        artifact: body.artifact,
        result: body.result,
        sort_order: body.sort_order,
        // Append mode (spec 612) is a CLI-side batch-annotation affordance;
        // the HTTP wire type deliberately does not expose it, so PATCH keeps
        // its replace-only semantics.
        append: false,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_task(id, &patch)?).into_response())
}

async fn delete_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_task(id)?).into_response())
}

/// Fires the task-execute hook for one task: the
/// shell command configured in the local hooks.json, run with the task JSON
/// on stdin from the project's `local_path`. Triggering local code execution
/// is the agents' capability class, so it shares `require_agent_access`. The
/// hook's own exit code is data in the 200 response; no hook configured is
/// 422, a shell that cannot spawn is 502 `unavailable`.
async fn execute_task(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let (task, project_dir) = {
        let store = state.store.lock().unwrap();
        let task = store.get_task(id)?;
        let dir = store.get_project(task.project_id)?.local_path;
        (task, dir)
    };
    let command = hooks::command_for(hooks::TASK_EXECUTE)
        .map_err(|message| ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message,
        })?
        .ok_or_else(|| ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!(
                "no task-execute hook configured; add {{\"task-execute\": \"<command>\"}} to {}",
                hooks::hooks_file().display()
            ),
        })?;
    // The hook is an arbitrary blocking subprocess; keep it off the async
    // workers like the agents/usage shell-outs.
    let run = tokio::task::spawn_blocking(move || {
        hooks::run_task_execute(&command, &task, project_dir.as_deref())
    })
    .await
    .map_err(|e| agents_unavailable(format!("hook run panicked: {e}")))?
    .map_err(agents_unavailable)?;
    Ok(Json(run).into_response())
}

/// Lists the full task objects this task is directly blocked by.
async fn list_dependencies(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_blockers(id)?).into_response())
}

/// Lists the full task objects this task directly blocks — the reverse of
/// `list_dependencies`, so a client can walk the edge set both ways.
async fn list_dependents(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_blocking(id)?).into_response())
}

async fn block_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<BlockBody>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.add_dependency(id, body.on)?).into_response())
}

/// Body for `POST /api/tasks/{id}/claim`, mirroring `mesa task claim`.
#[derive(Deserialize)]
struct ClaimBody {
    /// Opaque claim holder, matching the CLI's `--owner`.
    owner: String,
    /// Break another owner's claim, matching the CLI's `--force`.
    #[serde(default)]
    force: bool,
}

async fn claim_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<ClaimBody>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.claim_task(id, &body.owner, body.force)?).into_response())
}

async fn release_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.release_task(id)?).into_response())
}

async fn unblock_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<BlockBody>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.remove_dependency(id, body.on)?).into_response())
}

// ---- attachments (files attached to a task) ----

/// Upper bound on the raw HTTP request body for the create-attachment route.
/// Comfortably exceeds `MAX_ATTACHMENT_BYTES * 4/3` (base64 expansion) plus
/// JSON framing overhead (~1 MiB headroom), or axum's own 2 MiB
/// `DefaultBodyLimit` would reject an at-cap upload with a bare non-JSON 413
/// before `Store`'s own size check ever runs — breaking the "errors are
/// always JSON" contract (arch.md §4). `Store::create_attachment` is what
/// actually enforces the cap.
const ATTACHMENT_BODY_LIMIT: usize =
    (attachments::MAX_ATTACHMENT_BYTES as usize) * 4 / 3 + 1024 * 1024;

#[derive(Deserialize)]
struct AttachmentCreate {
    filename: String,
    content_base64: String,
    #[serde(default)]
    author: Option<String>,
}

async fn list_task_attachments(
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_attachments(task_id)?).into_response())
}

/// Upload: JSON body with base64-encoded content, not multipart — see
/// arch.md §4 for why (multipart/raw-body on a mutating route would reopen
/// the form-CSRF hole the Content-Type gate exists to close). Unknown task
/// -> 404 `not_found` (via `Store::create_attachment`); bad base64 -> 422
/// `validation` here; oversized decoded content -> 422 `validation` from
/// `Store`'s own size check.
async fn create_attachment(
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    body: Result<Json<AttachmentCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.content_base64.as_bytes())
        .map_err(|e| ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!("invalid base64 content: {e}"),
        })?;
    let mut store = state.store.lock().unwrap();
    let attachment =
        store.create_attachment(task_id, &body.filename, &bytes, body.author.as_deref())?;
    Ok((StatusCode::CREATED, Json(attachment)).into_response())
}

async fn show_attachment(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_attachment(id)?).into_response())
}

/// Raw bytes, never JSON-wrapped. Not a mutating method, so the Content-Type
/// gate doesn't apply (matches the git-diff/agents-list GET precedent) —
/// reads exclusively through `Store::attachment_bytes`.
async fn download_attachment(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let (attachment, bytes) = {
        let store = state.store.lock().unwrap();
        store.attachment_bytes(id)?
    };
    let content_type = attachment
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CONTENT_DISPOSITION,
                content_disposition(&attachment.filename),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Builds a `Content-Disposition: attachment; filename="..."` header value.
/// Quotes/backslashes in the quoted-ASCII fallback are escaped; non-ASCII
/// bytes in that fallback are replaced with `_` (never left un-escaped) and
/// carried losslessly instead via the RFC 5987 `filename*=UTF-8''...`
/// extended parameter, which RFC 6266-aware clients (and browsers) prefer
/// over the plain `filename` when both are present.
fn content_disposition(filename: &str) -> String {
    disposition("attachment", filename)
}

/// The body of [`content_disposition`], parameterized by disposition kind so
/// the inline image route (`raw_project_file`) reuses the exact same quoting
/// and RFC 5987 escaping rather than growing a second, subtly different
/// header builder. `kind` is a fixed literal at every call site — never
/// request-derived.
fn disposition(kind: &str, filename: &str) -> String {
    let ascii_fallback: String = filename
        .chars()
        .map(|c| if c.is_ascii() { c } else { '_' })
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let encoded = percent_encode_rfc5987(filename);
    format!("{kind}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}")
}

/// Percent-encodes `s` per RFC 5987's `attr-char` set (used by the `filename*`
/// extended parameter): ASCII alphanumerics plus `!#$&+-.^_`|~` pass through
/// unescaped, everything else (including all non-ASCII UTF-8 bytes) is
/// percent-encoded. Hand-rolled rather than pulling in a general-purpose
/// percent-encoding dependency for one narrow, small use.
fn percent_encode_rfc5987(s: &str) -> String {
    const UNRESERVED: &[u8] = b"!#$&+-.^_`|~";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || UNRESERVED.contains(b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn delete_attachment(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_attachment(id)?).into_response())
}

// ---- storyboards ----

#[derive(Deserialize)]
struct StoryboardQuery {
    #[serde(default)]
    project: Option<i64>,
}

#[derive(Deserialize)]
struct StoryboardCreate {
    project_id: i64,
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    /// Missing/null defaults to `DiagramType::Storyboard`. Immutable after
    /// creation — no field on `StoryboardUpdate`.
    #[serde(default)]
    diagram_type: Option<DiagramType>,
}

/// Optional `?author=` for the change history on body-less mutations (DELETE).
#[derive(Deserialize)]
struct ActorQuery {
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct StoryboardUpdate {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    /// Recorded as the change author; does not alter the board's own author.
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct FrameCreate {
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    w: Option<f64>,
    #[serde(default)]
    h: Option<f64>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    task_id: Option<i64>,
    /// Must be a member of the board's `diagram_type` shape set; validated
    /// by `Store::create_frame`. Immutable after creation — no field on
    /// `FrameUpdate`.
    #[serde(default)]
    shape: Option<FrameShape>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct FrameUpdate {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    body: Option<Option<String>>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    w: Option<f64>,
    #[serde(default)]
    h: Option<f64>,
    #[serde(default, deserialize_with = "double_option")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    task_id: Option<Option<i64>>,
    /// Recorded as the change author; does not alter the frame's own author.
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct EdgeCreate {
    from_frame: i64,
    to_frame: i64,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct EdgeUpdate {
    #[serde(default, deserialize_with = "double_option")]
    label: Option<Option<String>>,
    #[serde(default)]
    waypoints: Option<Vec<Waypoint>>,
    #[serde(default, deserialize_with = "double_option")]
    from_anchor: Option<Option<AnchorSide>>,
    #[serde(default, deserialize_with = "double_option")]
    to_anchor: Option<Option<AnchorSide>>,
    /// Recorded as the change author.
    #[serde(default)]
    author: Option<String>,
}

async fn list_storyboards(
    State(state): State<AppState>,
    Query(q): Query<StoryboardQuery>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_storyboards(q.project)?).into_response())
}

async fn create_storyboard(
    State(state): State<AppState>,
    body: Result<Json<StoryboardCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let storyboard = store.create_storyboard(
        body.project_id,
        &body.title,
        body.description.as_deref(),
        body.author.as_deref(),
        body.diagram_type,
    )?;
    Ok((StatusCode::CREATED, Json(storyboard)).into_response())
}

/// Returns the board's full contents: {storyboard, frames, edges}.
async fn show_storyboard(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_storyboard_view(id)?).into_response())
}

async fn update_storyboard(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<StoryboardUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let patch = StoryboardPatch {
        title: body.title,
        description: body.description,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_storyboard(id, &patch, body.author.as_deref())?).into_response())
}

async fn delete_storyboard(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_storyboard(id)?).into_response())
}

/// Storyboard change history (who/what/when), oldest first.
async fn list_storyboard_events(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_storyboard_events(id)?).into_response())
}

async fn create_frame(
    State(state): State<AppState>,
    Path(storyboard_id): Path<i64>,
    payload: Result<Json<FrameCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(payload) = payload?;
    let new = FrameNew {
        title: payload.title,
        body: payload.body,
        x: payload.x.unwrap_or(40.0),
        y: payload.y.unwrap_or(40.0),
        w: payload.w.unwrap_or(240.0),
        h: payload.h.unwrap_or(140.0),
        color: payload.color,
        task_id: payload.task_id,
        author: payload.author,
        shape: payload.shape,
    };
    let mut store = state.store.lock().unwrap();
    let frame = store.create_frame(storyboard_id, &new)?;
    Ok((StatusCode::CREATED, Json(frame)).into_response())
}

async fn update_frame(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    payload: Result<Json<FrameUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(payload) = payload?;
    let patch = FramePatch {
        title: payload.title,
        body: payload.body,
        x: payload.x,
        y: payload.y,
        w: payload.w,
        h: payload.h,
        color: payload.color,
        task_id: payload.task_id,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_frame(id, &patch, payload.author.as_deref())?).into_response())
}

async fn delete_frame(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<ActorQuery>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    let (frame, edges) = store.delete_frame(id, q.author.as_deref())?;
    Ok(Json(json!({"frame": frame, "edges": edges})).into_response())
}

async fn create_edge(
    State(state): State<AppState>,
    Path(storyboard_id): Path<i64>,
    body: Result<Json<EdgeCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let edge = store.create_edge(
        storyboard_id,
        body.from_frame,
        body.to_frame,
        body.label.as_deref(),
        body.author.as_deref(),
    )?;
    Ok((StatusCode::CREATED, Json(edge)).into_response())
}

async fn show_edge(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_edge(id)?).into_response())
}

async fn update_edge(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<EdgeUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let patch = EdgePatch {
        label: body.label,
        waypoints: body.waypoints,
        from_anchor: body.from_anchor,
        to_anchor: body.to_anchor,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_edge(id, &patch, body.author.as_deref())?).into_response())
}

async fn delete_edge(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<ActorQuery>,
) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_edge(id, q.author.as_deref())?).into_response())
}

// ---- inbox (global update requests) ----

#[derive(Deserialize)]
struct InboxQuery {
    #[serde(default)]
    project: Option<i64>,
}

#[derive(Deserialize)]
struct InboxCreate {
    body: String,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct InboxAssign {
    /// The project to convert this item into a todo task in. Required.
    project_id: i64,
}

async fn list_inbox(
    State(state): State<AppState>,
    Query(q): Query<InboxQuery>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_inbox_items(q.project)?).into_response())
}

async fn create_inbox(
    State(state): State<AppState>,
    body: Result<Json<InboxCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let item = store.create_inbox_item(body.author.as_deref(), &body.body)?;
    Ok((StatusCode::CREATED, Json(item)).into_response())
}

async fn show_inbox(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_inbox_item(id)?).into_response())
}

/// Assigns an item to a project by converting it into a todo task there and
/// removing it from the inbox; returns the created task.
async fn assign_inbox(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<InboxAssign>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let task = store.assign_inbox_item(id, body.project_id)?;
    Ok(Json(task).into_response())
}

async fn delete_inbox(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_inbox_item(id)?).into_response())
}

// ---- scripts (user-authored shell) ----

#[derive(Deserialize)]
struct ScriptQuery {
    #[serde(default)]
    project: Option<i64>,
}

#[derive(Deserialize)]
struct ScriptCreate {
    name: String,
    /// The shell source. Required — a script without a body is not a script.
    body: String,
    #[serde(default)]
    project_id: Option<i64>,
    #[serde(default)]
    description: Option<String>,
    /// Declared arguments, in the order they reach the body as `$1`, `$2`, ….
    /// Absent means none.
    #[serde(default)]
    args: Vec<ScriptArg>,
}

#[derive(Deserialize)]
struct ScriptUpdate {
    /// `null` un-binds the script from its project (making it global); an
    /// omitted key leaves the binding alone — the `double_option` convention
    /// every other PATCH body here uses.
    #[serde(default, deserialize_with = "double_option")]
    project_id: Option<Option<i64>>,
    /// Replace-only, same `double_option` treatment as `body`: a script's name
    /// is how the CLI resolves it, so `null` is an error, not an erasure.
    #[serde(default, deserialize_with = "double_option")]
    name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    /// Replace-only. A `double_option` like `TaskUpdate::description` and for
    /// the same reason: the body *is* the script, so an explicit `null` must
    /// be *rejected* rather than silently read as "omitted".
    #[serde(default, deserialize_with = "double_option")]
    body: Option<Option<String>>,
    /// Replaces the whole declared arg list.
    #[serde(default)]
    args: Option<Vec<ScriptArg>>,
}

#[derive(Deserialize)]
struct ScriptRunBody {
    /// The form's values, keyed by declared arg name. Absent means none —
    /// `core::scripts::validate_values` decides whether that is valid.
    #[serde(default)]
    values: std::collections::BTreeMap<String, String>,
}

async fn list_scripts(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<ScriptQuery>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_scripts(q.project)?).into_response())
}

/// Authoring a script is choosing a program mesa will run, so this and its two
/// sibling mutations are loopback-only in **both** serve modes — the
/// `/api/config` posture (see `update_config`), for the same reason.
async fn create_script(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<ScriptCreate>, JsonRejection>,
) -> ApiResult<Response> {
    require_local_path_write(&state, &addr, &headers, SCRIPT_AUTHORING_LOOPBACK)?;
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let script = store.create_script(
        body.project_id,
        &body.name,
        body.description.as_deref(),
        &body.body,
        &body.args,
    )?;
    Ok((StatusCode::CREATED, Json(script)).into_response())
}

async fn show_script(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_script(id)?).into_response())
}

async fn update_script(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Result<Json<ScriptUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    require_local_path_write(&state, &addr, &headers, SCRIPT_AUTHORING_LOOPBACK)?;
    let Json(body) = body?;
    // `name` and `body` are the script's identity and its whole point; an
    // explicit `null` for either is rejected rather than read as "omitted",
    // the same way `update_task` treats a task's description — so the API and
    // `mesa script update --body ""` fail identically.
    let (name, source) = match (body.name, body.body) {
        (Some(None), _) => {
            return Err(Error::Validation(
                "name cannot be cleared; it is how a script is resolved".into(),
            )
            .into());
        }
        (_, Some(None)) => {
            return Err(
                Error::Validation("body cannot be cleared; it is the script".into()).into(),
            );
        }
        (name, source) => (name.flatten(), source.flatten()),
    };
    let patch = ScriptPatch {
        project_id: body.project_id,
        name,
        description: body.description,
        body: source,
        args: body.args,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_script(id, patch)?).into_response())
}

async fn delete_script(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_local_path_write(&state, &addr, &headers, SCRIPT_AUTHORING_LOOPBACK)?;
    let mut store = state.store.lock().unwrap();
    // The full destroyed record is the echo that stands in for the
    // confirmation prompt mesa deliberately does not have.
    Ok(Json(store.delete_script(id)?).into_response())
}

/// Runs one script with the supplied values and returns the captured outcome.
///
/// Triggering local code execution is the agents' capability class, so this
/// shares `require_agent_access` with them (and with `execute_task`) rather
/// than the authoring gate: a LAN peer may run what is already stored, it just
/// cannot decide what that is.
///
/// The script's own nonzero exit is **data** in a 200 response, exactly like a
/// `HookRun`; a value that fails validation is 422, and a bash that cannot be
/// spawned is 502 `unavailable`.
async fn run_script(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Result<Json<ScriptRunBody>, JsonRejection>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let Json(body) = body?;
    let script = {
        let store = state.store.lock().unwrap();
        store.get_script(id)?
    };
    let cwd = script_cwd(&state, &script)?;
    // `run` validates too (it is the same pure `core` function the CLI calls,
    // so the two cannot diverge), but its `Err` channel is "bash would not
    // start" → 502. Calling it here first is what separates a client mistake
    // about the declared args (422) from an execution failure.
    scripts::validate_values(&script.args, &body.values).map_err(|message| ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message,
    })?;
    // An arbitrary blocking subprocess with no timeout; keep it off the async
    // workers, like the hook and agents shell-outs.
    let run =
        tokio::task::spawn_blocking(move || scripts::run(&script, &body.values, cwd.as_deref()))
            .await
            .map_err(|e| agents_unavailable(format!("script run panicked: {e}")))?
            .map_err(agents_unavailable)?;
    Ok(Json(run).into_response())
}

/// The message every script mutation refuses a non-loopback peer with. One
/// constant so the three cannot drift apart.
const SCRIPT_AUTHORING_LOOPBACK: &str =
    "authoring scripts is loopback-only; connect from this machine";

/// The working directory a run happens in, resolved **server-side** from the
/// script's own project binding — never client-supplied. A bound project uses
/// its `local_path` (the terminal/agents ladder: no path, or a path that is not
/// a directory here, is 422 `validation`); an unbound script runs in `$HOME`,
/// like an inbox-watcher dispatch.
fn script_cwd(state: &AppState, script: &Script) -> Result<Option<String>, ApiError> {
    let Some(project_id) = script.project_id else {
        return Ok(
            directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_string_lossy().into_owned())
        );
    };
    let local_path = state
        .store
        .lock()
        .unwrap()
        .get_project(project_id)?
        .local_path;
    let Some(path) = local_path else {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!(
                "project {project_id} has no local_path; run `mesa project resolve` in its repo \
                 or `mesa project update {project_id} --path <dir>`"
            ),
        });
    };
    if !std::path::Path::new(&path).is_dir() {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!(
                "project {project_id} local_path {path:?} is not a directory on this machine"
            ),
        });
    }
    Ok(Some(path))
}

// ---- agents (live Claude Code sessions under a project's folder) ----

#[derive(Deserialize)]
struct AgentSpawnBody {
    /// Optional first prompt; without one the session starts idle, ready for
    /// the first message over an attach.
    #[serde(default)]
    prompt: Option<String>,
}

#[derive(Deserialize)]
struct AttachQuery {
    /// Initial terminal size, so the TUI's first paint fits the client.
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

/// [`terminal_attach`]'s own query: the same initial size as [`AttachQuery`],
/// plus the optional project whose `local_path` the shell starts in. Kept
/// separate rather than adding a field to `AttachQuery`, which is the agent
/// attach route's contract and has no project scope of its own.
#[derive(Deserialize)]
struct TerminalAttachQuery {
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    /// Omitted = the global Terminal page's `$HOME` shell. Set = the project
    /// Terminal tab: the shell's cwd is that project's `local_path`.
    #[serde(default)]
    project: Option<i64>,
}

/// How long a listed-sessions snapshot is reused per folder. Kept below the
/// UI's 3s poll so a single tab always sees near-live data (it re-runs the
/// ~0.5s `claude agents` each poll); the cache's job is to collapse *concurrent*
/// polls — multiple tabs or clients on the same folder within the window — into
/// one subprocess, not to skip a lone tab's polls.
const AGENTS_TTL: Duration = Duration::from_secs(2);

/// Sentinel key the global agents list caches under in `agents_cache`
/// (which is otherwise keyed by folder `local_path`). No real path can equal
/// this — paths are canonicalized and never contain a NUL byte.
const ALL_AGENTS_CACHE_KEY: &str = "\0all";

/// How long one folder's git status is reused. The sidebar polls every 10s
/// from possibly several tabs; `git status` walks the whole working tree, so
/// unlike AGENTS_TTL this also skips a lone tab's back-to-back polls.
const GIT_TTL: Duration = Duration::from_secs(5);

/// Working-tree git status for every project whose `local_path` is a live
/// git repo; other projects are omitted (no repo folder is not an error —
/// this is sidebar decoration, so the poll must stay quiet). Like the agents
/// list this reads external state, but it is plain read-only data — no code
/// execution — so it sits behind the global guard only, like the project
/// list that already exposes `local_path` itself.
async fn get_git_status(State(state): State<AppState>) -> ApiResult<Response> {
    let projects = state.store.lock().unwrap().list_projects()?;
    let mut rows = Vec::new();
    for p in projects {
        let Some(path) = p.local_path else { continue };
        if !std::path::Path::new(&path).is_dir() {
            continue;
        }
        let cached = {
            let cache = state.git_cache.lock().unwrap();
            cache
                .get(&path)
                .filter(|(at, _)| at.elapsed() < GIT_TTL)
                .map(|(_, s)| s.clone())
        };
        let status = match cached {
            Some(s) => s,
            None => {
                // Blocking subprocess (like the agents list) — keep it off
                // the async workers. A panic just means "no status this poll".
                let dir = path.clone();
                let s = tokio::task::spawn_blocking(move || git::status_of(&dir))
                    .await
                    .unwrap_or(None);
                let mut cache = state.git_cache.lock().unwrap();
                // Cap stale keys from renamed local_paths (mirrors agents_cache).
                if cache.len() >= 64 {
                    cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
                }
                cache.insert(path, (Instant::now(), s.clone()));
                s
            }
        };
        if let Some(git) = status {
            rows.push(ProjectGitStatus {
                project_id: p.id,
                git,
            });
        }
    }
    Ok(Json(rows).into_response())
}

/// `GET /api/version` — the running binary's own version, for the header.
/// Infallible and always 200: it is `CARGO_PKG_VERSION`, baked in at compile
/// time. Not to be confused with `get_project_version` below.
async fn get_mesa_version() -> Json<MesaVersion> {
    Json(MesaVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// `GET /api/projects/{id}/version` — the app version in the project's
/// `local_path`, out of its `Cargo.toml`/`package.json`/`pyproject.toml`
/// (`core::version`). Best-effort decoration, so it borrows
/// `project_git_view`'s posture exactly: no `local_path`, a folder that is
/// gone, or no usable manifest all return `200 {"version":null,"source":null}`
/// rather than an error. Only an unknown project id is `not_found`.
async fn get_project_version(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let empty = ProjectVersion {
        version: None,
        source: None,
    };
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(path) = local_path else {
        return Ok(Json(empty).into_response());
    };
    if !std::path::Path::new(&path).is_dir() {
        return Ok(Json(empty).into_response());
    }
    // Blocking file reads (like the git shell-outs) — keep them off the async
    // workers. A panic just means "no version this request".
    let found = tokio::task::spawn_blocking(move || version::version_of(&path))
        .await
        .unwrap_or(None);
    let body = match found {
        Some((version, source)) => ProjectVersion {
            version: Some(version),
            source: Some(source),
        },
        None => empty,
    };
    Ok(Json(body).into_response())
}

/// Resolves a project's `local_path` and the working-tree view behind it,
/// through `git_view_cache`: `(None, None)` when no folder is linked,
/// `(Some(path), None)` when the folder is gone or not a git repo — quiet
/// empty shapes, never an error (agents-endpoint posture). Unknown project
/// id still surfaces as `not_found` via `get_project`. Always reads
/// `local_path` itself — the History routes below never take a `?worktree=`
/// override (commit history is shared across worktrees of one repo).
async fn project_git_view(
    state: &AppState,
    id: i64,
) -> ApiResult<(Option<String>, Option<GitRepoView>)> {
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(path) = local_path else {
        return Ok((None, None));
    };
    if !std::path::Path::new(&path).is_dir() {
        return Ok((Some(path), None));
    }
    let view = git_view_at(state, &path).await;
    Ok((Some(path), view))
}

/// The working-tree view (branch + changed-file list) of one directory,
/// through `git_view_cache` keyed by that directory — generalized out of
/// `project_git_view` so the git-tab routes can point it at either a
/// project's `local_path` or one of its worktrees (`resolve_git_dir`).
async fn git_view_at(state: &AppState, dir: &str) -> Option<GitRepoView> {
    let cached = {
        let cache = state.git_view_cache.lock().unwrap();
        cache
            .get(dir)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, v)| v.clone())
    };
    match cached {
        Some(v) => v,
        None => {
            // Blocking subprocess (like the sidebar status) — keep it off the
            // async workers. A panic just means "no view this request".
            let d = dir.to_string();
            let v = tokio::task::spawn_blocking(move || git::view_of(&d))
                .await
                .unwrap_or(None);
            let mut cache = state.git_view_cache.lock().unwrap();
            // Cap stale keys from renamed local_paths (mirrors git_cache).
            if cache.len() >= 64 {
                cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
            }
            cache.insert(dir.to_string(), (Instant::now(), v.clone()));
            v
        }
    }
}

/// Every worktree of the repo behind `local_path`, through
/// `git_worktrees_cache` keyed by `local_path` (the list is the same
/// regardless of which worktree it's queried from, so `local_path` alone is
/// the right key). `None` when `local_path` is not a repo.
async fn git_worktrees_at(state: &AppState, local_path: &str) -> Option<Vec<GitWorktree>> {
    let cached = {
        let cache = state.git_worktrees_cache.lock().unwrap();
        cache
            .get(local_path)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, v)| v.clone())
    };
    match cached {
        Some(v) => v,
        None => {
            let d = local_path.to_string();
            let v = tokio::task::spawn_blocking(move || git::worktrees_of(&d))
                .await
                .unwrap_or(None);
            let mut cache = state.git_worktrees_cache.lock().unwrap();
            if cache.len() >= 64 {
                cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
            }
            cache.insert(local_path.to_string(), (Instant::now(), v.clone()));
            v
        }
    }
}

/// Resolves which directory a git-view/diff request should actually read:
/// `local_path` by default, or a caller-selected worktree of it when
/// `worktree` is `Some`. `worktree` must be byte-equal to one of
/// `git_worktrees_at(local_path)`'s `path` entries — that list is the
/// allowlist, the same membership-based defense as `?path=` on the diff
/// route (an unlisted/absolute/unrelated folder 404s rather than ever
/// reaching a `git -C <dir>` call). Also returns the worktree list itself so
/// callers that need it (the view route) don't re-fetch it.
async fn resolve_git_dir(
    state: &AppState,
    local_path: &str,
    worktree: Option<&str>,
) -> ApiResult<(String, Option<Vec<GitWorktree>>)> {
    let worktrees = git_worktrees_at(state, local_path).await;
    match worktree {
        None => Ok((local_path.to_string(), worktrees)),
        Some(w) => {
            let listed = worktrees
                .as_ref()
                .is_some_and(|wt| wt.iter().any(|e| e.path == w));
            if !listed {
                return Err(ApiError {
                    status: StatusCode::NOT_FOUND,
                    code: "not_found",
                    message: format!("worktree not found: {w}"),
                });
            }
            Ok((w.to_string(), worktrees))
        }
    }
}

#[derive(Deserialize)]
struct GitViewQuery {
    /// Selects which worktree's status/files `repo` reflects; must be a
    /// path from this same response's `worktrees` list (see
    /// `resolve_git_dir`). Omitted → the project's own `local_path`.
    worktree: Option<String>,
}

/// Working-tree view (branch + changed-file list) of this project's
/// `local_path`, or of one of its worktrees when `?worktree=` selects one,
/// for the git tab. Read-only external state behind the standard guard
/// only, like `/api/git-status`.
async fn get_project_git(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<GitViewQuery>,
) -> ApiResult<Response> {
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(local_path) = local_path else {
        return Ok(Json(ProjectGitView {
            path: None,
            repo: None,
            worktrees: None,
        })
        .into_response());
    };
    if !std::path::Path::new(&local_path).is_dir() {
        return Ok(Json(ProjectGitView {
            path: Some(local_path),
            repo: None,
            worktrees: None,
        })
        .into_response());
    }
    let (dir, worktrees) = resolve_git_dir(&state, &local_path, q.worktree.as_deref()).await?;
    let repo = git_view_at(&state, &dir).await;
    Ok(Json(ProjectGitView {
        path: Some(local_path),
        repo,
        worktrees,
    })
    .into_response())
}

#[derive(Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
    /// Same worktree selector as `GitViewQuery` — the diff is read from the
    /// selected worktree's directory, and `path` is checked against *that*
    /// worktree's own file-status list, not the project's default one.
    worktree: Option<String>,
}

/// Unified diff for one file from the selected worktree's (default: the
/// project's `local_path`) git status list. `?path=` must be byte-equal to a
/// listed file's `path` (or rename `orig_path`) — git's own status output is
/// the allowlist, so this can never read a file git didn't report (`../…`,
/// absolute paths, and clean files are all non-members → `not_found`). A
/// failed/empty underlying diff is `diff: ""`, never an error.
async fn get_project_git_diff(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<GitDiffQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("path not in git status: {wanted}"),
    };
    let Some(local_path) = local_path else {
        return Err(not_found());
    };
    if !std::path::Path::new(&local_path).is_dir() {
        return Err(not_found());
    }
    let (dir, _worktrees) = resolve_git_dir(&state, &local_path, q.worktree.as_deref()).await?;
    let repo = git_view_at(&state, &dir).await;
    let file = repo.as_ref().and_then(|r| {
        r.files
            .iter()
            .find(|f| f.path == wanted || f.orig_path.as_deref() == Some(wanted.as_str()))
    });
    let Some(file) = file else {
        return Err(not_found());
    };
    let untracked = file.status == "??";
    let target = wanted.clone();
    let diff = tokio::task::spawn_blocking(move || git::diff_of(&dir, &target, untracked))
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    Ok(Json(GitFileDiff { path: wanted, diff }).into_response())
}

/// Recent commit log for the project's `local_path` repo. Reuses
/// `project_git_view` purely as the path/repo validity gate (it already runs
/// `git status`, which is exactly "does `local_path` point at a live git
/// repo") — ladder: `path == None` -> `{path: None, commits: None}`; `path`
/// set + `repo == None` (folder gone / not a repo) -> `{path, commits:
/// None}`; `repo == Some(_)` (valid repo, possibly unborn HEAD) -> fetch the
/// log through `git_log_cache` -> `{path, commits: Some(vec)}` (`[]` on
/// unborn HEAD). Never an error.
async fn get_project_git_log(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let (path, repo) = project_git_view(&state, id).await?;
    let commits = match (&path, &repo) {
        (Some(dir), Some(_)) => {
            let cached = {
                let cache = state.git_log_cache.lock().unwrap();
                cache
                    .get(dir)
                    .filter(|(at, _)| at.elapsed() < GIT_TTL)
                    .map(|(_, c)| c.clone())
            };
            let commits = match cached {
                Some(c) => c,
                None => {
                    let d = dir.clone();
                    let c = tokio::task::spawn_blocking(move || git::commit_log_of(&d))
                        .await
                        .unwrap_or_default();
                    let mut cache = state.git_log_cache.lock().unwrap();
                    if cache.len() >= 64 {
                        cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
                    }
                    cache.insert(dir.clone(), (Instant::now(), c.clone()));
                    c
                }
            };
            Some(commits)
        }
        _ => None,
    };
    Ok(Json(ProjectGitLog { path, commits }).into_response())
}

#[derive(Deserialize)]
struct GitFileLogQuery {
    path: Option<String>,
}

/// Commit history for ONE file under the project's `local_path` — the Files
/// tab's History pane (mesa task 542). Deliberately carries no `?worktree=`,
/// like its `/git/log` sibling: every worktree of a repo shares one history.
///
/// `?path=` is required (missing -> 422 `validation`, matching the diff
/// routes) and is a path relative to `local_path`, resolved through
/// `files::safe_path` — the SAME chokepoint the Files tab's own tree/content
/// routes use, so traversal, absolute-path smuggling, symlink escapes and
/// nonexistent paths all collapse to 404 `not_found` here exactly as they do
/// there. Reusing that resolver (rather than allowlisting against git's file
/// lists, as the working-tree and per-commit diff routes do) is the coherent
/// choice for this route: the client is browsing the *filesystem* tree, and
/// a file's not being in git yet is a legitimate state this route answers
/// with an empty list, not a 404.
///
/// Empty-state ladder mirrors `get_project_git_log`'s exactly: no
/// `local_path` -> `{path: None, commits: None}`; dead folder / non-repo ->
/// `{path, commits: None}`; live repo -> `{path, commits: Some(vec)}`, where
/// `[]` means "this file has no commits yet". Cached 5s per
/// `(local_path, rel)`.
async fn get_project_git_file_log(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<GitFileLogQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let (path, repo) = project_git_view(&state, id).await?;
    let (Some(dir), Some(_)) = (&path, &repo) else {
        return Ok(Json(ProjectGitLog {
            path,
            commits: None,
        })
        .into_response());
    };
    if files::safe_path(dir, &wanted).is_none() {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: format!("file not found: {wanted}"),
        });
    }
    let key = (dir.clone(), wanted.clone());
    let cached = {
        let cache = state.git_file_log_cache.lock().unwrap();
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, c)| c.clone())
    };
    let commits = match cached {
        Some(c) => c,
        None => {
            let d = dir.clone();
            let rel = wanted.clone();
            let c = tokio::task::spawn_blocking(move || git::file_log_of(&d, &rel))
                .await
                .unwrap_or_default();
            let mut cache = state.git_file_log_cache.lock().unwrap();
            if cache.len() >= 64 {
                cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
            }
            cache.insert(key, (Instant::now(), c.clone()));
            c
        }
    };
    Ok(Json(ProjectGitLog {
        path,
        commits: Some(commits),
    })
    .into_response())
}

/// Validates `sha`'s shape, resolves the project's repo dir via
/// `project_git_view` (`repo == None` => `not_found`), then returns that
/// commit's changed-file list — cached — or `not_found` if the shape is
/// invalid or git couldn't resolve the commit. Bad-sha and no-repo collapse
/// to the same `not_found`: from the caller's perspective both mean "can't
/// show you that commit."
async fn project_commit_files(
    state: &AppState,
    id: i64,
    sha: &str,
) -> ApiResult<(String, Vec<GitCommitFile>)> {
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("unknown commit: {sha}"),
    };
    let (path, repo) = project_git_view(state, id).await?;
    let (Some(dir), Some(_)) = (path, repo) else {
        return Err(not_found());
    };
    let key = (dir.clone(), sha.to_string());
    let cached = {
        let cache = state.git_commit_files_cache.lock().unwrap();
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, f)| f.clone())
    };
    let files = match cached {
        Some(f) => Some(f),
        None => {
            let d = dir.clone();
            let sha_owned = sha.to_string();
            let f = tokio::task::spawn_blocking(move || git::commit_files_of(&d, &sha_owned))
                .await
                .unwrap_or(None);
            if let Some(f) = &f {
                let mut cache = state.git_commit_files_cache.lock().unwrap();
                if cache.len() >= 64 {
                    cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
                }
                cache.insert(key, (Instant::now(), f.clone()));
            }
            f
        }
    };
    files.map(|f| (dir, f)).ok_or_else(not_found)
}

/// Files changed in one commit. Read-only external state behind the standard
/// guard only, like the routes above.
async fn get_project_git_commit_files(
    State(state): State<AppState>,
    Path((id, sha)): Path<(i64, String)>,
) -> ApiResult<Response> {
    let (_dir, files) = project_commit_files(&state, id, &sha).await?;
    Ok(Json(files).into_response())
}

/// Unified diff of one file as introduced by one commit. `?path=` must be
/// byte-equal to a member of THAT COMMIT's own changed-file list (`path` or
/// rename `orig_path`) — mirrors `get_project_git_diff`'s allowlist, scoped
/// per-commit (M7) rather than to the working-tree status list. Diff text
/// itself is not cached (matches `get_project_git_diff`'s precedent); it
/// runs fresh per request via `commit_file_diff_of`, capped at DIFF_CAP.
async fn get_project_git_commit_diff(
    State(state): State<AppState>,
    Path((id, sha)): Path<(i64, String)>,
    Query(q): Query<GitDiffQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let (dir, files) = project_commit_files(&state, id, &sha).await?;
    let is_member = files
        .iter()
        .any(|f| f.path == wanted || f.orig_path.as_deref() == Some(wanted.as_str()));
    if !is_member {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: format!("path not in commit {sha}: {wanted}"),
        });
    }
    let sha_owned = sha.clone();
    let target = wanted.clone();
    let diff =
        tokio::task::spawn_blocking(move || git::commit_file_diff_of(&dir, &sha_owned, &target))
            .await
            .unwrap_or(None)
            .unwrap_or_default();
    Ok(Json(GitFileDiff { path: wanted, diff }).into_response())
}

/// Resolves a project's `local_path` and whether it is currently a live,
/// readable directory — the shared root check for both Files routes below.
/// `(None, false)` = no local_path; `(Some(path), false)` = path set but not a
/// live directory; `(Some(path), true)` = live directory. Unlike
/// `project_git_view` there's no subprocess here, so no third "call failed"
/// state to fold in. Unknown project id surfaces as `not_found` via
/// `get_project`.
async fn project_files_root(state: &AppState, id: i64) -> ApiResult<(Option<String>, bool)> {
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(path) = local_path else {
        return Ok((None, false));
    };
    let is_dir = std::path::Path::new(&path).is_dir();
    Ok((Some(path), is_dir))
}

#[derive(Deserialize)]
struct FilesTreeQuery {
    path: Option<String>,
}

/// Files tab tree listing — one directory level per call (mesa task 410).
/// `path` omitted lists `local_path` itself (the root level); `path` given
/// lists that subdirectory instead, resolved the same way `read_file`
/// resolves its own `?path=` (via `core::files::tree_level`, which anchors
/// through `safe_path`). Empty-state ladder mirrors `ProjectGitView` and
/// applies only to the root call: no `local_path` -> `{path: null, tree:
/// null, truncated: false}`; dead/unreadable folder -> `{path, tree: null,
/// truncated: false}`; live folder -> `{path, tree: Some(entries),
/// truncated}`, cached per `(local_path, path)` in `files_tree_cache`. A
/// `path`-scoped call for an invalid/traversal/nonexistent/non-directory
/// subpath is 404 `not_found` instead — that's not a state of the tree
/// itself, it's "this specific request doesn't resolve", same as the
/// content route's own collapse. Never a 5xx.
async fn get_project_files(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FilesTreeQuery>,
) -> ApiResult<Response> {
    let rel = q.path.filter(|p| !p.is_empty());
    let not_found_dir = |rel: &str| ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("directory not found: {rel}"),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    if !is_dir {
        if let Some(rel) = rel {
            return Err(not_found_dir(&rel));
        }
        return Ok(Json(ProjectFileTree {
            path,
            tree: None,
            truncated: false,
        })
        .into_response());
    }
    let dir = path.clone().expect("is_dir true implies path is Some");
    let rel_key = rel.clone().unwrap_or_default();
    let cache_key = (dir.clone(), rel_key.clone());
    let cached = {
        let cache = state.files_tree_cache.lock().unwrap();
        cache
            .get(&cache_key)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, v)| v.clone())
    };
    let level = match cached {
        Some(v) => Some(v),
        None => {
            // Walking a directory isn't free; keep it off the async workers,
            // same rationale as the git subprocess calls above.
            let d = dir.clone();
            let r = rel_key.clone();
            let v = tokio::task::spawn_blocking(move || files::tree_level(&d, &r))
                .await
                .unwrap_or(None);
            if let Some(ref v) = v {
                let mut cache = state.files_tree_cache.lock().unwrap();
                if cache.len() >= 64 {
                    cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
                }
                cache.insert(cache_key, (Instant::now(), v.clone()));
            }
            v
        }
    };
    let Some((entries, truncated)) = level else {
        // `tree_level` only returns None for a `rel` that doesn't resolve
        // (traversal, nonexistent, or a file) — for the root call `rel` is
        // always `"."`-anchored against an already-`is_dir`-verified path,
        // so this rung is a dead-folder race (perms/removal between the
        // `is_dir` check above and the walk), not the common case.
        if let Some(rel) = rel {
            return Err(not_found_dir(&rel));
        }
        return Ok(Json(ProjectFileTree {
            path,
            tree: None,
            truncated: false,
        })
        .into_response());
    };
    Ok(Json(ProjectFileTree {
        path,
        tree: Some(entries),
        truncated,
    })
    .into_response())
}

#[derive(Deserialize)]
struct FilesContentQuery {
    path: Option<String>,
}

/// Files tab content read for one file. Missing `?path=` is 422 `validation`
/// (matches `GitDiffQuery`'s precedent). No `local_path` / dead folder
/// collapses to 404 `not_found` (nothing under any root to serve). Otherwise
/// delegates to `core::files::read_file`, whose `None` — traversal, absolute
/// path, unlisted/nonexistent path, or a directory given for a file — is
/// 279's single 404 `not_found` case, matching the git tab's "bad sha and no
/// repo both mean not_found" precedent. Content reads are not cached (mirrors
/// the git diff routes).
async fn get_project_files_content(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FilesContentQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("file not found: {wanted}"),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    let (Some(root), true) = (path, is_dir) else {
        return Err(not_found());
    };
    let rel = wanted.clone();
    let view = tokio::task::spawn_blocking(move || files::read_file(&root, &rel))
        .await
        .unwrap_or(None);
    view.map(|v| Json(v).into_response()).ok_or_else(not_found)
}

/// Files tab raw-bytes download (task 683) — the same `?path=` contract as
/// [`get_project_files_content`] above (missing `path` 422 `validation`, no
/// `local_path` / dead folder / anything `safe_path` rejects 404 `not_found`
/// with the identical message), differing only in what comes back: the file
/// itself rather than a `FileContentView`. That is why it is a server route at
/// all — a client-side blob built from `content` would be empty for a binary
/// file and silently short for one past `FILE_CONTENT_CAP`, the two cases this
/// button most exists for.
///
/// `Content-Type` is a FIXED `application/octet-stream`, never sniffed or
/// derived from the extension: a repo's own `.html`/`.svg` must never be
/// servable as same-origin markup off this API. `Content-Disposition` reuses
/// [`content_disposition`] verbatim — the attachments download's header
/// builder, quoting and RFC 5987 escaping included.
///
/// Gate: the standard `guard` only, like `get_project_files_content` and the
/// git read routes. It reads a file the tree route already lists; it writes
/// nothing, so neither `require_local_path_write` nor `require_agent_access`
/// applies, and the Content-Type gate doesn't fire on a GET.
async fn download_project_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FilesContentQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("file not found: {wanted}"),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    let (Some(root), true) = (path, is_dir) else {
        return Err(not_found());
    };
    let rel = wanted.clone();
    // Reading a whole file isn't free; keep it off the async workers, same
    // rationale as the content route's own read.
    let read = tokio::task::spawn_blocking(move || files::read_file_download(&root, &rel))
        .await
        .unwrap_or(Err(files::DownloadFileError::NotFound));
    let (filename, bytes) = match read {
        Ok(v) => v,
        Err(files::DownloadFileError::NotFound) => return Err(not_found()),
        Err(files::DownloadFileError::TooLarge) => {
            return Err(ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message: "file is larger than mesa can download".into(),
            });
        }
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, content_disposition(&filename)),
        ],
        bytes,
    )
        .into_response())
}

/// Files tab inline image bytes (task 801) — the same `?path=` contract as
/// [`download_project_file`] above (missing `path` 422 `validation`, anything
/// `safe_path` rejects 404 `not_found` with the identical message, over-cap
/// 422), differing only in how the bytes are labelled: the file's real image
/// type and `inline` rather than a fixed `application/octet-stream` +
/// `attachment`.
///
/// It is a SEPARATE route precisely so that difference stays contained.
/// `/files/download` deliberately serves every file as an opaque attachment
/// and must never be relaxed to sniff or derive a type — a repo's own `.html`
/// would then be servable as same-origin markup. Here the boundary is
/// [`files::image_mime`]'s extension allowlist, checked BEFORE a single byte
/// is read: nothing but an image can come back, and no route may ever return
/// `text/html`. It is checked AFTER `safe_path`, so a path that escapes the
/// root is 404 like everywhere else rather than a 422 that would tell a
/// caller its extension was the only thing wrong with it.
///
/// The residual risk is SVG: an SVG served same-origin can carry script. The
/// mitigation is threefold — a `sandbox` + `default-src 'none'` CSP on the
/// response, `X-Content-Type-Options: nosniff` so a mislabelled body is not
/// re-guessed into markup, and the fact that the frontend only ever loads
/// this URL as the `src` of an `<img>`, which does not execute script in an
/// SVG document at all. Navigating to the URL directly is what the CSP is for.
///
/// One asymmetry worth naming: the type comes from the REQUESTED path while
/// the `filename` comes from the resolved one, so an in-repo symlink
/// `logo.png -> page.html` answers `image/png` with `filename="page.html"`.
/// Harmless — `nosniff` means the declared type is what the browser honours,
/// and those bytes were already reachable through `/files/download` — but the
/// two halves of the response can disagree, and the type is the load-bearing
/// half.
///
/// Gate: the standard `guard` only, like both sibling reads. It reads a file
/// the tree route already lists and writes nothing.
async fn raw_project_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FilesContentQuery>,
) -> ApiResult<Response> {
    let wanted = q.path.ok_or(ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: "path query parameter is required".into(),
    })?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("file not found: {wanted}"),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    let (Some(root), true) = (path, is_dir) else {
        return Err(not_found());
    };
    // `safe_path` first, THEN the allowlist. A path that escapes the root is
    // 404 — the same answer the sibling reads give, so this route never
    // becomes an oracle that distinguishes "outside the repo" from "inside
    // but not an image". It is a resolve, not a read: the allowlist still
    // rejects a non-image before a single byte is loaded.
    if files::safe_path(&root, &wanted).is_none() {
        return Err(not_found());
    }
    let mime = files::image_mime(&wanted).ok_or_else(|| ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code: "validation",
        message: format!("not a previewable image: {wanted}"),
    })?;
    let rel = wanted.clone();
    // Reading a whole file isn't free; keep it off the async workers, same
    // rationale as the download route's own read.
    let read = tokio::task::spawn_blocking(move || files::read_file_download(&root, &rel))
        .await
        .unwrap_or(Err(files::DownloadFileError::NotFound));
    let (filename, bytes) = match read {
        Ok(v) => v,
        Err(files::DownloadFileError::NotFound) => return Err(not_found()),
        Err(files::DownloadFileError::TooLarge) => {
            return Err(ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message: "file is larger than mesa can download".into(),
            });
        }
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (
                header::CONTENT_DISPOSITION,
                disposition("inline", &filename),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; sandbox".to_string(),
            ),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
struct FilesContentUpdate {
    path: String,
    content: String,
}

/// Files tab edit-and-save (task 327). Path and new content ride the JSON
/// body — not a query string — for the same reason attachments' upload does:
/// it keeps this mutating route inside the Content-Type CSRF gate. Gated by
/// [`require_agent_access`], not the plain `guard` the read routes above use:
/// writing into a project's `local_path` is code-execution-adjacent (the
/// written bytes can be a hook script, a git hook, or anything else that
/// later executes), the same capability class as the agents/hooks routes —
/// under `--lan` a peer who can already spawn an agent or run a hook in this
/// folder gains nothing new here, so reusing that gate (rather than the
/// stricter loopback-only `require_local_path_write`) is the coherent choice,
/// not a looser one. On success, re-reads and returns the fresh
/// `FileContentView` (matches every other mutation in this API echoing the
/// full updated object). `core::files::write_file`'s `NotFound` collapses
/// path-traversal/nonexistent/directory/write-failure into 404 `not_found`;
/// `Validation` (binary target, truncated target, oversized new content) is
/// 422 `validation` — mirrors the read route's own collapse-many-causes
/// precedent.
async fn update_project_files_content(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<FilesContentUpdate>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("file not found: {}", body.path),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    let (Some(root), true) = (path, is_dir) else {
        return Err(not_found());
    };
    let rel = body.path.clone();
    let content = body.content;
    let write_root = root.clone();
    let write_rel = rel.clone();
    let write_result =
        tokio::task::spawn_blocking(move || files::write_file(&write_root, &write_rel, &content))
            .await
            .unwrap_or(Err(files::WriteFileError::NotFound));
    if let Err(err) = write_result {
        return match err {
            files::WriteFileError::NotFound => Err(not_found()),
            files::WriteFileError::Validation(message) => Err(ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message: message.into(),
            }),
        };
    }
    let view = tokio::task::spawn_blocking(move || files::read_file(&root, &rel))
        .await
        .unwrap_or(None);
    view.map(|v| Json(v).into_response()).ok_or_else(not_found)
}

#[derive(Deserialize)]
struct FilesContentCreate {
    path: String,
}

/// Files tab create-a-file (task 672) — the surface's second write route, and
/// the only one that brings a new path into existence. Body carries `path`
/// and nothing else: the new file is always EMPTY, and content arrives
/// afterwards through the PATCH above, so there is no `content` field to
/// validate a second time.
///
/// Gated by [`require_agent_access`] — the SAME gate as the PATCH beside it,
/// for the same reason: bytes written under a project's `local_path` are
/// code-execution-adjacent, and a peer who can already overwrite a file in
/// that folder gains nothing new by being able to add one. Not the plain read
/// guard, and not the stricter loopback-only `require_local_path_write` the
/// unscoped `/api/fs/dirs` uses. Being a mutation with a JSON body, it also
/// sits inside the global Content-Type/CSRF gate.
///
/// `core::files::create_file`'s errors map exactly like `create_fs_dir`'s:
/// `NotFound` → 404 (the parent doesn't resolve, isn't a directory, or the
/// write failed), `Validation` → 422 (unusable file name), `Conflict` → 409
/// (the name is taken). No `local_path` / dead folder is 404 too, matching its
/// neighbours.
///
/// The `files_tree_cache` entry for the new file's own directory is evicted
/// before responding: that cache has a 5s TTL, and the client refetches the
/// level immediately, so leaving it in place would show a tree that doesn't
/// contain the file that was just created. On success the fresh
/// `FileContentView` is echoed, like every other mutation in this API.
async fn create_project_file(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<FilesContentCreate>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("file not found: {}", body.path),
    };
    let (path, is_dir) = project_files_root(&state, id).await?;
    let (Some(root), true) = (path, is_dir) else {
        return Err(not_found());
    };
    let rel = body.path.clone();
    let create_root = root.clone();
    let create_rel = rel.clone();
    let created =
        tokio::task::spawn_blocking(move || files::create_file(&create_root, &create_rel))
            .await
            .unwrap_or(Err(files::CreateFileError::NotFound));
    if let Err(err) = created {
        return match err {
            files::CreateFileError::NotFound => Err(not_found()),
            files::CreateFileError::Validation(message) => Err(ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message: message.into(),
            }),
            files::CreateFileError::Conflict => Err(ApiError {
                status: StatusCode::CONFLICT,
                code: "conflict",
                message: format!("already exists: {}", body.path),
            }),
        };
    }
    // The key `get_project_files` caches under: `""` is the root level, else
    // the parent's own relative path.
    let rel_key = match rel.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    };
    state
        .files_tree_cache
        .lock()
        .unwrap()
        .remove(&(root.clone(), rel_key));
    let view = tokio::task::spawn_blocking(move || files::read_file(&root, &rel))
        .await
        .unwrap_or(None);
    view.map(|v| Json(v).into_response()).ok_or_else(not_found)
}

#[derive(Deserialize)]
struct FsDirsQuery {
    path: Option<String>,
}

/// `GET /api/fs/dirs` — server-side directory listing backing the web UI's
/// new-project folder picker (mesa task 405; see `.scratch/arch.md`, spec
/// task 404's Open Question A). UNLIKE the Files tab above, this is not
/// project-scoped and not rooted at any `local_path`: `path` is an absolute
/// filesystem path (or omitted, defaulting to `$HOME` via the same
/// `directories::BaseDirs::new().home_dir()` call `terminal_attach`/
/// `bridge_attach` already use). Gated by [`require_local_path_write`] as-is
/// (loopback-only in BOTH `serve` modes) — arch.md §6: browsing the
/// filesystem is the same capability class as anchoring where an agent
/// executes, not plain CRUD, so it gets the same boundary. The bound on
/// *which* paths can be listed is the OS's own permission model, not a mesa-
/// imposed prefix (arch.md §0-§2) — `core::files::list_dir` does the
/// resolve/read; any failure (unresolvable path, not a directory, unreadable)
/// collapses to 404 `not_found`, matching the Files tab's own "one case for
/// traversal/absolute/unlisted/directory" precedent. GET, so the
/// Content-Type/CSRF gate does not apply.
async fn list_fs_dirs(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<FsDirsQuery>,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "this endpoint is loopback-only; connect from this machine",
    )?;
    let requested = match q.path {
        Some(p) => p,
        None => {
            let home = directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf());
            match home {
                Some(h) => h.to_string_lossy().into_owned(),
                None => {
                    return Err(ApiError {
                        status: StatusCode::NOT_FOUND,
                        code: "not_found",
                        message: "could not resolve home directory".into(),
                    });
                }
            }
        }
    };
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("directory not found: {requested}"),
    };
    let lookup = requested.clone();
    let listing = tokio::task::spawn_blocking(move || files::list_dir(&lookup))
        .await
        .unwrap_or(None);
    listing
        .map(|v| Json(v).into_response())
        .ok_or_else(not_found)
}

#[derive(Deserialize)]
struct FsDirCreate {
    path: String,
    name: String,
}

/// `POST /api/fs/dirs` — create one folder inside a directory the picker is
/// already showing, so a project can be started in a folder that doesn't
/// exist yet (mesa task 489). Body: `{"path": <absolute parent>, "name":
/// <single folder name>}`; echoes the new `DirEntry`, identical in shape to
/// the ones the GET lists, so the client can navigate into it without a
/// second request.
///
/// Gated by [`require_local_path_write`] — the SAME gate as the GET beside it,
/// deliberately: creating a directory is a strictly larger capability than
/// listing one, so it can never be gated more loosely than its own read. It is
/// not `require_agent_access` (which `update_project_files_content` uses):
/// that gate's `--lan` relaxation is justified by the write being confined to
/// a project's `local_path`, where a LAN peer could already spawn an agent —
/// this route is unscoped, so it keeps the stricter loopback-only-in-both-modes
/// bound the rest of this endpoint has. Being a mutation, it also sits inside
/// the global Content-Type/CSRF gate.
///
/// `core::files::create_dir`'s errors map one-to-one: `NotFound` → 404 (the
/// parent vanished — the same collapse the GET performs), `Validation` → 422
/// (unusable folder name), `Conflict` → 409 (name already taken).
async fn create_fs_dir(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<FsDirCreate>,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "this endpoint is loopback-only; connect from this machine",
    )?;
    let parent = body.path.clone();
    let name = body.name.clone();
    let created = tokio::task::spawn_blocking(move || files::create_dir(&parent, &name))
        .await
        .unwrap_or(Err(files::CreateDirError::NotFound));
    match created {
        Ok(entry) => Ok(Json(entry).into_response()),
        Err(files::CreateDirError::NotFound) => Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: format!("directory not found: {}", body.path),
        }),
        Err(files::CreateDirError::Validation(message)) => Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: message.into(),
        }),
        Err(files::CreateDirError::Conflict) => Err(ApiError {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: format!("already exists: {}", body.name.trim()),
        }),
    }
}

/// Terminal access is code execution on this machine — a strictly stronger
/// capability than the task CRUD the rest of the API exposes. In default
/// (loopback) mode the agent endpoints are never served to non-local peers.
/// Under `--lan` the user has opted into no-auth LAN trust, and that trust
/// extends to the agent endpoints (so the web UI works from another machine);
/// what `--lan` does NOT extend to is the browser-as-confused-deputy attacks,
/// which [`require_agent_access`] still blocks per-mode.
fn require_loopback(addr: &SocketAddr) -> Result<(), ApiError> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: "agent endpoints are loopback-only; connect from this machine".into(),
    })
}

/// A project's `local_path` is the folder `claude --bg`/`claude agents` run
/// in — an execution input, not mere task data. So writing it is loopback-only
/// even under `--lan`: a LAN peer (who under `--lan` can otherwise write any
/// project field) must not be able to point a future locally-triggered agent
/// at a directory of their choosing. Under `--lan` the loopback peer alone is
/// not enough: the global `guard` skips its Host check there, so a
/// DNS-rebinding page on THIS machine reaches us with a loopback peer and its
/// own hostname in Host — the same confused-deputy the agent routes block —
/// hence the Host/Origin checks stack on top (in default mode `guard` already
/// pinned the Host).
///
/// Also reused as-is (not duplicated) by BOTH halves of the filesystem-browse
/// endpoint (`GET /api/fs/dirs`, mesa task 405/arch.md §6, and `POST
/// /api/fs/dirs`, task 489) — listing a directory or creating one is a
/// different capability than writing `local_path`, but the same "loopback-only
/// in BOTH modes" rationale applies (filesystem-exposure adjacent to the
/// execution-anchor concept, not plain CRUD), so `message` is caller-supplied
/// rather than hardcoded to `local_path`-specific copy.
fn require_local_path_write(
    state: &AppState,
    addr: &SocketAddr,
    headers: &HeaderMap,
    message: &'static str,
) -> Result<(), ApiError> {
    require_loopback(addr).map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: message.into(),
    })?;
    if state.lan {
        require_lan_page_access(addr, headers, state.port)?;
    }
    Ok(())
}

/// The Host-allowlist half of the DNS-rebinding defense for the agent
/// endpoints in default (loopback) mode: `require_loopback` sees the local
/// peer and same-origin GETs carry no Origin, so only the Host header — which
/// a browser sets to the page's rebound hostname, not `localhost` — still
/// distinguishes a rebinding page. Mirrors the allowlist in `guard`. Under
/// `--lan` the wider `require_lan_agent_host` runs instead.
fn require_local_host(headers: &HeaderMap, port: u16) -> Result<(), ApiError> {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host == format!("localhost:{port}") || host == format!("127.0.0.1:{port}") {
        return Ok(());
    }
    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: format!(
            "rejected Host {host:?}: agent endpoints require localhost:{port} or 127.0.0.1:{port}"
        ),
    })
}

/// The full access gate shared by all three agent routes, per serve mode.
///
/// Default (loopback) mode: local TCP peer (`require_loopback`) + local Host
/// (`require_local_host`) + local Origin (`require_local_origin`) — terminal
/// access never leaves this machine.
///
/// `--lan` mode: LAN peers are allowed (the opt-in "trust every device on the
/// LAN" posture now includes the terminal, so the web UI works from another
/// machine), but the browser-as-confused-deputy holes stay closed:
/// - DNS rebinding: `require_lan_agent_host` — the Host must be `localhost` or
///   an IP literal on the serve port. A rebound page's requests carry its own
///   DNS hostname in Host (that's the name the browser resolved), never an IP
///   literal, so this refuses it without needing to enumerate LAN addresses.
/// - Cross-site fetch/WebSocket: `require_origin_matches_host` — a browser
///   Origin must be local or exactly the host the request was addressed to.
fn require_agent_access(
    state: &AppState,
    addr: &SocketAddr,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    if state.lan {
        return require_lan_page_access(addr, headers, state.port);
    }
    require_loopback(addr)?;
    require_local_host(headers, state.port)?;
    require_local_origin(headers)?;
    Ok(())
}

/// The `--lan` page-authenticity gate, shared by the agent routes and the
/// `local_path` write. Under `--lan` we serve remote LAN browsers, so we cannot
/// demand a loopback peer; instead we require the request to have come from a
/// page THIS server served. The two checks are ordered and interdependent:
/// `require_lan_agent_host` first pins the Host to `localhost`/an IP-literal on
/// our port (a rebinding page can only send its own DNS name), THEN
/// `require_origin_matches_host` confirms a browser Origin equals that vetted
/// Host (or is a local page from a loopback peer). Order is load-bearing — the
/// Origin match trusts the Host, so the Host must be validated first.
fn require_lan_page_access(
    addr: &SocketAddr,
    headers: &HeaderMap,
    port: u16,
) -> Result<(), ApiError> {
    require_lan_agent_host(headers, port)?;
    require_origin_matches_host(addr, headers)?;
    Ok(())
}

/// The `--lan` half of the DNS-rebinding defense: accept `localhost:<port>` or
/// any `<ip>:<port>` / `[<ipv6>]:<port>` Host (the IP a LAN browser typed is
/// the server's own — an attacker cannot serve a page from it), refuse
/// DNS-name Hosts (the only kind a rebinding page can send). The port must be
/// ours: an IP Host on a foreign port is some other service's origin, not a
/// page this server handed out.
fn require_lan_agent_host(headers: &HeaderMap, port: u16) -> Result<(), ApiError> {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    // `localhost:<port>` without allocating a `format!` per request.
    if host
        .strip_prefix("localhost:")
        .and_then(|p| p.parse::<u16>().ok())
        == Some(port)
    {
        return Ok(());
    }
    // SocketAddr's parser accepts exactly `<ipv4>:<port>` and `[<ipv6>]:<port>`.
    if let Ok(sock) = host.parse::<SocketAddr>()
        && sock.port() == port
    {
        return Ok(());
    }
    // Browsers omit `:80` from Host on the default HTTP port, so serving on 80
    // yields portless forms: `localhost`, `192.168.1.50`, `[::1]`.
    if port == 80 {
        let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']'));
        if host == "localhost"
            || host.parse::<std::net::IpAddr>().is_ok()
            || bare.is_some_and(|h| h.parse::<std::net::Ipv6Addr>().is_ok())
        {
            return Ok(());
        }
    }
    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: format!(
            "rejected Host {host:?}: this endpoint under --lan requires localhost:{port} or an \
             IP-literal host on port {port} (DNS-rebinding defense) — browse the UI by IP, e.g. \
             http://<machine-ip>:{port}"
        ),
    })
}

/// The `--lan` cross-site check: a browser Origin must match the request's Host
/// — i.e. the page came from this very server, by whatever IP the browser used
/// to reach it — OR be a local page (embedded UI / vite dev on another port)
/// **from a loopback peer**. The loopback scope on the local-page bypass is
/// load-bearing: a REMOTE browser showing a hostile `localhost:*` page could
/// otherwise pass it and open the attach socket cross-origin (the WebSocket is
/// exempt from CORS, so this is its only cross-site defense). A legit remote
/// page's Origin equals the Host it was served from, so it still passes the
/// Host-match branch. Origin-less non-browser clients pass, as in default mode.
/// Depends on the caller having vetted the Host first (see
/// [`require_lan_page_access`]): the Host-match branch trusts the Host value.
fn require_origin_matches_host(addr: &SocketAddr, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    if addr.ip().is_loopback() && require_local_origin(headers).is_ok() {
        return Ok(());
    }
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let origin_host = origin.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    if !host.is_empty() && origin_host == host {
        return Ok(());
    }
    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: format!(
            "rejected Origin {origin:?}: this endpoint requires a page served by this host"
        ),
    })
}

/// Blocks cross-site fetch/WebSocket in default mode: a browser Origin must be
/// a local page (the embedded UI, or the vite dev server, on any port). The
/// attach WebSocket is exempt from CORS and browsers send `Host: <target>` on
/// it, so neither the Host allowlist nor the Content-Type gate protect it —
/// but browsers DO always send the page's `Origin`. A missing Origin means a
/// non-browser client (curl, native), which is fine — anything local already
/// has a terminal of its own. Under `--lan`, `require_origin_matches_host`
/// wraps this (loopback-scoped) and adds the Host-match branch for remote pages.
fn require_local_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    const LOCAL: [&str; 6] = [
        "http://localhost",
        "http://127.0.0.1",
        "http://[::1]",
        "https://localhost",
        "https://127.0.0.1",
        "https://[::1]",
    ];
    let local = LOCAL.iter().any(|base| {
        origin == *base
            || origin
                .strip_prefix(base)
                .is_some_and(|rest| rest.starts_with(':'))
    });
    if local {
        return Ok(());
    }
    Err(ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: format!("rejected Origin {origin:?}: must be a local page"),
    })
}

/// The claude CLI missing or misbehaving is an upstream problem, reported like
/// a dead usage endpoint: 502 `unavailable`.
fn agents_unavailable(message: String) -> ApiError {
    ApiError {
        status: StatusCode::BAD_GATEWAY,
        code: "unavailable",
        message,
    }
}

/// Relaunches the server: gracefully shuts down `axum::serve` (so the port is
/// released before anything rebinds it) and lets `serve` spawn a fresh
/// process off `current_exe()` once that completes. Same access gate as the
/// Agents endpoints — this is a strictly available-to-a-local-human action,
/// not something a blind cross-site request should ever reach.
///
/// The response is written to this request's own connection before
/// `with_graceful_shutdown` closes the listener, so the caller reliably sees
/// `{"restarting": true}` even though the process that sent it exits shortly
/// after. A second concurrent call (double-click) finds the oneshot already
/// taken and just reports the same thing — restart is idempotent.
/// `GET /api/config` — the three spawn command templates, each with its
/// built-in default and the placeholders it offers (`docs/config.md`).
///
/// Gated like the agent routes rather than like task CRUD: this reads the
/// argv mesa will execute, and it is the read half of a write that *is* code
/// execution. A malformed config is 502 `unavailable`, the same answer a spawn
/// gives — the Settings page must say "your config file is broken", never
/// render an empty editor that a save would then write over the wreckage.
async fn get_config(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    match config::settings() {
        Ok(commands) => Ok(Json(commands).into_response()),
        Err(message) => Err(ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        }),
    }
}

#[derive(Deserialize)]
struct ConfigUpdate {
    /// Only the keys present are touched; a blank value clears one back to its
    /// built-in default. Absent keys keep whatever the file already says, so
    /// two editors can't clobber each other's untouched rows.
    commands: HashMap<String, String>,
}

/// `PUT /api/config` — writes command templates and echoes the new settings.
///
/// **Loopback-only in both modes**, one notch stronger than the agent routes:
/// this rewrites the argv mesa itself runs on the next dispatch, so a LAN peer
/// under `--lan` (who may spawn an agent) still must not be able to choose the
/// *program* that spawn executes. Same rule, and the same helper, as the
/// `local_path` write — the other "execution input, not data" field.
async fn update_config(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ConfigUpdate>,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "editing the mesa config is loopback-only; connect from this machine",
    )?;
    config::save_commands(&body.commands).map_err(|e| match e {
        config::SaveError::Validation(message) => ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message,
        },
        config::SaveError::Unavailable(message) => ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        },
    })?;
    get_config(State(state), ConnectInfo(addr), headers).await
}

/// `GET /api/config/pricing` — the per-model-family price table the CC
/// Dashboard estimates cost from: mesa's built-in rates, each with whatever
/// `~/.mesa/config.json` overrides it with (`docs/config.md`, mesa task 692).
///
/// Gated like `get_config` — same file, same class of secret — and a malformed
/// config is the same 502 `unavailable`, for the same reason: the editor must
/// never render blank over a file it couldn't read.
async fn get_config_pricing(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    match config::pricing() {
        Ok(prices) => Ok(Json(prices).into_response()),
        Err(message) => Err(ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        }),
    }
}

#[derive(Deserialize)]
struct PricingUpdate {
    /// Only the prefixes present are touched; `null` removes one — restoring
    /// the built-in rate for a family mesa ships, deleting the row for one the
    /// user added. Absent keys keep whatever the file already says.
    pricing: HashMap<String, Option<ModelRates>>,
}

/// `PUT /api/config/pricing` — writes price rows and echoes the table.
///
/// **Loopback-only in both modes**, like `update_config`: it is the same file,
/// and a write that a LAN peer could aim at mesa's own config is exactly the
/// thing that gate exists to stop — the section it lands in is not the
/// distinction that matters.
async fn update_config_pricing(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PricingUpdate>,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "editing the mesa config is loopback-only; connect from this machine",
    )?;
    config::save_pricing(&body.pricing).map_err(|e| match e {
        config::SaveError::Validation(message) => ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message,
        },
        config::SaveError::Unavailable(message) => ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        },
    })?;
    get_config_pricing(State(state), ConnectInfo(addr), headers).await
}

/// `GET /api/config/watchers` — the watcher settings the Settings page edits:
/// today the todo-watcher's per-project agent ceiling, with the built-in
/// default beside it (`docs/config.md`, mesa task 777).
///
/// Gated like `get_config_pricing` — same file, same class of secret — and a
/// malformed config is the same 502 `unavailable`, so the editor never renders
/// a blank box over a file it couldn't read.
async fn get_config_watchers(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    match config::watchers() {
        Ok(watchers) => Ok(Json(watchers).into_response()),
        Err(message) => Err(ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        }),
    }
}

#[derive(Deserialize)]
struct WatchersUpdate {
    /// Absent leaves the key alone; `null` removes it (restoring the built-in
    /// 1). The value stays raw JSON so `0`, `-1` and `2.5` are the config
    /// layer's named 422 rather than a deserializer rejection.
    #[serde(default, deserialize_with = "deserialize_some")]
    todo_concurrency: Option<Option<serde_json::Value>>,
}

/// Distinguishes an absent key from an explicit `null` — the difference
/// between "don't touch this setting" and "put it back to the default".
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `PUT /api/config/watchers` — writes the watcher settings and echoes them.
///
/// **Loopback-only in both modes**, like `update_config` and
/// `update_config_pricing`: it is the same file mesa's own argv comes out of,
/// and the section a write lands in is not the distinction that matters.
async fn update_config_watchers(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<WatchersUpdate>,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "editing the mesa config is loopback-only; connect from this machine",
    )?;
    let mut updates = HashMap::new();
    if let Some(value) = body.todo_concurrency {
        updates.insert(config::TODO_CONCURRENCY.to_string(), value);
    }
    config::save_watchers(&updates).map_err(|e| match e {
        config::SaveError::Validation(message) => ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message,
        },
        config::SaveError::Unavailable(message) => ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        },
    })?;
    get_config_watchers(State(state), ConnectInfo(addr), headers).await
}

async fn restart_server(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    state.restart_requested.store(true, Ordering::SeqCst);
    if let Some(tx) = state.shutdown_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(Json(json!({"restarting": true})).into_response())
}

/// Lists the live Claude Code sessions running under this project's
/// `local_path`. A project without one gets `{path: null, agents: []}` — the
/// UI explains how to link a folder rather than erroring on every poll.
async fn list_project_agents(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(path) = local_path else {
        return Ok(Json(ProjectAgents {
            path: None,
            agents: vec![],
        })
        .into_response());
    };
    // A recorded folder that no longer exists (checkout moved/deleted) has no
    // sessions under it. Return that plainly instead of 502-ing every 3s poll
    // when `claude agents --cwd <gone>` errors — the path is still surfaced so
    // the UI shows where it looked. `resolve` re-learns the path when the user
    // runs it in the moved checkout.
    if !std::path::Path::new(&path).is_dir() {
        return Ok(Json(ProjectAgents {
            path: Some(path),
            agents: vec![],
        })
        .into_response());
    }
    {
        let cache = state.agents_cache.lock().unwrap();
        if let Some((at, sessions)) = cache.get(&path)
            && at.elapsed() < AGENTS_TTL
        {
            return Ok(Json(ProjectAgents {
                path: Some(path.clone()),
                agents: sessions.clone(),
            })
            .into_response());
        }
    }
    // The list shells out to `claude` (blocking, ~0.5s); keep it off the
    // async worker threads. Snapshot the invalidation generation first: if a
    // spawn bumps it while our subprocess runs, our snapshot may predate the
    // new session, so we skip caching (serve it, but don't poison the cache).
    let gen0 = state.agents_gen.load(Ordering::SeqCst);
    let dir = path.clone();
    let sessions = tokio::task::spawn_blocking(move || agents::list_under(&dir))
        .await
        .map_err(|e| agents_unavailable(format!("agents list panicked: {e}")))?
        .map_err(agents_unavailable)?;
    if state.agents_gen.load(Ordering::SeqCst) == gen0 {
        let mut cache = state.agents_cache.lock().unwrap();
        // Keys are per-folder; a project that changes local_path leaves its
        // old key behind. Cap the map so those can't accumulate unbounded
        // (mirrors cc_cache).
        if cache.len() >= 64 {
            cache.retain(|_, (at, _)| at.elapsed() < AGENTS_TTL);
        }
        cache.insert(path.clone(), (Instant::now(), sessions.clone()));
    }
    Ok(Json(ProjectAgents {
        path: Some(path),
        agents: sessions,
    })
    .into_response())
}

/// Lists every live Claude Code session on the machine (no folder filter) —
/// backs the persistent Agents sidebar, which shows sessions across every
/// project at once. Bare array response, unlike the per-project route: there
/// is no single `local_path` to wrap it with an empty-state `path`.
async fn list_all_agents(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    {
        let cache = state.agents_cache.lock().unwrap();
        if let Some((at, sessions)) = cache.get(ALL_AGENTS_CACHE_KEY)
            && at.elapsed() < AGENTS_TTL
        {
            return Ok(Json(sessions.clone()).into_response());
        }
    }
    let gen0 = state.agents_gen.load(Ordering::SeqCst);
    let sessions = tokio::task::spawn_blocking(agents::list_all)
        .await
        .map_err(|e| agents_unavailable(format!("agents list panicked: {e}")))?
        .map_err(agents_unavailable)?;
    if state.agents_gen.load(Ordering::SeqCst) == gen0 {
        let mut cache = state.agents_cache.lock().unwrap();
        cache.insert(
            ALL_AGENTS_CACHE_KEY.to_string(),
            (Instant::now(), sessions.clone()),
        );
    }
    Ok(Json(sessions).into_response())
}

/// Starts a new background session (`claude --bg`) in the project's folder
/// and returns the short job id.
async fn spawn_project_agent(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Result<Json<AgentSpawnBody>, JsonRejection>,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let Json(body) = body?;
    let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
    let Some(path) = local_path else {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!(
                "project {id} has no local_path; run `mesa project resolve` in its repo \
                 or `mesa project update {id} --path <dir>`"
            ),
        });
    };
    if !std::path::Path::new(&path).is_dir() {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!("project {id} local_path {path:?} is not a directory on this machine"),
        });
    }
    let dir = path.clone();
    // `~/.mesa/config.json`'s `agent-spawn` entry, defaulting to
    // `claude --bg … -- <prompt>`. `job` is None when that command printed no
    // receipt — the session is still real (see `AgentSpawned`).
    let job = tokio::task::spawn_blocking(move || {
        agents::spawn_bg(
            config::AGENT_SPAWN,
            &dir,
            None,
            None,
            body.prompt.as_deref(),
        )
    })
    .await
    .map_err(|e| agents_unavailable(format!("agent spawn panicked: {e}")))?
    .map_err(agents_unavailable)?;
    // Drop the cached list so the next poll shows the new session immediately,
    // and bump the generation so a list request in flight since before this
    // spawn won't reinsert its pre-spawn snapshot over the invalidation.
    state.agents_cache.lock().unwrap().remove(&path);
    state.agents_gen.fetch_add(1, Ordering::SeqCst);
    Ok((StatusCode::CREATED, Json(AgentSpawned { id: job })).into_response())
}

/// Upgrades to a WebSocket bridged onto `claude attach <id>` in a PTY — the
/// embedded terminal. Closing the socket kills only the attach client; the
/// background session keeps running (claude's own attach/detach contract).
async fn attach_agent(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(q): Query<AttachQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    // The id lands on `claude attach`'s argv — no shell is involved, but
    // constrain it anyway so arbitrary strings never reach an exec. A leading
    // `-` is refused too, so the id can never be parsed as a `claude attach`
    // flag (the id charset otherwise allows `-`).
    if id.is_empty()
        || id.len() > 64
        || id.starts_with('-')
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!("invalid agent id {id:?}"),
        });
    }
    let size = PtySize {
        rows: q.rows.unwrap_or(40),
        cols: q.cols.unwrap_or(120),
        pixel_width: 0,
        pixel_height: 0,
    };
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(err) = bridge_attach(socket, id, size).await {
            eprintln!("agent attach bridge: {err}");
        }
    }))
}

/// Upgrades to a WebSocket bridged onto a real interactive shell in a PTY —
/// the Terminal page. Distinct from [`attach_agent`]: this spawns `$SHELL`
/// (falling back to `/bin/sh`) directly, never `claude attach`, and has no
/// session id — every connection is its own shell with no server-side
/// registry (see `.scratch/arch.md` §0). Gated by the exact same
/// [`require_agent_access`] used by the agent routes above (terminal access
/// = code execution either way); see that function's doc for the gate's
/// mode-branched behavior.
///
/// cwd is `$HOME` (the global Terminal page) unless `?project=<id>` is given
/// (the project Terminal tab), in which case it is that project's
/// `local_path` — resolved, and rejected, exactly as [`spawn_project_agent`]
/// resolves its own spawn folder: unknown id is `not_found`, unset or
/// non-directory `local_path` is `validation`. Both land as a failed
/// handshake before the upgrade, so no shell is ever spawned somewhere the
/// caller didn't ask for.
async fn terminal_attach(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<TerminalAttachQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    require_agent_access(&state, &addr, &headers)?;
    let cwd = match q.project {
        None => None,
        Some(id) => {
            let local_path = state.store.lock().unwrap().get_project(id)?.local_path;
            let Some(path) = local_path else {
                return Err(ApiError {
                    status: StatusCode::UNPROCESSABLE_ENTITY,
                    code: "validation",
                    message: format!(
                        "project {id} has no local_path; run `mesa project resolve` in its repo \
                         or `mesa project update {id} --path <dir>`"
                    ),
                });
            };
            if !std::path::Path::new(&path).is_dir() {
                return Err(ApiError {
                    status: StatusCode::UNPROCESSABLE_ENTITY,
                    code: "validation",
                    message: format!(
                        "project {id} local_path {path:?} is not a directory on this machine"
                    ),
                });
            }
            Some(path)
        }
    };
    let size = PtySize {
        rows: q.rows.unwrap_or(40),
        cols: q.cols.unwrap_or(120),
        pixel_width: 0,
        pixel_height: 0,
    };
    Ok(ws.on_upgrade(move |socket| async move {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        match cwd {
            Some(path) => cmd.cwd(path),
            None => {
                if let Some(dirs) = directories::BaseDirs::new() {
                    cmd.cwd(dirs.home_dir());
                }
            }
        }
        if let Err(err) = pump_pty(socket, cmd, size).await {
            eprintln!("terminal attach: {err}");
        }
    }))
}

/// Client→server text frames carry JSON control; today that is only
/// `{"resize": {"cols": N, "rows": N}}`. Binary frames are keystrokes.
#[derive(Deserialize)]
struct AttachControl {
    #[serde(default)]
    resize: Option<AttachResize>,
}

#[derive(Deserialize)]
struct AttachResize {
    cols: u16,
    rows: u16,
}

/// Runs `claude attach <id>` inside a PTY and pumps bytes between it and the
/// WebSocket: server→client binary frames are raw terminal output;
/// client→server binary frames are keystrokes, text frames are control (see
/// [`AttachControl`]). Returns when either side closes; the attach child is
/// killed on the way out (the background session survives — verified claude
/// behavior: "The session keeps running either way").
async fn bridge_attach(socket: WebSocket, id: String, size: PtySize) -> Result<(), String> {
    let mut cmd = CommandBuilder::new(agents::claude_bin());
    cmd.args(["attach", &id]);
    cmd.env("TERM", "xterm-256color");
    // Give the child a stable cwd: attach resolves the job from claude's
    // global registry, and the server's own cwd may be anywhere.
    if let Some(dirs) = directories::BaseDirs::new() {
        cmd.cwd(dirs.home_dir());
    }
    pump_pty(socket, cmd, size).await
}

/// Spawns `cmd` inside a PTY of `size` and pumps bytes between it and the
/// WebSocket: server→client binary frames are raw terminal output;
/// client→server binary frames are keystrokes, text frames are control (see
/// [`AttachControl`]). Returns when either side closes; the child is killed
/// on the way out. Shared by [`bridge_attach`] (`claude attach <id>`) and the
/// Terminal page's raw-shell endpoint (`terminal_attach`) — both need
/// identical wire protocol, keepalive, resize, and kill-on-close semantics,
/// differing only in which command they spawn.
async fn pump_pty(mut socket: WebSocket, cmd: CommandBuilder, size: PtySize) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty.openpty(size).map_err(|e| format!("openpty: {e}"))?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn pty command: {e}"))?;
    drop(pair.slave);
    let master = pair.master;
    // Once the child is spawned, every error path must reap it — dropping the
    // master SIGHUPs the child but nothing else waits on it, so a bare return
    // would leave a zombie in the long-lived server process. These two calls
    // are dup(2)-backed and fail exactly under fd exhaustion, when a leak
    // would compound the problem.
    let reap = |mut child: Box<dyn portable_pty::Child + Send + Sync>, msg: String| {
        let _ = child.kill();
        let _ = child.wait();
        msg
    };
    let mut reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return Err(reap(child, format!("pty reader: {e}"))),
    };
    let mut writer = match master.take_writer() {
        Ok(w) => w,
        Err(e) => return Err(reap(child, format!("pty writer: {e}"))),
    };

    // Output pump: blocking PTY reads on a plain thread, handed to the async
    // loop over a bounded channel (a stalled websocket applies backpressure).
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    // Keystroke pump: blocking PTY writes on their own thread.
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = in_rx.recv() {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    // Keepalive: a half-open peer (killed tab, laptop sleep, yanked network)
    // sends no Close frame, and an idle PTY sends no output, so neither pump
    // arm would ever fire — the child + PTY + pump threads would leak for the
    // OS connection lifetime. Ping periodically and give up if nothing is
    // heard back for a few intervals (the browser auto-answers a Ping with a
    // Pong, which lands in the `socket.recv` arm and refreshes `last_seen`).
    let mut keepalive = tokio::time::interval(Duration::from_secs(30));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            chunk = out_rx.recv() => match chunk {
                Some(bytes) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                // PTY closed: the attach client exited (e.g. `claude stop`).
                None => break,
            },
            msg = socket.recv() => {
                // Any inbound frame (including a Pong) proves the peer is live.
                if matches!(msg, Some(Ok(_))) {
                    last_seen = Instant::now();
                }
                match msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        if in_tx.send(bytes.to_vec()).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ctl) = serde_json::from_str::<AttachControl>(&text)
                            && let Some(r) = ctl.resize
                        {
                            let _ = master.resize(PtySize {
                                rows: r.rows,
                                cols: r.cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {} // ping/pong: axum answers pings itself
                }
            }
            _ = keepalive.tick() => {
                if last_seen.elapsed() > Duration::from_secs(90)
                    || socket.send(Message::Ping(Vec::new().into())).await.is_err()
                {
                    break;
                }
            }
        }
    }
    // Detach: kill our attach client and reap it off the async threads. The
    // background session itself is untouched.
    tokio::task::spawn_blocking(move || {
        let _ = child.kill();
        let _ = child.wait();
    });
    Ok(())
}

// ---- CC Dashboard (Claude Code telemetry) ----

#[derive(Deserialize)]
struct CcQuery {
    /// `7d` | `30d` | `90d` | `all` | `<n>d`; defaults to `30d`.
    #[serde(default)]
    window: Option<String>,
}

/// Returns the CC telemetry dashboard for the requested window. Every request
/// first ingests new transcript lines (`cc::sync`), then serves from an
/// in-memory cache keyed by the db-derived `cc_stamp` — persisted row counts,
/// not file mtimes — so an ingest by another process (CLI sync, cron)
/// invalidates it, while deleting a transcript file (which must not drop
/// history from the view) does not.
async fn get_cc_dashboard(
    State(state): State<AppState>,
    Query(q): Query<CcQuery>,
) -> ApiResult<Response> {
    let window = q.window.unwrap_or_else(|| "30d".to_string());
    let stamp = {
        let mut store = state.store.lock().unwrap();
        crate::core::cc::sync(&mut store, false)?;
        store.cc_stamp()?
    };
    {
        let cache = state.cc_cache.lock().unwrap();
        if let Some((cached, dash)) = cache.get(&window)
            && *cached == stamp
        {
            return Ok(Json(dash.clone()).into_response());
        }
    }
    let mut dash = {
        let store = state.store.lock().unwrap();
        crate::core::cc::collect(&store, &window)?
    };
    // `collect` returns every session; the web payload is bounded (the true
    // total stays in `overview.sessions`).
    dash.sessions.truncate(crate::core::cc::MAX_SESSION_ROWS);
    {
        let mut cache = state.cc_cache.lock().unwrap();
        // `window` is arbitrary caller input (`<n>d`); cap the distinct-key
        // count so the cache can't grow without bound.
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(window, (stamp, dash.clone()));
    }
    Ok(Json(dash).into_response())
}

/// `POST /api/cc/reset` — purge the stored cc_* telemetry and re-ingest every
/// transcript still on disk, echoing the `CcSyncReport` (`cc::reset_and_sync`,
/// the same code path as `mesa cc reset`). The corrective counterpart to
/// `sync --rebuild`; the Settings page's confirmed operator action.
///
/// **Loopback-only in both modes**, like `update_config`: it destroys stored
/// history (a session whose transcript file is gone cannot come back), which
/// is not a capability a LAN peer gets from `--lan`'s "trust the LAN" opt-in.
/// Being a mutation it also sits inside the Content-Type gate.
///
/// No explicit cache invalidation: both CC caches are keyed by
/// `Store::cc_stamp`, and the purge moves it (see that fn's doc on why it is
/// still a sound key once it can go down).
async fn reset_cc_index(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_local_path_write(
        &state,
        &addr,
        &headers,
        "resetting the CC index is loopback-only; connect from this machine",
    )?;
    let report = {
        let mut store = state.store.lock().unwrap();
        crate::core::cc::reset_and_sync(&mut store)?
    };
    Ok(Json(report).into_response())
}

#[derive(Deserialize)]
struct CcGraphQuery {
    /// Cap on tool nodes; defaults to `cc::GRAPH_NODE_LIMIT`.
    #[serde(default)]
    limit: Option<usize>,
}

/// Returns one session's call tree (`CcSessionGraph`). Syncs first like the
/// dashboard read, but is **not** cached: it is a single-session drill-down
/// opened on demand, not a hot poll, and the per-session queries are indexed.
/// An unknown/never-ingested session is `not_found` (404), never an empty
/// graph — an empty tree is a real answer for a session that made no calls.
async fn get_cc_session_graph(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(q): Query<CcGraphQuery>,
) -> ApiResult<Response> {
    // Clamp: `limit` is arbitrary caller input, and the cost of a graph is
    // linear in the nodes it serializes.
    let limit = q
        .limit
        .unwrap_or(crate::core::cc::GRAPH_NODE_LIMIT)
        .min(5_000);
    let graph = {
        let mut store = state.store.lock().unwrap();
        crate::core::cc::sync(&mut store, false)?;
        crate::core::cc::session_graph(&store, &session_id, limit)?
    };
    match graph {
        Some(g) => Ok(Json(g).into_response()),
        None => Err(Error::NotFound(format!("no ingested session {session_id}")).into()),
    }
}

/// Returns one session's aggregate detail (`CcSessionDetail`) — the default
/// drill-down from the sessions table. Same shape as `get_cc_session_graph`:
/// syncs first, **not** cached (an on-demand drill-down, not a poll), unknown
/// session is `not_found` (404). No query parameters — the aggregates are
/// exact and unwindowed by construction.
async fn get_cc_session_detail(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<Response> {
    let detail = {
        let mut store = state.store.lock().unwrap();
        crate::core::cc::sync(&mut store, false)?;
        crate::core::cc::session_detail(&store, &session_id)?
    };
    match detail {
        Some(d) => Ok(Json(d).into_response()),
        None => Err(Error::NotFound(format!("no ingested session {session_id}")).into()),
    }
}

/// Project-scoped CC Dashboard: same `CcDashboard` shape as `get_cc_dashboard`,
/// filtered to sessions whose `cwd` matches this project's `local_path`
/// (`cc::collect_for_project`). Mirrors `project_git_view`'s precedent of
/// resolving the project first, so an unknown id surfaces `not_found` before
/// any sync/collect work — but only a 2-rung empty-state ladder is needed
/// here (unlike the git tab's 3), since this never touches the filesystem:
/// no `local_path`, or one that matches zero sessions, both fall out of
/// `collect_for_project` as an ordinary zero-valued dashboard, never an
/// error.
async fn get_project_cc_dashboard(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<CcQuery>,
) -> ApiResult<Response> {
    let window = q.window.unwrap_or_else(|| "30d".to_string());
    let local_path = {
        let store = state.store.lock().unwrap();
        store.get_project(id)?.local_path // unknown id -> not_found here
    };
    let stamp = {
        let mut store = state.store.lock().unwrap();
        crate::core::cc::sync(&mut store, false)?;
        store.cc_stamp()?
    };
    let key = (id, window.clone());
    {
        let cache = state.project_cc_cache.lock().unwrap();
        if let Some((cached, dash)) = cache.get(&key)
            && *cached == stamp
        {
            return Ok(Json(dash.clone()).into_response());
        }
    }
    let mut dash = {
        let store = state.store.lock().unwrap();
        crate::core::cc::collect_for_project(&store, &window, local_path.as_deref())?
    };
    dash.sessions.truncate(crate::core::cc::MAX_SESSION_ROWS);
    {
        let mut cache = state.project_cc_cache.lock().unwrap();
        // `window` is arbitrary caller input and `id` ranges over every
        // project; cap the distinct-key count (sized up from cc_cache's 16
        // for the added project_id dimension) so the cache can't grow
        // without bound.
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (stamp, dash.clone()));
    }
    Ok(Json(dash).into_response())
}

#[derive(Deserialize)]
struct CcLiveQuery {
    /// Recency window in minutes; defaults to `cc::DEFAULT_LIVE_MINUTES`.
    #[serde(default)]
    minutes: Option<i64>,
}

/// Returns the currently-running sessions. Computed fresh each call (it only
/// parses recently-modified transcripts) so the UI can poll it on a short
/// interval; no cache. Read-only, so the Content-Type gate doesn't apply.
async fn get_cc_live(Query(q): Query<CcLiveQuery>) -> ApiResult<Response> {
    let minutes = q.minutes.unwrap_or(crate::core::cc::DEFAULT_LIVE_MINUTES);
    Ok(Json(crate::core::cc::live(minutes)).into_response())
}

/// How long a fetched usage snapshot is reused before re-fetching from Anthropic.
const USAGE_TTL_SECS: i64 = 60;

/// Returns live Claude Code subscription usage (plan limits + reset times),
/// fetched from Anthropic's usage endpoint and cached for [`USAGE_TTL_SECS`] so
/// polling the UI doesn't hammer it. Read-only, so the Content-Type gate doesn't
/// apply. When the token is missing or the upstream is unreachable, responds
/// `502 {"error": {"code": "unavailable", ...}}`.
async fn get_cc_usage(State(state): State<AppState>) -> ApiResult<Response> {
    let now = unix_secs();
    let cached = state.usage_cache.lock().unwrap().clone();
    match cached {
        // Fresh: serve straight from cache.
        Some((at, usage)) if now - at < USAGE_TTL_SECS => Ok(Json(usage).into_response()),
        // Stale-but-present: serve stale immediately and refresh behind it, so
        // the client never waits and N concurrent polls cause at most one
        // outbound call (the `swap` admits a single background refresh).
        Some((_, stale)) => {
            if !state.usage_refreshing.swap(true, Ordering::SeqCst) {
                let state = state.clone();
                tokio::spawn(async move {
                    // Reset the flag on the way out — including via panic
                    // unwind (e.g. a poisoned cache mutex), so a single failed
                    // refresh can't disable all future ones.
                    let _reset = ResetOnDrop(&state.usage_refreshing);
                    let _ = refresh_usage(&state).await;
                });
            }
            Ok(Json(stale).into_response())
        }
        // Cold (no cache yet): fetch synchronously, single-flighted so a burst
        // of first-time requests still makes one upstream call.
        None => Ok(Json(refresh_usage(&state).await?).into_response()),
    }
}

/// Clears the `usage_refreshing` flag when dropped, so the background-refresh
/// slot is freed even if the refresh task panics mid-flight.
struct ResetOnDrop<'a>(&'a AtomicBool);

impl Drop for ResetOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Fetches live usage from Anthropic and updates the cache, serializing the
/// blocking `curl` behind `usage_lock` so concurrent callers collapse to one
/// outbound call. Waiters re-check the cache after acquiring the lock and
/// return the just-fetched value without hitting the network again.
async fn refresh_usage(state: &AppState) -> Result<CcUsage, ApiError> {
    let _guard = state.usage_lock.lock().await;
    // A peer may have refreshed while we waited for the lock.
    let now = unix_secs();
    if let Some((at, usage)) = state.usage_cache.lock().unwrap().as_ref()
        && now - *at < USAGE_TTL_SECS
    {
        return Ok(usage.clone());
    }
    // The fetch shells out to `curl` (blocking, up to 10s); keep it off the async
    // worker thread.
    let usage = tokio::task::spawn_blocking(crate::core::usage::fetch)
        .await
        .map_err(|e| ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "conflict",
            message: format!("usage fetch panicked: {e}"),
        })?
        .map_err(|message| ApiError {
            status: StatusCode::BAD_GATEWAY,
            code: "unavailable",
            message,
        })?;
    *state.usage_cache.lock().unwrap() = Some((unix_secs(), usage.clone()));
    Ok(usage)
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    //! Mostly the `--lan` agent-access gate. Those are peer-address-sensitive,
    //! which `scripts/agents-check.sh` cannot exercise (a same-machine curl is
    //! always a loopback peer), so the cross-origin-attach hole lives or dies
    //! here. Plus the request-body shapes whose absent/null/value distinction
    //! no shell check can see.
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn hdrs(host: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(v) = host {
            h.insert(header::HOST, v.parse().unwrap());
        }
        if let Some(v) = origin {
            h.insert(header::ORIGIN, v.parse().unwrap());
        }
        h
    }
    fn loopback() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 55555)
    }
    fn lan_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 55555)
    }

    #[test]
    fn lan_host_accepts_localhost_and_ip_literals_on_our_port() {
        assert!(require_lan_agent_host(&hdrs(Some("localhost:7770"), None), 7770).is_ok());
        assert!(require_lan_agent_host(&hdrs(Some("192.168.1.50:7770"), None), 7770).is_ok());
        assert!(require_lan_agent_host(&hdrs(Some("[::1]:7770"), None), 7770).is_ok());
    }

    #[test]
    fn lan_host_rejects_dns_names_and_foreign_ports() {
        // A DNS-name Host is the only shape a rebinding page can send.
        assert!(require_lan_agent_host(&hdrs(Some("evil.example"), None), 7770).is_err());
        assert!(require_lan_agent_host(&hdrs(Some("evil.example:7770"), None), 7770).is_err());
        assert!(require_lan_agent_host(&hdrs(Some("192.168.1.50:999"), None), 7770).is_err());
    }

    #[test]
    fn lan_host_port_80_accepts_portless_forms_but_not_dns_names() {
        assert!(require_lan_agent_host(&hdrs(Some("localhost"), None), 80).is_ok());
        assert!(require_lan_agent_host(&hdrs(Some("192.168.1.50"), None), 80).is_ok());
        assert!(require_lan_agent_host(&hdrs(Some("[::1]"), None), 80).is_ok());
        assert!(require_lan_agent_host(&hdrs(Some("evil.example"), None), 80).is_err());
    }

    #[test]
    fn origin_absent_passes() {
        let h = hdrs(Some("192.168.1.50:7770"), None);
        assert!(require_origin_matches_host(&lan_peer(), &h).is_ok());
    }

    #[test]
    fn legit_remote_page_origin_equals_host_passes() {
        let h = hdrs(Some("192.168.1.50:7770"), Some("http://192.168.1.50:7770"));
        assert!(require_origin_matches_host(&lan_peer(), &h).is_ok());
    }

    #[test]
    fn local_origin_bypass_honored_only_from_loopback_peer() {
        // vite dev proxy: localhost:5173 Origin, loopback peer → allowed.
        let h = hdrs(Some("127.0.0.1:7770"), Some("http://localhost:5173"));
        assert!(require_origin_matches_host(&loopback(), &h).is_ok());
    }

    #[test]
    fn cross_origin_attach_from_remote_peer_is_refused() {
        // THE hole this test guards: a remote browser showing a hostile
        // localhost:* page, addressing the server by IP. Must NOT pass.
        let h = hdrs(Some("192.168.1.50:7770"), Some("http://localhost:3000"));
        assert!(require_origin_matches_host(&lan_peer(), &h).is_err());
        assert!(require_lan_page_access(&lan_peer(), &h, 7770).is_err());
    }

    #[test]
    fn foreign_origin_refused_from_either_peer() {
        let h = hdrs(Some("192.168.1.50:7770"), Some("https://evil.example"));
        assert!(require_origin_matches_host(&lan_peer(), &h).is_err());
        assert!(require_origin_matches_host(&loopback(), &h).is_err());
    }

    #[test]
    fn lan_page_access_allows_legit_remote_and_local_pages() {
        let remote = hdrs(Some("192.168.1.50:7770"), Some("http://192.168.1.50:7770"));
        assert!(require_lan_page_access(&lan_peer(), &remote, 7770).is_ok());
        let dev = hdrs(Some("127.0.0.1:7770"), Some("http://localhost:5173"));
        assert!(require_lan_page_access(&loopback(), &dev, 7770).is_ok());
    }

    // --- Files tab: GET /files and /files/content (mesa task 279) ---------

    /// A fresh AppState over a tempdir-backed store, isolated per test. The
    /// backing `TempDir` is returned alongside so it stays alive (and the db
    /// file with it) for the test's duration.
    fn test_state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let state = AppState {
            store: Arc::new(Mutex::new(store)),
            port: 0,
            lan: false,
            cc_cache: Arc::new(Mutex::new(HashMap::new())),
            project_cc_cache: Arc::new(Mutex::new(HashMap::new())),
            usage_cache: Arc::new(Mutex::new(None)),
            usage_lock: Arc::new(tokio::sync::Mutex::new(())),
            usage_refreshing: Arc::new(AtomicBool::new(false)),
            agents_cache: Arc::new(Mutex::new(HashMap::new())),
            agents_gen: Arc::new(AtomicU64::new(0)),
            git_cache: Arc::new(Mutex::new(HashMap::new())),
            git_view_cache: Arc::new(Mutex::new(HashMap::new())),
            git_worktrees_cache: Arc::new(Mutex::new(HashMap::new())),
            git_log_cache: Arc::new(Mutex::new(HashMap::new())),
            git_commit_files_cache: Arc::new(Mutex::new(HashMap::new())),
            git_file_log_cache: Arc::new(Mutex::new(HashMap::new())),
            files_tree_cache: Arc::new(Mutex::new(HashMap::new())),
            restart_requested: Arc::new(AtomicBool::new(false)),
            shutdown_tx: Arc::new(Mutex::new(None)),
            inbox_dispatched: Arc::new(Mutex::new(std::collections::HashSet::new())),
            refine_dispatched: Arc::new(Mutex::new(std::collections::HashSet::new())),
        };
        (dir, state)
    }

    fn new_project(state: &AppState, local_path: Option<&str>) -> i64 {
        state
            .store
            .lock()
            .unwrap()
            .create_project("proj", None, None, local_path, None)
            .unwrap()
            .id
    }

    async fn json_body(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn no_path_query() -> Query<FilesTreeQuery> {
        Query(FilesTreeQuery { path: None })
    }

    fn path_query(path: &str) -> Query<FilesTreeQuery> {
        Query(FilesTreeQuery {
            path: Some(path.to_string()),
        })
    }

    #[tokio::test]
    async fn files_no_local_path_is_null_tree() {
        let (_dir, state) = test_state();
        let id = new_project(&state, None);
        let resp = get_project_files(State(state), Path(id), no_path_query())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], serde_json::Value::Null);
        assert_eq!(body["tree"], serde_json::Value::Null);
        assert_eq!(body["truncated"], false);
    }

    #[tokio::test]
    async fn files_dead_folder_has_path_but_null_tree() {
        let (dir, state) = test_state();
        let gone = dir.path().join("gone").to_str().unwrap().to_string();
        let id = new_project(&state, Some(&gone));
        let resp = get_project_files(State(state), Path(id), no_path_query())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], serde_json::json!(gone));
        assert_eq!(body["tree"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn files_live_folder_returns_top_level_only() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        std::fs::write(root.join("sub/b.rs"), "fn main() {}").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = get_project_files(State(state.clone()), Path(id), no_path_query())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], serde_json::json!(root_str));
        assert_eq!(body["truncated"], false);
        let tree = body["tree"].as_array().unwrap();
        let names: Vec<&str> = tree.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"sub"));
        assert!(names.contains(&"a.txt"));
        let sub = tree.iter().find(|e| e["name"] == "sub").unwrap();
        assert_eq!(sub["is_dir"], true);
        // The root call is one level only — a deeper file's contents don't
        // ride along, unlike the old whole-tree walk.
        assert!(sub.get("children").is_none());

        // The subdirectory's own contents are a separate, `?path=`-scoped
        // call — this is the lazy-expand contract.
        let resp = get_project_files(State(state), Path(id), path_query("sub"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        let tree = body["tree"].as_array().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0]["path"], "sub/b.rs");
    }

    #[tokio::test]
    async fn files_path_query_truncates_per_directory() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("many")).unwrap();
        // MAX_TREE_ENTRIES (src/core/files.rs) is 2_000; a bit over that in
        // one flat directory exercises the per-directory truncation.
        for i in 0..2_005 {
            std::fs::write(root.join("many").join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = get_project_files(State(state), Path(id), path_query("many"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["truncated"], true);
    }

    #[tokio::test]
    async fn files_path_query_traversal_is_not_found() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let err = get_project_files(State(state), Path(id), path_query("../"))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);
        assert_eq!(err.code, "not_found");
    }

    #[tokio::test]
    async fn files_content_reads_normal_file() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = get_project_files_content(
            State(state),
            Path(id),
            Query(FilesContentQuery {
                path: Some("main.rs".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], "main.rs");
        assert_eq!(body["is_binary"], false);
        assert_eq!(body["content"], "fn main() {}\n");
        assert_eq!(body["language"], "rust");
    }

    #[tokio::test]
    async fn files_content_missing_query_is_validation_error() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let err = get_project_files_content(
            State(state),
            Path(id),
            Query(FilesContentQuery { path: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "validation");
    }

    #[tokio::test]
    async fn files_content_traversal_and_bad_paths_are_not_found() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        for bad in [
            "../secret.txt",
            "/etc/passwd",
            "nope.txt",
            "sub", // a directory, not a file
        ] {
            let resp = get_project_files_content(
                State(state.clone()),
                Path(id),
                Query(FilesContentQuery {
                    path: Some(bad.to_string()),
                }),
            )
            .await;
            let err = resp.unwrap_err();
            assert_eq!(err.status, StatusCode::NOT_FOUND, "path {bad:?}");
            assert_eq!(err.code, "not_found", "path {bad:?}");
        }
    }

    #[tokio::test]
    async fn files_content_no_local_path_or_dead_folder_is_not_found() {
        let (dir, state) = test_state();
        let no_path_project = new_project(&state, None);
        let resp = get_project_files_content(
            State(state.clone()),
            Path(no_path_project),
            Query(FilesContentQuery {
                path: Some("a.txt".to_string()),
            }),
        )
        .await;
        assert_eq!(resp.unwrap_err().status, StatusCode::NOT_FOUND);

        let gone = dir.path().join("gone").to_str().unwrap().to_string();
        let dead_project = new_project(&state, Some(&gone));
        let resp = get_project_files_content(
            State(state),
            Path(dead_project),
            Query(FilesContentQuery {
                path: Some("a.txt".to_string()),
            }),
        )
        .await;
        assert_eq!(resp.unwrap_err().status, StatusCode::NOT_FOUND);
    }

    // --- Files tab: GET /files/download (mesa task 683) --------------------

    async fn body_bytes(resp: Response) -> Vec<u8> {
        axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn files_download_serves_raw_bytes_as_an_attachment() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a];
        std::fs::write(root.join("src/img.png"), &raw).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = download_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery {
                path: Some("src/img.png".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        // Fixed octet-stream — never sniffed, never the extension's type.
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/octet-stream"
        );
        let disp = resp
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(disp.starts_with("attachment; "), "{disp}");
        // The basename, not the `rel` that was requested.
        assert!(disp.contains("filename=\"img.png\""), "{disp}");
        assert_eq!(body_bytes(resp).await, raw);
    }

    #[tokio::test]
    async fn files_download_serves_a_truncated_file_whole() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let big = "a".repeat(300 * 1024);
        std::fs::write(root.join("big.txt"), &big).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        // The view route caps it...
        let view = get_project_files_content(
            State(state.clone()),
            Path(id),
            Query(FilesContentQuery {
                path: Some("big.txt".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(json_body(view).await["truncated"], true);

        // ...the download route does not.
        let resp = download_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery {
                path: Some("big.txt".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(body_bytes(resp).await.len(), big.len());
    }

    #[tokio::test]
    async fn files_download_missing_query_is_validation_error() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let err = download_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery { path: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "validation");
    }

    #[tokio::test]
    async fn files_download_traversal_and_bad_paths_are_not_found() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        for bad in ["../secret.txt", "/etc/passwd", "nope.txt", "sub"] {
            let err = download_project_file(
                State(state.clone()),
                Path(id),
                Query(FilesContentQuery {
                    path: Some(bad.to_string()),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, StatusCode::NOT_FOUND, "path {bad:?}");
            assert_eq!(err.code, "not_found", "path {bad:?}");
        }
    }

    #[tokio::test]
    async fn files_download_no_local_path_or_dead_folder_is_not_found() {
        let (dir, state) = test_state();
        let no_path_project = new_project(&state, None);
        let err = download_project_file(
            State(state.clone()),
            Path(no_path_project),
            Query(FilesContentQuery {
                path: Some("a.txt".to_string()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);

        let gone = dir.path().join("gone").to_str().unwrap().to_string();
        let dead_project = new_project(&state, Some(&gone));
        let err = download_project_file(
            State(state),
            Path(dead_project),
            Query(FilesContentQuery {
                path: Some("a.txt".to_string()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);
    }

    // --- Files tab: GET /files/raw (mesa task 801) -------------------------

    fn header_str(resp: &Response, name: header::HeaderName) -> String {
        resp.headers()
            .get(name)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn files_raw_serves_an_image_inline_with_its_type_and_hardening_headers() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a];
        std::fs::write(root.join("src/img.png"), &raw).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = raw_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery {
                path: Some("src/img.png".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(header_str(&resp, header::CONTENT_TYPE), "image/png");
        let disp = header_str(&resp, header::CONTENT_DISPOSITION);
        assert!(disp.starts_with("inline; "), "{disp}");
        assert!(disp.contains("filename=\"img.png\""), "{disp}");
        assert!(disp.contains("filename*=UTF-8''img.png"), "{disp}");
        assert_eq!(header_str(&resp, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
        assert_eq!(
            header_str(&resp, header::CONTENT_SECURITY_POLICY),
            "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        );
        assert_eq!(body_bytes(resp).await, raw);
    }

    #[tokio::test]
    async fn files_raw_refuses_anything_off_the_image_allowlist() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        // Both exist and are readable — only the extension decides.
        std::fs::write(root.join("page.html"), "<script>alert(1)</script>").unwrap();
        std::fs::write(root.join("LICENSE"), "text").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        for bad in ["page.html", "LICENSE"] {
            let err = raw_project_file(
                State(state.clone()),
                Path(id),
                Query(FilesContentQuery {
                    path: Some(bad.to_string()),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY, "path {bad:?}");
            assert_eq!(err.code, "validation", "path {bad:?}");
        }
    }

    #[tokio::test]
    async fn files_raw_traversal_is_not_found() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.png"), "top secret").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        // Both an image-extensioned escape and a plain one: `safe_path` runs
        // before the allowlist, so neither leaks a 422 "wrong extension".
        for bad in [
            "../../etc/passwd.png",
            "/etc/passwd.png",
            "../secret.png",
            "../../etc/passwd",
            "/etc/passwd",
        ] {
            let err = raw_project_file(
                State(state.clone()),
                Path(id),
                Query(FilesContentQuery {
                    path: Some(bad.to_string()),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, StatusCode::NOT_FOUND, "path {bad:?}");
            assert_eq!(err.code, "not_found", "path {bad:?}");
        }
    }

    #[tokio::test]
    async fn files_raw_missing_query_is_validation_error() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let err = raw_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery { path: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "validation");
    }

    /// The new route must not have relaxed the old one: `/files/download`
    /// still hands back every file as an opaque attachment, image or not.
    #[tokio::test]
    async fn files_download_still_serves_an_image_as_an_octet_stream_attachment() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("img.png"), [0x89u8, 0x50]).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = download_project_file(
            State(state),
            Path(id),
            Query(FilesContentQuery {
                path: Some("img.png".to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            header_str(&resp, header::CONTENT_TYPE),
            "application/octet-stream"
        );
        assert!(
            header_str(&resp, header::CONTENT_DISPOSITION).starts_with("attachment; "),
            "download must stay an attachment"
        );
    }

    // --- Files tab: PATCH /files/content (mesa task 327) -------------------

    /// Default-mode `require_agent_access` headers a real loopback browser
    /// request would send: Host matches `test_state()`'s port 0, no Origin
    /// (same-origin GETs/PATCHes from the embedded UI carry none).
    fn loopback_agent_headers() -> HeaderMap {
        hdrs(Some("localhost:0"), None)
    }

    #[tokio::test]
    async fn update_files_content_edits_and_returns_fresh_view() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = update_project_files_content(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentUpdate {
                path: "main.rs".to_string(),
                content: "fn main() { edited(); }\n".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["content"], "fn main() { edited(); }\n");
        assert_eq!(
            std::fs::read_to_string(root.join("main.rs")).unwrap(),
            "fn main() { edited(); }\n"
        );
    }

    #[tokio::test]
    async fn update_files_content_rejects_non_loopback_peer_in_default_mode() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = update_project_files_content(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentUpdate {
                path: "a.txt".to_string(),
                content: "pwned".to_string(),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hi",
            "rejected write must never touch disk"
        );
    }

    #[tokio::test]
    async fn update_files_content_traversal_binary_and_missing_are_rejected() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        std::fs::write(root.join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        for (bad_path, expect_status) in [
            ("../secret.txt", StatusCode::NOT_FOUND),
            ("nope.txt", StatusCode::NOT_FOUND),
            ("img.png", StatusCode::UNPROCESSABLE_ENTITY),
        ] {
            let resp = update_project_files_content(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Path(id),
                Json(FilesContentUpdate {
                    path: bad_path.to_string(),
                    content: "x".to_string(),
                }),
            )
            .await;
            let err = resp.unwrap_err();
            assert_eq!(err.status, expect_status, "path {bad_path:?}");
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("secret.txt")).unwrap(),
            "top secret"
        );
    }

    #[tokio::test]
    async fn update_files_content_no_local_path_is_not_found() {
        let (_dir, state) = test_state();
        let id = new_project(&state, None);
        let resp = update_project_files_content(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentUpdate {
                path: "a.txt".to_string(),
                content: "x".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.unwrap_err().status, StatusCode::NOT_FOUND);
    }

    // --- Files tab: POST /files/content (mesa task 672) ---------------------

    #[tokio::test]
    async fn create_project_file_makes_an_empty_file_and_echoes_its_view() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = create_project_file(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentCreate {
                path: "src/new.rs".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], "src/new.rs");
        assert_eq!(body["content"], "");
        assert_eq!(body["language"], "rust");
        assert_eq!(body["is_binary"], false);
        assert_eq!(
            std::fs::read_to_string(root.join("src/new.rs")).unwrap(),
            ""
        );
    }

    /// The 5s tree cache must not outlive the create — a client refetching the
    /// level it just created into has to see the new file, not a stale entry.
    #[tokio::test]
    async fn create_project_file_evicts_the_tree_cache_for_its_directory() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        // Warm both levels through the read route.
        for level in [None, Some("src".to_string())] {
            get_project_files(
                State(state.clone()),
                Path(id),
                Query(FilesTreeQuery { path: level }),
            )
            .await
            .unwrap();
        }
        assert_eq!(state.files_tree_cache.lock().unwrap().len(), 2);

        create_project_file(
            State(state.clone()),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentCreate {
                path: "src/new.rs".to_string(),
            }),
        )
        .await
        .unwrap();

        // Only the created file's own directory is evicted; the root entry
        // stays (nothing about it changed).
        {
            let cache = state.files_tree_cache.lock().unwrap();
            assert!(!cache.contains_key(&(root_str.clone(), "src".to_string())));
            assert!(cache.contains_key(&(root_str, String::new())));
        }

        let resp = get_project_files(
            State(state),
            Path(id),
            Query(FilesTreeQuery {
                path: Some("src".to_string()),
            }),
        )
        .await
        .unwrap();
        let body = json_body(resp).await;
        let names: Vec<&str> = body["tree"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["new.rs"]);
    }

    #[tokio::test]
    async fn create_project_file_maps_not_found_validation_and_conflict() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("taken.txt"), "keep me").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        for (bad_path, expect_status, expect_code) in [
            ("../escape.txt", StatusCode::NOT_FOUND, "not_found"),
            ("gone/x.txt", StatusCode::NOT_FOUND, "not_found"),
            ("taken.txt/x.txt", StatusCode::NOT_FOUND, "not_found"),
            ("", StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            ("..", StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            ("taken.txt", StatusCode::CONFLICT, "conflict"),
        ] {
            let err = create_project_file(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Path(id),
                Json(FilesContentCreate {
                    path: bad_path.to_string(),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, expect_status, "path {bad_path:?}");
            assert_eq!(err.code, expect_code, "path {bad_path:?}");
        }
        assert!(!dir.path().join("escape.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("taken.txt")).unwrap(),
            "keep me"
        );
    }

    #[tokio::test]
    async fn create_project_file_rejects_non_loopback_peer_in_default_mode() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = create_project_file(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentCreate {
                path: "pwned.sh".to_string(),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
        assert!(
            !root.join("pwned.sh").exists(),
            "rejected create must never touch disk"
        );
    }

    #[tokio::test]
    async fn create_project_file_no_local_path_is_not_found() {
        let (_dir, state) = test_state();
        let id = new_project(&state, None);
        let resp = create_project_file(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Json(FilesContentCreate {
                path: "a.txt".to_string(),
            }),
        )
        .await;
        assert_eq!(resp.unwrap_err().status, StatusCode::NOT_FOUND);
    }

    // --- fs/dirs: GET /api/fs/dirs (mesa task 405) --------------------------

    #[tokio::test]
    async fn fs_dirs_returns_listing_for_loopback_request() {
        let (dir, state) = test_state();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("sub_b")).unwrap();
        std::fs::create_dir_all(root.join("sub_a")).unwrap();
        std::fs::write(root.join("a_file.txt"), "x").unwrap();
        let root_str = root.to_str().unwrap().to_string();

        let resp = list_fs_dirs(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Query(FsDirsQuery {
                path: Some(root_str.clone()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        // Canonicalized, so compare against fs::canonicalize, not the raw
        // tempdir path (may differ on macOS's /private/tmp symlink).
        let canon_root = std::fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(body["path"], serde_json::json!(canon_root));
        let names: Vec<&str> = body["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        // Directories only, alphabetically sorted; the file is excluded.
        assert_eq!(names, vec!["sub_a", "sub_b"]);
    }

    #[tokio::test]
    async fn fs_dirs_defaults_to_home_dir_when_path_omitted() {
        let (_dir, state) = test_state();
        let resp = list_fs_dirs(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Query(FsDirsQuery { path: None }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        let home = directories::BaseDirs::new()
            .unwrap()
            .home_dir()
            .to_string_lossy()
            .into_owned();
        let canon_home = std::fs::canonicalize(&home)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(body["path"], serde_json::json!(canon_home));
    }

    #[tokio::test]
    async fn fs_dirs_not_found_for_nonexistent_or_non_directory_path() {
        let (dir, state) = test_state();
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();

        for bad in [
            dir.path().join("nope").to_str().unwrap().to_string(),
            dir.path().join("a.txt").to_str().unwrap().to_string(),
        ] {
            let resp = list_fs_dirs(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Query(FsDirsQuery {
                    path: Some(bad.clone()),
                }),
            )
            .await;
            let err = resp.unwrap_err();
            assert_eq!(err.status, StatusCode::NOT_FOUND, "path {bad:?}");
            assert_eq!(err.code, "not_found", "path {bad:?}");
        }
    }

    #[tokio::test]
    async fn fs_dirs_rejects_non_loopback_peer_in_default_mode() {
        let (dir, state) = test_state();
        assert!(!state.lan);
        let resp = list_fs_dirs(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Query(FsDirsQuery {
                path: Some(dir.path().to_str().unwrap().to_string()),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    #[tokio::test]
    async fn fs_dirs_rejects_non_loopback_peer_under_lan_mode() {
        let (dir, mut state) = test_state();
        state.lan = true;
        // A Host/Origin pair that would satisfy `require_lan_page_access` on
        // its own — the loopback check must still reject this peer first,
        // proving the endpoint is loopback-only in BOTH modes, not just
        // default.
        let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
        let resp = list_fs_dirs(
            State(state),
            ConnectInfo(lan_peer()),
            headers,
            Query(FsDirsQuery {
                path: Some(dir.path().to_str().unwrap().to_string()),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    // --- Settings: /api/config (mesa task 654) ------------------------------
    //
    // The round trip (read, write, validate, fall back) is covered by
    // `core::config`'s unit tests and, over HTTP against a real `~/.mesa`, by
    // `scripts/config-check.sh`. What can only be asserted here is the gate:
    // both handlers must refuse before they ever touch the file, since
    // `config_file()` resolves off HOME and these tests share one process.

    #[tokio::test]
    async fn get_config_rejects_non_loopback_peer_in_default_mode() {
        let (_dir, state) = test_state();
        assert!(!state.lan);
        let resp = get_config(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    #[tokio::test]
    async fn update_config_rejects_non_loopback_peer_under_lan_mode() {
        let (_dir, mut state) = test_state();
        state.lan = true;
        // Host/Origin that `require_lan_page_access` would accept — a LAN peer
        // that under `--lan` may spawn an agent still must not get to choose
        // the program that spawn runs. Loopback-only in BOTH modes.
        let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
        let resp = update_config(
            State(state),
            ConnectInfo(lan_peer()),
            headers,
            Json(ConfigUpdate {
                commands: HashMap::from([(
                    config::TODO_WATCHER.to_string(),
                    "attacker-tool".to_string(),
                )]),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    // The pricing verbs share the config gates exactly — same file, same
    // capability class. Asserted separately because they are separate routes.

    #[tokio::test]
    async fn get_config_pricing_rejects_non_loopback_peer_in_default_mode() {
        let (_dir, state) = test_state();
        let resp = get_config_pricing(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    #[tokio::test]
    async fn update_config_pricing_rejects_non_loopback_peer_under_lan_mode() {
        let (_dir, mut state) = test_state();
        state.lan = true;
        let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
        let resp = update_config_pricing(
            State(state),
            ConnectInfo(lan_peer()),
            headers,
            Json(PricingUpdate {
                pricing: HashMap::from([(
                    "claude-opus".to_string(),
                    Some(ModelRates {
                        input: 0.0,
                        output: 0.0,
                        cache_read: 0.0,
                        cache_write: 0.0,
                    }),
                )]),
            }),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    // --- CC index reset: POST /api/cc/reset (mesa task 698) -----------------
    //
    // The gate is what matters here: the handler destroys stored history, so
    // it carries the config routes' loopback-only-in-BOTH-modes gate rather
    // than the plain guard the /api/cc reads use. What it *does* is covered by
    // `core::cc`'s tests and `scripts/cc-check.sh` against a synthetic tree.

    #[tokio::test]
    async fn reset_cc_index_rejects_non_loopback_peer_in_default_mode() {
        let (_dir, state) = test_state();
        assert!(!state.lan);
        let resp = reset_cc_index(
            State(state),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
        )
        .await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    #[tokio::test]
    async fn reset_cc_index_rejects_non_loopback_peer_under_lan_mode() {
        let (_dir, mut state) = test_state();
        state.lan = true;
        // Host/Origin `require_lan_page_access` would accept: a LAN peer that
        // under `--lan` may write tasks still must not get to wipe the index.
        let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
        let resp = reset_cc_index(State(state), ConnectInfo(lan_peer()), headers).await;
        assert!(resp.unwrap_err().status.is_client_error());
    }

    // --- fs/dirs: POST /api/fs/dirs (mesa task 489) -------------------------

    #[tokio::test]
    async fn create_fs_dir_makes_the_folder_and_echoes_a_listable_entry() {
        let (dir, state) = test_state();
        let root = dir.path().to_str().unwrap().to_string();

        let resp = create_fs_dir(
            State(state.clone()),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Json(FsDirCreate {
                path: root.clone(),
                name: "  new proj  ".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["name"], serde_json::json!("new proj"));
        assert!(dir.path().join("new proj").is_dir());
        // The echoed path is directly listable — the picker navigates into it
        // without a second round trip to resolve anything.
        let listed = list_fs_dirs(
            State(state),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Query(FsDirsQuery {
                path: Some(body["path"].as_str().unwrap().to_string()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn create_fs_dir_maps_core_errors_to_validation_conflict_and_not_found() {
        let (dir, state) = test_state();
        let root = dir.path().to_str().unwrap().to_string();
        std::fs::create_dir(dir.path().join("taken")).unwrap();

        let cases = [
            (
                root.clone(),
                "../escape",
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
            ),
            (
                root.clone(),
                "   ",
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
            ),
            (root.clone(), "taken", StatusCode::CONFLICT, "conflict"),
            (
                dir.path().join("gone").to_str().unwrap().to_string(),
                "x",
                StatusCode::NOT_FOUND,
                "not_found",
            ),
        ];
        for (path, name, status, code) in cases {
            let err = create_fs_dir(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Json(FsDirCreate {
                    path,
                    name: name.to_string(),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, status, "name {name:?}");
            assert_eq!(err.code, code, "name {name:?}");
        }
        // Nothing escaped the parent while those rejections happened.
        assert!(!dir.path().parent().unwrap().join("escape").exists());
    }

    /// The POST is gated exactly like the GET beside it: loopback-only in BOTH
    /// serve modes, so creating a directory is never reachable more widely
    /// than listing one.
    #[tokio::test]
    async fn create_fs_dir_rejects_non_loopback_peer_in_both_modes() {
        for lan in [false, true] {
            let (dir, mut state) = test_state();
            state.lan = lan;
            // A Host/Origin pair that would satisfy `require_lan_page_access`
            // on its own — the loopback check must still reject the peer.
            let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
            let err = create_fs_dir(
                State(state),
                ConnectInfo(lan_peer()),
                headers,
                Json(FsDirCreate {
                    path: dir.path().to_str().unwrap().to_string(),
                    name: "nope".to_string(),
                }),
            )
            .await
            .unwrap_err();
            assert!(err.status.is_client_error(), "lan={lan}");
            assert!(!dir.path().join("nope").exists(), "lan={lan}");
        }
    }

    // --- Locked edge anchors: three-state PATCH validation (mesa task 350) ---

    /// An invalid `AnchorSide` literal fails to deserialize `EdgeUpdate` at
    /// the serde boundary — the same mechanism that already maps an invalid
    /// `status`/`priority` literal to a 422 `validation` error via
    /// `impl From<JsonRejection> for ApiError` (see module docs). Once a
    /// value reaches `Store::update_edge`, it is already a valid `AnchorSide`;
    /// there is nothing left for a dedicated Store-level check to reject.
    #[test]
    fn edge_update_rejects_invalid_anchor_literal() {
        assert!(serde_json::from_str::<EdgeUpdate>(r#"{"from_anchor":"diagonal"}"#).is_err());
        assert!(serde_json::from_str::<EdgeUpdate>(r#"{"to_anchor":"diagonal"}"#).is_err());
        // Valid literals, null (unlock), and omission all still parse.
        assert!(serde_json::from_str::<EdgeUpdate>(r#"{"from_anchor":"top"}"#).is_ok());
        assert!(serde_json::from_str::<EdgeUpdate>(r#"{"to_anchor":null}"#).is_ok());
        assert!(serde_json::from_str::<EdgeUpdate>(r#"{}"#).is_ok());
    }

    // --- acceptance / artifact / result over PATCH (mesa task 500) ---------

    fn new_task(state: &AppState, project_id: i64) -> i64 {
        state
            .store
            .lock()
            .unwrap()
            .create_task(
                project_id,
                "t",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
            .id
    }

    async fn patch_task(state: &AppState, id: i64, body: &str) -> serde_json::Value {
        let body: TaskUpdate = serde_json::from_str(body).unwrap();
        let resp = update_task(State(state.clone()), Path(id), Ok(Json(body)))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        json_body(resp).await
    }

    /// Task 660: a description is the task's identity, so `null` is a
    /// rejection rather than a clear — and the same `validation` the CLI's
    /// `--description ""` produces, so the two surfaces cannot diverge.
    #[tokio::test]
    async fn task_patch_rejects_clearing_the_description() {
        let (_dir, state) = test_state();
        let pid = new_project(&state, None);
        let id = new_task(&state, pid);
        let body: TaskUpdate = serde_json::from_str(r#"{"description":null}"#).unwrap();
        let err = update_task(State(state.clone()), Path(id), Ok(Json(body)))
            .await
            .unwrap_err();
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = json_body(resp).await;
        assert_eq!(body["error"]["code"], "validation");
        // The stored body is untouched.
        assert_eq!(
            state
                .store
                .lock()
                .unwrap()
                .get_task(id)
                .unwrap()
                .description,
            "t"
        );
    }

    /// These three were readable over the API but silently unwritable: the
    /// handler built its `TaskPatch` with `acceptance/artifact/result: None`
    /// hard-coded, so a PATCH carrying them returned 200 and changed nothing.
    /// The web UI had no way to set what the CLI had always written.
    #[tokio::test]
    async fn task_patch_writes_acceptance_artifact_and_result() {
        let (_dir, state) = test_state();
        let pid = new_project(&state, None);
        let id = new_task(&state, pid);

        let body = patch_task(
            &state,
            id,
            // r## — the markdown heading's `#` would close an `r#` literal.
            r##"{"acceptance":"passes CI","artifact":"abc123","result":"# done\n\nshipped"}"##,
        )
        .await;
        assert_eq!(body["acceptance"], "passes CI");
        assert_eq!(body["artifact"], "abc123");
        assert_eq!(body["result"], "# done\n\nshipped");
        // Response echo is not proof of a write — re-read from the store.
        let stored = state.store.lock().unwrap().get_task(id).unwrap();
        assert_eq!(stored.acceptance.as_deref(), Some("passes CI"));
        assert_eq!(stored.artifact.as_deref(), Some("abc123"));
        assert_eq!(stored.result.as_deref(), Some("# done\n\nshipped"));
    }

    /// `double_option`, same as `description`: an omitted key leaves the
    /// stored value alone, an explicit `null` clears it. The frontend relies
    /// on this split — it patches one field at a time and sends `null` for a
    /// field the user emptied.
    #[tokio::test]
    async fn task_patch_distinguishes_omitted_from_null() {
        let (_dir, state) = test_state();
        let pid = new_project(&state, None);
        let id = new_task(&state, pid);
        patch_task(
            &state,
            id,
            r#"{"acceptance":"a","artifact":"b","result":"c"}"#,
        )
        .await;

        // Omitted: untouched, even though the patch does change another field.
        // Deliberately not `description`: this test is about the three
        // double-option bodies, and description is neither one of them nor
        // clearable any more.
        let body = patch_task(&state, id, r#"{"priority":"high"}"#).await;
        assert_eq!(body["priority"], "high");
        assert_eq!(body["acceptance"], "a");
        assert_eq!(body["artifact"], "b");
        assert_eq!(body["result"], "c");

        // Explicit null: cleared, one field at a time.
        let body = patch_task(&state, id, r#"{"result":null}"#).await;
        assert_eq!(body["result"], serde_json::Value::Null);
        assert_eq!(body["acceptance"], "a");
        assert_eq!(body["artifact"], "b");
        let stored = state.store.lock().unwrap().get_task(id).unwrap();
        assert_eq!(stored.result, None);
        assert_eq!(stored.acceptance.as_deref(), Some("a"));
    }

    // --- todo-watcher must skip archived projects (mesa task 506) -----------
    //
    // `todo_watcher_tick`'s only project source is `Store::list_projects()`,
    // which excludes archived rows (mesa task 504); it then calls
    // `next_task(Some(project.id))`, a scoped/archive-agnostic read (mesa task
    // 505), so the project list is the sole gate. This test calls the private
    // `todo_watcher_tick` directly (same crate) against a stub `claude` so it
    // would fail immediately if a future change swapped in
    // `list_projects_all()` or otherwise let an archived project's task reach
    // dispatch.

    /// Writes an executable stub `claude` that only understands `--bg`,
    /// appending `<cwd>|<name>|<prompt>` to `log_path` and printing a
    /// well-formed receipt line (mirrors `scripts/todo-watcher-check.sh`'s
    /// stub). `--agent <name>` is consumed ahead of `--name`/`--` and written
    /// to `<dir>/last-agent` — argv order matters, so a stub that parses
    /// positionally has to know about every flag `spawn_bg` may emit.
    ///
    /// Also pins `MESA_CONFIG_FILE` at a path that does not exist, so these
    /// tests assert the **built-in default** spawn command and cannot be
    /// broken by whatever the developer running them has in their own
    /// `~/.mesa/config.json` (`core::config`). Every caller already holds
    /// `ENV_LOCK`; the value is left set on purpose — "no config file" is the
    /// state every other test wants too.
    fn stub_claude_bg(dir: &std::path::Path, log_path: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        unsafe { std::env::set_var("MESA_CONFIG_FILE", dir.join("no-such-config.json")) };
        let path = dir.join("claude");
        std::fs::write(
            &path,
            format!(
                r#"#!/bin/sh
[ "$1" = "--bg" ] || exit 1
shift
[ -e "{fail}" ] && {{ echo "stub claude is down" >&2; exit 1; }}
AGENT=""
if [ "$1" = "--agent" ]; then shift; AGENT="$1"; shift; fi
echo "$AGENT" > "{agent_log}"
NAME=""
if [ "$1" = "--name" ]; then shift; NAME="$1"; shift; fi
PROMPT=""
if [ "$1" = "--" ]; then shift; PROMPT="$1"; fi
echo "$(pwd)|$NAME|$PROMPT" >> "{log}"
echo "backgrounded · deadbeef (idle — send a prompt to start)"
"#,
                fail = dir.join("fail").display(),
                agent_log = dir.join("last-agent").display(),
                log = log_path.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn todo_watcher_tick_skips_archived_project_dispatches_normal_one() {
        // SAFETY: ENV_LOCK (shared with attachments/cc tests) gives this test
        // exclusive access to MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let archived_dir = tempfile::tempdir().unwrap();
        let normal_dir = tempfile::tempdir().unwrap();
        let archived_path = archived_dir.path().to_str().unwrap();
        let normal_path = normal_dir.path().to_str().unwrap();

        let archived_id = new_project(&state, Some(archived_path));
        let normal_id = new_project(&state, Some(normal_path));
        let archived_task = new_task(&state, archived_id);
        let normal_task = new_task(&state, normal_id);
        state
            .store
            .lock()
            .unwrap()
            .archive_project(archived_id)
            .unwrap();

        todo_watcher_tick(&state);

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            1,
            "expected exactly one dispatch (the unarchived project), got: {log:?}"
        );
        // Auto-dispatch spawns under an agent persona (`MESA_CLAUDE_AGENT`,
        // default `swe`) — asserted here because the watcher path is the one
        // that must never regress to a generic session.
        let agent = std::fs::read_to_string(stub_dir.path().join("last-agent")).unwrap_or_default();
        assert_eq!(agent.trim(), "swe", "dispatch must pass --agent swe");
        assert!(
            log.contains(normal_path),
            "the unarchived project's task must be dispatched: {log:?}"
        );
        assert!(
            !log.contains(archived_path),
            "the archived project's task must never be dispatched: {log:?}"
        );

        let archived_task = state.store.lock().unwrap().get_task(archived_task).unwrap();
        assert_eq!(
            archived_task.status,
            Status::Todo,
            "archived project's task must stay todo, never claimed"
        );
        let normal_task = state.store.lock().unwrap().get_task(normal_task).unwrap();
        assert_eq!(
            normal_task.status,
            Status::InProgress,
            "unarchived project's task must be claimed in_progress"
        );
    }

    // --- todo-watcher umbrella tasks (mesa task 570) -----------------------
    //
    // An `in_progress` task that has subtasks must not wedge its project: the
    // watcher keeps dispatching, but only from under that umbrella. An
    // `in_progress` *leaf* still wedges, as before.

    fn new_subtask(state: &AppState, project_id: i64, parent: i64, title: &str) -> i64 {
        state
            .store
            .lock()
            .unwrap()
            .create_task(
                project_id,
                title,
                Priority::Medium,
                &[],
                Some(parent),
                None,
                None,
                None,
            )
            .unwrap()
            .id
    }

    fn set_status(state: &AppState, id: i64, status: Status) {
        state
            .store
            .lock()
            .unwrap()
            .update_task(
                id,
                &TaskPatch {
                    status: Some(status),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    #[test]
    fn todo_watcher_tick_dispatches_subtask_under_in_progress_parent() {
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));

        // An unrelated todo, an umbrella held in_progress, and two children.
        let outsider = new_task(&state, project);
        let parent = new_task(&state, project);
        let child_a = new_subtask(&state, project, parent, "child a");
        let child_b = new_subtask(&state, project, parent, "child b");
        set_status(&state, parent, Status::InProgress);

        todo_watcher_tick(&state);

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            1,
            "an open umbrella must not wedge its project: {log:?}"
        );
        assert!(
            log.contains(&format!("/execute-mesa-task {child_a}")),
            "the umbrella's first child must be the dispatched task: {log:?}"
        );
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        assert_eq!(get(child_a), Status::InProgress);
        assert_eq!(get(parent), Status::InProgress, "the umbrella is untouched");
        assert_eq!(
            get(outsider),
            Status::Todo,
            "an open umbrella unblocks only its own children"
        );

        // The dispatched child is a leaf, so the project is busy again: the
        // second child must wait rather than fan out concurrently.
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            1,
            "an in_progress leaf still wedges the project: {log:?}"
        );
        assert_eq!(get(child_b), Status::Todo);

        // Child done -> the next tick takes the umbrella's second child.
        set_status(&state, child_a, Status::Done);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 2, "second child dispatched: {log:?}");
        assert!(
            log.contains(&format!("/execute-mesa-task {child_b}")),
            "{log:?}"
        );

        // Subtree exhausted while the umbrella is still open -> the watcher
        // stops rather than reaching for the unrelated todo.
        set_status(&state, child_b, Status::Done);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "an exhausted subtree must not fall back to the wider project: {log:?}"
        );
        assert_eq!(get(outsider), Status::Todo);

        // Umbrella closed -> the project is plainly idle again.
        set_status(&state, parent, Status::Done);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 3, "idle project resumes: {log:?}");
        assert!(
            log.contains(&format!("/execute-mesa-task {outsider}")),
            "{log:?}"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn todo_watcher_tick_never_dispatches_backlog_tasks() {
        // `backlog` is the agent-side opt-out an orchestrating agent relies on
        // (mesa task 613, `docs/todo-watcher.md`): tasks it authored and
        // intends to dispatch itself must not be picked up by the watcher in
        // the window between creation and dispatch. Both picks
        // (`next_task` and, under an umbrella, `next_subtask`) filter on
        // `status = 'todo'`, so this holds on both paths -- and the watcher is
        // the only place that contract is observable end to end.
        //
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));

        // Idle project whose only work is backlog: nothing to dispatch.
        let shelved = new_task(&state, project);
        set_status(&state, shelved, Status::Backlog);

        todo_watcher_tick(&state);

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            log.is_empty(),
            "a backlog task must never be auto-dispatched: {log:?}"
        );
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        assert_eq!(get(shelved), Status::Backlog, "and must not be claimed");

        // Same on the umbrella path: an agent holding a parent in_progress and
        // creating its children as backlog keeps its own subtree to itself.
        let parent = new_task(&state, project);
        let child = new_subtask(&state, project, parent, "child");
        set_status(&state, child, Status::Backlog);
        set_status(&state, parent, Status::InProgress);

        todo_watcher_tick(&state);

        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            log.is_empty(),
            "a backlog subtask must not be dispatched under an open umbrella: {log:?}"
        );
        assert_eq!(get(child), Status::Backlog);

        // The opt-out is the status and nothing else: releasing the child to
        // `todo` dispatches it on the very next tick.
        set_status(&state, child, Status::Todo);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            log.contains(&format!("/execute-mesa-task {child}")),
            "a released child must dispatch normally: {log:?}"
        );
        assert_eq!(get(child), Status::InProgress);

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn todo_watcher_tick_never_dispatches_a_task_with_actionable_subtasks() {
        // The umbrella rule's other half: if the watcher itself claimed a
        // *todo* epic, that epic would read as an umbrella on the very next
        // tick and a second agent would be spawned onto one of its own
        // children, in the same repo. `deepest_actionable` prevents it --
        // the watcher claims leaves, and an epic only once its subtree is
        // exhausted.
        //
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));

        // An all-todo epic: lowest id, so a plain `next_task` picks it.
        let epic = new_task(&state, project);
        let child = new_subtask(&state, project, epic, "child");
        let grandchild = new_subtask(&state, project, child, "grandchild");

        todo_watcher_tick(&state);
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 1, "one dispatch: {log:?}");
        assert!(
            log.contains(&format!("/execute-mesa-task {grandchild}")),
            "the deepest actionable descendant is the unit of work, not the epic: {log:?}"
        );
        assert_eq!(get(epic), Status::Todo, "the epic must not be claimed");
        assert_eq!(get(child), Status::Todo, "the mid-level parent likewise");

        // Second tick: the claimed grandchild is a leaf, so the project is
        // busy. Without the leaf rule the epic would have been in_progress
        // here and this tick would spawn a second agent alongside it.
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            1,
            "no second agent in the repo: {log:?}"
        );

        // Subtree exhausted -> the epic is finally the actionable leaf, and
        // its own claim parks the project rather than dispatching alongside.
        set_status(&state, grandchild, Status::Done);
        set_status(&state, child, Status::Done);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 2, "roll-up dispatched: {log:?}");
        assert!(
            log.contains(&format!("/execute-mesa-task {epic}")),
            "{log:?}"
        );
        assert_eq!(get(epic), Status::InProgress);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "an epic holding its own claim parks the project: {log:?}"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    // --- the configurable per-project concurrency limit (mesa task 777) ----

    /// Points `MESA_CONFIG_FILE` at a real file holding `body`. Callers run
    /// after `stub_claude_bg` (which pins the var at a *nonexistent* path) and
    /// hold `ENV_LOCK`, so this is the one place a watcher test opts into a
    /// config that exists. Only the `watchers` section is set — the spawn
    /// command stays the built-in default the stub understands.
    fn config_with(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("config.json");
        std::fs::write(&path, body).unwrap();
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &path) };
        path
    }

    #[test]
    fn todo_watcher_tick_fills_up_to_the_configured_limit() {
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN / MESA_CONFIG_FILE for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };
        config_with(stub_dir.path(), r#"{"watchers": {"todo-concurrency": 2}}"#);

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let first = new_task(&state, project);
        let second = new_task(&state, project);
        let third = new_task(&state, project);

        // One tick fills both slots — the limit is a ceiling on concurrent
        // agents, not a rate of one per tick.
        todo_watcher_tick(&state);
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "two dispatches in one tick: {log:?}"
        );
        assert_eq!(get(first), Status::InProgress);
        assert_eq!(get(second), Status::InProgress);
        assert_eq!(get(third), Status::Todo, "the third waits for a free slot");

        // Full: further ticks dispatch nothing.
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 2, "the project is full: {log:?}");

        // Freeing one slot releases exactly one more.
        set_status(&state, first, Status::Done);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            3,
            "the freed slot is refilled: {log:?}"
        );
        assert_eq!(get(third), Status::InProgress);

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn todo_watcher_tick_with_no_config_still_dispatches_exactly_one() {
        // The whole point of the default: an install that never touched
        // `~/.mesa/config.json` behaves exactly as mesa did before task 777.
        //
        // SAFETY: ENV_LOCK, as above.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        // `stub_claude_bg` pins MESA_CONFIG_FILE at a path that does not exist.
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let first = new_task(&state, project);
        let second = new_task(&state, project);

        todo_watcher_tick(&state);
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 1, "one agent per project: {log:?}");
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        assert_eq!(get(first), Status::InProgress);
        assert_eq!(get(second), Status::Todo);

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn lowering_the_limit_never_touches_work_in_flight() {
        // SAFETY: ENV_LOCK, as above.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };
        let config = config_with(stub_dir.path(), r#"{"watchers": {"todo-concurrency": 3}}"#);

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let ids: Vec<i64> = (0..4).map(|_| new_task(&state, project)).collect();

        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 3, "three slots filled: {log:?}");

        // Lowered under the in-flight count, mid-run, with no restart: the
        // next tick reads the new value, dispatches nothing, and de-claims
        // nothing.
        std::fs::write(&config, r#"{"watchers": {"todo-concurrency": 1}}"#).unwrap();
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 3, "nothing new is picked: {log:?}");
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        for id in &ids[..3] {
            assert_eq!(get(*id), Status::InProgress, "in-flight work is untouched");
        }
        assert_eq!(get(ids[3]), Status::Todo);

        // Only once the count falls back under the new limit does it move.
        for id in &ids[..3] {
            set_status(&state, *id, Status::Done);
        }
        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            4,
            "one more, at the new limit: {log:?}"
        );
        assert_eq!(get(ids[3]), Status::InProgress);

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn a_malformed_config_skips_the_tick_rather_than_guessing_a_limit() {
        // SAFETY: ENV_LOCK, as above.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };
        config_with(stub_dir.path(), "not json");

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let task = new_task(&state, project);

        todo_watcher_tick(&state);
        assert!(
            std::fs::read_to_string(&log_path)
                .unwrap_or_default()
                .is_empty(),
            "a config mesa cannot parse dispatches nothing"
        );
        assert_eq!(
            state.store.lock().unwrap().get_task(task).unwrap().status,
            Status::Todo,
            "and claims nothing"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn the_limit_counts_leaves_only_and_the_umbrella_still_narrows_the_pick() {
        // The two rules composed: an in_progress umbrella occupies no slot
        // (mesa task 570) but still confines the fill to its own children.
        //
        // SAFETY: ENV_LOCK, as above.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };
        config_with(stub_dir.path(), r#"{"watchers": {"todo-concurrency": 2}}"#);

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let epic = new_task(&state, project);
        let child_a = new_subtask(&state, project, epic, "a");
        let child_b = new_subtask(&state, project, epic, "b");
        let outsider = new_task(&state, project);
        set_status(&state, epic, Status::InProgress);

        todo_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "the umbrella occupies no slot, so both fill from under it: {log:?}"
        );
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        assert_eq!(get(child_a), Status::InProgress);
        assert_eq!(get(child_b), Status::InProgress);
        assert_eq!(
            get(outsider),
            Status::Todo,
            "an open umbrella unblocks its own children and nothing else"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    // --- refine watcher (mesa task 661) -----------------------------------

    fn new_refine_task(state: &AppState, project_id: i64, description: &str) -> i64 {
        state
            .store
            .lock()
            .unwrap()
            .create_task(
                project_id,
                description,
                Priority::Medium,
                &[],
                None,
                None,
                None,
                Some(Status::Refine),
            )
            .unwrap()
            .id
    }

    #[test]
    fn refine_watcher_tick_drips_one_per_project_and_never_repeats() {
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        // A project with no local_path is skipped, like the todo-watcher's.
        let pathless = new_project(&state, None);
        new_refine_task(&state, pathless, "nowhere to run");

        let first = new_refine_task(&state, project, "vague one");
        let second = new_refine_task(&state, project, "vague two");
        // Plain todo work is not this watcher's business at all.
        let todo = new_task(&state, project);

        let lines = || {
            std::fs::read_to_string(&log_path)
                .unwrap_or_default()
                .lines()
                .count()
        };
        let log = || std::fs::read_to_string(&log_path).unwrap_or_default();

        refine_watcher_tick(&state);
        assert_eq!(lines(), 1, "one dispatch per project per tick: {:?}", log());
        assert!(
            log().contains(&format!("id {first}")),
            "the head of the column goes first: {:?}",
            log()
        );
        // Dispatch is not a status claim: the task stays in `refine` until
        // the agent itself moves it on, and the project never reads as busy.
        let get = |id| state.store.lock().unwrap().get_task(id).unwrap().status;
        assert_eq!(get(first), Status::Refine);

        // Next tick: the already-dispatched task is skipped, the next one in
        // rank goes out. The column drains rather than stampeding.
        refine_watcher_tick(&state);
        assert_eq!(lines(), 2, "{:?}", log());
        assert!(log().contains(&format!("id {second}")), "{:?}", log());

        // Nothing left undispatched — and no dispatch onto the todo task or
        // the path-less project, on this tick or any earlier one.
        refine_watcher_tick(&state);
        assert_eq!(lines(), 2, "{:?}", log());
        assert!(!log().contains(&format!("id {todo}")), "{:?}", log());

        // The agent's own move to `todo` is what ends refinement: the task
        // leaves the column, and the todo-watcher can now pick it up.
        set_status(&state, first, Status::Todo);
        refine_watcher_tick(&state);
        assert_eq!(lines(), 2, "a refined task is not re-refined: {:?}", log());

        // …and if it comes back for another pass, it is dispatched again —
        // the dedup set tracks the column, not the task's whole life.
        set_status(&state, first, Status::Refine);
        refine_watcher_tick(&state);
        assert_eq!(lines(), 3, "{:?}", log());
        assert!(log().contains(&format!("id {first}")), "{:?}", log());

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    #[test]
    fn refine_watcher_tick_retries_after_a_spawn_failure() {
        // SAFETY: ENV_LOCK gives this test exclusive access to
        // MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };
        // Arm the stub's failure switch: `claude` exits nonzero.
        std::fs::write(stub_dir.path().join("fail"), "").unwrap();

        let (_dir, state) = test_state();
        let proj_dir = tempfile::tempdir().unwrap();
        let project = new_project(&state, Some(proj_dir.path().to_str().unwrap()));
        let task = new_refine_task(&state, project, "vague");

        refine_watcher_tick(&state);
        assert_eq!(
            std::fs::read_to_string(&log_path).unwrap_or_default(),
            "",
            "the stub failed before logging"
        );
        // The claim is released, so the task is not silently stranded in the
        // column forever — the mirror of the todo-watcher's revert-to-`todo`.
        std::fs::remove_file(stub_dir.path().join("fail")).unwrap();
        refine_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(log.lines().count(), 1, "retried next tick: {log:?}");
        assert!(log.contains(&format!("id {task}")), "{log:?}");

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    // --- inbox watcher (mesa task 544) -----------------------------------

    #[test]
    fn inbox_session_name_uses_first_nonempty_line_truncated() {
        let item = |body: &str| InboxItem {
            id: 7,
            project_id: None,
            author: None,
            body: body.to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert_eq!(
            inbox_session_name(&item(
                "\n\n  khora: eval errors on undefined  \nmore detail"
            )),
            "inbox 7: khora: eval errors on undefined"
        );
        // Truncation counts chars, not bytes — a multi-byte body must not
        // panic on a mid-codepoint slice.
        let long = "é".repeat(INBOX_SESSION_NAME_CHARS + 5);
        let name = inbox_session_name(&item(&long));
        assert_eq!(
            name,
            format!("inbox 7: {}…", "é".repeat(INBOX_SESSION_NAME_CHARS))
        );
        // A body with no usable line still names the item it triages.
        assert_eq!(inbox_session_name(&item("   \n\t\n")), "inbox 7");
    }

    /// The dedup set is what stands in for the todo-watcher's `in_progress`
    /// claim: every pending item is dispatched once, and a second tick over
    /// the same inbox dispatches nothing — the triage skill's "no confident
    /// project match" outcome leaves the item in place, so without this the
    /// watcher would respawn an agent for it every 60s forever.
    #[test]
    fn inbox_watcher_tick_dispatches_each_item_once_then_picks_up_new_ones() {
        // SAFETY: ENV_LOCK (shared with attachments/cc tests) gives this test
        // exclusive access to MESA_CLAUDE_BIN for its duration.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let first = state
            .store
            .lock()
            .unwrap()
            .create_inbox_item(Some("agent-7"), "khora: eval errors on undefined")
            .unwrap();
        let second = state
            .store
            .lock()
            .unwrap()
            .create_inbox_item(None, "loki: find exits 0 on no match")
            .unwrap();

        // The whole pending inbox goes out in one tick — the inbox is one
        // global queue, with no per-project cap to pace it.
        inbox_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "both pending items must dispatch in the first tick: {log:?}"
        );
        assert!(
            log.contains(&format!("/inbox-triage {}", first.id))
                && log.contains(&format!("/inbox-triage {}", second.id)),
            "each dispatch's prompt must name its own item: {log:?}"
        );
        assert!(
            log.contains(&format!(
                "inbox {}: khora: eval errors on undefined",
                first.id
            )),
            "session name must identify the item: {log:?}"
        );

        // Second tick, same inbox: nothing re-dispatches.
        inbox_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            2,
            "an already-dispatched item must not dispatch again: {log:?}"
        );

        // A newly-arrived item still dispatches on the next tick.
        let third = state
            .store
            .lock()
            .unwrap()
            .create_inbox_item(None, "mesa: add an inbox watcher")
            .unwrap();
        inbox_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            log.lines().count(),
            3,
            "a new item must dispatch even though older ones are claimed: {log:?}"
        );
        assert!(
            log.contains(&format!("/inbox-triage {}", third.id)),
            "the new item's own id must be dispatched: {log:?}"
        );

        // Triage removing an item prunes it from the set, so it can't grow
        // unboundedly on a long-lived server.
        state
            .store
            .lock()
            .unwrap()
            .delete_inbox_item(first.id)
            .unwrap();
        inbox_watcher_tick(&state);
        assert!(
            !state.inbox_dispatched.lock().unwrap().contains(&first.id),
            "an item that left the inbox must be pruned from the dedup set"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    /// A spawn failure must release the claim, so a transient `claude`
    /// outage retries next tick instead of silently dropping the item —
    /// the inbox equivalent of the todo-watcher's revert-to-`todo`.
    #[test]
    fn inbox_watcher_tick_releases_claim_when_spawn_fails() {
        // SAFETY: see `inbox_watcher_tick_dispatches_each_item_once_...`.
        let _env = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stub_dir = tempfile::tempdir().unwrap();
        let log_path = stub_dir.path().join("bg.log");
        let bin = stub_claude_bg(stub_dir.path(), &log_path);
        // `stub_claude_bg`'s `--bg` branch fails while this marker exists.
        std::fs::write(stub_dir.path().join("fail"), "").unwrap();
        unsafe { std::env::set_var("MESA_CLAUDE_BIN", &bin) };

        let (_dir, state) = test_state();
        let item = state
            .store
            .lock()
            .unwrap()
            .create_inbox_item(None, "mesa: something to triage")
            .unwrap();

        inbox_watcher_tick(&state);
        assert!(
            !state.inbox_dispatched.lock().unwrap().contains(&item.id),
            "a failed spawn must not leave the item claimed"
        );

        // With the stub healthy again, the next tick dispatches it.
        std::fs::remove_file(stub_dir.path().join("fail")).unwrap();
        inbox_watcher_tick(&state);
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            log.contains(&format!("/inbox-triage {}", item.id)),
            "the item must dispatch once the spawn succeeds: {log:?}"
        );

        unsafe { std::env::remove_var("MESA_CLAUDE_BIN") };
    }

    // --- scripts: /api/scripts (mesa task 785) ------------------------------
    //
    // CRUD and run semantics over HTTP are `scripts/scripts-check.sh`'s job.
    // What only lives here is the peer-address-sensitive half: the gate
    // *asymmetry* (a LAN page may run a stored script but may never author
    // one), which a same-machine curl cannot exercise, plus the server-side
    // cwd resolution and the body shapes serde decides.

    fn new_script(state: &AppState, project_id: Option<i64>, body: &str) -> Script {
        state
            .store
            .lock()
            .unwrap()
            .create_script(project_id, "s", None, body, &[])
            .unwrap()
    }

    async fn run_one(state: &AppState, id: i64) -> ApiResult<Response> {
        run_script(
            State(state.clone()),
            ConnectInfo(loopback()),
            loopback_agent_headers(),
            Path(id),
            Ok(Json(ScriptRunBody {
                values: std::collections::BTreeMap::new(),
            })),
        )
        .await
    }

    #[tokio::test]
    async fn script_mutations_reject_non_loopback_peer_in_default_mode() {
        let (_dir, state) = test_state();
        assert!(!state.lan);
        let script = new_script(&state, None, "true");

        let created = create_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Ok(Json(ScriptCreate {
                name: "evil".into(),
                body: "echo pwned".into(),
                project_id: None,
                description: None,
                args: vec![],
            })),
        )
        .await;
        assert!(created.unwrap_err().status.is_client_error());
        let updated = update_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(script.id),
            Ok(Json(ScriptUpdate {
                project_id: None,
                name: None,
                description: None,
                body: Some(Some("echo pwned".into())),
                args: None,
            })),
        )
        .await;
        assert!(updated.unwrap_err().status.is_client_error());
        let deleted = delete_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(script.id),
        )
        .await;
        assert!(deleted.unwrap_err().status.is_client_error());

        // None of the three may have touched the store.
        let stored = state.store.lock().unwrap().list_scripts(None).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].body, "true");
    }

    /// The load-bearing asymmetry: under `--lan`, a legitimate LAN page passes
    /// `require_agent_access` and may *run* a stored script, but authoring is
    /// loopback-only in both modes — a LAN peer must never choose the program.
    #[tokio::test]
    async fn lan_page_may_run_a_script_but_may_never_author_one() {
        let (_dir, mut state) = test_state();
        state.lan = true;
        let headers = hdrs(Some("192.168.1.50:0"), Some("http://192.168.1.50:0"));
        let script = new_script(&state, None, "exit 0");

        let ran = run_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            headers.clone(),
            Path(script.id),
            Ok(Json(ScriptRunBody {
                values: std::collections::BTreeMap::new(),
            })),
        )
        .await
        .unwrap();
        assert_eq!(ran.status(), StatusCode::OK);

        let authored = create_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            headers,
            Ok(Json(ScriptCreate {
                name: "evil".into(),
                body: "echo pwned".into(),
                project_id: None,
                description: None,
                args: vec![],
            })),
        )
        .await;
        assert!(authored.unwrap_err().status.is_client_error());
    }

    #[tokio::test]
    async fn script_reads_and_run_reject_non_loopback_peer_in_default_mode() {
        let (_dir, state) = test_state();
        let script = new_script(&state, None, "true");
        let listed = list_scripts(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Query(ScriptQuery { project: None }),
        )
        .await;
        assert!(listed.unwrap_err().status.is_client_error());
        let shown = show_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(script.id),
        )
        .await;
        assert!(shown.unwrap_err().status.is_client_error());
        let ran = run_script(
            State(state.clone()),
            ConnectInfo(lan_peer()),
            loopback_agent_headers(),
            Path(script.id),
            Ok(Json(ScriptRunBody {
                values: std::collections::BTreeMap::new(),
            })),
        )
        .await;
        assert!(ran.unwrap_err().status.is_client_error());
    }

    /// A script's own nonzero exit is data in a 200, exactly like a `HookRun`.
    #[tokio::test]
    async fn run_script_reports_a_nonzero_exit_as_data() {
        let (_dir, state) = test_state();
        let script = new_script(&state, None, "echo out; echo err >&2; exit 3");
        let resp = run_one(&state, script.id).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["exit_code"], 3);
        assert_eq!(body["stdout"], "out\n");
        assert_eq!(body["stderr"], "err\n");
        assert_eq!(body["truncated"], false);
    }

    #[tokio::test]
    async fn run_script_rejects_bad_values_with_422_not_502() {
        let (_dir, state) = test_state();
        let script = state
            .store
            .lock()
            .unwrap()
            .create_script(
                None,
                "needy",
                None,
                "true",
                &[ScriptArg {
                    name: "target".into(),
                    label: None,
                    kind: crate::core::ScriptArgKind::Text,
                    required: true,
                    default: None,
                    choices: None,
                }],
            )
            .unwrap();

        // Missing a required argument, and an undeclared key: both are the
        // client's mistake about the declared args, not a spawn failure.
        for values in [
            std::collections::BTreeMap::new(),
            std::collections::BTreeMap::from([("nope".to_string(), "x".to_string())]),
        ] {
            let err = run_script(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Path(script.id),
                Ok(Json(ScriptRunBody { values })),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(err.code, "validation");
        }
    }

    /// cwd comes from the script's own project binding, resolved server-side;
    /// an unbound script runs in `$HOME`.
    #[tokio::test]
    async fn run_script_cwd_is_the_bound_projects_local_path_else_home() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let project = new_project(&state, Some(root.to_str().unwrap()));
        let canon_root = std::fs::canonicalize(&root).unwrap();

        let bound = new_script(&state, Some(project), "pwd");
        let body = json_body(run_one(&state, bound.id).await.unwrap()).await;
        assert_eq!(
            std::fs::canonicalize(body["stdout"].as_str().unwrap().trim()).unwrap(),
            canon_root
        );

        state.store.lock().unwrap().delete_script(bound.id).unwrap();
        let unbound = new_script(&state, None, "pwd");
        let body = json_body(run_one(&state, unbound.id).await.unwrap()).await;
        let home = directories::BaseDirs::new().unwrap().home_dir().to_owned();
        assert_eq!(
            std::fs::canonicalize(body["stdout"].as_str().unwrap().trim()).unwrap(),
            std::fs::canonicalize(home).unwrap()
        );
    }

    #[tokio::test]
    async fn run_script_is_422_when_the_bound_project_has_no_usable_local_path() {
        let (dir, state) = test_state();
        let unset = new_project(&state, None);
        let gone = new_project(&state, Some(dir.path().join("gone").to_str().unwrap()));
        for project in [unset, gone] {
            let script = state
                .store
                .lock()
                .unwrap()
                .create_script(Some(project), &format!("s{project}"), None, "pwd", &[])
                .unwrap();
            let err = run_one(&state, script.id).await.unwrap_err();
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY, "{project}");
            assert_eq!(err.code, "validation", "{project}");
        }
    }

    /// The PATCH body's three-state fields: `null` un-binds a project and
    /// clears a description, while an omitted key changes nothing. An
    /// incomplete `ScriptArg` is a serde error, so it lands as 422 without
    /// reaching `Store`.
    #[test]
    fn script_update_body_distinguishes_absent_null_and_value() {
        let parsed: ScriptUpdate =
            serde_json::from_str(r#"{"project_id":null,"description":null}"#).unwrap();
        assert_eq!(parsed.project_id, Some(None));
        assert_eq!(parsed.description, Some(None));
        assert_eq!(parsed.body, None);
        let parsed: ScriptUpdate = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.project_id, None);
        assert_eq!(parsed.description, None);
        assert_eq!(parsed.name, None);
        assert!(serde_json::from_str::<ScriptUpdate>(r#"{"args":[{"name":"a"}]}"#).is_err());
    }

    /// Clearing the two identity fields is a `validation` error, not an
    /// erasure — and it is rejected before the store is touched.
    #[tokio::test]
    async fn script_update_refuses_to_clear_name_or_body() {
        let (_dir, state) = test_state();
        let script = new_script(&state, None, "true");
        for payload in [r#"{"name":null}"#, r#"{"body":null}"#] {
            let body: ScriptUpdate = serde_json::from_str(payload).unwrap();
            let err = update_script(
                State(state.clone()),
                ConnectInfo(loopback()),
                loopback_agent_headers(),
                Path(script.id),
                Ok(Json(body)),
            )
            .await
            .unwrap_err();
            assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY, "{payload}");
            assert_eq!(err.code, "validation", "{payload}");
        }
        let stored = state.store.lock().unwrap().get_script(script.id).unwrap();
        assert_eq!(stored, script);
    }
}
