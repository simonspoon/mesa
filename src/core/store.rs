use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};

use super::attachments;
use super::types::{
    AnchorSide, Attachment, Diagram, DiagramEvent, DiagramType, DiagramView, EdgeMarker, EdgeStyle,
    Frame, FrameEdge, FrameShape, InboxItem, InboxKind, LiveAction, LiveRole, LiveSession,
    LiveStatus, LiveTurn, Priority, Project, Script, ScriptArg, ScriptArgKind, Status, Task,
    TaskEvent, Waypoint, task_name,
};

#[derive(Debug)]
pub enum Error {
    NotFound(String),
    Validation(String),
    /// Something mesa depends on but does not own is missing or misbehaving —
    /// the contract's `unavailable` code, scoped to exactly those surfaces
    /// (the live `cc usage` endpoint, the agents endpoints, and resolving a
    /// CC node's full text out of a transcript file that may since have been
    /// deleted). Never a domain outcome: it says "ask again later", not
    /// "this input was wrong".
    Unavailable(String),
    Cycle(String),
    Conflict(String),
    Db(rusqlite::Error),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound(m)
            | Error::Validation(m)
            | Error::Unavailable(m)
            | Error::Cycle(m)
            | Error::Conflict(m) => f.write_str(m),
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
    "
    ALTER TABLE tasks ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
    UPDATE tasks SET sort_order = id;
    ",
    "ALTER TABLE tasks ADD COLUMN result TEXT;",
    "
    ALTER TABLE frame_edges ADD COLUMN from_anchor TEXT;
    ALTER TABLE frame_edges ADD COLUMN to_anchor TEXT;
    ",
    "
    ALTER TABLE storyboards ADD COLUMN diagram_type TEXT NOT NULL DEFAULT 'storyboard';
    ALTER TABLE frames ADD COLUMN shape TEXT;
    ",
    "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    "
    ALTER TABLE tasks ADD COLUMN owner TEXT;
    ALTER TABLE tasks ADD COLUMN claimed_at TEXT;
    ",
    // Subagent spawn provenance, read from each subagent transcript's
    // `<file>.meta.json` sidecar (see `core::cc::sidecar`). `tool_use_id` is
    // the `Task` tool call that spawned the run — the edge that turns a flat
    // session into the call tree `cc::session_graph` renders.
    "
    ALTER TABLE cc_agent_runs ADD COLUMN tool_use_id TEXT;
    ALTER TABLE cc_agent_runs ADD COLUMN description TEXT;
    ALTER TABLE cc_agent_runs ADD COLUMN spawn_depth INTEGER;
    ALTER TABLE cc_agent_runs ADD COLUMN parent_agent_id TEXT;
    CREATE INDEX idx_cc_agent_runs_tool ON cc_agent_runs(tool_use_id);
    ",
    // What a tool call acted on — the one bounded, sanitized field lifted out
    // of the otherwise-unread `tool_use.input` (see `core::cc::tool_target`).
    // Deliberately NOT folded into `name`: the dashboard's tool breakdown
    // buckets by `(name, caller)`, and a per-call value there would shatter
    // "Bash x 27408" into 27408 rows of one.
    "ALTER TABLE cc_tool_calls ADD COLUMN target TEXT;",
    // Adding the column above left every already-ingested row at `target IS
    // NULL`, and ingest is cursor-driven: an unchanged transcript is skipped
    // unread, so a plain `sync` would never revisit those rows and the value
    // would only ever appear on calls made *after* the upgrade. On a real db
    // that is 70k of 70k rows blank — the graph shows `Bash` with nothing
    // beside it and, because a `Skill` node is promoted only when it has a
    // target to name itself, no skill nodes at all. Clearing the cursors here
    // makes the next `cc::sync` re-walk the tree once and take the guarded
    // `target IS NULL` backfill in `ingest_cc_batch`, which is exactly what
    // `cc sync --rebuild` does by hand. Cheap and one-shot (~9s over 3.5k
    // transcripts) and additive-only — `cc_files` holds cursors, not data.
    "DELETE FROM cc_files;",
    // A bounded preview of the assistant prose that message emitted — the one
    // part of a transcript mesa otherwise never stores (`content[]` text blocks
    // are read for tool_use and discarded). Nullable and NULL-means-no-prose:
    // a tool-use-only message, an event whose text sanitizes to empty, and
    // every row ingested before this migration all read the same way, so no
    // reader needs to distinguish "not extracted yet" from "no prose".
    // Sanitizing and capping happen at ingest (`core::cc`), never at display —
    // this is untrusted model-authored text, and the column stores it
    // already-bounded.
    //
    // The matching `DELETE FROM cc_files;` — the cursor clear that makes the
    // next ORDINARY sync re-walk and fill this column on rows that predate it,
    // exactly as migration 23 did for `cc_tool_calls.target` — is deliberately
    // NOT here. It belongs to the change that makes ingest actually *emit* a
    // preview (task 607). The re-walk is one-shot: spent under a binary that
    // still writes `preview: None`, it would advance every cursor again and the
    // guarded `preview IS NULL` backfill below would never get a second chance
    // — task 583's 9-of-70,250 outcome, reproduced. 606 and 607 therefore ship
    // as ONE binary; releasing this migration alone is the bug.
    "ALTER TABLE cc_messages ADD COLUMN preview TEXT;",
    // The cursor clear promised above, now that ingest actually extracts a
    // preview (`core::cc::RawMessage::assistant_text`). Without it every row
    // ingested before this binary stays `preview IS NULL` forever: ingest is
    // cursor-driven, so an unchanged transcript is skipped unread and the
    // guarded `preview IS NULL` backfill in `ingest_cc_batch` is never
    // reached — on a real db that is ~138k of ~138k messages blank, i.e. a
    // session graph with no response nodes at all except on sessions recorded
    // after the upgrade. Clearing the cursors makes the next ORDINARY
    // `cc::sync` re-walk the tree once and take that backfill; `cc sync
    // --rebuild` is an operator command nobody runs and is not the remedy.
    // Same shape and same reasoning as migration 23 did for
    // `cc_tool_calls.target`: a shipped `DELETE FROM cc_files;` cannot be
    // reused, since `user_version` is already past it. One-shot, cheap (~9s
    // over 3.5k transcripts) and additive-only — `cc_files` holds cursors,
    // not data.
    "DELETE FROM cc_files;",
    // Task 660: `tasks.title` is gone — a task's `description` is its whole
    // identity, and the display label is derived from the description's first
    // line on every read (`types::task_name`), never stored.
    //
    // Backfill BEFORE the drop, in one batch, so no title is lost: the old
    // title becomes the description's first line. The blank-line join matches
    // `append_text`'s convention (spec 612), so a backfilled body reads the
    // same as one an agent appended to. The three cases are distinct on
    // purpose — a bare concatenation would leave a leading blank line on the
    // ~half of rows that never had a description.
    "
    UPDATE tasks SET description = CASE
        WHEN description IS NULL OR trim(description) = '' THEN title
        WHEN trim(title) = '' THEN description
        ELSE title || char(10) || char(10) || description
    END;
    ALTER TABLE tasks DROP COLUMN title;
    ",
    // Task 666: a project carries a manual `sort_order`, exactly mirroring the
    // one tasks have carried since migration 6 — same REAL column, same
    // fractional midpoint insertion, same next-value rule on create. It is
    // what makes the left nav's project list drag-reorderable, and because
    // `list_projects` orders by it, `mesa project list` and `GET /api/projects`
    // agree with the sidebar rather than each holding their own idea of order.
    //
    // Backfilled `sort_order = id` (not left at the DEFAULT 0) so an existing
    // db's list order is byte-identical the instant it upgrades: every row
    // keeps its creation-order position, and the `id` tiebreak in the new
    // ORDER BY only ever has to settle rows nobody has dragged.
    "
    ALTER TABLE projects ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
    UPDATE projects SET sort_order = id;
    ",
    // Task 668: a project may name another project as its parent — a pure
    // grouping relation (the nav renders a tree), never a roll-up: a child
    // keeps its own tasks, storyboards, `root_commit` and `local_path`.
    // NULL = top level, which is what every existing row upgrades to.
    //
    // `ON DELETE CASCADE` is what makes deleting a project destroy its whole
    // subtree, and it is the DB's job rather than a recursive Rust delete
    // because FK enforcement is already on (`PRAGMA foreign_keys` in
    // `Store::open`) — the same division of labour tasks/storyboards already
    // rely on. Cycle rejection is *not* the schema's job: like a task's
    // parent, it is validated in `Store` (see `check_project_parent`).
    "ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;",
    // Task 693: the billing identity of an assistant turn. Claude Code writes
    // ONE API response as several transcript lines (typically a `thinking`
    // line then the `text`/`tool_use` line) and repeats the identical
    // `message.usage` block on every one of them. `cc_messages` is keyed on
    // the per-LINE uuid, so summing rows counted one billed response 2-4
    // times (~35-40% inflation on every token and cost figure). `message.id`
    // is the same on every line of one response and differs across responses,
    // so it is the dedupe key; reads sum usage once per key while the rows
    // stay per-line (`cc_tool_calls.message_uuid` and the session graph's
    // response nodes both need them).
    "ALTER TABLE cc_messages ADD COLUMN message_id TEXT;",
    // The cursor clear that fills the column above on rows ingested before it,
    // exactly as migration 25 did for `cc_messages.preview`: ingest is
    // cursor-driven, so without this an unchanged transcript is skipped unread
    // and the guarded `message_id IS NULL` backfill in `cc_ingest_file` is
    // never reached. Ships in the SAME binary as the extraction — a bare
    // column release would spend the re-walk under a binary that still writes
    // NULL and never get a second chance. One-shot and additive: `cc_files`
    // holds cursors, not data.
    "DELETE FROM cc_files;",
    // Task 774: the human turns of a session. Kept in their own table rather
    // than as a `role` column on `cc_messages`, whose every row is an
    // assistant usage event — a user line carries neither `model` nor `usage`,
    // so it has nothing to put in most of that table's columns and would
    // corrupt every read that sums them. Same bounded-preview posture as
    // `cc_messages.preview`: one sanitized ≤200-char string, never the prompt
    // body. No `agent_id` — only main-thread prompts are ingested, so a prompt
    // always hangs off the session root.
    "CREATE TABLE cc_prompts (\
        uuid TEXT PRIMARY KEY, \
        session_id TEXT NOT NULL, \
        ts INTEGER NOT NULL, \
        preview TEXT NOT NULL); \
     CREATE INDEX idx_cc_prompts_session ON cc_prompts(session_id, ts);",
    // The cursor clear that fills the table above from transcripts already
    // read, exactly as migrations 25 and 30 did for `cc_messages.preview` and
    // `message_id`: ingest is cursor-driven, so without this an unchanged
    // transcript is skipped unread and not one prompt of it is ever extracted.
    // Ships in the SAME binary as the extraction — a bare table release would
    // spend the one-shot re-walk under a binary that writes no prompt rows and
    // never get a second chance. One-shot and additive: `cc_files` holds
    // cursors, not data.
    "DELETE FROM cc_files;",
    // Task 785: user-authored shell scripts. `project_id` is `ON DELETE SET
    // NULL` (as the inbox's is, deliberately not CASCADE): deleting a project
    // must un-bind the user's scripts, never destroy them. `args` holds a JSON
    // array of `ScriptArg` — the column is a `Store` implementation detail, the
    // struct exposes a typed `Vec`.
    "CREATE TABLE scripts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        description TEXT,
        body        TEXT NOT NULL,
        args        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );",
    // Task 803: the pointer from a thread back to the `.jsonl` it came from —
    // what makes "show me the full, uncapped text of this node" a single file
    // read instead of a blind scan of thousands of transcripts. The stored
    // `cc_*` previews stay bounded and sanitized; the body is resolved on
    // demand from the transcript (`cc::node_text`).
    //
    // Its OWN table, not a column on `cc_messages`/`cc_tool_calls`: those
    // insert `DO NOTHING`, so a new column would stay NULL on every row
    // already ingested even after the cursor reset below re-walks the files.
    // A fresh table upserts cleanly on that same re-walk. Verified 1:1
    // against the real ~/.claude/projects corpus (3445 pairs, none spanning
    // two files), so last-writer-wins is a formality rather than a policy.
    "CREATE TABLE cc_node_files (\
        session_id TEXT NOT NULL, \
        agent_id TEXT NOT NULL DEFAULT '', \
        path TEXT NOT NULL, \
        PRIMARY KEY (session_id, agent_id));",
    // The cursor clear that fills the table above from transcripts already
    // read, exactly as migrations 23, 25, 30 and 32 did before it. Ships in the
    // SAME binary as the ingest write — a bare table release would spend the
    // one-shot re-walk under a binary that writes no pointer rows and never
    // get a second chance. One-shot and additive: `cc_files` holds cursors,
    // not data.
    "DELETE FROM cc_files;",
    // Task 804: the `refine` status is gone — no column renders it and no query
    // selects it, so a row left in it would simply vanish from every surface.
    // `backlog` is where it lands: a refine task was explicitly *not* ready to
    // be handed out. There is no status CHECK constraint, so this is a plain
    // data rewrite.
    "UPDATE tasks SET status = 'backlog' WHERE status = 'refine';",
    // Task 814: `cc::human_prompt` now reads `origin.kind` as well as
    // `origin.type` — upstream renamed the key, and reading only the old
    // spelling rejected EVERY human turn of every session written since
    // (`RawOrigin` in `src/core/cc.rs` has the full account). Same shape as
    // the cursor clears above, and for the same reason: the fix makes the
    // parser emit `cc_prompts` rows it previously missed entirely, and an
    // unchanged transcript is skipped unread, so without this the timeline's
    // prompt rows would only ever appear for turns taken after the upgrade.
    // One-shot and additive — `cc_files` holds cursors, not data.
    "DELETE FROM cc_files;",
    // Task 831: an inbox item records when it was first read. Nullable, so
    // every item that predates this migration is unread — which is what an
    // untriaged item is. Additive; nothing else changes.
    "ALTER TABLE inbox ADD COLUMN read_at TEXT;",
    // Task 845: an inbox item can be **archived** — set aside without being
    // triaged or destroyed, which is what the Inbox nav's third sub-view
    // lists. Nullable, so every item that predates this migration is live.
    // Additive; nothing else changes.
    "ALTER TABLE inbox ADD COLUMN archived_at TEXT;",
    // Task 846: an inbox item declares what it is for — a task summary a
    // person reads, or a change request the inbox-watcher triages. Every item
    // that predates this migration becomes a summary, the passive kind: an
    // item nobody labelled must not start being auto-triaged by an upgrade.
    // Additive; nothing else changes.
    "ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'task-summary';",
    // Task 847: an inbox item names the task it came from, so a reader can see
    // which project and which piece of work it is about without opening it.
    // Required at creation from here on, but the column is **nullable**: every
    // item that predates this migration has no origin to name, and the FK is
    // `ON DELETE SET NULL` (as the item's own `project_id` is) so deleting a
    // task loses the pointer rather than the report. Additive; nothing else
    // changes.
    "ALTER TABLE inbox ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;",
    // Task 848: the container concept is renamed Storyboard -> Diagram. Pure
    // rename, no shape change: the tables and the foreign-key column get the
    // new name, and the two board-level history tokens are rewritten so an
    // upgraded db's change history reads in one vocabulary rather than two.
    // `storyboard` survives untouched as one value of `diagram_type` — it is
    // now one diagram *style*, not the container.
    "ALTER TABLE storyboards RENAME TO diagrams;
     ALTER TABLE storyboard_events RENAME TO diagram_events;
     ALTER TABLE frames RENAME COLUMN storyboard_id TO diagram_id;
     ALTER TABLE frame_edges RENAME COLUMN storyboard_id TO diagram_id;
     ALTER TABLE diagram_events RENAME COLUMN storyboard_id TO diagram_id;
     UPDATE diagram_events SET action = 'diagram_created' WHERE action = 'storyboard_created';
     UPDATE diagram_events SET action = 'diagram_edited'  WHERE action = 'storyboard_edited';",
    // Task 854: a connector carries professional properties — a line style and
    // a marker per endpoint. All three nullable, and NULL *is* today's
    // rendering (solid line, nothing at the start, a closed arrowhead at the
    // `to` end), so every edge that predates this migration draws
    // byte-identically. Additive; nothing else changes.
    "ALTER TABLE frame_edges ADD COLUMN style TEXT;
     ALTER TABLE frame_edges ADD COLUMN from_marker TEXT;
     ALTER TABLE frame_edges ADD COLUMN to_marker TEXT;",
    // Task 855: mesa live — one spoken conversation and its turns. The queue
    // is a table rather than server memory because the agent driving the
    // conversation reaches mesa through the CLI, which opens its own `Store`
    // and never talks to the server: anything held in the server's process
    // would be invisible to the one writer that matters.
    //
    // `project_id` is `ON DELETE SET NULL` (the call the inbox makes) — a
    // conversation outlives the project row it was about. `session_id` is
    // `ON DELETE CASCADE`: a turn is a part of a session, not a record of its
    // own. The index is the read pattern — every list and every `listen` is
    // "this session's turns, in id order".
    "CREATE TABLE live_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        agent_id    TEXT,
        status      TEXT NOT NULL,
        route       TEXT,
        started_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        ended_at    TEXT
    );
    CREATE TABLE live_turns (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        text         TEXT NOT NULL,
        action       TEXT,
        target       TEXT,
        created_at   TEXT NOT NULL,
        delivered_at TEXT,
        played_at    TEXT
    );
    CREATE INDEX idx_live_turns_session ON live_turns(session_id, id);",
];

/// Selects full task rows including the derived `blocked` flag.
const TASK_COLUMNS: &str = "t.id, t.project_id, t.parent_id, t.description, \
     t.status, t.priority, t.tags, \
     t.acceptance, t.artifact, t.result, t.created_at, t.updated_at, t.sort_order, \
     t.owner, t.claimed_at, \
     EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocked_by \
            WHERE d.task_id = t.id AND b.status NOT IN ('done', 'cancelled'))";

/// True iff task `t` has an unresolved dependency. Shared by every
/// "actionable?" query so `next_task` and `next_subtask` can never drift on
/// what blocked means.
const BLOCKED_EXPR: &str = "EXISTS(SELECT 1 FROM dependencies d JOIN tasks b ON b.id = d.blocked_by \
     WHERE d.task_id = t.id AND b.status NOT IN ('done', 'cancelled'))";

/// Actionable-task ordering: high > medium > low, then ascending id. Shared
/// for the same reason as [`BLOCKED_EXPR`].
const PRIORITY_RANK: &str = "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let id: i64 = row.get(0)?;
    // The column is still SQL-nullable (dropping `title` in migration 28 did
    // not rebuild the table), while the domain type is not: `Store` rejects an
    // empty description on write, so a NULL here can only come from a
    // hand-edited db and must render rather than panic.
    let description: String = row.get::<_, Option<String>>(3)?.unwrap_or_default();
    let status: String = row.get(4)?;
    let priority: String = row.get(5)?;
    let tags: String = row.get(6)?;
    Ok(Task {
        id,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        // Derived on every read, exactly like `blocked` below.
        name: task_name(&description, id),
        description,
        status: Status::parse(&status).expect("invalid status in db"),
        priority: Priority::parse(&priority).expect("invalid priority in db"),
        tags: serde_json::from_str(&tags).expect("invalid tags json in db"),
        acceptance: row.get(7)?,
        artifact: row.get(8)?,
        result: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        sort_order: row.get(12)?,
        owner: row.get(13)?,
        claimed_at: row.get(14)?,
        blocked: row.get(15)?,
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

const PROJECT_COLUMNS: &str =
    "id, name, description, root_commit, local_path, archived, sort_order, parent_id";

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        root_commit: row.get(3)?,
        local_path: row.get(4)?,
        archived: row.get(5)?,
        sort_order: row.get(6)?,
        parent_id: row.get(7)?,
    })
}

/// The set of projects hidden from **unscoped** reads (task 668): a project is
/// hidden iff it is archived **or any ancestor is**. The `archived` flag stays
/// strictly per-row — archiving a parent never writes its children — so
/// effective visibility is derived on every read, exactly as `blocked` is.
///
/// Prefix for a query that then filters on [`NOT_HIDDEN_PROJECT`]; defined
/// once and shared by every unscoped site (`list_projects`, `list_tasks`,
/// `next_task`, `list_diagrams`) so they cannot drift
/// apart on what "archived" means. `UNION` (not `UNION ALL`) so a malformed
/// parent cycle terminates instead of recursing forever — the same guard
/// `next_subtask` uses on the task tree.
const HIDDEN_PROJECTS_CTE: &str = "WITH RECURSIVE hidden_projects(id) AS ( \
     SELECT id FROM projects WHERE archived = 1 \
     UNION \
     SELECT c.id FROM projects c JOIN hidden_projects h ON c.parent_id = h.id \
 ) ";

/// The predicate half of [`HIDDEN_PROJECTS_CTE`]. Expects the `projects` table
/// aliased as `p`, which every unscoped query here already does.
const NOT_HIDDEN_PROJECT: &str = "p.id NOT IN (SELECT id FROM hidden_projects)";

const DIAGRAM_COLUMNS: &str =
    "id, project_id, title, description, author, diagram_type, created_at, updated_at";
const FRAME_COLUMNS: &str = "id, diagram_id, title, body, x, y, w, h, color, task_id, author, \
     shape, created_at, updated_at";
const EDGE_COLUMNS: &str = "id, diagram_id, from_frame, to_frame, label, author, created_at, \
     waypoints, from_anchor, to_anchor, style, from_marker, to_marker";
const DIAGRAM_EVENT_COLUMNS: &str = "id, diagram_id, actor, action, summary, at";
/// The item's own columns plus the two the origin task contributes: its
/// description (the `task_name` is derived from it on every read, never stored)
/// and its project's name. Both arrive through `INBOX_FROM`'s left joins, so
/// they are null exactly when `task_id` is.
const INBOX_COLUMNS: &str = "i.id, i.project_id, i.author, i.body, i.created_at, i.updated_at, \
     i.read_at, i.archived_at, i.kind, i.task_id, t.description, p.name";

/// The joins `INBOX_COLUMNS` reads the derived columns from. Left joins: an
/// item whose origin task was deleted (or that predates task 847) still reads.
const INBOX_FROM: &str = "FROM inbox i \
     LEFT JOIN tasks t ON t.id = i.task_id \
     LEFT JOIN projects p ON p.id = t.project_id";

fn row_to_inbox_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<InboxItem> {
    let kind: String = row.get(8)?;
    let task_id: Option<i64> = row.get(9)?;
    let description: Option<String> = row.get(10)?;
    Ok(InboxItem {
        id: row.get(0)?,
        project_id: row.get(1)?,
        author: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        read_at: row.get(6)?,
        archived_at: row.get(7)?,
        kind: InboxKind::parse(&kind).expect("invalid inbox kind in db"),
        task_id,
        task_name: match (task_id, description) {
            (Some(id), Some(d)) => Some(task_name(&d, id)),
            _ => None,
        },
        project_name: row.get(11)?,
    })
}

// ---- mesa live (task 855) ----

const LIVE_SESSION_COLUMNS: &str =
    "id, project_id, agent_id, status, route, started_at, updated_at, ended_at";

const LIVE_TURN_COLUMNS: &str = "id, session_id, role, text, action, target, \
     created_at, delivered_at, played_at";

/// Longest route mesa will store or navigate to. A route is a hash path the
/// page already knows how to render, not free text, so the bound is generous
/// but real — it lands in `window.location.hash`.
const LIVE_ROUTE_MAX: usize = 200;

/// Longest turn text. Bounded because a mesa turn is **spoken**: a runaway
/// body would wedge the synthesiser rather than say anything.
const LIVE_TEXT_MAX: usize = 8192;

/// Most turns one `list_live_turns` call returns. The page polls with a
/// cursor, so a bigger page would only ever be a slower first paint.
const LIVE_TURNS_MAX: i64 = 500;

fn row_to_live_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiveSession> {
    let status: String = row.get(3)?;
    Ok(LiveSession {
        id: row.get(0)?,
        project_id: row.get(1)?,
        agent_id: row.get(2)?,
        status: LiveStatus::parse(&status).expect("invalid live session status in db"),
        route: row.get(4)?,
        started_at: row.get(5)?,
        updated_at: row.get(6)?,
        ended_at: row.get(7)?,
    })
}

