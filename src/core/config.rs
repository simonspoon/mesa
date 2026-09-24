//! User config: the hook mesa runs when it starts a coding agent, and the
//! per-model price table the CC Dashboard estimates cost from.
//!
//! mesa spawns an agent from exactly six places — the todo-watcher's
//! dispatch, the inbox-watcher's triage, the Agents surface's "add agent"
//! button, the live conversation's agent, the short-lived agent that
//! writes a live conversation's memory once it ends (mesa task 921), and the
//! dream pass that tidies the live notebook between conversations (mesa task
//! 1152). Each used to be a hardcoded `claude --bg …` argv, so swapping the
//! binary, the persona, or the slash command meant a rebuild. Each is now a
//! **hook** in `~/.mesa/config.json`:
//!
//! ```json
//! {
//!   "commands": {
//!     "todo-watcher":   "claude --bg --agent supervisor --name {name} -- \"/execute-mesa-task {id}\"",
//!     "inbox-watcher":  "claude --bg --agent inbox-triage --name {name} -- \"Triage mesa inbox item {id}.\"",
//!     "agent-spawn":    "claude --bg --model opus --agent supervisor -- {prompt}",
//!     "live-agent":     "claude --bg --agent naru-live --name {name} -- {prompt}",
//!     "live-summary":   "claude --bg --name {name} -- {prompt}",
//!     "live-dream":     "claude --bg --name {name} -- {prompt}"
//!   }
//! }
//! ```
//!
//! ## One mode: every hook is a bash script
//!
//! A value is a **bash script**, run as `bash -c <script>` (mesa task 1143).
//! One line or many — there is no second mode, no newline rule, and a
//! one-line value is simply a one-line script, which is why the defaults
//! above read as the command lines they are and why `cd`, `export`, a pipe
//! or a conditional binary all just work.
//!
//! Each `{placeholder}` is replaced, at the slot it occupies, by its **value
//! shell-quoted for the context it sits in** ([`substitute_script`],
//! [`Ctx::quoted`]): single-quoted in a word position, backslash-escaped
//! inside `"…"` and in an unquoted heredoc body. What bash reads at every slot
//! is therefore a string literal, never syntax — the watchers pass a task
//! name or an inbox body (untrusted free text) as the session `--name`, and a
//! name of `"; rm -rf / #` becomes `'"; rm -rf / #'`, one argument. Wherever
//! bash performs word expansion it does not re-read the result looking for
//! syntax, so a value inside a quoted literal cannot run. There are no
//! `MESA_*` environment variables any more (a saved script that still reads
//! one is migrated on read, [`migrate_env_references`], and refused on save);
//! an absent value is the empty string, since free-form shell text has no
//! token to drop.
//!
//! **Arithmetic evaluation is a second parser** and is the exception.
//! `$(( ))`, `(( ))`, `let "…"`, `[[ x -gt y ]]` and an array subscript all
//! re-read what they are given, and an array subscript inside arithmetic is
//! itself expanded, so `a[$(cmd)]` runs the command however it was quoted on
//! the way in. [`scan_script`] refuses the two spellings it can cheaply see
//! (`$((`, `((`), wherever they are on the context stack; the rest are
//! documented sharp edges in `docs/config.md`, because teaching this lexer
//! bash's arithmetic is a trap.
//!
//! [`scan_script`] is a deliberately coarse lexer, and it is worth being
//! precise about what its mistakes cost now that it decides the bytes bash
//! sees. Every form it emits is inert in every context that expands anything,
//! so a mis-classified context costs a *mangled value* — a single-quoted
//! string read where bash wanted double-quote escaping has stray quote
//! characters in it; an escaped one read as a bare word splits on spaces —
//! never execution. The two contexts where a wrong guess *could* reach
//! execution are not guessed at: the single-quote family (`'…'`, `$'…'`, a
//! quoted heredoc delimiter), where a `'` in the value would close the run,
//! is refused at save time, as is a `` `…` `` (write `$(…)`) and arithmetic.
//! So the lexer is still not asked to be a full bash grammar; it is asked to
//! tell those contexts apart, and the tests pin the shapes a security review
//! once broke an earlier value-substituting draft with.
//!
//! Unlike `hooks.json` (a genuine `sh -c` string, [`crate::core::hooks`]) no
//! value mesa holds ever reaches a shell unquoted.
//!
//! ## Pricing
//!
//! A second, independent section prices model families for the CC Dashboard's
//! cost estimate (mesa task 692):
//!
//! ```json
//! { "pricing": { "claude-opus": {"input": 5.0, "output": 25.0,
//!                                "cache_read": 0.5, "cache_write": 6.25} } }
//! ```
//!
//! Keys are model-family **prefixes** (`starts_with`), values USD per 1M
//! tokens. [`DEFAULT_PRICES`] ships the families mesa knows; the config
//! overlays them and may add prefixes the binary has never heard of, which is
//! the point — a new model family gets priced without a rebuild. See
//! [`PriceTable`].
//!
//! ## Watchers
//!
//! A third, equally independent section tunes the watchers (mesa task 777):
//!
//! ```json
//! { "watchers": { "todo-concurrency": 3 } }
//! ```
//!
//! Two keys: how many agents `serve --watch-todo` may have running **per
//! project** ([`todo_concurrency`]), default [`DEFAULT_TODO_CONCURRENCY`],
//! and how many hours `serve --watch-retro` waits between two
//! retrospectives ([`retro_interval_hours`], mesa task 1158), default
//! [`DEFAULT_RETRO_INTERVAL_HOURS`]. Both read per tick rather than at
//! startup, so an edit lands on the next tick with no restart. See
//! `docs/todo-watcher.md` and `docs/retro.md`.

//!
//! ## Speech
//!
//! A fourth section picks the voice the inbox's play button speaks in (mesa
//! task 822):
//!
//! ```json
//! { "speech": { "voice": "bm_george" } }
//! ```
//!
//! One key, [`VOICE`], read on every press. Absent or blank is **not** a
//! default mesa names: it means no `-v` is passed at all, so the synthesiser's
//! own default applies and an unconfigured install runs the argv it ran before
//! this setting existed. See [`speech_voice`] and `docs/inbox.md`.
//!
//! ## Live
//!
//! A fifth section holds how long a settled dictation draft waits before the
//! page sends it (mesa task 886):
//!
//! ```json
//! { "live": { "auto-send-ms": 2000 } }
//! ```
//!
//! One key, [`LIVE_AUTO_SEND_MS`]. Absent or `null` is the wait mesa ships
//! ([`DEFAULT_LIVE_AUTO_SEND_MS`]). The instruction block a live
//! conversation's agent is spawned with **used to** live here too
//! (`live.prompt`) but moved to the library as of mesa task 919 — it is now
//! the `naru-live` agent definition in the library (mesa task 1068 turned it
//! from a `prompt` into a real agent definition). A `live.prompt` key left
//! behind in a
//! hand-edited file is silently ignored: `LiveSection` simply has no field
//! for it any more. See `docs/live.md`.
//!
//! ## Listen
//!
//! A sixth, independent section names the model `live transcribe` runs the
//! external `auris` speech-to-text binary with (mesa task 955) — the input-side
//! mirror of Speech, above:
//!
//! ```json
//! { "listen": { "model": "parakeet-tdt-0.6b-v2-int8" } }
//! ```
//!
//! One key, [`MODEL`], read on every request. Absent or blank is **not** a
//! default mesa names: it means no `-m` is passed at all, so `auris` picks its
//! own default model and an unconfigured install runs the argv it ran before
//! this setting existed. See [`listen_model`] and `docs/live.md`. A second
//! key, [`ENGINE`] (`"server"` | `"browser"`, default `"server"`, mesa task
//! 1388), names what the **page** listens with.
//!
//! ## Audio
//!
//! A ninth section picks the engine the **server** runs speech through and
//! where the `naru-audio` daemon listens (mesa task 1388):
//!
//! ```json
//! { "audio": { "engine": "naru-audio", "url": "http://127.0.0.1:7870" } }
//! ```
//!
//! [`ENGINE`] is `"legacy"` (the external `auris`/`kokoro-rs` binaries, the
//! built-in) or `"naru-audio"`; [`URL`] defaults to [`audio::DEFAULT_URL`] and
//! `NARU_AUDIO_URL` overrides it. See [`audio_engine`], [`audio_url`] and
//! `docs/config.md`.
//!
//! ## Keymap
//!
//! An eighth section rebinds the web UI's **global** keyboard shortcuts (mesa
//! task 1079). (The seventh, `guard`, is the cost guard's — it has no Settings
//! UI and is documented in `docs/cost-guard.md`.)
//!
//! ```json
//! { "keymap": { "create-task": ["n"], "focus-left": ["a", "ArrowLeft"] } }
//! ```
//!
//! One entry per action mesa binds ([`KEYMAP_ACTIONS`]), holding a **list** of
//! chords because the spatial nav answers to a letter *and* an arrow. An
//! absent action is the chords mesa ships, so defaults are never written —
//! only overrides are. This is the one section nothing in Rust reads: the
//! shortcuts are the page's, and the server's job is to store them and to
//! refuse what the editor refuses — an unknown action, a malformed chord, and
//! a chord bound to two actions at once. See [`save_keymap`] and
//! `docs/keyboard.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::core::audio::{self, AudioEngine};
use crate::core::guard::{GuardAction, GuardThresholds};
use crate::core::listen;
use crate::core::speech;
use crate::core::types::{
    ConfigAudio, ConfigCommand, ConfigGuard, ConfigKeymap, ConfigKeymapAction, ConfigListen,
    ConfigLive, ConfigPrice, ConfigSpeech, ConfigWatchers, ModelRates,
};

/// The todo-watcher's dispatch command (`docs/todo-watcher.md`).
pub const TODO_WATCHER: &str = "todo-watcher";
/// The inbox-watcher's triage command (`docs/inbox-watcher.md`).
pub const INBOX_WATCHER: &str = "inbox-watcher";
/// The Agents surface's "add agent" command (`docs/agents.md`).
pub const AGENT_SPAWN: &str = "agent-spawn";
/// The live conversation's agent (`docs/live.md`).
pub const LIVE_AGENT: &str = "live-agent";
/// The short-lived agent that writes a live conversation's memory once it
/// ends (mesa task 921, `docs/live.md`). Spawned from `live stop`, not from
/// `live start` — it cannot be the live agent's own last act, since stopping
/// a session stops that agent (`claude stop <agent_id>`).
pub const LIVE_SUMMARY: &str = "live-summary";
/// The dream pass over the live notebook (mesa task 1152, `docs/live.md`):
/// `mesa live memory dream` spawns it between conversations, never mid-call,
/// to merge duplicate entries and drop superseded ones one guarded command
/// at a time.
pub const LIVE_DREAM: &str = "live-dream";
/// The session retrospective (mesa task 1158, `docs/retro.md`): spawned by
/// `serve --watch-retro` every `retro-interval-hours`, and by `mesa retro
/// run` on demand, to review finished task sessions for friction and file
/// suggestions into the inbox. Proposes, never edits.
pub const RETRO: &str = "retro";

/// Every configurable command, in the order the docs and the Settings page
/// list them. The single source of truth for "which keys mesa configures" —
/// [`default_command`] answers the same question one key at a time.
pub const ACTIONS: [&str; 7] = [
    TODO_WATCHER,
    INBOX_WATCHER,
    AGENT_SPAWN,
    LIVE_AGENT,
    LIVE_SUMMARY,
    LIVE_DREAM,
    RETRO,
];

/// Built-in default for [`TODO_WATCHER`] — the argv mesa shipped before the
/// config file existed, spelled as a template.
///
/// The program and the agent are both **literal** (mesa task 1141): the
/// defaults are plain, editable command lines, and a user who wants a
/// different binary or a different agent edits the line in Settings rather
/// than reaching for an environment variable mesa never showed them.
/// (`{bin}` and `{agent}` used to stand here; they are no longer placeholders
/// at all — see [`migrate_retired_placeholders`] for what happens to a saved
/// template that still holds them.) The one seam left is
/// `agents::claude_bin`, which substitutes `MESA_CLAUDE_BIN` for the leading
/// `claude` of a **default** template only, so the check scripts' stub binary
/// keeps working; a configured template runs exactly as written.
///
/// The run happens as the `supervisor` agent definition (mesa task 1075,
/// `core::supervisor::SUPERVISOR_DEFINITION`, seeded to
/// `~/.claude/agents/supervisor.md` by
/// `core::supervisor::ensure_agent_definition`), which is where the
/// supervising rules live.
///
/// Note the quotes around the prompt: a slash command and its argument are
/// **one** argv entry (`claude` takes the prompt as a single positional), and
/// tokenization is by whitespace. Unquoted, `/execute-mesa-task {id}` would
/// arrive as two arguments and the id would be lost.
pub const DEFAULT_TODO_WATCHER: &str =
    r#"claude --bg --agent supervisor --name {name} -- "/execute-mesa-task {id}""#;
/// Built-in default for [`INBOX_WATCHER`]; see [`DEFAULT_TODO_WATCHER`]. The
/// triage runs as the `inbox-triage` agent definition (mesa task 1168,
/// `core::inbox_triage::INBOX_TRIAGE_DEFINITION`, seeded to
/// `.claude/agents/inbox-triage.md` before the spawn), named literally; the
/// prompt is one sentence, since the definition holds the whole procedure.
pub const DEFAULT_INBOX_WATCHER: &str =
    r#"claude --bg --agent inbox-triage --name {name} -- "Triage mesa inbox item {id}.""#;
/// Built-in default for [`AGENT_SPAWN`]. No `{id}`/`{name}`: this spawn is
/// driven by a request body, not a mesa record, and the prompt is optional —
/// absent, the `-- {prompt}` pair drops out and the session starts idle. The
/// agent is the literal `supervisor` on opus (mesa task 1188: no `swe` agent
/// exists), seeded by `spawn_project_agent` before the spawn.
pub const DEFAULT_AGENT_SPAWN: &str = "claude --bg --model opus --agent supervisor -- {prompt}";
/// Built-in default for [`LIVE_AGENT`]. The union of the two shapes above: a
/// live session is a mesa record (so it has an `{id}` and a `{name}`) *and*
/// carries a prompt mesa supplies — `core::live::agent_prompt`, the session
/// line and any recalled memory — so the feature works with no user
/// configuration. The conversation runs as the `naru-live` agent definition
/// (mesa task 1068, `core::live::AGENT_DEFINITION`, seeded to
/// `~/.claude/agents/naru-live.md` by `core::live::ensure_agent_definition`),
/// which is where its instructions live; a user who wants another agent edits
/// the name here.
pub const DEFAULT_LIVE_AGENT: &str = "claude --bg --agent naru-live --name {name} -- {prompt}";
/// Built-in default for [`LIVE_SUMMARY`] — identical in shape to
/// [`DEFAULT_LIVE_AGENT`]: the summariser is also a mesa record (a session
/// id and a name) carrying a prompt mesa supplies
/// (`core::live::summary_prompt`), so it works with no user configuration.
/// It names no agent — plain `claude` — since the prompt holds the whole
/// job and an unseeded agent name makes `claude` fail at once.
pub const DEFAULT_LIVE_SUMMARY: &str = "claude --bg --name {name} -- {prompt}";
/// Built-in default for [`LIVE_DREAM`] — [`DEFAULT_LIVE_SUMMARY`]'s shape
/// again: `{id}` is the newest conversation's id, `{name}` a fixed
/// `live memory dream`, and `{prompt}` is `core::live::dream_prompt`, the
/// instructions plus the active notebook. Names no agent, as above.
pub const DEFAULT_LIVE_DREAM: &str = "claude --bg --name {name} -- {prompt}";
/// Built-in default for [`RETRO`] — [`DEFAULT_INBOX_WATCHER`]'s shape: the
/// run is a mesa record (`retro_runs`, so `{id}` is the run id and `{name}`
/// the `naru retro <id>` session name) and the prompt is one sentence, since
/// the `naru-retro` agent definition (mesa task 1158,
/// `core::retro::RETRO_DEFINITION`, seeded to `.claude/agents/naru-retro.md`
/// before the spawn) holds the whole procedure. No `{prompt}`: mesa supplies
/// none.
pub const DEFAULT_RETRO: &str =
    r#"claude --bg --agent naru-retro --name {name} -- "Run mesa session retrospective {id}.""#;

/// The built-in template for `action`, or `None` if `action` isn't one of
/// [`ACTIONS`]. Public so the docs check and the API can report the shipped
/// default.
pub fn default_command(action: &str) -> Option<&'static str> {
    match action {
        TODO_WATCHER => Some(DEFAULT_TODO_WATCHER),
        INBOX_WATCHER => Some(DEFAULT_INBOX_WATCHER),
        AGENT_SPAWN => Some(DEFAULT_AGENT_SPAWN),
        LIVE_AGENT => Some(DEFAULT_LIVE_AGENT),
        LIVE_SUMMARY => Some(DEFAULT_LIVE_SUMMARY),
        LIVE_DREAM => Some(DEFAULT_LIVE_DREAM),
        RETRO => Some(DEFAULT_RETRO),
        _ => None,
    }
}

/// `NARU_CONFIG_FILE` / `MESA_CONFIG_FILE` if set (the test seam, mirroring
/// `MESA_HOOKS_FILE`), else `config.json` in Naru's home directory
/// ([`dot_dir_in`]: `~/.naru`, or `~/.mesa` on an install that predates the
/// rename). That directory may also be the JSON file itself — accepted
/// because "a config in ~/.mesa" reads both ways, and a user who wrote one
/// file shouldn't get silent no-ops.
pub fn config_file() -> PathBuf {
    if let Some(p) = crate::core::env::var("CONFIG_FILE") {
        return PathBuf::from(p);
    }
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    let dot = dot_dir_in(&home);
    if dot.is_file() {
        return dot;
    }
    dot.join("config.json")
}

/// Naru's home directory under `home` (mesa task 1301): `.naru` when it
/// exists, else `.mesa` when *it* exists (an install from before the rename,
/// file or directory), else `.naru` (a fresh install). Nothing is moved —
/// an existing `~/.mesa` simply stays the one in use. The config file, the
/// workspace and `mesa migrate`'s config item all resolve through this.
pub fn dot_dir_in(home: &Path) -> PathBuf {
    let new = home.join(".naru");
    let old = home.join(".mesa");
    if !new.exists() && old.exists() {
        old
    } else {
        new
    }
}

/// `~/.naru/workspace` (or `~/.mesa/workspace`, whichever [`dot_dir_in`]
/// picks), created on demand — the working directory for every
/// agent or shell mesa runs that is **not** bound to a project (the live
/// agent and its summary agent, an inbox-watcher dispatch, an unbound script,
/// the global Terminal page, the `claude attach` client).
///
/// That fallback used to be `$HOME`, but Claude Code never persists folder
/// trust for the home directory — trust accepted there is held for the
/// current session only and is never written to disk, with no setting to
/// change that — so anything interactive mesa started there re-prompted
/// forever. One folder mesa owns gets that prompt answered once.
///
/// Deliberately independent of `MESA_CONFIG_FILE`: that override moves the
/// config *file*, not mesa's home. Never fails — an undeterminable home or an
/// uncreatable directory falls back to the home directory (or `.`) exactly as
/// before, because no spawn should die over a working folder.
pub fn workspace_dir() -> PathBuf {
    match directories::BaseDirs::new() {
        Some(dirs) => workspace_in(dirs.home_dir()),
        None => PathBuf::from("."),
    }
}

/// The body of [`workspace_dir`], taking `home` explicitly so it is testable
/// without touching process-wide env.
fn workspace_in(home: &Path) -> PathBuf {
    let dir = dot_dir_in(home).join("workspace");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => dir,
        Err(_) => home.to_path_buf(),
    }
}

/// The `commands` map. Deliberately not `deny_unknown_fields`: the file is
/// meant to grow other sections, and an unknown key must not break spawning.
#[derive(Debug, Default, Deserialize)]
struct Config {
    #[serde(default)]
    commands: HashMap<String, String>,
}

/// The configured template for `action`: `Ok(None)` when the file or the key
/// is absent, or the value is blank (all three mean "use the built-in
/// default"); `Err` when the file exists but can't be read or parsed — a
/// broken config must be visible, not silently ignored (same rule as
/// `hooks::command_for`).
pub fn command_for(action: &str) -> Result<Option<String>, String> {
    command_in(&config_file(), action)
}

fn command_in(path: &Path, action: &str) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config
        .commands
        .get(action)
        .map(|s| {
            migrate_renamed_agents(&migrate_env_references(&migrate_retired_placeholders(
                s.trim(),
            )))
        })
        .filter(|s| !s.is_empty()))
}

/// Rewrites the two placeholders mesa task 1141 retired — `{bin}` and
/// `{agent}` — into literal values: `claude`, which `{bin}` always resolved
/// to, and `supervisor` for `{agent}`, whose old default `swe` names no agent
/// that exists (mesa task 1188).
///
/// Applied to a template **as it is read** from the config file, every read,
/// in memory: the user's file is never rewritten behind their back. An
/// upgraded install's saved template therefore keeps working with no silent
/// spawn failure; the Settings page shows the already-migrated literal text,
/// so the user's next Save writes the literal form and the file heals itself;
/// and a template *saved anew* with either token is refused by the ordinary
/// unsupported-placeholder rule ([`check_key`]), because
/// the vocabulary no longer offers them — a path the UI can no longer reach,
/// since it never shows those tokens.
///
/// Substring replacement is exact on the braced form, so `{bin: 1}` or a
/// `{prompt:bin}` name is untouched; in a script `"{bin}"` becomes
/// `"claude"`, which is what `MESA_BIN` held. Its sibling
/// [`migrate_env_references`] rewrites the `MESA_*` variables mesa task 1143
/// retired the same way.
pub fn migrate_retired_placeholders(template: &str) -> String {
    template
        .replace("{bin}", "claude")
        .replace("{agent}", "supervisor")
}

/// Rewrites an `--agent` argument naming an agent definition mesa task 1302
/// renamed (`core::library::RENAMED_BUILTINS`: `mesa-live` is `naru-live`,
/// `mesa-retro` is `naru-retro`) to its new name — bare, `"…"`-quoted or
/// `'…'`-quoted, after a space or an `=`. Applied on every read, in memory,
/// exactly like [`migrate_retired_placeholders`]: the file is never
/// rewritten, and the Settings page's next Save writes the new name. Without
/// it, a saved `--agent mesa-live` would spawn a definition nothing seeds any
/// more.
///
/// Only the `--agent` value is touched: a `--name "mesa-live"` beside it is a
/// session label, and a longer name (`mesa-live-v2`) is a different agent.
pub fn migrate_renamed_agents(template: &str) -> String {
    const FLAG: &str = "--agent";
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find(FLAG) {
        let (head, tail) = rest.split_at(at + FLAG.len());
        out.push_str(head);
        rest = tail;
        let sep_len = if rest.starts_with('=') {
            1
        } else {
            rest.len() - rest.trim_start_matches([' ', '\t']).len()
        };
        if sep_len == 0 {
            continue;
        }
        let (sep, value) = rest.split_at(sep_len);
        let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'');
        let inner = if quote.is_some() { &value[1..] } else { value };
        let renamed = crate::core::library::RENAMED_BUILTINS
            .iter()
            .find(|(old, _)| {
                inner.strip_prefix(old).is_some_and(|after| match quote {
                    Some(q) => after.starts_with(q),
                    None => after
                        .chars()
                        .next()
                        .is_none_or(|c| c.is_whitespace() || matches!(c, ';' | '&' | '|' | ')')),
                })
            });
        if let Some((old, new)) = renamed {
            out.push_str(sep);
            out.extend(quote);
            out.push_str(new);
            rest = &inner[old.len()..];
        }
    }
    out.push_str(rest);
    out
}

/// Every action's current setting, for the Settings page
/// (`GET /api/config`): the configured template (`None` = falling back), the
/// built-in default it falls back to, and the placeholders it may use.
///
/// `Err` on a file that exists but can't be read or parsed — the same rule the
/// spawn path follows, for the same reason: a broken config must never read as
/// "unconfigured", least of all on the surface that edits it.
pub fn settings() -> Result<Vec<ConfigCommand>, String> {
    settings_in(&config_file())
}

fn settings_in(path: &Path) -> Result<Vec<ConfigCommand>, String> {
    ACTIONS
        .iter()
        .map(|action| {
            Ok(ConfigCommand {
                action: (*action).to_string(),
                value: command_in(path, action)?,
                default: default_command(action).unwrap_or_default().to_string(),
                placeholders: offered_placeholders(action)
                    .iter()
                    .map(|p| (*p).to_string())
                    .collect(),
            })
        })
        .collect()
}

/// Why a [`save_commands`] call didn't happen. Split so the API can answer
/// 422 for "your template is wrong" and 502 for "this machine's config file is
/// unreadable" — the same split the spawn path already draws.
#[derive(Debug, PartialEq)]
pub enum SaveError {
    /// An unknown key, or a template the spawn path would later reject.
    Validation(String),
    /// The file couldn't be read, parsed or written.
    Unavailable(String),
}

/// Writes the `commands` entries named in `updates` into the config file.
///
/// - A blank value **removes** the key, which is how the Settings page says
///   "back to the built-in default" — the same meaning blank already has on
///   the read side ([`command_in`]).
/// - Every template is validated *before* anything is written, so a rejected
///   save leaves the file exactly as it was and a half-applied batch is not a
///   reachable state.
/// - Keys this call doesn't name, and any other top-level section of the file,
///   are preserved verbatim — the file is documented as free to grow sections
///   mesa doesn't know about, and an editor that silently dropped them would
///   break that promise.
pub fn save_commands(
    updates: &HashMap<String, String>,
    prompts: &Prompts,
) -> Result<(), SaveError> {
    save_commands_in(&config_file(), updates, prompts)
}

fn save_commands_in(
    path: &Path,
    updates: &HashMap<String, String>,
    prompts: &Prompts,
) -> Result<(), SaveError> {
    let mut actions: Vec<&String> = updates.keys().collect();
    actions.sort();
    for action in &actions {
        if default_command(action).is_none() {
            return Err(SaveError::Validation(format!(
                "unknown command {action:?}; mesa configures {}",
                ACTIONS.join(", ")
            )));
        }
        let template = updates[*action].trim();
        if !template.is_empty() {
            validate(action, template, prompts).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let commands = object
        .entry("commands")
        .or_insert_with(|| serde_json::json!({}));
    let Some(commands) = commands.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"commands\" is not a JSON object",
            path.display()
        )));
    };
    for action in actions {
        let template = updates[action].trim();
        if template.is_empty() {
            commands.remove(action);
        } else {
            commands.insert(
                action.clone(),
                serde_json::Value::String(template.to_string()),
            );
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// Write via a sibling temp file + rename, so a spawn reading the config
/// concurrently sees either the old file or the new one, never a truncated
/// one — the file is read on **every** spawn, with no lock between us.
fn write_atomically(path: &Path, body: &str) -> Result<(), SaveError> {
    let unavailable =
        |e: std::io::Error| SaveError::Unavailable(format!("cannot write {}: {e}", path.display()));
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(unavailable)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, body).map_err(unavailable)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        unavailable(e)
    })
}

/// Rejects a template the spawn path would fail on later — a `MESA_*`
/// variable reference mesa no longer sets, a placeholder this action doesn't
/// offer, one sitting where no substitution could go, an unknown library
/// prompt, or a bash syntax error. Every value is supplied, so only
/// template-shaped mistakes are caught here.
///
/// The point is *when* the failure lands: at save time, in the editor, rather
/// than at the next dispatch, in a watcher log the user isn't reading.
pub fn validate(action: &str, template: &str, prompts: &Prompts) -> Result<(), String> {
    let script = template.trim();
    refuse_env_references(action, script)?;
    check_script(action, script, prompts)?;
    let vars = Vars {
        id: Some(1),
        name: Some("name"),
        prompt: Some("prompt"),
        prompts: Some(prompts),
    };
    // Parse what `bash` will actually be handed — placeholders already
    // replaced by quoted values — rather than the template with braces still
    // in it, so the syntax check covers the real shape.
    bash_syntax_check(action, &substitute_script(action, script, &vars)?)
}

/// Resolves one action's configured (or default) `template` into the script
/// `bash -c` runs: the trimmed text with every `{placeholder}` replaced by its
/// value, shell-quoted for the context it sits in ([`substitute_script`]).
/// One mode, one function — the spawn path and the Settings preview can never
/// disagree about what will run.
pub fn resolve(action: &str, template: &str, vars: &Vars) -> Result<String, String> {
    let script = template.trim();
    check_script(action, script, vars.prompts())?;
    substitute_script(action, script, vars)
}

/// The three built-in placeholder names. Per-call data, so each is offered to
/// a subset of the actions ([`offered_placeholders`]); the library's
/// `{prompt:<name>}` form is orthogonal and offered everywhere.
const BUILTIN_PLACEHOLDERS: [&str; 3] = ["id", "name", "prompt"];

/// The `{prompt:<name>}` form's prefix — the one thing that keeps it from
/// colliding with the built-in `{prompt}`, which has no colon.
const PROMPT_PREFIX: &str = "prompt:";

