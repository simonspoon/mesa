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
    /// Hides the project from unscoped views (project list, unscoped task
    /// list/next, sidebar main list) without deleting anything. Flipped via
    /// `Store::archive_project` / `unarchive_project`; every query scoped to
    /// an explicit project id/name is unaffected.
    pub archived: bool,
    /// Manual list position (task 666), the project-level twin of
    /// `Task::sort_order`: `Store::list_projects` orders by it, so the CLI,
    /// the API and the left nav all render one agreed order. Fractional —
    /// a drag writes the midpoint between its new neighbours rather than
    /// renumbering the list, so one drag is one write. Backfilled from `id`,
    /// so an un-dragged install is still in creation order.
    pub sort_order: f64,
    /// Parent project (task 668), or `null` at top level. A pure **grouping**
    /// relation: the left nav renders the result as a tree, and nothing rolls
    /// up — a child keeps its own tasks, storyboards, `root_commit` and
    /// `local_path`. Arbitrary depth; `Store` rejects self-parenting and any
    /// cycle. The one place it changes behaviour beyond display is visibility:
    /// an unscoped read hides a project iff it is archived **or any ancestor
    /// is** (`docs/archiving.md`).
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
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
    /// **mesa-derived, not from the CLI payload** (hence `serde(default)`, so
    /// parsing `claude agents --json` still works): how many shell children
    /// this session's process currently has. Claude Code runs one
    /// `/bin/zsh -c …` child per Bash tool call, so a nonzero count means a
    /// Bash call is in flight *right now* — even when `state` says `done`.
    #[serde(default)]
    pub live_shells: u32,
    /// **mesa-derived, not from the CLI payload.** How many of this session's
    /// subagent transcripts were written within `cc::ACTIVE_SECS`. Subagents
    /// run in-process (no child process), so their jsonl mtimes are the only
    /// available liveness signal.
    #[serde(default)]
    pub live_subagents: u32,
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

/// One configurable agent-spawn command as the Settings page sees it
/// (`core::config`, `docs/config.md`). Not stored in the db — this is a view
/// of `~/.mesa/config.json`, which is read fresh on every spawn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigCommand {
    /// The config key: `todo-watcher`, `inbox-watcher` or `agent-spawn`.
    pub action: String,
    /// The configured template, or `null` when the key is absent or blank.
    /// Null is "falling back to `default`", never "run nothing".
    pub value: Option<String>,
    /// The built-in template used while `value` is null.
    pub default: String,
    /// The `{}`-delimited placeholders this action offers. Any other one is a
    /// save-time error, so the editor can list these as the whole vocabulary.
    /// Substituted in single-line (argv) mode only.
    pub placeholders: Vec<String>,
    /// The environment variables this action sets when the value is a
    /// **multi-line script** (`bash -c`), positionally matching
    /// `placeholders` — a script reads `$MESA_NAME`, never `{name}`. A
    /// variable with no value on a given call is left unset.
    pub env_vars: Vec<String>,
}

/// One model family's rates, USD per **1M tokens**. All four are explicit —
/// mesa never derives a cache rate from the input rate, because the
/// relationship is a pricing convention, not arithmetic mesa gets to assume.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ModelRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// One model-family price row as the Settings page sees it (`core::config`,
/// `docs/config.md`). Like [`ConfigCommand`] this is a view of
/// `~/.mesa/config.json`, not db state, and the same null-means-fallback rule
/// applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigPrice {
    /// The model-family **prefix**, matched with `starts_with` against a
    /// transcript's model id (`claude-opus`, `claude-opus-5-mini`, …).
    pub prefix: String,
    /// The configured rates, or `null` when the prefix is absent from the
    /// config — then `default` is what applies.
    pub value: Option<ModelRates>,
    /// The built-in rates behind this prefix, or `null` for a prefix the user
    /// added that the binary knows nothing about (then `value` is the only
    /// thing keeping the row alive, and clearing it deletes the row).
    pub default: Option<ModelRates>,
}

/// The watcher settings as the Settings page sees them (`core::config`,
/// `docs/config.md`, mesa task 777). A third view of `~/.mesa/config.json`
/// beside [`ConfigCommand`] and [`ConfigPrice`], with the same
/// null-means-fallback rule: an absent value is the built-in default, and
/// writing `null` back is how the user restores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigWatchers {
    /// How many watcher agents the todo-watcher may have running per project,
    /// or `null` when the config says nothing — then `todo_concurrency_default`
    /// is what applies.
    pub todo_concurrency: Option<u32>,
    /// The built-in limit mesa ships (1), so the editor can show what blank
    /// means without hardcoding it.
    pub todo_concurrency_default: u32,
}

/// The speech settings as the Settings page sees them (`core::config`,
/// `docs/config.md`, mesa task 822) — a fourth view of `~/.mesa/config.json`,
/// with the same null-means-fallback rule as [`ConfigWatchers`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigSpeech {
    /// The configured voice for the inbox's play button, or `null` when the
    /// config says nothing — then the synthesiser's own default applies and
    /// mesa passes no `-v` at all.
    pub voice: Option<String>,
    /// Every voice the installed `kokoro-rs` reports (`--list-voices`), so the
    /// editor can offer a list. **Empty means mesa could not ask** — a missing
    /// or uncooperative binary — never "there are no voices", so an empty list
    /// is a reason to accept a typed name, not to refuse one.
    pub voices: Vec<String>,
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

