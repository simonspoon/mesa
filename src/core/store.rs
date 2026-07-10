use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::attachments;
use super::types::{
    Attachment, Frame, FrameEdge, InboxItem, Priority, Project, Status, Storyboard,
    StoryboardEvent, StoryboardView, Task, TaskEvent, Waypoint,
};

#[derive(Debug)]
pub enum Error {
    NotFound(String),
    Validation(String),
    Cycle(String),
    Conflict(String),
    Db(rusqlite::Error),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound(m) | Error::Validation(m) | Error::Cycle(m) | Error::Conflict(m) => {
                f.write_str(m)
            }
            Error::Db(e) => write!(f, "database error: {e}"),
            Error::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// MESA_DB if set and non-empty, else ~/Library/Application Support/mesa/mesa.db
/// (macOS). An empty MESA_DB counts as unset: SQLite treats the path "" as a
/// private anonymous temp db, so honoring it would silently answer from an
/// empty database instead of the real one.
pub fn default_db_path() -> PathBuf {
    match std::env::var("MESA_DB") {
        Ok(p) if !p.is_empty() => return PathBuf::from(p),
        _ => {}
    }
    let dirs = directories::ProjectDirs::from("", "", "mesa")
        .expect("could not determine application data directory");
    dirs.data_dir().join("mesa.db")
}

const MIGRATIONS: &[&str] = &[
    "
    CREATE TABLE projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT
    );
    CREATE TABLE tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'todo',
        priority    TEXT NOT NULL DEFAULT 'medium',
        tags        TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE dependencies (
        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        blocked_by INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, blocked_by)
    );
",
    "ALTER TABLE projects ADD COLUMN docs_path TEXT;",
    "
    ALTER TABLE tasks ADD COLUMN acceptance TEXT;
    ALTER TABLE tasks ADD COLUMN artifact TEXT;
    ALTER TABLE tasks ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z';
    ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z';
    CREATE TABLE task_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        at          TEXT NOT NULL
    );
    ",
    "ALTER TABLE projects DROP COLUMN docs_path;",
    "
    CREATE TABLE storyboards (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        description TEXT,
        author      TEXT,
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    CREATE TABLE frames (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        storyboard_id INTEGER NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        body          TEXT,
        x             REAL NOT NULL DEFAULT 0,
        y             REAL NOT NULL DEFAULT 0,
        w             REAL NOT NULL DEFAULT 240,
        h             REAL NOT NULL DEFAULT 140,
        color         TEXT,
        task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        author        TEXT,
        created_at    TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at    TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    CREATE TABLE frame_edges (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        storyboard_id INTEGER NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
        from_frame    INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
        to_frame      INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
        label         TEXT,
        author        TEXT,
        created_at    TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    ",
    "
    CREATE TABLE storyboard_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        storyboard_id INTEGER NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
        actor         TEXT,
        action        TEXT NOT NULL,
        summary       TEXT NOT NULL,
        at            TEXT NOT NULL
    );
    ",
    "
    CREATE TABLE posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id   INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        author      TEXT,
        title       TEXT,
        tag         TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    ",
    "
    ALTER TABLE projects ADD COLUMN root_commit TEXT;
    CREATE UNIQUE INDEX idx_projects_root_commit
        ON projects(root_commit) WHERE root_commit IS NOT NULL;
    ",
    "
    CREATE TABLE inbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        author      TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    ",
    "
    ALTER TABLE projects ADD COLUMN local_path TEXT;
    ",
    "
    DROP TABLE posts;
    ",
    "
    CREATE TABLE cc_sessions (
        session_id    TEXT PRIMARY KEY,
        cwd           TEXT,
        git_branch    TEXT,
        entrypoint    TEXT,
        used_subagent INTEGER NOT NULL DEFAULT 0,
        start_ts      INTEGER,
        end_ts        INTEGER
    );
    CREATE TABLE cc_agent_runs (
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        agent       TEXT,
        skill       TEXT,
        PRIMARY KEY (session_id, agent_id)
    );
    CREATE TABLE cc_messages (
        uuid          TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        agent_id      TEXT,
        ts            INTEGER NOT NULL,
        model         TEXT NOT NULL,
        input_tokens          INTEGER NOT NULL,
        output_tokens         INTEGER NOT NULL,
        cache_read_tokens     INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        skill         TEXT,
        agent         TEXT
    );
    CREATE INDEX idx_cc_messages_session ON cc_messages(session_id);
    CREATE INDEX idx_cc_messages_ts      ON cc_messages(ts);
    CREATE TABLE cc_tool_calls (
        tool_use_id  TEXT PRIMARY KEY,
        message_uuid TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        agent_id     TEXT,
        name         TEXT NOT NULL,
        caller       TEXT,
        ts           INTEGER NOT NULL
    );
    CREATE INDEX idx_cc_tool_calls_session ON cc_tool_calls(session_id);
    CREATE INDEX idx_cc_tool_calls_ts      ON cc_tool_calls(ts);
    CREATE TABLE cc_files (
        path        TEXT PRIMARY KEY,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL
    );
    ",
    "
    CREATE TABLE attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename     TEXT NOT NULL,
        content_type TEXT,
        size_bytes   INTEGER NOT NULL,
        author       TEXT,
        created_at   TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    CREATE INDEX idx_attachments_task ON attachments(task_id);
    ",
    "ALTER TABLE frame_edges ADD COLUMN waypoints TEXT;",
];

/// Selects full task rows including the derived `blocked` flag.
const TASK_COLUMNS: &str = "t.id, t.project_id, t.parent_id, t.title, t.description, \
     t.status, t.priority, t.tags, \
     t.acceptance, t.artifact, t.created_at, t.updated_at, \
     EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocked_by \
            WHERE d.task_id = t.id AND b.status NOT IN ('done', 'cancelled'))";

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let status: String = row.get(5)?;
    let priority: String = row.get(6)?;
    let tags: String = row.get(7)?;
    Ok(Task {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        status: Status::parse(&status).expect("invalid status in db"),
        priority: Priority::parse(&priority).expect("invalid priority in db"),
        tags: serde_json::from_str(&tags).expect("invalid tags json in db"),
        acceptance: row.get(8)?,
        artifact: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        blocked: row.get(12)?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskEvent> {
    let from_status: Option<String> = row.get(2)?;
    let to_status: String = row.get(3)?;
    Ok(TaskEvent {
        id: row.get(0)?,
        task_id: row.get(1)?,
        from_status: from_status.map(|s| Status::parse(&s).expect("invalid status in db")),
        to_status: Status::parse(&to_status).expect("invalid status in db"),
        at: row.get(4)?,
    })
}

const PROJECT_COLUMNS: &str = "id, name, description, root_commit, local_path";

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        root_commit: row.get(3)?,
        local_path: row.get(4)?,
    })
}

const STORYBOARD_COLUMNS: &str =
    "id, project_id, title, description, author, created_at, updated_at";
const FRAME_COLUMNS: &str =
    "id, storyboard_id, title, body, x, y, w, h, color, task_id, author, created_at, updated_at";
const EDGE_COLUMNS: &str =
    "id, storyboard_id, from_frame, to_frame, label, author, created_at, waypoints";
const STORYBOARD_EVENT_COLUMNS: &str = "id, storyboard_id, actor, action, summary, at";
const INBOX_COLUMNS: &str = "id, project_id, author, body, created_at, updated_at";

fn row_to_inbox_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxItem> {
    Ok(InboxItem {
        id: row.get(0)?,
        project_id: row.get(1)?,
        author: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const ATTACHMENT_COLUMNS: &str =
    "id, task_id, filename, content_type, size_bytes, author, created_at";

fn row_to_attachment(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        filename: row.get(2)?,
        content_type: row.get(3)?,
        size_bytes: row.get(4)?,
        author: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// Splits an inbox item's free-text body into a `(title, description)` pair for
/// the task it converts into. The title is the first non-empty line, trimmed and
/// truncated to 120 chars (an ellipsis marks a cut); the description is the full
/// body verbatim, kept only when it carries more than the title (multi-line or
/// truncated) so a one-line item doesn't duplicate itself.
fn inbox_body_to_task(body: &str) -> (String, Option<String>) {
    let first = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let title: String = if first.chars().count() > 120 {
        first.chars().take(119).collect::<String>() + "…"
    } else {
        first.to_string()
    };
    let description = if body.trim() == title {
        None
    } else {
        Some(body.to_string())
    };
    (title, description)
}

fn row_to_storyboard(row: &rusqlite::Row<'_>) -> rusqlite::Result<Storyboard> {
    Ok(Storyboard {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        author: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn row_to_frame(row: &rusqlite::Row<'_>) -> rusqlite::Result<Frame> {
    Ok(Frame {
        id: row.get(0)?,
        storyboard_id: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        x: row.get(4)?,
        y: row.get(5)?,
        w: row.get(6)?,
        h: row.get(7)?,
        color: row.get(8)?,
        task_id: row.get(9)?,
        author: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn row_to_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<FrameEdge> {
    let waypoints_json: Option<String> = row.get(7)?;
    let waypoints = waypoints_json
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Vec<Waypoint>>(s).ok())
        .unwrap_or_default();
    Ok(FrameEdge {
        id: row.get(0)?,
        storyboard_id: row.get(1)?,
        from_frame: row.get(2)?,
        to_frame: row.get(3)?,
        label: row.get(4)?,
        author: row.get(5)?,
        created_at: row.get(6)?,
        waypoints,
    })
}

fn row_to_storyboard_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoryboardEvent> {
    Ok(StoryboardEvent {
        id: row.get(0)?,
        storyboard_id: row.get(1)?,
        actor: row.get(2)?,
        action: row.get(3)?,
        summary: row.get(4)?,
        at: row.get(5)?,
    })
}

/// Appends one change-history row for a storyboard. Operates on any
/// `Connection` (including an open transaction) so a mutation and its event
/// commit atomically.
fn insert_storyboard_event(
    conn: &Connection,
    storyboard_id: i64,
    actor: Option<&str>,
    action: &str,
    summary: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO storyboard_events (storyboard_id, actor, action, summary, at) \
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        (storyboard_id, actor, action, summary),
    )?;
    Ok(())
}

/// Reads a storyboard's frames, ordered by id. Operates on any `Connection`
/// (including an open transaction) so a delete can echo an atomic snapshot.
fn read_frames(conn: &Connection, storyboard_id: i64) -> Result<Vec<Frame>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FRAME_COLUMNS} FROM frames WHERE storyboard_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([storyboard_id], row_to_frame)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Reads a storyboard's edges, ordered by id. Operates on any `Connection`
/// (including an open transaction).
fn read_edges(conn: &Connection, storyboard_id: i64) -> Result<Vec<FrameEdge>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EDGE_COLUMNS} FROM frame_edges WHERE storyboard_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([storyboard_id], row_to_edge)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Fields to change on a project; `None` means leave unchanged.
#[derive(Debug, Default, Clone)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
    /// `Some(None)` clears the binding; `Some(Some(hash))` (re)binds. Binding a
    /// hash already held by another project is a `conflict`.
    pub root_commit: Option<Option<String>>,
    /// `Some(None)` clears the last-known working folder; `Some(Some(dir))`
    /// records it. Machine-local, not unique — no conflict checking.
    pub local_path: Option<Option<String>>,
}

/// Fields to change on a task; `None` means leave unchanged.
/// A task's project is immutable: there is deliberately no `project_id` field.
#[derive(Debug, Default, Clone)]
pub struct TaskPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
    pub status: Option<Status>,
    pub priority: Option<Priority>,
    /// Replaces the full tag set.
    pub tags: Option<Vec<String>>,
    /// `Some(None)` detaches the task from its parent.
    pub parent_id: Option<Option<i64>>,
    /// `Some(None)` clears the acceptance (definition-of-done) field.
    pub acceptance: Option<Option<String>>,
    /// `Some(None)` clears the artifact (work-receipt) field.
    pub artifact: Option<Option<String>>,
}

/// Fields to change on a storyboard; `None` means leave unchanged. A
/// storyboard's project and `author` (its creator) are immutable, so there is
/// deliberately no field for either.
#[derive(Debug, Default, Clone)]
pub struct StoryboardPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
}

/// A new frame to add to a storyboard. Coordinates and size are caller-supplied
/// (the CLI/API apply sensible defaults); `task_id`, if given, must reference a
/// task in the storyboard's project.
#[derive(Debug, Clone)]
pub struct FrameNew {
    pub title: String,
    pub body: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: Option<String>,
    pub task_id: Option<i64>,
    pub author: Option<String>,
}

/// Fields to change on a frame; `None` means leave unchanged. A frame's
/// storyboard and `author` are immutable.
#[derive(Debug, Default, Clone)]
pub struct FramePatch {
    pub title: Option<String>,
    /// `Some(None)` clears the body.
    pub body: Option<Option<String>>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    /// `Some(None)` clears the colour.
    pub color: Option<Option<String>>,
    /// `Some(None)` unlinks the frame from its task.
    pub task_id: Option<Option<i64>>,
}

/// Fields to change on an edge; `None` means leave unchanged. Only the label
/// and waypoints are mutable — endpoints and author are fixed at creation.
#[derive(Debug, Default, Clone)]
pub struct EdgePatch {
    /// `Some(None)` clears the label.
    pub label: Option<Option<String>>,
    /// `Some(vec)` replaces the full ordered waypoint list (including
    /// `Some(vec![])` to clear back to a straight auto-routed edge).
    /// `None` leaves the stored waypoints untouched.
    pub waypoints: Option<Vec<Waypoint>>,
}

/// Result of `next_task`: either the single actionable task, or — when none is
/// actionable — the status counts that distinguish the terminal states.
pub enum NextResult {
    Task(Box<Task>),
    None {
        blocked: i64,
        in_progress: i64,
        todo: i64,
    },
}

/// One task in an `import` document. `parent` and `blocked_by` reference other
/// tasks in the same document by their client-supplied `ref`; they are resolved
/// to real ids during import.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportTask {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub acceptance: Option<String>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub blocked_by: Option<Vec<String>>,
}

/// An `import` document: one project and a list of tasks forming a graph.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImportDoc {
    pub project: i64,
    pub tasks: Vec<ImportTask>,
}

// ---- CC telemetry ingest inputs (see `cc_ingest_file`) ----
//
// Plain structs the transcript parser (`core::cc`) folds a file into; `cc.rs`
// never holds a raw connection — every cc SQL statement lives here.

/// Per-file ingest cursor row (`cc_files`): how far a transcript has been
/// ingested. Purely an optimization — correctness comes from the upsert keys,
/// so a lost or stale cursor can only cost re-parsing, never duplicates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcFileCursor {
    /// File mtime (unix seconds) as of last ingest.
    pub mtime: i64,
    /// File size in bytes as of last ingest.
    pub size: i64,
    /// Bytes fully ingested (end of the last complete line parsed).
    pub byte_offset: i64,
}

/// One transcript file's parsed telemetry, ready to upsert in one transaction.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CcFileBatch {
    pub sessions: Vec<CcSessionUpsert>,
    pub agent_runs: Vec<CcAgentRunUpsert>,
    pub messages: Vec<CcMessageRow>,
    pub tool_calls: Vec<CcToolCallRow>,
}

