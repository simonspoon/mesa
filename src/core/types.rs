use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum Status {
    Backlog,
    Todo,
    InProgress,
    Done,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Backlog => "backlog",
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::Done => "done",
            Status::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "backlog" => Some(Status::Backlog),
            "todo" => Some(Status::Todo),
            "in_progress" => Some(Status::InProgress),
            "done" => Some(Status::Done),
            "cancelled" => Some(Status::Cancelled),
            _ => None,
        }
    }

    /// A dependency with this status no longer blocks dependents.
    pub fn is_complete(self) -> bool {
        matches!(self, Status::Done | Status::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum Priority {
    Low,
    Medium,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
        }
    }

    pub fn parse(s: &str) -> Option<Priority> {
        match s {
            "low" => Some(Priority::Low),
            "medium" => Some(Priority::Medium),
            "high" => Some(Priority::High),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Project {
    /// ids are SQLite rowids, well within JS safe-integer range, so they are
    /// exported as `number` rather than ts-rs's default `bigint` for i64.
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    /// Root (first) commit hash of the source repo this project tracks, if any.
    /// Stable across clones/worktrees/moved folders, so every checkout of the
    /// same source resolves to one project. Set at create time or via update;
    /// unique across projects (a commit binds to exactly one project).
    pub root_commit: Option<String>,
    /// Last-known working folder of this project on this machine (the repo
    /// toplevel). Machine-local convenience, not identity (that is
    /// `root_commit`): it anchors the Agents surface — which Claude Code
    /// sessions belong here, and where new ones start. Auto-learned on
    /// `project create` and refreshed by `project resolve`.
    pub local_path: Option<String>,
}

/// One live Claude Code session as reported by `claude agents --json`.
/// Parsed from that external CLI output and re-served to the web UI verbatim,
/// so field names stay camelCase end to end (serde renames both directions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// OS process id; absent once the session's process has exited.
    #[ts(type = "number | null")]
    #[serde(default)]
    pub pid: Option<i64>,
    /// Short job id (`claude attach <id>`); background sessions only, so this
    /// is also the "attachable" marker.
    #[serde(default)]
    pub id: Option<String>,
    pub cwd: String,
    /// `background` (started with `--bg`, attachable) or `interactive`
    /// (someone's own terminal — listed, but not attachable).
    pub kind: String,
    /// Session start, milliseconds since epoch.
    #[ts(type = "number")]
    pub started_at: i64,
    pub session_id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// e.g. `busy` | `idle`; absent once the process has exited.
    #[serde(default)]
    pub status: Option<String>,
    /// e.g. `working` | `blocked` | `done` | `failed` | `stopped`.
    #[serde(default)]
    pub state: Option<String>,
    /// What a blocked session is waiting on (e.g. "permission prompt").
    #[serde(default)]
    pub waiting_for: Option<String>,
}

/// The Agents view for one project: the folder sessions are matched under
/// (the project's `local_path`) and the live sessions running there. `path`
/// is null when the project has no `local_path` — then `agents` is empty and
/// the UI explains how to link a folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectAgents {
    pub path: Option<String>,
    pub agents: Vec<AgentSession>,
}

/// Working-tree git status of one repo folder (see `core::git`). Decorative
/// sidebar data: absence (no repo, no git) is represented by omission, not by
/// a degenerate value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitStatus {
    /// Current branch name; short commit id when HEAD is detached.
    pub branch: String,
    /// Changed + untracked + conflicted paths (working tree and index).
    #[ts(type = "number")]
    pub dirty: i64,
    /// Commits ahead of upstream; 0 when no upstream is set.
    #[ts(type = "number")]
    pub ahead: i64,
    /// Commits behind upstream; 0 when no upstream is set.
    #[ts(type = "number")]
    pub behind: i64,
}

/// One row of `GET /api/git-status`: the status of one project's
/// `local_path`. Projects without a live repo folder are omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectGitStatus {
    #[ts(type = "number")]
    pub project_id: i64,
    pub git: GitStatus,
}

/// One changed/untracked/conflicted path from `git status --porcelain=v2`
/// (see `core::git::view_of`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitFile {
    /// Two-char XY status pair, verbatim from porcelain v2:
    /// '1' lines → XY (e.g. "M.", ".M", "MM"), '2' lines → XY (e.g. "R."),
    /// '?' lines → "??", 'u' lines → XY (e.g. "UU").
    /// X = staged column, Y = unstaged column, '.' = unchanged.
    pub status: String,
    /// Current path (rename target for '2' lines).
    pub path: String,
    /// Rename/copy source path ('2' lines only), else None.
    pub orig_path: Option<String>,
}