/// `GET /api/projects/{id}/version`: the version of the app in a project's
/// `local_path`, read out of its package manifest (`core::version`). Derived
/// on every read, never stored. Both fields are `None` — the quiet empty
/// shape, never an error — when there is no folder or no usable manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectVersion {
    pub version: Option<String>,
    /// The bare manifest filename the version came from, e.g. "Cargo.toml".
    pub source: Option<String>,
}

/// `GET /api/version`: the running binary's own version
/// (`CARGO_PKG_VERSION`), shown under the wordmark in the app header.
/// Unrelated to `ProjectVersion` above, which reads a *project's* manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct MesaVersion {
    pub version: String,
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

/// One entry from `git worktree list --porcelain` (see
/// `core::git::worktrees_of`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GitWorktree {
    /// Absolute path of this worktree's checkout.
    pub path: String,
    /// Checked-out branch name; None when detached.
    pub branch: Option<String>,
    /// HEAD commit, full sha.
    pub head: String,
    /// True for the worktree at the project's own `local_path` — the one
    /// mesa is anchored to, highlighted in the UI as "current".
    pub is_current: bool,
}

/// `GET /api/projects/{id}/git` response. Mirrors ProjectAgents' empty-state
/// pattern: path null = no local_path; path set + repo null = folder gone
/// or not a git repo. Never an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectGitView {
    pub path: Option<String>,
    pub repo: Option<GitRepoView>,
    /// All worktrees of this repo (from `local_path`, regardless of which
    /// one `repo` currently reflects — see `?worktree=` on this route).
    /// None alongside `repo: None` (no repo to list worktrees of).
    pub worktrees: Option<Vec<GitWorktree>>,
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
///
/// `null` when the spawn command printed no `backgrounded · <id>` receipt —
/// possible since the command is user-configurable (`core::config`), and not
/// an error: the session started, mesa just can't pre-open an attach pane for
/// it. Clients must treat a null id as "created, discover it in the session
/// list", never as a failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct AgentSpawned {
    pub id: Option<String>,
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
    /// Derived display label, never stored — the same posture as `blocked`:
    /// computed on every read from `description` by [`task_name`]. This is
    /// what the board card, the task list and every agent session name show,
    /// so a task has exactly one identity string and it always agrees with
    /// the body it was cut from (task 660, which removed the stored `title`).
    pub name: String,
    /// The task itself, in free text. Required and non-empty: since task 660
    /// removed `title`, this *is* the task's identity — its first line is
    /// what [`task_name`] shows.
    pub description: String,
    pub status: Status,
    pub priority: Priority,
    pub tags: Vec<String>,
    /// Definition-of-done for this task; free text, unstructured.
    pub acceptance: Option<String>,
    /// Free-text receipt of completed work (commit SHA / PR URL / path).
    pub artifact: Option<String>,
    /// Free-text final summary the agent writes when the task is done;
    /// unlike `artifact` (a pointer), this holds the narrative itself.
    pub result: Option<String>,
    /// When the task row was inserted (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the task row was last updated (SQLite `datetime` text, UTC).
    pub updated_at: String,
    /// Manual board order (spec 328): compared across the whole table (not
    /// per-status), so a task keeps its relative position when its status
    /// changes. Not a dense rank — a sortable value; ties break on `id`.
    pub sort_order: f64,
    /// Who currently holds the task (task 563): an opaque caller-supplied
    /// identifier — for an agent, its Claude Code session id, so a reader can
    /// check liveness out-of-band (`ps aux | grep "claude attach <owner>"`)
    /// instead of guessing from `updated_at`. Null when unclaimed; cleared
    /// automatically when the task leaves `in_progress`.
    pub owner: Option<String>,
    /// When the current claim was taken or last renewed (SQLite `datetime`
    /// text, UTC). Unlike `updated_at` it moves ONLY on claim/renew, never on
    /// an ordinary field write — that is the whole point of the pair.
    pub claimed_at: Option<String>,
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

/// Compact task object for `list` responses (Requirement 6), and the `--quiet`
/// task shape: the full object minus the unbounded free-text bodies
/// (`description`, `result`) and `created_at`.
///
/// It stays identifiable without `description` because `name` is a *bounded
/// derivation* of it ([`task_name`], 50 chars) — that is what replaced the
/// stored `title` this projection used to carry (task 660).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct TaskSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
    /// Derived display label; see `Task::name`. Bounded (50 chars), which is
    /// why it survives into the compact shape while `description` does not.
    pub name: String,
    pub status: Status,
    pub priority: Priority,
    pub tags: Vec<String>,
    /// Definition-of-done, surfaced in `list` so agents see it without `show`.
    pub acceptance: Option<String>,
    /// Completion pointer (SHA / PR URL / path); see `Task::artifact`. Bounded,
    /// so it stays in the compact shape — an agent closing a task with
    /// `--artifact <sha> --quiet` gets the value it just wrote echoed back
    /// instead of a misleading `null` (spec 651).
    pub artifact: Option<String>,
    /// Manual board order (spec 328); see `Task::sort_order`.
    pub sort_order: f64,
    /// When the task row was last updated (SQLite `datetime` text, UTC); the
    /// Done board column sorts on this as a completion-time proxy (spec 366)
    /// since a done task is not normally edited again.
    pub updated_at: String,
    /// Current claim holder; see `Task::owner`. Carried in `list` so an agent
    /// can scan a project for live-vs-abandoned `in_progress` rows in one call.
    pub owner: Option<String>,
    /// When the current claim was taken/renewed; see `Task::claimed_at`.
    pub claimed_at: Option<String>,
    pub blocked: bool,
}