/// Session-level facts folded from a file's lines. Merge semantics on
/// conflict: keep-first for `cwd`/`git_branch`/`entrypoint`, OR for
/// `used_subagent`, min/max for the span — all idempotent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcSessionUpsert {
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub entrypoint: Option<String>,
    pub used_subagent: bool,
    /// Min over ALL timestamped lines seen (unix seconds).
    pub start_ts: Option<i64>,
    /// Max over ALL timestamped lines seen (unix seconds).
    pub end_ts: Option<i64>,
}

/// One subagent run under a parent session. Keyed `(session_id, agent_id)`;
/// `agent`/`skill` attribution is keep-first on conflict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcAgentRunUpsert {
    pub session_id: String,
    pub agent_id: String,
    pub agent: Option<String>,
    pub skill: Option<String>,
}

/// One assistant usage event. Keyed by the event `uuid`; re-inserting is a
/// no-op. Tokens only — cost is derived from the price table at read time,
/// never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcMessageRow {
    pub uuid: String,
    pub session_id: String,
    /// `None` = main thread; `Some` attributes the message to a subagent run.
    pub agent_id: Option<String>,
    pub ts: i64,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub skill: Option<String>,
    pub agent: Option<String>,
}

/// One tool_use block. Keyed by `tool_use_id`; re-inserting is a no-op.
/// `message_uuid` is a plain column (a tool_use can sit on an event that
/// carries no usage, hence no `cc_messages` row). Input payloads are never
/// stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcToolCallRow {
    pub tool_use_id: String,
    pub message_uuid: String,
    pub session_id: String,
    /// `None` = main thread.
    pub agent_id: Option<String>,
    pub name: String,
    pub caller: Option<String>,
    pub ts: i64,
}

/// One `cc_sessions` row as read back for the dashboard (`cc_read_sessions`).
/// Same fields as [`CcSessionUpsert`], but a distinct type so the read and
/// write contracts can drift independently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcSessionRecord {
    pub session_id: String,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub entrypoint: Option<String>,
    pub used_subagent: bool,
    pub start_ts: Option<i64>,
    pub end_ts: Option<i64>,
}

