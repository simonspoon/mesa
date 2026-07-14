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
    AgentSession, AgentSpawned, CcDashboard, CcUsage, EdgePatch, Error, FileTreeEntry, FrameNew,
    FramePatch, GitCommit, GitCommitFile, GitFileDiff, GitRepoView, GitStatus, GitWorktree,
    NextResult, Priority, ProjectAgents, ProjectFileTree, ProjectGitLog, ProjectGitStatus,
    ProjectGitView, ProjectPatch, Status, Store, StoryboardPatch, TaskPatch, TaskSummary,
    Waypoint, agents, attachments, files, git, hooks,
};

/// The Vite build output, embedded into the binary at compile time.
/// `scripts/build.sh` guarantees `frontend/dist` is built before the release
/// compile; debug builds read the folder from disk at runtime instead.
#[derive(rust_embed::RustEmbed, Clone)]
#[folder = "frontend/dist"]
struct Assets;

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
    /// Bumped whenever a spawn invalidates the list cache. A concurrent list
    /// whose subprocess started before the spawn checks this before caching,
    /// so it can't reinsert a pre-spawn snapshot after the invalidation and
    /// briefly hide the just-created session.
    agents_gen: Arc<AtomicU64>,
    /// Files tab tree listing per project folder, keyed by `local_path` —
    /// backs `GET /api/projects/{id}/files`. `core::files::tree_of` walks the
    /// whole tree (bounded by `MAX_TREE_ENTRIES`/`MAX_TREE_DEPTH`, but still
    /// not free for a large repo), so this reuses the same TTL/eviction-cap
    /// pattern as `git_view_cache`. File content reads are not cached (mirrors
    /// the git diff routes — on-demand, one file, cheap).
    files_tree_cache: Arc<Mutex<HashMap<String, (Instant, (Vec<FileTreeEntry>, bool))>>>,
    /// Set by `restart_server` before it triggers graceful shutdown; `serve`
    /// checks it right after `axum::serve` returns to decide whether to
    /// relaunch the current binary.
    restart_requested: Arc<AtomicBool>,
    /// Taken (once) by `restart_server` to fire the graceful-shutdown signal
    /// `serve` is awaiting. `None` after the first request, so a second
    /// concurrent restart click reports "already restarting" instead of
    /// panicking on a consumed oneshot.
    shutdown_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
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

