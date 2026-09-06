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
    /// up — a child keeps its own tasks, diagrams, `root_commit` and
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
    /// **mesa-derived, not from the CLI payload.** The tail of what this
    /// session's assistant last said, read live off its transcript and
    /// **bounded** by `cc::sanitize_capped` — it is untrusted model-authored
    /// text on a 3-second poll, so it is capped and stripped of control
    /// characters exactly as a stored preview is. `null` when the transcript
    /// is missing or has no assistant prose in its window.
    #[serde(default)]
    pub last_response: Option<String>,
    /// **mesa-derived, not from the CLI payload.** The context window this
    /// session currently occupies: the newest assistant message's
    /// `input + cache_read + cache_creation` tokens. Not a sum across
    /// messages and not output tokens — a context window is the size of the
    /// newest *request's* input. `null` when no usage is in the window.
    #[ts(type = "number | null")]
    #[serde(default)]
    pub context_tokens: Option<i64>,
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

/// The listen settings as the Settings page sees them (`core::config`,
/// `docs/config.md`, mesa task 955) — the input-side mirror of
/// [`ConfigSpeech`]: the model the external `auris` speech-to-text binary is
/// run with, plus the models the installed binary offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigListen {
    /// The configured model `live transcribe` runs `auris` with, or `null`
    /// when the config says nothing — then no `-m` is passed at all and
    /// `auris` picks its own default.
    pub model: Option<String>,
    /// Every model the installed `auris` reports (`--list-models`), so the
    /// editor can offer a list. **Empty means mesa could not ask** — a missing
    /// or uncooperative binary — never "there are no models", so an empty
    /// list is a reason to accept a typed name, not to refuse one.
    pub models: Vec<String>,
}

/// The live-conversation settings as the Settings page sees them
/// (`core::config`, `docs/config.md`, mesa task 867) — a fifth view of
/// `~/.mesa/config.json`, with the same null-means-fallback rule as
/// [`ConfigWatchers`].
///
/// This used to carry the instruction block a live agent is spawned with too
/// (`prompt`/`default_prompt`), but that moved to the library as of mesa task
/// 919 — it is now the `mesa-live` agent definition (mesa task 1068), edited
/// on `#/library` rather than here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigLive {
    /// How long a settled dictation draft waits before the page sends it, in
    /// milliseconds, or `null` when the config says nothing — then
    /// `auto_send_ms_default` is the wait (mesa task 886).
    pub auto_send_ms: Option<u32>,
    /// The wait mesa ships (`core::config::DEFAULT_LIVE_AUTO_SEND_MS`), so the
    /// page has the number to fall back to without a second copy of it in
    /// TypeScript.
    pub auto_send_ms_default: u32,
}

/// The cost-guard settings as the Settings page sees them (`core::config`,
/// `docs/cost-guard.md`, mesa task 1018) — a sixth view of
/// `~/.mesa/config.json`, with the same null-means-fallback rule as
/// [`ConfigWatchers`]: an absent value is the built-in threshold, and writing
/// `null` back is how the user restores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigGuard {
    /// Dollars of estimated spend in the guard window at which a live session
    /// is reported, or `null` when the config says nothing.
    pub cost_usd: Option<f64>,
    /// The built-in dollar ceiling mesa ships.
    pub cost_usd_default: f64,
    /// Tokens in the guard window at which a live session is reported, or
    /// `null` when the config says nothing.
    #[ts(type = "number | null")]
    pub total_tokens: Option<i64>,
    /// The built-in token ceiling mesa ships.
    #[ts(type = "number")]
    pub total_tokens_default: i64,
    /// The share of a session's tokens that must be cache reads for the
    /// spin-loop rule to fire (0.5..=1.0), or `null` for the built-in.
    pub cache_read_share: Option<f64>,
    /// The built-in cache-read share mesa ships.
    pub cache_read_share_default: f64,
    /// The token floor under which the spin-loop rule never fires — what stops
    /// a tiny session at 100% cache-read from being called a runaway — or
    /// `null` for the built-in.
    #[ts(type = "number | null")]
    pub cache_read_min_tokens: Option<i64>,
    /// The built-in spin-loop token floor mesa ships.
    #[ts(type = "number")]
    pub cache_read_min_tokens_default: i64,
    /// How many identical trivial `Bash` calls in a row fire the `repeat`
    /// rule, or `null` for the built-in.
    #[ts(type = "number | null")]
    pub repeat_count: Option<i64>,
    /// The built-in repeat count mesa ships.
    #[ts(type = "number")]
    pub repeat_count_default: i64,
    /// What the watcher does about a breach — `"stop"` or `"report"` — or
    /// `null` for the built-in.
    pub action: Option<String>,
    /// The built-in action mesa ships (`"stop"`).
    pub action_default: String,
}

/// The global keyboard shortcuts as the Settings page sees them
/// (`core::config`, `docs/keyboard.md`, mesa task 1079) — an eighth view of
/// `~/.mesa/config.json`, with the same null-means-fallback rule as
/// [`ConfigWatchers`]: an action the config says nothing about answers to the
/// chords mesa ships, and writing `null` back is how the user restores them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigKeymap {
    /// Every action mesa binds, in the order `config::KEYMAP_ACTIONS` ships
    /// them — a list rather than a map so the page renders the rows in one
    /// settled order without holding a second copy of it.
    pub actions: Vec<ConfigKeymapAction>,
}

/// One rebindable action: what the config says, and what mesa ships behind it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ConfigKeymapAction {
    /// The action id (`command-palette`, `focus-left`, …). The label beside it
    /// is the page's own: it is copy, not contract.
    pub action: String,
    /// The configured chords, or `null` when the config says nothing about
    /// this action — then `default` is what applies. A **list**, because the
    /// spatial nav answers to a letter and an arrow alike.
    pub value: Option<Vec<String>>,
    /// The chords mesa ships for this action, so the editor can show what
    /// "reset" means without a second copy of the table.
    pub default: Vec<String>,
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

/// `GET /api/system` and `mesa system`: a live reading of the host the mesa
/// server is running on (`core::system`). Derived on every read, never
/// stored — mesa keeps no history of it.
///
/// Every field a platform may decline to report is `Option`, and `None` means
/// **this host did not say**, never zero: a `null` and a reading of `0` are
/// different facts and the UI must not draw them the same way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct SystemInfo {
    // Every byte count is a `u64` in Rust but `number` in TypeScript: JSON
    // has one number type and `JSON.parse` hands the page a `number`, so the
    // `bigint` ts-rs would infer would be a lie about what actually arrives
    // (the `ProjectGitStatus::project_id` precedent). None of these can reach
    // 2^53 on hardware that exists.
    #[ts(type = "number")]
    pub ram_total_bytes: u64,
    #[ts(type = "number")]
    pub ram_used_bytes: u64,
    #[ts(type = "number")]
    pub swap_total_bytes: u64,
    #[ts(type = "number")]
    pub swap_used_bytes: u64,
    /// The first CPU's brand string, e.g. "Apple M1 Pro".
    pub cpu_model: Option<String>,
    /// Physical cores; `None` where the platform will not say.
    pub cpu_cores: Option<u32>,
    /// Logical cores (hardware threads) — always known, since it is the
    /// length of the per-core list below.
    pub cpu_logical: u32,
    /// Overall utilisation, 0–100, across the whole sampling window.
    pub cpu_usage_pct: f64,
    /// Per logical core, in `cpu_logical` order.
    pub cpu_per_core_pct: Vec<f64>,
    /// 1/5/15-minute load average; `None` where the platform has no such
    /// idea (Windows), rather than three misleading zeroes.
    pub load_average: Option<[f64; 3]>,
    pub gpu: Option<GpuInfo>,
    #[ts(type = "number")]
    pub uptime_secs: u64,
    /// The volume holding mesa's own database — not the whole machine's
    /// storage, since that is the one disk a mesa user can fill.
    #[ts(type = "number | null")]
    pub disk_total_bytes: Option<u64>,
    #[ts(type = "number | null")]
    pub disk_free_bytes: Option<u64>,
    /// Resident set size of the mesa process itself.
    #[ts(type = "number | null")]
    pub process_rss_bytes: Option<u64>,
    pub os: Option<String>,
    pub hostname: Option<String>,
}

