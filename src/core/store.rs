use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::types::{Priority, Project, Status, Task, TaskEvent};

#[derive(Debug)]
pub enum Error {
    NotFound(String),
    Validation(String),
    Cycle(String),
    Db(rusqlite::Error),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound(m) | Error::Validation(m) | Error::Cycle(m) => f.write_str(m),
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

/// MESA_DB if set, else ~/Library/Application Support/mesa/mesa.db (macOS).
pub fn default_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("MESA_DB") {
        return PathBuf::from(p);
    }
    let dirs = directories::ProjectDirs::from("", "", "mesa")
        .expect("could not determine application data directory");
    dirs.data_dir().join("mesa.db")
}

const MIGRATIONS: &[&str] = &["
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
    "];

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

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        docs_path: row.get(3)?,
    })
}

/// Fields to change on a project; `None` means leave unchanged.
#[derive(Debug, Default, Clone)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
    /// `Some(None)` clears the docs path.
    pub docs_path: Option<Option<String>>,
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
        docs_path: Option<&str>,
    ) -> Result<Project> {
        self.conn.execute(
            "INSERT INTO projects (name, description, docs_path) VALUES (?1, ?2, ?3)",
            (name, description, docs_path),
        )?;
        self.get_project(self.conn.last_insert_rowid())
    }

    pub fn get_project(&self, id: i64) -> Result<Project> {
        self.conn
            .query_row(
                "SELECT id, name, description, docs_path FROM projects WHERE id = ?1",
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
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, description, docs_path FROM projects ORDER BY id")?;
        let rows = stmt.query_map([], row_to_project)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_project(&mut self, id: i64, patch: &ProjectPatch) -> Result<Project> {
        let mut project = self.get_project(id)?;
        if let Some(name) = &patch.name {
            project.name = name.clone();
        }
        if let Some(description) = &patch.description {
            project.description = description.clone();
        }
        if let Some(docs_path) = &patch.docs_path {
            project.docs_path = docs_path.clone();
        }
        self.conn.execute(
            "UPDATE projects SET name = ?1, description = ?2, docs_path = ?3 WHERE id = ?4",
            (&project.name, &project.description, &project.docs_path, id),
        )?;
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
              created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))",
            (
                project_id,
                parent_id,
                title,
                description,
                priority.as_str(),
                tags_json,
                acceptance,
                artifact,
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
                    Error::NotFound(format!("task {id} not found"))
                }
                e => Error::Db(e),
            })
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
        tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
        tx.commit()?;
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

    fn add_task(store: &mut Store, project_id: i64, title: &str) -> Task {
        store
            .create_task(project_id, title, None, Priority::Medium, &[], None, None, None)
            .unwrap()
    }

    #[test]
    fn project_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("alpha", Some("first"), None).unwrap();
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
        assert!(matches!(
            store.get_project(p.id),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn project_docs_path_round_trip_and_clear() {
        let (mut store, _dir) = temp_store();
        // set at creation
        let p = store
            .create_project("docs", None, Some("/tmp/pm-docs"))
            .unwrap();
        assert_eq!(p.docs_path.as_deref(), Some("/tmp/pm-docs"));
        assert_eq!(store.get_project(p.id).unwrap(), p);

        // unset by default
        let q = store.create_project("bare", None, None).unwrap();
        assert_eq!(q.docs_path, None);

        // set via update; other fields untouched
        let updated = store
            .update_project(
                q.id,
                &ProjectPatch {
                    docs_path: Some(Some("/elsewhere".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.docs_path.as_deref(), Some("/elsewhere"));
        assert_eq!(updated.name, "bare");

        // Some(None) clears, matching description semantics
        let cleared = store
            .update_project(
                q.id,
                &ProjectPatch {
                    docs_path: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.docs_path, None);
        assert_eq!(store.get_project(q.id).unwrap(), cleared);
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
        assert_eq!(projects[0].docs_path, None);
    }

    #[test]
    fn task_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None).unwrap();
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
    fn create_task_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_task(999, "orphan", None, Priority::Medium, &[], None, None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn parent_must_be_in_same_project() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None).unwrap();
        let p2 = store.create_project("p2", None, None).unwrap();
        let t1 = add_task(&mut store, p1.id, "in p1");
        let t2 = add_task(&mut store, p2.id, "in p2");

        // create: cross-project parent rejected
        let err = store
            .create_task(p2.id, "sub", None, Priority::Medium, &[], Some(t1.id), None, None)
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
            .create_task(p1.id, "sub", None, Priority::Medium, &[], Some(t1.id), None, None)
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
        let p = store.create_project("p", None, None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(p.id, "child", None, Priority::Medium, &[], Some(root.id), None, None)
            .unwrap();
        let grandchild = store
            .create_task(p.id, "grandchild", None, Priority::Medium, &[], Some(child.id), None, None)
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

    #[test]
    fn delete_project_cascades_tasks_and_returns_them() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("doomed", Some("desc"), None).unwrap();
        let keep = store.create_project("keeper", None, None).unwrap();
        let t1 = add_task(&mut store, p.id, "one");
        let t2 = store
            .create_task(p.id, "two", None, Priority::Medium, &[], Some(t1.id), None, None)
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
        let p = store.create_project("p", None, None).unwrap();
        let t = add_task(&mut store, p.id, "t");
        let err = store.add_dependency(t.id, t.id).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        assert!(err.to_string().contains(&t.id.to_string()));
    }

    #[test]
    fn cycle_rejected_naming_the_edge() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", Some("kept"), None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        // Two creation events across all tasks, oldest first.
        let all = store.list_events(None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].task_id, a.id);
        assert_eq!(all[1].task_id, b.id);
        // events for an unknown task id is NotFound.
        assert!(matches!(store.list_events(Some(999)), Err(Error::NotFound(_))));
    }

    fn create_with_priority(
        store: &mut Store,
        project_id: i64,
        title: &str,
        priority: Priority,
    ) -> Task {
        store
            .create_task(project_id, title, None, priority, &[], None, None, None)
            .unwrap()
    }

    #[test]
    fn next_task_orders_by_priority_then_id_and_excludes_non_actionable() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p1 = store.create_project("p1", None, None).unwrap();
        let p2 = store.create_project("p2", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();
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
        let p = store.create_project("p", None, None).unwrap();

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
}
