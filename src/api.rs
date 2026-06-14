//! HTTP API: an axum router under `/api` over the same `Store` as the CLI.
//!
//! Contract (spec Requirements 7 and 8):
//! - Bound to 127.0.0.1; requests whose `Host` header is not
//!   `localhost:<port>` or `127.0.0.1:<port>` are rejected (DNS rebinding).
//! - Mutating methods (POST/PUT/PATCH/DELETE) require
//!   `Content-Type: application/json` (cross-site form posts).
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
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Deserializer};
use serde_json::json;

use crate::core::{Error, Priority, Project, ProjectPatch, Status, Store, TaskPatch, TaskSummary};

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
}

/// Opens the default store and serves the API on 127.0.0.1:<port>, blocking
/// until the process is killed.
pub fn serve(port: u16) -> crate::core::Result<()> {
    let store = Store::open_default()?;
    let state = AppState {
        store: Arc::new(Mutex::new(store)),
        port,
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        println!(
            "{}",
            json!({"listening": format!("http://127.0.0.1:{port}")})
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
        .route("/api/projects/{id}/docs", get(list_docs))
        .route("/api/projects/{id}/docs/{*path}", get(show_doc))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            get(show_task).patch(update_task).delete(delete_task),
        )
        .route("/api/tasks/{id}/block", post(block_task))
        .route("/api/tasks/{id}/unblock", post(unblock_task))
        .route("/api/tasks/{id}/dependencies", get(list_dependencies))
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
async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let port = state.port;
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
    #[serde(default)]
    docs_path: Option<String>,
}

#[derive(Deserialize)]
struct ProjectUpdate {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    docs_path: Option<Option<String>>,
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
    let project = store.create_project(
        &body.name,
        body.description.as_deref(),
        body.docs_path.as_deref(),
    )?;
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
        docs_path: body.docs_path,
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

// ---- project docs (spec Requirements 4 and 5: read-only viewer routes) ----

/// Resolves the project's docs directory or fails with the Requirement 4
/// error contract: unset docs_path → 422 validation, missing directory → 404.
fn docs_root(project: &Project) -> ApiResult<std::path::PathBuf> {
    let Some(docs_path) = &project.docs_path else {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: format!("project {} has no docs_path configured", project.id),
        });
    };
    let root = std::path::PathBuf::from(docs_path);
    if !root.is_dir() {
        return Err(ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: format!("docs_path {docs_path} does not exist"),
        });
    }
    Ok(root)
}

/// Collects files under `dir` recursively as paths relative to `root`,
/// skipping dot-files and dot-directories (spec Assumption 1).
fn collect_docs(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<String>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_docs(root, &path, out)?;
        } else if path.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

/// Content-Type by extension; `text/plain` fallback (spec Requirement 5).
/// Deliberately no `image/svg+xml` or `text/html`: a viewer has no need to
/// serve script-bearing formats (spec Assumption 2).
fn doc_content_type(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("md") | Some("markdown") => "text/markdown; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        _ => "text/plain; charset=utf-8",
    }
}

async fn list_docs(State(state): State<AppState>, Path(id): Path<i64>) -> ApiResult<Response> {
    let project = state.store.lock().unwrap().get_project(id)?;
    let root = docs_root(&project)?;
    let mut paths = Vec::new();
    collect_docs(&root, &root, &mut paths).map_err(Error::Io)?;
    paths.sort();
    Ok(Json(paths).into_response())
}

async fn show_doc(
    State(state): State<AppState>,
    Path((id, path)): Path<(i64, String)>,
) -> ApiResult<Response> {
    let project = state.store.lock().unwrap().get_project(id)?;
    let root = docs_root(&project)?;
    let not_found = || ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: format!("doc {path} not found"),
    };
    // Mechanical confinement (spec Requirement 5): canonicalize both ends
    // and require the target to sit under the root — rejecting `..`,
    // absolute paths, and symlinks escaping the docs directory alike.
    let root = root.canonicalize().map_err(|_| not_found())?;
    let target = root.join(&path).canonicalize().map_err(|_| not_found())?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(not_found());
    }
    let bytes = std::fs::read(&target).map_err(Error::Io)?;
    Ok((
        [(header::CONTENT_TYPE, doc_content_type(&path))],
        bytes,
    )
        .into_response())
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