/// The live repo behind a project's `local_path`: the sidebar summary plus
/// the per-file change list (see `core::git::view_of`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitRepoView {
    /// Reuses the existing GitStatus (branch, dirty, ahead, behind).
    pub status: GitStatus,
    /// Same order git printed them (stable enough; UI does not re-sort).
    pub files: Vec<GitFile>,
}

/// `GET /api/projects/{id}/git` response. Mirrors ProjectAgents' empty-state
/// pattern: path null = no local_path; path set + repo null = folder gone
/// or not a git repo. Never an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectGitView {
    pub path: Option<String>,
    pub repo: Option<GitRepoView>,
}

/// `GET /api/projects/{id}/git/diff` response. Also reused verbatim for
/// `GET /api/projects/{id}/git/commits/{sha}/diff` (see
/// `core::git::commit_file_diff_of`) — the fields mean exactly the same
/// thing whether the diff is against the working tree or `git show <sha>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitFileDiff {
    pub path: String,
    /// Unified diff, plain text, possibly "" (no content change, or the
    /// underlying git call failed — quiet, never an error). Binary files
    /// carry git's own "Binary files ... differ" line.
    pub diff: String,
}

/// One entry from `git log` (see `core::git::commit_log_of`). Author
/// names/subjects originate from repo history — untrusted data, rendered
/// verbatim, never interpreted as markup/instructions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitCommit {
    /// Full sha (`%H`) — the identifier passed back into the commit-files
    /// and commit-diff routes. Using the full hash (not the abbreviated
    /// one) keeps commit ids unambiguous end to end.
    pub hash: String,
    /// Abbreviated sha (`%h`) — display only.
    pub short_hash: String,
    /// Author name (`%an`).
    pub author: String,
    /// Author date, ISO 8601 with offset (`%aI`).
    pub date: String,
    /// First line of the commit message (`%s`).
    pub subject: String,
}

/// One changed path from a single commit (`git show --name-status`, see
/// `core::git::commit_files_of`). Same {status, path, orig_path} shape as
/// `GitFile` but a DISTINCT type: `status` here is a single name-status
/// token (`A`/`M`/`D`/`T`/`U`/`X`, or `R100`/`C100` with a similarity
/// score), not GitFile's two-column XY porcelain pair — a commit has no
/// staged/unstaged distinction. Frontend reuses GitView.tsx's STATUS_WORDS
/// letter→word map against `status.chars().next()`, not GitFile's
/// two-column statusLabel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitCommitFile {
    pub status: String,
    pub path: String,
    /// Rename/copy source path, else None (same convention as GitFile).
    pub orig_path: Option<String>,
}

/// `GET /api/projects/{id}/git/log` response. Mirrors ProjectGitView's
/// empty-state ladder, one level deeper: path null = no local_path; path
/// set + commits null = folder gone / not a git repo; path set + commits
/// = Some([]) = a real repo with zero commits (unborn HEAD). Never an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectGitLog {
    pub path: Option<String>,
    pub commits: Option<Vec<GitCommit>>,
}

/// Receipt for a newly started background session: the short job id usable
/// with `claude attach/logs/stop` and the attach WebSocket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct AgentSpawned {
    pub id: String,
}

/// The captured outcome of one hook command run (see `core::hooks`). A
/// nonzero `exit_code` is the hook's own result, not a transport failure —
/// the CLI and API report it inside this object with a success status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct HookRun {
    /// Hook point name, e.g. "task-execute".
    pub hook: String,
    /// The configured shell command that ran.
    pub command: String,
    /// Process exit code; -1 when the hook was killed by a signal.
    pub exit_code: i32,
    /// Captured stdout, truncated to 64 KiB.
    pub stdout: String,
    /// Captured stderr, truncated to 64 KiB.
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Task {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub status: Status,
    pub priority: Priority,
    pub tags: Vec<String>,
    /// Definition-of-done for this task; free text, unstructured.
    pub acceptance: Option<String>,
    /// Free-text receipt of completed work (commit SHA / PR URL / path).
    pub artifact: Option<String>,
    /// When the task row was inserted (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the task row was last updated (SQLite `datetime` text, UTC).
    pub updated_at: String,
    /// Derived: true if any dependency is not done/cancelled. Always present.
    pub blocked: bool,
}