/// One todo-watcher pass: for every project with a live `local_path` and no
/// `in_progress` task, pick the next actionable task (`Store::next_task`) and
/// dispatch a background `claude` agent on it. Marks the task `in_progress`
/// itself *before* spawning — closing the race window between dispatch and
/// the agent's own `/execute-mesa-task` pickup step, so a second tick can't
/// double-dispatch the same task while the agent is still starting up. A
/// spawn failure reverts the task back to `todo` so the project isn't
/// wedged; a dispatched agent that later crashes without finishing is not
/// detected here (task-status, not live-session, is the "in process" signal)
/// and leaves that project quiet until someone intervenes — an accepted v1
/// tradeoff over polling `claude agents` for every project every tick.
///
/// Two-phase, like `spawn_project_agent`: the store lock is held only long
/// enough to decide and claim (phase 1), then dropped before the blocking
/// `claude --bg` shell-outs (phase 2) — holding it across a spawn would
/// freeze every other API request (each needs the same lock) for as long as
/// `claude --bg` takes to start (node startup, ~0.5s+, per the Agents-tab
/// comments) times however many projects this tick dispatches.
fn todo_watcher_tick(state: &AppState) {
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
        let tasks = match store.list_tasks() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("todo-watcher: list_tasks failed: {e}");
                return;
            }
        };
        let busy_projects: std::collections::HashSet<i64> = tasks
            .iter()
            .filter(|t| t.status == Status::InProgress)
            .map(|t| t.project_id)
            .collect();
        let mut claimed = Vec::new();
        for project in projects {
            let Some(local_path) = project.local_path.as_deref() else {
                continue;
            };
            if !std::path::Path::new(local_path).is_dir() {
                continue;
            }
            if busy_projects.contains(&project.id) {
                continue;
            }
            let task = match store.next_task(Some(project.id)) {
                Ok(NextResult::Task(task)) => task,
                Ok(NextResult::None { .. }) => continue,
                Err(e) => {
                    eprintln!(
                        "todo-watcher: next_task failed for project {}: {e}",
                        project.id
                    );
                    continue;
                }
            };
            let in_progress = TaskPatch {
                status: Some(Status::InProgress),
                ..Default::default()
            };
            if let Err(e) = store.update_task(task.id, &in_progress) {
                eprintln!("todo-watcher: failed to claim task {}: {e}", task.id);
                continue;
            }
            let session_name = format!("{}: {}", project.name, task.title);
            claimed.push((task.id, local_path.to_string(), session_name));
        }
        claimed
    };
    for (task_id, local_path, session_name) in claimed {
        let prompt = format!("/execute-mesa-task {task_id}");
        if let Err(e) = agents::spawn_bg(&local_path, Some(&prompt), Some(&session_name)) {
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

/// Opens the default store and serves the API, blocking until the process is
/// killed. Binds 127.0.0.1 by default; with `lan`, binds 0.0.0.0 so other
/// devices on the local network can reach it (no auth — see `serve --help`).
/// `watch_todo` starts the periodic todo-watcher (see [`todo_watcher_tick`]);
/// off by default, propagated across the web UI's Restart Server action.
pub fn serve(port: u16, lan: bool, watch_todo: bool) -> crate::core::Result<()> {
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
        files_tree_cache: Arc::new(Mutex::new(HashMap::new())),
        restart_requested: restart_requested.clone(),
        shutdown_tx: Arc::new(Mutex::new(Some(shutdown_tx))),
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
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            get(show_task).patch(update_task).delete(delete_task),
        )
        // Fires the user-configured task-execute hook (a shell command from
        // the local hooks.json) — code execution, so it shares the agents'
        // mode-dependent access gate.
        .route("/api/tasks/{id}/execute", post(execute_task))
        .route("/api/tasks/{id}/block", post(block_task))
        .route("/api/tasks/{id}/unblock", post(unblock_task))
        .route("/api/tasks/{id}/dependencies", get(list_dependencies))
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
        .route("/api/edges/{id}", patch(update_edge).delete(delete_edge))
        .route("/api/inbox", get(list_inbox).post(create_inbox))
        .route(
            "/api/inbox/{id}",
            get(show_inbox).patch(assign_inbox).delete(delete_inbox),
        )
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
        // Sidebar decoration: working-tree git status of each project's
        // `local_path`. Read-only external state (shells `git status`).
        .route("/api/git-status", get(get_git_status))
        // Project git tab: working-tree view (branch + changed files) and a
        // per-file unified diff. Read-only external state like /api/git-status,
        // so the same standard guard only — no agent access gate.
        .route("/api/projects/{id}/git", get(get_project_git))
        .route("/api/projects/{id}/git/diff", get(get_project_git_diff))
        // Commit history: recent log, one commit's changed files, and one
        // commit-file's diff. Same read-only/standard-guard-only posture as
        // the two routes above — these execute nothing but `git` shell-outs.
        .route("/api/projects/{id}/git/log", get(get_project_git_log))
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
            get(get_project_files_content).patch(update_project_files_content),
        )
        // CC Dashboard: read-only Claude Code telemetry (no Store access).
        .route("/api/cc/usage", get(get_cc_usage))
        .route("/api/cc", get(get_cc_dashboard))
        // Live sessions: cheap, frequently-polled slice of the telemetry.
        .route("/api/cc/live", get(get_cc_live))
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
}

#[derive(Deserialize)]
struct ProjectResolve {
    commit: String,
}

async fn list_projects(State(state): State<AppState>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_projects()?).into_response())
}

async fn create_project(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<ProjectCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    if body.local_path.is_some() {
        require_local_path_write(&state, &addr, &headers)?;
    }
    let mut store = state.store.lock().unwrap();
    let project = store.create_project(
        &body.name,
        body.description.as_deref(),
        body.root_commit.as_deref(),
        body.local_path.as_deref(),
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
        require_local_path_write(&state, &addr, &headers)?;
    }
    let patch = ProjectPatch {
        name: body.name,
        description: body.description,
        root_commit: body.root_commit,
        local_path: body.local_path,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_project(id, &patch)?).into_response())
}

async fn delete_project(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    let (project, tasks) = store.delete_project(id)?;
    Ok(Json(json!({"project": project, "tasks": tasks})).into_response())
}

// ---- tasks ----

#[derive(Deserialize)]
struct TaskCreate {
    project_id: i64,
    title: String,
    #[serde(default)]
    description: Option<String>,
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
    #[serde(default)]
    title: Option<String>,
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
        .list_tasks()?
        .iter()
        .filter(|t| q.project.is_none_or(|p| t.project_id == p))
        .filter(|t| q.status.is_none_or(|s| t.status == s))
        .filter(|t| q.tag.as_ref().is_none_or(|g| t.tags.iter().any(|x| x == g)))
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
        &body.title,
        body.description.as_deref(),
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
    let patch = TaskPatch {
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        tags: body.tags,
        parent_id: body.parent_id,
        acceptance: None,
        artifact: None,
        result: None,
        sort_order: body.sort_order,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_task(id, &patch)?).into_response())
}

async fn delete_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_task(id)?).into_response())
}

/// Fires the task-execute hook for one task (the UI's Execute button): the
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