/// The host's display adapter, as `system_profiler` reports it (macOS only —
/// `SystemInfo::gpu` is `None` everywhere else). `usage_pct` is always `None`
/// today: real utilisation needs privileged `powermetrics`, so mesa reports
/// nothing rather than a number it cannot stand behind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct GpuInfo {
    pub name: String,
    /// Absent on Apple silicon, where the GPU shares system memory.
    #[ts(type = "number | null")]
    pub vram_bytes: Option<u64>,
    pub usage_pct: Option<f64>,
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

/// Summed line/file counts over a set of commits (`core::git::diff_stat`,
/// task 920). A bare triple rather than folding into `TaskReceipt` inline so
/// it stays independently testable against `git.rs`'s `parse_numstat`, the
/// same split `GitCommit`/`GitCommitFile` already keep from their owning
/// records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct DiffStat {
    /// Distinct paths touched across every summed commit, not a per-commit
    /// sum (see `core::git::diff_stat`).
    #[ts(type = "number")]
    pub files_changed: u32,
    #[ts(type = "number")]
    pub insertions: u32,
    #[ts(type = "number")]
    pub deletions: u32,
}

/// A frozen record of what actually changed while a task was claimed and
/// open (task 920, spec D1–D6). Generated once, at the moment a claimed task
/// closes into `done`, and stored in its own table rather than as fields on
/// `Task`:
///
/// - **Why frozen (D1):** `blocked` and `name` are derived-never-stored, but
///   a receipt cannot follow that pattern — the claim window it describes is
///   gone the instant it closes (`Store::update_task` nulls `owner`/
///   `claimed_at` the moment status leaves `in_progress`) and the commits
///   made during that window keep receding into git's ordinary history as
///   more work lands on the branch. Recomputing "what changed while task N
///   was open" after the fact is not possible even in principle once the
///   claim is gone, so the only honest option is to capture it once, at
///   close time, and keep that capture.
/// - **Why a sibling record, not `Task` fields (D2):** `Task`/`TaskSummary`
///   carry a long, heavily-specified `--quiet` key-parity contract
///   (`cli.rs::compact()`); widening either to hold a commit list and a diff
///   stat would force a decision across every existing projection for a
///   field most reads never want. A receipt is fetched by its own
///   subcommand/route instead. It sits beside `artifact`/`result` — which
///   stay exactly as they are, hand-written and authoritative — and never
///   overwrites either.
/// - **Why the transcript link is best-effort (D5):** `owner` is whatever
///   opaque string the claimant supplied; this repo's own execute-todo skill
///   uses a `session_XXX` convention that is not a `cc_sessions` UUID and
///   will never resolve. `owner`/`claimed_at` are therefore always stored
///   verbatim, while `session_id`/`transcript_path` are filled in only when
///   `owner` actually resolves against `Store::cc_session` — a null
///   transcript is a legitimate, expected answer, never an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct TaskReceipt {
    #[ts(type = "number")]
    pub task_id: i64,
    /// When this receipt was (re)generated (SQLite `datetime` text, UTC).
    /// Moves on `--regenerate`; unrelated to `edited`, which tracks a human
    /// hand touching the record afterward.
    pub generated_at: String,
    /// The claimant's `owner` string at close time, stored verbatim even
    /// when it does not resolve to a `cc_sessions` row (see D5 above).
    pub owner: Option<String>,
    /// The claim's `claimed_at`, captured before `Store::update_task` clears
    /// it on the same transition that produced this receipt — the start of
    /// the window `commits`/`stat` were read from.
    pub claimed_at: Option<String>,
    /// When the task closed into `done` (SQLite `datetime` text, UTC) — the
    /// end of the attribution window.
    pub closed_at: String,
    /// The repo branch at close time, so a reader can see which line of
    /// history `commits` was read from. `None` when there was no readable
    /// repo to check.
    pub branch: Option<String>,
    /// The project's `local_path` at generation time — where `commits`/
    /// `stat` were read from. Recorded because `local_path` itself is not
    /// frozen (task project may move or lose it later); the receipt keeps
    /// its own copy of what it actually read.
    pub repo_path: Option<String>,
    /// Commits in `[claimed_at, closed_at]` on `branch`, newest first,
    /// capped at `core::git::LOG_CAP` (`core::git::log_between`). Reuses
    /// `GitCommit` rather than a second commit struct — same shape, same
    /// meaning, no reason to duplicate it. Documented limitation (D4): two
    /// claims on the same repo/branch/window would see the same commits;
    /// this is the honest first cut, not a per-claim attribution guarantee.
    pub commits: Vec<GitCommit>,
    /// Summed diff stat over `commits` (`core::git::diff_stat`).
    pub stat: DiffStat,
    /// `cc_sessions.session_id` that `owner` resolved to, or `None` when it
    /// didn't (see D5 above).
    pub session_id: Option<String>,
    /// The transcript file path for `session_id`'s main thread
    /// (`Store::cc_node_file(session_id, "")`), or `None` when there is no
    /// `session_id` or the file was never recorded/has since vanished.
    pub transcript_path: Option<String>,
    /// Set the moment a human writes to this receipt (a note, a manual
    /// field edit) — never by regeneration itself, so a hand-corrected
    /// receipt can never silently pose as purely machine-generated (D6).
    pub edited: bool,
    /// Free-text human addendum. The one field on a receipt that is meant to
    /// be written by hand rather than regenerated.
    pub note: Option<String>,
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

/// A diagram's style, chosen at creation and immutable thereafter
/// (no field on `DiagramPatch` — the same structural-immutability posture
/// as `project_id`/`author`). Picks the shape set offered for its frames and
/// the connector markers its edges may carry — see [`DiagramType::shapes`],
/// [`DiagramType::allows_generic_frame`] and [`DiagramType::edge_markers`],
/// which are the single source of truth both `Store`'s validators and
/// `mesa diagram types` read.
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
    /// Every board type, in offer order. The one list a new type has to be
    /// added to — `mesa diagram types` walks it.
    pub const ALL: &'static [DiagramType] = &[
        DiagramType::Storyboard,
        DiagramType::Flowchart,
        DiagramType::Erd,
        DiagramType::Brainstorm,
    ];

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

    /// The named shapes a board of this type accepts, in offer order (the
    /// first entry is what the canvas mints for a quick-create gesture). The
    /// generic card is **not** a member — it is `shape: None`, answered by
    /// [`DiagramType::allows_generic_frame`]. `Store::validate_frame_shape`
    /// and `mesa diagram types` both read this, so the validator and the
    /// discovery command cannot drift apart.
    pub fn shapes(self) -> &'static [FrameShape] {
        match self {
            DiagramType::Storyboard => &[FrameShape::Scene, FrameShape::Note],
            DiagramType::Flowchart => &[
                FrameShape::Process,
                FrameShape::Decision,
                FrameShape::StartEnd,
                FrameShape::Data,
                FrameShape::Document,
                FrameShape::Database,
                FrameShape::PredefinedProcess,
            ],
            DiagramType::Erd => &[
                FrameShape::Entity,
                FrameShape::WeakEntity,
                FrameShape::Relationship,
                FrameShape::Attribute,
            ],
            DiagramType::Brainstorm => &[FrameShape::Idea, FrameShape::Central, FrameShape::Note],
        }
    }

    /// Whether a board of this type accepts the generic frame card
    /// (`shape: None`). Only a `storyboard` board does — every pre-feature
    /// frame reads back `shape: null`, and that must stay legal.
    pub fn allows_generic_frame(self) -> bool {
        matches!(self, DiagramType::Storyboard)
    }

    /// The endpoint markers a board of this type accepts: the general family
    /// everywhere, plus the ERD cardinality family on an `erd` board — a
    /// crow's foot means "many" of a relation, which says nothing on a
    /// flowchart. `Store::validate_edge_markers` and `mesa diagram types`
    /// both read this.
    pub fn edge_markers(self) -> &'static [EdgeMarker] {
        match self {
            DiagramType::Erd => EdgeMarker::ALL,
            _ => EdgeMarker::GENERAL,
        }
    }
}

