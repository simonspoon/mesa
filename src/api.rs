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
    EdgePatch, Error, FrameNew, FramePatch, Priority, ProjectPatch, Status, Store, StoryboardPatch,
    TaskPatch, TaskSummary,
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
}

#[derive(Deserialize)]
struct ProjectUpdate {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
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
    let project = store.create_project(&body.name, body.description.as_deref())?;
    Ok((StatusCode::CREATED, Json(project)).into_response())
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