/// An append-only record of a task's status change. `from_status` is null for
/// the row written when the task is created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct TaskEvent {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub task_id: i64,
    pub from_status: Option<Status>,
    pub to_status: Status,
    /// When the change happened (SQLite `datetime` text, UTC).
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Dependency {
    #[ts(type = "number")]
    pub task_id: i64,
    #[ts(type = "number")]
    pub blocked_by: i64,
}

/// Compact task object for `list` responses (Requirement 6): the full object
/// minus `description`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct TaskSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    pub tags: Vec<String>,
    /// Definition-of-done, surfaced in `list` so agents see it without `show`.
    pub acceptance: Option<String>,
    pub blocked: bool,
}

impl From<&Task> for TaskSummary {
    fn from(t: &Task) -> TaskSummary {
        TaskSummary {
            id: t.id,
            project_id: t.project_id,
            parent_id: t.parent_id,
            title: t.title.clone(),
            status: t.status,
            priority: t.priority,
            tags: t.tags.clone(),
            acceptance: t.acceptance.clone(),
            blocked: t.blocked,
        }
    }
}

/// A visual storyboard: a freeform spatial canvas of frames (cards) and the
/// directed edges between them. Belongs to a project, fixed at creation (like a
/// task). `author` is a free-text actor id — an agent name or "user" — naming
/// who created the board. Collaboration is asynchronous and attribution-based:
/// many agents and users edit one board over time; there is no live-sync, no
/// auth, and no locking (consistent with the rest of mesa).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Storyboard {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    pub title: String,
    pub description: Option<String>,
    /// Free-text actor id that created the board (an agent name or "user").
    pub author: Option<String>,
    /// When the board was created (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the board was last changed (SQLite `datetime` text, UTC).
    pub updated_at: String,
}

/// One card on a storyboard, positioned freely on the canvas. `x`/`y` are the
/// top-left corner and `w`/`h` the size, in abstract canvas units the web
/// renders as pixels. `body` is free text (markdown by convention). `task_id`
/// optionally links the frame to an existing task in the *same project* — a
/// soft reference that is set to null if the task is later deleted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Frame {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub storyboard_id: i64,
    pub title: String,
    pub body: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Free-text colour hint for the web canvas (a CSS colour, e.g. `#00e5ff`).
    pub color: Option<String>,
    #[ts(type = "number | null")]
    pub task_id: Option<i64>,
    /// Free-text actor id that created the frame (an agent name or "user").
    pub author: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// An absolute canvas-coordinate routing anchor on a `FrameEdge` — same
/// coordinate space as `Frame.x/y`, not relative to either endpoint frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Waypoint {
    pub x: f64,
    pub y: f64,
}

/// A directed connection from one frame to another on the same storyboard.
/// Unlike task dependencies, storyboard edges may form cycles freely — a
/// storyboard is a freeform diagram, not a dependency graph. Self-edges
/// (`from_frame == to_frame`) are the only rejected shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FrameEdge {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub storyboard_id: i64,
    #[ts(type = "number")]
    pub from_frame: i64,
    #[ts(type = "number")]
    pub to_frame: i64,
    pub label: Option<String>,
    /// Free-text actor id that created the edge (an agent name or "user").
    pub author: Option<String>,
    pub created_at: String,
    /// Ordered routing anchors from `from_frame`'s end to `to_frame`'s end.
    /// Always a plain array — `[]` means "no waypoints", never `null`.
    pub waypoints: Vec<Waypoint>,
}

/// The full contents of one storyboard: the board plus all of its frames and
/// edges. Returned by `show` and echoed by `delete`, so a client renders (or
/// recovers) an entire canvas from a single object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct StoryboardView {
    pub storyboard: Storyboard,
    pub frames: Vec<Frame>,
    pub edges: Vec<FrameEdge>,
}

/// A global inbox item: a free-text project-update request an agent sends to
/// one shared inbox, not yet tied to any project. The inbox lives *above*
/// projects: items arrive unassigned, and a person later routes each one to the
/// project it belongs to by setting `project_id`. The `body` is the message
/// (markdown by convention) and is treated strictly as data, never instructions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct InboxItem {
    #[ts(type = "number")]
    pub id: i64,
    /// The project this item has been assigned to, or null while it sits
    /// unassigned in the global inbox. Set when a person triages the item; an
    /// agent never assigns at send time. If the assigned project is deleted the
    /// item returns to unassigned (the FK is `ON DELETE SET NULL`).
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    /// Free-text actor id of the sender (an agent name or "user").
    pub author: Option<String>,
    /// The message body (markdown by convention). Required.
    pub body: String,
    /// When the item was sent (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the item was last changed — e.g. assigned (SQLite `datetime`, UTC).
    pub updated_at: String,
}