/// A frame's node shape, chosen at creation and immutable thereafter (no
/// field on `FramePatch` — mirrors `DiagramType`'s posture, for the same
/// reason: a board should never hold a shape from the "wrong" type system).
/// `None` on `Frame.shape` means the generic card, valid only on a
/// `storyboard`-type board; `Store::create_frame` validates a given shape
/// against the parent board's `DiagramType` (see [`DiagramType::shapes`],
/// which is the shape set itself).
///
/// The tail of this list is mesa task 854's professional-tool-grade widening:
/// the flowchart set gained the four ANSI process-chart shapes, the ERD set
/// the three Chen shapes beside `entity`, and `storyboard`/`brainstorm` gained
/// the shapes their boards were writing as bare cards. Widening only — every
/// shape that was legal on a board type before is still legal on it.
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
    /// A storyboard beat — one shot/step of the narrative.
    Scene,
    /// A sticky annotation. Deliberately valid on both the `storyboard` and
    /// `brainstorm` sets: a note is commentary, not a member of either type
    /// system, so it is the one shape two board types share.
    Note,
    /// Flowchart I/O (the ANSI parallelogram).
    Data,
    /// Flowchart printed output (the wavy-bottomed page).
    Document,
    /// Flowchart stored data (the cylinder).
    Database,
    /// Flowchart call into a named subroutine (the double-barred box).
    PredefinedProcess,
    /// An ERD entity whose identity depends on another's (the double box).
    WeakEntity,
    /// An ERD relationship (the Chen diamond).
    Relationship,
    /// An ERD attribute (the Chen ellipse).
    Attribute,
}

impl FrameShape {
    /// Every shape, grouped by the board type that offers it. The one list a
    /// new shape has to be added to; `DiagramType::shapes` decides which board
    /// accepts which.
    pub const ALL: &'static [FrameShape] = &[
        FrameShape::Process,
        FrameShape::Decision,
        FrameShape::StartEnd,
        FrameShape::Entity,
        FrameShape::Central,
        FrameShape::Idea,
        FrameShape::Scene,
        FrameShape::Note,
        FrameShape::Data,
        FrameShape::Document,
        FrameShape::Database,
        FrameShape::PredefinedProcess,
        FrameShape::WeakEntity,
        FrameShape::Relationship,
        FrameShape::Attribute,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FrameShape::Process => "process",
            FrameShape::Decision => "decision",
            FrameShape::StartEnd => "start_end",
            FrameShape::Entity => "entity",
            FrameShape::Central => "central",
            FrameShape::Idea => "idea",
            FrameShape::Scene => "scene",
            FrameShape::Note => "note",
            FrameShape::Data => "data",
            FrameShape::Document => "document",
            FrameShape::Database => "database",
            FrameShape::PredefinedProcess => "predefined_process",
            FrameShape::WeakEntity => "weak_entity",
            FrameShape::Relationship => "relationship",
            FrameShape::Attribute => "attribute",
        }
    }

    pub fn parse(s: &str) -> Option<FrameShape> {
        FrameShape::ALL
            .iter()
            .copied()
            .find(|shape| shape.as_str() == s)
    }
}

/// How a `FrameEdge`'s line is drawn (mesa task 854). `None` on
/// `FrameEdge.style` is today's rendering — a solid line — so an edge that
/// predates the feature is byte-identical; `solid` is the same picture said
/// explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum EdgeStyle {
    Solid,
    Dashed,
    Dotted,
}

impl EdgeStyle {
    /// Every style, in offer order. Valid on **every** board type — a dashed
    /// line means "weaker" on any diagram, so unlike `EdgeMarker` there is no
    /// per-type subset.
    pub const ALL: &'static [EdgeStyle] = &[EdgeStyle::Solid, EdgeStyle::Dashed, EdgeStyle::Dotted];

    pub fn as_str(self) -> &'static str {
        match self {
            EdgeStyle::Solid => "solid",
            EdgeStyle::Dashed => "dashed",
            EdgeStyle::Dotted => "dotted",
        }
    }

    pub fn parse(s: &str) -> Option<EdgeStyle> {
        EdgeStyle::ALL.iter().copied().find(|s2| s2.as_str() == s)
    }
}

/// What one end of a `FrameEdge` is decorated with (mesa task 854). Two
/// families, told apart by which board types accept them
/// ([`DiagramType::edge_markers`]): the **general** family draws on any board,
/// while the **cardinality** family states an ERD relation's multiplicity and
/// is therefore accepted only on an `erd` board.
///
/// `EdgeMarker::None` and `Option::None` are different answers: `None` on
/// `FrameEdge.from_marker`/`to_marker` is the default — today's rendering, no
/// start marker and a closed arrowhead at the `to` end — while
/// `EdgeMarker::None` explicitly draws nothing at that end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum EdgeMarker {
    None,
    Arrow,
    HollowArrow,
    Circle,
    Diamond,
    CrowsFoot,
    One,
    ZeroOrOne,
    OneOrMany,
    ZeroOrMany,
}

impl EdgeMarker {
    /// The family every board type accepts.
    pub const GENERAL: &'static [EdgeMarker] = &[
        EdgeMarker::None,
        EdgeMarker::Arrow,
        EdgeMarker::HollowArrow,
        EdgeMarker::Circle,
        EdgeMarker::Diamond,
    ];

    /// The ERD-only family: relation multiplicity, meaningless off an `erd`
    /// board.
    pub const CARDINALITY: &'static [EdgeMarker] = &[
        EdgeMarker::CrowsFoot,
        EdgeMarker::One,
        EdgeMarker::ZeroOrOne,
        EdgeMarker::OneOrMany,
        EdgeMarker::ZeroOrMany,
    ];

    /// `GENERAL` followed by `CARDINALITY` — what an `erd` board accepts, and
    /// the list a new marker has to be added to.
    pub const ALL: &'static [EdgeMarker] = &[
        EdgeMarker::None,
        EdgeMarker::Arrow,
        EdgeMarker::HollowArrow,
        EdgeMarker::Circle,
        EdgeMarker::Diamond,
        EdgeMarker::CrowsFoot,
        EdgeMarker::One,
        EdgeMarker::ZeroOrOne,
        EdgeMarker::OneOrMany,
        EdgeMarker::ZeroOrMany,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EdgeMarker::None => "none",
            EdgeMarker::Arrow => "arrow",
            EdgeMarker::HollowArrow => "hollow_arrow",
            EdgeMarker::Circle => "circle",
            EdgeMarker::Diamond => "diamond",
            EdgeMarker::CrowsFoot => "crows_foot",
            EdgeMarker::One => "one",
            EdgeMarker::ZeroOrOne => "zero_or_one",
            EdgeMarker::OneOrMany => "one_or_many",
            EdgeMarker::ZeroOrMany => "zero_or_many",
        }
    }

    pub fn parse(s: &str) -> Option<EdgeMarker> {
        EdgeMarker::ALL.iter().copied().find(|m| m.as_str() == s)
    }
}

/// A visual diagram: a freeform spatial canvas of frames (cards) and the
/// directed edges between them. Belongs to a project, fixed at creation (like a
/// task). `author` is a free-text actor id — an agent name or "user" — naming
/// who created the board. Collaboration is asynchronous and attribution-based:
/// many agents and users edit one board over time; there is no live-sync, no
/// auth, and no locking (consistent with the rest of mesa).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Diagram {
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

/// One card on a diagram, positioned freely on the canvas. `x`/`y` are the
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
    pub diagram_id: i64,
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

/// A directed connection from one frame to another on the same diagram.
/// Unlike task dependencies, diagram edges may form cycles freely — a
/// diagram is a freeform diagram, not a dependency graph. Self-edges
/// (`from_frame == to_frame`) are the only rejected shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct FrameEdge {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub diagram_id: i64,
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
    /// How the connector's line is drawn. `None` renders exactly as today
    /// (solid) — see `EdgeStyle`. Unlike `shape`/`diagram_type` this is
    /// mutable: restyling a connector never moves it into another type
    /// system, so there is nothing for immutability to protect.
    pub style: Option<EdgeStyle>,
    /// Decoration at the `from_frame` end. `None` renders exactly as today
    /// (nothing at the start) — see `EdgeMarker`. Validated against the
    /// board's `diagram_type`: the cardinality family is `erd`-only.
    pub from_marker: Option<EdgeMarker>,
    /// Decoration at the `to_frame` end. `None` renders exactly as today (a
    /// closed arrowhead). Same contract as `from_marker`, independent per
    /// endpoint.
    pub to_marker: Option<EdgeMarker>,
}