/// The library's `prompt` items, keyed for placeholder resolution — the table
/// `{prompt:<name>}` resolves against (mesa task 1138).
///
/// Built by `core::library::prompts` from the same view `mesa library list`
/// shows, so a db row, an unshadowed built-in and a fork overriding a built-in
/// all resolve here exactly as they do there. The type lives in this module,
/// holding nothing but names and bodies, so `config` stays free of the library:
/// what it needs is a lookup table, not a store.
///
/// Names are matched **case-insensitively**, the rule
/// `Store::find_project_by_name` already sets for every other name an agent
/// types. Two rows whose names differ only in case are the same key; the first
/// in the library's own (kind, name) order wins, so the answer is deterministic
/// rather than whichever row was inserted last.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Prompts {
    by_name: std::collections::BTreeMap<String, String>,
}

/// The table a [`Vars`] with no prompts falls back to: every `{prompt:…}` is
/// then an unknown name, which is an *error* — never a silent empty string.
static NO_PROMPTS: Prompts = Prompts {
    by_name: std::collections::BTreeMap::new(),
};

impl Prompts {
    /// Builds the table from `(name, body)` pairs in the library's own order.
    pub fn new<I: IntoIterator<Item = (String, String)>>(items: I) -> Self {
        let mut by_name = std::collections::BTreeMap::new();
        for (name, body) in items {
            by_name.entry(name.to_lowercase()).or_insert(body);
        }
        Self { by_name }
    }

    /// The body of the prompt named `name`, case-insensitively.
    pub fn body(&self, name: &str) -> Option<&str> {
        self.by_name.get(&name.to_lowercase()).map(String::as_str)
    }

    /// The names this library offers, for the "unknown prompt" error. Already
    /// sorted — a `BTreeMap` — so the message is stable across calls.
    fn offered(&self) -> String {
        if self.by_name.is_empty() {
            return "no prompts".to_string();
        }
        self.by_name
            .keys()
            .map(|n| format!("{{prompt:{n}}}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// The name in `{prompt:<name>}`, if `key` is that form at all.
///
/// The charset mirrors `Store`'s `validate_library_name` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
/// deliberately: anything that is not a name the library could hold is not a
/// placeholder, so `{prompt: see below}` in a script stays the literal text it
/// obviously is rather than becoming a save-time error. Drifting apart costs a
/// library name its placeholder, never a wrong resolution — `Store`'s rule
/// stays the authority on what a name may be.
fn prompt_name(key: &str) -> Option<&str> {
    let name = key.strip_prefix(PROMPT_PREFIX)?;
    let mut chars = name.chars();
    let head = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric());
    let tail = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    (head && tail).then_some(name)
}

/// True when `key` is shaped like a placeholder *name* — letters, digits, `-`
/// and `_`, nothing else. That is what makes `{tsak}` an error while `{id: 1}`,
/// `{ …; }` and `cp a{,.bak}` stay the bash text they obviously are: a brace
/// holding only name characters is nothing to bash (brace expansion needs a
/// `,` or `..`), so it can only have been meant as one of mesa's.
fn is_placeholder_shaped(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// The body of `{prompt:<name>}`, or the "unknown prompt" error naming what
/// the library does offer.
fn prompt_body<'p>(action: &str, name: &str, prompts: &'p Prompts) -> Result<&'p str, String> {
    prompts.body(name).ok_or_else(|| {
        format!(
            "unknown library prompt {{prompt:{name}}} in the {action} command; \
             the library offers {}",
            prompts.offered()
        )
    })
}

/// Rejects a placeholder `key` this action cannot resolve: an unknown library
/// prompt, or a built-in (or a typo shaped like one) the action does not
/// offer. The one rule, asked by [`check_script`] on both the save path and the
/// spawn path and by [`Vars::lookup`] when the value is fetched.
fn check_key(action: &str, key: &str, prompts: &Prompts) -> Result<(), String> {
    if let Some(name) = prompt_name(key) {
        return prompt_body(action, name, prompts).map(|_| ());
    }
    if offered_placeholders(action).contains(&format!("{{{key}}}").as_str()) {
        return Ok(());
    }
    Err(format!(
        "unsupported placeholder {{{key}}} in the {action} command; \
         {action} offers {}",
        offered_list(action)
    ))
}

/// One pass over a resolved prompt body, no recursion: the built-in
/// placeholders this action offers *and* has a value for on this call are
/// replaced; everything else — an unknown name, a nested `{prompt:…}`, an
/// offered placeholder with no value — is left exactly as written.
///
/// Never an error, and that is the point: a library body is **data** an agent
/// or a person wrote, not a template the config author reviewed, so a stray
/// brace in it must not break a hook. The one pass is what bounds it — the
/// text this produces is never rescanned, so a body holding `{prompt:x}`
/// cannot expand, recurse or loop. The result is then quoted as one value like
/// any other ([`Ctx::quoted`]), so nothing in it is ever parsed as shell.
fn expand_body(action: &str, body: &str, vars: &Vars) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(open) = rest.find('{') {
        let (before, from_brace) = rest.split_at(open);
        out.push_str(before);
        let Some(close) = from_brace.find('}') else {
            out.push_str(from_brace);
            return out;
        };
        let key = &from_brace[1..close];
        // Only the three built-in names are ever looked up here, so this cannot
        // reach `{prompt:…}` and cannot recurse.
        match BUILTIN_PLACEHOLDERS
            .contains(&key)
            .then(|| vars.lookup(key, action))
        {
            Some(Ok(Some(value))) => out.push_str(&value),
            _ => out.push_str(&from_brace[..close + 1]),
        }
        rest = &from_brace[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Rejects a script the spawn path would refuse later: an empty body, a
/// `{placeholder}` this action does not offer or a `{prompt:<name>}` the
/// library does not hold, or one sitting somewhere mesa cannot put a value.
///
/// Runs on **both** the save path and the spawn path, so a hand-edited config
/// fails these the same way the editor would have. Its sibling
/// [`bash_syntax_check`] does **not**: `bash -n` is save-time only, so a
/// hand-edited file may hold a script that parses badly, and that surfaces as a
/// failed spawn. Deliberate — a `bash` subprocess on every dispatch would cost
/// more than it catches, and the failure is already visible and harmless.
fn check_script(action: &str, script: &str, prompts: &Prompts) -> Result<(), String> {
    if script.is_empty() {
        return Err(format!("the {action} command is empty"));
    }
    for slot in scan_script(script) {
        let key = slot.key;
        check_key(action, key, prompts)?;
        // Asked of the whole stack, and asked *first*: a placeholder nested
        // inside arithmetic wears whatever context encloses it most closely,
        // and that context on its own looks perfectly substitutable.
        if slot.in_arith
            && let Some((place, fix)) = Ctx::Arith.refusal()
        {
            return Err(format!(
                "{{{key}}} in the {action} command sits {place}, where mesa \
                 will not put a value — {fix}"
            ));
        }
        if let Some((place, fix)) = slot.ctx.refusal() {
            return Err(format!(
                "{{{key}}} in the {action} command sits {place}, where mesa \
                 will not put a value — {fix}"
            ));
        }
    }
    Ok(())
}

/// The three variable names a script used to read its values through, before
/// mesa task 1143, and the placeholder each one is now.
const RETIRED_ENV: [(&str, &str); 3] = [
    ("MESA_ID", "{id}"),
    ("MESA_NAME", "{name}"),
    ("MESA_PROMPT", "{prompt}"),
];

/// The prefix of the variable a script used to read a library prompt through
/// (`{prompt:stop-notify}` travelled as `MESA_PROMPT_STOP_NOTIFY`).
const RETIRED_PROMPT_ENV_PREFIX: &str = "MESA_PROMPT_";

/// The reference to a retired `MESA_*` variable starting at byte `at` of
/// `text` (which must be a `$`), as `(placeholder, end)`: `$MESA_ID`,
/// `${MESA_ID}`, `${MESA_ID-}` and `$MESA_PROMPT_<NAME>` in the same three
/// forms. `None` for any other `$`. A bare `$MESA_ID` must end where an
/// identifier would — `$MESA_IDX` is some other variable.
fn retired_env_reference(text: &str, at: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let braced = bytes.get(at + 1) == Some(&b'{');
    let start = if braced { at + 2 } else { at + 1 };
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    let var = &text[start..end];
    let placeholder = if let Some((_, p)) = RETIRED_ENV.iter().find(|(v, _)| *v == var) {
        (*p).to_string()
    } else {
        let name = var.strip_prefix(RETIRED_PROMPT_ENV_PREFIX)?;
        if name.is_empty() {
            return None;
        }
        format!("{{prompt:{}}}", name.to_ascii_lowercase().replace('_', "-"))
    };
    if braced {
        if bytes.get(end) == Some(&b'-') {
            end += 1;
        }
        if bytes.get(end) != Some(&b'}') {
            return None;
        }
        end += 1;
    }
    Some((placeholder, end))
}

/// Rewrites the `MESA_*` variable references a script saved before mesa task
/// 1143 read its values through — `$MESA_ID`, `${MESA_ID}`, `${MESA_ID-}`,
/// each optionally wrapped in `"…"`, and the `MESA_PROMPT_<NAME>` forms — into
/// the `{placeholder}` each one meant, with the prompt name lowercased and
/// `_` folded to `-`.
///
/// Applied on **read**, in memory, exactly like [`migrate_retired_placeholders`]
/// and for the same reason: mesa no longer sets those variables, so a script
/// left reading them would read empty strings and silently start an agent
/// with no id, no name and no instructions. The enclosing `"…"` is consumed
/// because the placeholder arrives quoted already; a bare `$MESA_ID` becomes a
/// bare `{id}`, which is quoted for wherever it sits. A migrated prompt name
/// the library no longer holds fails the spawn with the ordinary unknown-prompt
/// error rather than starting anything. One caveat: the old encoding folded
/// `_` to `_` and `-` to `_` alike and uppercased, so it cannot be undone
/// exactly — a prompt really named `a_b` or `A-B` migrates to `{prompt:a-b}`,
/// and that spawn fails with the same unknown-prompt error until the hook is
/// edited to name it.
pub fn migrate_env_references(template: &str) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$'
            && let Some((placeholder, mut end)) = retired_env_reference(template, i)
        {
            if out.ends_with('"') && bytes.get(end) == Some(&b'"') {
                out.pop();
                end += 1;
            }
            out.push_str(&placeholder);
            i = end;
            continue;
        }
        let ch = template[i..].chars().next().unwrap_or_default();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Refuses a template that still reads one of the retired `MESA_*` variables
/// — the save-time half of [`migrate_env_references`]. A hand-typed
/// `"$MESA_NAME"` would otherwise save fine and read as the empty string on
/// every spawn, which is exactly the silent failure the read-time migration
/// exists to prevent for the files that already hold it.
fn refuse_env_references(action: &str, script: &str) -> Result<(), String> {
    let mut i = 0;
    while let Some(off) = script[i..].find('$') {
        let at = i + off;
        if let Some((placeholder, end)) = retired_env_reference(script, at) {
            return Err(format!(
                "the {action} command reads {}, but mesa no longer sets MESA_* \
                 variables; write {placeholder} instead — a {{placeholder}} arrives \
                 quoted for wherever it sits",
                &script[at..end]
            ));
        }
        i = at + 1;
    }
    Ok(())
}

/// The shell context a `{placeholder}` sits in — which quoting
/// [`substitute_script`] gives the value there, or whether it can put a value
/// there at all.
///
/// A value is spliced into the script **quoted for its context**, so what
/// bash reads is a string literal, never syntax. That makes this lexer's
/// verdict matter: getting a context wrong means quoting for the wrong one.
/// What that costs is bounded, and worth stating plainly. The forms mesa
/// emits are all *inert in every context that expands anything*: a
/// single-quoted value read where bash expected double-quote escaping is a
/// value with stray quote characters in it, and a backslash-escaped value read
/// in a plain-word position is one that word-splits — a mangled string, never
/// execution. The two ways a mis-lex *could* reach execution are ruled out by
/// construction: the single-quote family (`'…'`, `$'…'`, a quoted heredoc
/// delimiter) is refused rather than guessed at, since a value that happened
/// to hold a `'` would close the run; and arithmetic is refused wherever it
/// is on the stack, since it re-parses what it is given. So the lexer is
/// still not a security boundary a bash grammar has to be trusted to — the
/// refusals are — but the contexts it does classify now change the bytes bash
/// sees, which the earlier reference-substituting design could shrug at.
#[derive(PartialEq, Clone, Copy, Debug)]
enum Ctx {
    /// Ordinary script text.
    Plain,
    /// Inside `(…)`. Tracked only so its `)` cannot close a `$(` that is not
    /// there — the bug that made `"$( (uname) ; … {name} )"` come out
    /// mis-typed under an earlier, value-substituting draft.
    Subshell,
    /// Inside `$(…)` — a fresh command context, not a continuation of whatever
    /// encloses it, which is why `"$(echo {name})"` is not double-quoted.
    CmdSub,
    /// Inside `$((…))` or `((…))` arithmetic. **Refused**, because arithmetic
    /// evaluation is a *second parser*: it re-reads what it is given, and an
    /// array subscript inside it is itself expanded, so a value of
    /// `a[$(cmd)]` runs the command — however it was quoted on the way in.
    /// The two spellings the lexer can cheaply see are refused; `[[ x -gt y ]]`,
    /// `let "…"` and `${x[…]}` are not lexically bracketed in any way this
    /// deliberately coarse lexer should model, and stay documented sharp edges
    /// (`docs/config.md`).
    Arith,
    /// Inside `"…"`, and also `$"…"`: the value is backslash-escaped rather
    /// than wrapped in quotes of its own.
    Double,
    /// Inside `'…'` — refused: a `'` in the value would end the run.
    Single,
    /// Inside `$'…'`, bash's **ANSI-C quoting**, where `\n`/`\x41` are
    /// interpreted and `\'` does not close the run. Lexically it is not `'…'`
    /// at all; conflating the two is what let a value escape in an earlier
    /// draft. Refused.
    AnsiC,
    /// Inside `` `…` ``. Refused — its quoting rules differ from `$(…)`'s just
    /// enough not to guess, and `$(…)` is right there.
    Backtick,
    /// After an unquoted `#`, to the end of the line. Nothing here is read, so
    /// the one thing that matters is that the value cannot *leave* the comment:
    /// its newlines are folded ([`Ctx::quoted`]).
    Comment,
    /// A heredoc body whose delimiter was unquoted: expansions happen, quotes
    /// are literal text, and only `\`, `$` and `` ` `` can be escaped.
    Heredoc,
    /// A heredoc body whose delimiter was quoted (`<<'EOF'`): nothing expands
    /// and nothing escapes, so there is no way to put a value there. Refused.
    HeredocQuoted,
    /// The **delimiter word** of a heredoc — `cat <<{name}`. Not a place a
    /// value could go at all: the word is a label bash matches the closing line
    /// against. It is a context only so that this one spot errors like every
    /// other impossible one, instead of silently leaving the braces in place.
    HeredocDelimiter,
}

impl Ctx {
    /// `Some((where it is, what to do))` for a context mesa will not put a
    /// value into — the phrase the save-time error names it by, and the fix.
    fn refusal(self) -> Option<(&'static str, &'static str)> {
        match self {
            Ctx::Single => Some((
                "inside '…' single quotes",
                "move it outside the quotes; it arrives quoted already",
            )),
            Ctx::AnsiC => Some((
                "inside $'…' ANSI-C quotes",
                "move it outside the quotes; it arrives quoted already",
            )),
            Ctx::HeredocQuoted => Some((
                "inside a heredoc whose delimiter is quoted",
                "unquote the delimiter, or move it outside the heredoc",
            )),
            Ctx::Backtick => Some(("inside `…` command substitution", "write $(…) instead")),
            Ctx::Arith => Some((
                "inside $(( )) arithmetic",
                "arithmetic re-parses what it is given, so a value there could \
                 run a command however it was quoted; mesa will not put one there",
            )),
            Ctx::HeredocDelimiter => Some((
                "in a heredoc's delimiter word",
                "a delimiter is a label bash matches, not text it expands; \
                 name it something fixed",
            )),
            _ => None,
        }
    }

    /// `value`, quoted so that bash reads it here as exactly that string:
    /// - **single-quoted** in a word position (`Plain`, a subshell, a `$(…)`),
    ///   with a `'` in the value spelled `'\''` — nothing else is special
    ///   inside `'…'`, newlines included, so a value with spaces stays one word
    ///   and a `*` never globs;
    /// - **backslash-escaped** inside `"…"` — `\`, `"`, `$` and `` ` `` are the
    ///   four characters that mean anything there (history expansion is off in
    ///   a non-interactive shell, so `!` is not one);
    /// - **backslash-escaped** in an unquoted heredoc body too, where only `\`,
    ///   `$` and `` ` `` can be escaped and a `"` is literal text. One shape a
    ///   heredoc cannot carry as text is a value holding a **newline**: bash
    ///   reads the body line by line for its delimiter *before* any of it is
    ///   expanded, so a line of the value equal to `EOF` would end the heredoc
    ///   and hand the rest to the parser. Such a value (and one starting with
    ///   a tab, which `<<-` would strip) rides in through `$(printf '%s' $'…')`
    ///   instead — one line of body, the newlines as `\n` inside ANSI-C
    ///   quoting, so no line of it can match anything. The one cost is that
    ///   `$(…)` drops trailing newlines;
    /// - in a **comment**, the value with its newlines folded to spaces: it is
    ///   never read, and the one thing that must not happen is a second line
    ///   of it leaving the comment.
    ///
    /// The refused contexts never reach here — [`check_script`] refuses them
    /// on both paths — so they quote as a word position; failing safe rather
    /// than emitting nothing.
    fn quoted(self, value: &str) -> String {
        match self {
            Ctx::Double => backslash_escaped(value, &['\\', '"', '$', '`']),
            Ctx::Heredoc if value.contains('\n') || value.starts_with('\t') => {
                format!("$(printf '%s' {})", ansi_c_quoted(value))
            }
            Ctx::Heredoc => backslash_escaped(value, &['\\', '$', '`']),
            Ctx::Comment => single_quoted(&value.replace('\n', " ")),
            _ => single_quoted(value),
        }
    }
}

/// `'…'` with every `'` in the value spelled `'\''`.
fn single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// `value` with a backslash before each character in `specials`.
fn backslash_escaped(value: &str, specials: &[char]) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if specials.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `$'…'` — bash's ANSI-C quoting — carrying `value` with no literal newline
/// in it: `\` as `\\`, `'` as `\'`, a newline as `\n`. Everything else is
/// literal inside `$'…'`.
fn ansi_c_quoted(value: &str) -> String {
    let mut out = String::from("$'");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// One `{placeholder}` a script body holds: the byte span of `{…}`, the name,
/// and the shell context around it.
struct ScriptSlot<'a> {
    open: usize,
    end: usize,
    key: &'a str,
    ctx: Ctx,
    /// True when **any** frame of the stack is [`Ctx::Arith`], not just the
    /// top. Arithmetic is a property of the *enclosing* context: a nested
    /// `$(…)` pushes [`Ctx::CmdSub`] on top of it, and arithmetic then
    /// re-reads that substitution's **output**, so `$(( $(echo {name}) ))` is
    /// every bit as live as `$(( {name} ))`. One bool rather than any new
    /// lexer knowledge.
    in_arith: bool,
}

/// Every `{placeholder}` in a script, in order, each tagged with its [`Ctx`].
///
/// A coarse, deliberately approximate lexer over bash's quoting forms — see
/// [`Ctx`] for what approximate costs here. It tracks a **stack**, because
/// `"…"` and `'…'` nest inside `$(…)` and vice versa and only the innermost one
/// decides how a value is quoted.
///
/// A slot is a brace holding a placeholder-shaped name
/// ([`is_placeholder_shaped`]) or a `{prompt:<name>}`, and only when the `{`
/// is not preceded by `$` — a script's own `${HOME}` is a parameter expansion
/// bash owns. Anything else — `cp a{,.bak}`, `{ …; }`, `{id: 1}` — is not a
/// placeholder at all and passes through literally, because a script body is
/// bash source in which braces are ordinary text. A placeholder-shaped name
/// mesa does not know (`{tsak}`) is a slot, and therefore an error: bash has
/// no use for `{tsak}` either, so it can only be a typo.
fn scan_script(script: &str) -> Vec<ScriptSlot<'_>> {
    let bytes = script.as_bytes();
    let len = bytes.len();
    let mut slots = Vec::new();
    let mut stack = vec![Ctx::Plain];
    let mut pending: Option<(String, bool, bool)> = None;
    let mut delim = String::new();
    let mut strip = false;
    let mut line_start = true;
    let mut i = 0;
    while i < len {
        let top = *stack.last().unwrap_or(&Ctx::Plain);
        let c = bytes[i];
        if c == b'\n' {
            if top == Ctx::Comment {
                stack.pop();
            }
            if matches!(
                stack.last(),
                Some(Ctx::Plain | Ctx::Subshell | Ctx::CmdSub | Ctx::Arith)
            ) && let Some((d, s, quoted)) = pending.take()
            {
                delim = d;
                strip = s;
                stack.push(if quoted {
                    Ctx::HeredocQuoted
                } else {
                    Ctx::Heredoc
                });
            }
            i += 1;
            line_start = true;
            continue;
        }
        let starts_line = line_start;
        line_start = false;
        if matches!(top, Ctx::Heredoc | Ctx::HeredocQuoted) && starts_line {
            let end = script[i..].find('\n').map_or(len, |n| i + n);
            let line = &script[i..end];
            let candidate = if strip {
                line.trim_start_matches('\t')
            } else {
                line
            };
            if candidate == delim {
                stack.pop();
            }
        }
        let top = *stack.last().unwrap_or(&Ctx::Plain);
        // A backslash escapes the next character everywhere it is special at
        // all — which inside `$'…'` is what keeps `\'` from closing the run.
        if matches!(
            top,
            Ctx::Plain | Ctx::Subshell | Ctx::CmdSub | Ctx::Arith | Ctx::Double | Ctx::AnsiC
        ) && c == b'\\'
        {
            i += 2;
            continue;
        }
        if c == b'{'
            && let Some(slot) = slot_at(script, i, top, stack.contains(&Ctx::Arith))
        {
            i = slot.end;
            slots.push(slot);
            continue;
        }
        match top {
            Ctx::Plain | Ctx::Subshell | Ctx::CmdSub | Ctx::Arith => match c {
                // `$'…'` is ANSI-C quoting, not a single-quoted string.
                b'\'' if i > 0 && bytes[i - 1] == b'$' => stack.push(Ctx::AnsiC),
                b'\'' => stack.push(Ctx::Single),
                b'"' => stack.push(Ctx::Double),
                b'`' => stack.push(Ctx::Backtick),
                b')' if top == Ctx::Arith && bytes.get(i + 1) == Some(&b')') => {
                    stack.pop();
                    i += 2;
                    continue;
                }
                b')' if matches!(top, Ctx::Subshell | Ctx::CmdSub) => {
                    stack.pop();
                }
                b'$' if bytes.get(i + 1) == Some(&b'(') => {
                    // `$((` is arithmetic, `$( (` is a subshell inside a
                    // command substitution — the space is what tells them
                    // apart, in bash as here.
                    if bytes.get(i + 2) == Some(&b'(') {
                        stack.push(Ctx::Arith);
                        i += 3;
                    } else {
                        stack.push(Ctx::CmdSub);
                        i += 2;
                    }
                    continue;
                }
                // `((` is arithmetic; `( (` — with the space — is a subshell
                // inside a subshell, exactly as bash reads them.
                b'(' if bytes.get(i + 1) == Some(&b'(') => {
                    stack.push(Ctx::Arith);
                    i += 2;
                    continue;
                }
                b'(' => stack.push(Ctx::Subshell),
                b'#' if i == 0
                    || matches!(
                        bytes[i - 1],
                        b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')'
                    ) =>
                {
                    stack.push(Ctx::Comment)
                }
                b'<' if bytes.get(i + 1) == Some(&b'<') => {
                    i = read_heredoc(script, i, &mut pending, &mut slots);
                    continue;
                }
                _ => {}
            },
            Ctx::Double => match c {
                b'"' => {
                    stack.pop();
                }
                b'`' => stack.push(Ctx::Backtick),
                b'$' if bytes.get(i + 1) == Some(&b'(') => {
                    if bytes.get(i + 2) == Some(&b'(') {
                        stack.push(Ctx::Arith);
                        i += 3;
                    } else {
                        stack.push(Ctx::CmdSub);
                        i += 2;
                    }
                    continue;
                }
                _ => {}
            },
            Ctx::Single | Ctx::AnsiC => {
                if c == b'\'' {
                    stack.pop();
                }
            }
            Ctx::Backtick => {
                if c == b'`' {
                    stack.pop();
                }
            }
            // An unquoted heredoc body performs no command parsing, but it
            // does perform command and arithmetic expansion — the latter the
            // one thing that can turn a value there into a command.
            Ctx::Heredoc => {
                if c == b'$' && bytes.get(i + 1) == Some(&b'(') {
                    // `$((` first — it is the longer match, and the one that
                    // matters. `$(` is an ordinary command context, so a
                    // placeholder inside it gets the single-quoted form and
                    // keeps the no-word-split, no-glob promise that a heredoc
                    // body's escaped form could not make there.
                    if bytes.get(i + 2) == Some(&b'(') {
                        stack.push(Ctx::Arith);
                        i += 3;
                    } else {
                        stack.push(Ctx::CmdSub);
                        i += 2;
                    }
                    continue;
                }
            }
            Ctx::Comment | Ctx::HeredocQuoted | Ctx::HeredocDelimiter => {}
        }
        i += 1;
    }
    slots
}

/// The placeholder opening at `open`, if that `{` opens one at all.
fn slot_at(script: &str, open: usize, ctx: Ctx, in_arith: bool) -> Option<ScriptSlot<'_>> {
    if open > 0 && script.as_bytes()[open - 1] == b'$' {
        return None;
    }
    let rest = &script[open + 1..];
    let close = rest.find('}')?;
    let key = &rest[..close];
    (is_placeholder_shaped(key) || prompt_name(key).is_some()).then(|| ScriptSlot {
        open,
        end: open + 1 + close + 1,
        key,
        ctx,
        in_arith,
    })
}

/// Reads the heredoc delimiter a `<<` at `i` introduces into `pending` — the
/// word, whether `<<-` strips tabs, and whether the word was **quoted**, which
/// is what decides whether the body expands anything at all. Answers the offset
/// to carry on scanning from. `<<<` is a herestring, not a heredoc.
fn read_heredoc<'a>(
    script: &'a str,
    i: usize,
    pending: &mut Option<(String, bool, bool)>,
    slots: &mut Vec<ScriptSlot<'a>>,
) -> usize {
    let bytes = script.as_bytes();
    let mut j = i + 2;
    if bytes.get(j) == Some(&b'<') {
        return j + 1;
    }
    let mut strip = false;
    if bytes.get(j) == Some(&b'-') {
        strip = true;
        j += 1;
    }
    while matches!(bytes.get(j), Some(b' ' | b'\t')) {
        j += 1;
    }
    let start = j;
    while let Some(&c) = bytes.get(j) {
        if matches!(
            c,
            b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>'
        ) {
            break;
        }
        j += 1;
    }
    let raw = &script[start..j];
    // The word is consumed here rather than by the main loop, so a placeholder
    // written as a delimiter would otherwise be neither substituted nor
    // refused.
    for (at, _) in raw.match_indices('{') {
        if let Some(mut slot) = slot_at(script, start + at, Ctx::Plain, false) {
            slot.ctx = Ctx::HeredocDelimiter;
            slots.push(slot);
        }
    }
    let quoted = raw.contains('\'') || raw.contains('"') || raw.contains('\\');
    let word: String = raw
        .chars()
        .filter(|c| *c != '\'' && *c != '"' && *c != '\\')
        .collect();
    if !word.is_empty() {
        *pending = Some((word, strip, quoted));
    }
    j
}

/// Replaces a script's `{placeholder}`s with their **values, shell-quoted for
/// the context each sits in** ([`Ctx::quoted`]) — the one place a value mesa
/// holds meets text a shell will parse.
///
/// What bash is handed is therefore a string literal at every slot: a task
/// name of `"; rm -rf / #` becomes `'"; rm -rf / #'` in a word position and
/// `\"; rm -rf / #` inside `"…"`, and arrives at the program as that one
/// argument. Wherever bash performs word expansion it does not re-read the
/// result looking for syntax, so once the value is inside a quoted literal
/// nothing in it can run. Arithmetic evaluation *does* re-read it and is the
/// exception — see [`Ctx`], which refuses the spellings of it this lexer can
/// see.
///
/// An offered placeholder with no value on this call is the **empty string**
/// (`''` in a word position, nothing inside quotes): free-form shell text has
/// no token to drop, and a value is a value.
fn substitute_script(action: &str, script: &str, vars: &Vars) -> Result<String, String> {
    let mut out = String::with_capacity(script.len());
    let mut cursor = 0;
    for slot in scan_script(script) {
        // `check_script` refuses these on both paths that reach here, so these
        // are unreachable — and an injection chokepoint's unreachable branch
        // must *fail*, not fall through leaving `{name}` in text bash parses.
        if slot.in_arith {
            return Err(format!(
                "the {action} command has {{{key}}} inside arithmetic, where \
                 mesa will not put a value",
                key = slot.key
            ));
        }
        if let Some((place, _)) = slot.ctx.refusal() {
            return Err(format!(
                "the {action} command has {{{key}}} {place}, where mesa will \
                 not put a value",
                key = slot.key
            ));
        }
        let value = vars.lookup(slot.key, action)?.unwrap_or_default();
        out.push_str(&script[cursor..slot.open]);
        out.push_str(&slot.ctx.quoted(&value));
        cursor = slot.end;
    }
    out.push_str(&script[cursor..]);
    Ok(out)
}

/// Parses the script with `bash -n` — a syntax check that executes nothing —
/// so an unbalanced `fi` or an unterminated quote lands in the editor rather
/// than in a watcher log.
///
/// A machine with no `bash` on PATH skips the check rather than failing the
/// save: mesa can't prove the script is wrong there, and refusing to store a
/// value it merely can't inspect would be the worse answer. (Such a machine
/// can't run the script either — that failure belongs at dispatch.)
fn bash_syntax_check(action: &str, script: &str) -> Result<(), String> {
    let out = Command::new("bash")
        .arg("-n")
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .output();
    let Ok(out) = out else { return Ok(()) };
    if out.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&out.stderr);
    let detail = detail.trim();
    Err(format!(
        "the {action} command is not valid bash: {}",
        if detail.is_empty() {
            "syntax error"
        } else {
            detail
        }
    ))
}