// ---- CC Dashboard (Claude Code telemetry) ----
//
// Read-only analytics derived from Claude Code's own session transcripts
// (`~/.claude/projects/**/*.jsonl`), not from the mesa store. Aggregated in
// `core::cc` and surfaced by `mesa cc` (CLI) and `GET /api/cc` (web). All token
// counts are i64 (well within JS safe-integer range); costs are estimated from a
// static per-model price table and are labelled as estimates in the UI.

/// A four-way token split shared by every CC aggregate. `cache_read` is context
/// served from the prompt cache (cheap); `cache_creation` is context written to
/// it (a premium over plain input).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcTokens {
    #[ts(type = "number")]
    pub input: i64,
    #[ts(type = "number")]
    pub output: i64,
    #[ts(type = "number")]
    pub cache_read: i64,
    #[ts(type = "number")]
    pub cache_creation: i64,
}

/// Headline figures for the selected time window.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcOverview {
    /// Distinct Claude Code sessions active in the window.
    #[ts(type = "number")]
    pub sessions: i64,
    /// Calendar days with any activity.
    #[ts(type = "number")]
    pub active_days: i64,
    /// Assistant turns that reported token usage.
    #[ts(type = "number")]
    pub messages: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    /// Estimated spend in USD (static price table; see `core::cc`).
    pub est_cost_usd: f64,
    pub avg_session_minutes: f64,
    pub median_session_minutes: f64,
    pub avg_tokens_per_session: f64,
    /// cache_read / (cache_read + input): how much input was served from cache.
    pub cache_hit_ratio: f64,
    pub first_activity: Option<String>,
    pub last_activity: Option<String>,
}

/// One day's totals (the daily activity series).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcDayPoint {
    /// `YYYY-MM-DD` (UTC).
    pub date: String,
    #[ts(type = "number")]
    pub sessions: i64,
    #[ts(type = "number")]
    pub messages: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// Usage rolled up by model id.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcModelStat {
    pub model: String,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub sessions: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// Usage rolled up by `attributionSkill` — the skill-optimization view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSkillStat {
    pub skill: String,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub sessions: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// Usage rolled up by `attributionAgent` (subagents).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcAgentStat {
    pub agent: String,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub sessions: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// Usage rolled up by working directory (`cwd`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcProjectStat {
    /// Short name (last path component of `cwd`).
    pub project: String,
    /// Full working-directory path (disambiguates same-named folders).
    pub path: String,
    #[ts(type = "number")]
    pub sessions: i64,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// Tool usage rolled up by `(name, caller)` over `tool_use` blocks.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcToolStat {
    pub name: String,
    /// The `tool_use.caller`, verbatim (e.g. `{"type":"direct"}`); null when
    /// the block carried none.
    pub caller: Option<String>,
    #[ts(type = "number")]
    pub calls: i64,
    /// Distinct sessions that made at least one such call.
    #[ts(type = "number")]
    pub sessions: i64,
}

/// One session row for the sessions table.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionRow {
    pub session_id: String,
    /// First/last event timestamps (ISO-8601 UTC, as recorded by Claude Code).
    pub start: String,
    pub end: String,
    pub duration_minutes: f64,
    pub models: Vec<String>,
    #[ts(type = "number")]
    pub messages: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    /// Tool calls made in the window (main thread + subagents).
    #[ts(type = "number")]
    pub tool_calls: i64,
    /// Subagent runs recorded under this session (not window-filtered — runs
    /// have no timestamp of their own).
    #[ts(type = "number")]
    pub agent_runs: i64,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub git_branch: Option<String>,
    pub entrypoint: Option<String>,
    /// True if any of the session's events came from a subagent (`isSidechain`).
    /// Subagent transcripts reuse the parent's `sessionId`, so this is "the
    /// session used a subagent", not "the session *is* a sidechain".
    pub used_subagent: bool,
}