/// The full contents of one diagram: the board plus all of its frames and
/// edges. Returned by `show` and echoed by `delete`, so a client renders (or
/// recovers) an entire canvas from a single object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct DiagramView {
    pub diagram: Diagram,
    pub frames: Vec<Frame>,
    pub edges: Vec<FrameEdge>,
}

/// What one inbox item *is for* (mesa task 846) — the two things that arrive in
/// the inbox, told apart so each reaches its reader. A **task summary** is an
/// agent reporting what it did, for a person to read; a **change request** asks
/// for work, which is what the inbox-watcher triages. Exactly two kinds: the
/// pair is the whole point, so a third would mean deciding again who reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum InboxKind {
    TaskSummary,
    ChangeRequest,
}

impl InboxKind {
    pub fn as_str(self) -> &'static str {
        match self {
            InboxKind::TaskSummary => "task-summary",
            InboxKind::ChangeRequest => "change-request",
        }
    }

    pub fn parse(s: &str) -> Option<InboxKind> {
        match s {
            "task-summary" => Some(InboxKind::TaskSummary),
            "change-request" => Some(InboxKind::ChangeRequest),
            _ => None,
        }
    }
}

/// The kind an item that names none is: a report, not a request. The default is
/// deliberately the passive one — an unlabelled item waits for a person instead
/// of being auto-triaged by the inbox-watcher, so nothing runs on a caller's
/// silence (`docs/inbox.md`).
impl Default for InboxKind {
    fn default() -> Self {
        InboxKind::TaskSummary
    }
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
    /// What the item is for (mesa task 846): a summary a person reads, or a
    /// change request the inbox-watcher triages. Set at creation and never
    /// changed — it is what the sender meant, not a state the reader moves.
    pub kind: InboxKind,
    /// When the item was sent (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the item was last changed — e.g. assigned (SQLite `datetime`, UTC).
    pub updated_at: String,
    /// When the item was **first** read, or null while it is unread (mesa task
    /// 831). Stamped once and never moved or cleared: an item is read after it
    /// has been opened long enough to take in, or heard through the play
    /// button, and re-reading it says nothing new.
    pub read_at: Option<String>,
    /// When the item was archived — set aside without being triaged — or null
    /// while it is live (mesa task 845). Unlike `read_at` this toggles:
    /// archiving is a place an item sits, so un-archiving clears the stamp.
    pub archived_at: Option<String>,
    /// The task this item is **about** (mesa task 847) — required at creation,
    /// because every item arrives from an agent working a task and an item with
    /// no origin cannot say where it came from. Null only on a row that
    /// predates 847, or whose task was later deleted (the FK is
    /// `ON DELETE SET NULL`, like the item's own `project_id`). It is not the
    /// item's *assignment*: `project_id` stays null until a person triages.
    #[ts(type = "number | null")]
    pub task_id: Option<i64>,
    /// The origin task's `name`, **derived on every read** from that task's
    /// description by the one `task_name` implementation — never stored, so it
    /// cannot go stale against a task that was re-described. Null exactly when
    /// `task_id` is.
    pub task_name: Option<String>,
    /// The origin task's project name, derived on every read the same way.
    /// This is the project the item is *about*; `project_id` above is where it
    /// was triaged to, which is a different question and stays null.
    pub project_name: Option<String>,
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
    /// the run's working directory (the project's `local_path`;
    /// `~/.mesa/workspace` when null). Deleting the project un-binds rather
    /// than destroys the script — the FK is `ON DELETE SET NULL`, as the
    /// inbox's is.
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

// ---- artifacts (agent-written pages, mesa task 974) --------------------
//
// NOTE: unrelated to `Task::artifact` (a bounded pointer string — a commit
// SHA, PR URL, or path — a task carries as its work receipt). This
// `Artifact` is a first-class record: a whole small document (an HTML
// mockup, an SVG diagram, a markdown page) an agent writes and a person
// reads back on the project's Artifacts tab. The two share a name and
// nothing else.

/// The allowlisted `content_type` values a stored [`Artifact`] body may
/// declare — exactly three, mirroring `files::image_mime`'s posture: a fixed
/// list, not a free string, because `content_type` decides how the render
/// route answers and how the web UI frames the result (an `<iframe
/// sandbox>` for the first two, `components/Markdown.tsx` for the third). A
/// fourth value is a change to both of those, never a free addition here.
pub const ARTIFACT_CONTENT_TYPES: &[&str] = &["text/html", "image/svg+xml", "text/markdown"];

/// The `content_type` an artifact gets when a caller names none. Lives in
/// `core`, not the CLI or the API, so the two surfaces can never disagree
/// about it (CLAUDE.md: "CLI and API share `core` and never diverge") —
/// `Store::create_artifact` is what applies it, and both `mesa artifact
/// create --content-type` and a `POST` body that omits `content_type` reach
/// that one chokepoint.
pub const DEFAULT_ARTIFACT_CONTENT_TYPE: &str = "text/html";

/// Whether `content_type` is one of [`ARTIFACT_CONTENT_TYPES`]. The one
/// chokepoint `Store::create_artifact`/`update_artifact` call — never
/// re-checked ad hoc elsewhere.
pub fn is_valid_artifact_content_type(content_type: &str) -> bool {
    ARTIFACT_CONTENT_TYPES.contains(&content_type)
}

/// An agent-written page bound to a project: a small text document — HTML
/// mockup, SVG diagram, or markdown page — rendered on the project's
/// Artifacts tab. The body lives in the db (unlike an [`Attachment`], which
/// is an arbitrary binary on disk): an artifact is closer in kind to a task
/// `description` or a diagram frame `body`, both already stored this way,
/// and keeping it there means one `mesa backup` story rather than a second
/// on-disk tree for `Store` to reconcile. `ARTIFACT_BODY_MAX` (`Store`) is
/// the hard cap that keeps this from becoming the attachment case by the
/// back door.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct Artifact {
    #[ts(type = "number")]
    pub id: i64,
    /// The project this artifact belongs to; immutable after creation (the
    /// id is in the artifact's own URL). `ON DELETE CASCADE` — an artifact is
    /// a page *about* a project and has nowhere to live without one.
    #[ts(type = "number")]
    pub project_id: i64,
    /// The task that prompted this page, if any. `ON DELETE SET NULL` —
    /// deleting the task that prompted a page must not destroy the page.
    #[ts(type = "number | null")]
    pub task_id: Option<i64>,
    /// Unique (case-insensitively) within the project; the CLI resolves an
    /// artifact by id only (unlike a script or project), but the name is
    /// still the selector a person reads.
    pub name: String,
    /// One of [`ARTIFACT_CONTENT_TYPES`].
    pub content_type: String,
    /// The document itself, stored verbatim. Required, non-empty, capped at
    /// `ARTIFACT_BODY_MAX` (`Store`) — unlike the live surface's
    /// `LIVE_TEXT_MAX`, which does not apply here: an artifact is read, never
    /// spoken.
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// The API's `GET /api/projects/{id}/artifacts` list projection — every
/// [`Artifact`] field except `body` — the twin of the CLI's `QUIET_DROP_ARTIFACT`
/// compact shape (`src/cli.rs`); the two must stay in step, so a new bounded
/// field on `Artifact` belongs in both. Dropped for the same reason
/// [`TaskSummary`] drops `description`: `body` is a document capped at 2 MiB
/// (`Store::ARTIFACT_BODY_MAX`), and the primary caller of `list` is an agent
/// asking what pages exist in a project, not fetching every page's markup —
/// a project with many artifacts would otherwise return tens of megabytes
/// into a browser's memory for a question that only needed names and ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct ArtifactSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub project_id: i64,
    #[ts(type = "number | null")]
    pub task_id: Option<i64>,
    pub name: String,
    pub content_type: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&Artifact> for ArtifactSummary {
    fn from(a: &Artifact) -> ArtifactSummary {
        ArtifactSummary {
            id: a.id,
            project_id: a.project_id,
            task_id: a.task_id,
            name: a.name.clone(),
            content_type: a.content_type.clone(),
            created_at: a.created_at.clone(),
            updated_at: a.updated_at.clone(),
        }
    }
}

// ---- library (agents, skills, hooks, commands, prompts, CLAUDE.md) ----
//
// mesa task 919: agents, skills, hooks, commands, the live-conversation
// prompt, and CLAUDE.md files are first-class records — `library_items`, with
// a `library_versions` history — synced file-by-file against the `.claude`
// directory a user or a project checkout actually reads. A row's `kind`
// decides where on disk it lives (`core::library::relative_path`); `prompt`
// alone has no path, because the live-conversation prompt is mesa-internal,
// not a file Claude Code reads.

/// What a [`LibraryItem`] is. Six kinds, and the wire value is the exact word
/// Claude Code (or mesa, for `prompt`) uses for the thing — `kebab-case`
/// keeps `claude-md` readable rather than `claude_md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LibraryKind {
    Agent,
    Skill,
    Hook,
    Command,
    Prompt,
    ClaudeMd,
}

