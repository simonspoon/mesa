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