/// The full CC dashboard payload returned by `mesa cc summary` and `GET /api/cc`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcDashboard {
    /// Unix seconds at which this snapshot was computed.
    #[ts(type = "number")]
    pub generated_at_unix: i64,
    /// The requested window token (`7d`/`30d`/`90d`/`all`/`<n>d`).
    pub window: String,
    /// Inclusive cutoff date (`YYYY-MM-DD`), or null for `all`.
    pub since: Option<String>,
    pub overview: CcOverview,
    pub daily: Vec<CcDayPoint>,
    pub models: Vec<CcModelStat>,
    pub skills: Vec<CcSkillStat>,
    pub agents: Vec<CcAgentStat>,
    pub projects: Vec<CcProjectStat>,
    /// Tool-call breakdown by `(name, caller)`, most calls first.
    pub tools: Vec<CcToolStat>,
    /// Sessions newest-first, capped (see `core::cc`); `overview.sessions` holds
    /// the true total.
    pub sessions: Vec<CcSessionRow>,
}

/// One subagent (sidechain) currently running under a live session — surfaced as
/// a concise line under the session's card. Keyed by the transcript `agentId`;
/// `agent`/`skill` come from its `attributionAgent`/`attributionSkill`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcLiveSubagent {
    pub agent_id: String,
    /// Agent type, e.g. "general-purpose" / "Explore" (from `attributionAgent`).
    pub agent: Option<String>,
    /// Skill driving it, when attributed (from `attributionSkill`).
    pub skill: Option<String>,
    pub models: Vec<String>,
    /// This subagent's newest in-window event timestamp (ISO-8601 UTC).
    pub last_activity: String,
    /// Seconds since this subagent's last event (`now - last_event`).
    #[ts(type = "number")]
    pub idle_seconds: i64,
    /// Assistant turns this subagent produced inside the window.
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub total_tokens: i64,
}

/// One currently-running Claude Code session — a session whose newest transcript
/// event lands inside the live window. The `spark` is a per-minute token series
/// (oldest→newest, one entry per bucket of [`CcLive::bucket_seconds`]) so the UI
/// can draw a heartbeat of recent activity.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcLiveSession {
    pub session_id: String,
    /// Short name (last path component of `cwd`).
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub models: Vec<String>,
    /// First/last in-window event timestamps (ISO-8601 UTC).
    pub started: String,
    pub last_activity: String,
    /// Seconds since the last event (`now - last_event`); small ⇒ actively working.
    #[ts(type = "number")]
    pub idle_seconds: i64,
    /// `active` (idle within [`CcLive::active_seconds`]) or `idle`.
    pub status: String,
    /// Assistant turns inside the window.
    #[ts(type = "number")]
    pub messages: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    /// True if any in-window event came from a subagent (`isSidechain`).
    pub used_subagent: bool,
    /// Subagents currently running under this session (active within
    /// [`CcLive::active_seconds`]), most-recently-active first. Rendered as
    /// concise lines under the session card.
    pub subagents: Vec<CcLiveSubagent>,
    /// Per-minute total-token buckets over the window, oldest→newest.
    #[ts(type = "Array<number>")]
    pub spark: Vec<i64>,
}

/// The live-sessions payload (`mesa cc live` / `GET /api/cc/live`): the slice of
/// the CC dashboard restricted to sessions active in the last `window_minutes`.
/// Cheap to compute (skips files whose mtime predates the window) so the UI can
/// poll it on a short interval for a near-real-time view.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcLive {
    /// Unix seconds at which this snapshot was computed.
    #[ts(type = "number")]
    pub generated_at_unix: i64,
    /// Recency window: a session is "live" if its newest event is within this.
    #[ts(type = "number")]
    pub window_minutes: i64,
    /// Width of each `spark` bucket, in seconds.
    #[ts(type = "number")]
    pub bucket_seconds: i64,
    /// A session counts as `active` (vs merely `idle`/live) within this gap.
    #[ts(type = "number")]
    pub active_seconds: i64,
    /// Sessions with an event in the active gap.
    #[ts(type = "number")]
    pub active_count: i64,
    /// Total live sessions (== `sessions.len()`).
    #[ts(type = "number")]
    pub live_count: i64,
    /// Tokens across all live sessions within the window.
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    /// Combined burn rate over the window (`total_tokens / window_minutes`).
    pub tokens_per_min: f64,
    /// Live sessions, active first then most-recent first.
    pub sessions: Vec<CcLiveSession>,
}