impl LibraryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LibraryKind::Agent => "agent",
            LibraryKind::Skill => "skill",
            LibraryKind::Hook => "hook",
            LibraryKind::Command => "command",
            LibraryKind::Prompt => "prompt",
            LibraryKind::ClaudeMd => "claude-md",
        }
    }

    pub fn parse(s: &str) -> Option<LibraryKind> {
        match s {
            "agent" => Some(LibraryKind::Agent),
            "skill" => Some(LibraryKind::Skill),
            "hook" => Some(LibraryKind::Hook),
            "command" => Some(LibraryKind::Command),
            "prompt" => Some(LibraryKind::Prompt),
            "claude-md" => Some(LibraryKind::ClaudeMd),
            _ => None,
        }
    }
}

/// Where a [`LibraryItem`] lives: a personal, machine-wide row (the home
/// dir), or one bound to a project (that project's `local_path`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LibraryScope {
    User,
    Project,
}

impl LibraryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            LibraryScope::User => "user",
            LibraryScope::Project => "project",
        }
    }

    pub fn parse(s: &str) -> Option<LibraryScope> {
        match s {
            "user" => Some(LibraryScope::User),
            "project" => Some(LibraryScope::Project),
            _ => None,
        }
    }
}

/// One library record — an agent definition, a skill, a hook script, a slash
/// command, the live-conversation prompt, or a CLAUDE.md, stored in mesa and
/// (for every kind but `prompt`) synced against a file on disk.
///
/// `id` is `null` for an unshadowed built-in (`core::library::BUILTINS`) —
/// there is no db row yet, `builtin` is `true`, and `builtin_id` names which
/// built-in it is. Editing a built-in forks it: a db row appears carrying
/// `builtin_id`, `builtin` becomes `false`, and `id` becomes real.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibraryItem {
    #[ts(type = "number | null")]
    pub id: Option<i64>,
    /// `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `/`, no `..` — half of a filename.
    pub name: String,
    pub kind: LibraryKind,
    pub scope: LibraryScope,
    /// Required iff `scope` is `project`, and must be null iff `scope` is
    /// `user` — the same pairing rule `TaskPatch`'s neighbours enforce.
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    /// The file's contents. May be empty.
    pub body: String,
    /// The built-in this row forked from, or null for a purely user-authored
    /// row. Unique when set — a built-in forks at most once.
    pub builtin_id: Option<String>,
    /// Derived, never stored: true iff this row has no db id (an unshadowed
    /// built-in reported in its place).
    pub builtin: bool,
    /// Derived from `kind`/`scope`/`name` via `core::library::relative_path`;
    /// null for `prompt`, which has no file.
    pub path: Option<String>,
    /// The last body mesa and the file on disk agreed on — the sync
    /// baseline. Null until the first sync.
    pub synced_body: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// One entry in a [`LibraryItem`]'s history. A row is appended only when the
/// body actually changes, so this is a list of distinct contents, not a list
/// of edits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibraryVersion {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub item_id: i64,
    pub body: String,
    /// Who wrote this body: `edit` (the item was saved in mesa) or
    /// `sync-pull` (the disk side won a sync and was pulled in).
    pub source: String,
    pub created_at: String,
}

/// How a synced path's mesa body (M) compares to the file on disk (D) against
/// the last-agreed baseline (B) — `core::library::classify`'s result, and the
/// one decision table `mesa library sync status` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LibrarySyncStatus {
    /// M == D. Not offered as a resolvable row.
    InSync,
    /// No file yet, never synced (B is null).
    MesaNew,
    /// No file, B == M — the disk side was deleted since the last sync.
    DiskDeleted,
    /// B == D, M != D — mesa changed since the last sync.
    MesaChanged,
    /// B == M, D != M — disk changed since the last sync.
    DiskChanged,
    /// Both sides moved since the last sync (or never synced and both sides
    /// have content) — the one real conflict; the user picks a side.
    BothChanged,
    /// A file with no mesa row at all.
    DiskNew,
}

impl LibrarySyncStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LibrarySyncStatus::InSync => "in-sync",
            LibrarySyncStatus::MesaNew => "mesa-new",
            LibrarySyncStatus::DiskDeleted => "disk-deleted",
            LibrarySyncStatus::MesaChanged => "mesa-changed",
            LibrarySyncStatus::DiskChanged => "disk-changed",
            LibrarySyncStatus::BothChanged => "both-changed",
            LibrarySyncStatus::DiskNew => "disk-new",
        }
    }
}

/// One row of a sync scan — one *path*, comparing the mesa side to the disk
/// side. `item_id`/`builtin_id` are both null only for a `disk-new` row (a
/// file with no mesa row at all).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibrarySyncRow {
    #[ts(type = "number | null")]
    pub item_id: Option<i64>,
    pub builtin_id: Option<String>,
    pub name: String,
    pub kind: LibraryKind,
    pub scope: LibraryScope,
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    pub path: String,
    pub status: LibrarySyncStatus,
    pub mesa_body: Option<String>,
    pub disk_body: Option<String>,
    pub baseline: Option<String>,
}

/// The outcome of applying one resolution from `POST /api/library/sync`.
/// Apply is per-row, not all-or-nothing across the batch: a failing row is
/// reported here and the rest still apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibrarySyncResult {
    pub path: String,
    /// `mesa | disk | skip`, echoing the resolution this result answers.
    pub choice: String,
    pub applied: bool,
    pub error: Option<String>,
}

// ---- library import/export (mesa task 963) ----
//
// A bundle is a downloadable snapshot of a library's *contents*, portable to
// another mesa instance — `core::library::export`/`import`. It deliberately
// carries none of a row's machine-local facts: no `id`, `created_at` or
// `updated_at` (identity/bookkeeping on this database), no `synced_body` or
// `synced_at` (a fact about *this machine's* disk that must never travel),
// no `path` (derived), and no version history (a bundle is contents, not a
// past). An unshadowed built-in is never included — it is code, not a row,
// and identical on the receiving instance by construction — while a
// *forked* built-in travels, carrying its `builtin_id` so it lands as a
// fork on the far side too.

/// One library row as it travels between mesa instances.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibraryBundleItem {
    pub name: String,
    pub kind: LibraryKind,
    pub scope: LibraryScope,
    /// The project's NAME, not its id — ids are machine-local. Present iff
    /// `scope` is `project`, resolved back to an id on import via
    /// `Store::find_project_by_name`.
    pub project: Option<String>,
    pub body: String,
    /// The built-in this row forked from, so a fork imports as a fork.
    pub builtin_id: Option<String>,
}

/// A downloadable bundle of a library's contents (`core::library::export`),
/// portable to another mesa instance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibraryBundle {
    /// Format version; `1` today. A bundle whose version this mesa does not
    /// know is refused whole, not partly applied (`core::library::import`).
    pub version: u32,
    pub exported_at: String,
    pub items: Vec<LibraryBundleItem>,
}

/// The outcome of importing one bundle item. Import is per-item, not
/// all-or-nothing — a failing item is reported here and the rest still
/// apply. (Deliberately the same posture as `LibrarySyncResult`.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LibraryImportResult {
    pub name: String,
    pub kind: LibraryKind,
    pub scope: LibraryScope,
    /// `created | replaced | skipped | failed`.
    pub status: String,
    /// The db id of the row this item resolved to — the one created,
    /// replaced, or left untouched by a `skip`, which is how a caller
    /// identifies the row that won a conflict it did not overwrite. Null
    /// only for `failed`, where no row was reached at all.
    #[ts(type = "number | null")]
    pub item_id: Option<i64>,
    pub error: Option<String>,
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
    /// The `AskUserQuestion` call this session is **waiting on**, when it is
    /// waiting on one (task 866) — the one turn a reader can do something
    /// about rather than only watch. Derived on every read from the same
    /// window the turns come from (the last such `tool_use` carrying no
    /// `tool_result`), never stored, and `None` for every session that is not
    /// blocked on a question.
    pub pending_question: Option<CcChatAsk>,
}

