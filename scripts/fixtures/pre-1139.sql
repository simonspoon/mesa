-- A mesa db at `user_version = 54`: the schema exactly as it stood just
-- before migration index 54 (the `command` -> `prompt` fold, mesa task 1139).
-- Loaded by scripts/library-check.sh section 12, which inserts a pre-1139
-- `command` row into it and then opens it with the current binary so the fold
-- replays for real.
--
-- Generated from 998c383821824c09b0d108aeae1c382615a530cf — the parent of
-- 14a1b465bf71361830d1186dde006a8476d53e30, the commit that added migration
-- index 54 — with:
--
--     git worktree add <wt> 998c383 && cd <wt> && cargo build
--     MESA_DB=<scratch>.db ./target/debug/mesa project list
--     sqlite3 <scratch>.db .dump          # then append the PRAGMA below,
--                                         # which .dump does not carry
--
-- NEVER regenerate this by taking a current-binary db and rewinding
-- `user_version`: hand-undoing the later migrations cannot restore the
-- original schema (`ALTER TABLE ... DROP COLUMN` does not), and the list of
-- things to undo re-breaks on every non-idempotent migration added after it.
-- Rebuild it from a binary at the sha above, or not at all.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT
    , root_commit TEXT, local_path TEXT, archived INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0, parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE);
CREATE TABLE tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id   INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'todo',
        priority    TEXT NOT NULL DEFAULT 'medium',
        tags        TEXT NOT NULL DEFAULT '[]'
    , acceptance TEXT, artifact TEXT, created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z', updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z', sort_order REAL NOT NULL DEFAULT 0, result TEXT, owner TEXT, claimed_at TEXT);
CREATE TABLE dependencies (
        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        blocked_by INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, blocked_by)
    );
CREATE TABLE task_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        at          TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS "diagrams" (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        description TEXT,
        author      TEXT,
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    , diagram_type TEXT NOT NULL DEFAULT 'storyboard');
CREATE TABLE frames (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        diagram_id INTEGER NOT NULL REFERENCES "diagrams"(id) ON DELETE CASCADE,
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
    , shape TEXT);
CREATE TABLE frame_edges (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        diagram_id INTEGER NOT NULL REFERENCES "diagrams"(id) ON DELETE CASCADE,
        from_frame    INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
        to_frame      INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
        label         TEXT,
        author        TEXT,
        created_at    TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    , waypoints TEXT, from_anchor TEXT, to_anchor TEXT, style TEXT, from_marker TEXT, to_marker TEXT);
CREATE TABLE IF NOT EXISTS "diagram_events" (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        diagram_id INTEGER NOT NULL REFERENCES "diagrams"(id) ON DELETE CASCADE,
        actor         TEXT,
        action        TEXT NOT NULL,
        summary       TEXT NOT NULL,
        at            TEXT NOT NULL
    );
CREATE TABLE inbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        author      TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    , read_at TEXT, archived_at TEXT, kind TEXT NOT NULL DEFAULT 'task-summary', task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL);
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
        skill       TEXT, tool_use_id TEXT, description TEXT, spawn_depth INTEGER, parent_agent_id TEXT,
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
    , preview TEXT, message_id TEXT);
CREATE TABLE cc_tool_calls (
        tool_use_id  TEXT PRIMARY KEY,
        message_uuid TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        agent_id     TEXT,
        name         TEXT NOT NULL,
        caller       TEXT,
        ts           INTEGER NOT NULL
    , target TEXT);
CREATE TABLE cc_files (
        path        TEXT PRIMARY KEY,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL
    );
CREATE TABLE attachments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        filename     TEXT NOT NULL,
        content_type TEXT,
        size_bytes   INTEGER NOT NULL,
        author       TEXT,
        created_at   TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
CREATE TABLE cc_prompts (uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, preview TEXT NOT NULL);
CREATE TABLE scripts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        description TEXT,
        body        TEXT NOT NULL,
        args        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
CREATE TABLE cc_node_files (session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, PRIMARY KEY (session_id, agent_id));
CREATE TABLE live_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        agent_id    TEXT,
        status      TEXT NOT NULL,
        route       TEXT,
        started_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        ended_at    TEXT
    , context TEXT, working_since TEXT, window_box TEXT);
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
CREATE TABLE library_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        scope       TEXT NOT NULL,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        body        TEXT NOT NULL,
        builtin_id  TEXT UNIQUE,
        synced_body TEXT,
        synced_at   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
CREATE TABLE library_versions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        body       TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
CREATE TABLE task_receipts (
        task_id         INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        generated_at    TEXT NOT NULL,
        owner           TEXT,
        claimed_at      TEXT,
        closed_at       TEXT NOT NULL,
        branch          TEXT,
        repo_path       TEXT,
        commits         TEXT NOT NULL DEFAULT '[]',
        files_changed   INTEGER NOT NULL DEFAULT 0,
        insertions      INTEGER NOT NULL DEFAULT 0,
        deletions       INTEGER NOT NULL DEFAULT 0,
        session_id      TEXT,
        transcript_path TEXT,
        edited          INTEGER NOT NULL DEFAULT 0,
        note            TEXT
    );
CREATE TABLE live_summaries (
        session_id  INTEGER PRIMARY KEY REFERENCES live_sessions(id) ON DELETE CASCADE,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
CREATE TABLE artifacts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        name         TEXT NOT NULL,
        content_type TEXT NOT NULL,
        body         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );
CREATE TABLE live_boards (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        title        TEXT,
        body         TEXT NOT NULL,
        content_type TEXT,
        created_at   TEXT NOT NULL
    );
CREATE TABLE cc_tool_errors (
        tool_use_id   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        ts            INTEGER NOT NULL,
        sidechain     INTEGER NOT NULL DEFAULT 0,
        denial_kind   TEXT,
        denial_tool   TEXT,
        denial_command TEXT,
        denial_reason TEXT,
        signature     TEXT,
        excerpt       TEXT
    );
CREATE UNIQUE INDEX idx_projects_root_commit
        ON projects(root_commit) WHERE root_commit IS NOT NULL;
CREATE INDEX idx_cc_messages_session ON cc_messages(session_id);
CREATE INDEX idx_cc_messages_ts      ON cc_messages(ts);
CREATE INDEX idx_cc_tool_calls_session ON cc_tool_calls(session_id);
CREATE INDEX idx_cc_tool_calls_ts      ON cc_tool_calls(ts);
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_cc_agent_runs_tool ON cc_agent_runs(tool_use_id);
CREATE INDEX idx_cc_prompts_session ON cc_prompts(session_id, ts);
CREATE INDEX idx_live_turns_session ON live_turns(session_id, id);
CREATE UNIQUE INDEX library_items_identity
        ON library_items (kind, scope, COALESCE(project_id, -1), name);
CREATE INDEX idx_library_versions_item ON library_versions(item_id, id);
CREATE INDEX idx_artifacts_project ON artifacts(project_id);
CREATE INDEX idx_live_boards_session ON live_boards(session_id);
CREATE INDEX idx_cc_tool_errors_session ON cc_tool_errors(session_id);
CREATE INDEX idx_cc_tool_errors_ts      ON cc_tool_errors(ts);
COMMIT;
PRAGMA user_version = 54;