async fn block_task(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<BlockBody>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.add_dependency(id, body.on)?).into_response())
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
    let ascii_fallback: String = filename
        .chars()
        .map(|c| if c.is_ascii() { c } else { '_' })
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let encoded = percent_encode_rfc5987(filename);
    format!("attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}")
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

async fn update_edge(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<EdgeUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let patch = EdgePatch {
        label: body.label,
        waypoints: body.waypoints,
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

/// Files tab tree listing. Empty-state ladder mirrors `ProjectGitView`: no
/// `local_path` -> `{path: null, tree: null, truncated: false}`; dead/
/// unreadable folder -> `{path, tree: null, truncated: false}`; live folder ->
/// `{path, tree: Some(entries), truncated}` via `core::files::tree_of`, cached
/// per folder in `files_tree_cache`. Never a 5xx for any of these three
/// states.
async fn get_project_files(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let (path, is_dir) = project_files_root(&state, id).await?;
    if !is_dir {
        return Ok(Json(ProjectFileTree {
            path,
            tree: None,
            truncated: false,
        })
        .into_response());
    }
    let dir = path.clone().expect("is_dir true implies path is Some");
    let cached = {
        let cache = state.files_tree_cache.lock().unwrap();
        cache
            .get(&dir)
            .filter(|(at, _)| at.elapsed() < GIT_TTL)
            .map(|(_, v)| v.clone())
    };
    let (entries, truncated) = match cached {
        Some(v) => v,
        None => {
            // Walking a large repo isn't free; keep it off the async workers,
            // same rationale as the git subprocess calls above.
            let d = dir.clone();
            let v = tokio::task::spawn_blocking(move || files::tree_of(&d))
                .await
                .unwrap_or_else(|_| (Vec::new(), false));
            let mut cache = state.files_tree_cache.lock().unwrap();
            if cache.len() >= 64 {
                cache.retain(|_, (at, _)| at.elapsed() < GIT_TTL);
            }
            cache.insert(dir.clone(), (Instant::now(), v.clone()));
            v
        }
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
fn require_local_path_write(
    state: &AppState,
    addr: &SocketAddr,
    headers: &HeaderMap,
) -> Result<(), ApiError> {
    require_loopback(addr).map_err(|_| ApiError {
        status: StatusCode::FORBIDDEN,
        code: "validation",
        message: "local_path is an agent execution anchor; it can only be set from this machine"
            .into(),
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
    if let Ok(sock) = host.parse::<SocketAddr>() {
        if sock.port() == port {
            return Ok(());
        }
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
    let job =
        tokio::task::spawn_blocking(move || agents::spawn_bg(&dir, body.prompt.as_deref(), None))
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
async fn bridge_attach(mut socket: WebSocket, id: String, size: PtySize) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty.openpty(size).map_err(|e| format!("openpty: {e}"))?;
    let mut cmd = CommandBuilder::new(agents::claude_bin());
    cmd.args(["attach", &id]);
    cmd.env("TERM", "xterm-256color");
    // Give the child a stable cwd: attach resolves the job from claude's
    // global registry, and the server's own cwd may be anywhere.
    if let Some(dirs) = directories::BaseDirs::new() {
        cmd.cwd(dirs.home_dir());
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn claude attach: {e}"))?;
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
    //! The `--lan` agent-access gate. These are peer-address-sensitive, which
    //! `scripts/agents-check.sh` cannot exercise (a same-machine curl is always
    //! a loopback peer), so the cross-origin-attach hole lives or dies here.
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
            files_tree_cache: Arc::new(Mutex::new(HashMap::new())),
            restart_requested: Arc::new(AtomicBool::new(false)),
            shutdown_tx: Arc::new(Mutex::new(None)),
        };
        (dir, state)
    }

    fn new_project(state: &AppState, local_path: Option<&str>) -> i64 {
        state
            .store
            .lock()
            .unwrap()
            .create_project("proj", None, None, local_path)
            .unwrap()
            .id
    }

    async fn json_body(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn files_no_local_path_is_null_tree() {
        let (_dir, state) = test_state();
        let id = new_project(&state, None);
        let resp = get_project_files(State(state), Path(id)).await.unwrap();
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
        let resp = get_project_files(State(state), Path(id)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = json_body(resp).await;
        assert_eq!(body["path"], serde_json::json!(gone));
        assert_eq!(body["tree"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn files_live_folder_returns_tree() {
        let (dir, state) = test_state();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        std::fs::write(root.join("sub/b.rs"), "fn main() {}").unwrap();
        let root_str = root.to_str().unwrap().to_string();
        let id = new_project(&state, Some(&root_str));

        let resp = get_project_files(State(state), Path(id)).await.unwrap();
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
        let children = sub["children"].as_array().unwrap();
        assert_eq!(children[0]["path"], "sub/b.rs");
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
}