/// Rows actually inserted by one `cc_ingest_file` call (conflict-no-ops
/// excluded), from rusqlite `changes()` per statement.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CcIngestCounts {
    pub messages_added: i64,
    pub tool_calls_added: i64,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    pub fn open_default() -> Result<Store> {
        Store::open(&default_db_path())
    }

    // ---- projects ----

    pub fn create_project(
        &mut self,
        name: &str,
        description: Option<&str>,
        root_commit: Option<&str>,
        local_path: Option<&str>,
    ) -> Result<Project> {
        if let Some(hash) = root_commit {
            self.ensure_commit_free(hash, None)?;
        }
        self.conn
            .execute(
                "INSERT INTO projects (name, description, root_commit, local_path) \
                 VALUES (?1, ?2, ?3, ?4)",
                (name, description, root_commit, local_path),
            )
            .map_err(|e| match root_commit {
                Some(hash) => Self::map_commit_conflict(e, hash),
                None => Error::Db(e),
            })?;
        self.get_project(self.conn.last_insert_rowid())
    }

    pub fn get_project(&self, id: i64) -> Result<Project> {
        self.conn
            .query_row(
                &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"),
                [id],
                row_to_project,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("project {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects ORDER BY id"
        ))?;
        let rows = stmt.query_map([], row_to_project)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Resolves the project bound to a repo's root commit hash, if any.
    pub fn find_project_by_root_commit(&self, root_commit: &str) -> Result<Project> {
        self.conn
            .query_row(
                &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE root_commit = ?1"),
                [root_commit],
                row_to_project,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("no project bound to root commit {root_commit}"))
                }
                e => Error::Db(e),
            })
    }

    /// Resolves a project by its name (case-insensitive exact match). Project
    /// names are not unique, so more than one match is `conflict` — the caller
    /// must fall back to the numeric id.
    pub fn find_project_by_name(&self, name: &str) -> Result<Project> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects WHERE name = ?1 COLLATE NOCASE ORDER BY id"
        ))?;
        let matches = stmt
            .query_map([name], row_to_project)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        match matches.len() {
            0 => Err(Error::NotFound(format!(
                "no project named {name:?}; pass a project id or an existing name \
                 (see `mesa project list`)"
            ))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => Err(Error::Conflict(format!(
                "{} projects are named {name:?} (ids {}); use the id",
                matches.len(),
                matches
                    .iter()
                    .map(|p| p.id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// Translates a `root_commit` unique-index violation into a clean
    /// `Conflict`. `ensure_commit_free` catches the common case before the
    /// write; this catches the race where a concurrent writer (CLI vs API)
    /// binds the same hash between our check and our write, so the loser still
    /// gets `conflict` instead of a raw DB error (HTTP 500).
    fn map_commit_conflict(e: rusqlite::Error, hash: &str) -> Error {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::ConstraintViolation {
                return Error::Conflict(format!(
                    "root commit {hash} is already bound to another project"
                ));
            }
        }
        Error::Db(e)
    }

    /// Errors with `conflict` if `hash` is already bound to a project other than
    /// `except` (the project being updated, when rebinding to its own value).
    fn ensure_commit_free(&self, hash: &str, except: Option<i64>) -> Result<()> {
        match self.find_project_by_root_commit(hash) {
            Ok(p) if Some(p.id) != except => Err(Error::Conflict(format!(
                "root commit {hash} is already bound to project {}; \
                 resolve it instead of creating a duplicate",
                p.id
            ))),
            Ok(_) | Err(Error::NotFound(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn update_project(&mut self, id: i64, patch: &ProjectPatch) -> Result<Project> {
        let mut project = self.get_project(id)?;
        if let Some(name) = &patch.name {
            project.name = name.clone();
        }
        if let Some(description) = &patch.description {
            project.description = description.clone();
        }
        if let Some(root_commit) = &patch.root_commit {
            if let Some(hash) = root_commit {
                self.ensure_commit_free(hash, Some(id))?;
            }
            project.root_commit = root_commit.clone();
        }
        if let Some(local_path) = &patch.local_path {
            project.local_path = local_path.clone();
        }
        self.conn
            .execute(
                "UPDATE projects SET name = ?1, description = ?2, root_commit = ?3, \
                 local_path = ?4 WHERE id = ?5",
                (
                    &project.name,
                    &project.description,
                    &project.root_commit,
                    &project.local_path,
                    id,
                ),
            )
            .map_err(|e| match &project.root_commit {
                Some(hash) => Self::map_commit_conflict(e, hash),
                None => Error::Db(e),
            })?;
        Ok(project)
    }

    /// Deletes the project and all its tasks; returns the destroyed records.
    pub fn delete_project(&mut self, id: i64) -> Result<(Project, Vec<Task>)> {
        let project = self.get_project(id)?;
        let tx = self.conn.transaction()?;
        let tasks = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM tasks t WHERE t.project_id = ?1 ORDER BY t.id"
            ))?;
            let rows = stmt.query_map([id], row_to_task)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok((project, tasks))
    }

    // ---- tasks ----

    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &mut self,
        project_id: i64,
        title: &str,
        description: Option<&str>,
        priority: Priority,
        tags: &[String],
        parent_id: Option<i64>,
        acceptance: Option<&str>,
        artifact: Option<&str>,
        status: Option<Status>,
    ) -> Result<Task> {
        let project_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Err(Error::Validation(format!("project {project_id} not found")));
        }
        if let Some(pid) = parent_id {
            self.check_parent(pid, project_id)?;
        }
        let tags_json = serde_json::to_string(tags).expect("tags serialize");
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO tasks \
             (project_id, parent_id, title, description, priority, tags, acceptance, artifact, \
              status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))",
            (
                project_id,
                parent_id,
                title,
                description,
                priority.as_str(),
                tags_json,
                acceptance,
                artifact,
                status.unwrap_or(Status::Todo).as_str(),
            ),
        )?;
        let id = tx.last_insert_rowid();
        // Creation event: NULL from_status -> the row's initial (default) status.
        let initial_status: String =
            tx.query_row("SELECT status FROM tasks WHERE id = ?1", [id], |r| r.get(0))?;
        tx.execute(
            "INSERT INTO task_events (task_id, from_status, to_status, at) \
             VALUES (?1, NULL, ?2, datetime('now'))",
            (id, initial_status),
        )?;
        tx.commit()?;
        self.get_task(id)
    }

    pub fn get_task(&self, id: i64) -> Result<Task> {
        self.conn
            .query_row(
                &format!("SELECT {TASK_COLUMNS} FROM tasks t WHERE t.id = ?1"),
                [id],
                row_to_task,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(self.task_not_found_message(id))
                }
                e => Error::Db(e),
            })
    }

    /// A not-found message with a lead: the id-nearest existing task, so a
    /// typo'd id self-corrects instead of dead-ending.
    fn task_not_found_message(&self, id: i64) -> String {
        let nearest = self.conn.query_row(
            "SELECT id, title FROM tasks ORDER BY ABS(id - ?1), id LIMIT 1",
            [id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        );
        match nearest {
            Ok((near_id, title)) => {
                let short: String = title.chars().take(60).collect();
                let ellipsis = if title.chars().count() > 60 {
                    "…"
                } else {
                    ""
                };
                format!(
                    "task {id} not found; nearest existing task is {near_id} \"{short}{ellipsis}\""
                )
            }
            Err(_) => format!("task {id} not found; no tasks exist yet"),
        }
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {TASK_COLUMNS} FROM tasks t ORDER BY t.id"))?;
        let rows = stmt.query_map([], row_to_task)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_task(&mut self, id: i64, patch: &TaskPatch) -> Result<Task> {
        let mut task = self.get_task(id)?;
        let old_status = task.status;
        if let Some(title) = &patch.title {
            task.title = title.clone();
        }
        if let Some(description) = &patch.description {
            task.description = description.clone();
        }
        if let Some(status) = patch.status {
            task.status = status;
        }
        if let Some(priority) = patch.priority {
            task.priority = priority;
        }
        if let Some(tags) = &patch.tags {
            task.tags = tags.clone();
        }
        if let Some(parent_id) = patch.parent_id {
            if let Some(pid) = parent_id {
                if pid == id {
                    return Err(Error::Validation(format!(
                        "task {id} cannot be its own parent"
                    )));
                }
                self.check_parent(pid, task.project_id)?;
            }
            task.parent_id = parent_id;
        }
        if let Some(acceptance) = &patch.acceptance {
            task.acceptance = acceptance.clone();
        }
        if let Some(artifact) = &patch.artifact {
            task.artifact = artifact.clone();
        }
        let tags_json = serde_json::to_string(&task.tags).expect("tags serialize");
        let status_changed = task.status != old_status;
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE tasks SET title = ?1, description = ?2, status = ?3, priority = ?4, \
             tags = ?5, parent_id = ?6, acceptance = ?7, artifact = ?8, \
             updated_at = datetime('now') WHERE id = ?9",
            (
                &task.title,
                &task.description,
                task.status.as_str(),
                task.priority.as_str(),
                tags_json,
                task.parent_id,
                &task.acceptance,
                &task.artifact,
                id,
            ),
        )?;
        if status_changed {
            tx.execute(
                "INSERT INTO task_events (task_id, from_status, to_status, at) \
                 VALUES (?1, ?2, ?3, datetime('now'))",
                (id, old_status.as_str(), task.status.as_str()),
            )?;
        }
        tx.commit()?;
        // Re-read: a status change can alter dependents' (and this task's) blocked flag.
        self.get_task(id)
    }

    /// Deletes the task and all its subtasks (recursively); returns the
    /// destroyed records, the task itself first.
    pub fn delete_task(&mut self, id: i64) -> Result<Vec<Task>> {
        self.get_task(id)?;
        let tx = self.conn.transaction()?;
        let tasks = {
            let mut stmt = tx.prepare(&format!(
                "WITH RECURSIVE sub(sid) AS ( \
                     SELECT id FROM tasks WHERE id = ?1 \
                     UNION \
                     SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.sid \
                 ) \
                 SELECT {TASK_COLUMNS} FROM tasks t JOIN sub ON t.id = sub.sid \
                 ORDER BY t.id != ?1, t.id"
            ))?;
            let rows = stmt.query_map([id], row_to_task)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // Attachment files for the task and all its subtasks, read before the
        // delete commits (same "read paths before commit, unlink after
        // commit" rule as `delete_attachment`, applied transitively). The
        // `attachments.task_id` FK is `ON DELETE CASCADE`, so the DB rows drop
        // automatically with the tasks; only the on-disk files need explicit
        // cleanup here.
        let attachment_files: Vec<(i64, i64, String)> = {
            let mut stmt = tx.prepare(
                "WITH RECURSIVE sub(sid) AS ( \
                     SELECT id FROM tasks WHERE id = ?1 \
                     UNION \
                     SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.sid \
                 ) \
                 SELECT a.task_id, a.id, a.filename FROM attachments a JOIN sub ON a.task_id = sub.sid",
            )?;
            let rows = stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
        tx.commit()?;
        for (task_id, attachment_id, filename) in attachment_files {
            let path = attachments::attachment_path(task_id, attachment_id, &filename);
            let _ = std::fs::remove_file(&path);
        }
        Ok(tasks)
    }

    /// Imports a task graph atomically: every task and dependency is created in
    /// one transaction, or nothing is. Tasks reference each other by their
    /// client-supplied `ref` (resolved to real ids here), so a dependency need
    /// not know the created id in advance. All `create`-time validations apply
    /// per task (project exists; parent in same project; no self-edge or cycle,
    /// including cycles formed within the imported graph). Refs (`parent`,
    /// `blocked_by`) must be defined in the document.
    pub fn import_tasks(&mut self, doc: &ImportDoc) -> Result<Vec<Task>> {
        let project_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [doc.project],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Err(Error::Validation(format!(
                "project {} not found",
                doc.project
            )));
        }
        // Duplicate refs would make resolution ambiguous.
        let mut refs: HashMap<&str, i64> = HashMap::new();
        for t in &doc.tasks {
            if refs.insert(t.ref_.as_str(), 0).is_some() {
                return Err(Error::Validation(format!(
                    "duplicate task ref \"{}\" in import document",
                    t.ref_
                )));
            }
        }

        let tx = self.conn.transaction()?;
        // Pass 1: insert tasks in document order, recording ref -> real id.
        // Parent refs are resolved here (a parent must be defined earlier or
        // later in the doc, so resolve against the full map after this pass).
        for t in &doc.tasks {
            let priority = t.priority.unwrap_or(Priority::Medium);
            let tags = t.tags.clone().unwrap_or_default();
            let tags_json = serde_json::to_string(&tags).expect("tags serialize");
            tx.execute(
                "INSERT INTO tasks \
                 (project_id, title, description, priority, tags, acceptance, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))",
                (
                    doc.project,
                    &t.title,
                    &t.description,
                    priority.as_str(),
                    tags_json,
                    &t.acceptance,
                ),
            )?;
            let id = tx.last_insert_rowid();
            let initial_status: String =
                tx.query_row("SELECT status FROM tasks WHERE id = ?1", [id], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO task_events (task_id, from_status, to_status, at) \
                 VALUES (?1, NULL, ?2, datetime('now'))",
                (id, initial_status),
            )?;
            *refs.get_mut(t.ref_.as_str()).unwrap() = id;
        }

        // Pass 2: wire parents and dependencies against the resolved map.
        let resolve = |r: &str| -> Result<i64> {
            refs.get(r).copied().ok_or_else(|| {
                Error::Validation(format!(
                    "task ref \"{r}\" referenced but not defined in import document"
                ))
            })
        };
        for t in &doc.tasks {
            let id = refs[t.ref_.as_str()];
            if let Some(parent_ref) = &t.parent {
                let parent_id = resolve(parent_ref)?;
                check_parent(&tx, parent_id, doc.project)?;
                tx.execute(
                    "UPDATE tasks SET parent_id = ?1 WHERE id = ?2",
                    (parent_id, id),
                )?;
            }
            for blocker_ref in t.blocked_by.iter().flatten() {
                let blocker_id = resolve(blocker_ref)?;
                if blocker_id == id {
                    return Err(Error::Cycle(format!(
                        "task ref \"{}\" cannot be blocked by itself",
                        t.ref_
                    )));
                }
                if would_cycle(&tx, id, blocker_id)? {
                    return Err(Error::Cycle(format!(
                        "blocking task ref \"{}\" on task ref \"{}\" would create a \
                         dependency cycle",
                        t.ref_, blocker_ref
                    )));
                }
                tx.execute(
                    "INSERT OR IGNORE INTO dependencies (task_id, blocked_by) VALUES (?1, ?2)",
                    (id, blocker_id),
                )?;
            }
        }

        let created = {
            let placeholders = std::iter::repeat_n("?", doc.tasks.len())
                .collect::<Vec<_>>()
                .join(",");
            let ids: Vec<i64> = doc.tasks.iter().map(|t| refs[t.ref_.as_str()]).collect();
            let mut stmt = tx.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM tasks t WHERE t.id IN ({placeholders}) ORDER BY t.id"
            ))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(ids), row_to_task)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(created)
    }

    /// Selects the next actionable task: status `todo` and not blocked, within
    /// the `project` filter if given. Order: priority (high>medium>low) then
    /// ascending id; the first is returned. If none is actionable, returns the
    /// status counts (scoped to the same filter) so the caller can tell "all
    /// done" from "stuck/blocked" from "work in flight".
    pub fn next_task(&self, project: Option<i64>) -> Result<NextResult> {
        let blocked_expr = "EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocked_by \
             WHERE d.task_id = t.id AND b.status NOT IN ('done', 'cancelled'))";
        let priority_rank = "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";
        let task = {
            let sql = format!(
                "SELECT {TASK_COLUMNS} FROM tasks t \
                 WHERE t.status = 'todo' AND NOT {blocked_expr} \
                 AND (?1 IS NULL OR t.project_id = ?1) \
                 ORDER BY {priority_rank}, t.id LIMIT 1"
            );
            self.conn
                .query_row(&sql, [project], row_to_task)
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    e => Err(Error::Db(e)),
                })?
        };
        if let Some(task) = task {
            return Ok(NextResult::Task(Box::new(task)));
        }
        // No actionable task: count by status / blocked within the filter.
        let count = |predicate: &str| -> Result<i64> {
            let sql = format!(
                "SELECT COUNT(*) FROM tasks t \
                 WHERE (?1 IS NULL OR t.project_id = ?1) AND {predicate}"
            );
            Ok(self.conn.query_row(&sql, [project], |r| r.get(0))?)
        };
        Ok(NextResult::None {
            blocked: count(&format!("t.status = 'todo' AND {blocked_expr}"))?,
            in_progress: count("t.status = 'in_progress'")?,
            todo: count(&format!("t.status = 'todo' AND NOT {blocked_expr}"))?,
        })
    }

    /// Lists status-change events, oldest first. For one task if `task_id` is
    /// given, else across all tasks. Returns `NotFound` if the task is absent.
    pub fn list_events(&self, task_id: Option<i64>) -> Result<Vec<TaskEvent>> {
        if let Some(id) = task_id {
            self.get_task(id)?;
            let mut stmt = self.conn.prepare(
                "SELECT id, task_id, from_status, to_status, at FROM task_events \
                 WHERE task_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map([id], row_to_event)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, task_id, from_status, to_status, at FROM task_events ORDER BY id",
            )?;
            let rows = stmt.query_map([], row_to_event)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }
    }

    fn check_parent(&self, parent_id: i64, project_id: i64) -> Result<()> {
        check_parent(&self.conn, parent_id, project_id)
    }

    // ---- dependencies ----

    /// Makes `task_id` blocked by `blocker_id`. Idempotent for an existing
    /// edge; rejects self-edges and anything that would close a cycle.
    pub fn add_dependency(&mut self, task_id: i64, blocker_id: i64) -> Result<Task> {
        self.get_task(task_id)?;
        if task_id == blocker_id {
            return Err(Error::Cycle(format!(
                "task {task_id} cannot be blocked by itself"
            )));
        }
        if let Err(Error::NotFound(_)) = self.get_task(blocker_id) {
            return Err(Error::Validation(format!(
                "blocker task {blocker_id} not found"
            )));
        }
        if self.would_cycle(task_id, blocker_id)? {
            return Err(Error::Cycle(format!(
                "blocking task {task_id} on task {blocker_id} would create a dependency cycle: \
                 task {blocker_id} is already blocked, directly or transitively, by task {task_id}"
            )));
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO dependencies (task_id, blocked_by) VALUES (?1, ?2)",
            (task_id, blocker_id),
        )?;
        self.get_task(task_id)
    }

    /// Removes the edge making `task_id` blocked by `blocker_id`.
    pub fn remove_dependency(&mut self, task_id: i64, blocker_id: i64) -> Result<Task> {
        self.get_task(task_id)?;
        let n = self.conn.execute(
            "DELETE FROM dependencies WHERE task_id = ?1 AND blocked_by = ?2",
            (task_id, blocker_id),
        )?;
        if n == 0 {
            return Err(Error::NotFound(format!(
                "task {task_id} is not blocked by task {blocker_id}"
            )));
        }
        self.get_task(task_id)
    }

    /// Lists the tasks that `task_id` is directly blocked by.
    pub fn list_blockers(&self, task_id: i64) -> Result<Vec<Task>> {
        self.get_task(task_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks t \
             JOIN dependencies d ON d.blocked_by = t.id \
             WHERE d.task_id = ?1 ORDER BY t.id"
        ))?;
        let rows = stmt.query_map([task_id], row_to_task)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// True if a path blocker_id -> ... -> task_id already exists along
    /// blocked-by edges, i.e. adding (task_id blocked by blocker_id) would
    /// close a cycle. DFS over the full edge set.
    fn would_cycle(&self, task_id: i64, blocker_id: i64) -> Result<bool> {
        would_cycle(&self.conn, task_id, blocker_id)
    }

    // ---- attachments ----

    /// Creates an attachment on `task_id`: validates the task exists and the
    /// content fits the per-file cap, inserts the DB row, writes the bytes to
    /// disk, and only then commits — a failed write rolls the transaction
    /// back on drop, so a disk failure never leaves an orphan DB row (mirror
    /// of `delete_attachment`'s commit-then-unlink ordering).
    pub fn create_attachment(
        &mut self,
        task_id: i64,
        filename: &str,
        bytes: &[u8],
        author: Option<&str>,
    ) -> Result<Attachment> {
        self.get_task(task_id)?;
        if bytes.len() as u64 > attachments::MAX_ATTACHMENT_BYTES {
            return Err(Error::Validation(format!(
                "attachment {} bytes exceeds the {} byte limit",
                bytes.len(),
                attachments::MAX_ATTACHMENT_BYTES
            )));
        }
        let content_type = attachments::guess_content_type(filename);
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO attachments (task_id, filename, content_type, size_bytes, author, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            (task_id, filename, &content_type, bytes.len() as i64, author),
        )?;
        let id = tx.last_insert_rowid();
        let path = attachments::attachment_path(task_id, id, filename);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes)?;
        tx.commit()?;
        self.get_attachment(id)
    }

    pub fn get_attachment(&self, id: i64) -> Result<Attachment> {
        self.conn
            .query_row(
                &format!("SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1"),
                [id],
                row_to_attachment,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("attachment {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Lists a task's attachments, oldest first. 404s if the task itself
    /// doesn't exist (matches the repo's "the named parent must exist" posture
    /// for scoped listings).
    pub fn list_attachments(&self, task_id: i64) -> Result<Vec<Attachment>> {
        self.get_task(task_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE task_id = ?1 ORDER BY id"
        ))?;
        let rows = stmt.query_map([task_id], row_to_attachment)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Reads an attachment's metadata plus its bytes off disk, for `fetch`/
    /// `download`. A DB row with no file on disk (only possible via manual
    /// tampering with the data directory) surfaces `NotFound` — the closest
    /// existing error code, no new variant needed.
    pub fn attachment_bytes(&self, id: i64) -> Result<(Attachment, Vec<u8>)> {
        let attachment = self.get_attachment(id)?;
        let path =
            attachments::attachment_path(attachment.task_id, attachment.id, &attachment.filename);
        let bytes = std::fs::read(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound(format!(
                    "attachment {id} file missing on disk at {}",
                    path.display()
                ))
            } else {
                Error::Io(e)
            }
        })?;
        Ok((attachment, bytes))
    }

    /// Deletes one attachment: the DB delete commits first (the authoritative
    /// step), then the on-disk file is unlinked best-effort — tolerating an
    /// already-missing file and swallowing any other unlink error, since the
    /// DB commit already succeeded and is the source of truth. Returns the
    /// row as it was before deletion.
    pub fn delete_attachment(&mut self, id: i64) -> Result<Attachment> {
        let attachment = self.get_attachment(id)?;
        let path =
            attachments::attachment_path(attachment.task_id, attachment.id, &attachment.filename);
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM attachments WHERE id = ?1", [id])?;
        tx.commit()?;
        // Best-effort: the DB commit already succeeded and is the source of
        // truth, so a missing file (already gone) or any other unlink error
        // is swallowed rather than reported as a failed delete.
        let _ = std::fs::remove_file(&path);
        Ok(attachment)
    }

    // ---- storyboards ----

    /// Creates a storyboard in an existing project. The project is fixed at
    /// creation (immutable thereafter), mirroring tasks.
    pub fn create_storyboard(
        &mut self,
        project_id: i64,
        title: &str,
        description: Option<&str>,
        author: Option<&str>,
    ) -> Result<Storyboard> {
        let project_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Err(Error::Validation(format!("project {project_id} not found")));
        }
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO storyboards (project_id, title, description, author, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
                (project_id, title, description, author),
            )?;
            let id = tx.last_insert_rowid();
            insert_storyboard_event(
                &tx,
                id,
                author,
                "storyboard_created",
                &format!("created storyboard '{title}'"),
            )?;
            tx.commit()?;
            id
        };
        self.get_storyboard(id)
    }

    pub fn get_storyboard(&self, id: i64) -> Result<Storyboard> {
        self.conn
            .query_row(
                &format!("SELECT {STORYBOARD_COLUMNS} FROM storyboards WHERE id = ?1"),
                [id],
                row_to_storyboard,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("storyboard {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Lists storyboards, newest activity is not implied — ordered by id.
    /// Scoped to `project` if given. Frames and edges are omitted (the compact
    /// list shape); use `get_storyboard_view` for a board's full contents.
    pub fn list_storyboards(&self, project: Option<i64>) -> Result<Vec<Storyboard>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {STORYBOARD_COLUMNS} FROM storyboards \
             WHERE (?1 IS NULL OR project_id = ?1) ORDER BY id"
        ))?;
        let rows = stmt.query_map([project], row_to_storyboard)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Returns a board's full contents: the storyboard plus its frames and
    /// edges (each ordered by id). `NotFound` if the board is absent.
    pub fn get_storyboard_view(&self, id: i64) -> Result<StoryboardView> {
        let storyboard = self.get_storyboard(id)?;
        let frames = read_frames(&self.conn, id)?;
        let edges = read_edges(&self.conn, id)?;
        Ok(StoryboardView {
            storyboard,
            frames,
            edges,
        })
    }

    pub fn update_storyboard(
        &mut self,
        id: i64,
        patch: &StoryboardPatch,
        actor: Option<&str>,
    ) -> Result<Storyboard> {
        let current = self.get_storyboard(id)?;
        let mut sb = current.clone();
        if let Some(title) = &patch.title {
            sb.title = title.clone();
        }
        if let Some(description) = &patch.description {
            sb.description = description.clone();
        }
        // No-op patch: change nothing and log nothing, so the history records
        // only real edits (and the CLI and API agree on the outcome).
        if sb == current {
            return Ok(current);
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE storyboards SET title = ?1, description = ?2, updated_at = datetime('now') \
             WHERE id = ?3",
            (&sb.title, &sb.description, id),
        )?;
        insert_storyboard_event(&tx, id, actor, "storyboard_edited", "edited board details")?;
        tx.commit()?;
        self.get_storyboard(id)
    }

    /// Deletes a storyboard and all its frames, edges, and history (cascade).
    /// Returns the full destroyed contents so the transcript stays a recoverable
    /// record. The echo read and the delete run in one transaction, so the
    /// echoed contents exactly match what was destroyed even under a concurrent
    /// writer. No change-history row is written: the board's history dies with
    /// it, and the delete echo is the recoverable record.
    pub fn delete_storyboard(&mut self, id: i64) -> Result<StoryboardView> {
        let tx = self.conn.transaction()?;
        let storyboard = tx
            .query_row(
                &format!("SELECT {STORYBOARD_COLUMNS} FROM storyboards WHERE id = ?1"),
                [id],
                row_to_storyboard,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("storyboard {id} not found"))
                }
                e => Error::Db(e),
            })?;
        let frames = read_frames(&tx, id)?;
        let edges = read_edges(&tx, id)?;
        tx.execute("DELETE FROM storyboards WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(StoryboardView {
            storyboard,
            frames,
            edges,
        })
    }

    /// Lists a storyboard's change history, oldest first. `NotFound` if the
    /// board is absent.
    pub fn list_storyboard_events(&self, storyboard_id: i64) -> Result<Vec<StoryboardEvent>> {
        self.get_storyboard(storyboard_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {STORYBOARD_EVENT_COLUMNS} FROM storyboard_events \
             WHERE storyboard_id = ?1 ORDER BY id"
        ))?;
        let rows = stmt.query_map([storyboard_id], row_to_storyboard_event)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- frames ----

    /// Adds a frame to an existing storyboard. An unknown storyboard is a
    /// validation error (the id is a request parameter, like a task's project).
    /// A `task_id`, if given, must reference a task in the board's project.
    pub fn create_frame(&mut self, storyboard_id: i64, new: &FrameNew) -> Result<Frame> {
        let project_id = match self.get_storyboard(storyboard_id) {
            Ok(sb) => sb.project_id,
            Err(Error::NotFound(_)) => {
                return Err(Error::Validation(format!(
                    "storyboard {storyboard_id} not found"
                )));
            }
            Err(e) => return Err(e),
        };
        if let Some(task_id) = new.task_id {
            self.check_frame_task(task_id, project_id)?;
        }
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO frames \
                 (storyboard_id, title, body, x, y, w, h, color, task_id, author, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'), datetime('now'))",
                rusqlite::params![
                    storyboard_id,
                    new.title,
                    new.body,
                    new.x,
                    new.y,
                    new.w,
                    new.h,
                    new.color,
                    new.task_id,
                    new.author,
                ],
            )?;
            let id = tx.last_insert_rowid();
            insert_storyboard_event(
                &tx,
                storyboard_id,
                new.author.as_deref(),
                "frame_added",
                &format!("added frame '{}' (#{id})", new.title),
            )?;
            tx.commit()?;
            id
        };
        self.get_frame(id)
    }

    pub fn get_frame(&self, id: i64) -> Result<Frame> {
        self.conn
            .query_row(
                &format!("SELECT {FRAME_COLUMNS} FROM frames WHERE id = ?1"),
                [id],
                row_to_frame,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("frame {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    pub fn update_frame(
        &mut self,
        id: i64,
        patch: &FramePatch,
        actor: Option<&str>,
    ) -> Result<Frame> {
        let current = self.get_frame(id)?;
        let mut f = current.clone();
        if let Some(title) = &patch.title {
            f.title = title.clone();
        }
        if let Some(body) = &patch.body {
            f.body = body.clone();
        }
        if let Some(x) = patch.x {
            f.x = x;
        }
        if let Some(y) = patch.y {
            f.y = y;
        }
        if let Some(w) = patch.w {
            f.w = w;
        }
        if let Some(h) = patch.h {
            f.h = h;
        }
        if let Some(color) = &patch.color {
            f.color = color.clone();
        }
        if let Some(task_id) = patch.task_id {
            if let Some(tid) = task_id {
                let sb = self.get_storyboard(f.storyboard_id)?;
                self.check_frame_task(tid, sb.project_id)?;
            }
            f.task_id = task_id;
        }
        // No-op patch (every field re-set to its current value): change nothing
        // and log nothing, so the history records only real edits.
        if f == current {
            return Ok(current);
        }
        // A change touching only geometry is a "move"; anything else is an edit.
        let only_geometry = patch.title.is_none()
            && patch.body.is_none()
            && patch.color.is_none()
            && patch.task_id.is_none()
            && (patch.x.is_some() || patch.y.is_some() || patch.w.is_some() || patch.h.is_some());
        let (action, summary) = if only_geometry {
            ("frame_moved", format!("moved frame '{}' (#{id})", f.title))
        } else {
            (
                "frame_edited",
                format!("edited frame '{}' (#{id})", f.title),
            )
        };
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE frames SET title = ?1, body = ?2, x = ?3, y = ?4, w = ?5, h = ?6, \
             color = ?7, task_id = ?8, updated_at = datetime('now') WHERE id = ?9",
            rusqlite::params![f.title, f.body, f.x, f.y, f.w, f.h, f.color, f.task_id, id,],
        )?;
        insert_storyboard_event(&tx, f.storyboard_id, actor, action, &summary)?;
        tx.commit()?;
        self.get_frame(id)
    }

    /// Deletes a frame and the edges touching it (cascade). Returns the frame
    /// and the destroyed edges so the transcript is a recoverable record.
    pub fn delete_frame(
        &mut self,
        id: i64,
        actor: Option<&str>,
    ) -> Result<(Frame, Vec<FrameEdge>)> {
        let frame = self.get_frame(id)?;
        let tx = self.conn.transaction()?;
        // Snapshot the touching edges and delete the frame in one transaction,
        // so the echo exactly matches the edges the cascade destroys.
        let edges = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {EDGE_COLUMNS} FROM frame_edges \
                 WHERE from_frame = ?1 OR to_frame = ?1 ORDER BY id"
            ))?;
            let rows = stmt.query_map([id], row_to_edge)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute("DELETE FROM frames WHERE id = ?1", [id])?;
        insert_storyboard_event(
            &tx,
            frame.storyboard_id,
            actor,
            "frame_removed",
            &format!("removed frame '{}' (#{id})", frame.title),
        )?;
        tx.commit()?;
        Ok((frame, edges))
    }

    /// Validates that `task_id` exists and belongs to `project_id` (a frame may
    /// only link a task in its board's project), mirroring `check_parent`.
    fn check_frame_task(&self, task_id: i64, project_id: i64) -> Result<()> {
        let task_project: Option<i64> = self
            .conn
            .query_row(
                "SELECT project_id FROM tasks WHERE id = ?1",
                [task_id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(Error::Db(e)),
            })?;
        let Some(task_project) = task_project else {
            return Err(Error::Validation(format!("task {task_id} not found")));
        };
        if task_project != project_id {
            return Err(Error::Validation(format!(
                "task {task_id} belongs to project {task_project}, not the storyboard's \
                 project {project_id}: a frame may only link a task in its own project"
            )));
        }
        Ok(())
    }

    // ---- edges ----

    /// Connects two frames of the same storyboard with a directed edge. Rejects
    /// an unknown board, a self-edge, or an endpoint that is not a frame of this
    /// board — all validation errors. Cycles are allowed.
    pub fn create_edge(
        &mut self,
        storyboard_id: i64,
        from_frame: i64,
        to_frame: i64,
        label: Option<&str>,
        author: Option<&str>,
    ) -> Result<FrameEdge> {
        let storyboard_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM storyboards WHERE id = ?1)",
            [storyboard_id],
            |r| r.get(0),
        )?;
        if !storyboard_exists {
            return Err(Error::Validation(format!(
                "storyboard {storyboard_id} not found"
            )));
        }
        if from_frame == to_frame {
            return Err(Error::Validation(format!(
                "frame {from_frame} cannot connect to itself"
            )));
        }
        self.check_frame_in_storyboard(from_frame, storyboard_id, "from")?;
        self.check_frame_in_storyboard(to_frame, storyboard_id, "to")?;
        let summary = match label {
            Some(l) if !l.is_empty() => {
                format!("connected #{from_frame} \u{2192} #{to_frame} ({l})")
            }
            _ => format!("connected #{from_frame} \u{2192} #{to_frame}"),
        };
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO frame_edges (storyboard_id, from_frame, to_frame, label, author, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
                (storyboard_id, from_frame, to_frame, label, author),
            )?;
            let id = tx.last_insert_rowid();
            insert_storyboard_event(&tx, storyboard_id, author, "edge_added", &summary)?;
            tx.commit()?;
            id
        };
        self.get_edge(id)
    }

    pub fn get_edge(&self, id: i64) -> Result<FrameEdge> {
        self.conn
            .query_row(
                &format!("SELECT {EDGE_COLUMNS} FROM frame_edges WHERE id = ?1"),
                [id],
                row_to_edge,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("edge {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    pub fn update_edge(
        &mut self,
        id: i64,
        patch: &EdgePatch,
        actor: Option<&str>,
    ) -> Result<FrameEdge> {
        let current = self.get_edge(id)?;
        let mut edge = current.clone();
        if let Some(label) = &patch.label {
            edge.label = label.clone();
        }
        if let Some(waypoints) = &patch.waypoints {
            edge.waypoints = waypoints.clone();
        }
        // No-op patch: change nothing and log nothing.
        if edge == current {
            return Ok(current);
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE frame_edges SET label = ?1, waypoints = ?2 WHERE id = ?3",
            (
                &edge.label,
                serde_json::to_string(&edge.waypoints).unwrap(),
                id,
            ),
        )?;
        let (action, summary) = if patch.waypoints.is_some() && edge.waypoints != current.waypoints
        {
            (
                "edge_rerouted",
                format!(
                    "rerouted edge #{} \u{2192} #{} ({} waypoint(s))",
                    edge.from_frame,
                    edge.to_frame,
                    edge.waypoints.len()
                ),
            )
        } else {
            (
                "edge_relabeled",
                format!(
                    "relabeled edge #{} \u{2192} #{}",
                    edge.from_frame, edge.to_frame
                ),
            )
        };
        insert_storyboard_event(&tx, edge.storyboard_id, actor, action, &summary)?;
        tx.commit()?;
        self.get_edge(id)
    }

    pub fn delete_edge(&mut self, id: i64, actor: Option<&str>) -> Result<FrameEdge> {
        let edge = self.get_edge(id)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM frame_edges WHERE id = ?1", [id])?;
        insert_storyboard_event(
            &tx,
            edge.storyboard_id,
            actor,
            "edge_removed",
            &format!(
                "removed edge #{} \u{2192} #{}",
                edge.from_frame, edge.to_frame
            ),
        )?;
        tx.commit()?;
        Ok(edge)
    }

    /// Validates that `frame_id` exists and belongs to `storyboard_id`. `which`
    /// ("from"/"to") names the offending endpoint in the error message.
    fn check_frame_in_storyboard(
        &self,
        frame_id: i64,
        storyboard_id: i64,
        which: &str,
    ) -> Result<()> {
        let frame_board: Option<i64> = self
            .conn
            .query_row(
                "SELECT storyboard_id FROM frames WHERE id = ?1",
                [frame_id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(Error::Db(e)),
            })?;
        let Some(frame_board) = frame_board else {
            return Err(Error::Validation(format!(
                "{which} frame {frame_id} not found"
            )));
        };
        if frame_board != storyboard_id {
            return Err(Error::Validation(format!(
                "{which} frame {frame_id} belongs to storyboard {frame_board}, not \
                 storyboard {storyboard_id}: an edge must connect two frames of the same board"
            )));
        }
        Ok(())
    }

    // ---- inbox (global update requests) ----

    /// Adds an item to the global inbox: a free-text update request not yet tied
    /// to any project. New items are always unassigned (`project_id` null); a
    /// person routes them to a project later via `assign_inbox_item`. The single
    /// write path for inbox items.
    pub fn create_inbox_item(&mut self, author: Option<&str>, body: &str) -> Result<InboxItem> {
        self.conn.execute(
            "INSERT INTO inbox (project_id, author, body, created_at, updated_at) \
             VALUES (NULL, ?1, ?2, datetime('now'), datetime('now'))",
            (author, body),
        )?;
        self.get_inbox_item(self.conn.last_insert_rowid())
    }

    pub fn get_inbox_item(&self, id: i64) -> Result<InboxItem> {
        self.conn
            .query_row(
                &format!("SELECT {INBOX_COLUMNS} FROM inbox WHERE id = ?1"),
                [id],
                row_to_inbox_item,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("inbox item {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Lists inbox items, newest first. With `project` given, only the items
    /// assigned to that project; otherwise the whole inbox (assigned and not).
    pub fn list_inbox_items(&self, project: Option<i64>) -> Result<Vec<InboxItem>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {INBOX_COLUMNS} FROM inbox \
             WHERE (?1 IS NULL OR project_id = ?1) ORDER BY id DESC"
        ))?;
        let rows = stmt.query_map([project], row_to_inbox_item)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Routes an inbox item to a project by **converting it into a todo task**
    /// in that project and then deleting the item — it "moves" out of the inbox
    /// and becomes actionable work on the board. The task's title is the item's
    /// body (first line, truncated), its description the full body verbatim;
    /// priority defaults to medium. Returns the created `Task`. Assigning to an
    /// unknown project is a `validation` error, mirroring a task's `--project`.
    /// Atomic: the task insert (with its creation event) and the inbox delete
    /// happen in one transaction, so a triaged item never vanishes without a
    /// task to show for it.
    pub fn assign_inbox_item(&mut self, id: i64, project_id: i64) -> Result<Task> {
        let item = self.get_inbox_item(id)?;
        let project_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Err(Error::Validation(format!("project {project_id} not found")));
        }
        let (title, description) = inbox_body_to_task(&item.body);
        let tx = self.conn.transaction()?;
        // Claim the item by deleting it FIRST, inside the transaction: if a
        // concurrent assign already converted it, this affects 0 rows and we
        // bail before creating a (duplicate) task. The body was read above and
        // is immutable, so reading it outside the tx is safe.
        let claimed = tx.execute("DELETE FROM inbox WHERE id = ?1", [id])?;
        if claimed == 0 {
            return Err(Error::NotFound(format!("inbox item {id} not found")));
        }
        tx.execute(
            "INSERT INTO tasks \
             (project_id, parent_id, title, description, priority, tags, acceptance, artifact, \
              created_at, updated_at) \
             VALUES (?1, NULL, ?2, ?3, ?4, '[]', NULL, NULL, datetime('now'), datetime('now'))",
            (
                project_id,
                &title,
                description.as_deref(),
                Priority::Medium.as_str(),
            ),
        )?;
        let task_id = tx.last_insert_rowid();
        // Creation event: NULL from_status -> the row's initial (default) status.
        let initial_status: String =
            tx.query_row("SELECT status FROM tasks WHERE id = ?1", [task_id], |r| {
                r.get(0)
            })?;
        tx.execute(
            "INSERT INTO task_events (task_id, from_status, to_status, at) \
             VALUES (?1, NULL, ?2, datetime('now'))",
            (task_id, initial_status),
        )?;
        tx.commit()?;
        self.get_task(task_id)
    }

    /// Deletes an inbox item; returns the destroyed record (the recoverable
    /// echo — there is no history table for the inbox).
    pub fn delete_inbox_item(&mut self, id: i64) -> Result<InboxItem> {
        let item = self.get_inbox_item(id)?;
        self.conn.execute("DELETE FROM inbox WHERE id = ?1", [id])?;
        Ok(item)
    }

    // ---- cc telemetry (the single write path for `cc_*` tables) ----

    /// All per-file ingest cursors, keyed by absolute transcript path.
    pub fn cc_cursors(&self) -> Result<HashMap<String, CcFileCursor>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, mtime, size, byte_offset FROM cc_files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                CcFileCursor {
                    mtime: r.get(1)?,
                    size: r.get(2)?,
                    byte_offset: r.get(3)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Upserts one transcript file's parsed telemetry and its cursor row in
    /// ONE transaction, so a crash mid-sync loses at most "this file not yet
    /// ingested", never a half-advanced cursor. Idempotent by construction:
    /// sessions merge (min/max span, OR `used_subagent`, keep-first text
    /// fields), agent runs keep-first, messages and tool calls insert-or-
    /// ignore on their stable keys — re-ingesting any line twice is a no-op.
    pub fn cc_ingest_file(
        &mut self,
        path: &str,
        cursor: &CcFileCursor,
        batch: &CcFileBatch,
    ) -> Result<CcIngestCounts> {
        let tx = self.conn.transaction()?;
        let mut counts = CcIngestCounts::default();
        {
            let mut sess = tx.prepare(
                "INSERT INTO cc_sessions \
                     (session_id, cwd, git_branch, entrypoint, used_subagent, start_ts, end_ts) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                     cwd           = COALESCE(cc_sessions.cwd, excluded.cwd), \
                     git_branch    = COALESCE(cc_sessions.git_branch, excluded.git_branch), \
                     entrypoint    = COALESCE(cc_sessions.entrypoint, excluded.entrypoint), \
                     used_subagent = MAX(cc_sessions.used_subagent, excluded.used_subagent), \
                     start_ts      = MIN(COALESCE(cc_sessions.start_ts, excluded.start_ts), \
                                         COALESCE(excluded.start_ts, cc_sessions.start_ts)), \
                     end_ts        = MAX(COALESCE(cc_sessions.end_ts, excluded.end_ts), \
                                         COALESCE(excluded.end_ts, cc_sessions.end_ts))",
            )?;
            for s in &batch.sessions {
                sess.execute((
                    &s.session_id,
                    &s.cwd,
                    &s.git_branch,
                    &s.entrypoint,
                    s.used_subagent,
                    s.start_ts,
                    s.end_ts,
                ))?;
            }

            let mut run = tx.prepare(
                "INSERT INTO cc_agent_runs (session_id, agent_id, agent, skill) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(session_id, agent_id) DO UPDATE SET \
                     agent = COALESCE(cc_agent_runs.agent, excluded.agent), \
                     skill = COALESCE(cc_agent_runs.skill, excluded.skill)",
            )?;
            for r in &batch.agent_runs {
                run.execute((&r.session_id, &r.agent_id, &r.agent, &r.skill))?;
            }

            let mut msg = tx.prepare(
                "INSERT INTO cc_messages \
                     (uuid, session_id, agent_id, ts, model, input_tokens, output_tokens, \
                      cache_read_tokens, cache_creation_tokens, skill, agent) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
                 ON CONFLICT(uuid) DO NOTHING",
            )?;
            for m in &batch.messages {
                counts.messages_added += msg.execute((
                    &m.uuid,
                    &m.session_id,
                    &m.agent_id,
                    m.ts,
                    &m.model,
                    m.input_tokens,
                    m.output_tokens,
                    m.cache_read_tokens,
                    m.cache_creation_tokens,
                    &m.skill,
                    &m.agent,
                ))? as i64;
            }

            let mut call = tx.prepare(
                "INSERT INTO cc_tool_calls \
                     (tool_use_id, message_uuid, session_id, agent_id, name, caller, ts) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(tool_use_id) DO NOTHING",
            )?;
            for c in &batch.tool_calls {
                counts.tool_calls_added += call.execute((
                    &c.tool_use_id,
                    &c.message_uuid,
                    &c.session_id,
                    &c.agent_id,
                    &c.name,
                    &c.caller,
                    c.ts,
                ))? as i64;
            }

            tx.execute(
                "INSERT INTO cc_files (path, mtime, size, byte_offset) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(path) DO UPDATE SET \
                     mtime = excluded.mtime, \
                     size = excluded.size, \
                     byte_offset = excluded.byte_offset",
                (path, cursor.mtime, cursor.size, cursor.byte_offset),
            )?;
        }
        tx.commit()?;
        Ok(counts)
    }

    // ---- cc telemetry reads (the dashboard's source of truth — `cc.rs`
    // aggregates these rows; it never opens a connection of its own) ----

    /// Sessions in the window: `end_ts >= cutoff` (an in-window message always
    /// implies this — a message's `ts` bounds the span — so no message join is
    /// needed). `cutoff = None` returns everything.
    pub fn cc_read_sessions(&self, cutoff: Option<i64>) -> Result<Vec<CcSessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, cwd, git_branch, entrypoint, used_subagent, start_ts, end_ts \
             FROM cc_sessions WHERE ?1 IS NULL OR end_ts >= ?1",
        )?;
        let rows = stmt.query_map([cutoff], |r| {
            Ok(CcSessionRecord {
                session_id: r.get(0)?,
                cwd: r.get(1)?,
                git_branch: r.get(2)?,
                entrypoint: r.get(3)?,
                used_subagent: r.get::<_, i64>(4)? != 0,
                start_ts: r.get(5)?,
                end_ts: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Message rows with `ts >= cutoff` (`None` = all).
    pub fn cc_read_messages(&self, cutoff: Option<i64>) -> Result<Vec<CcMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT uuid, session_id, agent_id, ts, model, input_tokens, output_tokens, \
                    cache_read_tokens, cache_creation_tokens, skill, agent \
             FROM cc_messages WHERE ?1 IS NULL OR ts >= ?1",
        )?;
        let rows = stmt.query_map([cutoff], |r| {
            Ok(CcMessageRow {
                uuid: r.get(0)?,
                session_id: r.get(1)?,
                agent_id: r.get(2)?,
                ts: r.get(3)?,
                model: r.get(4)?,
                input_tokens: r.get(5)?,
                output_tokens: r.get(6)?,
                cache_read_tokens: r.get(7)?,
                cache_creation_tokens: r.get(8)?,
                skill: r.get(9)?,
                agent: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Tool-call rows with `ts >= cutoff` (`None` = all).
    pub fn cc_read_tool_calls(&self, cutoff: Option<i64>) -> Result<Vec<CcToolCallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_use_id, message_uuid, session_id, agent_id, name, caller, ts \
             FROM cc_tool_calls WHERE ?1 IS NULL OR ts >= ?1",
        )?;
        let rows = stmt.query_map([cutoff], |r| {
            Ok(CcToolCallRow {
                tool_use_id: r.get(0)?,
                message_uuid: r.get(1)?,
                session_id: r.get(2)?,
                agent_id: r.get(3)?,
                name: r.get(4)?,
                caller: r.get(5)?,
                ts: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Subagent-run counts per session (all-time — runs carry no timestamp).
    pub fn cc_agent_run_counts(&self) -> Result<HashMap<String, i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id, COUNT(*) FROM cc_agent_runs GROUP BY session_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Monotone stamp of persisted cc state: total rows across `cc_messages`,
    /// `cc_tool_calls`, `cc_sessions`. cc rows are never deleted, so the stamp
    /// only grows; the API uses it as the dashboard cache key (a change by any
    /// process — CLI sync, cron — moves it, while transcript-file deletion,
    /// which must not invalidate the history-inclusive view, does not).
    pub fn cc_stamp(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM cc_messages)
                  + (SELECT COUNT(*) FROM cc_tool_calls)
                  + (SELECT COUNT(*) FROM cc_sessions)",
            [],
            |r| r.get(0),
        )?)
    }

    // ---- backup ----

    /// Snapshots the database to `path` via `VACUUM INTO` (safe under WAL).
    pub fn backup(&self, path: &Path) -> Result<()> {
        self.conn
            .execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
        Ok(())
    }
}

/// Validates that `parent_id` exists and shares `project_id`. Operates on any
/// `Connection` (including an open transaction) so import can reuse it.
fn check_parent(conn: &Connection, parent_id: i64, project_id: i64) -> Result<()> {
    let parent_project: Option<i64> = conn
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [parent_id],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(Error::Db(e)),
        })?;
    let Some(parent_project) = parent_project else {
        return Err(Error::Validation(format!(
            "parent task {parent_id} not found"
        )));
    };
    if parent_project != project_id {
        return Err(Error::Validation(format!(
            "parent task {parent_id} belongs to project {parent_project}, not project \
             {project_id}: a subtask must belong to the same project as its parent",
        )));
    }
    Ok(())
}

/// True if a path blocker_id -> ... -> task_id already exists along blocked-by
/// edges, i.e. adding (task_id blocked by blocker_id) would close a cycle. DFS
/// over the full edge set. Operates on any `Connection` (including an open
/// transaction) so import can reuse it.
fn would_cycle(conn: &Connection, task_id: i64, blocker_id: i64) -> Result<bool> {
    let mut edges: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT task_id, blocked_by FROM dependencies")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (from, to) = row?;
        edges.entry(from).or_default().push(to);
    }
    let mut seen = HashSet::new();
    let mut stack = vec![blocker_id];
    while let Some(node) = stack.pop() {
        if node == task_id {
            return Ok(true);
        }
        if seen.insert(node)
            && let Some(next) = edges.get(&node)
        {
            stack.extend(next);
        }
    }
    Ok(false)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        conn.execute_batch(sql)?;
        conn.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        (store, dir)
    }

    #[test]
    fn empty_mesa_db_env_counts_as_unset() {
        // Set + assert + restore in one test: env vars are process-global and
        // no other test reads MESA_DB.
        unsafe { std::env::set_var("MESA_DB", "") };
        let empty = default_db_path();
        assert!(
            empty.ends_with("mesa.db"),
            "empty MESA_DB must fall back to the default path, got {empty:?}"
        );
        unsafe { std::env::set_var("MESA_DB", "/tmp/explicit.db") };
        assert_eq!(default_db_path(), PathBuf::from("/tmp/explicit.db"));
        unsafe { std::env::remove_var("MESA_DB") };
    }

    fn add_task(store: &mut Store, project_id: i64, title: &str) -> Task {
        store
            .create_task(
                project_id,
                title,
                None,
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
    }

    #[test]
    fn project_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", Some("first"), None, None)
            .unwrap();
        assert_eq!(p.name, "alpha");
        assert_eq!(p.description.as_deref(), Some("first"));

        assert_eq!(store.get_project(p.id).unwrap(), p);
        assert_eq!(store.list_projects().unwrap(), vec![p.clone()]);

        let updated = store
            .update_project(
                p.id,
                &ProjectPatch {
                    name: Some("beta".into()),
                    description: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "beta");
        assert_eq!(updated.description, None);
        assert_eq!(store.get_project(p.id).unwrap(), updated);

        let (deleted, tasks) = store.delete_project(p.id).unwrap();
        assert_eq!(deleted, updated);
        assert!(tasks.is_empty());
        assert!(matches!(store.get_project(p.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn local_path_records_updates_and_clears() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", None, None, Some("/tmp/checkout"))
            .unwrap();
        assert_eq!(p.local_path.as_deref(), Some("/tmp/checkout"));
        assert_eq!(store.get_project(p.id).unwrap(), p);

        // Machine-local, not unique: two projects may share a folder.
        let q = store
            .create_project("beta", None, None, Some("/tmp/checkout"))
            .unwrap();
        assert_eq!(q.local_path.as_deref(), Some("/tmp/checkout"));

        // Patch semantics match description/root_commit: set, then clear.
        let moved = store
            .update_project(
                p.id,
                &ProjectPatch {
                    local_path: Some(Some("/tmp/elsewhere".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.local_path.as_deref(), Some("/tmp/elsewhere"));
        let cleared = store
            .update_project(
                p.id,
                &ProjectPatch {
                    local_path: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.local_path, None);
        assert_eq!(store.get_project(p.id).unwrap(), cleared);
    }

    #[test]
    fn find_project_by_name_matches_case_insensitively_and_flags_ambiguity() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("Alpha", None, None, None).unwrap();
        store.create_project("beta", None, None, None).unwrap();

        assert_eq!(store.find_project_by_name("alpha").unwrap(), p);
        assert!(matches!(
            store.find_project_by_name("gamma"),
            Err(Error::NotFound(_))
        ));

        // A duplicate name is ambiguous: the caller must use the id.
        store.create_project("ALPHA", None, None, None).unwrap();
        assert!(matches!(
            store.find_project_by_name("alpha"),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn root_commit_binds_resolves_and_rejects_duplicates() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", None, Some("abc123"), None)
            .unwrap();
        assert_eq!(p.root_commit.as_deref(), Some("abc123"));

        // Every checkout of the same source resolves to the one project.
        assert_eq!(store.find_project_by_root_commit("abc123").unwrap(), p);
        assert!(matches!(
            store.find_project_by_root_commit("nope"),
            Err(Error::NotFound(_))
        ));

        // The same source code must not spawn a second project.
        assert!(matches!(
            store.create_project("dup", None, Some("abc123"), None),
            Err(Error::Conflict(_))
        ));

        // Another project cannot steal the binding...
        let q = store.create_project("beta", None, None, None).unwrap();
        assert!(matches!(
            store.update_project(
                q.id,
                &ProjectPatch {
                    root_commit: Some(Some("abc123".into())),
                    ..Default::default()
                },
            ),
            Err(Error::Conflict(_))
        ));

        // ...but a project may rebind to its own current hash (idempotent),
        let same = store
            .update_project(
                p.id,
                &ProjectPatch {
                    root_commit: Some(Some("abc123".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(same.root_commit.as_deref(), Some("abc123"));

        // and clearing it frees the hash for another project.
        store
            .update_project(
                p.id,
                &ProjectPatch {
                    root_commit: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        let moved = store
            .update_project(
                q.id,
                &ProjectPatch {
                    root_commit: Some(Some("abc123".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.root_commit.as_deref(), Some("abc123"));
    }

    #[test]
    fn migration_2_preserves_v1_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v1.db");
        // Build a v1 database by hand: only the first migration applied.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO projects (name, description) VALUES ('old', 'kept')",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let projects = store.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "old");
        assert_eq!(projects[0].description.as_deref(), Some("kept"));
    }

    #[test]
    fn task_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = store
            .create_task(
                p.id,
                "write tests",
                Some("cover everything"),
                Priority::High,
                &["rust".into(), "tdd".into()],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(t.title, "write tests");
        assert_eq!(t.description.as_deref(), Some("cover everything"));
        assert_eq!(t.status, Status::Todo);
        assert_eq!(t.priority, Priority::High);
        assert_eq!(t.tags, vec!["rust", "tdd"]);
        assert_eq!(t.parent_id, None);
        assert!(!t.blocked);

        assert_eq!(store.get_task(t.id).unwrap(), t);
        assert_eq!(store.list_tasks().unwrap(), vec![t.clone()]);

        // --tags replaces the full set; description clears; status/priority change.
        let updated = store
            .update_task(
                t.id,
                &TaskPatch {
                    title: Some("write more tests".into()),
                    description: Some(None),
                    status: Some(Status::InProgress),
                    priority: Some(Priority::Low),
                    tags: Some(vec!["qa".into()]),
                    parent_id: None,
                    acceptance: None,
                    artifact: None,
                },
            )
            .unwrap();
        assert_eq!(updated.title, "write more tests");
        assert_eq!(updated.description, None);
        assert_eq!(updated.status, Status::InProgress);
        assert_eq!(updated.priority, Priority::Low);
        assert_eq!(updated.tags, vec!["qa"]);
        assert_eq!(store.get_task(t.id).unwrap(), updated);

        let deleted = store.delete_task(t.id).unwrap();
        assert_eq!(deleted, vec![updated]);
        assert!(matches!(store.get_task(t.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn task_not_found_message_leads_to_nearest_task() {
        let (mut store, _dir) = temp_store();

        // Empty db: no lead to give.
        let err = store.get_task(42).unwrap_err();
        assert!(matches!(&err, Error::NotFound(m) if m.contains("no tasks exist")));

        let p = store.create_project("alpha", None, None, None).unwrap();
        let t1 = add_task(&mut store, p.id, "close one");
        let _t2 = add_task(&mut store, p.id, "far away");

        // A typo'd id points at the id-nearest existing task.
        let err = store.get_task(t1.id + 100).unwrap_err();
        match &err {
            Error::NotFound(m) => {
                assert!(m.contains(&format!("nearest existing task is {}", t1.id + 1)));
                assert!(m.contains("far away"));
            }
            other => panic!("expected NotFound, got {other:?}"),
        }

        // Long titles are truncated in the lead.
        let long_title = "x".repeat(200);
        let t3 = add_task(&mut store, p.id, &long_title);
        let err = store.get_task(t3.id + 1).unwrap_err();
        match &err {
            Error::NotFound(m) => {
                assert!(m.contains(&"x".repeat(60)));
                assert!(!m.contains(&"x".repeat(61)));
                assert!(m.contains('…'));
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn create_task_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_task(
                999,
                "orphan",
                None,
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn create_with_status_lands_in_that_column_and_logs_creation_event() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = store
            .create_task(
                p.id,
                "in flight",
                None,
                Priority::Medium,
                &[],
                None,
                None,
                None,
                Some(Status::InProgress),
            )
            .unwrap();
        assert_eq!(t.status, Status::InProgress);

        // The creation event records the requested status (NULL from_status).
        let events = store.list_events(Some(t.id)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].from_status, None);
        assert_eq!(events[0].to_status, Status::InProgress);

        // None preserves the schema default (todo).
        let d = store
            .create_task(
                p.id,
                "later",
                None,
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(d.status, Status::Todo);
    }

    #[test]
    fn parent_must_be_in_same_project() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None).unwrap();
        let t1 = add_task(&mut store, p1.id, "in p1");
        let t2 = add_task(&mut store, p2.id, "in p2");

        // create: cross-project parent rejected
        let err = store
            .create_task(
                p2.id,
                "sub",
                None,
                Priority::Medium,
                &[],
                Some(t1.id),
                None,
                None,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // update: cross-project parent rejected
        let err = store
            .update_task(
                t2.id,
                &TaskPatch {
                    parent_id: Some(Some(t1.id)),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // same-project parent accepted, and can be detached again
        let sub = store
            .create_task(
                p1.id,
                "sub",
                None,
                Priority::Medium,
                &[],
                Some(t1.id),
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(sub.parent_id, Some(t1.id));
        let detached = store
            .update_task(
                sub.id,
                &TaskPatch {
                    parent_id: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(detached.parent_id, None);
    }

    #[test]
    fn delete_task_cascades_subtasks_and_returns_them() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(
                p.id,
                "child",
                None,
                Priority::Medium,
                &[],
                Some(root.id),
                None,
                None,
                None,
            )
            .unwrap();
        let grandchild = store
            .create_task(
                p.id,
                "grandchild",
                None,
                Priority::Medium,
                &[],
                Some(child.id),
                None,
                None,
                None,
            )
            .unwrap();
        let bystander = add_task(&mut store, p.id, "bystander");
        // bystander is blocked by child; the edge must go when child goes
        store.add_dependency(bystander.id, child.id).unwrap();

        let deleted = store.delete_task(root.id).unwrap();
        assert_eq!(deleted.len(), 3);
        assert_eq!(deleted[0].id, root.id); // the task itself first
        let ids: HashSet<i64> = deleted.iter().map(|t| t.id).collect();
        assert_eq!(ids, HashSet::from([root.id, child.id, grandchild.id]));
        assert_eq!(deleted[0].title, "root");

        assert!(matches!(store.get_task(child.id), Err(Error::NotFound(_))));
        assert!(matches!(
            store.get_task(grandchild.id),
            Err(Error::NotFound(_))
        ));
        // bystander survives and is no longer blocked (edge cascaded away)
        assert!(!store.get_task(bystander.id).unwrap().blocked);
    }

    /// Like `temp_store`, but also points `MESA_ATTACHMENTS_DIR` at a tempdir
    /// sibling of the test db (so attachment tests never touch the real data
    /// directory) and hands back `attachments::ENV_LOCK`'s guard — the caller
    /// must keep it alive (`let (store, _dir, _lock) = ...`) for its whole
    /// test body so no other test's env-var window overlaps (shared with
    /// `attachments.rs`'s own env-var test, since both touch the same var).
    fn attachment_test_store() -> (Store, tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
        let guard = attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (store, dir) = temp_store();
        // SAFETY: the ENV_LOCK guard gives this test exclusive access to the
        // env var for as long as it is held.
        unsafe { std::env::set_var("MESA_ATTACHMENTS_DIR", dir.path().join("attachments")) };
        (store, dir, guard)
    }

    #[test]
    fn attachment_crud_round_trip() {
        let (mut store, _dir, _lock) = attachment_test_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "task with files");

        let created = store
            .create_attachment(t.id, "notes.md", b"hello world", Some("simon"))
            .unwrap();
        assert_eq!(created.task_id, t.id);
        assert_eq!(created.filename, "notes.md");
        assert_eq!(created.content_type.as_deref(), Some("text/markdown"));
        assert_eq!(created.size_bytes, 11);
        assert_eq!(created.author.as_deref(), Some("simon"));

        assert_eq!(store.get_attachment(created.id).unwrap(), created);
        assert_eq!(store.list_attachments(t.id).unwrap(), vec![created.clone()]);

        let (meta, bytes) = store.attachment_bytes(created.id).unwrap();
        assert_eq!(meta, created);
        assert_eq!(bytes, b"hello world");

        let deleted = store.delete_attachment(created.id).unwrap();
        assert_eq!(deleted, created);
        assert!(matches!(
            store.get_attachment(created.id),
            Err(Error::NotFound(_))
        ));
        assert!(store.list_attachments(t.id).unwrap().is_empty());

        // the file is actually gone from disk
        let path = attachments::attachment_path(t.id, created.id, &created.filename);
        assert!(!path.exists());

        unsafe { std::env::remove_var("MESA_ATTACHMENTS_DIR") };
    }

    #[test]
    fn create_attachment_rejects_oversized_content() {
        let (mut store, _dir, _lock) = attachment_test_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "task");

        let oversized = vec![0u8; (attachments::MAX_ATTACHMENT_BYTES + 1) as usize];
        let err = store
            .create_attachment(t.id, "big.bin", &oversized, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(store.list_attachments(t.id).unwrap().is_empty());

        unsafe { std::env::remove_var("MESA_ATTACHMENTS_DIR") };
    }

    #[test]
    fn attachment_operations_on_missing_task_or_attachment_are_not_found() {
        let (mut store, _dir, _lock) = attachment_test_store();

        let err = store
            .create_attachment(999_999, "f.txt", b"x", None)
            .unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));

        let err = store.list_attachments(999_999).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));

        let err = store.get_attachment(999_999).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));

        let err = store.attachment_bytes(999_999).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));

        let err = store.delete_attachment(999_999).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));

        unsafe { std::env::remove_var("MESA_ATTACHMENTS_DIR") };
    }

    #[test]
    fn delete_task_cascade_unlinks_attachment_files_for_task_and_subtasks() {
        let (mut store, _dir, _lock) = attachment_test_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(
                p.id,
                "child",
                None,
                Priority::Medium,
                &[],
                Some(root.id),
                None,
                None,
                None,
            )
            .unwrap();

        let on_root = store
            .create_attachment(root.id, "root.txt", b"root bytes", None)
            .unwrap();
        let on_child = store
            .create_attachment(child.id, "child.txt", b"child bytes", None)
            .unwrap();

        let root_path = attachments::attachment_path(root.id, on_root.id, &on_root.filename);
        let child_path = attachments::attachment_path(child.id, on_child.id, &on_child.filename);
        assert!(root_path.exists());
        assert!(child_path.exists());

        store.delete_task(root.id).unwrap();

        assert!(!root_path.exists(), "root attachment file must be unlinked");
        assert!(
            !child_path.exists(),
            "subtask attachment file must be unlinked"
        );
        // DB rows are gone too (cascaded via the FK + the recursive delete).
        assert!(matches!(
            store.get_attachment(on_root.id),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            store.get_attachment(on_child.id),
            Err(Error::NotFound(_))
        ));

        unsafe { std::env::remove_var("MESA_ATTACHMENTS_DIR") };
    }

    #[test]
    fn delete_project_cascades_tasks_and_returns_them() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("doomed", Some("desc"), None, None)
            .unwrap();
        let keep = store.create_project("keeper", None, None, None).unwrap();
        let t1 = add_task(&mut store, p.id, "one");
        let t2 = store
            .create_task(
                p.id,
                "two",
                None,
                Priority::Medium,
                &[],
                Some(t1.id),
                None,
                None,
                None,
            )
            .unwrap();
        let survivor = add_task(&mut store, keep.id, "survivor");

        let (project, tasks) = store.delete_project(p.id).unwrap();
        assert_eq!(project.id, p.id);
        assert_eq!(project.name, "doomed");
        assert_eq!(project.description.as_deref(), Some("desc"));
        let ids: Vec<i64> = tasks.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![t1.id, t2.id]);
        assert_eq!(tasks[0].title, "one");
        assert_eq!(tasks[1].title, "two");

        assert!(matches!(store.get_project(p.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_task(t1.id), Err(Error::NotFound(_))));
        // other project untouched
        assert_eq!(store.get_task(survivor.id).unwrap().id, survivor.id);
    }

    #[test]
    fn self_edge_rejected_as_cycle() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "t");
        let err = store.add_dependency(t.id, t.id).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        assert!(err.to_string().contains(&t.id.to_string()));
    }

    #[test]
    fn cycle_rejected_naming_the_edge() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        let c = add_task(&mut store, p.id, "c");
        store.add_dependency(a.id, b.id).unwrap(); // a blocked by b
        store.add_dependency(b.id, c.id).unwrap(); // b blocked by c

        // c blocked by a would close the cycle
        let err = store.add_dependency(c.id, a.id).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        let msg = err.to_string();
        assert!(msg.contains(&format!("task {}", c.id)));
        assert!(msg.contains(&format!("task {}", a.id)));

        // nothing was inserted: c is still unblocked
        assert!(!store.get_task(c.id).unwrap().blocked);
    }

    #[test]
    fn duplicate_edge_is_idempotent() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        let first = store.add_dependency(a.id, b.id).unwrap();
        assert!(first.blocked);
        let second = store.add_dependency(a.id, b.id).unwrap();
        assert_eq!(first, second);
        let count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM dependencies", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn blocked_is_derived_from_dependency_status() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let task = add_task(&mut store, p.id, "task");
        let dep1 = add_task(&mut store, p.id, "dep1");
        let dep2 = add_task(&mut store, p.id, "dep2");
        store.add_dependency(task.id, dep1.id).unwrap();
        store.add_dependency(task.id, dep2.id).unwrap();
        assert!(store.get_task(task.id).unwrap().blocked);

        // one dependency done: still blocked by the other
        store
            .update_task(
                dep1.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store.get_task(task.id).unwrap().blocked);

        // cancelled also counts as complete: unblocked
        store
            .update_task(
                dep2.id,
                &TaskPatch {
                    status: Some(Status::Cancelled),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!store.get_task(task.id).unwrap().blocked);

        // reopening a dependency re-blocks
        store
            .update_task(
                dep1.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(store.get_task(task.id).unwrap().blocked);
    }

    #[test]
    fn unblock_removes_edge_and_missing_edge_is_not_found() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        store.add_dependency(a.id, b.id).unwrap();

        let unblocked = store.remove_dependency(a.id, b.id).unwrap();
        assert!(!unblocked.blocked);

        let err = store.remove_dependency(a.id, b.id).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
    }

    #[test]
    fn list_blockers_returns_direct_blockers_only() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        let c = add_task(&mut store, p.id, "c");
        store.add_dependency(a.id, b.id).unwrap(); // a blocked by b
        store.add_dependency(b.id, c.id).unwrap(); // b blocked by c (transitive for a)

        let blockers = store.list_blockers(a.id).unwrap();
        let ids: Vec<i64> = blockers.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![b.id]); // direct only, not c
        assert!(blockers[0].blocked); // b itself is blocked by c

        assert!(store.list_blockers(c.id).unwrap().is_empty());
        assert!(matches!(store.list_blockers(999), Err(Error::NotFound(_))));
    }

    #[test]
    fn backup_round_trip() {
        let (mut store, dir) = temp_store();
        let p = store.create_project("p", Some("kept"), None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        store.add_dependency(a.id, b.id).unwrap();

        let snap = dir.path().join("snap.db");
        store.backup(&snap).unwrap();

        let restored = Store::open(&snap).unwrap();
        assert_eq!(restored.list_projects().unwrap(), vec![p]);
        let tasks = restored.list_tasks().unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(restored.get_task(a.id).unwrap().blocked);
        assert!(!restored.get_task(b.id).unwrap().blocked);
    }

    #[test]
    fn status_events_logged_on_create_and_real_status_changes() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "t");

        // Creation event: NULL -> initial status (todo).
        let events = store.list_events(Some(t.id)).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].from_status, None);
        assert_eq!(events[0].to_status, Status::Todo);

        // Two real status changes -> two more events.
        store
            .update_task(
                t.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_task(
                t.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();

        let events = store.list_events(Some(t.id)).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[1].from_status, Some(Status::Todo));
        assert_eq!(events[1].to_status, Status::InProgress);
        assert_eq!(events[2].from_status, Some(Status::InProgress));
        assert_eq!(events[2].to_status, Status::Done);
    }

    #[test]
    fn update_without_status_change_writes_no_event_but_bumps_updated_at() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "t");
        let before = store.get_task(t.id).unwrap();
        assert_eq!(before.created_at, before.updated_at);

        // Force the clock past the 1-second `datetime('now')` granularity so the
        // bump is observable, then update a non-status field.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let updated = store
            .update_task(
                t.id,
                &TaskPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        // No new event (only the creation event remains).
        assert_eq!(store.list_events(Some(t.id)).unwrap().len(), 1);
        // created_at is unchanged; updated_at advanced.
        assert_eq!(updated.created_at, before.created_at);
        assert_ne!(updated.updated_at, before.updated_at);
        assert!(updated.updated_at > before.updated_at);
    }

    #[test]
    fn list_events_all_tasks_and_unknown_task() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        // Two creation events across all tasks, oldest first.
        let all = store.list_events(None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].task_id, a.id);
        assert_eq!(all[1].task_id, b.id);
        // events for an unknown task id is NotFound.
        assert!(matches!(
            store.list_events(Some(999)),
            Err(Error::NotFound(_))
        ));
    }

    fn create_with_priority(
        store: &mut Store,
        project_id: i64,
        title: &str,
        priority: Priority,
    ) -> Task {
        store
            .create_task(
                project_id,
                title,
                None,
                priority,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap()
    }

    #[test]
    fn next_task_orders_by_priority_then_id_and_excludes_non_actionable() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        // Lower id, but medium priority; the high-priority task wins despite
        // its higher id.
        let _med = create_with_priority(&mut store, p.id, "med", Priority::Medium);
        let high = create_with_priority(&mut store, p.id, "high", Priority::High);
        let high2 = create_with_priority(&mut store, p.id, "high2", Priority::High);

        match store.next_task(None).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, high.id),
            NextResult::None { .. } => panic!("expected a task"),
        }

        // Once the first high is done, the lower-id high (high2) wins over med.
        store
            .update_task(
                high.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        match store.next_task(None).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, high2.id),
            NextResult::None { .. } => panic!("expected a task"),
        }

        // A blocked todo is not actionable; an in_progress task is not actionable.
        let blocker = create_with_priority(&mut store, p.id, "blocker", Priority::High);
        store.add_dependency(high2.id, blocker.id).unwrap(); // high2 now blocked
        store
            .update_task(
                blocker.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        // Actionable now: only "med" (high done, high2 blocked, blocker in_progress).
        match store.next_task(None).unwrap() {
            NextResult::Task(t) => assert_eq!(t.title, "med"),
            NextResult::None { .. } => panic!("expected a task"),
        }
    }

    #[test]
    fn next_task_counts_when_none_actionable() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a"); // will block b
        let b = add_task(&mut store, p.id, "b");
        let c = add_task(&mut store, p.id, "c");
        store.add_dependency(b.id, a.id).unwrap(); // b blocked by a (todo)
        // a -> in_progress; c -> done. b stays todo+blocked.
        store
            .update_task(
                a.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_task(
                c.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();

        match store.next_task(None).unwrap() {
            NextResult::Task(_) => panic!("expected no actionable task"),
            NextResult::None {
                blocked,
                in_progress,
                todo,
            } => {
                assert_eq!(blocked, 1); // b
                assert_eq!(in_progress, 1); // a
                assert_eq!(todo, 0); // no unblocked todo
            }
        }
    }

    #[test]
    fn next_task_respects_project_filter() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None).unwrap();
        let in_p2 = create_with_priority(&mut store, p2.id, "p2 high", Priority::High);
        let in_p1 = add_task(&mut store, p1.id, "p1 task");

        match store.next_task(Some(p1.id)).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, in_p1.id),
            NextResult::None { .. } => panic!("expected p1 task"),
        }
        match store.next_task(Some(p2.id)).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, in_p2.id),
            NextResult::None { .. } => panic!("expected p2 task"),
        }
    }

    fn import_task(ref_: &str, title: &str) -> ImportTask {
        ImportTask {
            ref_: ref_.into(),
            title: title.into(),
            description: None,
            acceptance: None,
            priority: None,
            tags: None,
            parent: None,
            blocked_by: None,
        }
    }

    #[test]
    fn import_creates_graph_atomically_and_wires_parent_and_deps() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        // a (parent) -> b (child of a, blocked by c) ; c (high priority).
        let doc = ImportDoc {
            project: p.id,
            tasks: vec![
                ImportTask {
                    acceptance: Some("done when shipped".into()),
                    tags: Some(vec!["root".into()]),
                    ..import_task("a", "design")
                },
                ImportTask {
                    parent: Some("a".into()),
                    blocked_by: Some(vec!["c".into()]),
                    ..import_task("b", "build")
                },
                ImportTask {
                    priority: Some(Priority::High),
                    ..import_task("c", "spike")
                },
            ],
        };
        let created = store.import_tasks(&doc).unwrap();
        assert_eq!(created.len(), 3);

        let by_title = |t: &str| created.iter().find(|x| x.title == t).unwrap().clone();
        let a = by_title("design");
        let b = by_title("build");
        let c = by_title("spike");

        assert_eq!(a.acceptance.as_deref(), Some("done when shipped"));
        assert_eq!(a.tags, vec!["root"]);
        assert_eq!(b.parent_id, Some(a.id));
        assert_eq!(c.priority, Priority::High);
        // b is blocked by c (c is todo, not complete).
        assert!(store.get_task(b.id).unwrap().blocked);
        assert_eq!(store.list_blockers(b.id).unwrap()[0].id, c.id);
        // Each task got a creation event.
        assert_eq!(store.list_events(Some(a.id)).unwrap().len(), 1);
        assert_eq!(store.list_events(Some(b.id)).unwrap().len(), 1);
    }

    #[test]
    fn import_in_graph_cycle_is_rejected_and_creates_nothing() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        // a blocked by b, b blocked by a -> cycle within the document.
        let doc = ImportDoc {
            project: p.id,
            tasks: vec![
                ImportTask {
                    blocked_by: Some(vec!["b".into()]),
                    ..import_task("a", "a")
                },
                ImportTask {
                    blocked_by: Some(vec!["a".into()]),
                    ..import_task("b", "b")
                },
            ],
        };
        let err = store.import_tasks(&doc).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        // Rolled back: no tasks, no events.
        assert!(store.list_tasks().unwrap().is_empty());
        assert!(store.list_events(None).unwrap().is_empty());
    }

    #[test]
    fn import_rejects_unknown_project_and_bad_refs_leaving_db_empty() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();

        // unknown project: nothing created.
        let bad_project = ImportDoc {
            project: 999,
            tasks: vec![import_task("a", "a")],
        };
        assert!(matches!(
            store.import_tasks(&bad_project).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(store.list_tasks().unwrap().is_empty());

        // blocked_by an undefined ref: validation error, nothing created.
        let bad_ref = ImportDoc {
            project: p.id,
            tasks: vec![ImportTask {
                blocked_by: Some(vec!["ghost".into()]),
                ..import_task("a", "a")
            }],
        };
        assert!(matches!(
            store.import_tasks(&bad_ref).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(store.list_tasks().unwrap().is_empty());

        // duplicate ref: validation error.
        let dup = ImportDoc {
            project: p.id,
            tasks: vec![import_task("a", "one"), import_task("a", "two")],
        };
        assert!(matches!(
            store.import_tasks(&dup).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(store.list_tasks().unwrap().is_empty());
    }

    #[test]
    fn migration_runner_is_idempotent_and_sets_user_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.db");
        {
            let store = Store::open(&path).unwrap();
            let v: i64 = store
                .conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, MIGRATIONS.len() as i64);
        }
        // reopening an already-migrated db must not fail
        let store = Store::open(&path).unwrap();
        assert!(store.list_projects().unwrap().is_empty());
    }

    // ---- storyboards ----

    fn frame_new(title: &str) -> FrameNew {
        FrameNew {
            title: title.into(),
            body: None,
            x: 10.0,
            y: 20.0,
            w: 240.0,
            h: 140.0,
            color: None,
            task_id: None,
            author: None,
        }
    }

    #[test]
    fn storyboard_crud_round_trip_with_view() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store
            .create_storyboard(p.id, "flow", Some("the happy path"), Some("agent-1"))
            .unwrap();
        assert_eq!(sb.title, "flow");
        assert_eq!(sb.description.as_deref(), Some("the happy path"));
        assert_eq!(sb.author.as_deref(), Some("agent-1"));
        assert_eq!(sb.created_at, sb.updated_at);

        assert_eq!(store.get_storyboard(sb.id).unwrap(), sb);
        assert_eq!(store.list_storyboards(None).unwrap(), vec![sb.clone()]);
        assert_eq!(
            store.list_storyboards(Some(p.id)).unwrap(),
            vec![sb.clone()]
        );
        assert!(store.list_storyboards(Some(p.id + 1)).unwrap().is_empty());

        // empty board view
        let view = store.get_storyboard_view(sb.id).unwrap();
        assert_eq!(view.storyboard, sb);
        assert!(view.frames.is_empty());
        assert!(view.edges.is_empty());

        let updated = store
            .update_storyboard(
                sb.id,
                &StoryboardPatch {
                    title: Some("renamed".into()),
                    description: Some(None),
                },
                Some("agent-2"),
            )
            .unwrap();
        assert_eq!(updated.title, "renamed");
        assert_eq!(updated.description, None);
        // author is immutable; project is immutable.
        assert_eq!(updated.author.as_deref(), Some("agent-1"));
        assert_eq!(updated.project_id, p.id);

        let destroyed = store.delete_storyboard(sb.id).unwrap();
        assert_eq!(destroyed.storyboard.id, sb.id);
        assert!(matches!(
            store.get_storyboard(sb.id),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn create_storyboard_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_storyboard(999, "orphan", None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn frame_crud_and_view_ordering() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();

        let f1 = store
            .create_frame(
                sb.id,
                &FrameNew {
                    body: Some("note".into()),
                    color: Some("#00e5ff".into()),
                    author: Some("user".into()),
                    ..frame_new("first")
                },
            )
            .unwrap();
        assert_eq!(f1.title, "first");
        assert_eq!(f1.body.as_deref(), Some("note"));
        assert_eq!(f1.x, 10.0);
        assert_eq!(f1.h, 140.0);
        assert_eq!(f1.color.as_deref(), Some("#00e5ff"));
        assert_eq!(f1.task_id, None);

        let f2 = store.create_frame(sb.id, &frame_new("second")).unwrap();

        // The view lists frames by id.
        let view = store.get_storyboard_view(sb.id).unwrap();
        let ids: Vec<i64> = view.frames.iter().map(|f| f.id).collect();
        assert_eq!(ids, vec![f1.id, f2.id]);

        // Move + relabel + clear body.
        let moved = store
            .update_frame(
                f1.id,
                &FramePatch {
                    title: Some("renamed".into()),
                    body: Some(None),
                    x: Some(99.5),
                    y: Some(88.0),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(moved.title, "renamed");
        assert_eq!(moved.body, None);
        assert_eq!(moved.x, 99.5);
        assert_eq!(moved.y, 88.0);
        // untouched dimensions persist
        assert_eq!(moved.w, 240.0);

        let (deleted, edges) = store.delete_frame(f2.id, None).unwrap();
        assert_eq!(deleted.id, f2.id);
        assert!(edges.is_empty());
        assert!(matches!(store.get_frame(f2.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn create_frame_unknown_storyboard_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store.create_frame(999, &frame_new("x")).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn frame_task_link_must_be_same_project_and_nulls_on_task_delete() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None).unwrap();
        let sb = store.create_storyboard(p1.id, "b", None, None).unwrap();
        let t1 = add_task(&mut store, p1.id, "in p1");
        let t2 = add_task(&mut store, p2.id, "in p2");

        // cross-project link rejected
        let err = store
            .create_frame(
                sb.id,
                &FrameNew {
                    task_id: Some(t2.id),
                    ..frame_new("bad")
                },
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // unknown task rejected
        let err = store
            .create_frame(
                sb.id,
                &FrameNew {
                    task_id: Some(9999),
                    ..frame_new("bad")
                },
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // same-project link accepted
        let f = store
            .create_frame(
                sb.id,
                &FrameNew {
                    task_id: Some(t1.id),
                    ..frame_new("good")
                },
            )
            .unwrap();
        assert_eq!(f.task_id, Some(t1.id));

        // update cross-project link rejected
        let err = store
            .update_frame(
                f.id,
                &FramePatch {
                    task_id: Some(Some(t2.id)),
                    ..Default::default()
                },
                None,
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // deleting the linked task nulls the reference (ON DELETE SET NULL)
        store.delete_task(t1.id).unwrap();
        assert_eq!(store.get_frame(f.id).unwrap().task_id, None);
    }

    #[test]
    fn edge_crud_rejects_self_and_foreign_frames_and_allows_cycles() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();
        let other = store.create_storyboard(p.id, "other", None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let foreign = store.create_frame(other.id, &frame_new("foreign")).unwrap();

        // self-edge rejected
        let err = store
            .create_edge(sb.id, a.id, a.id, None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // endpoint not on this board rejected
        let err = store
            .create_edge(sb.id, a.id, foreign.id, None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // unknown storyboard rejected
        let err = store.create_edge(999, a.id, b.id, None, None).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // valid edge, and the reverse edge too: cycles are allowed
        let e1 = store
            .create_edge(sb.id, a.id, b.id, Some("then"), Some("user"))
            .unwrap();
        assert_eq!(e1.from_frame, a.id);
        assert_eq!(e1.to_frame, b.id);
        assert_eq!(e1.label.as_deref(), Some("then"));
        let e2 = store.create_edge(sb.id, b.id, a.id, None, None).unwrap();

        let view = store.get_storyboard_view(sb.id).unwrap();
        assert_eq!(view.edges.len(), 2);

        // relabel + clear
        let relabelled = store
            .update_edge(
                e1.id,
                &EdgePatch {
                    label: Some(Some("next".into())),
                    waypoints: None,
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(relabelled.label.as_deref(), Some("next"));
        let cleared = store
            .update_edge(
                e1.id,
                &EdgePatch {
                    label: Some(None),
                    waypoints: None,
                },
                None,
            )
            .unwrap();
        assert_eq!(cleared.label, None);

        let deleted = store.delete_edge(e2.id, None).unwrap();
        assert_eq!(deleted.id, e2.id);
        assert!(matches!(store.get_edge(e2.id), Err(Error::NotFound(_))));
        assert_eq!(store.get_storyboard_view(sb.id).unwrap().edges.len(), 1);
    }

    #[test]
    fn delete_frame_cascades_edges_and_echoes_them() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let c = store.create_frame(sb.id, &frame_new("c")).unwrap();
        let e_ab = store.create_edge(sb.id, a.id, b.id, None, None).unwrap();
        let e_ba = store.create_edge(sb.id, b.id, a.id, None, None).unwrap();
        let e_bc = store.create_edge(sb.id, b.id, c.id, None, None).unwrap();

        // deleting b removes the two edges touching it, not e? none other; a-c has none
        let (deleted, edges) = store.delete_frame(b.id, None).unwrap();
        assert_eq!(deleted.id, b.id);
        let edge_ids: HashSet<i64> = edges.iter().map(|e| e.id).collect();
        assert_eq!(edge_ids, HashSet::from([e_ab.id, e_ba.id, e_bc.id]));

        // a and c survive; no edges remain
        assert_eq!(store.get_frame(a.id).unwrap().id, a.id);
        assert_eq!(store.get_frame(c.id).unwrap().id, c.id);
        assert!(store.get_storyboard_view(sb.id).unwrap().edges.is_empty());
    }

    #[test]
    fn delete_storyboard_cascades_and_echoes_full_view() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        store.create_edge(sb.id, a.id, b.id, None, None).unwrap();

        let view = store.delete_storyboard(sb.id).unwrap();
        assert_eq!(view.frames.len(), 2);
        assert_eq!(view.edges.len(), 1);
        // gone, with frames and edges cascaded
        assert!(matches!(
            store.get_storyboard(sb.id),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(store.get_frame(a.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn delete_project_cascades_storyboards() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("doomed", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        store.create_edge(sb.id, a.id, b.id, None, None).unwrap();

        store.delete_project(p.id).unwrap();
        assert!(matches!(
            store.get_storyboard(sb.id),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(store.get_frame(a.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_edge(1), Err(Error::NotFound(_))));
    }

    #[test]
    fn storyboard_change_history_records_actor_and_actions() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store
            .create_storyboard(p.id, "flow", None, Some("agent-1"))
            .unwrap();
        let a = store
            .create_frame(
                sb.id,
                &FrameNew {
                    author: Some("user".into()),
                    ..frame_new("a")
                },
            )
            .unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let e = store
            .create_edge(sb.id, a.id, b.id, Some("then"), Some("user"))
            .unwrap();

        // a move (geometry only) vs an edit (a field change)
        store
            .update_frame(
                a.id,
                &FramePatch {
                    x: Some(200.0),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        store
            .update_frame(
                a.id,
                &FramePatch {
                    title: Some("A!".into()),
                    ..Default::default()
                },
                Some("agent-2"),
            )
            .unwrap();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    label: Some(Some("next".into())),
                    waypoints: None,
                },
                Some("user"),
            )
            .unwrap();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    label: None,
                    waypoints: Some(vec![Waypoint { x: 10.0, y: 20.0 }]),
                },
                Some("user"),
            )
            .unwrap();
        store.delete_edge(e.id, Some("agent-2")).unwrap();

        let events = store.list_storyboard_events(sb.id).unwrap();
        let actions: Vec<&str> = events.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(
            actions,
            vec![
                "storyboard_created",
                "frame_added",
                "frame_added",
                "edge_added",
                "frame_moved",
                "frame_edited",
                "edge_relabeled",
                "edge_rerouted",
                "edge_removed",
            ]
        );
        // attribution: who did what
        assert_eq!(events[0].actor.as_deref(), Some("agent-1"));
        assert_eq!(events[1].actor.as_deref(), Some("user"));
        assert_eq!(events[2].actor, None); // frame b had no author
        assert_eq!(events[5].actor.as_deref(), Some("agent-2")); // the edit
        assert_eq!(events[8].actor.as_deref(), Some("agent-2")); // the delete
        // summaries carry a human-readable line
        assert!(events[4].summary.contains("moved frame"));
        assert!(events[1].summary.contains("added frame 'a'"));

        // deleting a frame logs a removal on the surviving board
        store.delete_frame(a.id, Some("user")).unwrap();
        let events = store.list_storyboard_events(sb.id).unwrap();
        assert_eq!(events.last().unwrap().action, "frame_removed");
        assert_eq!(events.last().unwrap().actor.as_deref(), Some("user"));

        // history dies with the board; unknown board is NotFound
        assert!(matches!(
            store.list_storyboard_events(9999),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn delete_storyboard_cascades_its_change_history() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", None, None).unwrap();
        store.create_frame(sb.id, &frame_new("a")).unwrap();
        assert!(!store.list_storyboard_events(sb.id).unwrap().is_empty());
        store.delete_storyboard(sb.id).unwrap();
        // a fresh board reuses no rows; the orphaned events are gone
        let sb2 = store.create_storyboard(p.id, "b2", None, None).unwrap();
        let events = store.list_storyboard_events(sb2.id).unwrap();
        assert_eq!(events.len(), 1); // only its own creation
        assert_eq!(events[0].action, "storyboard_created");
    }

    #[test]
    fn no_op_update_changes_nothing_and_logs_nothing() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();
        let sb = store.create_storyboard(p.id, "b", Some("d"), None).unwrap();
        let f = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let g = store.create_frame(sb.id, &frame_new("g")).unwrap();
        let e = store
            .create_edge(sb.id, f.id, g.id, Some("lbl"), None)
            .unwrap();
        let before = store.list_storyboard_events(sb.id).unwrap().len();
        let frame_updated_at = store.get_frame(f.id).unwrap().updated_at;

        // Re-set every field to its current value: no change, no event, and
        // updated_at is not bumped.
        store
            .update_storyboard(
                sb.id,
                &StoryboardPatch {
                    title: Some("b".into()),
                    description: Some(Some("d".into())),
                },
                Some("noop"),
            )
            .unwrap();
        store
            .update_frame(
                f.id,
                &FramePatch {
                    title: Some("a".into()),
                    x: Some(f.x),
                    ..Default::default()
                },
                Some("noop"),
            )
            .unwrap();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    label: Some(Some("lbl".into())),
                    waypoints: None,
                },
                Some("noop"),
            )
            .unwrap();
        assert_eq!(store.list_storyboard_events(sb.id).unwrap().len(), before);
        assert_eq!(store.get_frame(f.id).unwrap().updated_at, frame_updated_at);

        // A real change still logs one event.
        store
            .update_frame(
                f.id,
                &FramePatch {
                    x: Some(f.x + 5.0),
                    ..Default::default()
                },
                Some("mover"),
            )
            .unwrap();
        assert_eq!(
            store.list_storyboard_events(sb.id).unwrap().len(),
            before + 1
        );
    }

    // ---- inbox (global update requests) ----

    #[test]
    fn inbox_add_delete_round_trip() {
        let (mut store, _dir) = temp_store();

        // New items land unassigned in the global inbox.
        let item = store
            .create_inbox_item(Some("agent-7"), "deploy v2 to staging")
            .unwrap();
        assert_eq!(item.project_id, None);
        assert_eq!(item.author.as_deref(), Some("agent-7"));
        assert_eq!(item.body, "deploy v2 to staging");

        // The whole inbox lists it (no project filter).
        let all = store.list_inbox_items(None).unwrap();
        assert_eq!(all.iter().map(|i| i.id).collect::<Vec<_>>(), vec![item.id]);

        // Delete echoes the destroyed record.
        let destroyed = store.delete_inbox_item(item.id).unwrap();
        assert_eq!(destroyed.id, item.id);
        assert!(matches!(
            store.get_inbox_item(item.id),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn assigning_an_inbox_item_converts_it_to_a_todo_task() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None).unwrap();

        // A multi-line item: title is the first line, description the full body.
        let item = store
            .create_inbox_item(Some("agent-7"), "ship the auth fix\nmore detail here")
            .unwrap();

        let task = store.assign_inbox_item(item.id, p.id).unwrap();
        assert_eq!(task.project_id, p.id);
        assert_eq!(task.status, Status::Todo);
        assert_eq!(task.priority, Priority::Medium);
        assert_eq!(task.title, "ship the auth fix");
        assert_eq!(
            task.description.as_deref(),
            Some("ship the auth fix\nmore detail here")
        );

        // The item has moved out of the inbox entirely.
        assert!(matches!(
            store.get_inbox_item(item.id),
            Err(Error::NotFound(_))
        ));
        assert!(store.list_inbox_items(None).unwrap().is_empty());

        // A single-line item yields a task with no separate description.
        let single = store.create_inbox_item(None, "quick note").unwrap();
        let t2 = store.assign_inbox_item(single.id, p.id).unwrap();
        assert_eq!(t2.title, "quick note");
        assert_eq!(t2.description, None);
    }

    #[test]
    fn list_inbox_items_newest_first() {
        let (mut store, _dir) = temp_store();
        let a = store.create_inbox_item(None, "one").unwrap();
        let b = store.create_inbox_item(None, "two").unwrap();
        let all = store.list_inbox_items(None).unwrap();
        assert_eq!(
            all.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![b.id, a.id]
        );
    }

    #[test]
    fn assign_inbox_item_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let item = store.create_inbox_item(None, "orphan").unwrap();
        let err = store.assign_inbox_item(item.id, 999).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
        // The failed assignment left the item untouched in the inbox.
        assert!(store.get_inbox_item(item.id).is_ok());
    }

    // ---- cc telemetry ----

    fn cc_count(store: &Store, table: &str) -> i64 {
        store
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn cc_batch() -> CcFileBatch {
        CcFileBatch {
            sessions: vec![CcSessionUpsert {
                session_id: "sess-1".into(),
                cwd: Some("/repo".into()),
                git_branch: Some("main".into()),
                entrypoint: Some("cli".into()),
                used_subagent: false,
                start_ts: Some(1000),
                end_ts: Some(2000),
            }],
            agent_runs: vec![CcAgentRunUpsert {
                session_id: "sess-1".into(),
                agent_id: "agent-1".into(),
                agent: Some("Explore".into()),
                skill: None,
            }],
            messages: vec![
                CcMessageRow {
                    uuid: "uuid-1".into(),
                    session_id: "sess-1".into(),
                    agent_id: None,
                    ts: 1500,
                    model: "claude-fable-5".into(),
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_read_tokens: 30,
                    cache_creation_tokens: 40,
                    skill: Some("orchestrate".into()),
                    agent: None,
                },
                CcMessageRow {
                    uuid: "uuid-2".into(),
                    session_id: "sess-1".into(),
                    agent_id: Some("agent-1".into()),
                    ts: 1600,
                    model: "claude-fable-5".into(),
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_read_tokens: 3,
                    cache_creation_tokens: 4,
                    skill: None,
                    agent: Some("Explore".into()),
                },
            ],
            tool_calls: vec![CcToolCallRow {
                tool_use_id: "toolu-1".into(),
                message_uuid: "uuid-1".into(),
                session_id: "sess-1".into(),
                agent_id: None,
                name: "Bash".into(),
                caller: Some("main".into()),
                ts: 1500,
            }],
        }
    }

    #[test]
    fn cc_migration_applies_on_existing_pre_cc_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre-cc.db");
        // Build a db at the version just before the cc migration, with data.
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..MIGRATIONS.len() - 1] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", (MIGRATIONS.len() - 1) as i64)
                .unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('kept')", [])
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.list_projects().unwrap()[0].name, "kept");
        // All five cc tables exist and are empty.
        for table in [
            "cc_sessions",
            "cc_agent_runs",
            "cc_messages",
            "cc_tool_calls",
            "cc_files",
        ] {
            assert_eq!(cc_count(&store, table), 0, "{table} missing or non-empty");
        }
        assert!(store.cc_cursors().unwrap().is_empty());
    }

    #[test]
    fn cc_ingest_file_is_idempotent() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 111,
            size: 222,
            byte_offset: 222,
        };
        let batch = cc_batch();

        let first = store.cc_ingest_file("/t/a.jsonl", &cursor, &batch).unwrap();
        assert_eq!(first.messages_added, 2);
        assert_eq!(first.tool_calls_added, 1);
        assert_eq!(cc_count(&store, "cc_sessions"), 1);
        assert_eq!(cc_count(&store, "cc_agent_runs"), 1);
        assert_eq!(cc_count(&store, "cc_messages"), 2);
        assert_eq!(cc_count(&store, "cc_tool_calls"), 1);
        assert_eq!(cc_count(&store, "cc_files"), 1);

        // Same batch again: a no-op — zero adds, row counts unchanged.
        let second = store.cc_ingest_file("/t/a.jsonl", &cursor, &batch).unwrap();
        assert_eq!(second, CcIngestCounts::default());
        assert_eq!(cc_count(&store, "cc_sessions"), 1);
        assert_eq!(cc_count(&store, "cc_agent_runs"), 1);
        assert_eq!(cc_count(&store, "cc_messages"), 2);
        assert_eq!(cc_count(&store, "cc_tool_calls"), 1);
        assert_eq!(cc_count(&store, "cc_files"), 1);
    }

    /// The API cache key: 0 on empty, moves when rows land, stays put on a
    /// no-op re-ingest (so a warm cache keeps serving).
    #[test]
    fn cc_stamp_moves_only_when_rows_land() {
        let (mut store, _dir) = temp_store();
        assert_eq!(store.cc_stamp().unwrap(), 0);
        let cursor = CcFileCursor {
            mtime: 111,
            size: 222,
            byte_offset: 222,
        };
        let batch = cc_batch();
        store.cc_ingest_file("/t/a.jsonl", &cursor, &batch).unwrap();
        // 1 session + 2 messages + 1 tool call (agent runs/cursors excluded).
        let stamp = store.cc_stamp().unwrap();
        assert_eq!(stamp, 4);
        store.cc_ingest_file("/t/a.jsonl", &cursor, &batch).unwrap();
        assert_eq!(store.cc_stamp().unwrap(), stamp);
    }

    #[test]
    fn cc_session_upsert_merges_span_or_and_keep_first() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        // First sighting: sparse fields, narrow span.
        let sparse = CcFileBatch {
            sessions: vec![CcSessionUpsert {
                session_id: "s".into(),
                cwd: None,
                git_branch: None,
                entrypoint: Some("cli".into()),
                used_subagent: false,
                start_ts: Some(1500),
                end_ts: Some(1600),
            }],
            ..Default::default()
        };
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &sparse)
            .unwrap();
        // Second sighting: fills gaps, widens span, flips the subagent flag.
        let fuller = CcFileBatch {
            sessions: vec![CcSessionUpsert {
                session_id: "s".into(),
                cwd: Some("/repo".into()),
                git_branch: Some("main".into()),
                entrypoint: Some("sdk".into()), // must NOT overwrite (keep-first)
                used_subagent: true,
                start_ts: Some(1000),
                end_ts: Some(2000),
            }],
            ..Default::default()
        };
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &fuller)
            .unwrap();

        let (cwd, branch, entry): (Option<String>, Option<String>, Option<String>) = store
            .conn
            .query_row(
                "SELECT cwd, git_branch, entrypoint FROM cc_sessions WHERE session_id = 's'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(cwd.as_deref(), Some("/repo"));
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(entry.as_deref(), Some("cli")); // keep-first held
        let (used, start, end): (bool, Option<i64>, Option<i64>) = store
            .conn
            .query_row(
                "SELECT used_subagent, start_ts, end_ts FROM cc_sessions WHERE session_id = 's'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(used); // OR-merged
        assert_eq!(start, Some(1000)); // min
        assert_eq!(end, Some(2000)); // max
        assert_eq!(cc_count(&store, "cc_sessions"), 1);

        // A later narrower sighting must not shrink the span or unset the flag.
        let narrow = CcFileBatch {
            sessions: vec![CcSessionUpsert {
                session_id: "s".into(),
                cwd: None,
                git_branch: None,
                entrypoint: None,
                used_subagent: false,
                start_ts: Some(1200),
                end_ts: Some(1300),
            }],
            ..Default::default()
        };
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &narrow)
            .unwrap();
        let (used, start, end): (bool, Option<i64>, Option<i64>) = store
            .conn
            .query_row(
                "SELECT used_subagent, start_ts, end_ts FROM cc_sessions WHERE session_id = 's'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(used);
        assert_eq!((start, end), (Some(1000), Some(2000)));
    }

    #[test]
    fn cc_agent_run_upsert_keeps_first_attribution() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        let first = CcFileBatch {
            agent_runs: vec![CcAgentRunUpsert {
                session_id: "s".into(),
                agent_id: "a".into(),
                agent: None,
                skill: Some("khora".into()),
            }],
            ..Default::default()
        };
        store.cc_ingest_file("/t/a.jsonl", &cursor, &first).unwrap();
        let second = CcFileBatch {
            agent_runs: vec![CcAgentRunUpsert {
                session_id: "s".into(),
                agent_id: "a".into(),
                agent: Some("Explore".into()),
                skill: Some("other".into()), // must NOT overwrite
            }],
            ..Default::default()
        };
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &second)
            .unwrap();

        let (agent, skill): (Option<String>, Option<String>) = store
            .conn
            .query_row(
                "SELECT agent, skill FROM cc_agent_runs WHERE session_id = 's' AND agent_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(agent.as_deref(), Some("Explore")); // gap filled
        assert_eq!(skill.as_deref(), Some("khora")); // keep-first held
        assert_eq!(cc_count(&store, "cc_agent_runs"), 1);
    }

    #[test]
    fn cc_cursors_round_trip_and_advance() {
        let (mut store, _dir) = temp_store();
        assert!(store.cc_cursors().unwrap().is_empty());

        let c1 = CcFileCursor {
            mtime: 10,
            size: 100,
            byte_offset: 100,
        };
        store
            .cc_ingest_file("/t/a.jsonl", &c1, &CcFileBatch::default())
            .unwrap();
        let cursors = store.cc_cursors().unwrap();
        assert_eq!(cursors.len(), 1);
        assert_eq!(cursors["/t/a.jsonl"], c1);

        // Re-ingesting the same path advances its cursor in place.
        let c2 = CcFileCursor {
            mtime: 20,
            size: 250,
            byte_offset: 250,
        };
        store
            .cc_ingest_file("/t/a.jsonl", &c2, &CcFileBatch::default())
            .unwrap();
        let cursors = store.cc_cursors().unwrap();
        assert_eq!(cursors.len(), 1);
        assert_eq!(cursors["/t/a.jsonl"], c2);
    }
}
