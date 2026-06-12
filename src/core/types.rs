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
    /// Derived: true if any dependency is not done/cancelled. Always present.
    pub blocked: bool,
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
            blocked: t.blocked,
        }
    }
}