impl From<&Task> for TaskSummary {
    fn from(t: &Task) -> TaskSummary {
        TaskSummary {
            id: t.id,
            project_id: t.project_id,
            parent_id: t.parent_id,
            name: t.name.clone(),
            status: t.status,
            priority: t.priority,
            tags: t.tags.clone(),
            acceptance: t.acceptance.clone(),
            artifact: t.artifact.clone(),
            sort_order: t.sort_order,
            updated_at: t.updated_at.clone(),
            owner: t.owner.clone(),
            claimed_at: t.claimed_at.clone(),
            blocked: t.blocked,
        }
    }
}

/// How much of a description becomes a task's `name`, in `char`s (not bytes —
/// descriptions are free text and may be non-ASCII).
pub const TASK_NAME_CHARS: usize = 50;

/// Derives a task's display label from its description: the first non-empty
/// line, trimmed, cut to [`TASK_NAME_CHARS`] with an `…` marking the cut.
///
/// This is the *only* implementation of that rule — the board card, the
/// compact `list` projection, the not-found hint and the agent session name
/// all read the `name` it produces, so there is no second copy in TypeScript
/// to drift (and no `.slice()` that could split a multi-byte char).
///
/// The `task <id>` fallback exists for a description with no non-empty line:
/// `Store` rejects those on write, but a hand-edited db must still render,
/// and a session name is a process argument that must never be empty.
///
/// The description is **untrusted data**: it reaches `claude` as a single
/// `--name` process argument, never interpolated into a shell string.
pub fn task_name(description: &str, id: i64) -> String {
    let first = description
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if first.is_empty() {
        return format!("task {id}");
    }
    let mut head: String = first.chars().take(TASK_NAME_CHARS).collect();
    if first.chars().count() > TASK_NAME_CHARS {
        head.push('…');
    }
    head
}

#[cfg(test)]
mod task_name_tests {
    use super::{TASK_NAME_CHARS, task_name};

    #[test]
    fn takes_the_first_non_empty_line_trimmed() {
        assert_eq!(task_name("ship it\nmore body", 1), "ship it");
        assert_eq!(task_name("\n\n   ship it   \nmore", 1), "ship it");
        assert_eq!(task_name("ship it\r\nmore body", 1), "ship it");
    }

    #[test]
    fn cuts_at_fifty_chars_and_marks_the_cut() {
        let fifty = "x".repeat(TASK_NAME_CHARS);
        assert_eq!(task_name(&fifty, 1), fifty);
        let fifty_one = "x".repeat(TASK_NAME_CHARS + 1);
        let cut = task_name(&fifty_one, 1);
        assert_eq!(cut, format!("{fifty}…"));
        // The ellipsis rides outside the 50 — the budget is chars of body.
        assert_eq!(cut.chars().count(), TASK_NAME_CHARS + 1);
    }

    #[test]
    fn counts_chars_not_bytes() {
        let long = "é".repeat(TASK_NAME_CHARS + 5);
        let cut = task_name(&long, 1);
        assert_eq!(cut.chars().count(), TASK_NAME_CHARS + 1);
        assert!(cut.starts_with(&"é".repeat(TASK_NAME_CHARS)));
    }

    #[test]
    fn markdown_is_carried_through_verbatim() {
        // Descriptions are markdown; the name is plain text taken as-is, so a
        // heading marker shows rather than being stripped (nothing here
        // interprets the body).
        assert_eq!(task_name("# Refactor\n\nbody", 1), "# Refactor");
    }

    #[test]
    fn falls_back_to_the_id_when_there_is_no_line() {
        assert_eq!(task_name("", 7), "task 7");
        assert_eq!(task_name("   \n\t\n", 7), "task 7");
    }
}

/// A storyboard's diagram style, chosen at creation and immutable thereafter
/// (no field on `StoryboardPatch` — the same structural-immutability posture
/// as `project_id`/`author`). Picks the shape set offered for its frames: a
/// `storyboard` board takes the generic frame card, a `flowchart` board takes
/// `process`/`decision`/`start_end` node shapes, an `erd` board takes only the
/// `entity` shape, and a `brainstorm` board takes `central`/`idea` mind-map
/// shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum DiagramType {
    Storyboard,
    Flowchart,
    Erd,
    Brainstorm,
}

impl DiagramType {
    pub fn as_str(self) -> &'static str {
        match self {
            DiagramType::Storyboard => "storyboard",
            DiagramType::Flowchart => "flowchart",
            DiagramType::Erd => "erd",
            DiagramType::Brainstorm => "brainstorm",
        }
    }

    pub fn parse(s: &str) -> Option<DiagramType> {
        match s {
            "storyboard" => Some(DiagramType::Storyboard),
            "flowchart" => Some(DiagramType::Flowchart),
            "erd" => Some(DiagramType::Erd),
            "brainstorm" => Some(DiagramType::Brainstorm),
            _ => None,
        }
    }
}

/// A frame's node shape, chosen at creation and immutable thereafter (no
/// field on `FramePatch` — mirrors `DiagramType`'s posture, for the same
/// reason: a board should never hold a shape from the "wrong" type system).
/// `None` on `Frame.shape` means the generic card, valid only on a
/// `storyboard`-type board; `Store::create_frame` validates a given shape
/// against the parent board's `DiagramType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum FrameShape {
    Process,
    Decision,
    StartEnd,
    Entity,
    Central,
    Idea,
}

