use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::types::{Priority, Project, Status, Task};

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
"];

/// Selects full task rows including the derived `blocked` flag.
const TASK_COLUMNS: &str = "t.id, t.project_id, t.parent_id, t.title, t.description, \
     t.status, t.priority, t.tags, \
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
        blocked: row.get(8)?,
    })
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
    })
}

/// Fields to change on a project; `None` means leave unchanged.
#[derive(Debug, Default, Clone)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
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

    pub fn create_project(&mut self, name: &str, description: Option<&str>) -> Result<Project> {
        self.conn.execute(
            "INSERT INTO projects (name, description) VALUES (?1, ?2)",
            (name, description),
        )?;
        self.get_project(self.conn.last_insert_rowid())
    }

    pub fn get_project(&self, id: i64) -> Result<Project> {
        self.conn
            .query_row(
                "SELECT id, name, description FROM projects WHERE id = ?1",
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
            .prepare("SELECT id, name, description FROM projects ORDER BY id")?;
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
        self.conn.execute(
            "UPDATE projects SET name = ?1, description = ?2 WHERE id = ?3",
            (&project.name, &project.description, id),
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

    pub fn create_task(
        &mut self,
        project_id: i64,
        title: &str,
        description: Option<&str>,
        priority: Priority,
        tags: &[String],
        parent_id: Option<i64>,
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
        self.conn.execute(
            "INSERT INTO tasks (project_id, parent_id, title, description, priority, tags) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                project_id,
                parent_id,
                title,
                description,
                priority.as_str(),
                tags_json,
            ),
        )?;
        self.get_task(self.conn.last_insert_rowid())
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
        let tags_json = serde_json::to_string(&task.tags).expect("tags serialize");
        self.conn.execute(
            "UPDATE tasks SET title = ?1, description = ?2, status = ?3, priority = ?4, \
             tags = ?5, parent_id = ?6 WHERE id = ?7",
            (
                &task.title,
                &task.description,
                task.status.as_str(),
                task.priority.as_str(),
                tags_json,
                task.parent_id,
                id,
            ),
        )?;
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

    fn check_parent(&self, parent_id: i64, project_id: i64) -> Result<()> {
        let parent = match self.get_task(parent_id) {
            Ok(t) => t,
            Err(Error::NotFound(_)) => {
                return Err(Error::Validation(format!(
                    "parent task {parent_id} not found"
                )));
            }
            Err(e) => return Err(e),
        };
        if parent.project_id != project_id {
            return Err(Error::Validation(format!(
                "parent task {parent_id} belongs to project {}, not project {project_id}: \
                 a subtask must belong to the same project as its parent",
                parent.project_id
            )));
        }
        Ok(())
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

    /// True if a path blocker_id -> ... -> task_id already exists along
    /// blocked-by edges, i.e. adding (task_id blocked by blocker_id) would
    /// close a cycle. DFS over the full edge set.
    fn would_cycle(&self, task_id: i64, blocker_id: i64) -> Result<bool> {
        let mut edges: HashMap<i64, Vec<i64>> = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT task_id, blocked_by FROM dependencies")?;
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

    // ---- backup ----

    /// Snapshots the database to `path` via `VACUUM INTO` (safe under WAL).
    pub fn backup(&self, path: &Path) -> Result<()> {
        self.conn
            .execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
        Ok(())
    }
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
            .create_task(project_id, title, None, Priority::Medium, &[], None)
            .unwrap()
    }

    #[test]
    fn project_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("alpha", Some("first")).unwrap();
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
    fn task_crud_round_trip() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None).unwrap();
        let t = store
            .create_task(
                p.id,
                "write tests",
                Some("cover everything"),
                Priority::High,
                &["rust".into(), "tdd".into()],
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
            .create_task(999, "orphan", None, Priority::Medium, &[], None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn parent_must_be_in_same_project() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None).unwrap();
        let p2 = store.create_project("p2", None).unwrap();
        let t1 = add_task(&mut store, p1.id, "in p1");
        let t2 = add_task(&mut store, p2.id, "in p2");

        // create: cross-project parent rejected
        let err = store
            .create_task(p2.id, "sub", None, Priority::Medium, &[], Some(t1.id))
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
            .create_task(p1.id, "sub", None, Priority::Medium, &[], Some(t1.id))
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
        let p = store.create_project("p", None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(p.id, "child", None, Priority::Medium, &[], Some(root.id))
            .unwrap();
        let grandchild = store
            .create_task(p.id, "grandchild", None, Priority::Medium, &[], Some(child.id))
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
        let p = store.create_project("doomed", Some("desc")).unwrap();
        let keep = store.create_project("keeper", None).unwrap();
        let t1 = add_task(&mut store, p.id, "one");
        let t2 = store
            .create_task(p.id, "two", None, Priority::Medium, &[], Some(t1.id))
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
        let p = store.create_project("p", None).unwrap();
        let t = add_task(&mut store, p.id, "t");
        let err = store.add_dependency(t.id, t.id).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        assert!(err.to_string().contains(&t.id.to_string()));
    }

    #[test]
    fn cycle_rejected_naming_the_edge() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None).unwrap();
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
        let p = store.create_project("p", None).unwrap();
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
        let p = store.create_project("p", None).unwrap();
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
        let p = store.create_project("p", None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        store.add_dependency(a.id, b.id).unwrap();

        let unblocked = store.remove_dependency(a.id, b.id).unwrap();
        assert!(!unblocked.blocked);

        let err = store.remove_dependency(a.id, b.id).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
    }

    #[test]
    fn backup_round_trip() {
        let (mut store, dir) = temp_store();
        let p = store.create_project("p", Some("kept")).unwrap();
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