/// The `AskUserQuestion` call a session is blocked on — see
/// [`CcSessionChat::pending_question`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcChatAsk {
    /// The `tool_use_id` of the call. Also the id of the `tool` turn it
    /// appears as in `turns`, so a client can tell the two apart across polls
    /// — a *second* question is a different id, and answering the first one
    /// makes this whole field `None`.
    pub id: String,
    /// The questions of that one call, in the order the agent asked them —
    /// which is also the order its own chooser walks them in.
    pub questions: Vec<CcChatQuestion>,
}

/// One question of a [`CcChatAsk`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcChatQuestion {
    /// The question itself, bounded (`sanitize_capped`) like every other
    /// transcript-derived label: this is model-authored text on a button.
    pub question: String,
    /// The short chip the tool asks for beside it; empty when it carried none.
    pub header: String,
    /// Whether the chooser takes more than one answer.
    pub multi_select: bool,
    /// The offered answers, in order. The tool's own `preview` is deliberately
    /// dropped: it is unbounded and this payload is a 3s poll.
    pub options: Vec<CcChatOption>,
}

/// One offered answer of a [`CcChatQuestion`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcChatOption {
    /// What the agent's own chooser shows on the row — bounded.
    pub label: String,
    /// Why that answer, when the call gave a reason; empty when it did not.
    pub description: String,
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
    /// The requested window token (`7d`/`30d`/`90d`/`all`/`<n>d`, or
    /// `cc-5h`/`cc-7d` for the open Claude Code subscription window).
    pub window: String,
    /// Inclusive cutoff date (`YYYY-MM-DD`), or null for `all`. A subscription
    /// window starts mid-day, so this is the date its cutoff falls on.
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
    /// The trailing run of identical trivial `Bash` calls this session is
    /// currently in, or `null` when its newest tool call was anything else.
    /// The cost guard's `repeat` rule reads it (`docs/cost-guard.md`).
    pub repeat: Option<CcRepeat>,
}

/// A session stuck repeating one trivial shell command — the *shape* of a
/// wedged agent rather than its cost, and the only guard signal that can fire
/// before any money is spent (mesa task 1054).
///
/// `command` is the full `Bash` input run through `cc::sanitize_capped`, so it
/// is bounded and control-character-free like every other transcript-derived
/// string mesa surfaces: it is untrusted model-authored text, and it is data.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct CcRepeat {
    /// The command being repeated, sanitized and capped at
    /// `cc::TARGET_MAX_CHARS`.
    pub command: String,
    /// How many times in a row it has just been run.
    #[ts(type = "number")]
    pub count: u64,
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

/// One entry in a diagram's append-only change history. `actor` is the
/// free-text id of whoever made the change (an agent name or "user"); it is the
/// collaboration record — who did what, when. `action` is a stable machine
/// token (e.g. `frame_added`, `frame_moved`, `edge_added`); `summary` is a
/// human-readable one-liner for the web history view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct DiagramEvent {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub diagram_id: i64,
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

// ---- mesa live (mesa task 855) ----
//
// A live session is one spoken conversation: the user dictates into the Live
// page, a spawned agent pulls each utterance over the CLI and pushes a reply,
// and the browser speaks it. The queue lives in the db rather than in server
// memory because the agent drives mesa through the CLI, which opens its own
// `Store` and never talks to the server — see `docs/live.md`.

/// Whether a live conversation is still running. Exactly two states: it is
/// running, or it is over. There is no "paused" — a conversation the user
/// stopped is ended, and going live again starts a new session with its own
/// transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LiveStatus {
    Live,
    Ended,
}

impl LiveStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LiveStatus::Live => "live",
            LiveStatus::Ended => "ended",
        }
    }

    pub fn parse(s: &str) -> Option<LiveStatus> {
        match s {
            "live" => Some(LiveStatus::Live),
            "ended" => Some(LiveStatus::Ended),
            _ => None,
        }
    }
}

/// Who said one turn. `user` is dictated text the *person* typed or spoke into
/// the page; `mesa` is what the agent sends back, which is what gets spoken.
/// The pair is the whole vocabulary — a live session is two-sided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LiveRole {
    User,
    Mesa,
}

impl LiveRole {
    pub fn as_str(self) -> &'static str {
        match self {
            LiveRole::User => "user",
            LiveRole::Mesa => "mesa",
        }
    }

    pub fn parse(s: &str) -> Option<LiveRole> {
        match s {
            "user" => Some(LiveRole::User),
            "mesa" => Some(LiveRole::Mesa),
            _ => None,
        }
    }
}

/// A side effect a `mesa` turn asks the *page* to perform, beside speaking.
///
/// The vocabulary is deliberately narrow, and it is all one thing: **what the
/// person is looking at**. `navigate` moves the browser to a page; the sidebar
/// pair collapses and re-opens the app's two side panels around it (mesa task
/// 859), which is the other half of the same request — a person who asked to
/// *see* something wants the screen it needs. Anything beyond that (click this,
/// fill that) would be a remote-control vocabulary, and the agent already has
/// the whole mesa CLI for changing things.
///
/// Only `navigate` carries a `target`; the sidebar verbs say everything in
/// their own name, which is why they are two values rather than one verb with
/// a state argument in a column typed as a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LiveAction {
    Navigate,
    CollapseSidebars,
    ExpandSidebars,
}

impl LiveAction {
    pub fn as_str(self) -> &'static str {
        match self {
            LiveAction::Navigate => "navigate",
            LiveAction::CollapseSidebars => "collapse-sidebars",
            LiveAction::ExpandSidebars => "expand-sidebars",
        }
    }

    pub fn parse(s: &str) -> Option<LiveAction> {
        match s {
            "navigate" => Some(LiveAction::Navigate),
            "collapse-sidebars" => Some(LiveAction::CollapseSidebars),
            "expand-sidebars" => Some(LiveAction::ExpandSidebars),
            _ => None,
        }
    }
}

/// Which *page* the person is on when the live session reports its context.
///
/// The vocabulary is deliberately not open: it is the app's own page
/// inventory, and nothing else. Eight of these are `ProjectTab` values from
/// `frontend/src/lastView.ts` — the tabs a project page has — and the other
/// two are the global pages that have something in focus (the inbox and the
/// scripts page). A page mesa does not have is therefore not expressible,
/// which is the point: the agent reads this to talk about what is on screen,
/// and a free-form string would let a page invent a vocabulary nobody else in
/// mesa understands. Adding a page means adding a value here, deliberately,
/// in the same commit.
///
/// The one `ProjectTab` with no value here is **`custom`**, and its absence is
/// the same rule read the other way: a value nothing can report is as much a
/// rot risk as a page that cannot be named. A custom layout is several views
/// at once, and each of them already publishes what it holds — so the honest
/// answer to "what are they looking at" on that tab is `files` and the file,
/// not `custom` and nothing. A parent reporting the tab could only land on
/// top of the child that knew more (its effect runs last), which would make
/// the report worse rather than better.
///
/// The kind is the *page*; [`LiveContext`]'s other three fields are what is in
/// focus on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LiveContextKind {
    Artifacts,
    Board,
    Dashboard,
    Diagrams,
    Files,
    Git,
    Inbox,
    Scripts,
    Settings,
    Terminal,
}

/// What the person is actually looking at, as reported by the page alongside
/// the route (mesa task 888).
///
/// A route says which URL the browser is at; it does not say which file is
/// open in the editor, which diagram is on the canvas, or which commit is
/// selected in the history. This is that second half, and it is a **small
/// fixed shape** rather than a free-form blob so the agent can say something
/// useful about it without parsing anything: `kind` is the page, `id` is the
/// identity of the thing in focus (a file path, a diagram id, a task id, a
/// commit sha), `label` is the human — and therefore *spoken* — name for it,
/// and `detail` is whatever extra the page has (a line number, a selected
/// frame, a mode).
///
/// Every field but `kind` is optional, and absent genuinely means "nothing
/// selected": a page with an empty editor reports its kind and no more, rather
/// than an empty string the agent would have to treat as a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveContext {
    pub kind: LiveContextKind,
    pub id: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
}