/// Live Claude Code subscription usage — the `/usage` data fetched from
/// Anthropic's OAuth usage endpoint (`mesa cc usage` / `GET /api/cc/usage`).
/// Unlike the rest of the CC dashboard, which parses local transcripts, this is
/// a live network read (see `core::usage`). `utilization` is 0–100 percent of
/// the plan limit; `resets_at` is ISO-8601 UTC.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcUsage {
    /// Rolling 5-hour session window.
    pub five_hour: Option<CcUsageWindow>,
    /// Rolling 7-day window (all models).
    pub seven_day: Option<CcUsageWindow>,
    /// Rolling 7-day window scoped to Opus, when the plan meters it separately.
    pub seven_day_opus: Option<CcUsageWindow>,
    /// Rolling 7-day window scoped to Sonnet, when metered separately.
    pub seven_day_sonnet: Option<CcUsageWindow>,
    /// Pay-as-you-go extra-usage credits, when enabled on the plan.
    pub extra_usage: Option<CcUsageExtra>,
    /// Human plan label (e.g. "Max 20x"), from `~/.claude.json`, when known.
    pub plan_tier: Option<String>,
    /// Unix seconds at which this snapshot was fetched.
    #[ts(type = "number")]
    pub fetched_at_unix: i64,
}

/// One rate-limit window: how much of the plan limit is used and when it resets.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcUsageWindow {
    /// Percent of the plan limit consumed (0–100).
    pub utilization: f64,
    /// When the window resets (ISO-8601 UTC), if known.
    pub resets_at: Option<String>,
}

/// Pay-as-you-go extra-usage credit balance.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcUsageExtra {
    pub is_enabled: bool,
    /// Monthly credit cap in `currency`, if set.
    pub monthly_limit: Option<f64>,
    pub used_credits: f64,
    pub currency: String,
}

/// One entry in a storyboard's append-only change history. `actor` is the
/// free-text id of whoever made the change (an agent name or "user"); it is the
/// collaboration record — who did what, when. `action` is a stable machine
/// token (e.g. `frame_added`, `frame_moved`, `edge_added`); `summary` is a
/// human-readable one-liner for the web history view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct StoryboardEvent {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub storyboard_id: i64,
    pub actor: Option<String>,
    pub action: String,
    pub summary: String,
    /// When the change happened (SQLite `datetime` text, UTC).
    pub at: String,
}

/// A file attached to a task. Bytes live on disk (see `core::attachments`),
/// derived from `(task_id, id, filename)` — never a path column to keep in
/// sync. Content bytes never appear in this type (spec req. 21); fetch them
/// via `Store::attachment_bytes`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Attachment {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub task_id: i64,
    pub filename: String,
    /// Best-effort extension-based guess; `None` when unrecognized.
    pub content_type: Option<String>,
    #[ts(type = "number")]
    pub size_bytes: i64,
    /// Free-text attribution of who attached the file.
    pub author: Option<String>,
    /// When the file was attached (SQLite `datetime` text, UTC).
    pub created_at: String,
}

/// One node in a project's file tree, rooted at local_path (see
/// `core::files::tree_of`). `children` is `Some(_)` for every directory
/// (possibly `[]` — empty, excluded, or depth-capped) and `None` for every
/// file — the discriminant IS `is_dir`, `children` is never used to infer it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FileTreeEntry {
    /// Basename.
    pub name: String,
    /// Relative to local_path, "/"-separated.
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeEntry>>,
}

/// `GET /api/projects/{id}/files` response. Ladder mirrors `ProjectGitView`:
/// path null = no local_path; path set + tree null = dead/unreadable folder;
/// path set + tree = Some(_) = live folder (root itself always readable at
/// that point, so this is never Some(vec![]) representing "unreadable" — an
/// unreadable root collapses to the dead-folder rung, same as git's is_dir
/// check). Never an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectFileTree {
    pub path: Option<String>,
    pub tree: Option<Vec<FileTreeEntry>>,
    /// True iff MAX_TREE_ENTRIES or MAX_TREE_DEPTH was hit anywhere during
    /// the walk (one global flag, not per-node — good enough to tell the UI
    /// "this repo is bigger than what you're seeing").
    pub truncated: bool,
}

/// `GET /api/projects/{id}/files/content` response (see `core::files::read_file`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FileContentView {
    pub path: String,
    pub is_binary: bool,
    /// "" when is_binary is true — binary bytes are never put on the wire.
    pub content: String,
    pub truncated: bool,
    /// Extension-derived language tag (e.g. "rs" -> "rust"), or None when
    /// unrecognized. "" is never used in place of None here.
    pub language: Option<String>,
}