impl FrameShape {
    pub fn as_str(self) -> &'static str {
        match self {
            FrameShape::Process => "process",
            FrameShape::Decision => "decision",
            FrameShape::StartEnd => "start_end",
            FrameShape::Entity => "entity",
            FrameShape::Central => "central",
            FrameShape::Idea => "idea",
        }
    }

    pub fn parse(s: &str) -> Option<FrameShape> {
        match s {
            "process" => Some(FrameShape::Process),
            "decision" => Some(FrameShape::Decision),
            "start_end" => Some(FrameShape::StartEnd),
            "entity" => Some(FrameShape::Entity),
            "central" => Some(FrameShape::Central),
            "idea" => Some(FrameShape::Idea),
            _ => None,
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
    /// The board's diagram style, fixed at creation (see `DiagramType`).
    pub diagram_type: DiagramType,
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
    /// The frame's node shape, fixed at creation, validated against the
    /// board's `diagram_type` (see `FrameShape`). `None` is the generic card.
    pub shape: Option<FrameShape>,
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

/// Which side of a frame a `FrameEdge` endpoint is locked to, when locked at
/// all. Shares its four lowercase string values with React Flow's own
/// `Position` enum, so a value read off `FrameEdge.from_anchor`/`to_anchor`
/// casts directly into a `Position` prop with no translation table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum AnchorSide {
    Top,
    Right,
    Bottom,
    Left,
}

impl AnchorSide {
    pub fn as_str(self) -> &'static str {
        match self {
            AnchorSide::Top => "top",
            AnchorSide::Right => "right",
            AnchorSide::Bottom => "bottom",
            AnchorSide::Left => "left",
        }
    }

    pub fn parse(s: &str) -> Option<AnchorSide> {
        match s {
            "top" => Some(AnchorSide::Top),
            "right" => Some(AnchorSide::Right),
            "bottom" => Some(AnchorSide::Bottom),
            "left" => Some(AnchorSide::Left),
            _ => None,
        }
    }
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
    /// Side of `from_frame` this edge is locked to, if any. `None` means
    /// floating — routing picks the nearest side live, exactly today's
    /// behavior.
    pub from_anchor: Option<AnchorSide>,
    /// Side of `to_frame` this edge is locked to, if any. Same contract as
    /// `from_anchor`, independent per endpoint.
    pub to_anchor: Option<AnchorSide>,
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

// ---- scripts (user-authored shell) ----
//
// A script is user *data* with CRUD and a project binding, stored in the
// `scripts` table — deliberately not a `~/.mesa/config.json` section, which is
// reserved for hand-edited settings. Its arguments are **declared**, never
// parsed out of the body: the form the web UI renders and the validation the
// run path applies both read this list, so a body full of `$1`/`${FOO}` can
// never make the form silently wrong. Execution passes the body to `bash -c`
// verbatim and supplies values positionally and through the environment, so no
// value is ever interpolated into a string a shell parses (`core::scripts`).

/// What kind of value a [`ScriptArg`] accepts. Exactly four kinds — the form
/// renders one control per kind and the run path validates against it, so a
/// fifth kind is a change to both surfaces, never a free addition here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum ScriptArgKind {
    Text,
    Number,
    Bool,
    Choice,
}

impl ScriptArgKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScriptArgKind::Text => "text",
            ScriptArgKind::Number => "number",
            ScriptArgKind::Bool => "bool",
            ScriptArgKind::Choice => "choice",
        }
    }

    pub fn parse(s: &str) -> Option<ScriptArgKind> {
        match s {
            "text" => Some(ScriptArgKind::Text),
            "number" => Some(ScriptArgKind::Number),
            "bool" => Some(ScriptArgKind::Bool),
            "choice" => Some(ScriptArgKind::Choice),
            _ => None,
        }
    }
}

/// One declared argument of a [`Script`]. Every value crossing into the shell
/// is a string: `Number` and `Bool` describe the *control* and the validation,
/// not a parsed Rust type, so a half-typed value survives a keystroke in the
/// form and the run path has exactly one representation to pass along.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ScriptArg {
    /// Identifier: `^[A-Za-z_][A-Za-z0-9_-]*$`, ≤64 chars, unique within the
    /// script. Constrained because it becomes an `MESA_ARG_*` env-var suffix.
    pub name: String,
    /// Human label for the form; the `name` is used when absent.
    pub label: Option<String>,
    pub kind: ScriptArgKind,
    pub required: bool,
    /// Fills in for an absent optional argument at run time.
    pub default: Option<String>,
    /// Required and non-empty for `Choice`, and `None` for every other kind.
    pub choices: Option<Vec<String>>,
}

/// A user-authored shell script stored in mesa, run from the web UI's
/// generated form or from `mesa script run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Script {
    #[ts(type = "number")]
    pub id: i64,
    /// The project this script belongs to, or null for a global script. Also
    /// the run's working directory (the project's `local_path`; `$HOME` when
    /// null). Deleting the project un-binds rather than destroys the script —
    /// the FK is `ON DELETE SET NULL`, as the inbox's is.
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    /// Unique (case-insensitively), non-empty: the CLI resolves a script by id
    /// **or** name.
    pub name: String,
    pub description: Option<String>,
    /// The shell source, handed to `bash -c` verbatim. Required, non-empty.
    pub body: String,
    /// Declared arguments, in the order they reach the body as `$1`, `$2`, …
    pub args: Vec<ScriptArg>,
    pub created_at: String,
    pub updated_at: String,
}