/// The physical browser window a live conversation is being held in, as the
/// page reports it (mesa task 895): `window.screenX`/`screenY` and
/// `outerWidth`/`outerHeight`, rounded to whole pixels.
///
/// It exists because the agent otherwise has no way to *see* the screen. A
/// route says which page, a [`LiveContext`] says what is open on it, and
/// neither says what actually rendered — so `mesa live look` screenshots the
/// window, and this box is how it finds the right one. The desktop tooling
/// mesa asks (`loki`) reports every window's frame in the same screen
/// coordinates, and a window's position and size together are its identity:
/// several headless browsers on this machine are titled `mesa`, so matching on
/// a title would photograph one of them, while only the browser that is
/// actually joined to the conversation ever reports a box.
///
/// Reported by the page, so it needs a TS type — unlike the shot itself, which
/// no browser ever sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveWindow {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// One live conversation. **At most one is `live` at a time** (`Store`
/// enforces it): the page has one microphone-shaped text field and one
/// `<audio>` element, so a second concurrent conversation would have nowhere
/// to be heard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveSession {
    #[ts(type = "number")]
    pub id: i64,
    /// The project the conversation is about, or null for an unscoped one. The
    /// FK is `ON DELETE SET NULL` (the call the inbox makes): a conversation
    /// outlives the project row it mentioned.
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    /// The spawn receipt from `agents::spawn_bg` — the Claude session driving
    /// this conversation, when the spawn printed one. Null when the session
    /// was started with no agent, or when the command printed no receipt.
    pub agent_id: Option<String>,
    pub status: LiveStatus,
    /// Where the user's browser currently is (a `#/…` hash route), as last
    /// reported by the page. The agent reads it to know what the user is
    /// looking at; it is never authority for anything mesa does.
    pub route: Option<String>,
    /// What is *on* that page — the file, the diagram, the task, the commit —
    /// as reported by the page alongside the route, in the same request. The
    /// agent reads it to know what is actually on screen rather than asking
    /// the person what they are looking at; like `route`, it is never
    /// authority for anything mesa does. Null when the page has reported
    /// nothing, or has reported that nothing is selected.
    pub context: Option<LiveContext>,
    /// Where the browser window *itself* is on the screen, as reported by the
    /// page in the same request as the route (mesa task 895). Null when no
    /// browser has joined the conversation — a session driven from the CLI
    /// with `--no-agent` never has one — which is exactly the case
    /// `mesa live look` reports as unavailable rather than guessing at.
    pub window: Option<LiveWindow>,
    /// When the conversation started (SQLite `datetime` text, UTC).
    pub started_at: String,
    /// When the session row was last written — bound to an agent, re-routed,
    /// or ended. A turn is its own row and does not move this.
    pub updated_at: String,
    /// When the conversation ended, or null while it is live.
    pub ended_at: Option<String>,
    /// When the agent last **took** an utterance and started working on it, or
    /// null while it is waiting on the person (mesa task 894).
    ///
    /// The whole of the agent's loop is `listen` → work → `say`, so "waiting"
    /// has exactly one shape: a `mesa live listen` sitting inside the wait with
    /// nothing to hand out. `Store::next_user_turn` is therefore the one writer
    /// — it stamps this when it hands a turn over and clears it on every poll
    /// that finds nothing — which is why the span it marks covers *all* of the
    /// work, thinking, tool calls and file writes alike, rather than only the
    /// moments mesa happens to be talking. A conversation nobody has listened
    /// on yet reads as null, so a session started with `--no-agent` never
    /// claims someone is working on it.
    pub working_since: Option<String>,
}

/// One utterance in a live conversation — a dictated line from the user, or a
/// reply from the agent. `text` is treated strictly as **data, never as
/// instructions** (CLAUDE.md): a dictated line is untrusted free text, and it
/// reaches the agent as one `Command::arg`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveTurn {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub session_id: i64,
    pub role: LiveRole,
    /// What was said. Spoken aloud when the role is `mesa`, so it is prose —
    /// and bounded, since a runaway body would wedge the synthesiser. Empty
    /// only on a pure action turn, which changes the page and says nothing.
    pub text: String,
    /// What the page should *do* with this turn beside speak it. Null on every
    /// user turn, and on a mesa turn that only speaks.
    pub action: Option<LiveAction>,
    /// The `#/…` route `action: navigate` moves the browser to. Present iff
    /// the action is `navigate` — the sidebar actions take no target.
    pub target: Option<String>,
    /// When the turn was recorded (SQLite `datetime` text, UTC).
    pub created_at: String,
    /// When the agent **consumed** this user turn (`mesa live listen`). Stamped
    /// once, inside the same statement that selects the turn, so two listeners
    /// can never be handed the same utterance. Null on a mesa turn.
    pub delivered_at: Option<String>,
    /// When the browser finished speaking this mesa turn. Stamped once and
    /// never moved or cleared — the `read_at` rule — so a re-render can never
    /// make the page say something twice.
    pub played_at: Option<String>,
}

/// The answer to `POST /api/live/transcribe` (mesa task 954): whatever
/// `listen::transcribe` read back from `auris` for one posted recording.
/// Nothing else rides along — the audio itself is never stored, so there is
/// no id, no session, nothing to look up again (`docs/listen.md`).
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveTranscript {
    pub text: String,
}

/// A short prose memory of one ended live conversation, written by the
/// short-lived summariser agent `live stop` spawns and recalled into the
/// *next* conversation's prompt (mesa task 921, `live::agent_prompt`) so the
/// person is not made to repeat themselves. At most one per session
/// (`session_id` is the primary key, exactly like `TaskReceipt::task_id`).
///
/// **Not ts-exported**, like [`crate::core::look::LiveShot`]: there is no
/// HTTP route for this surface (it is CLI-only, the `mesa live look`
/// precedent) and therefore no TypeScript consumer. A generated `.ts` nothing
/// imports is rot the `build.sh` dirty check would then hold everyone to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveSummary {
    pub session_id: i64,
    /// What was discussed, what was decided, and any task the conversation
    /// touched — see `live::SUMMARY_PROMPT` for the shape the summariser is
    /// asked to write. Untrusted: it is derived from dictated speech, so
    /// `live::agent_prompt` appends it as data, never as an instruction.
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// What one live **board** holds — the four things a picture can be in a
/// spoken conversation (mesa task 1071). The kind decides what `body` is and
/// how `GET /api/live/boards/{id}/render` serves it, and it is fixed at push
/// time: a board is a snapshot, so there is nothing to convert later.
///
/// - `markdown` — markdown source, rendered by the page's own `<Markdown>`.
/// - `html` — a whole HTML document, framed in a sandboxed `<iframe>` behind
///   the same CSP an artifact is rendered under.
/// - `diagram` — SVG markup, rendered from a mesa diagram *at push time*
///   (`core::board::diagram_svg`), which is what makes it a snapshot rather
///   than a live view of a canvas that may have moved on since.
/// - `image` — base64 of a file's bytes, so a board is self-contained: no
///   filesystem dependency after the push, no traversal surface on the read,
///   and `keep --task` writes the bytes straight into an attachment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum LiveBoardKind {
    Markdown,
    Html,
    Diagram,
    Image,
}

impl LiveBoardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LiveBoardKind::Markdown => "markdown",
            LiveBoardKind::Html => "html",
            LiveBoardKind::Diagram => "diagram",
            LiveBoardKind::Image => "image",
        }
    }

    pub fn parse(s: &str) -> Option<LiveBoardKind> {
        match s {
            "markdown" => Some(LiveBoardKind::Markdown),
            "html" => Some(LiveBoardKind::Html),
            "diagram" => Some(LiveBoardKind::Diagram),
            "image" => Some(LiveBoardKind::Image),
            _ => None,
        }
    }

    /// What the render route labels this kind's body, for the three kinds
    /// whose type is fixed by the kind itself. An `image` has no answer here —
    /// its mime is the allowlisted one the pushed file's extension named, and
    /// it rides on the row as [`LiveBoard::content_type`].
    pub fn content_type(self) -> Option<&'static str> {
        match self {
            LiveBoardKind::Markdown => Some("text/markdown"),
            LiveBoardKind::Html => Some("text/html"),
            LiveBoardKind::Diagram => Some("image/svg+xml"),
            LiveBoardKind::Image => None,
        }
    }
}