fn row_to_live_turn(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiveTurn> {
    let role: String = row.get(2)?;
    let action: Option<String> = row.get(4)?;
    Ok(LiveTurn {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: LiveRole::parse(&role).expect("invalid live turn role in db"),
        text: row.get(3)?,
        action: action.map(|a| LiveAction::parse(&a).expect("invalid live turn action in db")),
        target: row.get(5)?,
        created_at: row.get(6)?,
        delivered_at: row.get(7)?,
        played_at: row.get(8)?,
    })
}

/// The one route rule, shared by `set_live_route` and a `navigate` turn's
/// `target` so the page can never be sent somewhere the session couldn't
/// record: non-empty, bounded, and a `#/` hash path (the app's only routing
/// vocabulary — see `App.tsx`'s route inventory).
fn validate_live_route(route: &str) -> Result<String> {
    let route = route.trim();
    if route.is_empty() {
        return Err(Error::Validation("route must not be empty".into()));
    }
    if route.chars().count() > LIVE_ROUTE_MAX {
        return Err(Error::Validation(format!(
            "route must be at most {LIVE_ROUTE_MAX} characters"
        )));
    }
    if !route.starts_with("#/") {
        return Err(Error::Validation(format!(
            "route must start with \"#/\" (got {route:?})"
        )));
    }
    Ok(route.to_string())
}

const SCRIPT_COLUMNS: &str =
    "id, project_id, name, description, body, args, created_at, updated_at";

/// The `args` column is stored JSON; the struct exposes the typed list, so the
/// encode/decode pair lives here and nowhere else. A row whose JSON is
/// unreadable is a corrupt db, surfaced as a conversion failure rather than
/// silently becoming an empty arg list (which would make the run form wrong).
fn row_to_script(row: &rusqlite::Row<'_>) -> rusqlite::Result<Script> {
    let args: String = row.get(5)?;
    let args: Vec<ScriptArg> = serde_json::from_str(&args).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Script {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        body: row.get(4)?,
        args,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Longest allowed [`ScriptArg::name`]. It becomes an `MESA_ARG_*` env-var
/// suffix, so it is bounded for the same reason its charset is.
const SCRIPT_ARG_NAME_MAX: usize = 64;

fn validate_script_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Error::Validation(
            "script name is required and may not be empty".into(),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_script_body(body: &str) -> Result<String> {
    if body.trim().is_empty() {
        return Err(Error::Validation(
            "script body is required and may not be empty".into(),
        ));
    }
    // Stored verbatim (leading indentation and trailing newline included) —
    // trimming is only how emptiness is judged, never what gets saved.
    Ok(body.to_string())
}

/// An arg name has to survive becoming an environment-variable suffix, so it
/// is constrained here rather than at the point of use: `^[A-Za-z_][A-Za-z0-9_-]*$`,
/// bounded length, unique within the script (case-insensitively — `-`→`_` and
/// upper-casing make `a-b` and `A_B` the same variable).
fn validate_script_args(args: &[ScriptArg]) -> Result<()> {
    let mut seen: HashSet<String> = HashSet::new();
    for arg in args {
        let name = &arg.name;
        let mut chars = name.chars();
        let head_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_');
        let tail_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !head_ok || !tail_ok || name.len() > SCRIPT_ARG_NAME_MAX {
            return Err(Error::Validation(format!(
                "invalid script argument name {name:?}: use up to {SCRIPT_ARG_NAME_MAX} \
                 characters matching ^[A-Za-z_][A-Za-z0-9_-]*$"
            )));
        }
        let key = name.to_ascii_uppercase().replace('-', "_");
        if !seen.insert(key) {
            return Err(Error::Validation(format!(
                "duplicate script argument name {name:?}: names are unique within a script"
            )));
        }
        match arg.kind {
            ScriptArgKind::Choice => {
                if arg.choices.as_ref().is_none_or(|c| c.is_empty()) {
                    return Err(Error::Validation(format!(
                        "script argument {name:?} is a choice and needs a non-empty choices list"
                    )));
                }
            }
            _ => {
                if arg.choices.is_some() {
                    return Err(Error::Validation(format!(
                        "script argument {name:?} is a {} and may not carry choices",
                        arg.kind.as_str()
                    )));
                }
            }
        }
    }
    Ok(())
}

fn encode_script_args(args: &[ScriptArg]) -> Result<String> {
    serde_json::to_string(args)
        .map_err(|e| Error::Validation(format!("cannot encode script arguments: {e}")))
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

fn row_to_diagram(row: &rusqlite::Row<'_>) -> rusqlite::Result<Diagram> {
    let diagram_type: String = row.get(5)?;
    Ok(Diagram {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        author: row.get(4)?,
        diagram_type: DiagramType::parse(&diagram_type).expect("invalid diagram_type in db"),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_frame(row: &rusqlite::Row<'_>) -> rusqlite::Result<Frame> {
    let shape: Option<String> = row.get(11)?;
    Ok(Frame {
        id: row.get(0)?,
        diagram_id: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        x: row.get(4)?,
        y: row.get(5)?,
        w: row.get(6)?,
        h: row.get(7)?,
        color: row.get(8)?,
        task_id: row.get(9)?,
        author: row.get(10)?,
        shape: shape
            .as_deref()
            .map(|s| FrameShape::parse(s).expect("invalid shape in db")),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

/// Validates a frame's `shape` against its board's `diagram_type` shape set —
/// `DiagramType::shapes` plus `allows_generic_frame` for the `None` card, the
/// same pair `mesa diagram types` prints, so the validator and the discovery
/// command cannot answer differently.
fn validate_frame_shape(diagram_type: DiagramType, shape: Option<FrameShape>) -> Result<()> {
    let ok = match shape {
        None => diagram_type.allows_generic_frame(),
        Some(shape) => diagram_type.shapes().contains(&shape),
    };
    if ok {
        Ok(())
    } else {
        let shape_str = shape.map(FrameShape::as_str).unwrap_or("none");
        Err(Error::Validation(format!(
            "shape '{shape_str}' is not valid for a {} board",
            diagram_type.as_str()
        )))
    }
}

/// Validates an edge's endpoint markers against its board's `diagram_type`
/// marker set (`DiagramType::edge_markers`, again the list `mesa diagram
/// types` prints). The general family draws on any board; the cardinality
/// family states an ERD relation's multiplicity and is `erd`-only. `None` —
/// the default rendering — is always valid, as is any `style`: a dashed line
/// means the same weakening on every board type, so `EdgeStyle` has no
/// per-type check at all.
fn validate_edge_markers(
    diagram_type: DiagramType,
    from_marker: Option<EdgeMarker>,
    to_marker: Option<EdgeMarker>,
) -> Result<()> {
    for marker in [from_marker, to_marker].into_iter().flatten() {
        if !diagram_type.edge_markers().contains(&marker) {
            return Err(Error::Validation(format!(
                "marker '{}' is not valid for a {} board",
                marker.as_str(),
                diagram_type.as_str()
            )));
        }
    }
    Ok(())
}

fn row_to_edge(row: &rusqlite::Row<'_>) -> rusqlite::Result<FrameEdge> {
    let waypoints_json: Option<String> = row.get(7)?;
    let waypoints = waypoints_json
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Vec<Waypoint>>(s).ok())
        .unwrap_or_default();
    let from_anchor: Option<String> = row.get(8)?;
    let to_anchor: Option<String> = row.get(9)?;
    let style: Option<String> = row.get(10)?;
    let from_marker: Option<String> = row.get(11)?;
    let to_marker: Option<String> = row.get(12)?;
    Ok(FrameEdge {
        id: row.get(0)?,
        diagram_id: row.get(1)?,
        from_frame: row.get(2)?,
        to_frame: row.get(3)?,
        label: row.get(4)?,
        author: row.get(5)?,
        created_at: row.get(6)?,
        waypoints,
        from_anchor: from_anchor
            .as_deref()
            .map(|s| AnchorSide::parse(s).expect("invalid anchor in db")),
        to_anchor: to_anchor
            .as_deref()
            .map(|s| AnchorSide::parse(s).expect("invalid anchor in db")),
        style: style
            .as_deref()
            .map(|s| EdgeStyle::parse(s).expect("invalid edge style in db")),
        from_marker: from_marker
            .as_deref()
            .map(|s| EdgeMarker::parse(s).expect("invalid edge marker in db")),
        to_marker: to_marker
            .as_deref()
            .map(|s| EdgeMarker::parse(s).expect("invalid edge marker in db")),
    })
}

fn row_to_diagram_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<DiagramEvent> {
    Ok(DiagramEvent {
        id: row.get(0)?,
        diagram_id: row.get(1)?,
        actor: row.get(2)?,
        action: row.get(3)?,
        summary: row.get(4)?,
        at: row.get(5)?,
    })
}

/// Appends one change-history row for a diagram. Operates on any
/// `Connection` (including an open transaction) so a mutation and its event
/// commit atomically.
fn insert_diagram_event(
    conn: &Connection,
    diagram_id: i64,
    actor: Option<&str>,
    action: &str,
    summary: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO diagram_events (diagram_id, actor, action, summary, at) \
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        (diagram_id, actor, action, summary),
    )?;
    Ok(())
}

/// Describes an anchor-lock change to `edge` relative to `current` for the
/// `edge_anchor_changed` diagram event. Only called once at least one of
/// `from_anchor`/`to_anchor` differs between the two.
fn anchor_summary(edge: &FrameEdge, current: &FrameEdge) -> String {
    let from_changed = edge.from_anchor != current.from_anchor;
    let to_changed = edge.to_anchor != current.to_anchor;
    let arrow = format!("edge #{} \u{2192} #{}", edge.from_frame, edge.to_frame);
    if from_changed && to_changed {
        return format!(
            "changed anchors of {arrow} (from: {}, to: {})",
            anchor_state_str(edge.from_anchor),
            anchor_state_str(edge.to_anchor)
        );
    }
    let (end, old, new) = if from_changed {
        ("from", current.from_anchor, edge.from_anchor)
    } else {
        ("to", current.to_anchor, edge.to_anchor)
    };
    match (old, new) {
        (None, Some(side)) => format!("locked {end}-anchor of {arrow} to {}", side.as_str()),
        (Some(_), None) => format!("unlocked {end}-anchor of {arrow}"),
        (Some(old_side), Some(new_side)) => format!(
            "changed {end}-anchor of {arrow} from {} to {}",
            old_side.as_str(),
            new_side.as_str()
        ),
        (None, None) => unreachable!("anchor_summary called with no change"),
    }
}

fn anchor_state_str(side: Option<AnchorSide>) -> &'static str {
    match side {
        Some(s) => s.as_str(),
        None => "unlocked",
    }
}

/// Describes a style/marker change to `edge` relative to `current` for the
/// `edge_restyled` diagram event (mesa task 854). Only called once at least
/// one of the three differs, and names only the parts that actually changed —
/// `default` for a cleared one, mirroring `anchor_summary`'s `unlocked`.
fn restyle_summary(edge: &FrameEdge, current: &FrameEdge) -> String {
    let mut changed: Vec<String> = Vec::new();
    if edge.style != current.style {
        changed.push(format!(
            "style: {}",
            edge.style.map(EdgeStyle::as_str).unwrap_or("default")
        ));
    }
    if edge.from_marker != current.from_marker {
        changed.push(format!(
            "from-marker: {}",
            edge.from_marker
                .map(EdgeMarker::as_str)
                .unwrap_or("default")
        ));
    }
    if edge.to_marker != current.to_marker {
        changed.push(format!(
            "to-marker: {}",
            edge.to_marker.map(EdgeMarker::as_str).unwrap_or("default")
        ));
    }
    format!(
        "restyled edge #{} \u{2192} #{} ({})",
        edge.from_frame,
        edge.to_frame,
        changed.join(", ")
    )
}

/// Reads a diagram's frames, ordered by id. Operates on any `Connection`
/// (including an open transaction) so a delete can echo an atomic snapshot.
fn read_frames(conn: &Connection, diagram_id: i64) -> Result<Vec<Frame>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {FRAME_COLUMNS} FROM frames WHERE diagram_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([diagram_id], row_to_frame)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Reads a diagram's edges, ordered by id. Operates on any `Connection`
/// (including an open transaction).
fn read_edges(conn: &Connection, diagram_id: i64) -> Result<Vec<FrameEdge>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {EDGE_COLUMNS} FROM frame_edges WHERE diagram_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([diagram_id], row_to_edge)?;
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
    /// Manual nav order (task 666); the caller (the sidebar, via the API)
    /// computes the fractional value from the drop position, `Store` just
    /// persists it. Same division of labour as `TaskPatch::sort_order`.
    pub sort_order: Option<f64>,
    /// `Some(None)` detaches the project to top level (task 668) — the same
    /// double-Option shape `TaskPatch::parent_id` uses. Reparenting touches
    /// nothing else: `sort_order`, `archived`, `root_commit` and `local_path`
    /// are unchanged by it.
    pub parent_id: Option<Option<i64>>,
}

/// Fields to change on a task; `None` means leave unchanged.
/// A task's project is immutable: there is deliberately no `project_id` field.
#[derive(Debug, Default, Clone)]
pub struct TaskPatch {
    /// Replace-only: a task's description is its identity (task 660), so
    /// unlike the other free-text bodies there is no `Some(None)` clear —
    /// an empty replacement is a `validation` error, not an erasure.
    pub description: Option<String>,
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
    /// `Some(None)` clears the result (final-summary) field.
    pub result: Option<Option<String>>,
    /// Manual board order (spec 328); caller (the API) computes the
    /// fractional value from the drop position, `Store` just persists it.
    pub sort_order: Option<f64>,
    /// Append mode (spec 612): the three free-text bodies —
    /// `description`, `acceptance`, `result` — are appended to the stored
    /// value instead of replacing it, so a caller can annotate a batch of
    /// tasks without round-tripping every body through its own context.
    /// Every other field is unaffected. `Some(None)` (clear) is meaningless
    /// under append and is rejected by the caller, not here. Appending to a
    /// description leaves its first line — and therefore the task's `name` —
    /// untouched, which is what makes it safe on the identity field.
    pub append: bool,
}

/// Join an appended body onto the stored one (spec 612): trailing newlines on
/// the stored value are trimmed and exactly one blank line separates the two,
/// so repeated appends produce a stable markdown-ish block sequence. An empty
/// or absent stored value means the appended text becomes the whole field.
fn append_text(existing: Option<&str>, added: &str) -> String {
    match existing.map(|e| e.trim_end_matches('\n')).unwrap_or("") {
        "" => added.to_string(),
        base => format!("{base}\n\n{added}"),
    }
}

/// Fields to change on a diagram; `None` means leave unchanged. A
/// diagram's project and `author` (its creator) are immutable, so there is
/// deliberately no field for either.
#[derive(Debug, Default, Clone)]
pub struct DiagramPatch {
    pub title: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
}

/// Fields to change on a script; `None` means leave unchanged (task 785).
#[derive(Debug, Default, Clone)]
pub struct ScriptPatch {
    /// `Some(None)` un-binds the script from its project (making it global);
    /// `Some(Some(id))` binds it. An unknown id is a `validation` error.
    pub project_id: Option<Option<i64>>,
    /// Replace-only: a script's name is how the CLI resolves it, so an empty
    /// replacement is a `validation` error, not an erasure.
    pub name: Option<String>,
    /// `Some(None)` clears the description.
    pub description: Option<Option<String>>,
    /// Replace-only and non-empty — the body *is* the script.
    pub body: Option<String>,
    /// Replaces the full declared arg list.
    pub args: Option<Vec<ScriptArg>>,
}

/// A new frame to add to a diagram. Coordinates and size are caller-supplied
/// (the CLI/API apply sensible defaults); `task_id`, if given, must reference a
/// task in the diagram's project. `shape`, if given, must be a member of
/// the diagram's `diagram_type` shape set (validated by
/// `Store::create_frame`) — settable only at creation, no field on
/// `FramePatch`.
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
    pub shape: Option<FrameShape>,
}

/// Fields to change on a frame; `None` means leave unchanged. A frame's
/// diagram and `author` are immutable.
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

/// A new edge to add to a diagram. The endpoints must be two distinct frames
/// of that board; `from_marker`/`to_marker`, if given, must be members of the
/// board's `diagram_type` marker set (validated by `Store::create_edge`).
/// Mirrors `FrameNew` — a struct rather than a longer argument list, since an
/// edge now carries as many optional properties as a frame does.
#[derive(Debug, Default, Clone)]
pub struct EdgeNew {
    pub from_frame: i64,
    pub to_frame: i64,
    pub label: Option<String>,
    pub author: Option<String>,
    /// `None` is today's rendering (solid).
    pub style: Option<EdgeStyle>,
    /// `None` is today's rendering (nothing at the start).
    pub from_marker: Option<EdgeMarker>,
    /// `None` is today's rendering (a closed arrowhead).
    pub to_marker: Option<EdgeMarker>,
}

/// Fields to change on an edge; `None` means leave unchanged. Endpoints and
/// author are fixed at creation; everything else — label, waypoints, anchor
/// locks, and the task 854 style/markers — is mutable. Style and markers are
/// deliberately *not* immutable the way `Frame::shape`/`Diagram::diagram_type`
/// are: re-shaping a frame would move it into another type system, whereas
/// restyling a connector only changes how the same relation is drawn, and
/// `validate_edge_markers` re-runs on every patch so a marker can never land
/// on a board type that rejects it.
#[derive(Debug, Default, Clone)]
pub struct EdgePatch {
    /// `Some(None)` clears the label.
    pub label: Option<Option<String>>,
    /// `Some(vec)` replaces the full ordered waypoint list (including
    /// `Some(vec![])` to clear back to a straight auto-routed edge).
    /// `None` leaves the stored waypoints untouched.
    pub waypoints: Option<Vec<Waypoint>>,
    /// `Some(None)` unlocks (returns to floating); `Some(Some(side))` locks
    /// to that side; `None` leaves the current lock state untouched.
    pub from_anchor: Option<Option<AnchorSide>>,
    /// Same three-state contract as `from_anchor`, independent per endpoint.
    pub to_anchor: Option<Option<AnchorSide>>,
    /// `Some(None)` clears back to the default (solid); `Some(Some(style))`
    /// sets it; `None` leaves it untouched — `from_anchor`'s three-state
    /// contract exactly.
    pub style: Option<Option<EdgeStyle>>,
    /// Same three-state contract, for the `from_frame` end's decoration.
    pub from_marker: Option<Option<EdgeMarker>>,
    /// Same three-state contract, for the `to_frame` end's decoration.
    pub to_marker: Option<Option<EdgeMarker>>,
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
    /// The task itself; required, since task 660 made it the identity field.
    pub description: String,
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
    pub prompts: Vec<CcPromptRow>,
    /// Every `(session_id, agent_id)` pair whose lines this file carries —
    /// `agent_id` empty for the main thread. The pointer back to the
    /// transcript, written by `cc_ingest_file` from the path it already has.
    ///
    /// Derived from the lines themselves, never from `sessions`/`agent_runs`:
    /// a subagent transcript's lines carry the *parent's* `sessionId`, so
    /// deriving the main-thread pair from `sessions` would point every
    /// session at whichever subagent file was walked last.
    pub node_files: Vec<CcNodeFilePair>,
}

/// One `(session_id, agent_id)` pair observed in a transcript file.
/// `agent_id` is `""` for the main session thread — an empty string rather
/// than a NULL so the pair can be a composite primary key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CcNodeFilePair {
    pub session_id: String,
    pub agent_id: String,
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
/// every optional field is keep-first on conflict.
///
/// `agent`/`skill` come from the transcript lines themselves; the four spawn
/// fields come from the run's `.meta.json` sidecar (`core::cc::sidecar`) and
/// are `None` for a run whose sidecar is missing or unreadable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcAgentRunUpsert {
    pub session_id: String,
    pub agent_id: String,
    pub agent: Option<String>,
    pub skill: Option<String>,
    /// The `Task` tool call that spawned this run — the parent edge in
    /// [`crate::core::cc::session_graph`].
    pub tool_use_id: Option<String>,
    /// The spawning call's one-line description.
    pub description: Option<String>,
    /// 1 for a run spawned by the main thread, 2+ for a nested subagent.
    pub spawn_depth: Option<i64>,
    /// The spawning subagent's `agent_id`, when nested. Only a fallback: the
    /// `tool_use_id` edge is exact and present on every sidecar observed.
    pub parent_agent_id: Option<String>,
}

/// One assistant usage event. Keyed by the event `uuid`; re-inserting is a
/// no-op. Tokens only — cost is derived from the price table at read time,
/// never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcMessageRow {
    pub uuid: String,
    /// The API response this line belongs to (`message.id`) — the billing
    /// identity. Several transcript lines of one response repeat the identical
    /// usage block under one `message.id`, so reads sum usage once per
    /// `message_id` (`core::cc::dedupe_key`). `None` for a row ingested before
    /// migration 29, or a line genuinely without one: such a row falls back to
    /// its own `uuid`, so it is still counted exactly once, never dropped.
    pub message_id: Option<String>,
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
    /// A bounded preview of the prose this message emitted, already sanitized
    /// and character-capped by the ingest layer. `None` = the message carried
    /// no prose (tool-use only, or text that sanitized to empty), which is
    /// also how every row ingested before migration 24 reads.
    pub preview: Option<String>,
}

/// One human turn on a session's main thread. Keyed by the transcript line
/// `uuid`; re-inserting is a no-op.
///
/// `preview` is the whole payload: a sanitized, character-capped rendering of
/// what the user typed (or the slash command they ran), produced by
/// [`crate::core::cc::human_prompt`]. The prompt body itself is never stored —
/// the same bounded posture as [`CcMessageRow::preview`]. There is no
/// `agent_id`: sidechain (subagent) user lines are not prompts, so every row
/// here belongs to the main thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcPromptRow {
    pub uuid: String,
    pub session_id: String,
    pub ts: i64,
    pub preview: String,
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
    /// What the call acted on (a Bash command, a file path, a skill name),
    /// already sanitized and length-capped by [`crate::core::cc::tool_target`].
    /// `None` when the tool has no meaningful target, or when its input was
    /// unparseable.
    pub target: Option<String>,
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

// Serializes the open sequence across threads *in this process*. Two
// connections racing on `PRAGMA journal_mode=WAL`'s SHARED->EXCLUSIVE lock
// promotion hit `SQLITE_BUSY` *immediately* — that failure bypasses the busy
// handler entirely, so raising `busy_timeout` (confirmed up to 60s) never
// helps (task 336; task 332's "busy_timeout before the WAL pragma" reduced
// the window but can't close it, since the WAL pragma runs outside
// `migrate`'s own `BEGIN IMMEDIATE`). A same-process mutex removes that
// contention deterministically for the intra-process case (e.g. many
// threads in one `cargo test` run opening the same fresh db, as this test
// does). It does nothing for genuinely concurrent *processes* — that stays
// on `migrate`'s `BEGIN IMMEDIATE`, which still only covers schema creation,
// not this WAL conversion; a first-open race between two separate processes
// remains a narrow, unhandled edge (task-332 territory, not fixed here).
static OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let _guard = OPEN_LOCK.lock().unwrap();
        // busy_timeout first: a concurrent journal_mode=WAL conversion on a
        // brand-new db needs a brief exclusive lock, and must be able to wait
        // on it rather than fail outright.
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
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
        parent_id: Option<i64>,
    ) -> Result<Project> {
        if let Some(hash) = root_commit {
            self.ensure_commit_free(hash, None)?;
        }
        // A brand-new project has no id yet, so it cannot be part of a cycle;
        // the parent only has to exist.
        if let Some(parent) = parent_id {
            self.check_project_parent(parent, None)?;
        }
        // Sort last, by the same next-value rule `create_task` uses: one past
        // the current maximum rather than a count or a rowid, so a new project
        // lands at the end of the nav no matter how far prior reordering has
        // spread the fractional values.
        let next_sort_order: f64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM projects",
            [],
            |r| r.get(0),
        )?;
        self.conn
            .execute(
                "INSERT INTO projects (name, description, root_commit, local_path, sort_order, \
                 parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (
                    name,
                    description,
                    root_commit,
                    local_path,
                    next_sort_order,
                    parent_id,
                ),
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

    /// Every project visible to an unscoped read: neither archived nor
    /// descended from an archived project (task 668).
    ///
    /// One FLAT array, in `sort_order` order — the tree is assembled by the
    /// caller from `parent_id`, so `mesa project list`, `GET /api/projects`
    /// and the left nav still cannot disagree about sibling order.
    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.list_projects_where(&format!("WHERE {NOT_HIDDEN_PROJECT}"), HIDDEN_PROJECTS_CTE)
    }

    /// All projects, archived (or under an archived parent) and not, same
    /// order as `list_projects`.
    pub fn list_projects_all(&self) -> Result<Vec<Project>> {
        self.list_projects_where("", "")
    }

    /// Manual order first, id as the tiebreak (task 666): the migration
    /// backfills `sort_order = id`, so rows nobody has dragged stay in
    /// creation order, and the tiebreak keeps that stable even if two rows
    /// ever land on the same fractional value.
    fn list_projects_where(&self, clause: &str, cte: &str) -> Result<Vec<Project>> {
        let mut stmt = self.conn.prepare(&format!(
            "{cte}SELECT {PROJECT_COLUMNS} FROM projects p {clause} ORDER BY sort_order, id"
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
        if let rusqlite::Error::SqliteFailure(f, _) = &e
            && f.code == rusqlite::ErrorCode::ConstraintViolation
        {
            return Error::Conflict(format!(
                "root commit {hash} is already bound to another project"
            ));
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
        if let Some(sort_order) = patch.sort_order {
            project.sort_order = sort_order;
        }
        if let Some(parent_id) = patch.parent_id {
            if let Some(parent) = parent_id {
                self.check_project_parent(parent, Some(id))?;
            }
            project.parent_id = parent_id;
        }
        self.conn
            .execute(
                "UPDATE projects SET name = ?1, description = ?2, root_commit = ?3, \
                 local_path = ?4, sort_order = ?5, parent_id = ?6 WHERE id = ?7",
                (
                    &project.name,
                    &project.description,
                    &project.root_commit,
                    &project.local_path,
                    project.sort_order,
                    project.parent_id,
                    id,
                ),
            )
            .map_err(|e| match &project.root_commit {
                Some(hash) => Self::map_commit_conflict(e, hash),
                None => Error::Db(e),
            })?;
        Ok(project)
    }

    /// Hides the project from unscoped views. Idempotent: archiving an
    /// already-archived project succeeds and returns its current state.
    pub fn archive_project(&mut self, id: i64) -> Result<Project> {
        self.get_project(id)?;
        self.conn
            .execute("UPDATE projects SET archived = 1 WHERE id = ?1", [id])?;
        self.get_project(id)
    }

    /// Reverses `archive_project`. Idempotent: unarchiving an
    /// already-unarchived project succeeds and returns its current state.
    pub fn unarchive_project(&mut self, id: i64) -> Result<Project> {
        self.get_project(id)?;
        self.conn
            .execute("UPDATE projects SET archived = 0 WHERE id = ?1", [id])?;
        self.get_project(id)
    }

    /// Validates a candidate `parent` for a project: it must exist, and — when
    /// the child already has an id (`child`, `None` on create) — the edge must
    /// not close a cycle. Mirrors the task-parent rules, with the same split
    /// of error kinds: a missing parent is `validation` (a bad reference),
    /// while self-parenting or a loop is `cycle`.
    fn check_project_parent(&self, parent: i64, child: Option<i64>) -> Result<()> {
        if Some(parent) == child {
            let child = child.unwrap();
            return Err(Error::Cycle(format!(
                "project {child} cannot be its own parent"
            )));
        }
        if let Err(Error::NotFound(_)) = self.get_project(parent) {
            return Err(Error::Validation(format!(
                "parent project {parent} not found"
            )));
        }
        if let Some(child) = child
            && self.project_descendant_ids(child)?.contains(&parent)
        {
            return Err(Error::Cycle(format!(
                "making project {parent} the parent of project {child} would create a cycle: \
                 project {parent} is already a descendant of project {child}"
            )));
        }
        Ok(())
    }

    /// Ids of every project under `id`, at any depth (the project itself is
    /// not included). `UNION` (not `UNION ALL`) so a malformed cycle
    /// terminates instead of recursing forever.
    fn project_descendant_ids(&self, id: i64) -> Result<HashSet<i64>> {
        let mut stmt = self.conn.prepare(
            "WITH RECURSIVE sub(id) AS ( \
                 SELECT id FROM projects WHERE parent_id = ?1 \
                 UNION \
                 SELECT c.id FROM projects c JOIN sub ON c.parent_id = sub.id \
             ) SELECT id FROM sub",
        )?;
        let rows = stmt.query_map([id], |r| r.get::<_, i64>(0))?;
        Ok(rows.collect::<rusqlite::Result<HashSet<_>>>()?)
    }

    /// Deletes the project, every project beneath it and all of their tasks;
    /// returns the destroyed records: the root, its descendants (depth-first,
    /// each level in list order) and the tasks of all of them in that same
    /// project order.
    ///
    /// The subtree goes with it via the `parent_id` FK's `ON DELETE CASCADE`
    /// (task 668) — the echo is read first, in the same transaction, because
    /// it is the recovery transcript that stands in for the confirmation
    /// prompt mesa deliberately does not have, and it has to carry *every*
    /// destroyed row.
    pub fn delete_project(&mut self, id: i64) -> Result<(Project, Vec<Project>, Vec<Task>)> {
        let project = self.get_project(id)?;
        let tx = self.conn.transaction()?;
        let subprojects = {
            // One read of the project table, ordered the way every other
            // project list is, then walked depth-first — so the echo's order
            // is the tree's shape rather than whatever order the FK cascade
            // happens to fire in.
            let mut stmt = tx.prepare(&format!(
                "SELECT {PROJECT_COLUMNS} FROM projects p ORDER BY sort_order, id"
            ))?;
            let all = stmt
                .query_map([], row_to_project)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut out = Vec::new();
            collect_subtree(&all, id, &mut HashSet::new(), &mut out);
            out
        };
        let tasks = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {TASK_COLUMNS} FROM tasks t WHERE t.project_id = ?1 ORDER BY t.id"
            ))?;
            let mut tasks = Vec::new();
            for pid in std::iter::once(id).chain(subprojects.iter().map(|p| p.id)) {
                let rows = stmt.query_map([pid], row_to_task)?;
                tasks.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
            }
            tasks
        };
        tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok((project, subprojects, tasks))
    }

    // ---- tasks ----

    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        &mut self,
        project_id: i64,
        description: &str,
        priority: Priority,
        tags: &[String],
        parent_id: Option<i64>,
        acceptance: Option<&str>,
        artifact: Option<&str>,
        status: Option<Status>,
    ) -> Result<Task> {
        // A task's description is its identity (task 660) — an empty one would
        // leave the row with nothing to show but its id.
        if description.trim().is_empty() {
            return Err(Error::Validation("description must not be empty".into()));
        }
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
        // New tasks append to the end of the board's manual order (spec 328),
        // regardless of how far prior reordering has spread sort_order values.
        let next_sort_order: f64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks",
            [],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO tasks \
             (project_id, parent_id, description, priority, tags, acceptance, artifact, \
              status, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))",
            (
                project_id,
                parent_id,
                description,
                priority.as_str(),
                tags_json,
                acceptance,
                artifact,
                status.unwrap_or(Status::Todo).as_str(),
                next_sort_order,
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
            "SELECT id, description FROM tasks ORDER BY ABS(id - ?1), id LIMIT 1",
            [id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            },
        );
        match nearest {
            // One truncation rule for the whole codebase — the same `name` the
            // board and `task list` show (task 660).
            Ok((near_id, description)) => {
                let short = task_name(&description, near_id);
                format!("task {id} not found; nearest existing task is {near_id} \"{short}\"")
            }
            Err(_) => format!("task {id} not found; no tasks exist yet"),
        }
    }

    /// Lists tasks. Scoped to `project` if given (archived-agnostic, matching
    /// every other scoped read); when `None`, excludes tasks whose project is
    /// hidden — archived, or under an archived ancestor (task 668) — so
    /// unscoped views don't surface an archived project's work.
    pub fn list_tasks(&self, project: Option<i64>) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(&format!(
            "{HIDDEN_PROJECTS_CTE}SELECT {TASK_COLUMNS} FROM tasks t \
             JOIN projects p ON p.id = t.project_id \
             WHERE (?1 IS NULL OR t.project_id = ?1) \
             AND (?1 IS NOT NULL OR {NOT_HIDDEN_PROJECT}) \
             ORDER BY t.sort_order, t.id"
        ))?;
        let rows = stmt.query_map([project], row_to_task)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_task(&mut self, id: i64, patch: &TaskPatch) -> Result<Task> {
        let mut task = self.get_task(id)?;
        let old_status = task.status;
        if let Some(description) = &patch.description {
            task.description = if patch.append {
                append_text(Some(task.description.as_str()), description)
            } else {
                if description.trim().is_empty() {
                    return Err(Error::Validation("description must not be empty".into()));
                }
                description.clone()
            };
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
            task.acceptance = if patch.append {
                acceptance
                    .as_deref()
                    .map(|added| append_text(task.acceptance.as_deref(), added))
            } else {
                acceptance.clone()
            };
        }
        if let Some(artifact) = &patch.artifact {
            task.artifact = artifact.clone();
        }
        if let Some(result) = &patch.result {
            task.result = if patch.append {
                result
                    .as_deref()
                    .map(|added| append_text(task.result.as_deref(), added))
            } else {
                result.clone()
            };
        }
        if let Some(sort_order) = patch.sort_order {
            task.sort_order = sort_order;
        }
        let tags_json = serde_json::to_string(&task.tags).expect("tags serialize");
        let status_changed = task.status != old_status;
        // A claim is only meaningful while the task is `in_progress`, so any
        // move out of it drops the claim rather than leaving a done/cancelled
        // row owned forever. Moving *into* `in_progress` leaves the claim
        // fields alone — `claim_task` is what takes ownership.
        if status_changed && task.status != Status::InProgress {
            task.owner = None;
            task.claimed_at = None;
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE tasks SET description = ?1, status = ?2, priority = ?3, \
             tags = ?4, parent_id = ?5, acceptance = ?6, artifact = ?7, result = ?8, \
             sort_order = ?9, owner = ?11, claimed_at = ?12, \
             updated_at = datetime('now') WHERE id = ?10",
            (
                &task.description,
                task.status.as_str(),
                task.priority.as_str(),
                tags_json,
                task.parent_id,
                &task.acceptance,
                &task.artifact,
                &task.result,
                task.sort_order,
                id,
                &task.owner,
                &task.claimed_at,
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

    /// Takes (or renews) the claim on a task and moves it to `in_progress`.
    ///
    /// `owner` is opaque to `Store` — the convention is the caller's Claude
    /// Code session id, which makes the claim's liveness checkable out-of-band
    /// rather than inferred from a timestamp. Renewing (same `owner`) restamps
    /// `claimed_at`, so a long-running holder can heartbeat.
    ///
    /// Held by a *different* owner while `in_progress` is a `Conflict` — that
    /// is the guard against two agents in one repo. `force` breaks such a
    /// claim (the documented stale-claim override). A claim on a task that is
    /// not `in_progress` is not a live hold, so it is taken over without
    /// `force`; the same goes for an `in_progress` row with no owner at all
    /// (a status flip by something that predates claims, e.g. the dispatcher).
    ///
    /// The conflict check and the write share ONE `Immediate` transaction, so
    /// this is not check-then-write: a concurrent claimer (CLI vs server, or
    /// two CLI processes — mesa supports both, see the WAL + `busy_timeout`
    /// note in the crate docs) either waits for the write lock and then reads
    /// the winner's owner, or times out. Reading the row outside the
    /// transaction would let two claimers both see "unowned" and both write,
    /// silently handing the task to whoever committed last — the exact
    /// two-agents-in-one-repo failure the conflict exists to prevent.
    pub fn claim_task(&mut self, id: i64, owner: &str, force: bool) -> Result<Task> {
        let owner = owner.trim();
        if owner.is_empty() {
            return Err(Error::Validation("owner must not be empty".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (status, held_by, claimed_at) = tx
            .query_row(
                "SELECT status, owner, claimed_at FROM tasks WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("task {id}")),
                e => Error::Db(e),
            })?;
        let status = Status::parse(&status).expect("invalid status in db");
        if !force
            && status == Status::InProgress
            && let Some(held_by) = &held_by
            && held_by != owner
        {
            return Err(Error::Conflict(format!(
                "task {id} is claimed by {held_by} (since {}); \
                 pass --force to break the claim",
                claimed_at.as_deref().unwrap_or("unknown")
            )));
        }
        let status_changed = status != Status::InProgress;
        tx.execute(
            "UPDATE tasks SET status = 'in_progress', owner = ?1, \
             claimed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2",
            (owner, id),
        )?;
        if status_changed {
            tx.execute(
                "INSERT INTO task_events (task_id, from_status, to_status, at) \
                 VALUES (?1, ?2, 'in_progress', datetime('now'))",
                (id, status.as_str()),
            )?;
        }
        tx.commit()?;
        self.get_task(id)
    }

    /// Drops the claim on a task, leaving its status untouched. Idempotent: an
    /// unclaimed task releases successfully. Deliberately unguarded — this is
    /// the tool for clearing an abandoned claim, so it takes no owner and
    /// never conflicts.
    pub fn release_task(&mut self, id: i64) -> Result<Task> {
        self.get_task(id)?;
        self.conn.execute(
            "UPDATE tasks SET owner = NULL, claimed_at = NULL, \
             updated_at = datetime('now') WHERE id = ?1",
            [id],
        )?;
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
        // Duplicate refs would make resolution ambiguous. A description is the
        // task's identity, so import enforces the same non-empty rule as
        // `create_task` — both pre-transaction, so nothing is created.
        let mut refs: HashMap<&str, i64> = HashMap::new();
        for t in &doc.tasks {
            if refs.insert(t.ref_.as_str(), 0).is_some() {
                return Err(Error::Validation(format!(
                    "duplicate task ref \"{}\" in import document",
                    t.ref_
                )));
            }
            if t.description.trim().is_empty() {
                return Err(Error::Validation(format!(
                    "task ref \"{}\" has an empty description",
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
                 (project_id, description, priority, tags, acceptance, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))",
                (
                    doc.project,
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
        let blocked_expr = BLOCKED_EXPR;
        let priority_rank = PRIORITY_RANK;
        let task = {
            let sql = format!(
                "{HIDDEN_PROJECTS_CTE}SELECT {TASK_COLUMNS} FROM tasks t \
                 JOIN projects p ON p.id = t.project_id \
                 WHERE t.status = 'todo' AND NOT {blocked_expr} \
                 AND (?1 IS NULL OR t.project_id = ?1) \
                 AND (?1 IS NOT NULL OR {NOT_HIDDEN_PROJECT}) \
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
                "{HIDDEN_PROJECTS_CTE}SELECT COUNT(*) FROM tasks t \
                 JOIN projects p ON p.id = t.project_id \
                 WHERE (?1 IS NULL OR t.project_id = ?1) \
                 AND (?1 IS NOT NULL OR {NOT_HIDDEN_PROJECT}) AND {predicate}"
            );
            Ok(self.conn.query_row(&sql, [project], |r| r.get(0))?)
        };
        Ok(NextResult::None {
            blocked: count(&format!("t.status = 'todo' AND {blocked_expr}"))?,
            in_progress: count("t.status = 'in_progress'")?,
            todo: count(&format!("t.status = 'todo' AND NOT {blocked_expr}"))?,
        })
    }

    /// Selects the next actionable task from among the **descendants** of
    /// `parents` (their subtasks, at any depth) — the same `todo`-and-not-
    /// blocked rule and the same priority-then-id ordering as
    /// [`Store::next_task`], scoped to a set of subtrees instead of a project.
    /// The parents themselves are never candidates. Returns `None` when
    /// `parents` is empty or nothing under them is actionable.
    ///
    /// Like any project-scoped read, this ignores `projects.archived`; a
    /// subtask shares its parent's project, so the caller has already chosen
    /// the project by choosing the parents (mesa task 570).
    pub fn next_subtask(&self, parents: &[i64]) -> Result<Option<Task>> {
        if parents.is_empty() {
            return Ok(None);
        }
        let placeholders = parents.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        // `UNION` (not `UNION ALL`) so a malformed parent cycle terminates
        // instead of recursing forever.
        let sql = format!(
            "WITH RECURSIVE sub(id) AS ( \
                 SELECT id FROM tasks WHERE parent_id IN ({placeholders}) \
                 UNION \
                 SELECT c.id FROM tasks c JOIN sub ON c.parent_id = sub.id \
             ) \
             SELECT {TASK_COLUMNS} FROM tasks t WHERE t.id IN (SELECT id FROM sub) \
             AND t.status = 'todo' AND NOT {BLOCKED_EXPR} \
             ORDER BY {PRIORITY_RANK}, t.id LIMIT 1"
        );
        self.conn
            .query_row(&sql, rusqlite::params_from_iter(parents), row_to_task)
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(Error::Db(e)),
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

    /// Lists the tasks that `task_id` directly blocks — the reverse of
    /// [`list_blockers`](Self::list_blockers) along the same edge set.
    pub fn list_blocking(&self, task_id: i64) -> Result<Vec<Task>> {
        self.get_task(task_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks t \
             JOIN dependencies d ON d.task_id = t.id \
             WHERE d.blocked_by = ?1 ORDER BY t.id"
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

    // ---- diagrams ----

    /// Creates a diagram in an existing project. The project is fixed at
    /// creation (immutable thereafter), mirroring tasks. `diagram_type`
    /// defaults to `DiagramType::Storyboard` when omitted, matching the
    /// column default — immutable after creation (no field on
    /// `DiagramPatch`).
    pub fn create_diagram(
        &mut self,
        project_id: i64,
        title: &str,
        description: Option<&str>,
        author: Option<&str>,
        diagram_type: Option<DiagramType>,
    ) -> Result<Diagram> {
        let project_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Err(Error::Validation(format!("project {project_id} not found")));
        }
        let diagram_type = diagram_type.unwrap_or(DiagramType::Storyboard);
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO diagrams (project_id, title, description, author, diagram_type, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))",
                (project_id, title, description, author, diagram_type.as_str()),
            )?;
            let id = tx.last_insert_rowid();
            insert_diagram_event(
                &tx,
                id,
                author,
                "diagram_created",
                &format!("created diagram '{title}'"),
            )?;
            tx.commit()?;
            id
        };
        self.get_diagram(id)
    }

    pub fn get_diagram(&self, id: i64) -> Result<Diagram> {
        self.conn
            .query_row(
                &format!("SELECT {DIAGRAM_COLUMNS} FROM diagrams WHERE id = ?1"),
                [id],
                row_to_diagram,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("diagram {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Lists diagrams, newest activity is not implied — ordered by id.
    /// Scoped to `project` if given (archived-agnostic); when `None`, excludes
    /// diagrams whose project is archived. Frames and edges are omitted
    /// (the compact list shape); use `get_diagram_view` for a board's full
    /// contents.
    pub fn list_diagrams(&self, project: Option<i64>) -> Result<Vec<Diagram>> {
        // DIAGRAM_COLUMNS is unqualified; under the join both `id` and
        // `description` collide with `projects` columns, so this query
        // aliases the table and qualifies every column explicitly instead of
        // reusing the shared constant.
        let mut stmt = self.conn.prepare(&format!(
            "{HIDDEN_PROJECTS_CTE}SELECT s.id, s.project_id, s.title, s.description, s.author, \
             s.diagram_type, s.created_at, s.updated_at \
             FROM diagrams s JOIN projects p ON p.id = s.project_id \
             WHERE (?1 IS NULL OR s.project_id = ?1) \
             AND (?1 IS NOT NULL OR {NOT_HIDDEN_PROJECT}) \
             ORDER BY s.id"
        ))?;
        let rows = stmt.query_map([project], row_to_diagram)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Returns a board's full contents: the diagram plus its frames and
    /// edges (each ordered by id). `NotFound` if the board is absent.
    pub fn get_diagram_view(&self, id: i64) -> Result<DiagramView> {
        let diagram = self.get_diagram(id)?;
        let frames = read_frames(&self.conn, id)?;
        let edges = read_edges(&self.conn, id)?;
        Ok(DiagramView {
            diagram,
            frames,
            edges,
        })
    }

    pub fn update_diagram(
        &mut self,
        id: i64,
        patch: &DiagramPatch,
        actor: Option<&str>,
    ) -> Result<Diagram> {
        let current = self.get_diagram(id)?;
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
            "UPDATE diagrams SET title = ?1, description = ?2, updated_at = datetime('now') \
             WHERE id = ?3",
            (&sb.title, &sb.description, id),
        )?;
        insert_diagram_event(&tx, id, actor, "diagram_edited", "edited board details")?;
        tx.commit()?;
        self.get_diagram(id)
    }

    /// Deletes a diagram and all its frames, edges, and history (cascade).
    /// Returns the full destroyed contents so the transcript stays a recoverable
    /// record. The echo read and the delete run in one transaction, so the
    /// echoed contents exactly match what was destroyed even under a concurrent
    /// writer. No change-history row is written: the board's history dies with
    /// it, and the delete echo is the recoverable record.
    pub fn delete_diagram(&mut self, id: i64) -> Result<DiagramView> {
        let tx = self.conn.transaction()?;
        let diagram = tx
            .query_row(
                &format!("SELECT {DIAGRAM_COLUMNS} FROM diagrams WHERE id = ?1"),
                [id],
                row_to_diagram,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("diagram {id} not found"))
                }
                e => Error::Db(e),
            })?;
        let frames = read_frames(&tx, id)?;
        let edges = read_edges(&tx, id)?;
        tx.execute("DELETE FROM diagrams WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(DiagramView {
            diagram,
            frames,
            edges,
        })
    }

    /// Lists a diagram's change history, oldest first. `NotFound` if the
    /// board is absent.
    pub fn list_diagram_events(&self, diagram_id: i64) -> Result<Vec<DiagramEvent>> {
        self.get_diagram(diagram_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {DIAGRAM_EVENT_COLUMNS} FROM diagram_events \
             WHERE diagram_id = ?1 ORDER BY id"
        ))?;
        let rows = stmt.query_map([diagram_id], row_to_diagram_event)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- frames ----

    /// Adds a frame to an existing diagram. An unknown diagram is a
    /// validation error (the id is a request parameter, like a task's project).
    /// A `task_id`, if given, must reference a task in the board's project.
    /// `new.shape`, if given, must be a member of the board's `diagram_type`
    /// shape set — a `storyboard` board takes no shape, a `flowchart` board
    /// takes `process`/`decision`/`start_end`, an `erd` board takes only
    /// `entity`, a `brainstorm` board takes `central`/`idea`; a mismatch is a
    /// validation error.
    pub fn create_frame(&mut self, diagram_id: i64, new: &FrameNew) -> Result<Frame> {
        let sb = match self.get_diagram(diagram_id) {
            Ok(sb) => sb,
            Err(Error::NotFound(_)) => {
                return Err(Error::Validation(format!("diagram {diagram_id} not found")));
            }
            Err(e) => return Err(e),
        };
        let project_id = sb.project_id;
        if let Some(task_id) = new.task_id {
            self.check_frame_task(task_id, project_id)?;
        }
        validate_frame_shape(sb.diagram_type, new.shape)?;
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO frames \
                 (diagram_id, title, body, x, y, w, h, color, task_id, author, shape, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))",
                rusqlite::params![
                    diagram_id,
                    new.title,
                    new.body,
                    new.x,
                    new.y,
                    new.w,
                    new.h,
                    new.color,
                    new.task_id,
                    new.author,
                    new.shape.map(FrameShape::as_str),
                ],
            )?;
            let id = tx.last_insert_rowid();
            insert_diagram_event(
                &tx,
                diagram_id,
                new.author.as_deref(),
                "frame_added",
                // The canvas creates frames untitled so the user types straight
                // into a focused, empty title field (mesa task 448), so the
                // common case here is an empty title — spell that out rather
                // than logging a bare `added frame '' (#N)`.
                &if new.title.trim().is_empty() {
                    format!("added untitled frame (#{id})")
                } else {
                    format!("added frame '{}' (#{id})", new.title)
                },
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
                let sb = self.get_diagram(f.diagram_id)?;
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
        insert_diagram_event(&tx, f.diagram_id, actor, action, &summary)?;
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
        insert_diagram_event(
            &tx,
            frame.diagram_id,
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
                "task {task_id} belongs to project {task_project}, not the diagram's \
                 project {project_id}: a frame may only link a task in its own project"
            )));
        }
        Ok(())
    }

    // ---- edges ----

    /// Connects two frames of the same diagram with a directed edge. Rejects
    /// an unknown board, a self-edge, or an endpoint that is not a frame of this
    /// board — all validation errors. Cycles are allowed. `new.from_marker`/
    /// `new.to_marker`, if given, must be members of the board's
    /// `diagram_type` marker set (the cardinality family is `erd`-only); a
    /// mismatch is a validation error. `new.style` needs no check — every
    /// style is valid on every board type.
    pub fn create_edge(&mut self, diagram_id: i64, new: &EdgeNew) -> Result<FrameEdge> {
        // The board's own type, read by the existence check itself rather than
        // a second query: the marker rule needs it.
        let diagram_type: Option<String> = self
            .conn
            .query_row(
                "SELECT diagram_type FROM diagrams WHERE id = ?1",
                [diagram_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(diagram_type) = diagram_type else {
            return Err(Error::Validation(format!("diagram {diagram_id} not found")));
        };
        let diagram_type = DiagramType::parse(&diagram_type).expect("invalid diagram type in db");
        let (from_frame, to_frame) = (new.from_frame, new.to_frame);
        if from_frame == to_frame {
            return Err(Error::Validation(format!(
                "frame {from_frame} cannot connect to itself"
            )));
        }
        self.check_frame_in_diagram(from_frame, diagram_id, "from")?;
        self.check_frame_in_diagram(to_frame, diagram_id, "to")?;
        validate_edge_markers(diagram_type, new.from_marker, new.to_marker)?;
        let summary = match new.label.as_deref() {
            Some(l) if !l.is_empty() => {
                format!("connected #{from_frame} \u{2192} #{to_frame} ({l})")
            }
            _ => format!("connected #{from_frame} \u{2192} #{to_frame}"),
        };
        let id = {
            let tx = self.conn.transaction()?;
            tx.execute(
                "INSERT INTO frame_edges \
                 (diagram_id, from_frame, to_frame, label, author, style, from_marker, to_marker, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
                rusqlite::params![
                    diagram_id,
                    from_frame,
                    to_frame,
                    new.label,
                    new.author,
                    new.style.map(EdgeStyle::as_str),
                    new.from_marker.map(EdgeMarker::as_str),
                    new.to_marker.map(EdgeMarker::as_str),
                ],
            )?;
            let id = tx.last_insert_rowid();
            insert_diagram_event(
                &tx,
                diagram_id,
                new.author.as_deref(),
                "edge_added",
                &summary,
            )?;
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
        if let Some(from_anchor) = &patch.from_anchor {
            edge.from_anchor = *from_anchor;
        }
        if let Some(to_anchor) = &patch.to_anchor {
            edge.to_anchor = *to_anchor;
        }
        if let Some(style) = &patch.style {
            edge.style = *style;
        }
        if let Some(from_marker) = &patch.from_marker {
            edge.from_marker = *from_marker;
        }
        if let Some(to_marker) = &patch.to_marker {
            edge.to_marker = *to_marker;
        }
        // No-op patch: change nothing and log nothing.
        if edge == current {
            return Ok(current);
        }
        // The board's type is only needed to judge markers, so it is only read
        // when a marker is actually being set — a label or waypoint patch
        // still costs exactly the queries it did before.
        if patch.from_marker.is_some() || patch.to_marker.is_some() {
            let diagram = self.get_diagram(edge.diagram_id)?;
            validate_edge_markers(diagram.diagram_type, edge.from_marker, edge.to_marker)?;
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE frame_edges SET label = ?1, waypoints = ?2, from_anchor = ?3, to_anchor = ?4, \
             style = ?5, from_marker = ?6, to_marker = ?7 \
             WHERE id = ?8",
            rusqlite::params![
                &edge.label,
                serde_json::to_string(&edge.waypoints).unwrap(),
                edge.from_anchor.map(|a| a.as_str()),
                edge.to_anchor.map(|a| a.as_str()),
                edge.style.map(EdgeStyle::as_str),
                edge.from_marker.map(EdgeMarker::as_str),
                edge.to_marker.map(EdgeMarker::as_str),
                id,
            ],
        )?;
        let anchor_changed =
            edge.from_anchor != current.from_anchor || edge.to_anchor != current.to_anchor;
        let restyled = edge.style != current.style
            || edge.from_marker != current.from_marker
            || edge.to_marker != current.to_marker;
        // One event per call, most-structural first. Anchors stay at the top
        // (they decide where the connector attaches at all); `edge_restyled`
        // sits next because a style or a marker changes what the connector
        // *means* — a crow's foot states a cardinality — while a reroute or a
        // relabel only changes how that same meaning is drawn or annotated.
        let (action, summary) = if anchor_changed {
            ("edge_anchor_changed", anchor_summary(&edge, &current))
        } else if restyled {
            ("edge_restyled", restyle_summary(&edge, &current))
        } else if patch.waypoints.is_some() && edge.waypoints != current.waypoints {
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
        insert_diagram_event(&tx, edge.diagram_id, actor, action, &summary)?;
        tx.commit()?;
        self.get_edge(id)
    }

    pub fn delete_edge(&mut self, id: i64, actor: Option<&str>) -> Result<FrameEdge> {
        let edge = self.get_edge(id)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM frame_edges WHERE id = ?1", [id])?;
        insert_diagram_event(
            &tx,
            edge.diagram_id,
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

    /// Validates that `frame_id` exists and belongs to `diagram_id`. `which`
    /// ("from"/"to") names the offending endpoint in the error message.
    fn check_frame_in_diagram(&self, frame_id: i64, diagram_id: i64, which: &str) -> Result<()> {
        let frame_board: Option<i64> = self
            .conn
            .query_row(
                "SELECT diagram_id FROM frames WHERE id = ?1",
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
        if frame_board != diagram_id {
            return Err(Error::Validation(format!(
                "{which} frame {frame_id} belongs to diagram {frame_board}, not \
                 diagram {diagram_id}: an edge must connect two frames of the same board"
            )));
        }
        Ok(())
    }

    // ---- inbox (global update requests) ----

    /// Adds an item to the global inbox: a free-text update request not yet tied
    /// to any project. New items are always unassigned (`project_id` null); a
    /// person routes them to a project later via `assign_inbox_item`. The single
    /// write path for inbox items.
    ///
    /// `kind` says what the item is for (mesa task 846) and is fixed at
    /// creation: a caller that names none sends a task summary, the kind that
    /// waits for a person.
    ///
    /// `task_id` is **required** (mesa task 847): an item always comes from an
    /// agent working a task, and naming it is what lets the reader see the
    /// project and the piece of work a report is about. An unknown task is a
    /// `validation` error, mirroring `assign_inbox_item`'s unknown project.
    pub fn create_inbox_item(
        &mut self,
        author: Option<&str>,
        body: &str,
        kind: InboxKind,
        task_id: i64,
    ) -> Result<InboxItem> {
        let task_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
            [task_id],
            |r| r.get(0),
        )?;
        if !task_exists {
            return Err(Error::Validation(format!("task {task_id} not found")));
        }
        self.conn.execute(
            "INSERT INTO inbox (project_id, author, body, kind, task_id, created_at, updated_at) \
             VALUES (NULL, ?1, ?2, ?3, ?4, datetime('now'), datetime('now'))",
            (author, body, kind.as_str(), task_id),
        )?;
        self.get_inbox_item(self.conn.last_insert_rowid())
    }

    pub fn get_inbox_item(&self, id: i64) -> Result<InboxItem> {
        self.conn
            .query_row(
                &format!("SELECT {INBOX_COLUMNS} {INBOX_FROM} WHERE i.id = ?1"),
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
            "SELECT {INBOX_COLUMNS} {INBOX_FROM} \
             WHERE (?1 IS NULL OR i.project_id = ?1) ORDER BY i.id DESC"
        ))?;
        let rows = stmt.query_map([project], row_to_inbox_item)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Routes an inbox item to a project by **converting it into a backlog
    /// task** in that project and then deleting the item — it "moves" out of
    /// the inbox onto the board, pending triage. The task's description is the
    /// item's body **verbatim** — since task 660 a task has no title to derive,
    /// and the board label comes from the body's first line for free
    /// (`types::task_name`, 50 chars — deliberately not the same width as the
    /// inbox watcher's own 60-char session name, which has its own fallback);
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
             (project_id, parent_id, description, priority, tags, acceptance, artifact, \
              status, created_at, updated_at) \
             VALUES (?1, NULL, ?2, ?3, '[]', NULL, NULL, ?4, datetime('now'), datetime('now'))",
            (
                project_id,
                &item.body,
                Priority::Medium.as_str(),
                Status::Backlog.as_str(),
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

    /// Marks an inbox item **read**, stamping `read_at` with the moment it was
    /// first read (mesa task 831). Idempotent by design: a second call is a
    /// no-op that returns the item unchanged, so the stamp is *when you first
    /// read it* and re-opening an item never moves it. Nothing un-reads an
    /// item — reading is a fact about the past, not a flag to toggle.
    pub fn mark_inbox_item_read(&mut self, id: i64) -> Result<InboxItem> {
        // The read first, for the `not_found` the caller expects. The stamp is
        // then written by ONE statement whose `read_at IS NULL` decides it:
        // the CLI opens its own `Store` beside the server's, so a check-then-
        // act pair here would let two writers both find it unread and the
        // second move a stamp this method promises never moves.
        self.get_inbox_item(id)?;
        self.conn.execute(
            "UPDATE inbox SET read_at = datetime('now'), updated_at = datetime('now') \
             WHERE id = ?1 AND read_at IS NULL",
            [id],
        )?;
        self.get_inbox_item(id)
    }

    /// Archives an inbox item, or puts it back (mesa task 845): sets aside an
    /// item that needs no triage without destroying it, which is the third
    /// thing that can happen to an item beside "assign" and "delete".
    ///
    /// Unlike `read_at`, this one *toggles* — archiving is a place an item
    /// sits, not a fact about the past — so `archived_at` is the moment it was
    /// last archived, and un-archiving clears it. Idempotent in both
    /// directions: re-archiving an archived item leaves its stamp alone.
    pub fn set_inbox_item_archived(&mut self, id: i64, archived: bool) -> Result<InboxItem> {
        // The read first, for the `not_found` the caller expects; the write
        // then decides on the row itself (see `mark_inbox_item_read`) so a
        // second archiver cannot move a stamp the first one set.
        self.get_inbox_item(id)?;
        if archived {
            self.conn.execute(
                "UPDATE inbox SET archived_at = datetime('now'), updated_at = datetime('now') \
                 WHERE id = ?1 AND archived_at IS NULL",
                [id],
            )?;
        } else {
            self.conn.execute(
                "UPDATE inbox SET archived_at = NULL, updated_at = datetime('now') \
                 WHERE id = ?1 AND archived_at IS NOT NULL",
                [id],
            )?;
        }
        self.get_inbox_item(id)
    }

    /// Deletes an inbox item; returns the destroyed record (the recoverable
    /// echo — there is no history table for the inbox).
    pub fn delete_inbox_item(&mut self, id: i64) -> Result<InboxItem> {
        let item = self.get_inbox_item(id)?;
        self.conn.execute("DELETE FROM inbox WHERE id = ?1", [id])?;
        Ok(item)
    }

    // ---- mesa live (task 855) ----

    /// Starts a live conversation. **At most one session is `live` at a
    /// time**: starting while one is running is a `conflict` naming the id
    /// that is already live, because the Live page has one text field and one
    /// `<audio>` element and a second conversation would have nowhere to be
    /// heard. An unknown `project_id` is a `validation` error, mirroring
    /// `assign_inbox_item`.
    pub fn start_live_session(&mut self, project_id: Option<i64>) -> Result<LiveSession> {
        if let Some(id) = project_id {
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::Validation(format!("project {id} not found")));
            }
        }
        if let Some(live) = self.current_live_session()? {
            return Err(Error::Conflict(format!(
                "live session {} is already running; stop it first",
                live.id
            )));
        }
        self.conn.execute(
            "INSERT INTO live_sessions (project_id, status, started_at, updated_at) \
             VALUES (?1, ?2, datetime('now'), datetime('now'))",
            (project_id, LiveStatus::Live.as_str()),
        )?;
        self.get_live_session(self.conn.last_insert_rowid())
    }

    /// The running conversation, or `None`. Every `mesa live` command but
    /// `start` resolves its session through this — there is no session
    /// argument anywhere, because there is only ever one.
    pub fn current_live_session(&self) -> Result<Option<LiveSession>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {LIVE_SESSION_COLUMNS} FROM live_sessions \
                     WHERE status = ?1 ORDER BY id DESC LIMIT 1"
                ),
                [LiveStatus::Live.as_str()],
                row_to_live_session,
            )
            .optional()?)
    }

    pub fn get_live_session(&self, id: i64) -> Result<LiveSession> {
        self.conn
            .query_row(
                &format!("SELECT {LIVE_SESSION_COLUMNS} FROM live_sessions WHERE id = ?1"),
                [id],
                row_to_live_session,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("live session {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Ends a conversation. **Idempotent**: ending an already-ended session
    /// returns it unchanged rather than erroring, so a stop the user pressed
    /// twice — or a page and an agent stopping at once — is not a failure.
    /// Like every other stamp in mesa, `ended_at` records the first ending.
    pub fn end_live_session(&mut self, id: i64) -> Result<LiveSession> {
        // The read first, for the `not_found` the caller expects; the write
        // then decides on the row itself (see `mark_inbox_item_read`) so a
        // second stopper cannot move the stamp the first one set.
        self.get_live_session(id)?;
        self.conn.execute(
            "UPDATE live_sessions SET status = ?2, ended_at = datetime('now'), \
             updated_at = datetime('now') WHERE id = ?1 AND status = ?3",
            (id, LiveStatus::Ended.as_str(), LiveStatus::Live.as_str()),
        )?;
        self.get_live_session(id)
    }

    /// Records the spawn receipt — which Claude session is driving this
    /// conversation. `None` clears it, which is what a spawn that printed no
    /// receipt leaves behind (`agents::spawn_bg` returns `Option`).
    pub fn bind_live_agent(&mut self, id: i64, agent_id: Option<&str>) -> Result<LiveSession> {
        self.get_live_session(id)?;
        self.conn.execute(
            "UPDATE live_sessions SET agent_id = ?2, updated_at = datetime('now') WHERE id = ?1",
            (id, agent_id),
        )?;
        self.get_live_session(id)
    }

    /// The page reporting where the user's browser is. Bounded by
    /// [`validate_live_route`] — it is a hash route, not free text.
    pub fn set_live_route(&mut self, id: i64, route: &str) -> Result<LiveSession> {
        let route = validate_live_route(route)?;
        self.get_live_session(id)?;
        self.conn.execute(
            "UPDATE live_sessions SET route = ?2, updated_at = datetime('now') WHERE id = ?1",
            (id, &route),
        )?;
        self.get_live_session(id)
    }

    /// Records one utterance. The single write path for turns, and where every
    /// shape rule lives:
    ///
    /// - the session must exist and still be `live` — a turn on a dead
    ///   conversation is a caller bug, not a silent no-op, so it is a
    ///   `validation` error rather than a swallowed write;
    /// - a `user` turn carries text and nothing else: the page dictates, it
    ///   does not drive itself;
    /// - a `mesa` turn must say something **or** do something (a pure
    ///   `navigate` speaks nothing, which is why empty text is legal there and
    ///   nowhere else);
    /// - `navigate` must carry a `target` that passes the route rule, the
    ///   sidebar actions must carry none, and a `target` without an action is a
    ///   `validation` error rather than a field nothing reads;
    /// - `text` is bounded ([`LIVE_TEXT_MAX`]) because it is spoken.
    pub fn add_live_turn(
        &mut self,
        session_id: i64,
        role: LiveRole,
        text: &str,
        action: Option<LiveAction>,
        target: Option<&str>,
    ) -> Result<LiveTurn> {
        let session = self
            .conn
            .query_row(
                &format!("SELECT {LIVE_SESSION_COLUMNS} FROM live_sessions WHERE id = ?1"),
                [session_id],
                row_to_live_session,
            )
            .optional()?
            .ok_or_else(|| Error::Validation(format!("live session {session_id} not found")))?;
        if session.status != LiveStatus::Live {
            return Err(Error::Validation(format!(
                "live session {session_id} has ended"
            )));
        }
        let text = text.trim();
        if text.chars().count() > LIVE_TEXT_MAX {
            return Err(Error::Validation(format!(
                "turn text must be at most {LIVE_TEXT_MAX} characters"
            )));
        }
        match role {
            LiveRole::User => {
                if text.is_empty() {
                    return Err(Error::Validation("a user turn must have text".into()));
                }
                if action.is_some() {
                    return Err(Error::Validation(
                        "a user turn cannot carry an action".into(),
                    ));
                }
            }
            LiveRole::Mesa => {
                if text.is_empty() && action.is_none() {
                    return Err(Error::Validation(
                        "a mesa turn must have text or an action".into(),
                    ));
                }
            }
        }
        let target = match (action, target) {
            (Some(LiveAction::Navigate), Some(t)) => Some(validate_live_route(t)?),
            (Some(LiveAction::Navigate), None) => {
                return Err(Error::Validation(
                    "a navigate turn must name a target route".into(),
                ));
            }
            // The sidebar verbs say everything in their own name; a route on
            // one is a caller that meant `navigate`, not a field to ignore.
            (Some(_), Some(_)) => {
                return Err(Error::Validation(
                    "only a navigate turn takes a target route".into(),
                ));
            }
            (Some(_), None) => None,
            (None, Some(_)) => {
                return Err(Error::Validation(
                    "a target route needs an action of \"navigate\"".into(),
                ));
            }
            (None, None) => None,
        };
        self.conn.execute(
            "INSERT INTO live_turns (session_id, role, text, action, target, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            (
                session_id,
                role.as_str(),
                text,
                action.map(|a| a.as_str()),
                target.as_deref(),
            ),
        )?;
        self.get_live_turn(self.conn.last_insert_rowid())
    }

    pub fn get_live_turn(&self, id: i64) -> Result<LiveTurn> {
        self.conn
            .query_row(
                &format!("SELECT {LIVE_TURN_COLUMNS} FROM live_turns WHERE id = ?1"),
                [id],
                row_to_live_turn,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("live turn {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Hands the agent the oldest undelivered user utterance, stamping it
    /// delivered on the way out — `None` when there is nothing to say.
    ///
    /// The select and the stamp are **one statement**: the CLI opens its own
    /// `Store` beside the server's, so a read-then-update pair would let two
    /// listeners be handed the same utterance and answer it twice.
    pub fn next_user_turn(&mut self, session_id: i64) -> Result<Option<LiveTurn>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "UPDATE live_turns SET delivered_at = datetime('now') \
                     WHERE id = (SELECT id FROM live_turns \
                                 WHERE session_id = ?1 AND role = ?2 AND delivered_at IS NULL \
                                 ORDER BY id LIMIT 1) \
                     RETURNING {LIVE_TURN_COLUMNS}"
                ),
                (session_id, LiveRole::User.as_str()),
                row_to_live_turn,
            )
            .optional()?)
    }

    /// A session's turns in id order — the transcript, and the page's poll.
    /// `after` is the cursor (exclusive); `limit` is clamped into
    /// `1..=`[`LIVE_TURNS_MAX`], so a caller cannot ask for the whole table or
    /// for nothing.
    pub fn list_live_turns(
        &self,
        session_id: i64,
        after: Option<i64>,
        limit: i64,
    ) -> Result<Vec<LiveTurn>> {
        let limit = limit.clamp(1, LIVE_TURNS_MAX);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {LIVE_TURN_COLUMNS} FROM live_turns \
             WHERE session_id = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3"
        ))?;
        let rows = stmt.query_map((session_id, after, limit), row_to_live_turn)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Marks a turn **spoken**, stamping `played_at` the first time and never
    /// again — the `read_at` rule, and for the same reason: the page decides a
    /// turn has been heard, and a re-render must not make it say it twice.
    pub fn mark_live_turn_played(&mut self, id: i64) -> Result<LiveTurn> {
        self.get_live_turn(id)?;
        self.conn.execute(
            "UPDATE live_turns SET played_at = datetime('now') \
             WHERE id = ?1 AND played_at IS NULL",
            [id],
        )?;
        self.get_live_turn(id)
    }

    // ---- scripts (user-authored shell) ----

    /// Stores a new script. The single write path for scripts: `name` and
    /// `body` are required and non-empty, the name is unique
    /// (case-insensitively — it is a CLI selector, so two scripts differing
    /// only in case would be unresolvable), the declared args are checked for
    /// shape, and an unknown `project_id` is a `validation` error (mirroring
    /// `assign_inbox_item`). Nothing about the body is inspected: it is opaque
    /// shell source that `core::scripts` hands to `bash` verbatim.
    pub fn create_script(
        &mut self,
        project_id: Option<i64>,
        name: &str,
        description: Option<&str>,
        body: &str,
        args: &[ScriptArg],
    ) -> Result<Script> {
        let name = validate_script_name(name)?;
        let body = validate_script_body(body)?;
        validate_script_args(args)?;
        self.ensure_script_project(project_id)?;
        self.ensure_script_name_free(&name, None)?;
        let encoded = encode_script_args(args)?;
        self.conn.execute(
            "INSERT INTO scripts (project_id, name, description, body, args, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))",
            (project_id, &name, description, &body, &encoded),
        )?;
        self.get_script(self.conn.last_insert_rowid())
    }

    pub fn get_script(&self, id: i64) -> Result<Script> {
        self.conn
            .query_row(
                &format!("SELECT {SCRIPT_COLUMNS} FROM scripts WHERE id = ?1"),
                [id],
                row_to_script,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    Error::NotFound(format!("script {id} not found"))
                }
                e => Error::Db(e),
            })
    }

    /// Case-insensitive exact match, mirroring [`Store::find_project_by_name`]
    /// — this is how `mesa script <id-or-name>` resolves a name. The `conflict`
    /// arm cannot fire while the uniqueness rule holds; it is kept so a db that
    /// somehow carries duplicates says so instead of picking one silently.
    pub fn find_script_by_name(&self, name: &str) -> Result<Script> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SCRIPT_COLUMNS} FROM scripts WHERE name = ?1 COLLATE NOCASE ORDER BY id"
        ))?;
        let matches = stmt
            .query_map([name], row_to_script)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        match matches.len() {
            0 => Err(Error::NotFound(format!(
                "no script named {name:?}; pass a script id or an existing name \
                 (see `mesa script list`)"
            ))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => Err(Error::Conflict(format!(
                "{} scripts are named {name:?} (ids {}); use the id",
                matches.len(),
                matches
                    .iter()
                    .map(|s| s.id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// Lists scripts by name (case-insensitively), `id` breaking ties. With
    /// `project` given, only that project's scripts; otherwise every script,
    /// global and bound alike.
    pub fn list_scripts(&self, project: Option<i64>) -> Result<Vec<Script>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SCRIPT_COLUMNS} FROM scripts \
             WHERE (?1 IS NULL OR project_id = ?1) ORDER BY name COLLATE NOCASE, id"
        ))?;
        let rows = stmt.query_map([project], row_to_script)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Applies a patch. Every rule `create_script` enforces is re-enforced
    /// here — an update is the other way a bad record could get in.
    pub fn update_script(&mut self, id: i64, patch: ScriptPatch) -> Result<Script> {
        let current = self.get_script(id)?;
        let mut next = current.clone();
        if let Some(project_id) = patch.project_id {
            self.ensure_script_project(project_id)?;
            next.project_id = project_id;
        }
        if let Some(name) = &patch.name {
            next.name = validate_script_name(name)?;
            self.ensure_script_name_free(&next.name, Some(id))?;
        }
        if let Some(description) = &patch.description {
            next.description = description.clone();
        }
        if let Some(body) = &patch.body {
            next.body = validate_script_body(body)?;
        }
        if let Some(args) = &patch.args {
            validate_script_args(args)?;
            next.args = args.clone();
        }
        let encoded = encode_script_args(&next.args)?;
        self.conn.execute(
            "UPDATE scripts SET project_id = ?1, name = ?2, description = ?3, body = ?4, \
             args = ?5, updated_at = datetime('now') WHERE id = ?6",
            (
                next.project_id,
                &next.name,
                &next.description,
                &next.body,
                &encoded,
                id,
            ),
        )?;
        self.get_script(id)
    }

    /// Deletes a script; returns the destroyed record (the recoverable echo —
    /// there is no history table for scripts, and deletes carry no prompt).
    pub fn delete_script(&mut self, id: i64) -> Result<Script> {
        let script = self.get_script(id)?;
        self.conn
            .execute("DELETE FROM scripts WHERE id = ?1", [id])?;
        Ok(script)
    }

    /// A script may be global (`None`) or bound to a project that exists;
    /// an unknown id is `validation`, not `not_found`, because it arrives as a
    /// field of the record being written.
    fn ensure_script_project(&self, project_id: Option<i64>) -> Result<()> {
        let Some(project_id) = project_id else {
            return Ok(());
        };
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::Validation(format!("project {project_id} not found")));
        }
        Ok(())
    }

    /// Name uniqueness, case-insensitive to match the lookup. `except` is the
    /// row being updated, so re-saving a script under its own name is a no-op
    /// rather than a conflict with itself.
    fn ensure_script_name_free(&self, name: &str, except: Option<i64>) -> Result<()> {
        let clash: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM scripts WHERE name = ?1 COLLATE NOCASE AND id IS NOT ?2 LIMIT 1",
                (name, except),
                |r| r.get(0),
            )
            .optional()?;
        if let Some(other) = clash {
            return Err(Error::Conflict(format!(
                "script {other} is already named {name:?}; script names are unique"
            )));
        }
        Ok(())
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

    /// Deletes every `cc_files` cursor row, forcing the next [`crate::core::cc::sync`]
    /// to re-walk every transcript from byte 0. Only the cursors are cleared —
    /// the already-ingested `cc_*` rows are never truncated. Re-ingest is
    /// additive, not corrective: `cc_messages`/`cc_tool_calls` insert on
    /// `DO NOTHING`, so a row that already exists keeps its stored values
    /// untouched — a parsing fix retroactively applies only in the sense
    /// that it can now emit a row (a new stable key) it previously missed,
    /// e.g. mesa task 340's advisor-accounting fix. A fix that needs to
    /// *change* an already-ingested row's values still needs a manual
    /// `DELETE` of that row (or table) before a rebuild backfills it.
    pub fn cc_clear_cursors(&self) -> Result<()> {
        self.conn.execute("DELETE FROM cc_files", [])?;
        Ok(())
    }

    /// Purges ALL persisted Claude Code telemetry — every row of `cc_messages`,
    /// `cc_prompts`, `cc_tool_calls`, `cc_agent_runs`, `cc_sessions` and the
    /// `cc_files` cursors — in one transaction, so a crash leaves either the whole index
    /// or none of it. The corrective counterpart to `cc_clear_cursors`, which
    /// is additive-only: re-ingest can never *change* an existing row's values
    /// (task 693's usage dedupe), so fixing already-stored rows means deleting
    /// them first. Destructive of history: a session whose transcript file is
    /// gone from disk cannot be re-ingested and is lost permanently — so this
    /// is only ever reached from an explicit operator action, never a read.
    pub fn cc_reset(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        for table in [
            "cc_messages",
            "cc_prompts",
            "cc_tool_calls",
            "cc_agent_runs",
            "cc_sessions",
            "cc_node_files",
            "cc_files",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.commit()?;
        Ok(())
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

            // Every optional column is `COALESCE(existing, new)`, so a rebuild
            // backfills the spawn fields onto runs ingested before migration
            // 15 added them (they are NULL there) without ever overwriting a
            // value already stored.
            let mut run = tx.prepare(
                "INSERT INTO cc_agent_runs \
                     (session_id, agent_id, agent, skill, tool_use_id, description, \
                      spawn_depth, parent_agent_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(session_id, agent_id) DO UPDATE SET \
                     agent = COALESCE(cc_agent_runs.agent, excluded.agent), \
                     skill = COALESCE(cc_agent_runs.skill, excluded.skill), \
                     tool_use_id = COALESCE(cc_agent_runs.tool_use_id, excluded.tool_use_id), \
                     description = COALESCE(cc_agent_runs.description, excluded.description), \
                     spawn_depth = COALESCE(cc_agent_runs.spawn_depth, excluded.spawn_depth), \
                     parent_agent_id = \
                         COALESCE(cc_agent_runs.parent_agent_id, excluded.parent_agent_id)",
            )?;
            for r in &batch.agent_runs {
                run.execute((
                    &r.session_id,
                    &r.agent_id,
                    &r.agent,
                    &r.skill,
                    &r.tool_use_id,
                    &r.description,
                    r.spawn_depth,
                    &r.parent_agent_id,
                ))?;
            }

            let mut msg = tx.prepare(
                "INSERT INTO cc_messages \
                     (uuid, session_id, agent_id, ts, model, input_tokens, output_tokens, \
                      cache_read_tokens, cache_creation_tokens, skill, agent, preview, \
                      message_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
                 ON CONFLICT(uuid) DO NOTHING",
            )?;
            // `preview` arrived after these rows did (migration 24), so it needs
            // the same treatment `cc_tool_calls.target` gets below: a separate
            // guarded UPDATE, deliberately NOT folded into a `DO UPDATE` arm.
            // `DO UPDATE` reports one changed row per conflict, which would
            // count every re-ingested message as newly added and turn a
            // cursor-cleared re-walk into a fake full-table import. Guarding on
            // `preview IS NULL` keeps `messages_added` meaning "rows inserted"
            // and preserves keep-first for an already-stored value.
            let mut msg_backfill = tx.prepare(
                "UPDATE cc_messages SET preview = ?2 \
                 WHERE uuid = ?1 AND preview IS NULL",
            )?;
            // Same shape, same reasoning, for `message_id` (migration 29): a
            // separate guarded UPDATE rather than a `DO UPDATE` arm, so the
            // cursor-cleared re-walk that migration 30 forces backfills the
            // column without reporting a fake full-table import.
            let mut msg_id_backfill = tx.prepare(
                "UPDATE cc_messages SET message_id = ?2 \
                 WHERE uuid = ?1 AND message_id IS NULL",
            )?;
            for m in &batch.messages {
                let added = msg.execute((
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
                    &m.preview,
                    &m.message_id,
                ))? as i64;
                counts.messages_added += added;
                if added == 0 && m.preview.is_some() {
                    msg_backfill.execute((&m.uuid, &m.preview))?;
                }
                if added == 0 && m.message_id.is_some() {
                    msg_id_backfill.execute((&m.uuid, &m.message_id))?;
                }
            }

            let mut call = tx.prepare(
                "INSERT INTO cc_tool_calls \
                     (tool_use_id, message_uuid, session_id, agent_id, name, caller, ts, target) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(tool_use_id) DO NOTHING",
            )?;
            // `target` arrived after these rows did (migration 22), so it needs
            // the backfill the agent-run upsert gets from its `COALESCE` arms.
            // It cannot ride the same `DO UPDATE`: that reports one changed row
            // per conflict, which would count every re-ingested call as newly
            // added and turn `cc sync --rebuild` into a fake 52k-row import.
            // A separate guarded UPDATE keeps `tool_calls_added` meaning
            // "rows inserted" and still fills the gap on a rebuild, while
            // `target IS NULL` preserves keep-first for a stored value.
            let mut backfill = tx.prepare(
                "UPDATE cc_tool_calls SET target = ?2 \
                 WHERE tool_use_id = ?1 AND target IS NULL",
            )?;
            for c in &batch.tool_calls {
                let added = call.execute((
                    &c.tool_use_id,
                    &c.message_uuid,
                    &c.session_id,
                    &c.agent_id,
                    &c.name,
                    &c.caller,
                    c.ts,
                    &c.target,
                ))? as i64;
                counts.tool_calls_added += added;
                if added == 0 && c.target.is_some() {
                    backfill.execute((&c.tool_use_id, &c.target))?;
                }
            }

            // Prompts need no backfill twin: `preview` is NOT NULL and is the
            // only non-key column, so a conflicting row already holds the one
            // value this insert could supply. Deliberately uncounted in
            // `CcIngestCounts` — no reader reports prompt volume, and a new
            // field there would ripple into the TS type and the cc-check count
            // assertions for nothing.
            let mut prompt = tx.prepare(
                "INSERT INTO cc_prompts (uuid, session_id, ts, preview) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(uuid) DO NOTHING",
            )?;
            for p in &batch.prompts {
                prompt.execute((&p.uuid, &p.session_id, p.ts, &p.preview))?;
            }

            // The thread → transcript pointer. Last-writer-wins rather than
            // keep-first: if Claude Code ever moves a transcript, the newest
            // sighting is the one that can still be opened. Uncounted in
            // `CcIngestCounts` for the same reason prompts are — it is a
            // pointer, not telemetry.
            let mut node_file = tx.prepare(
                "INSERT INTO cc_node_files (session_id, agent_id, path) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(session_id, agent_id) DO UPDATE SET path = excluded.path",
            )?;
            for n in &batch.node_files {
                node_file.execute((&n.session_id, &n.agent_id, path))?;
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

    /// Message rows with `ts >= cutoff` (`None` = all), oldest first —
    /// deterministic order so the row a read-time dedupe keeps is stable
    /// (`core::cc::dedupe_key`), the same guarantee `cc_session_messages`
    /// already gave.
    pub fn cc_read_messages(&self, cutoff: Option<i64>) -> Result<Vec<CcMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT uuid, session_id, agent_id, ts, model, input_tokens, output_tokens, \
                    cache_read_tokens, cache_creation_tokens, skill, agent, preview, \
                    message_id \
             FROM cc_messages WHERE ?1 IS NULL OR ts >= ?1 ORDER BY ts, uuid",
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
                preview: r.get(11)?,
                message_id: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Tool-call rows with `ts >= cutoff` (`None` = all).
    pub fn cc_read_tool_calls(&self, cutoff: Option<i64>) -> Result<Vec<CcToolCallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_use_id, message_uuid, session_id, agent_id, name, caller, ts, target \
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
                target: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ---- session-scoped cc reads (`cc::session_graph`) ----
    //
    // The dashboard reads above are window-scoped and whole-table; a single
    // session's call tree is the opposite shape, so these filter on
    // `session_id` (both hot tables are indexed on it) and never on `ts` — a
    // graph of a session always shows the whole session.

    /// One `cc_sessions` row by id, or `None` when the session was never
    /// ingested.
    pub fn cc_session(&self, session_id: &str) -> Result<Option<CcSessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, cwd, git_branch, entrypoint, used_subagent, start_ts, end_ts \
             FROM cc_sessions WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query_map([session_id], |r| {
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
        Ok(rows.next().transpose()?)
    }

    /// Every message row for one session, oldest first.
    pub fn cc_session_messages(&self, session_id: &str) -> Result<Vec<CcMessageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT uuid, session_id, agent_id, ts, model, input_tokens, output_tokens, \
                    cache_read_tokens, cache_creation_tokens, skill, agent, preview, \
                    message_id \
             FROM cc_messages WHERE session_id = ?1 ORDER BY ts, uuid",
        )?;
        let rows = stmt.query_map([session_id], |r| {
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
                preview: r.get(11)?,
                message_id: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every prompt row for one session, oldest first. Unwindowed, like its
    /// message and tool-call siblings: the session graph is a whole-session
    /// read and applies its own `limit` budget.
    pub fn cc_session_prompts(&self, session_id: &str) -> Result<Vec<CcPromptRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT uuid, session_id, ts, preview \
             FROM cc_prompts WHERE session_id = ?1 ORDER BY ts, uuid",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(CcPromptRow {
                uuid: r.get(0)?,
                session_id: r.get(1)?,
                ts: r.get(2)?,
                preview: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every tool-call row for one session, oldest first.
    pub fn cc_session_tool_calls(&self, session_id: &str) -> Result<Vec<CcToolCallRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_use_id, message_uuid, session_id, agent_id, name, caller, ts, target \
             FROM cc_tool_calls WHERE session_id = ?1 ORDER BY ts, tool_use_id",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(CcToolCallRow {
                tool_use_id: r.get(0)?,
                message_uuid: r.get(1)?,
                session_id: r.get(2)?,
                agent_id: r.get(3)?,
                name: r.get(4)?,
                caller: r.get(5)?,
                ts: r.get(6)?,
                target: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every subagent run recorded under one session.
    pub fn cc_session_agent_runs(&self, session_id: &str) -> Result<Vec<CcAgentRunUpsert>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, agent_id, agent, skill, tool_use_id, description, \
                    spawn_depth, parent_agent_id \
             FROM cc_agent_runs WHERE session_id = ?1 ORDER BY agent_id",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(CcAgentRunUpsert {
                session_id: r.get(0)?,
                agent_id: r.get(1)?,
                agent: r.get(2)?,
                skill: r.get(3)?,
                tool_use_id: r.get(4)?,
                description: r.get(5)?,
                spawn_depth: r.get(6)?,
                parent_agent_id: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The transcript file one thread's lines were read from — `agent_id` is
    /// `""` for the main session thread. `None` when the session was ingested
    /// before migration 33 and its file has since vanished (so the one-shot
    /// re-walk could not re-record it).
    ///
    /// A stored path is a *cursor-era* fact, not a capability: it is whatever
    /// the walker saw, so every caller must still re-check that it is inside
    /// `cc::projects_dir()` before opening it.
    pub fn cc_node_file(&self, session_id: &str, agent_id: &str) -> Result<Option<String>> {
        let path = self
            .conn
            .query_row(
                "SELECT path FROM cc_node_files WHERE session_id = ?1 AND agent_id = ?2",
                (session_id, agent_id),
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(path)
    }

    /// Subagent-run counts per session (all-time — runs carry no timestamp).
    pub fn cc_agent_run_counts(&self) -> Result<HashMap<String, i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id, COUNT(*) FROM cc_agent_runs GROUP BY session_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Stamp of persisted cc state: total rows across `cc_messages`,
    /// `cc_tool_calls`, `cc_sessions`. It normally only grows (ingest is
    /// insert-only); [`Store::cc_reset`] is the one thing that can move it
    /// *down*. It stays a usable cache key either way: a purge + re-ingest
    /// landing on exactly the same total across three tables is not reachable
    /// in practice. The API uses it as the dashboard cache key (a change by any
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

/// Appends every project under `parent` to `out`, depth-first, each level in
/// the order `all` is already in (`sort_order, id`). `seen` guards against a
/// malformed parent cycle, so this terminates on any input.
fn collect_subtree(all: &[Project], parent: i64, seen: &mut HashSet<i64>, out: &mut Vec<Project>) {
    for child in all.iter().filter(|p| p.parent_id == Some(parent)) {
        if !seen.insert(child.id) {
            continue;
        }
        out.push(child.clone());
        collect_subtree(all, child.id, seen, out);
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

/// `BEGIN IMMEDIATE` serializes concurrent first-opens of a brand-new db: two
/// processes racing here would otherwise both read `user_version = 0` and
/// both try to `CREATE TABLE`, crashing the loser with "table already
/// exists". The losing process's `BEGIN IMMEDIATE` blocks (up to
/// `busy_timeout`, already set by `Store::open` before this runs) until the
/// winner commits, then re-reads the now-current `user_version` and finds
/// nothing left to apply.
fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let run = || -> Result<()> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(())
    };
    match run() {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            conn.execute_batch("ROLLBACK").ok();
            return Err(e);
        }
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

    fn add_task(store: &mut Store, project_id: i64, description: &str) -> Task {
        store
            .create_task(
                project_id,
                description,
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
            .create_project("alpha", Some("first"), None, None, None)
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

        let (deleted, _subprojects, tasks) = store.delete_project(p.id).unwrap();
        assert_eq!(deleted, updated);
        assert!(tasks.is_empty());
        assert!(matches!(store.get_project(p.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn archive_and_unarchive_are_idempotent_and_dont_hide_from_get_or_delete() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", None, None, None, None)
            .unwrap();
        assert!(!p.archived);

        let archived = store.archive_project(p.id).unwrap();
        assert!(archived.archived);
        assert_eq!(archived.name, p.name);
        // Idempotent: archiving an already-archived project succeeds and
        // returns the same state.
        let archived_again = store.archive_project(p.id).unwrap();
        assert_eq!(archived_again, archived);

        // get/find_by_name must not filter archived projects (story 503
        // guardrail) — unarchive-by-name and `project show` depend on this.
        assert_eq!(store.get_project(p.id).unwrap(), archived);
        assert_eq!(store.find_project_by_name("alpha").unwrap(), archived);

        let unarchived = store.unarchive_project(p.id).unwrap();
        assert!(!unarchived.archived);
        let unarchived_again = store.unarchive_project(p.id).unwrap();
        assert_eq!(unarchived_again, unarchived);

        // Delete stays byte-identical on an archived project: full cascade,
        // full echo, no special-casing of the flag.
        let archived = store.archive_project(p.id).unwrap();
        let (deleted, _subprojects, tasks) = store.delete_project(p.id).unwrap();
        assert_eq!(deleted, archived);
        assert!(tasks.is_empty());
    }

    #[test]
    fn list_projects_excludes_archived_list_projects_all_includes_them() {
        let (mut store, _dir) = temp_store();
        let a = store
            .create_project("alpha", None, None, None, None)
            .unwrap();
        let b = store
            .create_project("beta", None, None, None, None)
            .unwrap();
        store.archive_project(b.id).unwrap();

        let visible = store.list_projects().unwrap();
        assert_eq!(visible.iter().map(|p| p.id).collect::<Vec<_>>(), vec![a.id]);
        assert!(visible.iter().all(|p| !p.archived));

        let all = store.list_projects_all().unwrap();
        assert_eq!(
            all.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![a.id, b.id]
        );
        assert!(all.iter().any(|p| p.id == b.id && p.archived));
    }

    /// Task 666. Three things at once, because they are one contract: the
    /// migration's `sort_order = id` backfill (a fresh db's list is still in
    /// creation order), `create_project`'s next-value rule (a new project
    /// sorts last), and the reorder itself (a midpoint write moves one row
    /// and rewrites nothing else).
    #[test]
    fn projects_list_in_sort_order_and_reorder_moves_one_row() {
        let (mut store, _dir) = temp_store();
        let a = store
            .create_project("alpha", None, None, None, None)
            .unwrap();
        let b = store
            .create_project("beta", None, None, None, None)
            .unwrap();
        let c = store
            .create_project("gamma", None, None, None, None)
            .unwrap();

        // Backfill/next-value: untouched projects come out in creation order,
        // each one sort_order past the last.
        let ids = |ps: Vec<Project>| ps.iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!(ids(store.list_projects().unwrap()), vec![a.id, b.id, c.id]);
        assert!(a.sort_order < b.sort_order && b.sort_order < c.sort_order);

        // Drag the last to the front: the value the sidebar would compute for
        // an insert above the head (`first - 1`), written to that row alone.
        let moved = store
            .update_project(
                c.id,
                &ProjectPatch {
                    sort_order: Some(a.sort_order - 1.0),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.sort_order, a.sort_order - 1.0);
        assert_eq!(ids(store.list_projects().unwrap()), vec![c.id, a.id, b.id]);
        // The other two rows were not rewritten.
        assert_eq!(store.get_project(a.id).unwrap(), a);
        assert_eq!(store.get_project(b.id).unwrap(), b);
        // Archived rows sort by the same key in the all-inclusive read.
        assert_eq!(
            ids(store.list_projects_all().unwrap()),
            vec![c.id, a.id, b.id]
        );

        // A project created after the reordering still sorts last, not into
        // the gap the drag opened up.
        let d = store
            .create_project("delta", None, None, None, None)
            .unwrap();
        assert_eq!(
            ids(store.list_projects().unwrap()),
            vec![c.id, a.id, b.id, d.id]
        );

        // An update that omits sort_order leaves it alone.
        let renamed = store
            .update_project(
                c.id,
                &ProjectPatch {
                    name: Some("gamma!".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(renamed.sort_order, moved.sort_order);
    }

    /// The backfill on a db that predates the column: existing rows keep
    /// creation order rather than collapsing onto the DEFAULT 0 (where the
    /// `id` tiebreak would be doing all the work and the first drag would
    /// have nothing to interleave between).
    #[test]
    fn project_sort_order_migration_backfills_from_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre666.db");
        // Pinned by index, NOT `MIGRATIONS.len() - 1`: the positional form
        // silently re-aims at whatever migration ships next, and this test
        // would then be exercising that one's backfill instead of this one's.
        const PROJECT_SORT_ORDER: usize = 26;
        assert!(
            MIGRATIONS[PROJECT_SORT_ORDER].contains("ALTER TABLE projects ADD COLUMN sort_order"),
            "PROJECT_SORT_ORDER points at the wrong migration",
        );
        let cutoff = PROJECT_SORT_ORDER;
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..cutoff] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", cutoff as i64)
                .unwrap();
            conn.execute_batch("INSERT INTO projects (name) VALUES ('one'), ('two'), ('three');")
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let listed = store.list_projects().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|p| (p.name.as_str(), p.sort_order))
                .collect::<Vec<_>>(),
            vec![("one", 1.0), ("two", 2.0), ("three", 3.0)],
        );
    }

    /// Task 668. The parent column on a db that predates it: every existing
    /// row upgrades to top level, and the tree still lists in `sort_order`.
    #[test]
    fn project_parent_migration_leaves_existing_rows_at_top_level() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre668.db");
        // Pinned by index, NOT `MIGRATIONS.len() - 1` (see the sort_order
        // test above for why the positional form is a trap).
        const PROJECT_PARENT: usize = 27;
        assert!(
            MIGRATIONS[PROJECT_PARENT].contains("ALTER TABLE projects ADD COLUMN parent_id"),
            "PROJECT_PARENT points at the wrong migration",
        );
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..PROJECT_PARENT] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", PROJECT_PARENT as i64)
                .unwrap();
            conn.execute_batch("INSERT INTO projects (name) VALUES ('one'), ('two');")
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let listed = store.list_projects().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|p| (p.name.as_str(), p.parent_id))
                .collect::<Vec<_>>(),
            vec![("one", None), ("two", None)],
        );
    }

    /// A parent round-trips through create/get/list/update, detaches on
    /// `Some(None)`, and nests arbitrarily deep. Reparenting is *only* a
    /// reparent: every other field on the row is left exactly as it was.
    #[test]
    fn project_parent_round_trips_and_reparent_touches_nothing_else() {
        let (mut store, _dir) = temp_store();
        let root = store
            .create_project("root", None, None, None, None)
            .unwrap();
        assert_eq!(root.parent_id, None);

        let child = store
            .create_project("child", None, None, Some("/tmp/child"), Some(root.id))
            .unwrap();
        assert_eq!(child.parent_id, Some(root.id));
        assert_eq!(store.get_project(child.id).unwrap(), child);
        // A new child sorts last among its siblings, drawn from the one
        // global sequence.
        assert!(child.sort_order > root.sort_order);

        // Three levels deep is fine — nesting has no depth limit.
        let grandchild = store
            .create_project("grandchild", None, None, None, Some(child.id))
            .unwrap();
        assert_eq!(grandchild.parent_id, Some(child.id));

        // The list stays FLAT and in sort_order; the tree is the caller's job.
        assert_eq!(
            store
                .list_projects()
                .unwrap()
                .iter()
                .map(|p| (p.id, p.parent_id))
                .collect::<Vec<_>>(),
            vec![
                (root.id, None),
                (child.id, Some(root.id)),
                (grandchild.id, Some(child.id)),
            ],
        );

        // Reparent: grandchild moves up under root, and nothing else on the
        // row moves with it.
        let moved = store
            .update_project(
                grandchild.id,
                &ProjectPatch {
                    parent_id: Some(Some(root.id)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            moved,
            Project {
                parent_id: Some(root.id),
                ..grandchild.clone()
            }
        );

        // `Some(None)` detaches to top level.
        let detached = store
            .update_project(
                moved.id,
                &ProjectPatch {
                    parent_id: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(detached.parent_id, None);
        // An unrelated update leaves the parent alone.
        let renamed = store
            .update_project(
                child.id,
                &ProjectPatch {
                    name: Some("child!".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(renamed.parent_id, Some(root.id));
    }

    /// Self-parenting and any loop are `cycle`; an unknown parent is
    /// `validation` — the same split of error kinds a task's parent uses.
    #[test]
    fn project_parent_rejects_cycles_and_unknown_parents() {
        let (mut store, _dir) = temp_store();
        let a = store.create_project("a", None, None, None, None).unwrap();
        let b = store
            .create_project("b", None, None, None, Some(a.id))
            .unwrap();
        let c = store
            .create_project("c", None, None, None, Some(b.id))
            .unwrap();

        let self_parent = store.update_project(
            a.id,
            &ProjectPatch {
                parent_id: Some(Some(a.id)),
                ..Default::default()
            },
        );
        assert!(
            matches!(self_parent, Err(Error::Cycle(_))),
            "{self_parent:?}"
        );

        // Direct loop: a under its own child.
        let direct = store.update_project(
            a.id,
            &ProjectPatch {
                parent_id: Some(Some(b.id)),
                ..Default::default()
            },
        );
        assert!(matches!(direct, Err(Error::Cycle(_))), "{direct:?}");

        // Deeper loop: a under its own grandchild.
        let deep = store.update_project(
            a.id,
            &ProjectPatch {
                parent_id: Some(Some(c.id)),
                ..Default::default()
            },
        );
        assert!(matches!(deep, Err(Error::Cycle(_))), "{deep:?}");

        let unknown = store.update_project(
            c.id,
            &ProjectPatch {
                parent_id: Some(Some(9999)),
                ..Default::default()
            },
        );
        assert!(matches!(unknown, Err(Error::Validation(_))), "{unknown:?}");
        assert!(matches!(
            store.create_project("d", None, None, None, Some(9999)),
            Err(Error::Validation(_))
        ));
        // Every rejection was a no-op: the tree is untouched.
        assert_eq!(store.get_project(a.id).unwrap(), a);
        assert_eq!(store.get_project(c.id).unwrap(), c);
    }

    /// Archiving cascades down the tree for UNSCOPED reads only, and does it
    /// without writing a single descendant row: the flag is per-row,
    /// visibility is derived (task 668).
    #[test]
    fn archiving_a_parent_hides_descendants_from_unscoped_reads_only() {
        let (mut store, _dir) = temp_store();
        let root = store
            .create_project("root", None, None, None, None)
            .unwrap();
        let child = store
            .create_project("child", None, None, None, Some(root.id))
            .unwrap();
        let grandchild = store
            .create_project("grandchild", None, None, None, Some(child.id))
            .unwrap();
        let other = store
            .create_project("other", None, None, None, None)
            .unwrap();
        let t_child = add_task(&mut store, child.id, "child task");
        let t_other = add_task(&mut store, other.id, "other task");
        store
            .create_diagram(child.id, "child board", None, None, None)
            .unwrap();

        store.archive_project(root.id).unwrap();

        // Unscoped: the whole subtree is gone.
        assert_eq!(
            store
                .list_projects()
                .unwrap()
                .iter()
                .map(|p| p.id)
                .collect::<Vec<_>>(),
            vec![other.id],
        );
        assert_eq!(
            store
                .list_tasks(None)
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec![t_other.id],
        );
        assert!(matches!(
            store.next_task(None).unwrap(),
            NextResult::Task(t) if t.id == t_other.id
        ));
        assert!(store.list_diagrams(None).unwrap().is_empty());

        // The descendants' own flag is untouched — nothing was written.
        assert_eq!(store.get_project(child.id).unwrap(), child);
        assert_eq!(store.get_project(grandchild.id).unwrap(), grandchild);
        assert!(!store.get_project(child.id).unwrap().archived);
        // ...and `list_projects_all` still returns everything.
        assert_eq!(store.list_projects_all().unwrap().len(), 4);

        // Scoped reads of a LIVE child of an archived parent are unaffected.
        assert_eq!(
            store
                .list_tasks(Some(child.id))
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec![t_child.id],
        );
        assert!(matches!(
            store.next_task(Some(child.id)).unwrap(),
            NextResult::Task(t) if t.id == t_child.id
        ));
        assert_eq!(store.list_diagrams(Some(child.id)).unwrap().len(), 1);

        // Unarchiving the root restores the subtree with no per-child write.
        store.unarchive_project(root.id).unwrap();
        assert_eq!(store.list_projects().unwrap().len(), 4);
        assert_eq!(store.list_tasks(None).unwrap().len(), 2);
        assert_eq!(store.get_project(child.id).unwrap(), child);
    }

    /// Deleting a project takes its whole subtree — and the echo carries every
    /// destroyed row, since it is the recovery transcript.
    #[test]
    fn delete_project_cascades_subtree_and_echoes_every_row() {
        let (mut store, _dir) = temp_store();
        let root = store
            .create_project("root", None, None, None, None)
            .unwrap();
        let child = store
            .create_project("child", None, None, None, Some(root.id))
            .unwrap();
        let grandchild = store
            .create_project("grandchild", None, None, None, Some(child.id))
            .unwrap();
        let sibling = store
            .create_project("sibling", None, None, None, Some(root.id))
            .unwrap();
        let keep = store
            .create_project("keep", None, None, None, None)
            .unwrap();
        let t_root = add_task(&mut store, root.id, "root task");
        let t_grand = add_task(&mut store, grandchild.id, "grandchild task");
        let t_keep = add_task(&mut store, keep.id, "kept task");
        let board = store
            .create_diagram(grandchild.id, "board", None, None, None)
            .unwrap();

        let (deleted, subprojects, tasks) = store.delete_project(root.id).unwrap();
        assert_eq!(deleted.id, root.id);
        // Depth-first, each level in list order.
        assert_eq!(
            subprojects.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![child.id, grandchild.id, sibling.id],
        );
        // Root's own tasks first, then each descendant's, in that same order.
        assert_eq!(
            tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![t_root.id, t_grand.id],
        );

        // Nothing of the subtree is left in the db; the untouched project and
        // its task are still there.
        for id in [root.id, child.id, grandchild.id, sibling.id] {
            assert!(matches!(store.get_project(id), Err(Error::NotFound(_))));
        }
        assert!(matches!(
            store.get_task(t_grand.id),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            store.get_diagram(board.id),
            Err(Error::NotFound(_))
        ));
        assert_eq!(store.get_project(keep.id).unwrap(), keep);
        assert_eq!(store.get_task(t_keep.id).unwrap().id, t_keep.id);

        // A leaf delete is unchanged: an empty subtree.
        let (_, subprojects, tasks) = store.delete_project(keep.id).unwrap();
        assert!(subprojects.is_empty());
        assert_eq!(
            tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![t_keep.id]
        );
    }

    #[test]
    fn local_path_records_updates_and_clears() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", None, None, Some("/tmp/checkout"), None)
            .unwrap();
        assert_eq!(p.local_path.as_deref(), Some("/tmp/checkout"));
        assert_eq!(store.get_project(p.id).unwrap(), p);

        // Machine-local, not unique: two projects may share a folder.
        let q = store
            .create_project("beta", None, None, Some("/tmp/checkout"), None)
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
        let p = store
            .create_project("Alpha", None, None, None, None)
            .unwrap();
        store
            .create_project("beta", None, None, None, None)
            .unwrap();

        assert_eq!(store.find_project_by_name("alpha").unwrap(), p);
        assert!(matches!(
            store.find_project_by_name("gamma"),
            Err(Error::NotFound(_))
        ));

        // A duplicate name is ambiguous: the caller must use the id.
        store
            .create_project("ALPHA", None, None, None, None)
            .unwrap();
        assert!(matches!(
            store.find_project_by_name("alpha"),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn root_commit_binds_resolves_and_rejects_duplicates() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("alpha", None, Some("abc123"), None, None)
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
            store.create_project("dup", None, Some("abc123"), None, None),
            Err(Error::Conflict(_))
        ));

        // Another project cannot steal the binding...
        let q = store
            .create_project("beta", None, None, None, None)
            .unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = store
            .create_task(
                p.id,
                "write tests\n\ncover everything",
                Priority::High,
                &["rust".into(), "tdd".into()],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        // `name` is derived from the description's first line, never stored.
        assert_eq!(t.name, "write tests");
        assert_eq!(t.description, "write tests\n\ncover everything");
        assert_eq!(t.status, Status::Todo);
        assert_eq!(t.priority, Priority::High);
        assert_eq!(t.tags, vec!["rust", "tdd"]);
        assert_eq!(t.parent_id, None);
        assert!(!t.blocked);

        assert_eq!(store.get_task(t.id).unwrap(), t);
        assert_eq!(store.list_tasks(None).unwrap(), vec![t.clone()]);

        // --tags replaces the full set; description/status/priority change.
        let updated = store
            .update_task(
                t.id,
                &TaskPatch {
                    description: Some("write more tests".into()),
                    status: Some(Status::InProgress),
                    priority: Some(Priority::Low),
                    tags: Some(vec!["qa".into()]),
                    parent_id: None,
                    acceptance: None,
                    artifact: None,
                    result: None,
                    sort_order: None,
                    append: false,
                },
            )
            .unwrap();
        assert_eq!(updated.description, "write more tests");
        // The derived name follows the body it was cut from.
        assert_eq!(updated.name, "write more tests");
        assert_eq!(updated.status, Status::InProgress);
        assert_eq!(updated.priority, Priority::Low);
        assert_eq!(updated.tags, vec!["qa"]);
        assert_eq!(store.get_task(t.id).unwrap(), updated);

        let deleted = store.delete_task(t.id).unwrap();
        assert_eq!(deleted, vec![updated]);
        assert!(matches!(store.get_task(t.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn claim_sets_owner_and_moves_to_in_progress() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        assert_eq!(t.owner, None);
        assert_eq!(t.claimed_at, None);

        let claimed = store.claim_task(t.id, "sess-a", false).unwrap();
        assert_eq!(claimed.status, Status::InProgress);
        assert_eq!(claimed.owner.as_deref(), Some("sess-a"));
        assert!(claimed.claimed_at.is_some());
        // Persisted, not just returned.
        assert_eq!(
            store.get_task(t.id).unwrap().owner.as_deref(),
            Some("sess-a")
        );
        // The status move is recorded like any other.
        let events = store.list_events(Some(t.id)).unwrap();
        assert_eq!(events.last().unwrap().to_status, Status::InProgress);
    }

    #[test]
    fn claim_rejects_a_different_live_owner_unless_forced() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store.claim_task(t.id, "sess-a", false).unwrap();

        assert!(matches!(
            store.claim_task(t.id, "sess-b", false),
            Err(Error::Conflict(_))
        ));
        // The rejected claim changed nothing.
        assert_eq!(
            store.get_task(t.id).unwrap().owner.as_deref(),
            Some("sess-a")
        );

        let stolen = store.claim_task(t.id, "sess-b", true).unwrap();
        assert_eq!(stolen.owner.as_deref(), Some("sess-b"));
    }

    #[test]
    fn a_claim_conflicts_across_two_connections() {
        // The claim guards CLI-vs-server and CLI-vs-CLI, which are separate
        // processes on separate connections — so the conflict must be raised
        // from the *database*, not from anything cached in one Store. The
        // check and the write share one Immediate transaction for the same
        // reason; this test covers the visibility half of that.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let mut a = Store::open(&path).unwrap();
        let p = a.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut a, p.id, "work");
        a.claim_task(t.id, "sess-a", false).unwrap();

        let mut b = Store::open(&path).unwrap();
        assert!(
            matches!(b.claim_task(t.id, "sess-b", false), Err(Error::Conflict(_))),
            "a second connection must see the first's claim"
        );
        assert_eq!(b.get_task(t.id).unwrap().owner.as_deref(), Some("sess-a"));
        // ...and --force still works across connections.
        assert_eq!(
            b.claim_task(t.id, "sess-b", true).unwrap().owner.as_deref(),
            Some("sess-b")
        );
        assert_eq!(a.get_task(t.id).unwrap().owner.as_deref(), Some("sess-b"));
    }

    #[test]
    fn claim_by_the_same_owner_renews_the_lease() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store.claim_task(t.id, "sess-a", false).unwrap();
        // Backdate the claim so the renewal is observable without sleeping:
        // `datetime('now')` has one-second resolution.
        store
            .conn
            .execute(
                "UPDATE tasks SET claimed_at = '2000-01-01 00:00:00' WHERE id = ?1",
                [t.id],
            )
            .unwrap();
        let renewed = store.claim_task(t.id, "sess-a", false).unwrap();
        assert_eq!(renewed.owner.as_deref(), Some("sess-a"));
        assert_ne!(
            renewed.claimed_at.as_deref(),
            Some("2000-01-01 00:00:00"),
            "re-claiming with the same owner must restamp claimed_at"
        );
    }

    #[test]
    fn claim_takes_over_an_in_progress_task_with_no_owner() {
        // The pre-claims world (and any plain `--status in_progress` flip):
        // in_progress with a null owner is not a live hold, so no --force.
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store
            .update_task(
                t.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        let claimed = store.claim_task(t.id, "sess-a", false).unwrap();
        assert_eq!(claimed.owner.as_deref(), Some("sess-a"));
    }

    #[test]
    fn release_clears_the_claim_and_is_idempotent() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store.claim_task(t.id, "sess-a", false).unwrap();

        let released = store.release_task(t.id).unwrap();
        assert_eq!(released.owner, None);
        assert_eq!(released.claimed_at, None);
        // Status is deliberately untouched — release breaks a claim, it does
        // not un-start the work.
        assert_eq!(released.status, Status::InProgress);
        // Releasing again is a no-op, not an error.
        assert_eq!(store.release_task(t.id).unwrap().owner, None);
    }

    #[test]
    fn leaving_in_progress_drops_the_claim() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store.claim_task(t.id, "sess-a", false).unwrap();

        let done = store
            .update_task(
                t.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done.owner, None, "a done task must not stay owned");
        assert_eq!(done.claimed_at, None);
    }

    #[test]
    fn an_ordinary_update_leaves_the_claim_alone() {
        // The whole point of `claimed_at`: `updated_at` moves on any field
        // write, `claimed_at` only on claim/renew.
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        store.claim_task(t.id, "sess-a", false).unwrap();
        store
            .conn
            .execute(
                "UPDATE tasks SET claimed_at = '2000-01-01 00:00:00' WHERE id = ?1",
                [t.id],
            )
            .unwrap();

        let edited = store
            .update_task(
                t.id,
                &TaskPatch {
                    description: Some("work, renamed".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(edited.owner.as_deref(), Some("sess-a"));
        assert_eq!(
            edited.claimed_at.as_deref(),
            Some("2000-01-01 00:00:00"),
            "an ordinary field write must not restamp claimed_at"
        );
    }

    #[test]
    fn claim_rejects_an_empty_owner() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "work");
        assert!(matches!(
            store.claim_task(t.id, "   ", false),
            Err(Error::Validation(_))
        ));
        assert_eq!(store.get_task(t.id).unwrap().status, Status::Todo);
    }

    #[test]
    fn update_task_sets_and_clears_result() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "ship it");
        assert_eq!(t.result, None);

        let done = store
            .update_task(
                t.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    result: Some(Some("shipped in commit abc123".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done.result.as_deref(), Some("shipped in commit abc123"));
        assert_eq!(store.get_task(t.id).unwrap().result, done.result);

        let cleared = store
            .update_task(
                t.id,
                &TaskPatch {
                    result: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.result, None);
    }

    /// Spec 612: `append` turns the three free-text bodies into appends,
    /// separated from the stored value by exactly one blank line however many
    /// trailing newlines it carried, and leaves every other field replacing.
    #[test]
    fn update_task_appends_the_free_text_bodies() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "story");
        let seeded = store
            .update_task(
                t.id,
                &TaskPatch {
                    // A trailing newline is what a `--description-file` body
                    // normally ends with; it must not double the blank line.
                    description: Some("Story body.\n".into()),
                    acceptance: Some(Some("Ships.".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(seeded.result, None);

        let annotated = store
            .update_task(
                t.id,
                &TaskPatch {
                    description: Some("DESIGN CONTRACT: see task 605".into()),
                    acceptance: Some(Some("...and is documented.".into())),
                    // An absent body: the appended text becomes the whole value.
                    result: Some(Some("first note".into())),
                    priority: Some(Priority::High),
                    append: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            annotated.description,
            "Story body.\n\nDESIGN CONTRACT: see task 605"
        );
        // Appending to the identity field leaves the first line — and so the
        // derived name — exactly where it was.
        assert_eq!(annotated.name, "Story body.");
        assert_eq!(
            annotated.acceptance.as_deref(),
            Some("Ships.\n\n...and is documented.")
        );
        assert_eq!(annotated.result.as_deref(), Some("first note"));
        assert_eq!(
            annotated.priority,
            Priority::High,
            "append must not leak into non-text fields"
        );
        assert_eq!(
            store.get_task(t.id).unwrap().description,
            annotated.description
        );

        // Repeated appends stack rather than nesting blank lines.
        let twice = store
            .update_task(
                t.id,
                &TaskPatch {
                    result: Some(Some("second note".into())),
                    append: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(twice.result.as_deref(), Some("first note\n\nsecond note"));

        // Without `append` the same patch replaces, exactly as before.
        let replaced = store
            .update_task(
                t.id,
                &TaskPatch {
                    result: Some(Some("third note".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(replaced.result.as_deref(), Some("third note"));
    }

    #[test]
    fn task_not_found_message_leads_to_nearest_task() {
        let (mut store, _dir) = temp_store();

        // Empty db: no lead to give.
        let err = store.get_task(42).unwrap_err();
        assert!(matches!(&err, Error::NotFound(m) if m.contains("no tasks exist")));

        let p = store
            .create_project("alpha", None, None, None, None)
            .unwrap();
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

        // Long descriptions are truncated in the lead, by the same 50-char
        // `task_name` rule the board and `task list` use.
        let long_description = "x".repeat(200);
        let t3 = add_task(&mut store, p.id, &long_description);
        let err = store.get_task(t3.id + 1).unwrap_err();
        match &err {
            Error::NotFound(m) => {
                assert!(m.contains(&"x".repeat(50)));
                assert!(!m.contains(&"x".repeat(51)));
                assert!(m.contains('…'));
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    /// Task 660: a description is a task's identity, so it may be neither
    /// created empty nor emptied later — there is no clear, only a replace.
    #[test]
    fn description_must_not_be_empty_on_create_or_update() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        for blank in ["", "   \n\t "] {
            let err = store
                .create_task(p.id, blank, Priority::Medium, &[], None, None, None, None)
                .unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "create({blank:?})");
        }
        let t = add_task(&mut store, p.id, "real work");
        let err = store
            .update_task(
                t.id,
                &TaskPatch {
                    description: Some("  ".into()),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        // The stored body is untouched by the rejected write.
        assert_eq!(store.get_task(t.id).unwrap().description, "real work");
    }

    #[test]
    fn create_task_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_task(999, "orphan", Priority::Medium, &[], None, None, None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn create_with_status_lands_in_that_column_and_logs_creation_event() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = store
            .create_task(
                p.id,
                "in flight",
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
            .create_task(p.id, "later", Priority::Medium, &[], None, None, None, None)
            .unwrap();
        assert_eq!(d.status, Status::Todo);
    }

    #[test]
    fn parent_must_be_in_same_project() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
        let t1 = add_task(&mut store, p1.id, "in p1");
        let t2 = add_task(&mut store, p2.id, "in p2");

        // create: cross-project parent rejected
        let err = store
            .create_task(
                p2.id,
                "sub",
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
        let p = store.create_project("p", None, None, None, None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(
                p.id,
                "child",
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
        assert_eq!(deleted[0].name, "root");

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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
        let root = add_task(&mut store, p.id, "root");
        let child = store
            .create_task(
                p.id,
                "child",
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
            .create_project("doomed", Some("desc"), None, None, None)
            .unwrap();
        let keep = store
            .create_project("keeper", None, None, None, None)
            .unwrap();
        let t1 = add_task(&mut store, p.id, "one");
        let t2 = store
            .create_task(
                p.id,
                "two",
                Priority::Medium,
                &[],
                Some(t1.id),
                None,
                None,
                None,
            )
            .unwrap();
        let survivor = add_task(&mut store, keep.id, "survivor");

        let (project, _subprojects, tasks) = store.delete_project(p.id).unwrap();
        assert_eq!(project.id, p.id);
        assert_eq!(project.name, "doomed");
        assert_eq!(project.description.as_deref(), Some("desc"));
        let ids: Vec<i64> = tasks.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![t1.id, t2.id]);
        assert_eq!(tasks[0].name, "one");
        assert_eq!(tasks[1].name, "two");

        assert!(matches!(store.get_project(p.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_task(t1.id), Err(Error::NotFound(_))));
        // other project untouched
        assert_eq!(store.get_task(survivor.id).unwrap().id, survivor.id);
    }

    #[test]
    fn self_edge_rejected_as_cycle() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let t = add_task(&mut store, p.id, "t");
        let err = store.add_dependency(t.id, t.id).unwrap_err();
        assert!(matches!(err, Error::Cycle(_)));
        assert!(err.to_string().contains(&t.id.to_string()));
    }

    #[test]
    fn cycle_rejected_naming_the_edge() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
    fn list_blocking_returns_direct_dependents_only() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        let c = add_task(&mut store, p.id, "c");
        store.add_dependency(a.id, b.id).unwrap(); // a blocked by b
        store.add_dependency(b.id, c.id).unwrap(); // b blocked by c

        // c blocks b directly, and a only transitively.
        let ids: Vec<i64> = store
            .list_blocking(c.id)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![b.id]);

        // Exact mirror of list_blockers along the same edge.
        assert_eq!(store.list_blocking(b.id).unwrap()[0].id, a.id, "b blocks a");
        assert!(store.list_blocking(a.id).unwrap().is_empty());
        assert!(matches!(store.list_blocking(999), Err(Error::NotFound(_))));
    }

    #[test]
    fn backup_round_trip() {
        let (mut store, dir) = temp_store();
        let p = store
            .create_project("p", Some("kept"), None, None, None)
            .unwrap();
        let a = add_task(&mut store, p.id, "a");
        let b = add_task(&mut store, p.id, "b");
        store.add_dependency(a.id, b.id).unwrap();

        let snap = dir.path().join("snap.db");
        store.backup(&snap).unwrap();

        let restored = Store::open(&snap).unwrap();
        assert_eq!(restored.list_projects().unwrap(), vec![p]);
        let tasks = restored.list_tasks(None).unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(restored.get_task(a.id).unwrap().blocked);
        assert!(!restored.get_task(b.id).unwrap().blocked);
    }

    #[test]
    fn status_events_logged_on_create_and_real_status_changes() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
                    description: Some("renamed".into()),
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        description: &str,
        priority: Priority,
    ) -> Task {
        store
            .create_task(
                project_id,
                description,
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
            NextResult::Task(t) => assert_eq!(t.name, "med"),
            NextResult::None { .. } => panic!("expected a task"),
        }
    }

    #[test]
    fn next_subtask_scopes_to_descendants_shares_next_task_rules() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sub = |store: &mut Store, parent: i64, title: &str, priority: Priority| -> Task {
            store
                .create_task(p.id, title, priority, &[], Some(parent), None, None, None)
                .unwrap()
        };

        // An unrelated high-priority todo would win any project-wide pick;
        // next_subtask must never see it.
        let outsider = create_with_priority(&mut store, p.id, "outsider", Priority::High);
        let parent = add_task(&mut store, p.id, "umbrella");
        let child_med = sub(&mut store, parent.id, "child med", Priority::Medium);
        let child_high = sub(&mut store, parent.id, "child high", Priority::High);
        let grandchild = sub(&mut store, child_med.id, "grandchild", Priority::High);

        // Empty parents is None, never a project-wide fallback.
        assert!(store.next_subtask(&[]).unwrap().is_none());

        // Priority ordering, same as next_task; the parent itself and the
        // unrelated task are both out of scope.
        let picked = store.next_subtask(&[parent.id]).unwrap().unwrap();
        assert_eq!(picked.id, child_high.id);

        // Blocked descendants are skipped on the same rule as next_task, and
        // depth is unlimited: with child_high blocked and child_med done, the
        // grandchild is next.
        store.add_dependency(child_high.id, outsider.id).unwrap();
        store
            .update_task(
                child_med.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        let picked = store.next_subtask(&[parent.id]).unwrap().unwrap();
        assert_eq!(
            picked.id, grandchild.id,
            "descendants are found at any depth"
        );

        // Nothing actionable under the subtree -> None, even though the
        // project still has an actionable todo (`outsider`).
        store
            .update_task(
                grandchild.id,
                &TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            store.next_subtask(&[parent.id]).unwrap().is_none(),
            "an exhausted subtree must not fall back to the wider project"
        );
        match store.next_task(Some(p.id)).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, outsider.id),
            NextResult::None { .. } => panic!("outsider is still actionable project-wide"),
        }
    }

    #[test]
    fn next_task_counts_when_none_actionable() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
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
    fn next_task_excludes_backlog() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        store
            .create_task(
                p.id,
                "shelved",
                Priority::High,
                &[],
                None,
                None,
                None,
                Some(Status::Backlog),
            )
            .unwrap();
        // A backlog task is never actionable, even ranked above everything by
        // priority, and never counted in any of the None-result buckets.
        match store.next_task(None).unwrap() {
            NextResult::Task(_) => panic!("backlog task must not be picked as next"),
            NextResult::None {
                blocked,
                in_progress,
                todo,
            } => {
                assert_eq!(blocked, 0);
                assert_eq!(in_progress, 0);
                assert_eq!(todo, 0);
            }
        }

        // A backlog blocker still counts as unresolved: it blocks a dependent
        // exactly like any other non-done/cancelled status, so the dependent
        // is skipped in favor of a plain unblocked todo.
        let backlog_blocker = store
            .create_task(
                p.id,
                "backlog_blocker",
                Priority::High,
                &[],
                None,
                None,
                None,
                Some(Status::Backlog),
            )
            .unwrap();
        let dependent = create_with_priority(&mut store, p.id, "dependent", Priority::High);
        store
            .add_dependency(dependent.id, backlog_blocker.id)
            .unwrap();
        let plain_todo = add_task(&mut store, p.id, "plain_todo");
        match store.next_task(None).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, plain_todo.id),
            NextResult::None { .. } => panic!("expected the plain todo task"),
        }
    }

    #[test]
    fn next_task_respects_project_filter() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
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

    #[test]
    fn list_tasks_unscoped_excludes_archived_project_scoped_unaffected() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
        let t1 = add_task(&mut store, p1.id, "p1 task");
        let t2 = add_task(&mut store, p2.id, "p2 task");

        // Before archiving: unscoped sees both.
        let before: Vec<i64> = store
            .list_tasks(None)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(before, vec![t1.id, t2.id]);

        store.archive_project(p2.id).unwrap();

        // Unscoped excludes the archived project's task.
        let ids: Vec<i64> = store
            .list_tasks(None)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![t1.id]);

        // Scoped read of the archived project is completely unaffected.
        let scoped = store.list_tasks(Some(p2.id)).unwrap();
        assert_eq!(scoped, vec![t2.clone()]);
        assert_eq!(scoped[0].blocked, t2.blocked);

        store.unarchive_project(p2.id).unwrap();
        let ids: Vec<i64> = store
            .list_tasks(None)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, vec![t1.id, t2.id]);
    }

    #[test]
    fn next_task_unscoped_skips_archived_project_scoped_unaffected() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
        // p2's task is higher priority, so it would win an unscoped pick
        // unless the archived project is excluded.
        let in_p2 = create_with_priority(&mut store, p2.id, "p2 high", Priority::High);
        let in_p1 = add_task(&mut store, p1.id, "p1 task");

        store.archive_project(p2.id).unwrap();

        match store.next_task(None).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, in_p1.id),
            NextResult::None { .. } => panic!("expected p1 task, p2 is archived"),
        }

        // Scoped read of the archived project still returns its task.
        match store.next_task(Some(p2.id)).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, in_p2.id),
            NextResult::None { .. } => panic!("expected p2 task via scoped read"),
        }
    }

    #[test]
    fn next_task_unscoped_none_counts_exclude_archived_project() {
        // Regresses the count closure specifically (store.rs's second patch
        // site): an archived project with in_progress/blocked/todo tasks must
        // not be counted into the unscoped NextResult::None totals.
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();

        // p1: one task, marked in_progress so it isn't "actionable" but does
        // count -- keeps the unscoped pick landing in NextResult::None.
        let p1_task = add_task(&mut store, p1.id, "p1 in progress");
        store
            .update_task(
                p1_task.id,
                &TaskPatch {
                    status: Some(Status::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();

        // p2 (to be archived): a todo task and a blocked todo task, which
        // would inflate the unscoped counts if not excluded.
        let p2_blocker = add_task(&mut store, p2.id, "p2 blocker");
        let p2_blocked = add_task(&mut store, p2.id, "p2 blocked");
        store.add_dependency(p2_blocked.id, p2_blocker.id).unwrap();
        // p2_blocker itself is an actionable todo task in p2.

        store.archive_project(p2.id).unwrap();

        match store.next_task(None).unwrap() {
            NextResult::Task(t) => panic!("expected None, got actionable task {}", t.id),
            NextResult::None {
                blocked,
                in_progress,
                todo,
            } => {
                assert_eq!(blocked, 0, "p2's blocked task must not be counted");
                assert_eq!(in_progress, 1, "only p1's in_progress task counts");
                assert_eq!(todo, 0, "p2's actionable todo task must not be counted");
            }
        }

        // Scoped read of the archived project still counts its own tasks.
        match store.next_task(Some(p2.id)).unwrap() {
            NextResult::Task(t) => assert_eq!(t.id, p2_blocker.id),
            NextResult::None { .. } => panic!("expected p2's actionable task via scoped read"),
        }
    }

    #[test]
    fn list_diagrams_unscoped_excludes_archived_project_scoped_unaffected() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
        let sb1 = store
            .create_diagram(p1.id, "p1 board", None, None, None)
            .unwrap();
        let sb2 = store
            .create_diagram(p2.id, "p2 board", None, None, None)
            .unwrap();

        store.archive_project(p2.id).unwrap();

        let ids: Vec<i64> = store
            .list_diagrams(None)
            .unwrap()
            .iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![sb1.id]);

        // Scoped read of the archived project is completely unaffected.
        assert_eq!(store.list_diagrams(Some(p2.id)).unwrap(), vec![sb2]);
    }

    fn import_task(ref_: &str, description: &str) -> ImportTask {
        ImportTask {
            ref_: ref_.into(),
            description: description.into(),
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
        let p = store.create_project("p", None, None, None, None).unwrap();
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

        let by_name = |t: &str| created.iter().find(|x| x.name == t).unwrap().clone();
        let a = by_name("design");
        let b = by_name("build");
        let c = by_name("spike");

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
        let p = store.create_project("p", None, None, None, None).unwrap();
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
        assert!(store.list_tasks(None).unwrap().is_empty());
        assert!(store.list_events(None).unwrap().is_empty());
    }

    #[test]
    fn import_rejects_unknown_project_and_bad_refs_leaving_db_empty() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();

        // unknown project: nothing created.
        let bad_project = ImportDoc {
            project: 999,
            tasks: vec![import_task("a", "a")],
        };
        assert!(matches!(
            store.import_tasks(&bad_project).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(store.list_tasks(None).unwrap().is_empty());

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
        assert!(store.list_tasks(None).unwrap().is_empty());

        // duplicate ref: validation error.
        let dup = ImportDoc {
            project: p.id,
            tasks: vec![import_task("a", "one"), import_task("a", "two")],
        };
        assert!(matches!(
            store.import_tasks(&dup).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(store.list_tasks(None).unwrap().is_empty());
    }

    #[test]
    fn import_rejects_empty_description_creating_nothing() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();

        // A description is the task's identity: import enforces the same
        // non-empty rule as `create_task`, so this is not a second write path
        // into a state the rest of the surface treats as impossible.
        for empty in ["", "   "] {
            let doc = ImportDoc {
                project: p.id,
                tasks: vec![import_task("a", "valid"), import_task("b", empty)],
            };
            let err = store.import_tasks(&doc).unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "got {err:?}");
            // Rejected before the transaction opens: no tasks, no events.
            assert!(store.list_tasks(None).unwrap().is_empty());
            assert!(store.list_events(None).unwrap().is_empty());
        }
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

    #[test]
    fn cursor_reset_migration_reopens_ingest_without_dropping_cc_rows() {
        // The `target` column shipped with no way back to the rows that
        // predated it: ingest skips a transcript whose `cc_files` cursor
        // still matches, so those rows stay `NULL` forever and the session
        // graph renders bare `Bash` nodes and zero skill nodes. The last
        // Migration 23 clears the cursors so the next `cc::sync` re-walks once.
        //
        // Pinned to 23 by index, NOT `MIGRATIONS.len() - 1`. The positional
        // form silently re-aimed at whatever shipped last, so it only kept
        // testing this behaviour while the newest migration happened to be a
        // cursor clear — the moment task 606 appended a plain `ALTER TABLE`
        // it started asserting that an unrelated migration clears cursors,
        // and failed. The subject is migration 23 specifically.
        //
        // Index 22, not 23: prose elsewhere numbers migrations by the
        // `user_version` they leave behind (1-based), the array is 0-based.
        const CURSOR_RESET: usize = 22;
        assert_eq!(
            MIGRATIONS[CURSOR_RESET].trim(),
            "DELETE FROM cc_files;",
            "migration {CURSOR_RESET} is no longer the cursor reset — a shipped \
             migration was edited or reordered, which is never allowed"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre.db");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..CURSOR_RESET] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", CURSOR_RESET as i64)
                .unwrap();
            conn.execute(
                "INSERT INTO cc_files (path, mtime, size, byte_offset) \
                 VALUES ('/p/s1.jsonl', 1, 2, 2)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO cc_tool_calls \
                     (tool_use_id, message_uuid, session_id, name, ts) \
                 VALUES ('tu1', 'u1', 's1', 'Bash', 100)",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        // The cursor is gone, so the transcript is read again on next sync...
        let cursors: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM cc_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cursors, 0);
        // ...while the ingested rows themselves are untouched: `cc_files`
        // holds cursors, not data, so this is additive-only.
        let calls: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM cc_tool_calls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn concurrent_first_open_of_a_new_db_does_not_race() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("racy.db");
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || Store::open(&path).map(|_| ()))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        let store = Store::open(&path).unwrap();
        let v: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        assert!(store.list_projects().unwrap().is_empty());
    }

    // ---- diagrams ----

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
            shape: None,
        }
    }

    /// A plain connector: no label, no author, and every task 854 property at
    /// its default, which is the shape almost every test here wants.
    fn edge_new(from_frame: i64, to_frame: i64) -> EdgeNew {
        EdgeNew {
            from_frame,
            to_frame,
            ..Default::default()
        }
    }

    #[test]
    fn diagram_crud_round_trip_with_view() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store
            .create_diagram(p.id, "flow", Some("the happy path"), Some("agent-1"), None)
            .unwrap();
        assert_eq!(sb.title, "flow");
        assert_eq!(sb.description.as_deref(), Some("the happy path"));
        assert_eq!(sb.author.as_deref(), Some("agent-1"));
        assert_eq!(sb.created_at, sb.updated_at);

        assert_eq!(store.get_diagram(sb.id).unwrap(), sb);
        assert_eq!(store.list_diagrams(None).unwrap(), vec![sb.clone()]);
        assert_eq!(store.list_diagrams(Some(p.id)).unwrap(), vec![sb.clone()]);
        assert!(store.list_diagrams(Some(p.id + 1)).unwrap().is_empty());

        // empty board view
        let view = store.get_diagram_view(sb.id).unwrap();
        assert_eq!(view.diagram, sb);
        assert!(view.frames.is_empty());
        assert!(view.edges.is_empty());

        let updated = store
            .update_diagram(
                sb.id,
                &DiagramPatch {
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

        let destroyed = store.delete_diagram(sb.id).unwrap();
        assert_eq!(destroyed.diagram.id, sb.id);
        assert!(matches!(store.get_diagram(sb.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn create_diagram_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_diagram(999, "orphan", None, None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    /// The whole matrix, driven off the value sets rather than a hand-written
    /// copy of them: **every** (diagram_type, shape) pair, the generic `None`
    /// card included, is created for real and its outcome checked against
    /// `DiagramType::shapes`/`allows_generic_frame`. A shape added to a type's
    /// set is therefore covered the moment it is listed, and a shape moved out
    /// of one is asserted to be rejected there.
    #[test]
    fn frame_shape_must_belong_to_its_boards_diagram_type() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let candidates: Vec<Option<FrameShape>> = std::iter::once(None)
            .chain(FrameShape::ALL.iter().copied().map(Some))
            .collect();
        for diagram_type in DiagramType::ALL.iter().copied() {
            let sb = store
                .create_diagram(p.id, diagram_type.as_str(), None, None, Some(diagram_type))
                .unwrap();
            for shape in candidates.iter().copied() {
                let allowed = match shape {
                    None => diagram_type.allows_generic_frame(),
                    Some(s) => diagram_type.shapes().contains(&s),
                };
                let result = store.create_frame(
                    sb.id,
                    &FrameNew {
                        shape,
                        ..frame_new("f")
                    },
                );
                let named = shape.map(FrameShape::as_str).unwrap_or("none");
                if allowed {
                    let f = result
                        .unwrap_or_else(|e| panic!("{named} on {}: {e}", diagram_type.as_str()));
                    assert_eq!(f.shape, shape);
                } else {
                    let err = result.err().unwrap_or_else(|| {
                        panic!("{named} must not be legal on a {}", diagram_type.as_str())
                    });
                    assert!(matches!(err, Error::Validation(_)));
                    assert!(err.to_string().contains(diagram_type.as_str()));
                    assert!(err.to_string().contains(named));
                }
            }
        }
    }

    /// The marker twin of the shape matrix: every marker against every board
    /// type, on both `create_edge` and `update_edge`, checked against
    /// `DiagramType::edge_markers` — which is what makes the cardinality
    /// family `erd`-only in one place rather than two.
    #[test]
    fn edge_markers_must_belong_to_its_boards_diagram_type() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        for diagram_type in DiagramType::ALL.iter().copied() {
            let sb = store
                .create_diagram(p.id, diagram_type.as_str(), None, None, Some(diagram_type))
                .unwrap();
            let shape = diagram_type.shapes().first().copied();
            let a = store
                .create_frame(
                    sb.id,
                    &FrameNew {
                        shape,
                        ..frame_new("a")
                    },
                )
                .unwrap();
            let b = store
                .create_frame(
                    sb.id,
                    &FrameNew {
                        shape,
                        ..frame_new("b")
                    },
                )
                .unwrap();
            let plain = store.create_edge(sb.id, &edge_new(a.id, b.id)).unwrap();
            for marker in EdgeMarker::ALL.iter().copied() {
                let allowed = diagram_type.edge_markers().contains(&marker);
                let created = store.create_edge(
                    sb.id,
                    &EdgeNew {
                        to_marker: Some(marker),
                        ..edge_new(a.id, b.id)
                    },
                );
                let patched = store.update_edge(
                    plain.id,
                    &EdgePatch {
                        from_marker: Some(Some(marker)),
                        ..Default::default()
                    },
                    None,
                );
                if allowed {
                    assert_eq!(created.unwrap().to_marker, Some(marker));
                    assert_eq!(patched.unwrap().from_marker, Some(marker));
                } else {
                    for err in [created.unwrap_err(), patched.unwrap_err()] {
                        assert!(matches!(err, Error::Validation(_)));
                        assert_eq!(
                            err.to_string(),
                            format!(
                                "marker '{}' is not valid for a {} board",
                                marker.as_str(),
                                diagram_type.as_str()
                            )
                        );
                    }
                }
            }
        }
    }

    /// Style/markers are mutable (unlike `shape`), with `from_anchor`'s
    /// three-state patch contract, and a change that lands logs exactly one
    /// `edge_restyled` event.
    #[test]
    fn edge_style_and_markers_are_patchable_and_log_one_restyle_event() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let e = store
            .create_edge(
                sb.id,
                &EdgeNew {
                    style: Some(EdgeStyle::Dashed),
                    ..edge_new(a.id, b.id)
                },
            )
            .unwrap();
        assert_eq!(e.style, Some(EdgeStyle::Dashed));
        assert_eq!(e.from_marker, None);

        // Omitted leaves it alone; the marker set lands.
        let e = store
            .update_edge(
                e.id,
                &EdgePatch {
                    to_marker: Some(Some(EdgeMarker::HollowArrow)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(e.style, Some(EdgeStyle::Dashed));
        assert_eq!(e.to_marker, Some(EdgeMarker::HollowArrow));

        // Re-asserting what is already stored is a no-op: no event.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    style: Some(Some(EdgeStyle::Dashed)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(store.list_diagram_events(sb.id).unwrap().len(), before);

        // Explicit `None` clears back to the default, and logs one event.
        let e = store
            .update_edge(
                e.id,
                &EdgePatch {
                    style: Some(None),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(e.style, None);
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        let last = events.last().unwrap();
        assert_eq!(last.action, "edge_restyled");
        assert!(last.summary.contains("style: default"), "{}", last.summary);

        // An anchor change in the same call outranks the restyle: one event.
        let before = events.len();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    from_anchor: Some(Some(AnchorSide::Top)),
                    to_marker: Some(Some(EdgeMarker::Circle)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap().action, "edge_anchor_changed");
    }

    #[test]
    fn migration_backfills_diagram_type_and_leaves_shape_null_on_pre_357_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre-357.db");
        // Index 16, not `MIGRATIONS.len() - 1`: the positional form silently
        // re-aims at whatever shipped last (see `CURSOR_RESET` above), which
        // would make this assert that some unrelated migration backfills
        // diagram_type. The subject is migration 18 — index 17 — so the db is
        // built from everything *before* it.
        const DIAGRAM_TYPE: usize = 17;
        assert!(
            MIGRATIONS[DIAGRAM_TYPE].contains("ADD COLUMN diagram_type"),
            "migration {DIAGRAM_TYPE} is no longer the diagram_type migration — \
             a shipped migration was edited or reordered, which is never allowed"
        );
        // Build a db at the version just before the diagram_type/shape
        // migration, with a pre-feature diagram and frame (spec 355 Must
        // #1/#6: existing rows must read back as diagram_type=storyboard,
        // shape=null, with no explicit backfill statement).
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..DIAGRAM_TYPE] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", DIAGRAM_TYPE as i64)
                .unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('kept')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO storyboards (project_id, title, author, created_at, updated_at) \
                 VALUES (1, 'pre-feature board', NULL, datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO frames \
                 (storyboard_id, title, x, y, w, h, author, created_at, updated_at) \
                 VALUES (1, 'pre-feature frame', 0, 0, 240, 140, NULL, datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let boards = store.list_diagrams(None).unwrap();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].diagram_type, DiagramType::Storyboard);
        let view = store.get_diagram_view(boards[0].id).unwrap();
        assert_eq!(view.frames.len(), 1);
        assert_eq!(view.frames[0].shape, None);
    }

    #[test]
    fn migration_leaves_style_and_markers_null_on_pre_854_edges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre-854.db");
        // Index 42 — migration 43 — pinned, NOT `MIGRATIONS.len() - 1`: the
        // positional form silently re-aims at whatever ships next (see
        // `CURSOR_RESET` above). The db is built from everything *before* it.
        const EDGE_STYLE: usize = 42;
        assert!(
            MIGRATIONS[EDGE_STYLE].contains("ADD COLUMN from_marker"),
            "migration {EDGE_STYLE} is no longer the edge style/marker migration — \
             a shipped migration was edited or reordered, which is never allowed"
        );
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..EDGE_STYLE] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", EDGE_STYLE as i64)
                .unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('kept')", [])
                .unwrap();
            conn.execute(
                "INSERT INTO diagrams (project_id, title, author, created_at, updated_at) \
                 VALUES (1, 'pre-feature board', NULL, datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            for title in ["a", "b"] {
                conn.execute(
                    "INSERT INTO frames (diagram_id, title, x, y, w, h, created_at, updated_at) \
                     VALUES (1, ?1, 0, 0, 240, 140, datetime('now'), datetime('now'))",
                    [title],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO frame_edges (diagram_id, from_frame, to_frame, created_at) \
                 VALUES (1, 1, 2, datetime('now'))",
                [],
            )
            .unwrap();
        }
        // Every pre-feature edge reads back at the default rendering — the
        // whole point of the three columns being nullable.
        let store = Store::open(&path).unwrap();
        let edges = store.get_diagram_view(1).unwrap().edges;
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].style, None);
        assert_eq!(edges[0].from_marker, None);
        assert_eq!(edges[0].to_marker, None);
    }

    #[test]
    fn frame_crud_and_view_ordering() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();

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
        let view = store.get_diagram_view(sb.id).unwrap();
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
    fn create_frame_unknown_diagram_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store.create_frame(999, &frame_new("x")).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
    }

    #[test]
    fn frame_task_link_must_be_same_project_and_nulls_on_task_delete() {
        let (mut store, _dir) = temp_store();
        let p1 = store.create_project("p1", None, None, None, None).unwrap();
        let p2 = store.create_project("p2", None, None, None, None).unwrap();
        let sb = store.create_diagram(p1.id, "b", None, None, None).unwrap();
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
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let other = store
            .create_diagram(p.id, "other", None, None, None)
            .unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let foreign = store.create_frame(other.id, &frame_new("foreign")).unwrap();

        // self-edge rejected
        let err = store.create_edge(sb.id, &edge_new(a.id, a.id)).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // endpoint not on this board rejected
        let err = store
            .create_edge(sb.id, &edge_new(a.id, foreign.id))
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // unknown diagram rejected
        let err = store.create_edge(999, &edge_new(a.id, b.id)).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));

        // valid edge, and the reverse edge too: cycles are allowed
        let e1 = store
            .create_edge(
                sb.id,
                &EdgeNew {
                    label: Some("then".into()),
                    author: Some("user".into()),
                    ..edge_new(a.id, b.id)
                },
            )
            .unwrap();
        assert_eq!(e1.from_frame, a.id);
        assert_eq!(e1.to_frame, b.id);
        assert_eq!(e1.label.as_deref(), Some("then"));
        let e2 = store.create_edge(sb.id, &edge_new(b.id, a.id)).unwrap();

        let view = store.get_diagram_view(sb.id).unwrap();
        assert_eq!(view.edges.len(), 2);

        // relabel + clear
        let relabelled = store
            .update_edge(
                e1.id,
                &EdgePatch {
                    label: Some(Some("next".into())),
                    ..Default::default()
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
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(cleared.label, None);

        let deleted = store.delete_edge(e2.id, None).unwrap();
        assert_eq!(deleted.id, e2.id);
        assert!(matches!(store.get_edge(e2.id), Err(Error::NotFound(_))));
        assert_eq!(store.get_diagram_view(sb.id).unwrap().edges.len(), 1);
    }

    #[test]
    fn delete_frame_cascades_edges_and_echoes_them() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let c = store.create_frame(sb.id, &frame_new("c")).unwrap();
        let e_ab = store.create_edge(sb.id, &edge_new(a.id, b.id)).unwrap();
        let e_ba = store.create_edge(sb.id, &edge_new(b.id, a.id)).unwrap();
        let e_bc = store.create_edge(sb.id, &edge_new(b.id, c.id)).unwrap();

        // deleting b removes the two edges touching it, not e? none other; a-c has none
        let (deleted, edges) = store.delete_frame(b.id, None).unwrap();
        assert_eq!(deleted.id, b.id);
        let edge_ids: HashSet<i64> = edges.iter().map(|e| e.id).collect();
        assert_eq!(edge_ids, HashSet::from([e_ab.id, e_ba.id, e_bc.id]));

        // a and c survive; no edges remain
        assert_eq!(store.get_frame(a.id).unwrap().id, a.id);
        assert_eq!(store.get_frame(c.id).unwrap().id, c.id);
        assert!(store.get_diagram_view(sb.id).unwrap().edges.is_empty());
    }

    #[test]
    fn delete_diagram_cascades_and_echoes_full_view() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        store.create_edge(sb.id, &edge_new(a.id, b.id)).unwrap();

        let view = store.delete_diagram(sb.id).unwrap();
        assert_eq!(view.frames.len(), 2);
        assert_eq!(view.edges.len(), 1);
        // gone, with frames and edges cascaded
        assert!(matches!(store.get_diagram(sb.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_frame(a.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn delete_project_cascades_diagrams() {
        let (mut store, _dir) = temp_store();
        let p = store
            .create_project("doomed", None, None, None, None)
            .unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        store.create_edge(sb.id, &edge_new(a.id, b.id)).unwrap();

        store.delete_project(p.id).unwrap();
        assert!(matches!(store.get_diagram(sb.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_frame(a.id), Err(Error::NotFound(_))));
        assert!(matches!(store.get_edge(1), Err(Error::NotFound(_))));
    }

    #[test]
    fn diagram_change_history_records_actor_and_actions() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store
            .create_diagram(p.id, "flow", None, Some("agent-1"), None)
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
            .create_edge(
                sb.id,
                &EdgeNew {
                    label: Some("then".into()),
                    author: Some("user".into()),
                    ..edge_new(a.id, b.id)
                },
            )
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
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    waypoints: Some(vec![Waypoint { x: 10.0, y: 20.0 }]),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        store.delete_edge(e.id, Some("agent-2")).unwrap();

        let events = store.list_diagram_events(sb.id).unwrap();
        let actions: Vec<&str> = events.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(
            actions,
            vec![
                "diagram_created",
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
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.last().unwrap().action, "frame_removed");
        assert_eq!(events.last().unwrap().actor.as_deref(), Some("user"));

        // history dies with the board; unknown board is NotFound
        assert!(matches!(
            store.list_diagram_events(9999),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn delete_diagram_cascades_its_change_history() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        store.create_frame(sb.id, &frame_new("a")).unwrap();
        assert!(!store.list_diagram_events(sb.id).unwrap().is_empty());
        store.delete_diagram(sb.id).unwrap();
        // a fresh board reuses no rows; the orphaned events are gone
        let sb2 = store.create_diagram(p.id, "b2", None, None, None).unwrap();
        let events = store.list_diagram_events(sb2.id).unwrap();
        assert_eq!(events.len(), 1); // only its own creation
        assert_eq!(events[0].action, "diagram_created");
    }

    #[test]
    fn no_op_update_changes_nothing_and_logs_nothing() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store
            .create_diagram(p.id, "b", Some("d"), None, None)
            .unwrap();
        let f = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let g = store.create_frame(sb.id, &frame_new("g")).unwrap();
        let e = store
            .create_edge(
                sb.id,
                &EdgeNew {
                    label: Some("lbl".into()),
                    ..edge_new(f.id, g.id)
                },
            )
            .unwrap();
        let before = store.list_diagram_events(sb.id).unwrap().len();
        let frame_updated_at = store.get_frame(f.id).unwrap().updated_at;

        // Re-set every field to its current value: no change, no event, and
        // updated_at is not bumped.
        store
            .update_diagram(
                sb.id,
                &DiagramPatch {
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
                    ..Default::default()
                },
                Some("noop"),
            )
            .unwrap();
        assert_eq!(store.list_diagram_events(sb.id).unwrap().len(), before);
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
        assert_eq!(store.list_diagram_events(sb.id).unwrap().len(), before + 1);
    }

    #[test]
    fn edge_anchor_patch_is_three_state_preserved_and_logged() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let sb = store.create_diagram(p.id, "b", None, None, None).unwrap();
        let a = store.create_frame(sb.id, &frame_new("a")).unwrap();
        let b = store.create_frame(sb.id, &frame_new("b")).unwrap();
        let e = store
            .create_edge(
                sb.id,
                &EdgeNew {
                    label: Some("lbl".into()),
                    ..edge_new(a.id, b.id)
                },
            )
            .unwrap();
        assert_eq!(e.from_anchor, None);
        assert_eq!(e.to_anchor, None);

        // Lock the "from" end.
        let locked = store
            .update_edge(
                e.id,
                &EdgePatch {
                    from_anchor: Some(Some(AnchorSide::Right)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(locked.from_anchor, Some(AnchorSide::Right));
        assert_eq!(locked.to_anchor, None);

        // (1) A label-only PATCH leaves the existing anchor lock untouched.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        let relabeled = store
            .update_edge(
                e.id,
                &EdgePatch {
                    label: Some(Some("lbl2".into())),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(relabeled.from_anchor, Some(AnchorSide::Right));
        assert_eq!(relabeled.to_anchor, None);
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap().action, "edge_relabeled");

        // (2) Locking the other end logs exactly one edge_anchor_changed event.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        let changed = store
            .update_edge(
                e.id,
                &EdgePatch {
                    to_anchor: Some(Some(AnchorSide::Bottom)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(changed.to_anchor, Some(AnchorSide::Bottom));
        assert_eq!(changed.from_anchor, Some(AnchorSide::Right)); // independent endpoints
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap().action, "edge_anchor_changed");
        assert!(events.last().unwrap().summary.contains("locked to-anchor"));

        // (3) Re-PATCHing an endpoint to the side it's already locked to is a
        // no-op: no change, no event.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        let noop = store
            .update_edge(
                e.id,
                &EdgePatch {
                    to_anchor: Some(Some(AnchorSide::Bottom)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(noop.to_anchor, Some(AnchorSide::Bottom));
        assert_eq!(store.list_diagram_events(sb.id).unwrap().len(), before);

        // Unlocking logs its own event with the "unlocked" summary shape.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        let unlocked = store
            .update_edge(
                e.id,
                &EdgePatch {
                    from_anchor: Some(None),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        assert_eq!(unlocked.from_anchor, None);
        assert_eq!(unlocked.to_anchor, Some(AnchorSide::Bottom)); // untouched
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap().action, "edge_anchor_changed");
        assert!(
            events
                .last()
                .unwrap()
                .summary
                .contains("unlocked from-anchor")
        );

        // Priority: when a single PATCH changes both an anchor and the label,
        // the anchor change wins the one-event-per-call slot.
        let before = store.list_diagram_events(sb.id).unwrap().len();
        store
            .update_edge(
                e.id,
                &EdgePatch {
                    label: Some(Some("lbl3".into())),
                    from_anchor: Some(Some(AnchorSide::Top)),
                    ..Default::default()
                },
                Some("user"),
            )
            .unwrap();
        let events = store.list_diagram_events(sb.id).unwrap();
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap().action, "edge_anchor_changed");
    }

    // ---- inbox (global update requests) ----

    /// Every inbox item names the task it came from (task 847), so each test
    /// needs one to point at. Returns the task's id.
    fn origin_task(store: &mut Store) -> i64 {
        let p = store
            .create_project("origin", None, None, None, None)
            .unwrap();
        store
            .create_task(
                p.id,
                "the task this report is about",
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

    #[test]
    fn inbox_add_delete_round_trip() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);

        // New items land unassigned in the global inbox, but always name the
        // task they came from — and read back its project and name, derived.
        let item = store
            .create_inbox_item(
                Some("agent-7"),
                "deploy v2 to staging",
                InboxKind::TaskSummary,
                origin,
            )
            .unwrap();
        assert_eq!(item.project_id, None);
        assert_eq!(item.task_id, Some(origin));
        assert_eq!(
            item.task_name.as_deref(),
            Some("the task this report is about")
        );
        assert_eq!(item.project_name.as_deref(), Some("origin"));
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
    fn assigning_an_inbox_item_converts_it_to_a_backlog_task() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let origin = origin_task(&mut store);

        // The description is the item's body verbatim; the name is its first
        // line (task 660 — an assigned item keeps every character it arrived
        // with, and the board label falls out of the body for free).
        let item = store
            .create_inbox_item(
                Some("agent-7"),
                "ship the auth fix\nmore detail here",
                InboxKind::ChangeRequest,
                origin,
            )
            .unwrap();

        let task = store.assign_inbox_item(item.id, p.id).unwrap();
        assert_eq!(task.project_id, p.id);
        assert_eq!(task.status, Status::Backlog);
        assert_eq!(task.priority, Priority::Medium);
        assert_eq!(task.description, "ship the auth fix\nmore detail here");
        assert_eq!(task.name, "ship the auth fix");

        // The item has moved out of the inbox entirely.
        assert!(matches!(
            store.get_inbox_item(item.id),
            Err(Error::NotFound(_))
        ));
        assert!(store.list_inbox_items(None).unwrap().is_empty());

        // A single-line item: body and name coincide, no duplication to avoid.
        let single = store
            .create_inbox_item(None, "quick note", InboxKind::TaskSummary, origin)
            .unwrap();
        let t2 = store.assign_inbox_item(single.id, p.id).unwrap();
        assert_eq!(t2.description, "quick note");
        assert_eq!(t2.name, "quick note");
    }

    #[test]
    fn list_inbox_items_newest_first() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let a = store
            .create_inbox_item(None, "one", InboxKind::TaskSummary, origin)
            .unwrap();
        let b = store
            .create_inbox_item(None, "two", InboxKind::TaskSummary, origin)
            .unwrap();
        let all = store.list_inbox_items(None).unwrap();
        assert_eq!(
            all.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![b.id, a.id]
        );
    }

    /// Task 831: an item arrives unread, is stamped once, and re-marking it is
    /// a no-op — the stamp is *when it was first read*, so a second pass over
    /// an item the reader has already seen must not move it.
    #[test]
    fn mark_inbox_item_read_stamps_once() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let item = store
            .create_inbox_item(None, "unread on arrival", InboxKind::TaskSummary, origin)
            .unwrap();
        assert_eq!(item.read_at, None);

        let read = store.mark_inbox_item_read(item.id).unwrap();
        let stamp = read.read_at.clone().expect("read_at is stamped");
        assert!(store.list_inbox_items(None).unwrap()[0].read_at.is_some());

        let again = store.mark_inbox_item_read(item.id).unwrap();
        assert_eq!(again.read_at, Some(stamp));
        assert_eq!(again.updated_at, read.updated_at);
    }

    /// Task 845: archiving is a place an item sits, not a fact about the past,
    /// so it toggles — and both directions are idempotent, so a second press
    /// (or a second writer) cannot move the stamp the first one set.
    #[test]
    fn set_inbox_item_archived_toggles_and_is_idempotent() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let item = store
            .create_inbox_item(None, "nothing to do here", InboxKind::TaskSummary, origin)
            .unwrap();
        assert_eq!(item.archived_at, None);

        let archived = store.set_inbox_item_archived(item.id, true).unwrap();
        let stamp = archived
            .archived_at
            .clone()
            .expect("archived_at is stamped");
        assert!(
            store.list_inbox_items(None).unwrap()[0]
                .archived_at
                .is_some()
        );

        let again = store.set_inbox_item_archived(item.id, true).unwrap();
        assert_eq!(again.archived_at, Some(stamp));
        assert_eq!(again.updated_at, archived.updated_at);

        // …and back, which clears the stamp rather than adding a second one.
        let live = store.set_inbox_item_archived(item.id, false).unwrap();
        assert_eq!(live.archived_at, None);
        // Archiving is independent of reading: an item can be set aside unread.
        assert_eq!(live.read_at, None);
    }

    #[test]
    fn set_inbox_item_archived_unknown_id_is_not_found() {
        let (mut store, _dir) = temp_store();
        assert!(matches!(
            store.set_inbox_item_archived(999, true),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn mark_inbox_item_read_unknown_id_is_not_found() {
        let (mut store, _dir) = temp_store();
        assert!(matches!(
            store.mark_inbox_item_read(999),
            Err(Error::NotFound(_))
        ));
    }

    /// Task 846: the kind is what the sender meant, so it round-trips exactly
    /// as given — and a row written before the column existed reads back as a
    /// task summary, the kind that waits for a person. The second half is the
    /// upgrade path: it must not be an unlabelled item the inbox-watcher
    /// suddenly starts dispatching agents for.
    #[test]
    fn inbox_kind_round_trips_and_defaults_to_task_summary() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);

        let request = store
            .create_inbox_item(
                None,
                "make the board sort by priority",
                InboxKind::ChangeRequest,
                origin,
            )
            .unwrap();
        assert_eq!(request.kind, InboxKind::ChangeRequest);
        assert_eq!(
            store.get_inbox_item(request.id).unwrap().kind,
            InboxKind::ChangeRequest
        );

        // A pre-846 row: the column's own default is what it gets.
        store
            .conn
            .execute(
                "INSERT INTO inbox (project_id, author, body, created_at, updated_at) \
                 VALUES (NULL, NULL, 'shipped the auth fix', datetime('now'), datetime('now'))",
                (),
            )
            .unwrap();
        let legacy = store
            .get_inbox_item(store.conn.last_insert_rowid())
            .unwrap();
        assert_eq!(legacy.kind, InboxKind::TaskSummary);
    }

    /// Task 847: the origin task is required and must exist — an unknown one is
    /// a `validation` error, mirroring `assign_inbox_item`'s unknown project.
    #[test]
    fn create_inbox_item_unknown_task_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let err = store
            .create_inbox_item(None, "from nowhere", InboxKind::TaskSummary, 999)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
        assert!(store.list_inbox_items(None).unwrap().is_empty());
    }

    /// Task 847: the task's name and project are **derived on every read**, so
    /// they follow the task rather than freezing at send time — and a row that
    /// predates the column (or whose task was deleted) reads back with all
    /// three null instead of failing.
    #[test]
    fn inbox_task_name_is_derived_on_read_and_null_without_a_task() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let item = store
            .create_inbox_item(None, "done", InboxKind::TaskSummary, origin)
            .unwrap();

        // Re-describing the task changes what the item reads back.
        store
            .update_task(
                origin,
                &TaskPatch {
                    description: Some("renamed after the report was sent".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let after = store.get_inbox_item(item.id).unwrap();
        assert_eq!(
            after.task_name.as_deref(),
            Some("renamed after the report was sent")
        );

        // A pre-847 row names no task, and reads back with nothing derived.
        store
            .conn
            .execute(
                "INSERT INTO inbox (project_id, author, body, created_at, updated_at) \
                 VALUES (NULL, NULL, 'legacy', datetime('now'), datetime('now'))",
                (),
            )
            .unwrap();
        let legacy = store
            .get_inbox_item(store.conn.last_insert_rowid())
            .unwrap();
        assert_eq!(legacy.task_id, None);
        assert_eq!(legacy.task_name, None);
        assert_eq!(legacy.project_name, None);
    }

    /// Task 847: the FK is `ON DELETE SET NULL` (as the item's own `project_id`
    /// is) — deleting the origin task loses the pointer, never the report.
    #[test]
    fn deleting_the_origin_task_leaves_the_inbox_item() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let item = store
            .create_inbox_item(
                None,
                "the report outlives its task",
                InboxKind::TaskSummary,
                origin,
            )
            .unwrap();

        store.delete_task(origin).unwrap();
        let after = store.get_inbox_item(item.id).unwrap();
        assert_eq!(after.body, "the report outlives its task");
        assert_eq!(after.task_id, None);
        assert_eq!(after.task_name, None);
        assert_eq!(after.project_name, None);
    }

    #[test]
    fn assign_inbox_item_unknown_project_is_validation_error() {
        let (mut store, _dir) = temp_store();
        let origin = origin_task(&mut store);
        let item = store
            .create_inbox_item(None, "orphan", InboxKind::TaskSummary, origin)
            .unwrap();
        let err = store.assign_inbox_item(item.id, 999).unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(err.to_string().contains("999"));
        // The failed assignment left the item untouched in the inbox.
        assert!(store.get_inbox_item(item.id).is_ok());
    }

    // ---- mesa live (task 855) ----

    /// The single-session rule: the Live page has one text field and one
    /// `<audio>` element, so a second live conversation would have nowhere to
    /// be heard. Starting again is only possible once the first has ended.
    #[test]
    fn only_one_live_session_runs_at_a_time() {
        let (mut store, _dir) = temp_store();
        let first = store.start_live_session(None).unwrap();
        assert_eq!(first.status, LiveStatus::Live);
        assert_eq!(first.ended_at, None);
        assert_eq!(store.current_live_session().unwrap().unwrap().id, first.id);

        let err = store.start_live_session(None).unwrap_err();
        assert!(matches!(err, Error::Conflict(_)), "{err:?}");
        assert!(err.to_string().contains(&first.id.to_string()));

        store.end_live_session(first.id).unwrap();
        assert!(store.current_live_session().unwrap().is_none());
        let second = store.start_live_session(None).unwrap();
        assert_ne!(second.id, first.id);
    }

    #[test]
    fn start_live_session_binds_a_project_and_refuses_an_unknown_one() {
        let (mut store, _dir) = temp_store();
        let project = store
            .create_project("talking about this", None, None, None, None)
            .unwrap();
        let session = store.start_live_session(Some(project.id)).unwrap();
        assert_eq!(session.project_id, Some(project.id));
        store.end_live_session(session.id).unwrap();

        let err = store.start_live_session(Some(999)).unwrap_err();
        assert!(matches!(err, Error::Validation(_)), "{err:?}");
        assert!(err.to_string().contains("999"));
        // A refused start left no session behind.
        assert!(store.current_live_session().unwrap().is_none());
    }

    /// The FK is `ON DELETE SET NULL`, the call the inbox makes: a
    /// conversation outlives the project row it was about.
    #[test]
    fn deleting_the_project_leaves_the_live_session() {
        let (mut store, _dir) = temp_store();
        let project = store
            .create_project("doomed", None, None, None, None)
            .unwrap();
        let session = store.start_live_session(Some(project.id)).unwrap();
        store.delete_project(project.id).unwrap();
        let after = store.get_live_session(session.id).unwrap();
        assert_eq!(after.project_id, None);
        assert_eq!(after.status, LiveStatus::Live);
    }

    /// Ending is idempotent — a stop pressed twice, or a page and an agent
    /// stopping at once, is not a failure and never moves the stamp.
    #[test]
    fn end_live_session_is_idempotent() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let ended = store.end_live_session(session.id).unwrap();
        assert_eq!(ended.status, LiveStatus::Ended);
        let stamp = ended.ended_at.clone().expect("ended_at is stamped");

        let again = store.end_live_session(session.id).unwrap();
        assert_eq!(again.ended_at, Some(stamp));
        assert_eq!(again.updated_at, ended.updated_at);
        assert!(matches!(
            store.end_live_session(999),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn bind_live_agent_records_and_clears_the_spawn_receipt() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        assert_eq!(session.agent_id, None);
        let bound = store.bind_live_agent(session.id, Some("abc123")).unwrap();
        assert_eq!(bound.agent_id.as_deref(), Some("abc123"));
        // A spawn that printed no receipt clears it rather than lying.
        let cleared = store.bind_live_agent(session.id, None).unwrap();
        assert_eq!(cleared.agent_id, None);
        assert!(matches!(
            store.bind_live_agent(999, None),
            Err(Error::NotFound(_))
        ));
    }

    /// A route is a hash path the page already renders, not free text — the
    /// one rule `set_live_route` and a `navigate` turn's target share.
    #[test]
    fn set_live_route_takes_a_hash_route_and_nothing_else() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let routed = store
            .set_live_route(session.id, "  #/projects/3/files  ")
            .unwrap();
        assert_eq!(routed.route.as_deref(), Some("#/projects/3/files"));
        assert_ne!(routed.updated_at, "");

        for bad in [
            "",
            "   ",
            "/projects/3",
            "https://example.com",
            &format!("#/{}", "x".repeat(LIVE_ROUTE_MAX)),
        ] {
            let err = store.set_live_route(session.id, bad).unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "{bad:?}: {err:?}");
        }
        // …and the route the last good call stored is still there.
        assert_eq!(
            store.get_live_session(session.id).unwrap().route.as_deref(),
            Some("#/projects/3/files")
        );
    }

    #[test]
    fn add_live_turn_records_both_sides_of_the_conversation() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let said = store
            .add_live_turn(
                session.id,
                LiveRole::User,
                "  what is on the board  ",
                None,
                None,
            )
            .unwrap();
        assert_eq!(said.role, LiveRole::User);
        assert_eq!(said.text, "what is on the board");
        assert_eq!(said.action, None);
        assert_eq!(said.delivered_at, None);
        assert_eq!(said.played_at, None);

        let reply = store
            .add_live_turn(
                session.id,
                LiveRole::Mesa,
                "Three tasks are open.",
                None,
                None,
            )
            .unwrap();
        assert_eq!(reply.role, LiveRole::Mesa);
        // A pure navigate speaks nothing — the one place empty text is legal.
        let moved = store
            .add_live_turn(
                session.id,
                LiveRole::Mesa,
                "",
                Some(LiveAction::Navigate),
                Some("#/projects/1"),
            )
            .unwrap();
        assert_eq!(moved.action, Some(LiveAction::Navigate));
        assert_eq!(moved.target.as_deref(), Some("#/projects/1"));
        assert_eq!(moved.text, "");

        let all = store.list_live_turns(session.id, None, 100).unwrap();
        assert_eq!(
            all.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![said.id, reply.id, moved.id]
        );
    }

    #[test]
    fn add_live_turn_enforces_every_shape_rule() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let long = "a".repeat(LIVE_TEXT_MAX + 1);
        let cases = [
            ("a user turn with no text", LiveRole::User, "  ", None, None),
            (
                "a user turn driving the page",
                LiveRole::User,
                "go there",
                Some(LiveAction::Navigate),
                Some("#/inbox"),
            ),
            (
                "a mesa turn that neither speaks nor acts",
                LiveRole::Mesa,
                "",
                None,
                None,
            ),
            (
                "a navigate with no target",
                LiveRole::Mesa,
                "opening",
                Some(LiveAction::Navigate),
                None,
            ),
            (
                "a target with no action",
                LiveRole::Mesa,
                "opening",
                None,
                Some("#/inbox"),
            ),
            (
                "a target that is not a route",
                LiveRole::Mesa,
                "opening",
                Some(LiveAction::Navigate),
                Some("/inbox"),
            ),
            (
                "text past the spoken bound",
                LiveRole::Mesa,
                long.as_str(),
                None,
                None,
            ),
            (
                "a sidebar action carrying a route",
                LiveRole::Mesa,
                "making room",
                Some(LiveAction::CollapseSidebars),
                Some("#/inbox"),
            ),
            (
                "a user turn collapsing the sidebars",
                LiveRole::User,
                "hide those",
                Some(LiveAction::CollapseSidebars),
                None,
            ),
        ];
        for (label, role, text, action, target) in cases {
            let err = store
                .add_live_turn(session.id, role, text, action, target)
                .unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "{label}: {err:?}");
        }
        assert!(
            store
                .list_live_turns(session.id, None, 100)
                .unwrap()
                .is_empty()
        );

        // A turn on a session that never existed, or that has ended, is a
        // caller bug — a validation error, not a silently swallowed write.
        assert!(matches!(
            store.add_live_turn(999, LiveRole::User, "hello", None, None),
            Err(Error::Validation(_))
        ));
        store.end_live_session(session.id).unwrap();
        let err = store
            .add_live_turn(session.id, LiveRole::User, "hello", None, None)
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)), "{err:?}");
    }

    /// The sidebar verbs (mesa task 859): the other half of "show me that" —
    /// they change what the person is looking at, carry no target, and like a
    /// navigate they may speak or stay silent.
    #[test]
    fn add_live_turn_collapses_and_expands_the_sidebars() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let quiet = store
            .add_live_turn(
                session.id,
                LiveRole::Mesa,
                "",
                Some(LiveAction::CollapseSidebars),
                None,
            )
            .unwrap();
        assert_eq!(quiet.action, Some(LiveAction::CollapseSidebars));
        assert_eq!(quiet.target, None);
        assert_eq!(quiet.text, "");

        let spoken = store
            .add_live_turn(
                session.id,
                LiveRole::Mesa,
                "Bringing those back.",
                Some(LiveAction::ExpandSidebars),
                None,
            )
            .unwrap();
        assert_eq!(spoken.action, Some(LiveAction::ExpandSidebars));
        assert_eq!(spoken.text, "Bringing those back.");

        // Round-trips through the db as its own value, not as a navigate.
        let all = store.list_live_turns(session.id, None, 100).unwrap();
        assert_eq!(
            all.iter().map(|t| t.action).collect::<Vec<_>>(),
            vec![
                Some(LiveAction::CollapseSidebars),
                Some(LiveAction::ExpandSidebars)
            ]
        );
    }

    /// The delivery stamp is what makes the loop safe: two listeners must
    /// never be handed the same utterance, and a delivered turn is never
    /// offered again.
    #[test]
    fn next_user_turn_hands_out_each_utterance_exactly_once() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        assert!(store.next_user_turn(session.id).unwrap().is_none());

        let first = store
            .add_live_turn(session.id, LiveRole::User, "one", None, None)
            .unwrap();
        let second = store
            .add_live_turn(session.id, LiveRole::User, "two", None, None)
            .unwrap();
        // A mesa turn is not something to listen for.
        store
            .add_live_turn(session.id, LiveRole::Mesa, "hello there", None, None)
            .unwrap();

        let got = store.next_user_turn(session.id).unwrap().unwrap();
        assert_eq!(got.id, first.id);
        assert!(got.delivered_at.is_some(), "delivered on the way out");
        let got = store.next_user_turn(session.id).unwrap().unwrap();
        assert_eq!(got.id, second.id, "oldest first");
        // Nothing left, and nothing handed out twice.
        assert!(store.next_user_turn(session.id).unwrap().is_none());
        assert!(
            store
                .list_live_turns(session.id, None, 100)
                .unwrap()
                .iter()
                .filter(|t| t.role == LiveRole::User)
                .all(|t| t.delivered_at.is_some())
        );
        // Another session's turns are not this one's.
        store.end_live_session(session.id).unwrap();
        let other = store.start_live_session(None).unwrap();
        assert!(store.next_user_turn(other.id).unwrap().is_none());
    }

    #[test]
    fn list_live_turns_walks_a_cursor_and_clamps_its_limit() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let ids: Vec<i64> = (0..5)
            .map(|i| {
                store
                    .add_live_turn(session.id, LiveRole::User, &format!("line {i}"), None, None)
                    .unwrap()
                    .id
            })
            .collect();

        let after = store
            .list_live_turns(session.id, Some(ids[1]), 100)
            .unwrap();
        assert_eq!(
            after.iter().map(|t| t.id).collect::<Vec<_>>(),
            ids[2..].to_vec()
        );
        assert_eq!(store.list_live_turns(session.id, None, 2).unwrap().len(), 2);
        // A limit outside the bounds is clamped, never honored literally: 0
        // would poll forever seeing nothing, and a huge one would page the
        // whole table into one response.
        assert_eq!(store.list_live_turns(session.id, None, 0).unwrap().len(), 1);
        assert_eq!(
            store
                .list_live_turns(session.id, None, i64::MAX)
                .unwrap()
                .len(),
            5
        );
        assert!(
            store
                .list_live_turns(session.id, Some(ids[4]), 100)
                .unwrap()
                .is_empty()
        );
    }

    /// The `read_at` rule again: the page decides a turn has been heard, and a
    /// re-render must never make it say the same thing twice.
    #[test]
    fn mark_live_turn_played_stamps_once() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        let turn = store
            .add_live_turn(
                session.id,
                LiveRole::Mesa,
                "Three tasks are open.",
                None,
                None,
            )
            .unwrap();
        assert_eq!(turn.played_at, None);

        let played = store.mark_live_turn_played(turn.id).unwrap();
        let stamp = played.played_at.clone().expect("played_at is stamped");
        let again = store.mark_live_turn_played(turn.id).unwrap();
        assert_eq!(again.played_at, Some(stamp));
        assert!(matches!(
            store.mark_live_turn_played(999),
            Err(Error::NotFound(_))
        ));
    }

    /// Turns are parts of a session, not records of their own: the FK is
    /// `ON DELETE CASCADE`, so nothing outlives the conversation it was said
    /// in.
    #[test]
    fn deleting_a_live_session_takes_its_turns_with_it() {
        let (mut store, _dir) = temp_store();
        let session = store.start_live_session(None).unwrap();
        store
            .add_live_turn(session.id, LiveRole::User, "hello", None, None)
            .unwrap();
        store
            .add_live_turn(session.id, LiveRole::Mesa, "Hello back.", None, None)
            .unwrap();
        store
            .conn
            .execute("DELETE FROM live_sessions WHERE id = ?1", [session.id])
            .unwrap();
        let left: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM live_turns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// The live tables arrive by migration, so a db written before this
    /// feature upgrades into them rather than needing a fresh file.
    #[test]
    fn the_live_tables_arrive_by_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("upgrade.db");
        // Index 43 — migration 44 — pinned, NOT `MIGRATIONS.len() - 1`: the
        // positional form silently re-aims at whatever ships next.
        const LIVE: usize = 43;
        assert!(
            MIGRATIONS[LIVE].contains("CREATE TABLE live_sessions"),
            "migration {LIVE} is no longer the mesa live migration — a shipped \
             migration was edited or reordered, which is never allowed"
        );
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..LIVE] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", LIVE as i64)
                .unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('kept')", [])
                .unwrap();
        }
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.list_projects().unwrap().len(), 1);
        assert!(store.current_live_session().unwrap().is_none());
        let session = store.start_live_session(None).unwrap();
        store
            .add_live_turn(session.id, LiveRole::User, "hello", None, None)
            .unwrap();
        assert_eq!(
            store.list_live_turns(session.id, None, 10).unwrap().len(),
            1
        );
    }

    // ---- scripts (user-authored shell) ----

    fn script_arg(name: &str, kind: ScriptArgKind) -> ScriptArg {
        ScriptArg {
            name: name.to_string(),
            label: None,
            kind,
            required: false,
            default: None,
            choices: match kind {
                ScriptArgKind::Choice => Some(vec!["a".into(), "b".into()]),
                _ => None,
            },
        }
    }

    #[test]
    fn script_create_show_delete_round_trip() {
        let (mut store, _dir) = temp_store();
        let args = vec![
            script_arg("target", ScriptArgKind::Text),
            script_arg("mode", ScriptArgKind::Choice),
        ];
        let s = store
            .create_script(None, "deploy", Some("ship it"), "echo \"$1\"\n", &args)
            .unwrap();
        assert_eq!(s.name, "deploy");
        assert_eq!(s.project_id, None);
        assert_eq!(s.body, "echo \"$1\"\n");
        // The args round-trip through the JSON column as a typed list.
        assert_eq!(s.args, args);
        assert_eq!(store.get_script(s.id).unwrap(), s);

        // Delete echoes the full destroyed record.
        let destroyed = store.delete_script(s.id).unwrap();
        assert_eq!(destroyed, s);
        assert!(matches!(store.get_script(s.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn script_requires_a_name_and_a_body() {
        let (mut store, _dir) = temp_store();
        for name in ["", "   "] {
            assert!(matches!(
                store.create_script(None, name, None, "echo hi", &[]),
                Err(Error::Validation(_))
            ));
        }
        for body in ["", "  \n "] {
            assert!(matches!(
                store.create_script(None, "s", None, body, &[]),
                Err(Error::Validation(_))
            ));
        }
        // The name is stored trimmed; the body is stored verbatim.
        let s = store
            .create_script(None, "  spaced  ", None, "  echo hi\n", &[])
            .unwrap();
        assert_eq!(s.name, "spaced");
        assert_eq!(s.body, "  echo hi\n");
    }

    #[test]
    fn script_names_are_unique_case_insensitively() {
        let (mut store, _dir) = temp_store();
        let first = store
            .create_script(None, "deploy", None, "true", &[])
            .unwrap();
        assert!(matches!(
            store.create_script(None, "Deploy", None, "true", &[]),
            Err(Error::Conflict(_))
        ));
        // A second script cannot take the name; the first can keep its own.
        let other = store
            .create_script(None, "other", None, "true", &[])
            .unwrap();
        assert!(matches!(
            store.update_script(
                other.id,
                ScriptPatch {
                    name: Some("DEPLOY".into()),
                    ..Default::default()
                }
            ),
            Err(Error::Conflict(_))
        ));
        let same = store
            .update_script(
                first.id,
                ScriptPatch {
                    name: Some("deploy".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(same.name, "deploy");
    }

    #[test]
    fn script_arg_names_are_constrained_and_unique() {
        let (mut store, _dir) = temp_store();
        for bad in ["", "1st", "has space", "a$b", &"x".repeat(65)] {
            let args = vec![script_arg(bad, ScriptArgKind::Text)];
            let err = store
                .create_script(None, "s", None, "true", &args)
                .unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "{bad:?} was accepted");
        }
        // `a-b` and `A_B` collapse onto the same MESA_ARG_A_B variable.
        let dupes = vec![
            script_arg("a-b", ScriptArgKind::Text),
            script_arg("A_B", ScriptArgKind::Text),
        ];
        assert!(matches!(
            store.create_script(None, "s", None, "true", &dupes),
            Err(Error::Validation(_))
        ));
        let ok = vec![
            script_arg("_leading", ScriptArgKind::Text),
            script_arg("dry-run", ScriptArgKind::Text),
        ];
        assert!(store.create_script(None, "s", None, "true", &ok).is_ok());
    }

    #[test]
    fn script_choice_args_need_choices_and_others_may_not_carry_them() {
        let (mut store, _dir) = temp_store();
        let mut choice = script_arg("mode", ScriptArgKind::Choice);
        choice.choices = None;
        assert!(matches!(
            store.create_script(None, "s", None, "true", &[choice.clone()]),
            Err(Error::Validation(_))
        ));
        choice.choices = Some(vec![]);
        assert!(matches!(
            store.create_script(None, "s", None, "true", &[choice]),
            Err(Error::Validation(_))
        ));
        for kind in [
            ScriptArgKind::Text,
            ScriptArgKind::Number,
            ScriptArgKind::Bool,
        ] {
            let mut arg = script_arg("x", kind);
            arg.choices = Some(vec!["a".into()]);
            assert!(
                matches!(
                    store.create_script(None, "s", None, "true", &[arg]),
                    Err(Error::Validation(_))
                ),
                "{kind:?} was allowed to carry choices"
            );
        }
    }

    #[test]
    fn script_project_must_exist_and_unbinds_on_project_delete() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        assert!(matches!(
            store.create_script(Some(999), "s", None, "true", &[]),
            Err(Error::Validation(_))
        ));
        let s = store
            .create_script(Some(p.id), "s", None, "true", &[])
            .unwrap();
        assert_eq!(s.project_id, Some(p.id));
        // ON DELETE SET NULL, not CASCADE: the script survives its project.
        store.delete_project(p.id).unwrap();
        assert_eq!(store.get_script(s.id).unwrap().project_id, None);
    }

    #[test]
    fn find_script_by_name_is_case_insensitive_and_hints_on_a_miss() {
        let (mut store, _dir) = temp_store();
        let s = store
            .create_script(None, "Deploy", None, "true", &[])
            .unwrap();
        assert_eq!(store.find_script_by_name("deploy").unwrap().id, s.id);
        assert_eq!(store.find_script_by_name("DEPLOY").unwrap().id, s.id);
        let err = store.find_script_by_name("nope").unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
        assert!(err.to_string().contains("mesa script list"), "{err}");
    }

    #[test]
    fn list_scripts_orders_by_name_and_scopes_to_a_project() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        store
            .create_script(None, "zeta", None, "true", &[])
            .unwrap();
        store
            .create_script(Some(p.id), "Alpha", None, "true", &[])
            .unwrap();
        store.create_script(None, "mid", None, "true", &[]).unwrap();
        let names = |v: Vec<Script>| v.into_iter().map(|s| s.name).collect::<Vec<_>>();
        assert_eq!(
            names(store.list_scripts(None).unwrap()),
            vec!["Alpha", "mid", "zeta"]
        );
        assert_eq!(
            names(store.list_scripts(Some(p.id)).unwrap()),
            vec!["Alpha"]
        );
    }

    #[test]
    fn update_script_patches_only_what_it_names() {
        let (mut store, _dir) = temp_store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let s = store
            .create_script(
                Some(p.id),
                "s",
                Some("desc"),
                "true",
                &[script_arg("a", ScriptArgKind::Text)],
            )
            .unwrap();

        // An empty patch changes nothing.
        let same = store.update_script(s.id, ScriptPatch::default()).unwrap();
        assert_eq!(same.name, s.name);
        assert_eq!(same.body, s.body);
        assert_eq!(same.args, s.args);
        assert_eq!(same.project_id, Some(p.id));

        // Some(None) clears the clearable fields; the rest are untouched.
        let cleared = store
            .update_script(
                s.id,
                ScriptPatch {
                    project_id: Some(None),
                    description: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.project_id, None);
        assert_eq!(cleared.description, None);
        assert_eq!(cleared.body, "true");

        // The replace-only fields re-run every create rule.
        assert!(matches!(
            store.update_script(
                s.id,
                ScriptPatch {
                    body: Some("  ".into()),
                    ..Default::default()
                }
            ),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            store.update_script(
                s.id,
                ScriptPatch {
                    args: Some(vec![script_arg("bad name", ScriptArgKind::Text)]),
                    ..Default::default()
                }
            ),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            store.update_script(
                s.id,
                ScriptPatch {
                    project_id: Some(Some(999)),
                    ..Default::default()
                }
            ),
            Err(Error::Validation(_))
        ));

        let updated = store
            .update_script(
                s.id,
                ScriptPatch {
                    name: Some("renamed".into()),
                    body: Some("echo two".into()),
                    args: Some(vec![]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.body, "echo two");
        assert!(updated.args.is_empty());
        assert!(matches!(
            store.update_script(999, ScriptPatch::default()),
            Err(Error::NotFound(_))
        ));
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
                tool_use_id: None,
                description: None,
                spawn_depth: None,
                parent_agent_id: None,
            }],
            messages: vec![
                CcMessageRow {
                    uuid: "uuid-1".into(),
                    message_id: None,
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
                    preview: Some("Reading the store.".into()),
                },
                CcMessageRow {
                    uuid: "uuid-2".into(),
                    message_id: None,
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
                    // A tool-use-only message: no prose, so no preview.
                    preview: None,
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
                target: Some("ls -la".into()),
            }],
            prompts: vec![CcPromptRow {
                uuid: "uuid-0".into(),
                session_id: "sess-1".into(),
                ts: 1400,
                preview: "read the store".into(),
            }],
            node_files: vec![
                CcNodeFilePair {
                    session_id: "sess-1".into(),
                    agent_id: String::new(),
                },
                CcNodeFilePair {
                    session_id: "sess-1".into(),
                    agent_id: "agent-1".into(),
                },
            ],
        }
    }

    /// Task 660: the `title` column is gone and no title may be lost — the old
    /// value becomes the description's first line, which is exactly what the
    /// derived `name` reads. Covers the three backfill cases the migration
    /// distinguishes (no description, empty title, both present).
    #[test]
    fn migration_folds_the_old_title_into_the_description() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre-660.db");
        const TITLE_FOLD: usize = 25;
        assert!(
            MIGRATIONS[TITLE_FOLD].contains("ALTER TABLE tasks DROP COLUMN title"),
            "migration {TITLE_FOLD} is no longer the title fold — a shipped \
             migration was edited or reordered, which is never allowed"
        );
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..TITLE_FOLD] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", TITLE_FOLD as i64)
                .unwrap();
            conn.execute("INSERT INTO projects (name) VALUES ('kept')", [])
                .unwrap();
            for (title, description) in [
                ("title only", None),
                ("both", Some("the body")),
                ("", Some("body, no title")),
                ("blank description", Some("   ")),
            ] {
                conn.execute(
                    "INSERT INTO tasks (project_id, title, description, created_at, updated_at) \
                     VALUES (1, ?1, ?2, datetime('now'), datetime('now'))",
                    rusqlite::params![title, description],
                )
                .unwrap();
            }
        }

        let store = Store::open(&path).unwrap();
        let tasks = store.list_tasks(None).unwrap();
        let bodies: Vec<&str> = tasks.iter().map(|t| t.description.as_str()).collect();
        assert_eq!(
            bodies,
            vec![
                "title only",
                "both\n\nthe body",
                "body, no title",
                "blank description",
            ],
            "no title may be lost, and no row may gain a leading blank line"
        );
        // The label every surface shows comes back out of the folded body.
        assert_eq!(tasks[1].name, "both");
        // The column itself is gone.
        let schema: String = store
            .conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!schema.contains("title"), "tasks.title survived: {schema}");
    }

    #[test]
    fn cc_migration_applies_on_existing_pre_cc_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pre-cc.db");
        // Pinned by index for the same reason as `CURSOR_RESET` above: the
        // subject is migration 12 (index 11), the one that creates the cc
        // tables, not "whatever shipped most recently".
        const CC_TABLES: usize = 11;
        assert!(
            MIGRATIONS[CC_TABLES].contains("CREATE TABLE cc_sessions"),
            "migration {CC_TABLES} is no longer the cc-tables migration — a \
             shipped migration was edited or reordered, which is never allowed"
        );
        // Build a db at the version just before the cc migration, with data.
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..CC_TABLES] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", CC_TABLES as i64)
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
        // One pointer row per thread the file carried — main plus subagent.
        assert_eq!(cc_count(&store, "cc_node_files"), 2);

        // Same batch again: a no-op — zero adds, row counts unchanged.
        let second = store.cc_ingest_file("/t/a.jsonl", &cursor, &batch).unwrap();
        assert_eq!(second, CcIngestCounts::default());
        assert_eq!(cc_count(&store, "cc_sessions"), 1);
        assert_eq!(cc_count(&store, "cc_agent_runs"), 1);
        assert_eq!(cc_count(&store, "cc_messages"), 2);
        assert_eq!(cc_count(&store, "cc_tool_calls"), 1);
        assert_eq!(cc_count(&store, "cc_files"), 1);
        // The pointer upserts on its composite key, so a re-walk rewrites the
        // same two rows rather than accumulating one pair per sync.
        assert_eq!(cc_count(&store, "cc_node_files"), 2);
    }

    /// The pointer is last-writer-wins by design: a transcript Claude Code has
    /// moved must resolve to where it is *now*, not where it first appeared.
    #[test]
    fn cc_node_file_pointer_follows_the_newest_sighting() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        store
            .cc_ingest_file("/t/old.jsonl", &cursor, &cc_batch())
            .unwrap();
        assert_eq!(
            store.cc_node_file("sess-1", "").unwrap().as_deref(),
            Some("/t/old.jsonl")
        );
        store
            .cc_ingest_file("/t/new.jsonl", &cursor, &cc_batch())
            .unwrap();
        assert_eq!(
            store.cc_node_file("sess-1", "").unwrap().as_deref(),
            Some("/t/new.jsonl")
        );
        assert_eq!(
            store.cc_node_file("sess-1", "agent-1").unwrap().as_deref(),
            Some("/t/new.jsonl")
        );
        // An unknown thread has no pointer — the caller's `unavailable`.
        assert_eq!(store.cc_node_file("sess-1", "nope").unwrap(), None);
    }

    /// The task-803 pair, pinned by adjacency: the `CREATE TABLE` must be
    /// immediately followed by the cursor reset that backfills it, and both
    /// must ship in the same binary as the ingest write. Located by content
    /// rather than by literal index — migrations append, so the pair drifts
    /// down the array — but nothing may ever land *between* the two.
    #[test]
    fn node_files_table_is_immediately_followed_by_its_cursor_reset() {
        let i = MIGRATIONS
            .iter()
            .position(|m| m.contains("CREATE TABLE cc_node_files"))
            .expect("the cc_node_files migration is gone");
        assert_eq!(MIGRATIONS[i + 1].trim(), "DELETE FROM cc_files;");
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
    fn cc_reset_empties_every_cc_table_including_cursors() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 111,
            size: 222,
            byte_offset: 222,
        };
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &cc_batch())
            .unwrap();
        assert!(store.cc_stamp().unwrap() > 0);
        assert!(!store.cc_cursors().unwrap().is_empty());
        assert!(!store.cc_session_prompts("sess-1").unwrap().is_empty());
        assert!(store.cc_node_file("sess-1", "").unwrap().is_some());

        store.cc_reset().unwrap();

        // Stamp back to zero — the one write that makes it go *down* — and the
        // cursors are gone too, so the next plain sync re-walks from byte 0.
        assert_eq!(store.cc_stamp().unwrap(), 0);
        assert!(store.cc_cursors().unwrap().is_empty());
        assert_eq!(
            store
                .conn
                .query_row("SELECT COUNT(*) FROM cc_agent_runs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(store.cc_session_prompts("sess-1").unwrap().is_empty());
        assert_eq!(store.cc_node_file("sess-1", "").unwrap(), None);
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
                tool_use_id: None,
                description: None,
                spawn_depth: None,
                parent_agent_id: None,
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
                // Absent on the first batch, so these DO land — the backfill
                // path a `cc sync --rebuild` takes over rows ingested before
                // migration 21 added the columns.
                tool_use_id: Some("toolu_1".into()),
                description: Some("spawned".into()),
                spawn_depth: Some(2),
                parent_agent_id: Some("p".into()),
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

        // The sidecar columns take the same COALESCE path: all four were NULL
        // after the first batch, so the second backfills every one of them.
        let run = store.cc_session_agent_runs("s").unwrap();
        assert_eq!(run.len(), 1);
        assert_eq!(run[0].tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(run[0].description.as_deref(), Some("spawned"));
        assert_eq!(run[0].spawn_depth, Some(2));
        assert_eq!(run[0].parent_agent_id.as_deref(), Some("p"));
    }

    /// `target` (migration 22) lands on rows ingested before it existed, the
    /// way `cc sync --rebuild` delivers it — but without the re-ingest being
    /// counted as new rows, which is what a `DO UPDATE` upsert would have done.
    #[test]
    fn cc_tool_call_target_backfills_without_inflating_the_add_count() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        let row = |target: Option<&str>| CcFileBatch {
            tool_calls: vec![CcToolCallRow {
                tool_use_id: "tu1".into(),
                message_uuid: "u1".into(),
                session_id: "s".into(),
                agent_id: None,
                name: "Bash".into(),
                caller: None,
                ts: 10,
                target: target.map(str::to_string),
            }],
            ..Default::default()
        };
        let target = |s: &Store| -> Option<String> {
            s.conn
                .query_row(
                    "SELECT target FROM cc_tool_calls WHERE tool_use_id = 'tu1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };

        // Ingested before migration 22 existed: the row lands with no target.
        let first = store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(None))
            .unwrap();
        assert_eq!(first.tool_calls_added, 1);
        assert_eq!(target(&store), None);

        // Re-parsed by a rebuild, now with a target: the gap fills, and the
        // row is NOT re-counted as added (a 52k-call rebuild must not report
        // 52k new rows).
        let second = store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(Some("cargo test")))
            .unwrap();
        assert_eq!(second.tool_calls_added, 0);
        assert_eq!(target(&store).as_deref(), Some("cargo test"));
        assert_eq!(cc_count(&store, "cc_tool_calls"), 1);

        // Keep-first, like every other cc column: a stored value is never
        // overwritten by a later parse.
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(Some("rm -rf /")))
            .unwrap();
        assert_eq!(target(&store).as_deref(), Some("cargo test"));
    }

    // Same contract as the `target` test above, for the `preview` column added
    // by migration 24. Kept as its own test rather than folded in: they cover
    // two independent statements in `cc_ingest_file`, and a regression in one
    // must not be masked by the other.
    #[test]
    fn cc_message_preview_backfills_without_inflating_the_add_count() {
        let (mut store, _dir) = temp_store();
        let cursor = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        let row = |preview: Option<&str>| CcFileBatch {
            messages: vec![CcMessageRow {
                uuid: "u1".into(),
                message_id: None,
                session_id: "s".into(),
                agent_id: None,
                ts: 10,
                model: "claude-fable-5".into(),
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 4,
                skill: None,
                agent: None,
                preview: preview.map(str::to_string),
            }],
            ..Default::default()
        };
        let preview = |s: &Store| -> Option<String> {
            s.conn
                .query_row(
                    "SELECT preview FROM cc_messages WHERE uuid = 'u1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };

        // Ingested before migration 24 existed: the row lands with no preview.
        let first = store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(None))
            .unwrap();
        assert_eq!(first.messages_added, 1);
        assert_eq!(preview(&store), None);

        // Re-walked after the migration cleared the cursors, now carrying
        // prose: the gap fills, and the row is NOT re-counted as added — the
        // whole reason this is a guarded UPDATE and not a `DO UPDATE` arm.
        let second = store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(Some("Let me check that.")))
            .unwrap();
        assert_eq!(second.messages_added, 0);
        assert_eq!(preview(&store).as_deref(), Some("Let me check that."));
        assert_eq!(cc_count(&store, "cc_messages"), 1);

        // Keep-first: a stored preview is never overwritten by a later parse.
        store
            .cc_ingest_file("/t/a.jsonl", &cursor, &row(Some("something else")))
            .unwrap();
        assert_eq!(preview(&store).as_deref(), Some("Let me check that."));

        // And the round-trip reader surfaces it, so the column is not
        // write-only for the graph story that consumes it next.
        assert_eq!(
            store.cc_session_messages("s").unwrap()[0]
                .preview
                .as_deref(),
            Some("Let me check that.")
        );
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