/// The values a template's placeholders may resolve to. A `None` field is
/// "not available for this call" and substitutes as the empty string. The
/// program and the agent are not here: since mesa task 1141 a template names
/// both literally (`claude --bg --agent supervisor …`), so there is nothing to fill.
#[derive(Debug, Default, Clone)]
pub struct Vars<'a> {
    pub id: Option<i64>,
    pub name: Option<&'a str>,
    pub prompt: Option<&'a str>,
    /// The library's prompts, for `{prompt:<name>}` (mesa task 1138). Unlike
    /// the three above this is not per-call data but static library text, so
    /// every action offers it — which is why it sits beside them rather than
    /// in any of [`offered_placeholders`]'s per-action subsets. `None` is an
    /// empty library: every `{prompt:…}` is then an unknown name, an error,
    /// never a silent empty string.
    pub prompts: Option<&'a Prompts>,
}

impl<'a> Vars<'a> {
    /// The prompt table to resolve against — [`NO_PROMPTS`] when this call
    /// carries none.
    pub fn prompts(&self) -> &'a Prompts {
        self.prompts.unwrap_or(&NO_PROMPTS)
    }
}

impl Vars<'_> {
    /// `Some(value)` if this placeholder is available, `None` if it is a
    /// recognized placeholder with no value on this call. `Err` for a name
    /// this action doesn't offer, or a library prompt that isn't there.
    fn lookup(&self, key: &str, action: &str) -> Result<Option<String>, String> {
        check_key(action, key, self.prompts())?;
        // `{prompt:<name>}` is orthogonal to the per-action vocabulary below:
        // every action offers it, and an unknown name is an error rather than
        // an empty string, because a hook that silently lost its instructions
        // is worse than one that refuses to start.
        if let Some(name) = prompt_name(key) {
            // `check_key` has already established the body is there.
            let body = self.prompts().body(name).unwrap_or_default();
            return Ok(Some(expand_body(action, body, self)));
        }
        Ok(match key {
            "id" => self.id.map(|i| i.to_string()),
            "name" => self.name.map(str::to_string),
            "prompt" => self.prompt.map(str::to_string),
            _ => None,
        })
    }
}

/// The placeholder names `action` offers, `{}`-delimited and in doc order.
/// Shared by the "unsupported placeholder" error and by [`settings`], so the
/// Settings page can only ever advertise placeholders [`check_key`] actually
/// accepts.
pub fn offered_placeholders(action: &str) -> &'static [&'static str] {
    match action {
        AGENT_SPAWN => &["{prompt}"],
        // The union: a live session (and its summariser, and the dream pass
        // that borrows the newest session's id) is a mesa record *and*
        // carries a prompt.
        LIVE_AGENT | LIVE_SUMMARY | LIVE_DREAM => &["{id}", "{name}", "{prompt}"],
        _ => &["{id}", "{name}"],
    }
}

fn offered_list(action: &str) -> String {
    offered_placeholders(action).join(", ")
}

// ---- pricing (mesa task 692) -------------------------------------------

/// The shipped price table: model-family prefix → USD per 1M tokens, in the
/// order the Settings page lists them. These are the exact numbers `cc.rs`
/// hardcoded before the config could override them.
///
/// `cache_read` ≈ 0.1× input and `cache_write` (5-minute TTL) ≈ 1.25× input,
/// but both are written out rather than derived — a pricing convention is not
/// arithmetic mesa gets to assume on a family it has never seen.
pub const DEFAULT_PRICES: [(&str, ModelRates); 5] = [
    ("claude-fable", rates(10.0, 50.0, 1.0, 12.5)),
    ("claude-mythos", rates(10.0, 50.0, 1.0, 12.5)),
    ("claude-opus", rates(5.0, 25.0, 0.5, 6.25)),
    ("claude-sonnet", rates(3.0, 15.0, 0.3, 3.75)),
    ("claude-haiku", rates(1.0, 5.0, 0.1, 1.25)),
];

const fn rates(input: f64, output: f64, cache_read: f64, cache_write: f64) -> ModelRates {
    ModelRates {
        input,
        output,
        cache_read,
        cache_write,
    }
}

/// The built-in rates for `prefix` as an exact key (not a prefix match), or
/// `None` for a prefix mesa doesn't ship — the pricing twin of
/// [`default_command`].
pub fn default_price(prefix: &str) -> Option<ModelRates> {
    DEFAULT_PRICES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map(|(_, r)| *r)
}

/// The `pricing` map, deserialized on its own so a broken price entry can
/// never take the spawn path down with it (and vice versa): the two sections
/// are independent features that happen to share a file.
#[derive(Debug, Default, Deserialize)]
struct PricingConfig {
    #[serde(default)]
    pricing: HashMap<String, ModelRates>,
}

/// The merged price table: [`DEFAULT_PRICES`] overlaid by the config's
/// `pricing` section. Built **once per request** and passed down — `cc.rs`
/// prices every message through it, so re-reading the file per message would
/// be a per-row `stat`+parse in a hot loop.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PriceTable {
    entries: HashMap<String, ModelRates>,
}

impl PriceTable {
    /// Just the shipped rates — what mesa costs with no config file.
    pub fn builtin() -> PriceTable {
        PriceTable {
            entries: DEFAULT_PRICES
                .iter()
                .map(|(p, r)| ((*p).to_string(), *r))
                .collect(),
        }
    }

    /// Built-ins overlaid by `~/.mesa/config.json`. `Err` when the file exists
    /// but can't be read or parsed — a broken config is visible, never a
    /// silent fall back to the built-in numbers (same rule as the spawn path).
    pub fn load() -> Result<PriceTable, String> {
        Self::load_from(&config_file())
    }

    fn load_from(path: &Path) -> Result<PriceTable, String> {
        let mut table = Self::builtin();
        for (prefix, rates) in read_pricing(path)? {
            table.entries.insert(prefix, rates);
        }
        Ok(table)
    }

    /// The rates for a model id: **longest matching prefix wins**, so
    /// `claude-opus-5-mini` can be priced separately from `claude-opus`. No
    /// match is all-zeros — a synthetic or unknown model gets no estimate
    /// rather than a wrong one.
    pub fn for_model(&self, model: &str) -> ModelRates {
        self.entries
            .iter()
            .filter(|(prefix, _)| model.starts_with(prefix.as_str()))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, r)| *r)
            .unwrap_or(rates(0.0, 0.0, 0.0, 0.0))
    }
}

fn read_pricing(path: &Path) -> Result<HashMap<String, ModelRates>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: PricingConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.pricing)
}

/// Every price row for the Settings page (`GET /api/config/pricing`): the
/// built-in families first in declaration order, then any prefix the user
/// added, sorted. A configured built-in reports both `value` and `default`, so
/// the editor can offer "reset" for one and "remove" for the other.
pub fn pricing() -> Result<Vec<ConfigPrice>, String> {
    pricing_in(&config_file())
}

fn pricing_in(path: &Path) -> Result<Vec<ConfigPrice>, String> {
    let configured = read_pricing(path)?;
    let mut rows: Vec<ConfigPrice> = DEFAULT_PRICES
        .iter()
        .map(|(prefix, default)| ConfigPrice {
            prefix: (*prefix).to_string(),
            value: configured.get(*prefix).copied(),
            default: Some(*default),
        })
        .collect();
    let mut extra: Vec<&String> = configured
        .keys()
        .filter(|k| default_price(k).is_none())
        .collect();
    extra.sort();
    rows.extend(extra.into_iter().map(|prefix| ConfigPrice {
        prefix: prefix.clone(),
        value: configured.get(prefix).copied(),
        default: None,
    }));
    Ok(rows)
}

/// Writes the `pricing` entries named in `updates` into the config file.
///
/// - `None` **removes** the key: for a built-in prefix that restores the
///   shipped rates, for a user-added one it deletes the row outright. Same
///   meaning blank has on the commands side.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`] on purpose: one read-modify-write over the
///   whole document, so `commands` and `pricing` each survive the other's
///   edits along with any section mesa doesn't know.
pub fn save_pricing(updates: &HashMap<String, Option<ModelRates>>) -> Result<(), SaveError> {
    save_pricing_in(&config_file(), updates)
}

fn save_pricing_in(
    path: &Path,
    updates: &HashMap<String, Option<ModelRates>>,
) -> Result<(), SaveError> {
    let mut prefixes: Vec<&String> = updates.keys().collect();
    prefixes.sort();
    for prefix in &prefixes {
        validate_prefix(prefix).map_err(SaveError::Validation)?;
        if let Some(rates) = &updates[*prefix] {
            validate_rates(prefix, rates).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("pricing")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"pricing\" is not a JSON object",
            path.display()
        )));
    };
    for prefix in prefixes {
        match &updates[prefix] {
            None => {
                section.remove(prefix.trim());
            }
            Some(rates) => {
                let value = serde_json::to_value(rates).map_err(|e| {
                    SaveError::Unavailable(format!("cannot serialize the mesa config: {e}"))
                })?;
                section.insert(prefix.trim().to_string(), value);
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// The whole config document as JSON, or `{}` when the file doesn't exist yet.
/// Shared by both savers so neither can invent a second file format.
fn read_config_document(path: &Path) -> Result<serde_json::Value, SaveError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            SaveError::Unavailable(format!("malformed mesa config {}: {e}", path.display()))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(SaveError::Unavailable(format!(
            "cannot read {}: {e}",
            path.display()
        ))),
    }
}

/// A prefix has to be usable as a `starts_with` needle and as a JSON key:
/// non-empty, no whitespace (a model id has none), and bounded so the file
/// can't be stuffed through the editor.
fn validate_prefix(prefix: &str) -> Result<(), String> {
    let trimmed = prefix.trim();
    if trimmed.is_empty() {
        return Err("a model prefix cannot be empty".to_string());
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(format!(
            "the model prefix {trimmed:?} contains whitespace; a model id has none"
        ));
    }
    if trimmed.chars().count() > 64 {
        return Err(format!(
            "the model prefix {trimmed:?} is longer than 64 characters"
        ));
    }
    Ok(())
}

fn validate_rates(prefix: &str, rates: &ModelRates) -> Result<(), String> {
    for (label, value) in [
        ("input", rates.input),
        ("output", rates.output),
        ("cache_read", rates.cache_read),
        ("cache_write", rates.cache_write),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!(
                "the {label} rate for {:?} must be a number ≥ 0, got {value}",
                prefix.trim()
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/// The config key holding the todo-watcher's per-project agent ceiling.
pub const TODO_CONCURRENCY: &str = "todo-concurrency";

/// The config key holding the retrospective's cadence, in hours (mesa task
/// 1158, `docs/retro.md`).
pub const RETRO_INTERVAL_HOURS: &str = "retro-interval-hours";

/// Every key the `watchers` section understands, for the unknown-key error.
const WATCHER_KEYS: &[&str] = &[TODO_CONCURRENCY, RETRO_INTERVAL_HOURS];

/// How long `serve --watch-retro` waits between two retrospectives with no
/// config: three days, the cadence the feature was asked for.
pub const DEFAULT_RETRO_INTERVAL_HOURS: u32 = 72;

/// The longest cadence the editor will write — a year. A sanity bound like
/// [`MAX_TODO_CONCURRENCY`]: a retrospective that never runs is spelled by
/// not passing `--watch-retro`, not by a huge number.
pub const MAX_RETRO_INTERVAL_HOURS: u32 = 8760;

/// How many watcher agents one project may run at once with no config — the
/// value that keeps an unconfigured install byte-identical to mesa before
/// task 777, when the ceiling was hardcoded at one.
pub const DEFAULT_TODO_CONCURRENCY: u32 = 1;

/// The largest limit the editor will write. A **sanity bound, not a policy**:
/// nothing about the dispatch loop breaks above it, but every slot is a real
/// `claude` process on this machine, and a fat-fingered `200` would fork the
/// box rather than the backlog. Raise it here if a real workload wants more.
pub const MAX_TODO_CONCURRENCY: u32 = 20;

/// The `watchers` map, deserialized on its own so a broken watcher value can
/// never take the spawn path (`commands`) or the dashboard (`pricing`) down
/// with it, and vice versa — three independent features sharing one file
/// ([`PricingConfig`] is the model).
#[derive(Debug, Default, Deserialize)]
struct WatchersConfig {
    #[serde(default)]
    watchers: WatchersSection,
}

#[derive(Debug, Default, Deserialize)]
struct WatchersSection {
    #[serde(default, rename = "todo-concurrency")]
    todo_concurrency: Option<u32>,
    #[serde(default, rename = "retro-interval-hours")]
    retro_interval_hours: Option<u32>,
}

fn read_watchers(path: &Path) -> Result<WatchersSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(WatchersSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: WatchersConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.watchers)
}

/// How many agents the todo-watcher may have running per project.
///
/// Read **on every tick**, like [`command_for`] is read on every spawn: that
/// is what makes a change take effect without restarting `mesa serve`. An
/// absent file or key is [`DEFAULT_TODO_CONCURRENCY`]; a file that exists but
/// can't be read or parsed is `Err`, never a silent fall back to 1 — same rule
/// as [`read_pricing`], and the caller (`todo_watcher_tick`) skips the tick
/// rather than dispatch under a guessed limit.
///
/// A hand-edited value outside `1..=MAX_TODO_CONCURRENCY` is **clamped** into
/// it rather than rejected: the bound exists to stop a typo forking the
/// machine, and refusing to dispatch at all would be a worse answer to `0`
/// than treating it as the one-at-a-time it obviously means. The editor still
/// refuses to *write* such a value.
pub fn todo_concurrency() -> Result<u32, String> {
    todo_concurrency_in(&config_file())
}

fn todo_concurrency_in(path: &Path) -> Result<u32, String> {
    Ok(read_watchers(path)?
        .todo_concurrency
        .map(|n| n.clamp(1, MAX_TODO_CONCURRENCY))
        .unwrap_or(DEFAULT_TODO_CONCURRENCY))
}

/// How many hours `serve --watch-retro` waits between two retrospectives
/// (mesa task 1158). [`todo_concurrency`]'s rules exactly: read on every
/// tick (and by `mesa retro run`/`status`), an absent file or key is
/// [`DEFAULT_RETRO_INTERVAL_HOURS`], a hand-edited value outside
/// `1..=MAX_RETRO_INTERVAL_HOURS` is clamped rather than rejected, and a file
/// that can't be read or parsed is `Err`.
pub fn retro_interval_hours() -> Result<u32, String> {
    retro_interval_hours_in(&config_file())
}

fn retro_interval_hours_in(path: &Path) -> Result<u32, String> {
    Ok(read_watchers(path)?
        .retro_interval_hours
        .map(|n| n.clamp(1, MAX_RETRO_INTERVAL_HOURS))
        .unwrap_or(DEFAULT_RETRO_INTERVAL_HOURS))
}

/// The watcher settings for the Settings page (`GET /api/config/watchers`):
/// the configured value (verbatim, or `null` when the file says nothing) plus
/// the built-in default behind it — the `{value, default}` idiom
/// [`ConfigPrice`] and [`ConfigCommand`] already use.
pub fn watchers() -> Result<ConfigWatchers, String> {
    watchers_in(&config_file())
}

fn watchers_in(path: &Path) -> Result<ConfigWatchers, String> {
    let section = read_watchers(path)?;
    Ok(ConfigWatchers {
        todo_concurrency: section.todo_concurrency,
        todo_concurrency_default: DEFAULT_TODO_CONCURRENCY,
        retro_interval_hours: section.retro_interval_hours,
        retro_interval_hours_default: DEFAULT_RETRO_INTERVAL_HOURS,
    })
}

/// Writes the `watchers` entries named in `updates` into the config file.
///
/// - `None` **removes** the key, restoring the built-in default — the same
///   meaning blank has for a command and `null` for a price row.
/// - Values arrive as raw JSON so `2.5` and `-1` are *this* layer's
///   [`SaveError::Validation`] with a sentence naming the mistake, rather than
///   a deserializer rejection the API would have to render as a 400.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`] and [`save_pricing`]: one read-modify-write
///   over the whole document, so all three sections (and any mesa doesn't
///   know) survive each other's edits.
pub fn save_watchers(
    updates: &HashMap<String, Option<serde_json::Value>>,
) -> Result<(), SaveError> {
    save_watchers_in(&config_file(), updates)
}

fn save_watchers_in(
    path: &Path,
    updates: &HashMap<String, Option<serde_json::Value>>,
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and in particular no empty
        // `"watchers": {}` written into a file the user never configured.
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !WATCHER_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown watcher setting {key:?}; mesa configures {}",
                WATCHER_KEYS.join(", ")
            )));
        }
        if let Some(value) = &updates[*key] {
            let max = if key.as_str() == RETRO_INTERVAL_HOURS {
                MAX_RETRO_INTERVAL_HOURS
            } else {
                MAX_TODO_CONCURRENCY
            };
            validate_limit(key, value, max).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("watchers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"watchers\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match &updates[key] {
            None => {
                section.remove(key);
            }
            Some(value) => {
                section.insert(key.clone(), value.clone());
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// A watcher limit has to be a whole number inside its sanity bound
/// (`max` — [`MAX_TODO_CONCURRENCY`] agents, or [`MAX_RETRO_INTERVAL_HOURS`]
/// hours): `0` (which would stop the watcher rather than configure it), a
/// negative, a fraction and anything over the bound are all named rather
/// than silently coerced.
fn validate_limit(key: &str, value: &serde_json::Value, max: u32) -> Result<(), String> {
    let Some(n) = value.as_u64() else {
        return Err(format!(
            "{key} must be a whole number between 1 and {max}, got {value}"
        ));
    };
    if n < 1 || n > u64::from(max) {
        return Err(format!("{key} must be between 1 and {max}, got {n}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Speech (mesa task 822)
// ---------------------------------------------------------------------------

/// The config key holding the voice the inbox's play button speaks in.
pub const VOICE: &str = "voice";

/// Every key the `speech` section understands, for the unknown-key error.
const SPEECH_KEYS: &[&str] = &[VOICE];

/// The `speech` map, deserialized on its own for the reason every other
/// section is: four independent features share one file, and a broken value in
/// any of them must not take the other three down ([`PricingConfig`] is the
/// model).
#[derive(Debug, Default, Deserialize)]
struct SpeechConfig {
    #[serde(default)]
    speech: SpeechSection,
}

#[derive(Debug, Default, Deserialize)]
struct SpeechSection {
    #[serde(default)]
    voice: Option<String>,
}

fn read_speech(path: &Path) -> Result<SpeechSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SpeechSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: SpeechConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.speech)
}

/// The configured voice, or `None` for "the synthesiser's own default".
///
/// Read **on every press**, like [`command_for`] is read on every spawn, so a
/// change is audible on the next play with no restart. Absent, blank and a
/// value the shape rule rejects all mean `None`: a hand-edited nonsense voice
/// falls back to the default rather than reaching the binary's argv, which is
/// the same conservatism [`todo_concurrency`] clamps with. A file that exists
/// but can't be read or parsed is `Err`, never a silent fall back.
pub fn speech_voice() -> Result<Option<String>, String> {
    speech_voice_in(&config_file())
}

fn speech_voice_in(path: &Path) -> Result<Option<String>, String> {
    Ok(read_speech(path)?
        .voice
        .map(|v| v.trim().to_string())
        .filter(|v| speech::is_voice_name(v)))
}

/// The speech settings for the Settings page (`GET /api/config/speech`): the
/// configured voice (`null` when the file says nothing) plus the voices the
/// installed synthesiser offers, so the editor can be a list rather than a
/// magic string. An empty `voices` is "mesa could not ask the binary" — the
/// editor still has to accept a typed name then.
pub fn speech() -> Result<ConfigSpeech, String> {
    speech_in(&config_file())
}

fn speech_in(path: &Path) -> Result<ConfigSpeech, String> {
    Ok(ConfigSpeech {
        // The **raw** stored value, not the filtered one [`speech_voice_in`]
        // hands the synthesiser: a hand-edited nonsense voice must reach the
        // editor that can fix it, exactly as an out-of-range watcher limit
        // does. Blank is still absence — the file's own spelling of "default".
        voice: read_speech(path)?
            .voice
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        voices: speech::voices(),
    })
}

/// Writes the `speech` entries named in `updates` into the config file.
///
/// - `None` **removes** the key, restoring the synthesiser's own default — the
///   same meaning blank has for a command and `null` for a watcher limit.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`], [`save_pricing`] and [`save_watchers`]: one
///   read-modify-write over the whole document, so all four sections (and any
///   mesa doesn't know) survive each other's edits.
pub fn save_speech(updates: &HashMap<String, Option<String>>) -> Result<(), SaveError> {
    save_speech_in(&config_file(), updates, &speech::voices())
}

/// `offered` is the list membership is checked against — a parameter rather
/// than a [`speech::voices`] call, so a test names the list it is asserting
/// about instead of inheriting whatever synthesiser the machine has installed.
fn save_speech_in(
    path: &Path,
    updates: &HashMap<String, Option<String>>,
    offered: &[String],
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and no empty `"speech": {}` written
        // into a file the user never configured.
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !SPEECH_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown speech setting {key:?}; mesa configures {}",
                SPEECH_KEYS.join(", ")
            )));
        }
        // Blank is the reset, not a value to check — same rule as a command box.
        if let Some(value) = updates[*key].as_deref().map(str::trim)
            && !value.is_empty()
        {
            validate_voice(value, offered).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("speech")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"speech\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match updates[key].as_deref().map(str::trim) {
            // Blank is the same reset as `null`, exactly as it is for a command
            // template — the editor clears a box, it does not send a sentinel.
            None | Some("") => {
                section.remove(key);
            }
            Some(value) => {
                section.insert(key.clone(), serde_json::Value::String(value.to_string()));
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// A voice has to be a name the synthesiser could accept: a bounded identifier
/// ([`speech::is_voice_name`] — so it can never be read as an option), and,
/// when mesa managed to ask the binary what it `offers`, one of those.
///
/// The membership half is skipped when `offered` is empty, which is what a
/// missing or uncooperative binary looks like: mesa cannot prove the name is
/// wrong there, and refusing a value it merely can't check would be the worse
/// answer (the same call [`bash_syntax_check`] makes).
pub fn validate_voice(voice: &str, offered: &[String]) -> Result<(), String> {
    if !speech::is_voice_name(voice) {
        return Err(format!(
            "the voice {voice:?} is not a voice name: up to 64 letters, digits, \
             underscores and dashes, starting with a letter or digit"
        ));
    }
    if !offered.is_empty() && !offered.iter().any(|v| v == voice) {
        return Err(format!(
            "unknown voice {voice:?}; {} offers {}",
            speech::kokoro_bin(),
            offered.join(", ")
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Listen (mesa task 955)
// ---------------------------------------------------------------------------

/// The config key holding the model `live transcribe` runs the external
/// `auris` speech-to-text binary with.
pub const MODEL: &str = "model";

/// The config key naming what the **page** listens with (mesa task 1388):
/// `"server"` (the server's engine, `audio.engine`) or `"browser"` (the Web
/// Speech API, a deliberate opt-in, never a fallback). Also the `audio`
/// section's key for what the **server** runs.
pub const ENGINE: &str = "engine";

/// The words `listen.engine` accepts; the first is the built-in.
const LISTEN_ENGINES: &[&str] = &["server", "browser"];

/// Every key the `listen` section understands, for the unknown-key error.
const LISTEN_KEYS: &[&str] = &[ENGINE, MODEL];

/// The `listen` map, deserialized on its own for the reason every other
/// section is — the [`SpeechSection`] mirror, on the input side.
#[derive(Debug, Default, Deserialize)]
struct ListenConfig {
    #[serde(default)]
    listen: ListenSection,
}

#[derive(Debug, Default, Deserialize)]
struct ListenSection {
    #[serde(default)]
    model: Option<String>,
    /// Raw, like [`GuardSection::action`]: a word Naru does not know is shown
    /// verbatim so the editor can fix it.
    #[serde(default)]
    engine: Option<String>,
}

fn read_listen(path: &Path) -> Result<ListenSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ListenSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: ListenConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.listen)
}

/// The configured model, or `None` for "the recognizer's own default".
///
/// Read **on every request**, like [`speech_voice`] is read on every press,
/// so a change reaches the next transcription with no restart. Absent, blank
/// and a value the shape rule rejects all mean `None`: a hand-edited
/// nonsense model falls back to the default rather than reaching the
/// binary's argv. A file that exists but can't be read or parsed is `Err`,
/// never a silent fall back.
pub fn listen_model() -> Result<Option<String>, String> {
    listen_model_in(&config_file())
}

fn listen_model_in(path: &Path) -> Result<Option<String>, String> {
    Ok(read_listen(path)?
        .model
        .map(|v| v.trim().to_string())
        .filter(|v| listen::is_model_name(v)))
}

/// The listen settings for the Settings page (`GET /api/config/listen`): the
/// configured model (`null` when the file says nothing) plus the models the
/// installed recognizer offers, so the editor can be a list rather than a
/// magic string. An empty `models` is "mesa could not ask the binary" — the
/// editor still has to accept a typed name then.
pub fn listen() -> Result<ConfigListen, String> {
    listen_in(&config_file())
}

fn listen_in(path: &Path) -> Result<ConfigListen, String> {
    let section = read_listen(path)?;
    Ok(ConfigListen {
        // The **raw** stored value, not the filtered one [`listen_model_in`]
        // hands the recognizer: a hand-edited nonsense model must reach the
        // editor that can fix it, exactly as [`speech_in`] does for a voice.
        model: section
            .model
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        models: listen::models(),
        engine: section
            .engine
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        engine_default: LISTEN_ENGINES[0].to_string(),
    })
}

/// Writes the `listen` entries named in `updates` into the config file.
///
/// - `None` **removes** the key, restoring the recognizer's own default —
///   the same meaning blank has for a command and `null` for a watcher
///   limit.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_speech`] and the other savers: one read-modify-write
///   over the whole document, so every section (and any mesa doesn't know)
///   survives every other's edits.
pub fn save_listen(updates: &HashMap<String, Option<String>>) -> Result<(), SaveError> {
    save_listen_in(&config_file(), updates, &listen::models())
}

/// `offered` is the list membership is checked against — a parameter rather
/// than a [`listen::models`] call, so a test names the list it is asserting
/// about instead of inheriting whatever recognizer the machine has
/// installed.
fn save_listen_in(
    path: &Path,
    updates: &HashMap<String, Option<String>>,
    offered: &[String],
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and no empty `"listen": {}` written
        // into a file the user never configured.
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !LISTEN_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown listen setting {key:?}; mesa configures {}",
                LISTEN_KEYS.join(", ")
            )));
        }
        // Blank is the reset, not a value to check — same rule as a command box.
        if let Some(value) = updates[*key].as_deref().map(str::trim)
            && !value.is_empty()
        {
            if key.as_str() == ENGINE {
                validate_word(key, value, LISTEN_ENGINES).map_err(SaveError::Validation)?;
            } else {
                validate_model(value, offered).map_err(SaveError::Validation)?;
            }
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("listen")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"listen\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match updates[key].as_deref().map(str::trim) {
            // Blank is the same reset as `null`, exactly as it is for a command
            // template — the editor clears a box, it does not send a sentinel.
            None | Some("") => {
                section.remove(key);
            }
            Some(value) => {
                section.insert(key.clone(), serde_json::Value::String(value.to_string()));
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// A model has to be a name the recognizer could accept: a bounded
/// identifier ([`listen::is_model_name`] — so it can never be read as an
/// option), and, when mesa managed to ask the binary what it `offers`, one
/// of those.
///
/// The membership half is skipped when `offered` is empty, which is what a
/// missing or uncooperative binary looks like: mesa cannot prove the name is
/// wrong there, and refusing a value it merely can't check would be the
/// worse answer (the same call [`validate_voice`] makes).
pub fn validate_model(model: &str, offered: &[String]) -> Result<(), String> {
    if !listen::is_model_name(model) {
        return Err(format!(
            "the model {model:?} is not a model name: up to 64 letters, digits, \
             underscores, dashes and dots, starting with a letter or digit"
        ));
    }
    if !offered.is_empty() && !offered.iter().any(|m| m == model) {
        return Err(format!(
            "unknown model {model:?}; {} offers {}",
            listen::auris_bin(),
            offered.join(", ")
        ));
    }
    Ok(())
}

/// One of a fixed set of words, or a sentence naming the set.
fn validate_word(key: &str, value: &str, words: &[&str]) -> Result<(), String> {
    if words.contains(&value) {
        return Ok(());
    }
    let quoted: Vec<String> = words.iter().map(|w| format!("{w:?}")).collect();
    Err(format!(
        "{key} must be one of {}, got {value:?}",
        quoted.join(", ")
    ))
}

// ---------------------------------------------------------------------------
// Audio (mesa task 1388)
// ---------------------------------------------------------------------------

/// The config key holding where the `naru-audio` daemon listens.
pub const URL: &str = "url";

/// Every key the `audio` section understands, for the unknown-key error.
const AUDIO_KEYS: &[&str] = &[ENGINE, URL];

/// The engine the server runs speech through when the config says nothing:
/// the external binaries, exactly as before this section existed.
pub const DEFAULT_AUDIO_ENGINE: AudioEngine = AudioEngine::Legacy;

/// The longest daemon URL the editor will write — a sanity bound.
const AUDIO_URL_MAX: usize = 200;

#[derive(Debug, Default, Deserialize)]
struct AudioConfig {
    #[serde(default)]
    audio: AudioSection,
}

/// Both keys kept raw, like [`GuardSection::action`]: a bad hand-edited value
/// falls back to the built-in where it is used and is still shown verbatim.
#[derive(Debug, Default, Deserialize)]
struct AudioSection {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    engine: Option<String>,
}

fn read_audio(path: &Path) -> Result<AudioSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AudioSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: AudioConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.audio)
}

/// The engine the server runs speech through (`audio.engine`), read on every
/// request so a change needs no restart. Absent or a word Naru does not know
/// is [`DEFAULT_AUDIO_ENGINE`].
pub fn audio_engine() -> Result<AudioEngine, String> {
    audio_engine_in(&config_file())
}

fn audio_engine_in(path: &Path) -> Result<AudioEngine, String> {
    Ok(read_audio(path)?
        .engine
        .as_deref()
        .map(str::trim)
        .and_then(AudioEngine::parse)
        .unwrap_or(DEFAULT_AUDIO_ENGINE))
}

/// Where the daemon listens: `NARU_AUDIO_URL` (or `MESA_AUDIO_URL`) when set
/// and non-empty, else a valid `audio.url`, else [`audio::DEFAULT_URL`].
pub fn audio_url() -> Result<String, String> {
    audio_url_in(&config_file())
}

fn audio_url_in(path: &Path) -> Result<String, String> {
    let env = crate::core::env::var("AUDIO_URL");
    let (url, warning) = pick_audio_url(env.as_deref(), read_audio(path)?.url.as_deref());
    if let Some(warning) = warning {
        // Read on every request: warn once per bad value, not once per probe.
        static WARNED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
        if warned.as_deref() != env.as_deref() {
            eprintln!("{warning}");
            *warned = env;
        }
    }
    Ok(url)
}

/// The daemon URL from the environment's value and the config's, each held
/// to [`validate_audio_url`]: a valid non-empty env value wins, else a valid
/// config value, else [`audio::DEFAULT_URL`]. The second half is the warning
/// to print when a non-empty env value was refused.
fn pick_audio_url(env: Option<&str>, config: Option<&str>) -> (String, Option<String>) {
    let config = config
        .map(str::trim)
        .filter(|v| validate_audio_url(v).is_ok())
        .unwrap_or(audio::DEFAULT_URL);
    match env.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) if validate_audio_url(v).is_ok() => (v.to_string(), None),
        Some(v) => (
            config.to_string(),
            Some(format!(
                "warn NARU_AUDIO_URL {v:?} is not a plain http://host[:port] address; \
                 using {config}"
            )),
        ),
        None => (config.to_string(), None),
    }
}

/// The audio settings for the Settings page (`GET /api/config/audio`): each
/// value verbatim (`null` when the file says nothing) beside its built-in —
/// the `{value, default}` idiom [`ConfigGuard`] uses.
pub fn audio() -> Result<ConfigAudio, String> {
    audio_in(&config_file())
}

fn audio_in(path: &Path) -> Result<ConfigAudio, String> {
    let section = read_audio(path)?;
    let raw = |v: Option<String>| v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    Ok(ConfigAudio {
        url: raw(section.url),
        url_default: audio::DEFAULT_URL.to_string(),
        engine: raw(section.engine),
        engine_default: DEFAULT_AUDIO_ENGINE.as_str().to_string(),
    })
}

/// Writes the `audio` entries named in `updates` into the config file.
///
/// - `None` (or blank) **removes** the key, restoring the built-in.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of every other saver: one read-modify-write over the whole
///   document, so every section (and any Naru doesn't know) survives.
pub fn save_audio(updates: &HashMap<String, Option<String>>) -> Result<(), SaveError> {
    save_audio_in(&config_file(), updates)
}

fn save_audio_in(path: &Path, updates: &HashMap<String, Option<String>>) -> Result<(), SaveError> {
    if updates.is_empty() {
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !AUDIO_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown audio setting {key:?}; mesa configures {}",
                AUDIO_KEYS.join(", ")
            )));
        }
        if let Some(value) = updates[*key].as_deref().map(str::trim)
            && !value.is_empty()
        {
            if key.as_str() == ENGINE {
                validate_word(key, value, &["legacy", "naru-audio"])
            } else {
                validate_audio_url(value)
            }
            .map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("audio")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"audio\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match updates[key].as_deref().map(str::trim) {
            None | Some("") => {
                section.remove(key);
            }
            Some(value) => {
                section.insert(key.clone(), serde_json::Value::String(value.to_string()));
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// A daemon URL is plain `http://host[:port]` with at most a trailing `/`:
/// Naru's client speaks no TLS, and the probe appends its own paths.
fn validate_audio_url(url: &str) -> Result<(), String> {
    let authority = url
        .strip_prefix("http://")
        .map(|rest| rest.strip_suffix('/').unwrap_or(rest));
    match authority {
        Some(a)
            if !a.is_empty()
                && url.len() <= AUDIO_URL_MAX
                && a.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')
                }) =>
        {
            Ok(())
        }
        _ => Err(format!(
            "{URL} must be a plain http://host[:port] address of at most \
             {AUDIO_URL_MAX} characters (no https, path or query), got {url:?}"
        )),
    }
}