/// The captured outcome of one script run — the [`HookRun`] twin. A nonzero
/// `exit_code` is the script's own result, not a transport failure: the CLI
/// exits 0 and the API returns 200 with this object either way. Runs are not
/// persisted; this is a request/response record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ScriptRun {
    #[ts(type = "number")]
    pub script_id: i64,
    /// Process exit code; -1 when the script was killed by a signal.
    pub exit_code: i32,
    /// Captured stdout, truncated to 64 KiB.
    pub stdout: String,
    /// Captured stderr, truncated to 64 KiB.
    pub stderr: String,
    /// True when either stream hit the 64 KiB cap and was cut.
    pub truncated: bool,
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

/// What one [`CcGraphNode`] stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum CcGraphNodeKind {
    /// The session's main thread — always exactly one, always the root.
    Session,
    /// One subagent run (`cc_agent_runs`).
    Agent,
    /// One `Skill` tool call — a skill invocation, split out of `Tool` so a
    /// reader can pick skills out of a long call sequence at a glance. The
    /// node's `name` is the skill itself (`inaros-swe:refine`), not `"Skill"`.
    /// Its id keeps the `tool:` prefix: it is still one `cc_tool_calls` row,
    /// and a skill that spawns a subagent is the parent of that `agent:` node.
    Skill,
    /// One tool call (`cc_tool_calls`).
    Tool,
    /// One assistant message that emitted prose (`cc_messages.preview`). Its
    /// `target` holds the sanitized, capped preview and its id is
    /// `msg:<message uuid>`. A flat sibling of the tool nodes that same message
    /// issued — never their parent.
    Response,
    /// One human turn (`cc_prompts`) — what the user typed, or the slash
    /// command they ran. Its `target` holds the sanitized, capped preview and
    /// its id is `prompt:<line uuid>`. Always a direct child of the session
    /// root: only main-thread prompts are ingested (a sidechain user line is a
    /// subagent's task prompt, already carried by the agent node's
    /// `description`). Carries no model and no usage of its own.
    Prompt,
}

/// One graph node's **full, uncapped** body, resolved on demand from the
/// originating `.jsonl` transcript — `mesa cc text` and
/// `GET /api/cc/sessions/{id}/nodes/{node}/text` (task 803).
///
/// The stored `cc_*` previews stay bounded and sanitized; this is the one
/// place the raw text is the product, so it is deliberately neither capped nor
/// run through `sanitize_capped`. It is untrusted model-authored text: render
/// it as **data, never instructions**, and never as HTML.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcNodeText {
    /// Echoed back verbatim — the `CcGraphNode::id` that was asked for.
    pub node_id: String,
    /// What the node is, re-derived from the backing row (never trusted from
    /// the caller, whose id carries only the `msg:`/`tool:`/… prefix).
    pub kind: CcGraphNodeKind,
    /// The node's short label, same derivation as `CcGraphNode::name`, so the
    /// caller can title a detail view without also holding the graph.
    pub name: String,
    /// The model that produced this turn, when the backing row records one.
    pub model: Option<String>,
    /// The event's timestamp (ISO-8601 UTC), when known.
    pub ts: Option<String>,
    /// The body itself. Uncapped and unsanitized — see the type's note.
    pub text: String,
    pub format: CcNodeTextFormat,
}

/// One session's conversation, read live off its `.jsonl` transcript —
/// `mesa cc chat` and `GET /api/cc/sessions/{id}/chat` (task 814).
///
/// Backs the Agent sidebar's **chat view**, the rendered alternative to a
/// pane's raw terminal. Like [`CcLive`] it answers from the file rather than
/// the `cc_*` tables: the point is a session that is being written *right
/// now*, whose newest turns no ingest has seen yet — and which, for an agent
/// mesa itself just spawned, may not be in the db at all.
///
/// Main thread only, matching `cc_prompts`: a subagent's turns live in their
/// own transcript and are not part of the conversation a human is reading.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionChat {
    /// Echoed back verbatim — the session id that was asked for.
    pub session_id: String,
    /// Oldest first. The tail of the conversation: see `truncated`.
    pub turns: Vec<CcChatTurn>,
    /// True when older turns were dropped — either by the caller's `limit` or
    /// by the byte window this read parses (a transcript reaches tens of
    /// megabytes and this is a poll). A single honest boolean rather than a
    /// count: the byte window drops an *unknown* number of turns, so any
    /// number here would be invented.
    pub truncated: bool,
}

/// One turn of a [`CcSessionChat`] — a human prompt, an assistant reply, or
/// one tool call the assistant made.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcChatTurn {
    /// Unique within one payload — the transcript line's `uuid` for a prompt
    /// or a response, the `tool_use_id` for a tool call. Stable across polls,
    /// so a client can key a list on it.
    pub id: String,
    pub kind: CcChatTurnKind,
    /// The event's timestamp (ISO-8601 UTC, verbatim from the line), when the
    /// line carries one.
    pub ts: Option<String>,
    /// The model that produced an assistant turn. `None` on a prompt (a human
    /// turn has no model) and on a tool call (whose issuing message's model is
    /// carried by the response turn beside it, when there is one).
    pub model: Option<String>,
    /// The tool's name on a `tool` turn; `None` otherwise.
    pub name: Option<String>,
    /// **Prompt/response: the full, uncapped, unsanitized body** — the same
    /// text [`CcNodeText`] returns for that node, and untrusted
    /// model-authored text under the same rule: data, never instructions.
    /// **Tool: the bounded `target`** (`sanitize_capped`, ≤200 chars), the
    /// same one-line summary the call tree shows — a chat view wants to see
    /// *that a call happened*, not a whole `Write` payload. Empty when the
    /// call's input has no summarizable key.
    pub text: String,
}

