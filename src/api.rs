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
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Deserializer};
use serde_json::json;

use crate::core::{
    AgentSession, AgentSpawned, CcDashboard, CcUsage, EdgePatch, Error, FrameNew, FramePatch,
    PostPatch, Priority, ProjectAgents, ProjectPatch, Status, Store, StoryboardPatch, TaskPatch,
    TaskSummary, agents,
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
    /// CC Dashboard cache, keyed by window. Each entry pairs the newest
    /// transcript mtime seen when it was built with the dashboard; a request
    /// re-parses only when new activity has landed (parsing thousands of
    /// transcript files per request is otherwise too slow). Read-only data —
    /// not the mesa store, so no `Store` write path is involved.
    cc_cache: Arc<Mutex<HashMap<String, (i64, CcDashboard)>>>,
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
    /// Bumped whenever a spawn invalidates the list cache. A concurrent list
    /// whose subprocess started before the spawn checks this before caching,
    /// so it can't reinsert a pre-spawn snapshot after the invalidation and
    /// briefly hide the just-created session.
    agents_gen: Arc<AtomicU64>,
}

/// Opens the default store and serves the API, blocking until the process is
/// killed. Binds 127.0.0.1 by default; with `lan`, binds 0.0.0.0 so other
/// devices on the local network can reach it (no auth — see `serve --help`).
pub fn serve(port: u16, lan: bool) -> crate::core::Result<()> {
    let store = Store::open_default()?;
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
        port,
        lan,
        cc_cache: Arc::new(Mutex::new(HashMap::new())),
        usage_cache: Arc::new(Mutex::new(None)),
        usage_lock: Arc::new(tokio::sync::Mutex::new(())),
        usage_refreshing: Arc::new(AtomicBool::new(false)),
        agents_cache: Arc::new(Mutex::new(HashMap::new())),
        agents_gen: Arc::new(AtomicU64::new(0)),
    };
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        println!(
            "{}",
            json!({"listening": format!("http://{host}:{port}")})
        );
        // ConnectInfo carries the peer address so the agent endpoints and
        // local_path writes can be gated on loopback in default mode (see
        // `require_agent_access` / `require_local_path_write`).
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
        Ok(())
    })
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/resolve", get(resolve_project))
        .route(
            "/api/projects/{id}",
            get(show_project).patch(update_project).delete(delete_project),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            get(show_task).patch(update_task).delete(delete_task),
        )
        .route("/api/tasks/{id}/block", post(block_task))
        .route("/api/tasks/{id}/unblock", post(unblock_task))
        .route("/api/tasks/{id}/dependencies", get(list_dependencies))
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
        .route("/api/posts", get(list_posts).post(create_post))
        .route(
            "/api/posts/{id}",
            get(show_post).patch(update_post).delete(delete_post),
        )
        .route("/api/posts/{id}/replies", post(reply_post))
        .route("/api/inbox", get(list_inbox).post(create_inbox))
        .route(
            "/api/inbox/{id}",
            get(show_inbox).patch(assign_inbox).delete(delete_inbox),
        )
        // Agents: live Claude Code sessions under a project's folder. All
        // three routes share `require_agent_access` (terminal access = code
        // execution): loopback-only in default mode, LAN-page-authenticated
        // under `--lan`.
        .route(
            "/api/projects/{id}/agents",
            get(list_project_agents).post(spawn_project_agent),
        )
        .route("/api/agents/{id}/attach", get(attach_agent))
        // CC Dashboard: read-only Claude Code telemetry (no Store access).
        .route("/api/cc/usage", get(get_cc_usage))
        .route("/api/cc", get(get_cc_dashboard))
        // Live sessions: cheap, frequently-polled slice of the telemetry.
        .route("/api/cc/live", get(get_cc_live))
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

async fn show_project(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
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

async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
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
        body.status,
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
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_task(id, &patch)?).into_response())
}

async fn delete_task(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_task(id)?).into_response())
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
    let patch = EdgePatch { label: body.label };
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

// ---- posts (bulletin board) ----

#[derive(Deserialize)]
struct PostQuery {
    #[serde(default)]
    project: Option<i64>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct PostCreate {
    project_id: i64,
    body: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct ReplyCreate {
    body: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    author: Option<String>,
}

#[derive(Deserialize)]
struct PostUpdate {
    #[serde(default)]
    body: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    tag: Option<Option<String>>,
}

async fn list_posts(
    State(state): State<AppState>,
    Query(q): Query<PostQuery>,
) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.list_posts(q.project, q.tag.as_deref(), q.author.as_deref())?).into_response())
}

async fn create_post(
    State(state): State<AppState>,
    body: Result<Json<PostCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let post = store.create_post(
        body.project_id,
        body.author.as_deref(),
        body.title.as_deref(),
        body.tag.as_deref(),
        &body.body,
    )?;
    Ok((StatusCode::CREATED, Json(post)).into_response())
}

/// Reply to a post; the reply inherits the target's project.
async fn reply_post(
    State(state): State<AppState>,
    Path(parent_id): Path<i64>,
    body: Result<Json<ReplyCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let post = store.reply_to_post(
        parent_id,
        body.author.as_deref(),
        body.title.as_deref(),
        body.tag.as_deref(),
        &body.body,
    )?;
    Ok((StatusCode::CREATED, Json(post)).into_response())
}

/// Returns a post with its replies: {post, replies}.
async fn show_post(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let store = state.store.lock().unwrap();
    Ok(Json(store.get_post_thread(id)?).into_response())
}

async fn update_post(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<PostUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let patch = PostPatch {
        title: body.title,
        tag: body.tag,
        body: body.body,
    };
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.update_post(id, &patch)?).into_response())
}

async fn delete_post(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_post(id)?).into_response())
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
    if host.strip_prefix("localhost:").and_then(|p| p.parse::<u16>().ok()) == Some(port) {
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
    let job = tokio::task::spawn_blocking(move || agents::spawn_bg(&dir, body.prompt.as_deref()))
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

/// Returns the CC telemetry dashboard for the requested window, served from an
/// in-memory cache that is invalidated when a transcript file changes.
async fn get_cc_dashboard(
    State(state): State<AppState>,
    Query(q): Query<CcQuery>,
) -> ApiResult<Response> {
    let window = q.window.unwrap_or_else(|| "30d".to_string());
    let newest = crate::core::cc::newest_mtime();
    {
        let cache = state.cc_cache.lock().unwrap();
        if let Some((mtime, dash)) = cache.get(&window)
            && *mtime == newest
        {
            return Ok(Json(dash.clone()).into_response());
        }
    }
    let mut dash = crate::core::cc::collect(&window);
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
        cache.insert(window, (newest, dash.clone()));
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
}