// ---------------------------------------------------------------------------
// Live (mesa task 867)
// ---------------------------------------------------------------------------

/// The config key holding how long a settled dictation draft waits before the
/// page sends it (mesa task 886).
pub const LIVE_AUTO_SEND_MS: &str = "auto-send-ms";

/// Every key the `live` section understands, for the unknown-key error. Task
/// 919 moved the instruction block out to the library, leaving this section
/// with the one key.
const LIVE_KEYS: &[&str] = &[LIVE_AUTO_SEND_MS];

/// How long an untouched draft waits with no config — the value that keeps an
/// unconfigured install byte-identical to mesa before task 886, when the wait
/// was hardcoded at two seconds in `liveCapture.ts`.
pub const DEFAULT_LIVE_AUTO_SEND_MS: u32 = 2_000;

/// The shortest wait the editor will write. A **sanity bound, not a policy**:
/// nothing breaks below it, but a wait shorter than the gap between two spoken
/// words would post half a sentence, which reads as mesa interrupting.
pub const MIN_LIVE_AUTO_SEND_MS: u32 = 250;

/// The longest wait the editor will write — a minute of silence after a
/// finished thought is a conversation that has stopped, not one still waiting.
pub const MAX_LIVE_AUTO_SEND_MS: u32 = 60_000;

/// The `live` map, deserialized on its own for the reason every other section
/// is: five independent features share one file, and a broken value in any of
/// them must not take the other four down.
#[derive(Debug, Default, Deserialize)]
struct LiveConfig {
    #[serde(default)]
    live: LiveSection,
}

/// `#[serde(default)]` on the struct means a stray key with no field of its
/// own — a hand-edited `live.prompt` left over from before task 919 — is
/// simply ignored by `serde_json`, never an error: this section only needs to
/// know about the key it still has.
#[derive(Debug, Default, Deserialize)]
struct LiveSection {
    #[serde(default, rename = "auto-send-ms")]
    auto_send_ms: Option<u32>,
}

fn read_live(path: &Path) -> Result<LiveSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LiveSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: LiveConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.live)
}

/// The live settings for the Settings page (`GET /api/config/live`): the
/// configured auto-send wait (`null` when the file says nothing) plus the
/// built-in wait, so the editor can show what blank means without a copy of
/// it in TypeScript. The instruction block moved to the library (mesa task
/// 919) — the Settings page links there instead of holding a second copy of
/// it here.
pub fn live() -> Result<ConfigLive, String> {
    live_in(&config_file())
}

fn live_in(path: &Path) -> Result<ConfigLive, String> {
    Ok(ConfigLive {
        auto_send_ms: read_live(path)?.auto_send_ms,
        auto_send_ms_default: DEFAULT_LIVE_AUTO_SEND_MS,
    })
}

/// Writes the `live` entries named in `updates` into the config file.
///
/// - `None` (or a blank string) **removes** the key, restoring what mesa ships
///   — the same meaning blank has for a command and `null` for a watcher limit.
/// - Values arrive as raw JSON, as [`save_watchers`]' do, because this section
///   holds both prose and a number: `2.5` and `-1` are *this* layer's
///   [`SaveError::Validation`] with a sentence naming the mistake, rather than
///   a deserializer rejection the API would have to render as a 400.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`], [`save_pricing`], [`save_watchers`] and
///   [`save_speech`]: one read-modify-write over the whole document, so all
///   five sections (and any mesa doesn't know) survive each other's edits.
pub fn save_live(updates: &HashMap<String, Option<serde_json::Value>>) -> Result<(), SaveError> {
    save_live_in(&config_file(), updates)
}