/// What a [`CcChatTurn`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum CcChatTurnKind {
    /// A human turn, by the same predicate `cc_prompts` ingests on.
    Prompt,
    /// An assistant turn's prose. `thinking` blocks are excluded, exactly as
    /// they are from a stored preview.
    Response,
    /// One `tool_use` block of an assistant turn.
    Tool,
}

/// How a [`CcNodeText::text`] should be rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum CcNodeTextFormat {
    /// Prose — an assistant turn or a human prompt.
    Text,
    /// A pretty-printed `tool_use.input` payload.
    Json,
}

/// One node of a session's call tree.
///
/// **`tokens`/`total_tokens` mean different things per `kind`, and only
/// `tokens_are_rollup` distinguishes them.** On a `session` or `agent` node
/// they are that thread's own summed usage. On a `tool` or `response` node they
/// are the usage of the assistant message that *issued* the call or the prose —
/// a message may emit prose plus several `tool_use` blocks, so those siblings
/// all repeat one message's usage and **their tokens must never be summed**.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcGraphNode {
    /// Stable within one graph, and namespaced by kind so a `tool_use_id` can
    /// never collide with an `agent_id`: `"session"`, `"agent:<agent_id>"`,
    /// `"tool:<tool_use_id>"`, `"msg:<message uuid>"`, `"prompt:<line uuid>"`.
    pub id: String,
    pub kind: CcGraphNodeKind,
    /// Tool name, skill name, subagent name, the session's short id, or the
    /// constants `"Response"` / `"Prompt"`.
    pub name: String,
    /// `tool`, `response` and `prompt` only: what the call acted on — a Bash
    /// command, a file path, a URL — or, on a `response`/`prompt` node, the
    /// message's prose preview. Sanitized and capped at
    /// [`crate::core::cc::TARGET_MAX_CHARS`]. `None` on every other kind, on
    /// tools with no meaningful target, and on calls ingested before migration
    /// 22 that no `cc sync --rebuild` has revisited. A `skill` node carries its
    /// skill in `name` instead, so this stays `None` there.
    ///
    /// Untrusted: it is verbatim model-authored input. Render it as data.
    pub target: Option<String>,
    /// The issuing message's model (`tool`/`response`), or the thread's
    /// most-used model (`session`/`agent`). `None` when no usage-carrying
    /// message backs it.
    pub model: Option<String>,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    /// True when `tokens` is this node's own rolled-up usage (`session`,
    /// `agent`); false on a `tool` or `response` node — see the type-level
    /// note.
    pub tokens_are_rollup: bool,
    pub est_cost_usd: f64,
    /// First event timestamp (ISO-8601 UTC), when known.
    pub ts: Option<String>,
    /// `agent` only: the run's attributed skill.
    pub skill: Option<String>,
    /// `agent` only: the spawning call's one-line description (sidecar).
    pub description: Option<String>,
    /// `agent` only: 1 for a main-thread spawn, 2+ when nested (sidecar).
    #[ts(type = "number | null")]
    pub spawn_depth: Option<i64>,
    /// `session`/`agent` only: usage-carrying messages in that thread.
    #[ts(type = "number")]
    pub messages: i64,
    /// `session`/`agent` only: tool calls made directly by that thread.
    #[ts(type = "number")]
    pub tool_calls: i64,
    /// `tool` only: the `tool_use.caller`, verbatim.
    pub caller: Option<String>,
}

/// A parent→child edge in the call tree: session→tool, tool→agent (the
/// spawning `Task` call), agent→tool.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcGraphEdge {
    pub from: String,
    pub to: String,
}

/// One session's call tree — `GET /api/cc/sessions/{id}/graph` and
/// `mesa cc graph <SESSION_ID>`. Always a tree: every node but the root has
/// exactly one parent, so a client can lay it out without cycle-breaking.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionGraph {
    pub session_id: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub git_branch: Option<String>,
    /// Session span (ISO-8601 UTC), when known.
    pub start: Option<String>,
    pub end: Option<String>,
    /// Whole-session rolled-up usage — the honest total, since tool-node
    /// tokens are not additive.
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    /// Root first, then the rest oldest-first.
    pub nodes: Vec<CcGraphNode>,
    pub edges: Vec<CcGraphEdge>,
    /// True when `limit` dropped tool, response **or** prompt nodes. Subagent
    /// nodes and the tool calls that spawned them are never dropped, so the
    /// tree stays connected.
    pub truncated: bool,
    /// How many tool nodes were dropped.
    #[ts(type = "number")]
    pub omitted_tool_calls: i64,
    /// How many response nodes were dropped by `limit`. Budgeted separately
    /// from tool calls, so `omitted_tool_calls` keeps counting tool calls only.
    #[ts(type = "number")]
    pub omitted_responses: i64,
    /// How many prompt nodes were dropped by `limit`. A third independent
    /// budget, for the same reason responses got the second one: prompts are
    /// their own unbounded population, so riding either existing budget would
    /// make that budget's counter report something other than what it names.
    #[ts(type = "number")]
    pub omitted_prompts: i64,
}

