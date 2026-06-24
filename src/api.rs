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
use std::sync::{Arc, Mutex};

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Deserializer};
use serde_json::json;

use crate::core::{
    CcDashboard, CcUsage, EdgePatch, Error, FrameNew, FramePatch, PostPatch, Priority,
    ProjectPatch, Status, Store, StoryboardPatch, TaskPatch, TaskSummary,
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
    /// outbound calls. Read-only live data — not the mesa store.
    usage_cache: Arc<Mutex<Option<(i64, CcUsage)>>>,
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
        axum::serve(listener, router(state)).await?;
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
}

#[derive(Deserialize)]
struct ProjectUpdate {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    root_commit: Option<Option<String>>,
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
    body: Result<Json<ProjectCreate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let project =
        store.create_project(&body.name, body.description.as_deref(), body.root_commit.as_deref())?;
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
    Path(id): Path<i64>,
    body: Result<Json<ProjectUpdate>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let patch = ProjectPatch {
        name: body.name,
        description: body.description,
        root_commit: body.root_commit,
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
    /// `Some(Some(id))` assigns to a project; `Some(None)` clears the
    /// assignment; an absent field leaves it unchanged.
    #[serde(default, deserialize_with = "double_option")]
    project_id: Option<Option<i64>>,
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

/// Routes an item to a project, or clears it. PATCH semantics: an absent
/// `project_id` is a no-op (the item is returned unchanged).
async fn assign_inbox(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Result<Json<InboxAssign>, JsonRejection>,
) -> ApiResult<Response> {
    let Json(body) = body?;
    let mut store = state.store.lock().unwrap();
    let item = match body.project_id {
        Some(target) => store.assign_inbox_item(id, target)?,
        None => store.get_inbox_item(id)?,
    };
    Ok(Json(item).into_response())
}

async fn delete_inbox(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut store = state.store.lock().unwrap();
    Ok(Json(store.delete_inbox_item(id)?).into_response())
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
    {
        let cache = state.usage_cache.lock().unwrap();
        if let Some((at, usage)) = cache.as_ref()
            && now - *at < USAGE_TTL_SECS
        {
            return Ok(Json(usage.clone()).into_response());
        }
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
    {
        let mut cache = state.usage_cache.lock().unwrap();
        *cache = Some((now, usage.clone()));
    }
    Ok(Json(usage).into_response())
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