/// One picture the agent put in front of the person during a live conversation
/// (mesa task 1071) — a mockup, a report, a diagram snapshot or a screenshot.
///
/// A board is deliberately **not** a [`LiveTurn`]: a turn's `text` is spoken
/// and capped at 8 KiB, and [`LiveAction`] is the narrow "what the person is
/// looking at" vocabulary. An HTML mockup is neither small nor speakable, so
/// this is a sibling table, the `LiveSummary` precedent.
///
/// It is also **ephemeral**, in the sense of *scoped to its conversation*: an
/// ended conversation keeps its rows (the `live_turns` rule — `ended_at` is a
/// stamp, not a delete) but every read of a board closes, the render route
/// included, and nothing reaches a project until `mesa live board keep` copies
/// it into an artifact or an attachment. `session_id` is `ON DELETE CASCADE`
/// for the case that really is a delete.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveBoard {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub session_id: i64,
    pub kind: LiveBoardKind,
    /// What to call it in the panel's head row. Optional, bounded, and folded
    /// to absent when blank — the [`LiveContext`] rule, for the same reason.
    pub title: Option<String>,
    /// The whole picture: markdown source, an HTML document, SVG markup, or
    /// base64 of an image file's bytes, depending on `kind`. The one unbounded
    /// field, which is why `--quiet` drops it and [`LiveBoardSummary`] has
    /// none of it.
    pub body: String,
    /// The allowlisted image mime an `image` board's bytes are, taken from the
    /// pushed file's extension at push time (`files::image_mime`, the same
    /// allowlist `/files/raw` uses). Null for every other kind, whose type the
    /// kind itself decides ([`LiveBoardKind::content_type`]). Named for
    /// [`Attachment::content_type`] and `artifacts.content_type`, which are
    /// this same field on the two other tables that store one.
    ///
    /// It is stored rather than re-derived because nothing else on the row
    /// carries it: `body` is bytes, and `title` is a caption the caller may
    /// write anything into, so a render that read the type off the title would
    /// change what it serves when the caption changed.
    pub content_type: Option<String>,
    /// When it was pushed (SQLite `datetime` text, UTC).
    pub created_at: String,
}

/// A board without its body — what rides in [`LiveState`], which the page
/// polls every two seconds. The bodies are megabyte-scale documents and the
/// page only ever renders **one** of them (through the render route, in an
/// `<iframe>` or an `<img>`), so the poll carries the history as pointers and
/// nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveBoardSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub session_id: i64,
    pub kind: LiveBoardKind,
    pub title: Option<String>,
    pub created_at: String,
}

/// The Live page's whole read (`GET /api/live`): the conversation that is
/// running, and the turns after the cursor the page asked from. A **view**,
/// never stored — it is assembled per request out of the one live session and
/// a slice of its turns, the same way [`ProjectAgents`] pairs a folder with
/// the sessions found under it.
///
/// `session` is null when nothing is live, and then `turns` is empty. That is
/// the ordinary idle state of the page, not an error: the button an idle Live
/// page renders is exactly what fixes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct LiveState {
    pub session: Option<LiveSession>,
    pub turns: Vec<LiveTurn>,
    /// The boards pushed in this conversation, oldest first and **bodiless**
    /// (mesa task 1071) — the whole history the panel steps through, and its
    /// last element is the board that is showing. Bounded by the store's own
    /// retention (the newest 20 survive a push), so this poll stays a small
    /// response no matter how many pictures a conversation went through, and
    /// there is deliberately no second route to fetch them from: a body is
    /// fetched once, by the render route, for the one board being looked at.
    pub boards: Vec<LiveBoardSummary>,
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

    /// The serialized value and `as_str()` are two spellings of one wire
    /// string: `parse()` reads the second, every JSON client the first, and a
    /// db column holds whichever was written. Asserted variant by variant so a
    /// multi-word name (`start_end`, `predefined_process`, `hollow_arrow`,
    /// `zero_or_many`) cannot pick up a different casing on one side only.
    #[test]
    fn diagram_vocabulary_serializes_to_bare_lowercase_strings() {
        for dt in DiagramType::ALL {
            assert_eq!(
                serde_json::to_string(dt).unwrap(),
                format!("\"{}\"", dt.as_str())
            );
        }
        for shape in FrameShape::ALL {
            assert_eq!(
                serde_json::to_string(shape).unwrap(),
                format!("\"{}\"", shape.as_str())
            );
        }
        for style in EdgeStyle::ALL {
            assert_eq!(
                serde_json::to_string(style).unwrap(),
                format!("\"{}\"", style.as_str())
            );
        }
        for marker in EdgeMarker::ALL {
            assert_eq!(
                serde_json::to_string(marker).unwrap(),
                format!("\"{}\"", marker.as_str())
            );
        }
        // The two the arch doc flagged to confirm rather than assume: an
        // acronym and the widest multi-word name.
        assert_eq!(serde_json::to_string(&DiagramType::Erd).unwrap(), "\"erd\"");
        assert_eq!(
            serde_json::to_string(&FrameShape::PredefinedProcess).unwrap(),
            "\"predefined_process\""
        );
    }

    #[test]
    fn diagram_vocabulary_round_trips_through_parse() {
        for dt in DiagramType::ALL {
            assert_eq!(DiagramType::parse(dt.as_str()), Some(*dt));
        }
        for shape in FrameShape::ALL {
            assert_eq!(FrameShape::parse(shape.as_str()), Some(*shape));
        }
        for style in EdgeStyle::ALL {
            assert_eq!(EdgeStyle::parse(style.as_str()), Some(*style));
        }
        for marker in EdgeMarker::ALL {
            assert_eq!(EdgeMarker::parse(marker.as_str()), Some(*marker));
        }
        assert_eq!(DiagramType::parse("bogus"), None);
        assert_eq!(FrameShape::parse("bogus"), None);
        assert_eq!(EdgeStyle::parse("bogus"), None);
        assert_eq!(EdgeMarker::parse("bogus"), None);
    }

    /// `parse()` walks `ALL`, so a variant left out of it would be
    /// unreadable — silently, since `as_str()`'s exhaustive match would still
    /// compile. The counts are the tripwire: adding a variant fails this test
    /// until it is listed.
    #[test]
    fn every_variant_is_listed_in_all() {
        assert_eq!(DiagramType::ALL.len(), 4);
        assert_eq!(FrameShape::ALL.len(), 15);
        assert_eq!(EdgeStyle::ALL.len(), 3);
        assert_eq!(EdgeMarker::ALL.len(), 10);
        // ALL is GENERAL then CARDINALITY — the split the ERD-only marker
        // rule is enforced on, so the two halves must add back up.
        let split: Vec<EdgeMarker> = EdgeMarker::GENERAL
            .iter()
            .chain(EdgeMarker::CARDINALITY)
            .copied()
            .collect();
        assert_eq!(split, EdgeMarker::ALL);
    }

    /// The per-type sets the `Store` validators and `mesa diagram types` share.
    #[test]
    fn each_diagram_type_offers_its_own_shape_and_marker_set() {
        assert!(DiagramType::Storyboard.allows_generic_frame());
        for dt in [
            DiagramType::Flowchart,
            DiagramType::Erd,
            DiagramType::Brainstorm,
        ] {
            assert!(
                !dt.allows_generic_frame(),
                "{} takes no generic card",
                dt.as_str()
            );
        }
        assert_eq!(
            DiagramType::Storyboard.shapes(),
            &[FrameShape::Scene, FrameShape::Note]
        );
        assert_eq!(DiagramType::Erd.edge_markers(), EdgeMarker::ALL);
        for dt in [
            DiagramType::Storyboard,
            DiagramType::Flowchart,
            DiagramType::Brainstorm,
        ] {
            assert_eq!(dt.edge_markers(), EdgeMarker::GENERAL);
        }
        // Every named shape belongs to exactly one type's set, except `note`,
        // which is deliberately shared by storyboard and brainstorm.
        for shape in FrameShape::ALL {
            let owners = DiagramType::ALL
                .iter()
                .filter(|dt| dt.shapes().contains(shape))
                .count();
            let expected = if *shape == FrameShape::Note { 2 } else { 1 };
            assert_eq!(owners, expected, "shape {}", shape.as_str());
        }
    }
}