/// One session's aggregate detail — `GET /api/cc/sessions/{id}` and
/// `mesa cc session <ID>`, the default drill-down from the sessions table.
///
/// Aggregated server-side over **every** persisted row, deliberately not
/// derived from [`CcSessionGraph`]: that payload caps its tool nodes, and its
/// tool/response nodes repeat their issuing message's usage, so neither an
/// exact per-tool count nor a token-over-time series is recoverable from it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionDetail {
    pub session_id: String,
    pub cwd: Option<String>,
    /// Short name (last path component of `cwd`), same derivation as
    /// [`CcSessionRow`].
    pub project: Option<String>,
    pub git_branch: Option<String>,
    pub entrypoint: Option<String>,
    /// Session span (ISO-8601 UTC), when known.
    pub start: Option<String>,
    pub end: Option<String>,
    pub duration_minutes: f64,
    pub used_subagent: bool,
    /// Whole-session rollup: main thread + every subagent.
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub tool_calls: i64,
    /// Subagent runs recorded under this session.
    #[ts(type = "number")]
    pub agent_runs: i64,
    /// The main thread alone — the half of the rollup that is not subagents.
    pub main: CcSessionThreadStat,
    /// One entry per subagent thread, `total_tokens` desc (`agent_id` asc ties).
    pub agents: Vec<CcSessionThreadStat>,
    pub models: Vec<CcSessionModelStat>,
    pub tools: Vec<CcSessionToolStat>,
    pub skills: Vec<CcSessionSkillStat>,
    /// Evenly-sized buckets over the session span; see
    /// [`crate::core::cc::ACTIVITY_BUCKETS`].
    pub activity: Vec<CcSessionBucket>,
}

/// One thread of a session: the main thread (`agent_id: None`) or one subagent.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionThreadStat {
    /// `None` = the main thread.
    pub agent_id: Option<String>,
    /// Agent type / skill / spawn description, from `cc_agent_runs`. All `None`
    /// for a thread seen only in messages or tool calls (no run row).
    ///
    /// Untrusted transcript text — render as data.
    pub agent: Option<String>,
    pub skill: Option<String>,
    pub description: Option<String>,
    #[ts(type = "number | null")]
    pub spawn_depth: Option<i64>,
    /// The thread's most-used model.
    pub model: Option<String>,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub tool_calls: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
    /// First/last event in this thread (ISO-8601 UTC), when known.
    pub start: Option<String>,
    pub end: Option<String>,
}

/// One session's usage rolled up by model id.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionModelStat {
    pub model: String,
    #[ts(type = "number")]
    pub messages: i64,
    pub tokens: CcTokens,
    #[ts(type = "number")]
    pub total_tokens: i64,
    pub est_cost_usd: f64,
}

/// One session's tool calls rolled up by tool **name** only — never by
/// `target`, so a Bash tool is one row rather than one row per command.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionToolStat {
    /// Untrusted transcript text — render as data.
    pub name: String,
    #[ts(type = "number")]
    pub calls: i64,
    /// Of `calls`, those made by a subagent (non-null `agent_id`).
    #[ts(type = "number")]
    pub subagent_calls: i64,
}

/// One session's `Skill` invocations, keyed by the skill itself (the call's
/// `target`) — the same promotion the call tree does.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionSkillStat {
    /// Untrusted transcript text — render as data.
    pub name: String,
    #[ts(type = "number")]
    pub calls: i64,
}

/// One bucket of the activity series. Messages are the atoms and their usage is
/// additive, so these token counts are honest sums (unlike a graph node's).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcSessionBucket {
    /// The bucket's left edge (ISO-8601 UTC).
    pub start: String,
    #[ts(type = "number")]
    pub messages: i64,
    #[ts(type = "number")]
    pub tool_calls: i64,
    #[ts(type = "number")]
    pub total_tokens: i64,
    #[ts(type = "number")]
    pub output_tokens: i64,
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

/// One entry in a single directory level of a project's file tree, rooted at
/// local_path (see `core::files::tree_level`). Lazy tree walk (mesa task
/// 410): a response only ever carries ONE level — no `children` field,
/// unlike the whole-tree walk this replaced. A directory's own contents are
/// fetched by a separate call passing this entry's `path` as `?path=`; the
/// frontend tracks "not yet fetched" itself, off the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FileTreeEntry {
    /// Basename.
    pub name: String,
    /// Relative to local_path, "/"-separated.
    pub path: String,
    pub is_dir: bool,
}

/// `GET /api/projects/{id}/files[?path=<rel>]` response — one directory
/// level: `local_path` itself when `path` is omitted, else the subdirectory
/// `path` resolves to. Ladder mirrors `ProjectGitView`, and only applies to
/// the root call (`path` omitted): tree null = no local_path; path set +
/// tree null = dead/unreadable folder; path set + tree = Some(_) = live
/// folder (root itself always readable at that point, so this is never
/// Some(vec![]) representing "unreadable" — an unreadable root collapses to
/// the dead-folder rung, same as git's is_dir check). A `path`-scoped call
/// for an invalid/traversal/nonexistent subdirectory is a 404, not a rung of
/// this ladder. Never a 5xx.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectFileTree {
    pub path: Option<String>,
    pub tree: Option<Vec<FileTreeEntry>>,
    /// True iff MAX_TREE_ENTRIES was hit for THIS level (a per-directory
    /// cap now, not a whole-tree flag — a single flat directory with more
    /// entries than the cap is still capped; laziness alone doesn't solve
    /// that).
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

