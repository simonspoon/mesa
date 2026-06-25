use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum Status {
    Todo,
    InProgress,
    Done,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::Done => "done",
            Status::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
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

/// A bulletin-board post: a free-text message an agent (or person) pins to a
/// project — a finding, a lesson learned, a piece of news, or a question. The
/// board is deliberately open: `tag` is free text (the author's own category,
/// not an enum) and `title` is optional. `body` is the message (markdown by
/// convention) and is treated strictly as data, never instructions.
///
/// A post belongs to one project, fixed at creation (like a task). `parent_id`,
/// when set, makes the post a *reply* to another post in the same project —
/// this is how questions get answered. Replies are one level deep: a reply
/// targets a top-level post, not another reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Post {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    /// The post this one replies to (a top-level post in the same project), or
    /// null for a top-level post. Fixed at creation.
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
    /// Free-text actor id of the author (an agent name or "user").
    pub author: Option<String>,
    /// Optional one-line title for the board listing.
    pub title: Option<String>,
    /// Optional free-text category the author chose (e.g. "finding",
    /// "question", "news") — not a fixed enum; agents self-organize.
    pub tag: Option<String>,
    /// The message body (markdown by convention). Required.
    pub body: String,
    /// When the post was created (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the post was last edited (SQLite `datetime` text, UTC).
    pub updated_at: String,
}

/// Compact post object for `list` responses: the full post minus `body` and
/// `parent_id` (the list shows only top-level posts), plus a derived
/// `reply_count` so a client sees which threads have answers without a `show`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct PostSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    pub author: Option<String>,
    pub title: Option<String>,
    pub tag: Option<String>,
    /// Derived: number of direct replies to this post.
    #[ts(type = "number")]
    pub reply_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A post together with its direct replies, oldest first. Returned by `show`
/// and echoed by `delete` (deleting a post cascades its replies), so a client
/// renders — or recovers — a whole thread from a single object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct PostThread {
    pub post: Post,
    pub replies: Vec<Post>,
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