fn save_live_in(
    path: &Path,
    updates: &HashMap<String, Option<serde_json::Value>>,
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and no empty `"live": {}` written into
        // a file the user never configured.
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !LIVE_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown live setting {key:?}; mesa configures {}",
                LIVE_KEYS.join(", ")
            )));
        }
        // Blank is the reset, not a value to check — same rule as a command box.
        if let Some(value) = &updates[*key]
            && !is_live_reset(value)
        {
            validate_live(key, value).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("live")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"live\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match &updates[key] {
            Some(value) if !is_live_reset(value) => {
                section.insert(key.clone(), value.clone());
            }
            _ => {
                section.remove(key);
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// Whether this value is the section's spelling of "put it back to what mesa
/// ships": `null`, the only reset `auto-send-ms` (the one key left in this
/// section) ever needs — it has no textbox-shaped "blank" the way a command
/// or the old prompt did.
fn is_live_reset(value: &serde_json::Value) -> bool {
    value.is_null()
}

/// The rule for one live value — currently just `auto-send-ms`, the one key
/// left in this section: a whole number of milliseconds inside the sanity
/// bounds. A value of the wrong *shape* is named here too — a wait sent as a
/// string — rather than coerced into something the person did not ask for.
fn validate_live(key: &str, value: &serde_json::Value) -> Result<(), String> {
    debug_assert_eq!(key, LIVE_AUTO_SEND_MS, "the live section has only one key");
    let Some(ms) = value.as_u64() else {
        return Err(format!(
            "{key} must be a whole number of milliseconds between \
             {MIN_LIVE_AUTO_SEND_MS} and {MAX_LIVE_AUTO_SEND_MS}, got {value}"
        ));
    };
    if ms < u64::from(MIN_LIVE_AUTO_SEND_MS) || ms > u64::from(MAX_LIVE_AUTO_SEND_MS) {
        return Err(format!(
            "{key} must be between {MIN_LIVE_AUTO_SEND_MS} and {MAX_LIVE_AUTO_SEND_MS} \
             milliseconds, got {ms}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Guard (mesa task 1018)
// ---------------------------------------------------------------------------

/// The config key holding the dollar ceiling one live session may reach in the
/// guard window before it is reported.
pub const GUARD_COST_USD: &str = "cost-usd";
/// The config key holding the token ceiling for the same window.
pub const GUARD_TOTAL_TOKENS: &str = "total-tokens";
/// The config key holding the cache-read share the spin-loop rule fires at.
pub const GUARD_CACHE_READ_SHARE: &str = "cache-read-share";
/// The config key holding the token floor the spin-loop rule needs before it
/// will fire at all.
pub const GUARD_CACHE_READ_MIN_TOKENS: &str = "cache-read-min-tokens";

/// The config key holding how many identical trivial `Bash` calls in a row
/// fire the repeat rule.
pub const GUARD_REPEAT_COUNT: &str = "repeat-count";
/// The config key holding what the watcher does about a breach.
pub const GUARD_ACTION: &str = "action";

/// Every key the `guard` section understands, for the unknown-key error.
const GUARD_KEYS: &[&str] = &[
    GUARD_ACTION,
    GUARD_CACHE_READ_MIN_TOKENS,
    GUARD_CACHE_READ_SHARE,
    GUARD_COST_USD,
    GUARD_REPEAT_COUNT,
    GUARD_TOTAL_TOKENS,
];

/// Dollars of *estimated* spend inside the guard window at which a session is
/// worth a person's attention. Deliberately an hour's worth of expensive work
/// rather than a day's: the guard reports, it does not stop anything, so the
/// cost of a false alarm is one inbox item.
pub const DEFAULT_GUARD_COST_USD: f64 = 25.0;

/// The largest ceiling the editor will write — a **sanity bound, not a
/// policy**. Past it the guard would never fire and the section would be
/// silently off, which is worse than not configuring it.
pub const MAX_GUARD_COST_USD: f64 = 100_000.0;

/// Tokens inside the guard window at which a session is reported regardless of
/// what they cost. The cost rule can be defeated by a cheap model; volume
/// cannot.
pub const DEFAULT_GUARD_TOTAL_TOKENS: i64 = 100_000_000;

/// The share of a session's tokens that must be cache **reads** for the
/// spin-loop rule to fire. The motivating incident sat at 99.8%: an agent
/// re-reading the same context forever, producing almost no output.
pub const DEFAULT_GUARD_CACHE_READ_SHARE: f64 = 0.98;

/// The narrowest share the editor will write. Below half, "mostly cache reads"
/// stops describing a loop and starts describing a healthy long session.
pub const MIN_GUARD_CACHE_READ_SHARE: f64 = 0.5;

/// The token floor the spin-loop rule needs before it fires. A session three
/// messages long is 100% cache-read and perfectly healthy; the floor is what
/// separates "reading its context" from "reading its context forever".
pub const DEFAULT_GUARD_CACHE_READ_MIN_TOKENS: i64 = 20_000_000;

/// Identical trivial `Bash` calls in a row at which a session is reported.
///
/// Thirty, because no honest workflow runs one command that produces nothing
/// thirty times without a different tool call in between — and because the
/// motivating loop reached 4,600. It is deliberately well above the handful of
/// retries a polling loop legitimately makes.
pub const DEFAULT_GUARD_REPEAT_COUNT: i64 = 30;

/// The largest repeat count the editor will write — the [`MAX_GUARD_COST_USD`]
/// sanity bound, not a policy. Past it the rule could never fire.
pub const MAX_GUARD_REPEAT_COUNT: i64 = 100_000;

/// What the watcher does about a breach when the config says nothing:
/// **stop** the session (`docs/cost-guard.md`, mesa task 1054).
pub const DEFAULT_GUARD_ACTION: GuardAction = GuardAction::Stop;

/// The `guard` map, deserialized on its own for the reason every other section
/// is: independent features share one file, and a broken value in any of them
/// must not take the others down.
#[derive(Debug, Default, Deserialize)]
struct GuardConfig {
    #[serde(default)]
    guard: GuardSection,
}

#[derive(Debug, Default, Deserialize)]
struct GuardSection {
    #[serde(default, rename = "cost-usd")]
    cost_usd: Option<f64>,
    #[serde(default, rename = "total-tokens")]
    total_tokens: Option<i64>,
    #[serde(default, rename = "cache-read-share")]
    cache_read_share: Option<f64>,
    #[serde(default, rename = "cache-read-min-tokens")]
    cache_read_min_tokens: Option<i64>,
    #[serde(default, rename = "repeat-count")]
    repeat_count: Option<i64>,
    /// Kept as the raw string the file holds, not a parsed [`GuardAction`]: a
    /// word mesa does not know falls back to the built-in on the watcher's
    /// side and is still shown **verbatim** by the editor, the clamp posture
    /// every other key in this section takes.
    #[serde(default)]
    action: Option<String>,
}

fn read_guard(path: &Path) -> Result<GuardSection, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(GuardSection::default()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: GuardConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.guard)
}

/// The thresholds the cost-guard watcher evaluates against, read **on every
/// tick** — the [`todo_concurrency`] rule, and for the same reason: a limit
/// raised in Settings must take effect without restarting `mesa serve`.
///
/// A file that exists but can't be read or parsed is `Err`, never a silent
/// fall back — the caller (`cost_watcher_tick`) skips the tick rather than
/// guard against guessed numbers. A value of the right *type* but outside its
/// sanity bound falls back to the built-in for that key alone, the same
/// don't-stop-working posture [`todo_concurrency`]'s clamp takes: a
/// hand-edited `0` must not turn the guard off silently, and the editor still
/// refuses to *write* such a value.
pub fn guard_thresholds() -> Result<GuardThresholds, String> {
    guard_thresholds_in(&config_file())
}

fn guard_thresholds_in(path: &Path) -> Result<GuardThresholds, String> {
    let section = read_guard(path)?;
    Ok(GuardThresholds {
        cost_usd: section
            .cost_usd
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= MAX_GUARD_COST_USD)
            .unwrap_or(DEFAULT_GUARD_COST_USD),
        total_tokens: section
            .total_tokens
            .filter(|v| *v >= 1)
            .unwrap_or(DEFAULT_GUARD_TOTAL_TOKENS),
        cache_read_share: section
            .cache_read_share
            .filter(|v| v.is_finite() && *v >= MIN_GUARD_CACHE_READ_SHARE && *v <= 1.0)
            .unwrap_or(DEFAULT_GUARD_CACHE_READ_SHARE),
        cache_read_min_tokens: section
            .cache_read_min_tokens
            .filter(|v| *v >= 1)
            .unwrap_or(DEFAULT_GUARD_CACHE_READ_MIN_TOKENS),
        repeat_count: section
            .repeat_count
            .filter(|v| (1..=MAX_GUARD_REPEAT_COUNT).contains(v))
            .unwrap_or(DEFAULT_GUARD_REPEAT_COUNT) as u64,
        action: section
            .action
            .as_deref()
            .and_then(GuardAction::parse)
            .unwrap_or(DEFAULT_GUARD_ACTION),
    })
}

/// The guard settings for the Settings page (`GET /api/config/guard`): each
/// configured value **verbatim** (`null` when the file says nothing) beside
/// the built-in behind it — the `{value, default}` idiom [`ConfigWatchers`]
/// uses. Verbatim matters: a hand-edited out-of-range number is shown as it
/// was written, so the editor reflects the file rather than the number the
/// watcher fell back to.
pub fn guard() -> Result<ConfigGuard, String> {
    guard_in(&config_file())
}

fn guard_in(path: &Path) -> Result<ConfigGuard, String> {
    let section = read_guard(path)?;
    Ok(ConfigGuard {
        cost_usd: section.cost_usd,
        cost_usd_default: DEFAULT_GUARD_COST_USD,
        total_tokens: section.total_tokens,
        total_tokens_default: DEFAULT_GUARD_TOTAL_TOKENS,
        cache_read_share: section.cache_read_share,
        cache_read_share_default: DEFAULT_GUARD_CACHE_READ_SHARE,
        cache_read_min_tokens: section.cache_read_min_tokens,
        cache_read_min_tokens_default: DEFAULT_GUARD_CACHE_READ_MIN_TOKENS,
        repeat_count: section.repeat_count,
        repeat_count_default: DEFAULT_GUARD_REPEAT_COUNT,
        action: section.action,
        action_default: DEFAULT_GUARD_ACTION.as_str().to_string(),
    })
}

/// Writes the `guard` entries named in `updates` into the config file.
///
/// - `None` (or `null`) **removes** the key, restoring the built-in threshold.
/// - Values arrive as raw JSON, as [`save_watchers`]' do, so `-1`, `"lots"`
///   and a share of `2` are *this* layer's [`SaveError::Validation`] with a
///   sentence naming the mistake rather than a deserializer rejection.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`], [`save_pricing`], [`save_watchers`],
///   [`save_speech`], [`save_listen`] and [`save_live`]: one read-modify-write
///   over the whole document, so all six sections (and any mesa doesn't know)
///   survive each other's edits.
pub fn save_guard(updates: &HashMap<String, Option<serde_json::Value>>) -> Result<(), SaveError> {
    save_guard_in(&config_file(), updates)
}

fn save_guard_in(
    path: &Path,
    updates: &HashMap<String, Option<serde_json::Value>>,
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and no empty `"guard": {}` written
        // into a file the user never configured.
        return Ok(());
    }
    let mut keys: Vec<&String> = updates.keys().collect();
    keys.sort();
    for key in &keys {
        if !GUARD_KEYS.contains(&key.as_str()) {
            return Err(SaveError::Validation(format!(
                "unknown guard setting {key:?}; mesa configures {}",
                GUARD_KEYS.join(", ")
            )));
        }
        if let Some(value) = &updates[*key]
            && !value.is_null()
        {
            validate_guard(key, value).map_err(SaveError::Validation)?;
        }
    }

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("guard")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"guard\" is not a JSON object",
            path.display()
        )));
    };
    for key in keys {
        match &updates[key] {
            Some(value) if !value.is_null() => {
                section.insert(key.clone(), value.clone());
            }
            _ => {
                section.remove(key);
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// The rule for one guard threshold. Two of the four are counts of tokens and
/// must be whole numbers; two are continuous. A value of the wrong *shape* is
/// named here rather than coerced into something the person did not ask for.
fn validate_guard(key: &str, value: &serde_json::Value) -> Result<(), String> {
    match key {
        GUARD_COST_USD => {
            let Some(v) = value.as_f64() else {
                return Err(format!(
                    "{key} must be a number of dollars greater than 0 and at most \
                     {MAX_GUARD_COST_USD}, got {value}"
                ));
            };
            if !v.is_finite() || v <= 0.0 || v > MAX_GUARD_COST_USD {
                return Err(format!(
                    "{key} must be greater than 0 and at most {MAX_GUARD_COST_USD}, got {v}"
                ));
            }
        }
        GUARD_TOTAL_TOKENS | GUARD_CACHE_READ_MIN_TOKENS => {
            let Some(v) = value.as_i64() else {
                return Err(format!(
                    "{key} must be a whole number of tokens of at least 1, got {value}"
                ));
            };
            if v < 1 {
                return Err(format!("{key} must be at least 1 token, got {v}"));
            }
        }
        GUARD_CACHE_READ_SHARE => {
            let Some(v) = value.as_f64() else {
                return Err(format!(
                    "{key} must be a share between {MIN_GUARD_CACHE_READ_SHARE} and 1, got {value}"
                ));
            };
            if !v.is_finite() || !(MIN_GUARD_CACHE_READ_SHARE..=1.0).contains(&v) {
                return Err(format!(
                    "{key} must be between {MIN_GUARD_CACHE_READ_SHARE} and 1, got {v}"
                ));
            }
        }
        GUARD_REPEAT_COUNT => {
            let Some(v) = value.as_i64() else {
                return Err(format!(
                    "{key} must be a whole number of repeats between 1 and \
                     {MAX_GUARD_REPEAT_COUNT}, got {value}"
                ));
            };
            if !(1..=MAX_GUARD_REPEAT_COUNT).contains(&v) {
                return Err(format!(
                    "{key} must be between 1 and {MAX_GUARD_REPEAT_COUNT}, got {v}"
                ));
            }
        }
        GUARD_ACTION => {
            let Some(v) = value.as_str() else {
                return Err(format!(
                    "{key} must be the string \"{}\" or \"{}\", got {value}",
                    GuardAction::Stop.as_str(),
                    GuardAction::Report.as_str()
                ));
            };
            if GuardAction::parse(v).is_none() {
                return Err(format!(
                    "{key} must be \"{}\" or \"{}\", got {v:?}",
                    GuardAction::Stop.as_str(),
                    GuardAction::Report.as_str()
                ));
            }
        }
        _ => unreachable!("unknown guard keys are refused before validation"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Keymap
// ---------------------------------------------------------------------------

/// Every global shortcut the Settings page may rebind, with the chords mesa
/// ships (mesa task 1079).
///
/// The **twin** of `frontend/src/keymap.ts`'s `ACTIONS` table, and deliberately
/// so: the page needs the ids, the labels and the defaults before the first
/// fetch resolves, and this side needs the ids and the defaults to answer "is
/// that an action mesa knows" and "does this override collide with an action
/// the user never touched". Labels are the page's alone — they are copy, not
/// contract. `keymap_defaults_match_the_frontend_table` is the test that pins
/// the two id/chord lists together; edit one and edit the other.
///
/// Only the **global window listeners** are here. A Files-tab chord, the
/// editor's Cmd/Ctrl+S and a modal's Escape are component-local — they belong
/// to one surface that is on screen, which is a different thing from a binding
/// the whole app answers to.
pub const KEYMAP_ACTIONS: &[(&str, &[&str])] = &[
    ("command-palette", &["Mod+Shift+P"]),
    ("focus-left", &["h", "ArrowLeft"]),
    ("focus-down", &["j", "ArrowDown"]),
    ("focus-up", &["k", "ArrowUp"]),
    ("focus-right", &["l", "ArrowRight"]),
    ("create-task", &["a"]),
    ("live-listen", &["Mod+Shift+L"]),
    ("live-cancel", &["Escape"]),
];

/// The most chords one action may be bound to. A **sanity bound, not a
/// policy**: the editor records a single chord per change, and the only reason
/// the shipped table needs more than one is the spatial nav's letter *and*
/// arrow pair. Four leaves room for a keyboard mesa has not met.
pub const MAX_KEYMAP_CHORDS: usize = 4;

/// The longest chord string the editor will write — `Mod+Alt+Shift+ArrowLeft`
/// is 23, so this is slack rather than a limit anyone meets. It exists so the
/// config file cannot be stuffed through the route.
pub const MAX_CHORD_LEN: usize = 32;

/// The modifier names a chord may carry, in the order a canonical chord writes
/// them. `Mod` is meta-or-ctrl — one name for the two platforms, because a
/// keymap saved on a Mac has to mean the same thing on the Linux box reading
/// the same config file.
const CHORD_MODIFIERS: &[&str] = &["Mod", "Alt", "Shift"];

/// The chords mesa ships for `action`, or `None` when it is not an action mesa
/// knows.
fn keymap_default(action: &str) -> Option<&'static [&'static str]> {
    KEYMAP_ACTIONS
        .iter()
        .find(|(name, _)| *name == action)
        .map(|(_, chords)| *chords)
}

/// The `keymap` map, deserialized as raw JSON per action so one hand-edited
/// entry can never take the rest of the section down with it — the read path is
/// forgiving where the write path is strict, the posture `todo-concurrency`'s
/// clamp already takes.
#[derive(Debug, Default, Deserialize)]
struct KeymapConfig {
    #[serde(default)]
    keymap: HashMap<String, serde_json::Value>,
}

fn read_keymap(path: &Path) -> Result<HashMap<String, serde_json::Value>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let config: KeymapConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("malformed mesa config {}: {e}", path.display()))?;
    Ok(config.keymap)
}

/// The overrides the file actually holds, with every entry mesa cannot use
/// dropped: an action id it does not know, or chords that are not a bounded
/// list of well-formed chord strings. That action simply falls back to its
/// **own** default, alone — a typo in one binding must not cost the user the
/// six they got right.
fn keymap_overrides_in(path: &Path) -> Result<HashMap<String, Vec<String>>, String> {
    let raw = read_keymap(path)?;
    let mut out = HashMap::new();
    for (action, value) in raw {
        if keymap_default(&action).is_none() {
            continue;
        }
        if let Ok(chords) = parse_chords(&action, &value) {
            out.insert(action, chords);
        }
    }
    Ok(out)
}

/// The keymap for the Settings page (`GET /api/config/keymap`): every action
/// mesa binds, in the shipped order, each carrying the configured chords
/// (`null` when the file says nothing) beside the built-ins — the
/// `{value, default}` idiom [`ConfigPrice`] and [`ConfigWatchers`] already use.
pub fn keymap() -> Result<ConfigKeymap, String> {
    keymap_in(&config_file())
}

fn keymap_in(path: &Path) -> Result<ConfigKeymap, String> {
    let configured = keymap_overrides_in(path)?;
    Ok(ConfigKeymap {
        actions: KEYMAP_ACTIONS
            .iter()
            .map(|(action, defaults)| ConfigKeymapAction {
                action: (*action).to_string(),
                value: configured.get(*action).cloned(),
                default: defaults.iter().map(|c| (*c).to_string()).collect(),
            })
            .collect(),
    })
}

/// Writes the `keymap` entries named in `updates` into the config file.
///
/// - `None` **removes** the key, restoring that action's built-in chords —
///   the same meaning blank has for a command and `null` for a price row.
///   Defaults are therefore never stored; only overrides are.
/// - Values arrive as raw JSON, as [`save_watchers`]' do, so `"h"`, `[]` and
///   `["Mod+"]` are all *this* layer's [`SaveError::Validation`] with a
///   sentence naming the mistake rather than a deserializer rejection.
/// - **A collision between two actions is refused**, which is the one rule
///   here that no other section has: a keymap is not a set of independent
///   values but a partition of the keyboard, so an override has to be judged
///   against everything else the map will hold once it lands — including the
///   actions the user never touched, which is why the built-ins are consulted.
///   The server refuses exactly what the editor refuses.
/// - Everything is validated before anything is written, so a rejected save
///   leaves the file byte-identical.
/// - Sibling of [`save_commands`], [`save_pricing`], [`save_watchers`],
///   [`save_speech`], [`save_listen`], [`save_live`] and [`save_guard`]: one
///   read-modify-write over the whole document, so all eight sections (and any
///   mesa doesn't know) survive each other's edits.
pub fn save_keymap(updates: &HashMap<String, Option<serde_json::Value>>) -> Result<(), SaveError> {
    save_keymap_in(&config_file(), updates)
}

fn save_keymap_in(
    path: &Path,
    updates: &HashMap<String, Option<serde_json::Value>>,
) -> Result<(), SaveError> {
    if updates.is_empty() {
        // Nothing named, nothing to do — and in particular no empty
        // `"keymap": {}` written into a file the user never configured.
        return Ok(());
    }
    let mut actions: Vec<&String> = updates.keys().collect();
    actions.sort();

    // The map this save would leave behind: the built-ins, overlaid with the
    // overrides already on disk, overlaid with what is being written. That
    // whole picture is what the collision rule is judged against.
    let mut effective: HashMap<String, Vec<String>> = KEYMAP_ACTIONS
        .iter()
        .map(|(action, chords)| {
            (
                (*action).to_string(),
                chords.iter().map(|c| (*c).to_string()).collect(),
            )
        })
        .collect();
    for (action, chords) in
        keymap_overrides_in(path).map_err(|e| SaveError::Unavailable(e.clone()))?
    {
        effective.insert(action, chords);
    }

    for action in &actions {
        let Some(defaults) = keymap_default(action) else {
            return Err(SaveError::Validation(format!(
                "unknown keyboard action {action:?}; mesa binds {}",
                KEYMAP_ACTIONS
                    .iter()
                    .map(|(name, _)| *name)
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        };
        match &updates[*action] {
            None => {
                effective.insert(
                    (*action).clone(),
                    defaults.iter().map(|c| (*c).to_string()).collect(),
                );
            }
            Some(value) => {
                let chords = parse_chords(action, value).map_err(SaveError::Validation)?;
                effective.insert((*action).clone(), chords);
            }
        }
    }
    check_no_chord_collision(&effective).map_err(SaveError::Validation)?;

    let mut root = read_config_document(path)?;
    let Some(object) = root.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: the file is not a JSON object",
            path.display()
        )));
    };
    let section = object
        .entry("keymap")
        .or_insert_with(|| serde_json::json!({}));
    let Some(section) = section.as_object_mut() else {
        return Err(SaveError::Unavailable(format!(
            "malformed mesa config {}: \"keymap\" is not a JSON object",
            path.display()
        )));
    };
    for action in actions {
        match &updates[action] {
            None => {
                section.remove(action);
            }
            Some(value) => {
                // Stored canonicalized, so the file never holds two spellings
                // of one chord and a later collision check cannot disagree
                // with this one.
                let chords: Vec<serde_json::Value> = parse_chords(action, value)
                    .map_err(SaveError::Validation)?
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect();
                section.insert(action.clone(), serde_json::Value::Array(chords));
            }
        }
    }

    let mut body = serde_json::to_string_pretty(&root)
        .map_err(|e| SaveError::Unavailable(format!("cannot serialize the mesa config: {e}")))?;
    body.push('\n');
    write_atomically(path, &body)
}

/// A bound action's value: a JSON array of 1..=[`MAX_KEYMAP_CHORDS`] chord
/// strings. An empty list is refused rather than read as "unbound": `null` is
/// already the way to say "put this back", and a shortcut silently bound to
/// nothing is the kind of thing a user cannot tell from a bug.
fn parse_chords(action: &str, value: &serde_json::Value) -> Result<Vec<String>, String> {
    let Some(items) = value.as_array() else {
        return Err(format!(
            "the chords for {action:?} must be a list of chord strings, got {value}"
        ));
    };
    if items.is_empty() {
        return Err(format!(
            "{action:?} needs at least one chord; write null to restore its default"
        ));
    }
    if items.len() > MAX_KEYMAP_CHORDS {
        return Err(format!(
            "{action:?} may be bound to at most {MAX_KEYMAP_CHORDS} chords, got {}",
            items.len()
        ));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(chord) = item.as_str() else {
            return Err(format!(
                "the chords for {action:?} must all be strings, got {item}"
            ));
        };
        out.push(canonical_chord(chord).map_err(|e| format!("{action:?}: {e}"))?);
    }
    Ok(out)
}

/// A chord string in its one canonical spelling: the modifiers it carries in
/// [`CHORD_MODIFIERS`] order, then the key, lowercased when it is a single
/// character so `A` and `a` are one binding rather than two. Errs with a
/// sentence naming what is wrong with it.
///
/// The key itself keeps the browser's own `KeyboardEvent.key` spelling
/// (`ArrowLeft`, `Enter`, `/`) — mesa invents no key names, so what the editor
/// records from a real keystroke is exactly what it stores.
fn canonical_chord(chord: &str) -> Result<String, String> {
    let trimmed = chord.trim();
    if trimmed.is_empty() {
        return Err("a chord cannot be empty".to_string());
    }
    if trimmed.chars().count() > MAX_CHORD_LEN {
        return Err(format!(
            "the chord {trimmed:?} is longer than {MAX_CHORD_LEN} characters"
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(format!(
            "the chord {trimmed:?} contains whitespace; a key name has none"
        ));
    }
    let parts: Vec<&str> = trimmed.split('+').collect();
    let (key, mods) = parts.split_last().expect("split always yields one part");
    if key.is_empty() {
        return Err(format!("the chord {trimmed:?} names no key"));
    }
    let mut held: Vec<&str> = Vec::new();
    for part in mods {
        let Some(name) = CHORD_MODIFIERS
            .iter()
            .find(|m| m.eq_ignore_ascii_case(part))
        else {
            return Err(format!(
                "{part:?} is not a modifier mesa knows; chords carry {}",
                CHORD_MODIFIERS.join(", ")
            ));
        };
        if held.contains(name) {
            return Err(format!("the chord {trimmed:?} names {name} twice"));
        }
        held.push(name);
    }
    // A modifier on its own is not a chord — `Shift` alone can never fire, and
    // recording one would swallow the very keystroke that starts a real chord.
    for name in ["Mod", "Shift", "Control", "Ctrl", "Meta", "Alt", "AltGraph"] {
        if key.eq_ignore_ascii_case(name) {
            return Err(format!(
                "{key:?} is a modifier, not a key; a chord ends in the key that is pressed"
            ));
        }
    }
    let key = if key.chars().count() == 1 {
        key.to_lowercase()
    } else {
        (*key).to_string()
    };
    let mut out = String::new();
    for name in CHORD_MODIFIERS {
        if held.contains(name) {
            out.push_str(name);
            out.push('+');
        }
    }
    out.push_str(&key);
    Ok(out)
}

/// The collision rule: no chord may belong to two actions. Reported naming the
/// chord and both actions, since "there is a conflict" is not something a user
/// can act on.
fn check_no_chord_collision(effective: &HashMap<String, Vec<String>>) -> Result<(), String> {
    // Walked in the shipped order rather than the map's, so the same clash
    // always reports the same pair in the same order.
    let mut seen: HashMap<String, &str> = HashMap::new();
    for (action, _) in KEYMAP_ACTIONS {
        let Some(chords) = effective.get(*action) else {
            continue;
        };
        for chord in chords {
            let key = match canonical_chord(chord) {
                Ok(k) => k,
                // Already validated on every path that reaches here; a chord
                // read off disk that isn't is dropped before this point.
                Err(_) => continue,
            };
            if let Some(other) = seen.insert(key.clone(), action) {
                return Err(format!(
                    "the chord {key:?} is bound to both {other:?} and {action:?}; \
                     one chord belongs to one action"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, json: &str) -> PathBuf {
        let path = dir.join("config.json");
        std::fs::write(&path, json).unwrap();
        path
    }

    /// The unbound-agent working folder is created on demand, and asking for
    /// it twice is the same answer — a spawn calls this every time.
    #[test]
    fn the_workspace_folder_is_created_on_demand_and_is_idempotent() {
        let home = tempfile::tempdir().unwrap();
        let want = home.path().join(".naru").join("workspace");

        let first = workspace_in(home.path());
        assert_eq!(first, want);
        assert!(want.is_dir());

        let second = workspace_in(home.path());
        assert_eq!(second, want);
        assert!(want.is_dir());
    }

    /// The rename's home-directory rule (mesa task 1301): `.naru` if it
    /// exists, else `.mesa` if it exists (dir or file), else `.naru` — and the
    /// workspace follows whichever is chosen.
    #[test]
    fn the_config_dir_prefers_naru_and_falls_back_to_mesa() {
        let home = tempfile::tempdir().unwrap();
        let (naru, mesa) = (home.path().join(".naru"), home.path().join(".mesa"));

        // Neither: a fresh install gets .naru.
        assert_eq!(dot_dir_in(home.path()), naru);

        // Only .mesa, as a directory: the old install keeps it, workspace too.
        std::fs::create_dir(&mesa).unwrap();
        assert_eq!(dot_dir_in(home.path()), mesa);
        assert_eq!(workspace_in(home.path()), mesa.join("workspace"));
        assert!(!naru.exists(), "nothing may be created under .naru");

        // Only .mesa, as the config file itself: still chosen.
        std::fs::remove_dir_all(&mesa).unwrap();
        std::fs::write(&mesa, "{}").unwrap();
        assert_eq!(dot_dir_in(home.path()), mesa);

        // Both: .naru wins.
        std::fs::create_dir(&naru).unwrap();
        assert_eq!(dot_dir_in(home.path()), naru);
        assert_eq!(workspace_in(home.path()), naru.join("workspace"));
    }

    // ---- guard (mesa task 1018) ------------------------------------------

    fn guard_update(
        entries: &[(&str, Option<serde_json::Value>)],
    ) -> HashMap<String, Option<serde_json::Value>> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn an_absent_guard_section_is_the_built_in_thresholds() {
        let t = guard_thresholds_in(Path::new("/nonexistent/config.json")).unwrap();
        assert_eq!(t.cost_usd, DEFAULT_GUARD_COST_USD);
        assert_eq!(t.total_tokens, DEFAULT_GUARD_TOTAL_TOKENS);
        assert_eq!(t.cache_read_share, DEFAULT_GUARD_CACHE_READ_SHARE);
        assert_eq!(t.cache_read_min_tokens, DEFAULT_GUARD_CACHE_READ_MIN_TOKENS);

        let view = guard_in(Path::new("/nonexistent/config.json")).unwrap();
        assert_eq!(view.cost_usd, None);
        assert_eq!(view.cost_usd_default, DEFAULT_GUARD_COST_USD);
    }

    #[test]
    fn a_configured_guard_threshold_wins_and_reads_back_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"guard": {"cost-usd": 5.5, "cache-read-share": 0.6}}"#,
        );
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.cost_usd, 5.5);
        assert_eq!(t.cache_read_share, 0.6);
        // Untouched keys stay on their built-ins.
        assert_eq!(t.total_tokens, DEFAULT_GUARD_TOTAL_TOKENS);

        let view = guard_in(&path).unwrap();
        assert_eq!(view.cost_usd, Some(5.5));
        assert_eq!(view.total_tokens, None);
    }

    #[test]
    fn a_hand_edited_out_of_range_guard_value_falls_back_per_key() {
        // The editor refuses to write these; a hand-edited file can still hold
        // them, and a `0` ceiling must not silently switch the guard off.
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"guard": {"cost-usd": 0, "cache-read-share": 4, "total-tokens": 500}}"#,
        );
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.cost_usd, DEFAULT_GUARD_COST_USD);
        assert_eq!(t.cache_read_share, DEFAULT_GUARD_CACHE_READ_SHARE);
        // The one value that IS in range is still honoured.
        assert_eq!(t.total_tokens, 500);
        // …and the reader still shows the file as written.
        assert_eq!(guard_in(&path).unwrap().cost_usd, Some(0.0));
    }

    #[test]
    fn a_guard_value_of_the_wrong_type_is_an_error_not_a_guess() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"guard": {"cost-usd": "lots"}}"#);
        assert!(guard_thresholds_in(&path).is_err());
    }

    #[test]
    fn save_guard_rejects_a_bad_threshold_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"guard": {"cost-usd": 12.0}}"#;
        let path = write_config(dir.path(), before);
        for (label, key, value) in [
            ("zero dollars", GUARD_COST_USD, serde_json::json!(0)),
            ("negative dollars", GUARD_COST_USD, serde_json::json!(-1)),
            ("dollars as text", GUARD_COST_USD, serde_json::json!("25")),
            (
                "over the sanity bound",
                GUARD_COST_USD,
                serde_json::json!(100_001),
            ),
            ("zero tokens", GUARD_TOTAL_TOKENS, serde_json::json!(0)),
            (
                "fractional tokens",
                GUARD_TOTAL_TOKENS,
                serde_json::json!(2.5),
            ),
            (
                "a share above one",
                GUARD_CACHE_READ_SHARE,
                serde_json::json!(1.5),
            ),
            (
                "a share below the floor",
                GUARD_CACHE_READ_SHARE,
                serde_json::json!(0.2),
            ),
            (
                "a zero spin floor",
                GUARD_CACHE_READ_MIN_TOKENS,
                serde_json::json!(0),
            ),
        ] {
            let err = save_guard_in(&path, &guard_update(&[(key, Some(value))])).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{label}: {err:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{label}");
        }
        let err = save_guard_in(
            &path,
            &guard_update(&[("cost-eur", Some(serde_json::json!(1)))]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown guard setting")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn the_repeat_count_and_action_read_defaults_clamp_and_validate() {
        let dir = tempfile::tempdir().unwrap();

        // Absent: the built-ins, and stopping is the built-in posture.
        let path = write_config(dir.path(), r#"{}"#);
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.repeat_count, DEFAULT_GUARD_REPEAT_COUNT as u64);
        assert_eq!(t.action, GuardAction::Stop);
        let shown = guard_in(&path).unwrap();
        assert_eq!(shown.repeat_count, None);
        assert_eq!(shown.action, None);
        assert_eq!(shown.repeat_count_default, 30);
        assert_eq!(shown.action_default, "stop");

        // Configured: both honoured, with no restart in between.
        let path = write_config(
            dir.path(),
            r#"{"guard": {"repeat-count": 5, "action": "report"}}"#,
        );
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.repeat_count, 5);
        assert_eq!(t.action, GuardAction::Report);

        // Hand-edited nonsense of the right *type* clamps to the built-in for
        // that key alone, and the editor still shows the file verbatim — the
        // posture every other key in this section takes.
        let path = write_config(
            dir.path(),
            r#"{"guard": {"repeat-count": 0, "action": "pause", "cost-usd": 12.0}}"#,
        );
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.repeat_count, DEFAULT_GUARD_REPEAT_COUNT as u64);
        assert_eq!(t.action, GuardAction::Stop);
        assert_eq!(t.cost_usd, 12.0);
        let shown = guard_in(&path).unwrap();
        assert_eq!(shown.repeat_count, Some(0));
        assert_eq!(shown.action.as_deref(), Some("pause"));

        // A value of the wrong type is still an error on read, so the tick
        // skips rather than guessing.
        let path = write_config(dir.path(), r#"{"guard": {"action": 3}}"#);
        assert!(guard_thresholds_in(&path).is_err());
    }

    #[test]
    fn save_guard_rejects_a_bad_repeat_count_or_action_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"guard": {"cost-usd": 12.0}}"#;
        let path = write_config(dir.path(), before);
        for (label, key, value) in [
            ("zero repeats", GUARD_REPEAT_COUNT, serde_json::json!(0)),
            (
                "negative repeats",
                GUARD_REPEAT_COUNT,
                serde_json::json!(-4),
            ),
            (
                "fractional repeats",
                GUARD_REPEAT_COUNT,
                serde_json::json!(2.5),
            ),
            (
                "past the sanity bound",
                GUARD_REPEAT_COUNT,
                serde_json::json!(100_001),
            ),
            (
                "repeats as text",
                GUARD_REPEAT_COUNT,
                serde_json::json!("30"),
            ),
            (
                "an unknown action",
                GUARD_ACTION,
                serde_json::json!("pause"),
            ),
            (
                "a capitalised action",
                GUARD_ACTION,
                serde_json::json!("Stop"),
            ),
            ("an action as a number", GUARD_ACTION, serde_json::json!(1)),
            ("an action as a bool", GUARD_ACTION, serde_json::json!(true)),
        ] {
            let err = save_guard_in(&path, &guard_update(&[(key, Some(value))])).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{label}: {err:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{label}");
        }
        // Both good values write, and `null` puts each back to the built-in.
        save_guard_in(
            &path,
            &guard_update(&[
                (GUARD_REPEAT_COUNT, Some(serde_json::json!(4))),
                (GUARD_ACTION, Some(serde_json::json!("report"))),
            ]),
        )
        .unwrap();
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.repeat_count, 4);
        assert_eq!(t.action, GuardAction::Report);
        save_guard_in(
            &path,
            &guard_update(&[(GUARD_REPEAT_COUNT, None), (GUARD_ACTION, None)]),
        )
        .unwrap();
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.repeat_count, DEFAULT_GUARD_REPEAT_COUNT as u64);
        assert_eq!(t.action, GuardAction::Stop);
        assert_eq!(t.cost_usd, 12.0, "the sibling key is untouched");
    }

    #[test]
    fn save_guard_writes_one_section_and_leaves_the_others_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool {id}"},
                "watchers": {"todo-concurrency": 3},
                "live": {"auto-send-ms": 3000}}"#,
        );
        save_guard_in(
            &path,
            &guard_update(&[
                (GUARD_COST_USD, Some(serde_json::json!(9.5))),
                (GUARD_TOTAL_TOKENS, Some(serde_json::json!(250))),
            ]),
        )
        .unwrap();
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["commands"]["todo-watcher"], "mytool {id}");
        assert_eq!(root["watchers"]["todo-concurrency"], 3);
        assert_eq!(root["live"]["auto-send-ms"], 3000);
        assert_eq!(root["guard"]["cost-usd"], 9.5);
        assert_eq!(root["guard"]["total-tokens"], 250);

        // `null` removes a key, restoring the built-in behind it.
        save_guard_in(&path, &guard_update(&[(GUARD_COST_USD, None)])).unwrap();
        let t = guard_thresholds_in(&path).unwrap();
        assert_eq!(t.cost_usd, DEFAULT_GUARD_COST_USD);
        assert_eq!(t.total_tokens, 250);
    }

    #[test]
    fn command_in_missing_file_is_unconfigured() {
        assert_eq!(
            command_in(Path::new("/nonexistent/config.json"), TODO_WATCHER),
            Ok(None)
        );
    }

    #[test]
    fn command_in_reads_a_command_and_misses_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool run {id}"}}"#,
        );
        assert_eq!(
            command_in(&path, TODO_WATCHER).unwrap().as_deref(),
            Some("mytool run {id}")
        );
        assert_eq!(command_in(&path, INBOX_WATCHER).unwrap(), None);
    }

    #[test]
    fn command_in_migrates_the_retired_bin_and_agent_placeholders_on_read() {
        // A template saved before mesa task 1141 may still hold `{bin}` /
        // `{agent}`. Read back, it is the literal form — so it resolves to
        // exactly the argv the literal template does — while the file itself
        // is left byte-identical: the rewrite is in memory, every read.
        let dir = tempfile::tempdir().unwrap();
        let before = concat!(
            r#"{"commands": {"#,
            r#""todo-watcher": "{bin} --bg --agent {agent} --name {name} -- \"/execute-mesa-task {id}\"", "#,
            r#""agent-spawn": "cd /repo\nexec \"{bin}\" --agent {agent} -- {prompt}""#,
            r#"}}"#
        );
        let path = write_config(dir.path(), before);
        let literal =
            r#"claude --bg --agent supervisor --name {name} -- "/execute-mesa-task {id}""#;
        assert_eq!(
            command_in(&path, TODO_WATCHER).unwrap().as_deref(),
            Some(literal)
        );
        let vars = Vars {
            id: Some(4),
            name: Some("n"),
            ..Default::default()
        };
        assert_eq!(
            resolve(TODO_WATCHER, literal, &vars).unwrap(),
            resolve(
                TODO_WATCHER,
                &migrate_retired_placeholders(
                    r#"{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}""#
                ),
                &vars
            )
            .unwrap()
        );
        // Script mode too: the reference-substitution rules never see the
        // retired names, so a script that used them still runs as written.
        assert_eq!(
            command_in(&path, AGENT_SPAWN).unwrap().as_deref(),
            Some("cd /repo\nexec \"claude\" --agent supervisor -- {prompt}")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        // Only the exact braced tokens are rewritten.
        assert_eq!(
            migrate_retired_placeholders("{bin: 1} {prompt:bin} {agent}"),
            "{bin: 1} {prompt:bin} supervisor"
        );
    }

    /// mesa task 1302: a saved template spawning the pre-rename agent names
    /// is read with the new ones — bare, `"…"` and `'…'` — while `--name`, a
    /// longer agent name and a template without them come through unchanged,
    /// and the file itself is never rewritten.
    #[test]
    fn a_saved_template_naming_a_renamed_agent_reads_with_the_new_name() {
        assert_eq!(
            migrate_renamed_agents("claude --bg --agent mesa-live --name {name} -- {prompt}"),
            "claude --bg --agent naru-live --name {name} -- {prompt}"
        );
        assert_eq!(
            migrate_renamed_agents(
                r#"claude --bg --name "mesa-live" --agent "mesa-live" -- {prompt}"#
            ),
            r#"claude --bg --name "mesa-live" --agent "naru-live" -- {prompt}"#
        );
        assert_eq!(
            migrate_renamed_agents("claude --agent 'mesa-retro' --name {name}"),
            "claude --agent 'naru-retro' --name {name}"
        );
        assert_eq!(
            migrate_renamed_agents("claude --agent=mesa-retro\nclaude --agent mesa-live"),
            "claude --agent=naru-retro\nclaude --agent naru-live"
        );
        for untouched in [
            "claude --bg --agent supervisor --name mesa-live -- {prompt}",
            "claude --agent mesa-live-v2 -- x",
            "claude --agent \"mesa-live-v2\" -- x",
            "claude --agents mesa-live",
            DEFAULT_LIVE_AGENT,
            DEFAULT_RETRO,
            "",
        ] {
            assert_eq!(migrate_renamed_agents(untouched), untouched);
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let before = r#"{"commands": {"live-agent": "claude --bg --name \"mesa-live\" --agent \"mesa-live\" -- {prompt}"}}"#;
        std::fs::write(&path, before).unwrap();
        assert_eq!(
            command_in(&path, LIVE_AGENT).unwrap().as_deref(),
            Some(r#"claude --bg --name "mesa-live" --agent "naru-live" -- {prompt}"#)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn command_in_treats_blank_and_missing_section_as_unconfigured() {
        let dir = tempfile::tempdir().unwrap();
        // A blank value falls back to the default rather than expanding to an
        // empty argv — the natural way to "un-set" one command.
        let path = write_config(dir.path(), r#"{"commands": {"todo-watcher": "   "}}"#);
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
        let path = write_config(dir.path(), r#"{"other": {"x": 1}}"#);
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn command_in_rejects_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = command_in(&path, TODO_WATCHER).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
    }

    /// `save_commands_in` with an empty prompt library — what every test that
    /// is not about `{prompt:<name>}` wants. The ones that *are* call the real
    /// one with a table of their own.
    fn save_in(path: &Path, updates: &HashMap<String, String>) -> Result<(), SaveError> {
        save_commands_in(path, updates, &Prompts::default())
    }

    /// [`validate`] with an empty prompt library, for the same reason.
    fn validate_(action: &str, template: &str) -> Result<(), String> {
        validate(action, template, &Prompts::default())
    }

    /// [`resolve`] for the todo-watcher, unwrapped — most of the script tests
    /// only care what the text became.
    fn resolved(template: &str, vars: &Vars) -> String {
        resolve(TODO_WATCHER, template, vars).unwrap()
    }

    fn update(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn settings_reports_every_action_with_its_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool run {id}"}}"#,
        );
        let settings = settings_in(&path).unwrap();
        assert_eq!(settings.len(), ACTIONS.len());
        assert_eq!(settings[0].action, TODO_WATCHER);
        assert_eq!(settings[0].value.as_deref(), Some("mytool run {id}"));
        assert_eq!(settings[0].default, DEFAULT_TODO_WATCHER);
        // An unconfigured action is `None` — "falling back", not "empty".
        assert_eq!(settings[1].action, INBOX_WATCHER);
        assert_eq!(settings[1].value, None);
        assert_eq!(settings[1].default, DEFAULT_INBOX_WATCHER);
        // The placeholder vocabulary is per-action, matching `check_key`.
        assert_eq!(settings[0].placeholders, ["{id}", "{name}"]);
        assert_eq!(settings[2].action, AGENT_SPAWN);
        assert_eq!(settings[2].placeholders, ["{prompt}"]);
        // The live agent offers the union of the two shapes: it is a mesa
        // record with an id and a name, and mesa supplies its prompt.
        assert_eq!(settings[3].action, LIVE_AGENT);
        assert_eq!(settings[3].default, DEFAULT_LIVE_AGENT);
        assert_eq!(settings[3].placeholders, ["{id}", "{name}", "{prompt}"]);
        // The summariser offers the same union, for the same reason.
        assert_eq!(settings[4].action, LIVE_SUMMARY);
        assert_eq!(settings[4].default, DEFAULT_LIVE_SUMMARY);
        assert_eq!(settings[4].placeholders, ["{id}", "{name}", "{prompt}"]);
        // The dream pass (mesa task 1152) is the sixth, same union.
        assert_eq!(settings[5].action, LIVE_DREAM);
        assert_eq!(settings[5].default, DEFAULT_LIVE_DREAM);
        assert_eq!(settings[5].placeholders, ["{id}", "{name}", "{prompt}"]);
        // The retrospective (mesa task 1158) is the seventh: a mesa record
        // with no prompt of mesa's, the inbox-watcher's shape.
        assert_eq!(settings[6].action, RETRO);
        assert_eq!(settings[6].default, DEFAULT_RETRO);
        assert_eq!(settings[6].placeholders, ["{id}", "{name}"]);
    }

    /// The retro default resolves like the inbox-watcher's: the run id lands
    /// inside the quoted prompt and the session name in its own argument.
    #[test]
    fn retro_default_resolves_with_the_run_id_and_name() {
        let vars = Vars {
            id: Some(7),
            name: Some("mesa retro 7"),
            ..Default::default()
        };
        assert_eq!(
            resolve(RETRO, DEFAULT_RETRO, &vars).unwrap(),
            r#"claude --bg --agent naru-retro --name 'mesa retro 7' -- "Run mesa session retrospective 7.""#
        );
    }

    #[test]
    fn settings_surfaces_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = settings_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
    }

    #[test]
    fn save_commands_writes_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        // The file need not exist yet — nor its parent directory.
        let path = dir.path().join("nested").join("config.json");
        save_in(&path, &update(&[(AGENT_SPAWN, "  mytool -- {prompt}  ")])).unwrap();
        // Stored trimmed, and visible to the ordinary read path immediately.
        assert_eq!(
            command_in(&path, AGENT_SPAWN).unwrap().as_deref(),
            Some("mytool -- {prompt}")
        );
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn save_commands_preserves_untouched_keys_and_other_sections() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"other": {"x": 1}, "commands": {"todo-watcher": "mytool {id}"}}"#,
        );
        save_in(&path, &update(&[(INBOX_WATCHER, "mytool triage {id}")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // A section mesa knows nothing about survives the edit verbatim.
        assert_eq!(written["other"]["x"], 1);
        assert_eq!(written["commands"]["todo-watcher"], "mytool {id}");
        assert_eq!(written["commands"]["inbox-watcher"], "mytool triage {id}");
    }

    #[test]
    fn save_commands_clears_a_key_on_blank() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "mytool {id}", "agent-spawn": "mytool"}}"#,
        );
        save_in(&path, &update(&[(TODO_WATCHER, "   ")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored blank: the default is expressed by absence.
        assert!(written["commands"].get(TODO_WATCHER).is_none());
        assert_eq!(written["commands"]["agent-spawn"], "mytool");
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
        // …and a multi-line blank is blank too.
        save_in(&path, &update(&[(AGENT_SPAWN, "\n  \n")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["commands"].get(AGENT_SPAWN).is_none());
    }

    #[test]
    fn save_commands_rejects_a_bad_template_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"commands": {"todo-watcher": "mytool {id}"}}"#;
        let path = write_config(dir.path(), before);
        // Unsupported placeholder for this action…
        let err = save_in(&path, &update(&[(TODO_WATCHER, "mytool {prompt}")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unsupported placeholder")),
            "{err:?}"
        );
        // …an unterminated quote, which `bash -n` refuses…
        let err = save_in(&path, &update(&[(AGENT_SPAWN, "mytool \"oops")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("not valid bash")),
            "{err:?}"
        );
        // …and a key mesa doesn't configure.
        let err = save_in(&path, &update(&[("tsak", "mytool")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown command")),
            "{err:?}"
        );
        // Every rejection is total: the file is byte-identical.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn save_commands_is_all_or_nothing_across_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"commands": {}}"#;
        let path = write_config(dir.path(), before);
        // One good entry, one bad one — the good one must not land either.
        let err = save_in(
            &path,
            &update(&[(TODO_WATCHER, "mytool {id}"), (AGENT_SPAWN, "mytool {id}")]),
        )
        .unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn save_commands_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = save_in(&path, &update(&[(TODO_WATCHER, "mytool {id}")])).unwrap_err();
        // Unavailable, not validation: the user's template was fine, the file
        // on this machine isn't — and overwriting it would destroy content.
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn saved_templates_resolve_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_in(
            &path,
            &update(&[(TODO_WATCHER, r#"mytool --name {name} -- "/go {id}""#)]),
        )
        .unwrap();
        let template = command_in(&path, TODO_WATCHER).unwrap().unwrap();
        let vars = Vars {
            id: Some(7),
            name: Some("a b"),
            ..Vars::default()
        };
        // A word-position value is single-quoted; one inside `"…"` is escaped
        // in place, so the template's own quotes still close where they did.
        assert_eq!(
            resolved(&template, &vars),
            r#"mytool --name 'a b' -- "/go 7""#
        );
    }

    #[test]
    fn default_templates_reproduce_the_pre_config_argv() {
        // The exact argv mesa hardcoded before this config existed, as the
        // script bash is handed: every value quoted, so bash's own word
        // splitting reproduces the argv `Command::args` used to build. If any
        // of these change, the check scripts' stub-argv assertions and the
        // agent CLI contract change with them.
        let vars = Vars {
            id: Some(731),
            name: Some("mesa: do the thing"),
            ..Default::default()
        };
        assert_eq!(
            resolve(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap(),
            // Literal since mesa task 1075: the run is supervised by the
            // `supervisor` agent definition.
            r#"claude --bg --agent supervisor --name 'mesa: do the thing' -- "/execute-mesa-task 731""#
        );
        assert_eq!(
            resolve(INBOX_WATCHER, DEFAULT_INBOX_WATCHER, &vars).unwrap(),
            r#"claude --bg --agent inbox-triage --name 'mesa: do the thing' -- "Triage mesa inbox item 731.""#
        );
        let spawn = Vars {
            prompt: Some("look at the tests"),
            ..Default::default()
        };
        assert_eq!(
            resolve(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &spawn).unwrap(),
            "claude --bg --model opus --agent supervisor -- 'look at the tests'"
        );
        // The live agent takes both halves: a named session id *and* the
        // prompt mesa supplies. The prompt is one argument however long or
        // hostile its text. Its agent is the literal `naru-live` definition
        // (mesa task 1068).
        let live = Vars {
            id: Some(12),
            name: Some("mesa live 12"),
            prompt: Some("listen; then say \"hi\""),
            prompts: None,
        };
        assert_eq!(
            resolve(LIVE_AGENT, DEFAULT_LIVE_AGENT, &live).unwrap(),
            r#"claude --bg --agent naru-live --name 'mesa live 12' -- 'listen; then say "hi"'"#
        );
        // …and a real bash agrees about the argv each of those makes.
        assert_eq!(
            argv_of(&resolve(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap()),
            [
                "claude",
                "--bg",
                "--agent",
                "supervisor",
                "--name",
                "mesa: do the thing",
                "--",
                "/execute-mesa-task 731",
            ]
        );
        assert_eq!(
            argv_of(&resolve(LIVE_AGENT, DEFAULT_LIVE_AGENT, &live).unwrap()),
            [
                "claude",
                "--bg",
                "--agent",
                "naru-live",
                "--name",
                "mesa live 12",
                "--",
                "listen; then say \"hi\"",
            ]
        );
    }

    /// The argv a resolved script makes, as a real bash splits it: the
    /// script's first word is swapped for a `printf` that writes one argument
    /// per line. Only for scripts whose first line is a plain command.
    fn argv_of(script: &str) -> Vec<String> {
        let (program, rest) = script.split_once(' ').unwrap_or((script, ""));
        let out = Command::new("bash")
            .arg("-c")
            .arg(format!("printf '%s\\n' '{program}' {rest}"))
            .stdin(Stdio::null())
            .output()
            .expect("bash");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn an_absent_value_is_the_empty_string() {
        // No token is dropped and no flag goes with it: a placeholder with no
        // value on this call is `''` in a word position and nothing inside
        // quotes, so a promptless spawn hands its program an empty prompt.
        let vars = Vars::default();
        assert_eq!(
            resolve(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &vars).unwrap(),
            "claude --bg --model opus --agent supervisor -- ''"
        );
        assert_eq!(
            argv_of(&resolve(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &vars).unwrap()),
            [
                "claude",
                "--bg",
                "--model",
                "opus",
                "--agent",
                "supervisor",
                "--",
                ""
            ]
        );
        let named = Vars {
            id: Some(7),
            ..Default::default()
        };
        assert_eq!(
            resolve(TODO_WATCHER, DEFAULT_TODO_WATCHER, &named).unwrap(),
            r#"claude --bg --agent supervisor --name '' -- "/execute-mesa-task 7""#
        );
        assert_eq!(resolved("t run \"{name}\" {id}", &named), "t run \"\" '7'");
    }

    #[test]
    fn untrusted_values_stay_one_argument() {
        // The whole point of quoting at the slot: a name full of spaces,
        // quotes and shell metacharacters is one argument, and the argv length
        // is fixed by the template.
        let hostile = r#"drop "; rm -rf / #' --dangerously-skip-permissions"#;
        let vars = Vars {
            id: Some(1),
            name: Some(hostile),
            ..Default::default()
        };
        let argv = argv_of(&resolve(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap());
        assert_eq!(argv.len(), 8);
        assert_eq!(argv[5], hostile);
    }

    #[test]
    fn placeholders_are_scoped_to_the_action() {
        let vars = Vars {
            id: Some(1),
            prompt: Some("p"),
            ..Default::default()
        };
        // agent-spawn has no mesa record behind it, so no {id}/{name}…
        let err = resolve(AGENT_SPAWN, "claude {id}", &vars).unwrap_err();
        assert!(err.contains("{id}"), "{err}");
        assert!(err.contains("agent-spawn offers {prompt}"), "{err}");
        // …and the watchers' prompt is theirs to write, not mesa's to inject.
        let err = resolve(TODO_WATCHER, "claude {prompt}", &vars).unwrap_err();
        assert!(err.contains("{prompt}"), "{err}");
        assert!(err.contains("todo-watcher offers {id}, {name}"), "{err}");
        // A placeholder-shaped name mesa does not know is a typo, not text:
        // bash has no use for `{nope}` either.
        let err = resolve(TODO_WATCHER, "claude {nope}", &vars).unwrap_err();
        assert!(err.contains("{nope}"), "{err}");
        // The two placeholders mesa task 1141 retired are unknown names now,
        // refused exactly like `{nope}` — a template saved anew with either
        // is a validation error, not a silent literal.
        for retired in ["claude --bg --agent {agent} -- {id}", "{bin} --bg -- {id}"] {
            let err = resolve(TODO_WATCHER, retired, &vars).unwrap_err();
            assert!(err.contains("unsupported placeholder"), "{err}");
            assert!(validate_(TODO_WATCHER, retired).is_err(), "{retired}");
        }
    }

    #[test]
    fn a_scripts_own_shell_syntax_is_not_mistaken_for_a_placeholder() {
        // `${VAR}`, brace expansion, `{ …; }` grouping and jq's object syntax
        // all contain braces; only a placeholder-shaped name is one.
        for script in [
            "cd /repo\nexec \"$CLAUDE_BIN\" --name \"${HOME}\"",
            "cd /repo\ncp a.txt{,.bak}\n{ echo one; echo two; }",
            "cd /repo\necho '{id: 1}' | tee out.json",
            "cd /repo\necho {bin: 1} {1..3} a{b mesa-{}",
        ] {
            assert_eq!(validate_(TODO_WATCHER, script), Ok(()), "{script}");
            assert_eq!(
                resolved(script, &Vars::default()),
                script.trim(),
                "{script}"
            );
        }
        // A placeholder can sit inside a larger word: `mesa-{id}` is one
        // argument, `{name}{id}` one word.
        let vars = Vars {
            id: Some(5),
            name: Some("n"),
            ..Default::default()
        };
        assert_eq!(
            resolved("t mesa-{id} {name}{id}", &vars),
            "t mesa-'5' 'n''5'"
        );
        assert_eq!(
            argv_of(&resolved("t mesa-{id} {name}{id}", &vars)),
            ["t", "mesa-5", "n5"]
        );
    }

    #[test]
    fn a_dollar_before_a_brace_is_bashs_own_parameter_expansion() {
        // `${name}` is a parameter expansion bash owns, left alone; the two
        // placeholders beside it are mesa's and become quoted values.
        let vars = Vars {
            name: Some("foo$"),
            id: Some(9),
            ..Default::default()
        };
        assert_eq!(
            resolved("true\nprintf '%s' ${name} $ {name}{id}", &vars),
            "true\nprintf '%s' ${name} $ 'foo$''9'"
        );
    }

    #[test]
    fn command_in_migrates_mesa_variable_references_on_read() {
        // A script saved before mesa task 1143 read its values as `MESA_*`
        // variables, which mesa no longer sets. Read back, every spelling of
        // such a reference is the placeholder it meant — the enclosing `"…"`
        // consumed, since a placeholder arrives quoted — while the file itself
        // is left byte-identical, exactly like the `{bin}`/`{agent}` rewrite.
        let dir = tempfile::tempdir().unwrap();
        let before = serde_json::json!({"commands": {
            "todo-watcher": "cd /repo\nexec claude --name \"$MESA_NAME\" -- \"work on ${MESA_ID}\" ${MESA_ID-} $MESA_NAME",
            "agent-spawn": "printf '%s' \"${MESA_PROMPT-}\" $MESA_PROMPT_NIGHTLY_BRIEF \"${MESA_PROMPT_A_B}\"",
        }})
        .to_string();
        let path = write_config(dir.path(), &before);
        assert_eq!(
            command_in(&path, TODO_WATCHER).unwrap().as_deref(),
            Some("cd /repo\nexec claude --name {name} -- \"work on {id}\" {id} {name}")
        );
        assert_eq!(
            command_in(&path, AGENT_SPAWN).unwrap().as_deref(),
            Some("printf '%s' {prompt} {prompt:nightly-brief} {prompt:a-b}")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        // Only mesa's own three names and the prompt prefix are rewritten; an
        // identifier that merely starts with one is some other variable, a
        // quote that does not pair up stays, and `$MESA_DB` is untouched.
        assert_eq!(
            migrate_env_references("$MESA_IDX ${MESA_NAMES} \"$MESA_ID $MESA_DB\" $MESA_PROMPT_"),
            "$MESA_IDX ${MESA_NAMES} \"{id} $MESA_DB\" $MESA_PROMPT_"
        );
        // A migrated hook resolves like one written with placeholders.
        let vars = Vars {
            id: Some(4),
            name: Some("a b"),
            ..Default::default()
        };
        assert_eq!(
            resolved(&command_in(&path, TODO_WATCHER).unwrap().unwrap(), &vars),
            "cd /repo\nexec claude --name 'a b' -- \"work on 4\" '4' 'a b'"
        );
    }

    #[test]
    fn save_refuses_a_mesa_variable_reference() {
        // The other half of the migration: a hand-typed `$MESA_NAME` must not
        // save and then silently read as empty on every spawn.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        for (template, spelling, fix) in [
            ("claude --name \"$MESA_NAME\"", "$MESA_NAME", "{name}"),
            ("cd /repo\nclaude -- ${MESA_ID}", "${MESA_ID}", "{id}"),
            (
                "claude -- \"${MESA_PROMPT-}\"",
                "${MESA_PROMPT-}",
                "{prompt}",
            ),
            (
                "claude -- $MESA_PROMPT_STOP_NOTIFY",
                "$MESA_PROMPT_STOP_NOTIFY",
                "{prompt:stop-notify}",
            ),
        ] {
            let err = save_in(&path, &update(&[(LIVE_AGENT, template)])).unwrap_err();
            let SaveError::Validation(message) = &err else {
                panic!("{template}: {err:?}");
            };
            assert!(message.contains(spelling), "{template}: {message}");
            assert!(message.contains(fix), "{template}: {message}");
            assert!(message.contains("no longer sets"), "{template}: {message}");
        }
        assert!(!path.exists(), "a refused save wrote the file");
        // A variable mesa reads but never set for a hook is not one of these.
        save_in(
            &path,
            &update(&[(LIVE_AGENT, "echo \"$MESA_DB\" $MESA_IDX")]),
        )
        .unwrap();
    }

    // ---- quoting at the slot (mesa task 1143) ---------------------------

    #[test]
    fn a_value_is_quoted_for_the_context_it_sits_in() {
        let vars = Vars {
            name: Some("it's \"a\" $b `c` \\d"),
            id: Some(7),
            ..Default::default()
        };
        // A word position: single-quoted, `'` spelled `'\''`.
        assert_eq!(
            resolved("echo {name}", &vars),
            "echo 'it'\\''s \"a\" $b `c` \\d'"
        );
        // Inside `"…"`: escaped in place, the four characters that mean
        // anything there — no quotes of mesa's own.
        assert_eq!(
            resolved("echo \"x {name} y\"", &vars),
            "echo \"x it's \\\"a\\\" \\$b \\`c\\` \\\\d y\""
        );
        // `$(…)` is a fresh word position even inside `"…"`.
        assert_eq!(
            resolved("echo \"$(printf %s {name})\"", &vars),
            "echo \"$(printf %s 'it'\\''s \"a\" $b `c` \\d')\""
        );
        // A heredoc body: only `\`, `$` and `` ` `` can be escaped, and a `"`
        // is literal text there.
        assert_eq!(
            resolved("cat <<EOF\n{name}\nEOF", &vars),
            "cat <<EOF\nit's \"a\" \\$b \\`c\\` \\\\d\nEOF"
        );
        // A comment: quoted like a word, and never read.
        assert_eq!(resolved("true # {id}", &vars), "true # '7'");
    }

    /// Runs a resolved script through a real bash and answers what it wrote.
    fn run_resolved(template: &str, vars: &Vars, log: &std::path::Path) -> String {
        let script = resolved(template, vars);
        let _ = std::fs::remove_file(log);
        let out = Command::new("bash")
            .arg("-c")
            .arg(&script)
            .stdin(Stdio::null())
            .output()
            .expect("bash");
        assert!(
            out.status.success(),
            "{script}\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        std::fs::read_to_string(log).unwrap_or_default()
    }

    #[test]
    fn a_hostile_value_survives_every_position_a_placeholder_may_take() {
        // End to end, through a real bash: the value comes back byte-identical
        // and nothing it contains is ever executed. The payloads are shaped
        // like the dangerous ones but touch a file in a temp dir, because this
        // test *runs* them.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let pwned = dir.path().join("pwned");
        let payload = format!("\"; touch {}; \"", pwned.display());
        let quoted_payload = format!("'; touch {}; '", pwned.display());
        let ansi_payload = format!("x'; touch {}; :'", pwned.display());
        let heredoc_payload = format!("x\nEOF\ntouch {}\ncat <<EOF\n", pwned.display());
        let log_arg = log.display().to_string();
        for body in [
            "true\nprintf '%s' {name} > LOG",
            "true\nprintf '%s' \"{name}\" > LOG",
            "true\nprintf '%s' \"$(printf '%s' {name})\" > LOG",
            "true\nprintf '%s' \"$( (true) ; printf %s {name} )\" > LOG",
            "true\ncat > LOG <<EOF\n{name}\nEOF",
            "true\ncat > LOG <<EOF\npre {name} post\nEOF",
        ] {
            let template = body.replace("LOG", &log_arg);
            let heredoc = body.contains("<<EOF");
            for hostile in [
                payload.as_str(),
                quoted_payload.as_str(),
                ansi_payload.as_str(),
                heredoc_payload.as_str(),
                "$(id)",
                "`id`",
                "\\",
                "back\\slash \"and\" 'quotes'",
                "$MESA_NAME ${MESA_NAME} !ref \\$x \\\\",
                "two words",
                "* ? [a-z]",
                "line one\nline two",
                "\ttabbed\n\tlines",
            ] {
                let vars = Vars {
                    name: Some(hostile),
                    ..Default::default()
                };
                let got = run_resolved(&template, &vars, &log);
                // A heredoc body always ends in a newline, and `$(…)` strips
                // trailing ones — a value with newlines rides through one in
                // a heredoc too — so compare what each can carry.
                let expected = if heredoc {
                    let value = hostile.trim_end_matches('\n');
                    if body.contains("pre ") {
                        format!("pre {value} post\n")
                    } else {
                        format!("{value}\n")
                    }
                } else if body.contains("$(") {
                    hostile.trim_end_matches('\n').to_string()
                } else {
                    hostile.to_string()
                };
                assert_eq!(got, expected, "{template} with {hostile:?}");
                assert!(
                    !pwned.exists(),
                    "the injected command ran: {template} with {hostile:?}"
                );
            }
        }
    }

    #[test]
    fn a_value_with_a_newline_cannot_end_a_heredoc_or_a_comment() {
        // Bash finds a heredoc's delimiter line by line *before* expanding the
        // body, and a comment ends at a newline — the two contexts where a
        // newline in a value would put its next line in front of the parser.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let pwned = dir.path().join("pwned");
        let hostile = format!("x\nEOF\ntouch {}\ncat <<EOF\ny", pwned.display());
        let vars = Vars {
            name: Some(&hostile),
            ..Default::default()
        };
        let template = format!("true\ncat > {} <<EOF\n{{name}}\nEOF", log.display());
        // The body is one line of `$(printf '%s' $'…')`, so no line of it can
        // match `EOF`.
        assert!(
            resolved(&template, &vars).contains("$(printf '%s' $'x\\nEOF\\ntouch "),
            "{}",
            resolved(&template, &vars)
        );
        assert_eq!(run_resolved(&template, &vars, &log), format!("{hostile}\n"));
        assert!(!pwned.exists(), "the heredoc was ended early");
        // `<<-` strips a leading tab from each body line before expansion, so
        // a value starting with one rides the same way.
        let tabbed = "\tkeep my tab";
        let vars = Vars {
            name: Some(tabbed),
            ..Default::default()
        };
        let template = format!("true\ncat > {} <<-EOF\n\t{{name}}\n\tEOF", log.display());
        assert_eq!(run_resolved(&template, &vars, &log), format!("{tabbed}\n"));
        // A comment folds the value's newlines: the second line is still
        // inside the comment.
        let hostile = format!("note\ntouch {}", pwned.display());
        let vars = Vars {
            name: Some(&hostile),
            ..Default::default()
        };
        let template = format!("true # {{name}}\nprintf '%s' done > {}", log.display());
        assert!(!resolved(&template, &vars).contains("\ntouch"));
        assert_eq!(run_resolved(&template, &vars, &log), "done");
        assert!(!pwned.exists(), "the comment was ended early");
    }

    #[test]
    fn the_three_lexer_holes_that_broke_an_earlier_draft_stay_closed() {
        // A security review's three proofs of concept against an earlier
        // value-substituting draft, kept as regressions now that values are
        // substituted again. (2) was a confirmed RCE; (1) and (3) were
        // mis-lexings that reached bad shell text.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let pwned = dir.path().join("pwned");
        let log_arg = log.display().to_string();
        // (1) `$'…'` is ANSI-C quoting, not a single-quoted string. Refused:
        // a `'` in the value would close the run, and `\n` would be read.
        let poc1 = format!("true\nprintf '%s' $'{{name}}' > {log_arg}");
        let err = validate_(TODO_WATCHER, &poc1).unwrap_err();
        assert!(err.contains("ANSI-C"), "{err}");
        assert!(
            resolve(TODO_WATCHER, &poc1, &Vars::default()).is_err(),
            "{poc1}"
        );
        // (2) a `)` that closed a `$(` which was never opened, mis-typing
        // everything after it as `"…"` — so the value was escaped for `"…"`
        // while actually sitting in a word position, where a `"` in it
        // opened a string. The subshell is tracked now.
        let poc2 = format!("true\nprintf '%s' \"$( (uname) ; printf %s {{name}} )\" > {log_arg}");
        let hostile = format!("x\"; touch {}; \"", pwned.display());
        let vars = Vars {
            name: Some(&hostile),
            ..Default::default()
        };
        let got = run_resolved(&poc2, &vars, &log);
        // `uname`'s own output leads; what matters is that the value follows it
        // as literal text (so nothing in it ran) — asserted without pinning the
        // platform this test happens to run on.
        assert!(got.ends_with(&hostile), "{got:?}");
        assert!(!pwned.exists(), "PoC 2 still executes");
        // (3) bash starts a comment after `)`, which an earlier predecessor
        // set omitted, so the value was read as code. A comment is a context
        // of its own now, and the value stays inside it.
        let poc3 = format!("true\n(true)# note {{name}}\nprintf '%s' done > {log_arg}");
        let vars = Vars {
            name: Some(&format!("x\ntouch {}", pwned.display())),
            ..Default::default()
        };
        assert_eq!(run_resolved(&poc3, &vars, &log), "done");
        assert!(!pwned.exists(), "PoC 3 still executes");
    }

    #[test]
    fn a_substituted_value_never_globs_and_never_word_splits() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let log_arg = log.display().to_string();
        let dir_arg = dir.path().display().to_string();
        for body in [
            "true\ncd DIR\nprintf '[%s]' {name} > LOG",
            "true\ncd DIR\nprintf '[%s]' \"{name}\" > LOG",
            "true\ncd DIR\nprintf '[%s]' \"$(printf %s {name})\" > LOG",
        ] {
            let template = body.replace("LOG", &log_arg).replace("DIR", &dir_arg);
            for hostile in ["two words", "*", "a.tx?", "  spaced  ", "~", "$HOME"] {
                let vars = Vars {
                    name: Some(hostile),
                    ..Default::default()
                };
                // One `[…]` means one word: no splitting, no globbing, no
                // tilde or parameter expansion.
                assert_eq!(
                    run_resolved(&template, &vars, &log),
                    format!("[{hostile}]"),
                    "{template} with {hostile:?}"
                );
            }
        }
    }

    #[test]
    fn a_placeholder_is_refused_where_no_value_could_go() {
        // The single-quote family: a `'` in the value would end the run, and
        // inside `$'…'` its backslashes would be read — so nothing mesa could
        // emit there is right. Plus backticks, whose rules differ from
        // `$(…)`'s just enough not to guess.
        for (script, place) in [
            ("set -eu\necho '{name}'", "single quotes"),
            ("set -eu\nprintf '%s' $'{name}'", "ANSI-C"),
            ("set -eu\ncat <<'END'\n{name}\nEND", "delimiter is quoted"),
            ("set -eu\necho `id {name}`", "command substitution"),
        ] {
            let err = validate_(TODO_WATCHER, script).unwrap_err();
            assert!(err.contains("{name}"), "{script}: {err}");
            assert!(err.contains(place), "{script}: {err}");
            assert!(
                resolve(TODO_WATCHER, script, &Vars::default()).is_err(),
                "the spawn path must refuse it too: {script}"
            );
        }
        // An *unquoted* heredoc expands, so it is an ordinary position; so is
        // a comment, and so is anything after either has ended.
        for ok in [
            "set -eu\ncat <<EOF\n{name}\nEOF",
            "set -eu\n# note {name}\necho done",
            "set -eu\ncat <<EOF\nhello\nEOF\necho {name}",
            "set -eu\necho 'quoted' {name}",
        ] {
            assert_eq!(validate_(TODO_WATCHER, ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn a_placeholder_as_a_heredoc_delimiter_is_refused_not_ignored() {
        // `read_heredoc` eats the delimiter word before the main loop sees the
        // `{`, so this used to be the one spot where a placeholder neither
        // substituted nor errored — it just stayed as braces.
        let script = "true\ncat <<{name}\nhello\n{name}";
        let err = validate_(TODO_WATCHER, script).unwrap_err();
        assert!(err.contains("{name}"), "{err}");
        assert!(err.contains("delimiter word"), "{err}");
        assert!(
            resolve(TODO_WATCHER, script, &Vars::default()).is_err(),
            "{err}"
        );
        // `<<-` and a quoted delimiter go the same way…
        for script in [
            "true\ncat <<-{name}\nhello\n{name}",
            "true\ncat <<'{name}'\nhello\n{name}",
        ] {
            assert!(validate_(TODO_WATCHER, script).is_err(), "{script}");
        }
        // …while a fixed delimiter with a placeholder in the *body* is fine.
        assert_eq!(
            validate_(TODO_WATCHER, "true\ncat <<EOF\n{name}\nEOF"),
            Ok(())
        );
    }

    #[test]
    fn arithmetic_is_refused_because_it_re_parses_what_it_is_given() {
        // Arithmetic evaluation is a *second* parser, and an array subscript
        // inside it is itself expanded, so a value of `a[$(cmd)]` runs the
        // command however it was quoted. Both spellings the lexer can cheaply
        // see are refused, on the save path and the spawn path alike.
        for script in [
            "true\nn=$(( {id} + 1 ))",
            "true\n(( n = {id} ))",
            "true\nif (( {id} > 0 )); then echo yes; fi",
            // …including the one reached through a heredoc body.
            "true\ncat <<EOF\n$(( {id} ))\nEOF",
        ] {
            let err = validate_(TODO_WATCHER, script).unwrap_err();
            assert!(err.contains("{id}"), "{script}: {err}");
            assert!(err.contains("arithmetic"), "{script}: {err}");
            assert!(
                resolve(TODO_WATCHER, script, &Vars::default()).is_err(),
                "the spawn path must refuse it too: {script}"
            );
        }
        // `( (` with a space is a subshell, not arithmetic — bash reads it that
        // way and so does mesa, so the PoC-2 shape still works.
        let vars = Vars {
            name: Some("v"),
            ..Default::default()
        };
        assert_eq!(
            resolved(
                "true\necho \"$( (true) ; printf %s {name} )\"\nm=$(( (2) * 3 ))",
                &vars
            ),
            "true\necho \"$( (true) ; printf %s 'v' )\"\nm=$(( (2) * 3 ))"
        );
    }

    #[test]
    fn arithmetic_refusal_is_inherited_by_every_nested_context() {
        // `Ctx::Arith` is a stack-*top* test, and a nested `$(…)` pushes
        // `CmdSub` on top of it — but arithmetic re-reads that substitution's
        // **output**, so the subscript gadget fires there too. The refusal is
        // asked of the whole stack.
        for script in [
            "true\necho $(( $(echo {name}) ))",
            "true\ncat <<EOF\n$(( $(echo {name}) ))\nEOF",
            "true\necho $(( (1+{name}) ))",
            "true\necho $(( \"{name}\" ))",
            "true\necho $(( $(echo $(echo {name})) ))",
            "true\n(( n = $( (echo {name}) ) ))",
        ] {
            let err = validate_(TODO_WATCHER, script).unwrap_err();
            assert!(err.contains("{name}"), "{script}: {err}");
            assert!(err.contains("arithmetic"), "{script}: {err}");
            assert!(
                resolve(TODO_WATCHER, script, &Vars::default()).is_err(),
                "the spawn path must refuse it too: {script}"
            );
        }
        // Leaving arithmetic must clear it again — the flag is positional, not
        // sticky for the rest of the script.
        assert_eq!(
            validate_(TODO_WATCHER, "true\nn=$(( 1 + 1 ))\necho {name}"),
            Ok(())
        );
        // The refusal names no variable: there are none to name.
        let err = validate_(TODO_WATCHER, "true\necho $(( {id} ))").unwrap_err();
        assert!(!err.contains("MESA_"), "{err}");
    }

    #[test]
    fn a_command_substitution_in_a_heredoc_body_is_a_word_position() {
        // `$(…)` inside a heredoc body is an ordinary command context, so the
        // escaped form the body itself calls for would word-split and glob
        // there; the value is single-quoted instead.
        let vars = Vars {
            name: Some("two words"),
            ..Default::default()
        };
        assert_eq!(
            resolved(
                "true\ncat <<EOF\n$(printf '[%s]' {name})\n{name}\nEOF",
                &vars
            ),
            "true\ncat <<EOF\n$(printf '[%s]' 'two words')\ntwo words\nEOF"
        );
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let template = format!(
            "true\ncat > {} <<EOF\n$(printf '[%s]' {{name}})\nEOF",
            log.display()
        );
        assert_eq!(run_resolved(&template, &vars, &log), "[two words]\n");
    }

    #[test]
    fn an_array_subscript_payload_cannot_execute_from_any_accepted_position() {
        // `a[$(cmd)]` is the gadget that makes arithmetic a second parser: the
        // subscript is itself expanded. Arithmetic is refused, so the question
        // this test answers is the complement — that the payload is inert in
        // every position mesa *does* accept.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let pwned = dir.path().join("pwned");
        let payload = format!("a[$(touch {})]", pwned.display());
        let log_arg = log.display().to_string();
        for body in [
            "true\nprintf '%s' {name} > LOG",
            "true\nprintf '%s' \"{name}\" > LOG",
            "true\nprintf '%s' \"$(printf '%s' {name})\" > LOG",
            "true\nprintf '%s' \"$( (true) ; printf %s {name} )\" > LOG",
            "true\ncat > LOG <<EOF\n{name}\nEOF",
            "true\n# note {name}\nprintf '%s' a[$] > LOG",
            "true\nx=${y:-{name}}\nprintf '%s' \"$x\" > LOG",
        ] {
            let template = body.replace("LOG", &log_arg);
            let vars = Vars {
                name: Some(&payload),
                ..Default::default()
            };
            let got = run_resolved(&template, &vars, &log);
            let got = got.strip_suffix('\n').unwrap_or(&got).to_string();
            // The comment case writes a fixed marker, not the value — it is
            // here to prove the commented value runs nothing either.
            let expected = if template.contains("# note") {
                "a[$]".to_string()
            } else {
                payload.clone()
            };
            assert_eq!(got, expected, "{template}");
            assert!(
                !pwned.exists(),
                "the subscript payload executed: {template}"
            );
        }
        // …and every arithmetic spelling refuses it rather than emitting it.
        for script in [
            "true\necho $(( {name} ))",
            "true\n(( n = {name} ))",
            "true\ncat <<EOF\n$(( {name} ))\nEOF",
        ] {
            let vars = Vars {
                name: Some(&payload),
                ..Default::default()
            };
            assert!(resolve(TODO_WATCHER, script, &vars).is_err(), "{script}");
            assert!(validate_(TODO_WATCHER, script).is_err(), "{script}");
        }
        assert!(!pwned.exists());
    }

    #[test]
    fn the_shell_forms_the_review_found_correct_stay_correct() {
        // The review's "could not break" list, pinned so a later lexer edit
        // cannot quietly regress it. Each of these must leave a following
        // placeholder in a word position, where it is single-quoted.
        for script in [
            // `$"…"` locale quoting, `${#var}`, `$#`, `#` that starts no comment
            "true\necho $\"text\" {name}",
            "true\necho ${#PATH} $# {name}",
            "true\necho \"x\"#y {name}",
            "true\nx=#y\necho {name}",
            // `<<<` is a herestring, not a heredoc
            "true\ncat <<<word\necho {name}",
            // `<<-` with tab stripping closes on an indented delimiter
            "true\ncat <<-EOF\n\thello\n\tEOF\necho {name}",
            // `<<` that is not a redirection because of where it sits
            "true\necho '<<EOF' {name}",
            "true\necho \"<<EOF\" {name}",
            "true\n# <<EOF\necho {name}",
            // process substitution is a fresh command context
            "true\ncat <(echo {name})",
            // a backslash at the very end, and before a closing quote
            "true\necho {name} \\",
            "true\necho \"a\\\"\" {name}",
            // `${x:-…}` — bash's own expansion parser, not mesa's
            "true\necho ${x:-y} {name}",
            // UTF-8 either side, including right after a backslash skip
            "true\necho ümläut \\é {name} ✓",
        ] {
            assert_eq!(validate_(TODO_WATCHER, script), Ok(()), "{script}");
            let out = resolved(
                script,
                &Vars {
                    name: Some("v w"),
                    ..Default::default()
                },
            );
            assert!(out.contains("'v w'"), "{script} became {out}");
        }
        // CRLF: the `\r` rides along in both the recorded delimiter and the
        // line compared against it, so the heredoc closes where it looks like
        // it closes and a later placeholder is an ordinary one.
        let crlf = "true\r\ncat <<EOF\r\nhi\r\nEOF\r\necho {name}";
        assert_eq!(validate_(TODO_WATCHER, crlf), Ok(()));
        let out = resolved(
            crlf,
            &Vars {
                name: Some("v"),
                ..Default::default()
            },
        );
        assert!(out.ends_with("echo 'v'"), "{out}");
    }

    #[test]
    fn a_script_with_a_bash_syntax_error_is_refused_at_save_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let err = save_in(
            &path,
            &update(&[(TODO_WATCHER, "cd /repo\nif true; then\necho stuck")]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("not valid bash")),
            "{err:?}"
        );
        assert!(!path.exists(), "a rejected save must write nothing");
        // A well-formed script round-trips verbatim.
        let script = "cd /repo\nexec \"$CLAUDE_BIN\" --bg -- \"work on {id}\"";
        save_in(&path, &update(&[(TODO_WATCHER, script)])).unwrap();
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap().unwrap(), script);
    }
    // ---- pricing (mesa task 692) ----------------------------------------

    fn price(pairs: &[(&str, Option<ModelRates>)]) -> HashMap<String, Option<ModelRates>> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    #[test]
    fn price_table_falls_back_to_the_built_ins_and_zeros_the_unknown() {
        let table = PriceTable::builtin();
        assert_eq!(
            table.for_model("claude-opus-4-8"),
            rates(5.0, 25.0, 0.5, 6.25)
        );
        assert_eq!(
            table.for_model("claude-haiku-4-5"),
            rates(1.0, 5.0, 0.1, 1.25)
        );
        // A model no prefix matches gets no estimate rather than a wrong one.
        assert_eq!(table.for_model("<synthetic>"), rates(0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn config_overlays_the_built_ins_and_longest_prefix_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"pricing": {
                 "claude-opus": {"input": 9, "output": 9, "cache_read": 9, "cache_write": 9},
                 "claude-opus-5-mini": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}
               }}"#,
        );
        let table = PriceTable::load_from(&path).unwrap();
        // The overlay beats the built-in…
        assert_eq!(
            table.for_model("claude-opus-4-8"),
            rates(9.0, 9.0, 9.0, 9.0)
        );
        // …and a longer prefix beats a shorter one that also matches.
        assert_eq!(
            table.for_model("claude-opus-5-mini-20260101"),
            rates(1.0, 2.0, 3.0, 4.0)
        );
        // An untouched family keeps its shipped rates.
        assert_eq!(
            table.for_model("claude-sonnet-5"),
            rates(3.0, 15.0, 0.3, 3.75)
        );
        // A prefix the binary never heard of prices anyway — the whole point.
        let path = write_config(
            dir.path(),
            r#"{"pricing": {"newco-x": {"input": 2, "output": 4, "cache_read": 0, "cache_write": 0}}}"#,
        );
        let table = PriceTable::load_from(&path).unwrap();
        assert_eq!(table.for_model("newco-x-1"), rates(2.0, 4.0, 0.0, 0.0));
    }

    #[test]
    fn a_malformed_config_never_silently_prices_at_the_built_ins() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        assert!(
            PriceTable::load_from(&path)
                .unwrap_err()
                .contains("malformed mesa config")
        );
        assert!(pricing_in(&path).unwrap_err().contains("malformed"));
        // No file at all is not malformed — it's the shipped table.
        assert_eq!(
            PriceTable::load_from(Path::new("/nonexistent/config.json")).unwrap(),
            PriceTable::builtin()
        );
    }

    #[test]
    fn pricing_lists_built_ins_first_then_sorted_extras() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"pricing": {
                 "zeta": {"input": 1, "output": 1, "cache_read": 1, "cache_write": 1},
                 "alpha": {"input": 1, "output": 1, "cache_read": 1, "cache_write": 1},
                 "claude-opus": {"input": 7, "output": 7, "cache_read": 7, "cache_write": 7}
               }}"#,
        );
        let rows = pricing_in(&path).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.prefix.as_str()).collect::<Vec<_>>(),
            [
                "claude-fable",
                "claude-mythos",
                "claude-opus",
                "claude-sonnet",
                "claude-haiku",
                "alpha",
                "zeta"
            ]
        );
        // A configured built-in carries both, so the editor can offer "reset".
        assert_eq!(rows[2].value, Some(rates(7.0, 7.0, 7.0, 7.0)));
        assert_eq!(rows[2].default, Some(rates(5.0, 25.0, 0.5, 6.25)));
        // An unconfigured one is "falling back", not "empty".
        assert_eq!(rows[3].value, None);
        // A user-added prefix has nothing behind it — clearing it deletes it.
        assert_eq!(rows[5].default, None);
        assert_eq!(rows[5].value, Some(rates(1.0, 1.0, 1.0, 1.0)));
    }

    #[test]
    fn the_two_sections_preserve_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"other": {"x": 1}, "commands": {"todo-watcher": "mytool {id}"}}"#,
        );
        save_pricing_in(
            &path,
            &price(&[("claude-opus", Some(rates(1.0, 2.0, 3.0, 4.0)))]),
        )
        .unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["commands"]["todo-watcher"], "mytool {id}");
        assert_eq!(written["other"]["x"], 1);
        assert_eq!(written["pricing"]["claude-opus"]["output"], 2.0);
        // …and the commands saver leaves the pricing section alone in turn.
        save_in(&path, &update(&[(INBOX_WATCHER, "mytool triage {id}")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["pricing"]["claude-opus"]["output"], 2.0);
        assert_eq!(written["commands"]["inbox-watcher"], "mytool triage {id}");
        // Both are visible to the ordinary read paths.
        assert_eq!(
            PriceTable::load_from(&path)
                .unwrap()
                .for_model("claude-opus-9"),
            rates(1.0, 2.0, 3.0, 4.0)
        );
        assert_eq!(
            command_in(&path, INBOX_WATCHER).unwrap().as_deref(),
            Some("mytool triage {id}")
        );
    }

    #[test]
    fn removing_a_price_restores_a_built_in_and_deletes_a_user_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"pricing": {
                 "claude-opus": {"input": 9, "output": 9, "cache_read": 9, "cache_write": 9},
                 "newco": {"input": 9, "output": 9, "cache_read": 9, "cache_write": 9}
               }}"#,
        );
        save_pricing_in(&path, &price(&[("claude-opus", None), ("newco", None)])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored zeroed: the default is expressed by absence.
        assert!(written["pricing"].get("claude-opus").is_none());
        assert!(written["pricing"].get("newco").is_none());
        let table = PriceTable::load_from(&path).unwrap();
        assert_eq!(
            table.for_model("claude-opus-4-8"),
            rates(5.0, 25.0, 0.5, 6.25)
        );
        assert_eq!(table.for_model("newco-1"), rates(0.0, 0.0, 0.0, 0.0));
        // And the row disappears from the Settings view entirely.
        assert!(
            pricing_in(&path)
                .unwrap()
                .iter()
                .all(|r| r.prefix != "newco")
        );
    }

    #[test]
    fn save_pricing_rejects_a_bad_prefix_or_rate_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"pricing": {"claude-opus": {"input": 9, "output": 9, "cache_read": 9, "cache_write": 9}}}"#;
        let path = write_config(dir.path(), before);
        let good = Some(rates(1.0, 1.0, 1.0, 1.0));
        for (label, updates) in [
            ("empty prefix", price(&[("  ", good)])),
            ("whitespace", price(&[("claude opus", good)])),
            ("too long", price(&[(&"x".repeat(65), good)])),
            (
                "negative rate",
                price(&[("claude-opus", Some(rates(1.0, -1.0, 1.0, 1.0)))]),
            ),
            (
                "non-finite rate",
                price(&[("claude-opus", Some(rates(f64::NAN, 1.0, 1.0, 1.0)))]),
            ),
        ] {
            let err = save_pricing_in(&path, &updates).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{label}: {err:?}");
        }
        // A batch with one bad entry lands nothing at all.
        let err = save_pricing_in(
            &path,
            &price(&[
                ("claude-sonnet", good),
                ("claude-haiku", Some(rates(0.0, 0.0, 0.0, -0.5))),
            ]),
        )
        .unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn save_pricing_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = save_pricing_in(
            &path,
            &price(&[("claude-opus", Some(rates(1.0, 1.0, 1.0, 1.0)))]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    fn watcher(pairs: &[(&str, Option<u64>)]) -> HashMap<String, Option<serde_json::Value>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(|n| serde_json::json!(n))))
            .collect()
    }

    #[test]
    fn todo_concurrency_defaults_to_one_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        // No file at all, and a file with no watchers section: the shipped 1.
        assert_eq!(
            todo_concurrency_in(&dir.path().join("nope.json")).unwrap(),
            DEFAULT_TODO_CONCURRENCY
        );
        let path = write_config(dir.path(), r#"{"commands": {}}"#);
        assert_eq!(todo_concurrency_in(&path).unwrap(), 1);
        assert_eq!(watchers_in(&path).unwrap().todo_concurrency, None);

        save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(3))])).unwrap();
        assert_eq!(todo_concurrency_in(&path).unwrap(), 3);
        let view = watchers_in(&path).unwrap();
        assert_eq!(view.todo_concurrency, Some(3));
        assert_eq!(view.todo_concurrency_default, DEFAULT_TODO_CONCURRENCY);
    }

    /// The second watcher key (mesa task 1158): 72 with no config, the
    /// configured value round-trips, a hand-edited out-of-range value clamps
    /// on read, and the editor refuses to write one.
    #[test]
    fn retro_interval_hours_defaults_to_72_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            retro_interval_hours_in(&dir.path().join("nope.json")).unwrap(),
            DEFAULT_RETRO_INTERVAL_HOURS
        );
        let path = write_config(dir.path(), r#"{"watchers": {"todo-concurrency": 2}}"#);
        assert_eq!(retro_interval_hours_in(&path).unwrap(), 72);
        let view = watchers_in(&path).unwrap();
        assert_eq!(view.retro_interval_hours, None);
        assert_eq!(view.retro_interval_hours_default, 72);

        save_watchers_in(&path, &watcher(&[(RETRO_INTERVAL_HOURS, Some(24))])).unwrap();
        assert_eq!(retro_interval_hours_in(&path).unwrap(), 24);
        let view = watchers_in(&path).unwrap();
        assert_eq!(view.retro_interval_hours, Some(24));
        // The other key survived the save.
        assert_eq!(view.todo_concurrency, Some(2));
        assert_eq!(todo_concurrency_in(&path).unwrap(), 2);

        // `null` removes it; the default is expressed by absence.
        save_watchers_in(&path, &watcher(&[(RETRO_INTERVAL_HOURS, None)])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["watchers"].get(RETRO_INTERVAL_HOURS).is_none());
        assert_eq!(retro_interval_hours_in(&path).unwrap(), 72);

        // Hand-edited nonsense clamps on read (the `todo-concurrency` posture)…
        let path = write_config(dir.path(), r#"{"watchers": {"retro-interval-hours": 0}}"#);
        assert_eq!(retro_interval_hours_in(&path).unwrap(), 1);
        let path = write_config(
            dir.path(),
            r#"{"watchers": {"retro-interval-hours": 999999}}"#,
        );
        assert_eq!(
            retro_interval_hours_in(&path).unwrap(),
            MAX_RETRO_INTERVAL_HOURS
        );
        // …while the editor refuses to write it, byte-identically.
        let before = r#"{"watchers": {"retro-interval-hours": 48}}"#;
        let path = write_config(dir.path(), before);
        for value in [
            serde_json::json!(0),
            serde_json::json!(8761),
            serde_json::json!(1.5),
            serde_json::json!("72"),
        ] {
            let err = save_watchers_in(&path, &{
                let mut m = HashMap::new();
                m.insert(RETRO_INTERVAL_HOURS.to_string(), Some(value.clone()));
                m
            })
            .unwrap_err();
            assert!(
                matches!(&err, SaveError::Validation(m) if m.contains(RETRO_INTERVAL_HOURS)),
                "{value}: {err:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        }
    }

    #[test]
    fn removing_todo_concurrency_restores_the_built_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"watchers": {"todo-concurrency": 5}}"#);
        save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, None)])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored as 1: the default is expressed by absence.
        assert!(written["watchers"].get(TODO_CONCURRENCY).is_none());
        assert_eq!(todo_concurrency_in(&path).unwrap(), 1);
        assert_eq!(watchers_in(&path).unwrap().todo_concurrency, None);
    }

    #[test]
    fn each_saver_preserves_the_other_sections_and_unknown_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{
                 "commands": {"inbox-watcher": "mytool triage {id}"},
                 "pricing": {"claude-opus": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}},
                 "watchers": {"todo-concurrency": 4},
                 "speech": {"voice": "bm_george"},
                 "listen": {"model": "parakeet-tdt-0.6b-v2-int8"},
                 "audio": {"engine": "naru-audio"},
                 "future": {"x": 1}
               }"#,
        );
        let survives = |label: &str| {
            let root: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                root["commands"]["inbox-watcher"], "mytool triage {id}",
                "{label}"
            );
            assert_eq!(root["pricing"]["claude-opus"]["output"], 2.0, "{label}");
            assert_eq!(root["speech"][VOICE], "bm_george", "{label}");
            assert_eq!(
                root["listen"][MODEL], "parakeet-tdt-0.6b-v2-int8",
                "{label}"
            );
            assert_eq!(root["audio"][ENGINE], "naru-audio", "{label}");
            assert_eq!(root["future"]["x"], 1, "{label}");
            root
        };

        // Saving watchers leaves every other section alone.
        save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(7))])).unwrap();
        assert_eq!(survives("watchers")["watchers"][TODO_CONCURRENCY], 7);
        // …and each of the other savers leaves `watchers` alone.
        save_in(&path, &update(&[("todo-watcher", "mytool run {id}")])).unwrap();
        assert_eq!(survives("commands")["watchers"][TODO_CONCURRENCY], 7);
        save_pricing_in(
            &path,
            &price(&[("claude-sonnet", Some(rates(1.0, 1.0, 1.0, 1.0)))]),
        )
        .unwrap();
        assert_eq!(survives("pricing")["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(todo_concurrency_in(&path).unwrap(), 7);
        // The speech saver is the fourth of the same shape: it rewrites its own
        // key and nothing else (`survives` re-asserts the voice it just wrote).
        save_speech_in(&path, &voice(&[(VOICE, Some("bm_george"))]), &offered()).unwrap();
        assert_eq!(survives("speech")["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(
            survives("speech")["commands"]["todo-watcher"],
            "mytool run {id}"
        );
        // And the live saver is the fifth (mesa task 867).
        save_live_in(
            &path,
            &live_json(LIVE_AUTO_SEND_MS, Some(serde_json::json!(3000))),
        )
        .unwrap();
        let root = survives("live");
        assert_eq!(root["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(root["live"][LIVE_AUTO_SEND_MS], 3000);
        // And the listen saver is the sixth (mesa task 955).
        save_listen_in(
            &path,
            &model_update(&[(MODEL, Some("parakeet-tdt-0.6b-v2-int8"))]),
            &offered_models(),
        )
        .unwrap();
        let root = survives("listen");
        assert_eq!(root["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(root["listen"][MODEL], "parakeet-tdt-0.6b-v2-int8");
        // And the keymap saver is the seventh (mesa task 1079).
        save_keymap_in(&path, &{
            let mut m = HashMap::new();
            m.insert(
                "create-task".to_string(),
                Some(serde_json::json!(["Mod+Shift+N"])),
            );
            m
        })
        .unwrap();
        let root = survives("keymap");
        assert_eq!(root["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(root["keymap"]["create-task"][0], "Mod+Shift+n");
        // And the audio saver is the eighth (mesa task 1388).
        save_audio_in(
            &path,
            &audio_update(&[(URL, Some("http://127.0.0.1:7871"))]),
        )
        .unwrap();
        let root = survives("audio");
        assert_eq!(root["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(root["keymap"]["create-task"][0], "Mod+Shift+n");
        assert_eq!(root["audio"][URL], "http://127.0.0.1:7871");
        // The listen saver's new key leaves the model beside it alone.
        save_listen_in(
            &path,
            &model_update(&[(ENGINE, Some("browser"))]),
            &offered_models(),
        )
        .unwrap();
        assert_eq!(survives("listen engine")["listen"][ENGINE], "browser");
        // …and every other saver leaves the keymap alone in turn.
        save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(9))])).unwrap();
        assert_eq!(
            survives("watchers again")["keymap"]["create-task"][0],
            "Mod+Shift+n"
        );
    }

    #[test]
    fn save_watchers_rejects_a_bad_limit_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"watchers": {"todo-concurrency": 2}}"#;
        let path = write_config(dir.path(), before);
        for (label, value) in [
            ("zero", serde_json::json!(0)),
            ("negative", serde_json::json!(-1)),
            ("fraction", serde_json::json!(2.5)),
            ("over the bound", serde_json::json!(21)),
            ("a string", serde_json::json!("3")),
            ("null-ish text", serde_json::json!("")),
        ] {
            let mut updates = HashMap::new();
            updates.insert(TODO_CONCURRENCY.to_string(), Some(value));
            let err = save_watchers_in(&path, &updates).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{label}: {err:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{label}");
        }
        // An unknown key in the section is a validation error too, not a
        // silently stored row.
        let err = save_watchers_in(&path, &watcher(&[("todo-cadence", Some(2))])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown watcher setting")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        // The bounds themselves are inclusive.
        for ok in [1u64, u64::from(MAX_TODO_CONCURRENCY)] {
            save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(ok))])).unwrap();
            assert_eq!(todo_concurrency_in(&path).unwrap(), ok as u32);
        }
    }

    #[test]
    fn watchers_refuse_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = todo_concurrency_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
        assert!(watchers_in(&path).is_err());
        let err = save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(2))])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn a_hand_edited_limit_is_clamped_into_the_sanity_bound() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"watchers": {"todo-concurrency": 0}}"#);
        assert_eq!(todo_concurrency_in(&path).unwrap(), 1);
        // The raw value still reaches the editor, which is what refuses it.
        assert_eq!(watchers_in(&path).unwrap().todo_concurrency, Some(0));
        let path = write_config(dir.path(), r#"{"watchers": {"todo-concurrency": 500}}"#);
        assert_eq!(todo_concurrency_in(&path).unwrap(), MAX_TODO_CONCURRENCY);
    }

    fn voice(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(str::to_string)))
            .collect()
    }

    /// The voices a save is checked against. A fixture, never
    /// `speech::voices()`: what a real synthesiser on this machine happens to
    /// offer is not something a config unit test may depend on.
    fn offered() -> Vec<String> {
        ["af_heart", "af_bella", "bm_george"]
            .iter()
            .map(|v| (*v).to_string())
            .collect()
    }

    #[test]
    fn speech_round_trips_a_voice_and_resets_to_the_binary_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // No file at all: no voice, so no `-v` — the pre-822 argv.
        assert_eq!(speech_voice_in(&path).unwrap(), None);

        save_speech_in(&path, &voice(&[(VOICE, Some("  bm_george  "))]), &offered()).unwrap();
        // Stored trimmed, and visible to the read path immediately.
        assert_eq!(
            speech_voice_in(&path).unwrap().as_deref(),
            Some("bm_george")
        );
        let view = speech_in(&path).unwrap();
        assert_eq!(view.voice.as_deref(), Some("bm_george"));

        // `null` and blank both remove the key — the reset, expressed by
        // absence rather than by a stored empty string.
        for reset in [None, Some("")] {
            save_speech_in(&path, &voice(&[(VOICE, Some("af_bella"))]), &offered()).unwrap();
            save_speech_in(&path, &voice(&[(VOICE, reset)]), &offered()).unwrap();
            let written: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(written["speech"].get(VOICE).is_none(), "{reset:?}");
            assert_eq!(speech_voice_in(&path).unwrap(), None);
        }
    }

    #[test]
    fn save_speech_rejects_a_name_that_is_not_a_voice_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"speech": {"voice": "af_heart"}}"#;
        let path = write_config(dir.path(), before);
        // A name that could be read as an option, or carry a shell metacharacter
        // into an argv — refused in the editor, not at the next press.
        for bad in ["-o", "af heart", "af_heart; rm -rf /", &"a".repeat(65)] {
            let err = save_speech_in(&path, &voice(&[(VOICE, Some(bad))]), &offered()).unwrap_err();
            assert!(
                matches!(&err, SaveError::Validation(m) if m.contains("voice")),
                "{bad:?}: {err:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{bad:?}");
        }
        // An unknown key in the section is a validation error too.
        let err = save_speech_in(&path, &voice(&[("speed", Some("1.2"))]), &offered()).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown speech setting")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        // Nothing named writes nothing — no empty `"speech": {}` appears.
        let path = dir.path().join("untouched.json");
        save_speech_in(&path, &HashMap::new(), &offered()).unwrap();
        assert!(!path.exists());
    }

    /// The membership half of the check: a well-shaped name the binary never
    /// offered is refused — but only when mesa actually has a list. An empty
    /// list is "mesa could not ask", where refusing a name it merely can't
    /// check would be the worse answer.
    #[test]
    fn save_speech_refuses_an_unoffered_voice_only_when_it_has_a_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let err =
            save_speech_in(&path, &voice(&[(VOICE, Some("zz_nobody"))]), &offered()).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("zz_nobody")),
            "{err:?}"
        );
        assert!(!path.exists(), "a rejected save writes nothing");
        // No list: the same name is stored, because nothing here can disprove it.
        save_speech_in(&path, &voice(&[(VOICE, Some("zz_nobody"))]), &[]).unwrap();
        assert_eq!(
            speech_voice_in(&path).unwrap().as_deref(),
            Some("zz_nobody")
        );
    }

    /// A voice hand-edited into something the argv must never carry falls back
    /// to the binary's default on the speak path, while the editor still sees
    /// the raw value — the same split the watcher clamp draws.
    #[test]
    fn a_hand_edited_voice_that_is_not_a_name_is_ignored_but_still_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"speech": {"voice": "--output /tmp/x"}}"#);
        assert_eq!(speech_voice_in(&path).unwrap(), None);
        assert_eq!(
            speech_in(&path).unwrap().voice.as_deref(),
            Some("--output /tmp/x")
        );
    }

    #[test]
    fn speech_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = speech_voice_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
        assert!(speech_in(&path).is_err());
        let err =
            save_speech_in(&path, &voice(&[(VOICE, Some("af_heart"))]), &offered()).unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    fn model_update(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(str::to_string)))
            .collect()
    }

    /// The models a save is checked against. A fixture, never
    /// `listen::models()`: what a real recognizer on this machine happens to
    /// offer is not something a config unit test may depend on.
    fn offered_models() -> Vec<String> {
        vec!["parakeet-tdt-0.6b-v2-int8".to_string()]
    }

    #[test]
    fn listen_round_trips_a_model_and_resets_to_the_binary_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // No file at all: no model, so no `-m` — the pre-955 argv.
        assert_eq!(listen_model_in(&path).unwrap(), None);

        save_listen_in(
            &path,
            &model_update(&[(MODEL, Some("  parakeet-tdt-0.6b-v2-int8  "))]),
            &offered_models(),
        )
        .unwrap();
        // Stored trimmed, and visible to the read path immediately.
        assert_eq!(
            listen_model_in(&path).unwrap().as_deref(),
            Some("parakeet-tdt-0.6b-v2-int8")
        );
        let view = listen_in(&path).unwrap();
        assert_eq!(view.model.as_deref(), Some("parakeet-tdt-0.6b-v2-int8"));

        // `null` and blank both remove the key — the reset, expressed by
        // absence rather than by a stored empty string.
        for reset in [None, Some("")] {
            save_listen_in(
                &path,
                &model_update(&[(MODEL, Some("parakeet-tdt-0.6b-v2-int8"))]),
                &offered_models(),
            )
            .unwrap();
            save_listen_in(&path, &model_update(&[(MODEL, reset)]), &offered_models()).unwrap();
            let written: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(written["listen"].get(MODEL).is_none(), "{reset:?}");
            assert_eq!(listen_model_in(&path).unwrap(), None);
        }
    }

    #[test]
    fn save_listen_rejects_a_name_that_is_not_a_model_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"listen": {"model": "parakeet-tdt-0.6b-v2-int8"}}"#;
        let path = write_config(dir.path(), before);
        // A name that could be read as an option, or carry a shell metacharacter
        // into an argv — refused in the editor, not at the next request.
        for bad in ["-o", "a b", "a; rm -rf /", &"a".repeat(65)] {
            let err = save_listen_in(
                &path,
                &model_update(&[(MODEL, Some(bad))]),
                &offered_models(),
            )
            .unwrap_err();
            assert!(
                matches!(&err, SaveError::Validation(m) if m.contains("model")),
                "{bad:?}: {err:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{bad:?}");
        }
        // An unknown key in the section is a validation error too.
        let err = save_listen_in(
            &path,
            &model_update(&[("language", Some("en"))]),
            &offered_models(),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown listen setting")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        // Nothing named writes nothing — no empty `"listen": {}` appears.
        let path = dir.path().join("untouched.json");
        save_listen_in(&path, &HashMap::new(), &offered_models()).unwrap();
        assert!(!path.exists());
    }

    /// The membership half of the check: a well-shaped name the binary never
    /// offered is refused — but only when mesa actually has a list. An empty
    /// list is "mesa could not ask", where refusing a name it merely can't
    /// check would be the worse answer.
    #[test]
    fn save_listen_refuses_an_unoffered_model_only_when_it_has_a_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let err = save_listen_in(
            &path,
            &model_update(&[(MODEL, Some("zz-nobody"))]),
            &offered_models(),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("zz-nobody")),
            "{err:?}"
        );
        assert!(!path.exists(), "a rejected save writes nothing");
        // No list: the same name is stored, because nothing here can disprove it.
        save_listen_in(&path, &model_update(&[(MODEL, Some("zz-nobody"))]), &[]).unwrap();
        assert_eq!(
            listen_model_in(&path).unwrap().as_deref(),
            Some("zz-nobody")
        );
    }

    /// A model hand-edited into something the argv must never carry falls back
    /// to the binary's default on the transcribe path, while the editor still
    /// sees the raw value — the same split the watcher clamp draws.
    #[test]
    fn a_hand_edited_model_that_is_not_a_name_is_ignored_but_still_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"listen": {"model": "--output /tmp/x"}}"#);
        assert_eq!(listen_model_in(&path).unwrap(), None);
        assert_eq!(
            listen_in(&path).unwrap().model.as_deref(),
            Some("--output /tmp/x")
        );
    }

    #[test]
    fn listen_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = listen_model_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
        assert!(listen_in(&path).is_err());
        let err = save_listen_in(
            &path,
            &model_update(&[(MODEL, Some("parakeet-tdt-0.6b-v2-int8"))]),
            &offered_models(),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn listen_engine_round_trips_and_refuses_an_unknown_word_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let view = listen_in(&path).unwrap();
        assert_eq!(view.engine, None);
        assert_eq!(view.engine_default, "server");

        save_listen_in(&path, &model_update(&[(ENGINE, Some("browser"))]), &[]).unwrap();
        assert_eq!(listen_in(&path).unwrap().engine.as_deref(), Some("browser"));

        let before = std::fs::read_to_string(&path).unwrap();
        for bad in ["auris", "Server", "none"] {
            let err =
                save_listen_in(&path, &model_update(&[(ENGINE, Some(bad))]), &[]).unwrap_err();
            assert!(
                matches!(&err, SaveError::Validation(m) if m.contains("engine")),
                "{bad}: {err:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        }

        save_listen_in(&path, &model_update(&[(ENGINE, None)]), &[]).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["listen"].get(ENGINE).is_none());
    }

    fn audio_update(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.map(str::to_string)))
            .collect()
    }

    #[test]
    fn audio_defaults_to_legacy_on_the_standard_port() {
        let _env = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // SAFETY: ENV_LOCK serializes every test touching the environment.
        unsafe {
            std::env::remove_var("NARU_AUDIO_URL");
            std::env::remove_var("MESA_AUDIO_URL");
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert_eq!(audio_engine_in(&path).unwrap(), AudioEngine::Legacy);
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:7870");
        let view = audio_in(&path).unwrap();
        assert_eq!(view.url, None);
        assert_eq!(view.url_default, "http://127.0.0.1:7870");
        assert_eq!(view.engine, None);
        assert_eq!(view.engine_default, "legacy");

        // A hand-edited unusable value falls back where it is used, and is
        // still shown verbatim to the editor.
        let path = write_config(
            dir.path(),
            r#"{"audio": {"engine": "auris", "url": "https://x"}}"#,
        );
        assert_eq!(audio_engine_in(&path).unwrap(), AudioEngine::Legacy);
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:7870");
        assert_eq!(audio_in(&path).unwrap().engine.as_deref(), Some("auris"));
    }

    #[test]
    fn audio_url_env_overrides_the_config() {
        let _env = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"audio": {"url": "http://127.0.0.1:9000"}}"#);
        // SAFETY: ENV_LOCK serializes every test touching the environment.
        unsafe {
            std::env::remove_var("NARU_AUDIO_URL");
            std::env::remove_var("MESA_AUDIO_URL");
        }
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:9000");
        unsafe { std::env::set_var("MESA_AUDIO_URL", "http://127.0.0.1:9001") };
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:9001");
        unsafe { std::env::set_var("NARU_AUDIO_URL", "http://127.0.0.1:9002") };
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:9002");
        // Empty is unset.
        unsafe {
            std::env::set_var("NARU_AUDIO_URL", "");
            std::env::remove_var("MESA_AUDIO_URL");
        }
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:9000");
        // An unusable env value falls through to the config, not past it.
        unsafe { std::env::set_var("NARU_AUDIO_URL", "https://127.0.0.1:9003") };
        assert_eq!(audio_url_in(&path).unwrap(), "http://127.0.0.1:9000");
        unsafe { std::env::remove_var("NARU_AUDIO_URL") };
    }

    #[test]
    fn a_bad_audio_url_env_value_falls_through_with_a_warning() {
        let good = "http://127.0.0.1:9000";
        assert_eq!(
            pick_audio_url(Some("http://localhost:9001"), Some(good)),
            ("http://localhost:9001".to_string(), None)
        );
        for bad in [
            "https://127.0.0.1:9001",
            "127.0.0.1:9001",
            "http://x/health",
        ] {
            let (url, warning) = pick_audio_url(Some(bad), Some(good));
            assert_eq!(url, good, "{bad}");
            let warning = warning.expect("a refused env value warns");
            assert!(warning.contains(bad) && warning.contains(good), "{warning}");
            // …and past a bad config value too, to the built-in.
            let (url, warning) = pick_audio_url(Some(bad), Some("https://nope"));
            assert_eq!(url, audio::DEFAULT_URL);
            assert!(warning.is_some());
        }
        // Empty is unset, not bad: no warning.
        assert_eq!(
            pick_audio_url(Some(" "), None),
            (audio::DEFAULT_URL.to_string(), None)
        );
        assert_eq!(pick_audio_url(None, Some(good)), (good.to_string(), None));
    }

    #[test]
    fn save_audio_round_trips_and_refuses_bad_values_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_audio_in(
            &path,
            &audio_update(&[
                (ENGINE, Some("naru-audio")),
                (URL, Some("http://localhost:7871/")),
            ]),
        )
        .unwrap();
        assert_eq!(audio_engine_in(&path).unwrap(), AudioEngine::NaruAudio);
        let view = audio_in(&path).unwrap();
        assert_eq!(view.engine.as_deref(), Some("naru-audio"));
        assert_eq!(view.url.as_deref(), Some("http://localhost:7871/"));

        let before = std::fs::read_to_string(&path).unwrap();
        for (key, bad) in [
            (ENGINE, "auris"),
            (ENGINE, "Legacy"),
            (URL, "https://127.0.0.1:7870"),
            (URL, "127.0.0.1:7870"),
            (URL, "http://"),
            (URL, "http://127.0.0.1:7870/health"),
            (URL, "http://a b"),
            ("voice", "x"),
        ] {
            let err = save_audio_in(&path, &audio_update(&[(key, Some(bad))])).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{key}={bad}");
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                before,
                "{key}={bad}"
            );
        }

        // null and blank both restore the built-in by removing the key.
        save_audio_in(&path, &audio_update(&[(ENGINE, None), (URL, Some(" "))])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["audio"].get(ENGINE).is_none());
        assert!(written["audio"].get(URL).is_none());
        assert_eq!(audio_engine_in(&path).unwrap(), AudioEngine::Legacy);

        // Nothing named writes nothing.
        let empty = dir.path().join("empty.json");
        save_audio_in(&empty, &HashMap::new()).unwrap();
        assert!(!empty.exists());
    }

    fn live_update(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<serde_json::Value>> {
        pairs
            .iter()
            .map(|(k, v)| {
                (
                    (*k).to_string(),
                    v.map(|text| serde_json::Value::String(text.to_string())),
                )
            })
            .collect()
    }

    fn live_json(
        key: &str,
        value: Option<serde_json::Value>,
    ) -> HashMap<String, Option<serde_json::Value>> {
        HashMap::from([(key.to_string(), value)])
    }

    /// The auto-send wait's whole contract (mesa task 886): nothing
    /// configured is the two seconds mesa shipped before the setting
    /// existed, a saved value is what the page reads back, and `null`
    /// removes the key rather than leaving a stale one behind. This section
    /// used to hold the live-agent prompt too, but that moved to the library
    /// as of mesa task 919 — see `a_leftover_live_prompt_key_is_silently_ignored`
    /// below for the migration case.
    #[test]
    fn live_auto_send_round_trips_and_resets_to_the_built_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert_eq!(live_in(&path).unwrap().auto_send_ms, None);
        assert_eq!(
            live_in(&path).unwrap().auto_send_ms_default,
            DEFAULT_LIVE_AUTO_SEND_MS
        );

        save_live_in(
            &path,
            &live_json(LIVE_AUTO_SEND_MS, Some(serde_json::json!(4500))),
        )
        .unwrap();
        assert_eq!(live_in(&path).unwrap().auto_send_ms, Some(4500));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["live"][LIVE_AUTO_SEND_MS], 4500);

        save_live_in(&path, &live_json(LIVE_AUTO_SEND_MS, None)).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["live"].get(LIVE_AUTO_SEND_MS).is_none());
        assert_eq!(live_in(&path).unwrap().auto_send_ms, None);
    }

    /// mesa task 919: `live.prompt` used to be this section's other key. A
    /// file still carrying one — hand-edited, or simply never migrated — must
    /// not error and must not surface anywhere; `LiveSection` has no field
    /// for it any more, so `#[serde(default)]` on the struct just drops it.
    #[test]
    fn a_leftover_live_prompt_key_is_silently_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"live": {"prompt": "old block", "auto-send-ms": 3500}}"#,
        );
        let live = live_in(&path).unwrap();
        assert_eq!(live.auto_send_ms, Some(3500));

        // And saving the section back leaves the stray key exactly as it
        // was — a save only ever touches the key it names.
        save_live_in(
            &path,
            &live_json(LIVE_AUTO_SEND_MS, Some(serde_json::json!(4000))),
        )
        .unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["live"]["prompt"], "old block");
        assert_eq!(written["live"][LIVE_AUTO_SEND_MS], 4000);
    }

    /// A value the editor would never write is refused, and the file is left
    /// byte-identical — the rule every other section's saver keeps. A value
    /// *hand-edited* into the file is a different case: it is reported
    /// verbatim, because the editor's job is to show what the file says; the
    /// page is what clamps it into something usable (`liveCapture.ts`).
    #[test]
    fn a_bad_auto_send_wait_is_refused_but_a_hand_edited_one_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"live": {"auto-send-ms": 3000}}"#;
        let path = write_config(dir.path(), before);
        for bad in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(2.5),
            serde_json::json!(MAX_LIVE_AUTO_SEND_MS as u64 + 1),
            serde_json::json!("2000"),
        ] {
            let err = save_live_in(&path, &live_json(LIVE_AUTO_SEND_MS, Some(bad.clone())))
                .expect_err(&format!("{bad} must be refused"));
            assert!(matches!(err, SaveError::Validation(_)), "{bad}: {err:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{bad}");
        }

        for hand_edited in [0, 999_999] {
            let path = write_config(
                dir.path(),
                &format!(r#"{{"live": {{"auto-send-ms": {hand_edited}}}}}"#),
            );
            assert_eq!(live_in(&path).unwrap().auto_send_ms, Some(hand_edited));
        }
    }

    /// A rejected save leaves the file byte-identical, and an unknown key in
    /// the section is named rather than silently written — including
    /// `prompt` itself now that it is no longer one of this section's keys
    /// (mesa task 919): a `PUT` naming it is a mistake to report, distinct
    /// from a `prompt` already sitting in the file, which is quietly ignored
    /// (`a_leftover_live_prompt_key_is_silently_ignored`).
    #[test]
    fn save_live_rejects_an_unknown_key() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"live": {"auto-send-ms": 3000}}"#;
        let path = write_config(dir.path(), before);

        for unknown in ["prompt", "voice"] {
            let err = save_live_in(&path, &live_update(&[(unknown, Some("x"))])).unwrap_err();
            assert!(
                matches!(&err, SaveError::Validation(m) if m.contains("unknown live setting")),
                "{unknown}: {err:?}"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{unknown}");
        }

        // Nothing named writes nothing — no empty `"live": {}` appears.
        let path = dir.path().join("untouched.json");
        save_live_in(&path, &HashMap::new()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn live_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = live_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
        let err = save_live_in(
            &path,
            &live_json(LIVE_AUTO_SEND_MS, Some(serde_json::json!(4000))),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn every_default_names_a_known_action() {
        for action in ACTIONS {
            assert!(default_command(action).is_some(), "{action}");
        }
        assert_eq!(default_command("task-execute"), None);
    }

    fn keys(
        pairs: &[(&str, Option<serde_json::Value>)],
    ) -> HashMap<String, Option<serde_json::Value>> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    /// The shipped chords are exactly what the app answered to before this
    /// section existed — the Rust half of the pair `frontend/src/keymap.ts`'s
    /// `defaults match today's behaviour` test pins on the other side. Edit
    /// one table and this fails until the other is edited too.
    #[test]
    fn the_shipped_keymap_is_todays_behaviour() {
        assert_eq!(
            keymap_default("command-palette"),
            Some(&["Mod+Shift+P"][..])
        );
        assert_eq!(keymap_default("focus-left"), Some(&["h", "ArrowLeft"][..]));
        assert_eq!(keymap_default("focus-down"), Some(&["j", "ArrowDown"][..]));
        assert_eq!(keymap_default("focus-up"), Some(&["k", "ArrowUp"][..]));
        assert_eq!(
            keymap_default("focus-right"),
            Some(&["l", "ArrowRight"][..])
        );
        assert_eq!(keymap_default("create-task"), Some(&["a"][..]));
        assert_eq!(keymap_default("live-listen"), Some(&["Mod+Shift+L"][..]));
        // The live conversation's discard-and-mute key (mesa task 1354).
        assert_eq!(keymap_default("live-cancel"), Some(&["Escape"][..]));
        assert_eq!(keymap_default("nope"), None);
        // What mesa ships must itself pass the rule it enforces on a save.
        let shipped: HashMap<String, Vec<String>> = KEYMAP_ACTIONS
            .iter()
            .map(|(a, c)| {
                (
                    (*a).to_string(),
                    c.iter().map(|s| (*s).to_string()).collect(),
                )
            })
            .collect();
        check_no_chord_collision(&shipped).unwrap();
        for chords in shipped.values() {
            for chord in chords {
                canonical_chord(chord).unwrap();
            }
        }
    }

    #[test]
    fn keymap_defaults_to_the_shipped_chords_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        // No file at all, and a file with no keymap section: every action
        // reports a null override beside the chords mesa ships.
        for path in [dir.path().join("nope.json"), write_config(dir.path(), "{}")] {
            let view = keymap_in(&path).unwrap();
            assert_eq!(view.actions.len(), KEYMAP_ACTIONS.len());
            assert!(view.actions.iter().all(|a| a.value.is_none()));
            let palette = &view.actions[0];
            assert_eq!(palette.action, "command-palette");
            assert_eq!(palette.default, vec!["Mod+Shift+P".to_string()]);
        }

        let path = write_config(dir.path(), r#"{"commands": {}}"#);
        save_keymap_in(
            &path,
            &keys(&[("create-task", Some(serde_json::json!(["n"])))]),
        )
        .unwrap();
        let view = keymap_in(&path).unwrap();
        let row = view
            .actions
            .iter()
            .find(|a| a.action == "create-task")
            .unwrap();
        assert_eq!(row.value, Some(vec!["n".to_string()]));
        assert_eq!(row.default, vec!["a".to_string()]);
        // Only the override is stored — the other seven actions stay absent.
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["keymap"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn removing_a_keymap_override_restores_the_shipped_chords() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"keymap": {"create-task": ["n"]}}"#);
        save_keymap_in(&path, &keys(&[("create-task", None)])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored as the default: absence is how a default is said.
        assert!(written["keymap"].get("create-task").is_none());
        let view = keymap_in(&path).unwrap();
        assert!(view.actions.iter().all(|a| a.value.is_none()));
    }

    /// Chords are stored canonicalized, so the file never holds two spellings
    /// of one binding — `Shift+Mod+a` and `Mod+Shift+A` are the same chord.
    #[test]
    fn a_chord_is_stored_in_one_canonical_spelling() {
        assert_eq!(canonical_chord("Shift+Mod+A").unwrap(), "Mod+Shift+a");
        assert_eq!(canonical_chord("mod+shift+p").unwrap(), "Mod+Shift+p");
        assert_eq!(canonical_chord(" ArrowLeft ").unwrap(), "ArrowLeft");
        assert_eq!(canonical_chord("H").unwrap(), "h");

        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "{}");
        save_keymap_in(
            &path,
            &keys(&[("create-task", Some(serde_json::json!(["Shift+Mod+N"])))]),
        )
        .unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["keymap"]["create-task"][0], "Mod+Shift+n");
    }

    #[test]
    fn save_keymap_rejects_a_bad_binding_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"keymap": {"create-task": ["n"]}}"#;
        let path = write_config(dir.path(), before);
        for (label, value) in [
            ("not a list", serde_json::json!("n")),
            ("an empty list", serde_json::json!([])),
            (
                "too many chords",
                serde_json::json!(["q", "w", "e", "r", "t"]),
            ),
            ("a non-string chord", serde_json::json!([7])),
            ("an empty chord", serde_json::json!([""])),
            ("a chord with no key", serde_json::json!(["Mod+"])),
            ("an unknown modifier", serde_json::json!(["Hyper+k"])),
            ("a repeated modifier", serde_json::json!(["Mod+Mod+k"])),
            ("a bare modifier", serde_json::json!(["Shift"])),
            ("a chord with whitespace", serde_json::json!(["Mod+ k"])),
            (
                "an over-long chord",
                serde_json::json!([format!("Mod+{}", "x".repeat(MAX_CHORD_LEN))]),
            ),
        ] {
            let err = save_keymap_in(&path, &keys(&[("create-task", Some(value))])).unwrap_err();
            assert!(matches!(err, SaveError::Validation(_)), "{label}: {err:?}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{label}");
        }
        // An action mesa doesn't bind is a named validation error, not a
        // silently stored row.
        let err = save_keymap_in(
            &path,
            &keys(&[("fly-me-to-the-moon", Some(serde_json::json!(["m"])))]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m)
                if m.contains("unknown keyboard action") && m.contains("fly-me-to-the-moon")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    /// The rule no other section has: a keymap is a partition of the keyboard,
    /// so an override is judged against the whole map it would leave behind —
    /// including the actions the user never touched.
    #[test]
    fn save_keymap_refuses_a_chord_two_actions_would_share() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"keymap": {"create-task": ["n"]}}"#;
        let path = write_config(dir.path(), before);

        // Against a built-in nobody overrode: `h` is still the spatial nav's.
        let err = save_keymap_in(
            &path,
            &keys(&[("create-task", Some(serde_json::json!(["h"])))]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m)
                if m.contains("focus-left") && m.contains("create-task")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // Against an override already on disk, and through a different
        // spelling of the same chord.
        let err = save_keymap_in(
            &path,
            &keys(&[("focus-up", Some(serde_json::json!(["N"])))]),
        )
        .unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // Two clashing actions in one batch, neither of them on disk.
        let err = save_keymap_in(
            &path,
            &keys(&[
                ("focus-up", Some(serde_json::json!(["z"]))),
                ("focus-down", Some(serde_json::json!(["z"]))),
            ]),
        )
        .unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // And the clash a *removal* would create: putting `create-task` back
        // to `a` is fine, but only because nothing else holds `a`.
        save_keymap_in(
            &path,
            &keys(&[("focus-up", Some(serde_json::json!(["a"])))]),
        )
        .unwrap();
        let err = save_keymap_in(&path, &keys(&[("create-task", None)])).unwrap_err();
        assert!(matches!(err, SaveError::Validation(_)), "{err:?}");
    }

    /// The read path is forgiving where the write path is strict (the
    /// `todo-concurrency` clamp posture): one hand-edited entry mesa cannot use
    /// costs that action its override and nothing else.
    #[test]
    fn a_hand_edited_keymap_entry_falls_back_to_its_own_default_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"keymap": {
                 "create-task": "n",
                 "focus-up": [],
                 "invent-a-shortcut": ["q"],
                 "focus-left": ["Mod+Shift+H"]
               }}"#,
        );
        let view = keymap_in(&path).unwrap();
        let value = |action: &str| {
            view.actions
                .iter()
                .find(|a| a.action == action)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(value("create-task"), None, "a non-list is dropped");
        assert_eq!(value("focus-up"), None, "an empty list is dropped");
        assert_eq!(value("focus-left"), Some(vec!["Mod+Shift+h".to_string()]));
        assert!(
            !view.actions.iter().any(|a| a.action == "invent-a-shortcut"),
            "an action mesa doesn't bind never reaches the page"
        );
    }

    #[test]
    fn keymap_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        assert!(keymap_in(&path).is_err());
        let err = save_keymap_in(
            &path,
            &keys(&[("create-task", Some(serde_json::json!(["n"])))]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    // ------------------------------------------------------------------
    // Library prompts as placeholders — `{prompt:<name>}` (mesa task 1138)
    // ------------------------------------------------------------------

    /// A prompt table from `(name, body)` pairs, standing in for the library
    /// view `core::library::prompts` builds (tested there, against a store).
    fn prompts(pairs: &[(&str, &str)]) -> Prompts {
        Prompts::new(
            pairs
                .iter()
                .map(|(n, b)| ((*n).to_string(), (*b).to_string())),
        )
    }

    #[test]
    fn a_hostile_prompt_body_never_runs_as_shell() {
        // The test that matters most: a library body is free text somebody
        // else wrote, and it is exactly the shape the quoting has to survive.
        // Every position, through a real bash, the body coming straight back.
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("out");
        let pwned = dir.path().join("pwned");
        let bodies = [
            format!("\"; touch {}; \"", pwned.display()),
            format!("'; touch {}; '", pwned.display()),
            format!("$(touch {})", pwned.display()),
            format!("`touch {}`", pwned.display()),
            format!("x\nEOF\ntouch {}\ncat <<EOF\n", pwned.display()),
            "$((1+1)) ${HOME} $HOME".to_string(),
            "a literal \\n escape".to_string(),
            "line one\nline two\nline three".to_string(),
            "back\\slash \"and\" 'quotes' * ? [a-z]".to_string(),
        ];
        for body in &bodies {
            let table = prompts(&[("brief", body)]);
            let vars = Vars {
                prompts: Some(&table),
                ..Default::default()
            };
            for template in [
                "true\nprintf '%s' {prompt:brief} > LOG",
                "true\nprintf '%s' \"{prompt:brief}\" > LOG",
                "true\ncat > LOG <<EOF\n{prompt:brief}\nEOF",
            ] {
                let template = template.replace("LOG", &log.display().to_string());
                let got = run_resolved(&template, &vars, &log);
                let expected = if template.contains("<<EOF") {
                    format!("{}\n", body.trim_end_matches('\n'))
                } else {
                    body.clone()
                };
                assert_eq!(got, expected, "{template} with {body:?}");
                assert!(!pwned.exists(), "the injected command ran: {body:?}");
            }
        }
    }

    #[test]
    fn a_prompt_name_matches_case_insensitively() {
        // `Store::find_project_by_name`'s rule, for the same reason: an agent
        // types a name, and case is not what it meant to say.
        let table = prompts(&[("Nightly-Brief", "read the board")]);
        let vars = Vars {
            prompts: Some(&table),
            ..Default::default()
        };
        for written in ["Nightly-Brief", "nightly-brief", "NIGHTLY-BRIEF"] {
            assert_eq!(
                resolve(
                    AGENT_SPAWN,
                    &format!("claude -- {{prompt:{written}}}"),
                    &vars
                )
                .unwrap(),
                "claude -- 'read the board'",
                "{written}"
            );
        }
        // A name may hold a `.` — it is a library name, and nothing else has
        // to be able to hold it any more.
        let table = prompts(&[("my.brief", "text")]);
        let vars = Vars {
            prompts: Some(&table),
            ..Default::default()
        };
        assert_eq!(
            resolve(AGENT_SPAWN, "claude -- {prompt:my.brief}", &vars).unwrap(),
            "claude -- 'text'"
        );
    }

    #[test]
    fn an_empty_prompt_body_resolves_to_the_empty_string_rather_than_failing() {
        // An empty body is a legal library row, so it is a legal placeholder:
        // one empty argument.
        let table = prompts(&[("blank", "")]);
        let vars = Vars {
            prompts: Some(&table),
            ..Default::default()
        };
        assert_eq!(
            resolve(AGENT_SPAWN, "claude -- {prompt:blank}", &vars).unwrap(),
            "claude -- ''"
        );
    }

    #[test]
    fn an_unknown_prompt_is_refused_at_save_time_and_at_spawn_time() {
        // Save time is where this belongs — library names are known then, and
        // the editor is where the author can fix it…
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let table = prompts(&[("nightly", "read the board")]);
        let err = save_commands_in(
            &path,
            &update(&[(TODO_WATCHER, "mytool -- {prompt:missing}")]),
            &table,
        )
        .unwrap_err();
        let SaveError::Validation(message) = &err else {
            panic!("{err:?}");
        };
        assert!(message.contains("{prompt:missing}"), "{message}");
        assert!(message.contains("{prompt:nightly}"), "{message}");
        assert!(!path.exists(), "a refused save wrote the file");

        // …but a row deleted since the save must be a hard error on the spawn
        // path too, never a silently empty prompt.
        let vars = Vars {
            prompts: Some(&prompts(&[])),
            ..Default::default()
        };
        let err = resolve(TODO_WATCHER, "claude -- {prompt:nightly}", &vars).unwrap_err();
        assert!(err.contains("{prompt:nightly}"), "{err}");
        assert!(err.contains("no prompts"), "{err}");
    }

    #[test]
    fn a_prompt_body_expands_its_own_placeholders_exactly_once() {
        // One pass, no recursion: an offered built-in with a value on this call
        // is replaced; a nested `{prompt:…}`, a placeholder this action does
        // not offer and an unknown brace are all left literal — a library body
        // is data somebody wrote, not a template the config author reviewed, so
        // it must never break a hook. The result is then quoted as one value.
        let table = prompts(&[
            (
                "brief",
                "task {id} ({name}) — {prompt:other} {prompt} {nope}",
            ),
            ("other", "NEVER"),
        ]);
        let vars = Vars {
            id: Some(7),
            name: Some("A: do it"),
            prompt: Some("ignored"),
            prompts: Some(&table),
        };
        // todo-watcher offers {id}/{name} but not {prompt}.
        assert_eq!(
            resolve(TODO_WATCHER, "claude -- {prompt:brief}", &vars).unwrap(),
            "claude -- 'task 7 (A: do it) — {prompt:other} {prompt} {nope}'"
        );
    }

    #[test]
    fn a_library_prompt_is_offered_by_every_action() {
        // The sibling of `placeholders_are_scoped_to_the_action`: the built-in
        // vocabulary is per-call data and therefore scoped, while a library
        // prompt is static text every spawn may quote — so it is a second,
        // orthogonal form rather than another entry in the per-action subsets,
        // and it is *not* advertised in `offered_placeholders`.
        let table = prompts(&[("brief", "read the board")]);
        let vars = Vars {
            id: Some(1),
            name: Some("n"),
            prompt: Some("p"),
            prompts: Some(&table),
        };
        for action in ACTIONS {
            assert_eq!(
                resolve(action, "claude -- {prompt:brief}", &vars).unwrap(),
                "claude -- 'read the board'",
                "{action}"
            );
            assert!(
                !offered_placeholders(action).contains(&"{prompt:brief}"),
                "{action} advertises a library name"
            );
        }
        // And a colon-free `{prompt}` keeps its own per-action scoping.
        let err = resolve(TODO_WATCHER, "claude {prompt}", &vars).unwrap_err();
        assert!(err.contains("{prompt}"), "{err}");
    }

    #[test]
    fn a_prompt_placeholder_obeys_every_shell_refusal_the_builtins_do() {
        // Not special-cased: the contexts a value cannot go into refuse a
        // `{prompt:…}` exactly as they refuse a `{name}`.
        let table = prompts(&[("brief", "text")]);
        let vars = Vars {
            prompts: Some(&table),
            ..Default::default()
        };
        for (template, fragment) in [
            ("true\necho '{prompt:brief}'", "single quotes"),
            ("true\necho $'{prompt:brief}'", "ANSI-C"),
            (
                "true\ncat <<'EOF'\n{prompt:brief}\nEOF",
                "delimiter is quoted",
            ),
            ("true\necho `{prompt:brief}`", "command substitution"),
            ("true\necho $(( {prompt:brief} ))", "arithmetic"),
            (
                "true\ncat <<{prompt:brief}\nx\n{prompt:brief}",
                "delimiter word",
            ),
        ] {
            let err = resolve(TODO_WATCHER, template, &vars).unwrap_err();
            assert!(err.contains(fragment), "{template}: {err}");
            assert!(err.contains("{prompt:brief}"), "{template}: {err}");
        }
    }

    #[test]
    fn text_that_only_looks_like_a_prompt_placeholder_stays_literal() {
        // The lexer's existing rule, extended: anything that is not a name the
        // library could hold is not a placeholder at all, so ordinary prose in
        // a script body is still ordinary prose.
        let vars = Vars {
            prompts: Some(&prompts(&[])),
            ..Default::default()
        };
        let script = resolved("true\necho '{prompt: see below}' ${prompt:-x}", &vars);
        assert!(script.contains("{prompt: see below}"), "{script}");
        assert!(script.contains("${prompt:-x}"), "{script}");
    }
}