/// One hit in a project-wide file search (mesa task 813, see
/// `core::files::search_files`) — one *match*, not one line: a line holding
/// two hits produces two of these, the way every editor's search panel lists
/// them.
///
/// The match's own offsets are deliberately NOT on the wire. `text` is a
/// snippet shaped server-side (leading indentation dropped, windowed around
/// the match, `…` marking either cut), and the panel re-runs the same literal
/// scan over it to paint the highlight — the client already owns that scan
/// (`fileFind.ts`, the in-file find bar), and a char offset computed in Rust
/// is not a UTF-16 offset in JS. The worst a disagreement can do is leave a
/// row unhighlighted, never mislocate the result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FileSearchMatch {
    /// 1-based line number, counted over the same capped bytes
    /// [`FileContentView`] carries — so opening the file and revealing this
    /// line can never point past what the viewer will show.
    pub line: u32,
    /// The snippet to paint. Never the raw line: see the type doc.
    pub text: String,
}

/// One file's hits in a project-wide file search (mesa task 813).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FileSearchFile {
    /// Relative to local_path, "/"-separated — the same path shape
    /// [`FileTreeEntry`] uses, so a result opens through the existing content
    /// route unchanged.
    pub path: String,
    /// Extension-derived language tag, same table as [`FileContentView`] —
    /// the panel tints a result group with it exactly as the tree tints a row.
    pub language: Option<String>,
    pub matches: Vec<FileSearchMatch>,
    /// True iff this file holds more matches than were returned.
    pub truncated: bool,
}

/// `GET /api/projects/{id}/files/search?q=` response (mesa task 813, see
/// `core::files::search_files`). Unlike [`ProjectFileTree`] there is no
/// empty-state ladder: no `local_path` / dead folder is 404 `not_found`, the
/// content route's precedent, because a search is a request about a specific
/// root rather than a description of the project's state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ProjectFileSearch {
    /// Files with at least one hit, in walk order (directories before files,
    /// alphabetical within each — [`FileTreeEntry`]'s order, one level at a
    /// time, all the way down).
    pub files: Vec<FileSearchFile>,
    /// Matches actually returned, across every file — the number the panel's
    /// summary states, never an estimate of what is on disk.
    pub total_matches: u32,
    /// True iff the walk stopped early: any cap was hit (files, matches, or
    /// the number of files opened at all). The panel says so rather than
    /// claiming the project holds exactly this many.
    pub truncated: bool,
}

/// One subdirectory entry in a [`DirListing`] (see `core::files::list_dir`).
/// Directories only — this endpoint never lists files (see arch.md #4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct DirEntry {
    /// Basename.
    pub name: String,
    /// Absolute path (parent's canonical path + this basename). For a
    /// symlinked directory this is the symlink's own location, not its
    /// resolved target — `metadata()` follows the link to confirm it's a
    /// directory, but `path` is never further-resolved, so `basename(path)
    /// == name` always holds.
    pub path: String,
}

/// `GET /api/fs/dirs` response — a single-level, non-recursive listing of one
/// directory's subdirectories, for the web UI's new-project folder picker.
/// Unlike [`FileTreeEntry`]/[`ProjectFileTree`], this is not rooted at any
/// project's `local_path`: `path` is whatever absolute filesystem path the
/// caller asked for (see `.scratch/arch.md` #0, mesa task 405).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct DirListing {
    /// Canonical absolute path of the directory actually listed.
    pub path: String,
    /// Canonical absolute path of `path`'s parent, or None at `/`. Lets the
    /// frontend implement "up one level" without doing its own path math.
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagram_type_serializes_to_bare_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&DiagramType::Storyboard).unwrap(),
            "\"storyboard\""
        );
        assert_eq!(
            serde_json::to_string(&DiagramType::Flowchart).unwrap(),
            "\"flowchart\""
        );
        // The acronym-casing case the arch doc flagged to confirm, not assume.
        assert_eq!(serde_json::to_string(&DiagramType::Erd).unwrap(), "\"erd\"");
        assert_eq!(
            serde_json::to_string(&DiagramType::Brainstorm).unwrap(),
            "\"brainstorm\""
        );
    }

    #[test]
    fn frame_shape_serializes_to_bare_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&FrameShape::Process).unwrap(),
            "\"process\""
        );
        assert_eq!(
            serde_json::to_string(&FrameShape::Decision).unwrap(),
            "\"decision\""
        );
        assert_eq!(
            serde_json::to_string(&FrameShape::StartEnd).unwrap(),
            "\"start_end\""
        );
        assert_eq!(
            serde_json::to_string(&FrameShape::Entity).unwrap(),
            "\"entity\""
        );
        assert_eq!(
            serde_json::to_string(&FrameShape::Central).unwrap(),
            "\"central\""
        );
        assert_eq!(
            serde_json::to_string(&FrameShape::Idea).unwrap(),
            "\"idea\""
        );
    }

    #[test]
    fn diagram_type_and_frame_shape_round_trip_through_parse() {
        for dt in [
            DiagramType::Storyboard,
            DiagramType::Flowchart,
            DiagramType::Erd,
            DiagramType::Brainstorm,
        ] {
            assert_eq!(DiagramType::parse(dt.as_str()), Some(dt));
        }
        for shape in [
            FrameShape::Process,
            FrameShape::Decision,
            FrameShape::StartEnd,
            FrameShape::Entity,
            FrameShape::Central,
            FrameShape::Idea,
        ] {
            assert_eq!(FrameShape::parse(shape.as_str()), Some(shape));
        }
        assert_eq!(DiagramType::parse("bogus"), None);
        assert_eq!(FrameShape::parse("bogus"), None);
    }
}
