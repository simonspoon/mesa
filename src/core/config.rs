//! User config: the command lines mesa uses when it starts a coding agent,
//! and the per-model price table the CC Dashboard estimates cost from.
//!
//! mesa spawns an agent from exactly four places — the todo-watcher's
//! dispatch, the inbox-watcher's triage, the Agents surface's "add agent"
//! button, and the live conversation's agent. Each used to be a hardcoded
//! `claude --bg …` argv, so swapping the binary, the persona, or the slash
//! command meant a rebuild. Each is now a **command template** in
//! `~/.mesa/config.json`:
//!
//! ```json
//! {
//!   "commands": {
//!     "todo-watcher":   "claude --bg --agent swe --name {name} -- \"/execute-mesa-task {id}\"",
//!     "inbox-watcher":  "claude --bg --agent swe --name {name} -- \"/inbox-triage {id}\"",
//!     "agent-spawn":    "claude --bg --agent swe -- {prompt}",
//!     "live-agent":     "claude --bg --agent swe --name {name} -- {prompt}"
//!   }
//! }
//! ```
//!
//! A single-line template is **argv, not a shell command** — tokenized here
//! and handed to `Command` directly, with no `sh -c` anywhere. That is
//! load-bearing, not stylistic: the watchers pass a task name / inbox body
//! (untrusted free text) as the session `--name`, and what makes that safe is
//! that it reaches the agent as one `Command::arg`. Placeholders are
//! substituted *after* tokenization, so a value can never split into extra
//! argv entries or be reinterpreted as flags — see [`expand`].
//!
//! ## Script mode
//!
//! A value whose trimmed text contains a **newline** is instead a bash script,
//! run as `bash -c <script>` ([`is_script`], [`resolve`]). That buys a `cd`, an
//! `export`, a conditional binary — the things a single program call can't do.
//!
//! The safety property survives intact, by a different mechanism: a script's
//! values arrive as **environment variables** (`MESA_ID`, `MESA_NAME`, …) set
//! on the child, never as text spliced into the script body, which reaches
//! `bash` verbatim. So untrusted free text is still never parsed by a shell.
//! `{}` syntax would be both meaningless and confusable with `${VAR}` there, so
//! a `{placeholder}` inside a script is a save-time error naming the variable
//! to use instead.
//!
//! Unlike `hooks.json` (a genuine `sh -c` string, [`crate::core::hooks`]) no
//! value mesa holds is ever interpolated into a string a shell parses.
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
//! Today that is one key — how many agents `serve --watch-todo` may have
//! running **per project** ([`todo_concurrency`]), default
//! [`DEFAULT_TODO_CONCURRENCY`]. Read per tick rather than at startup, so an
//! edit lands on the next tick with no restart. See `docs/todo-watcher.md`.
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
//! A fifth section holds the instruction block a live conversation's agent is
//! spawned with (mesa task 867):
//!
//! ```json
//! { "live": { "prompt": "You are the voice of mesa …" } }
//! ```
//!
//! One key, [`LIVE_PROMPT`], read on every `mesa live start`. Absent or blank
//! is the block mesa ships ([`crate::core::live::AGENT_PROMPT`]), so an
//! unconfigured install spawns exactly the agent it spawned before this
//! setting existed; a configured value **replaces** it — what the Settings box
//! holds is the whole of what mesa sends. See [`live_prompt`] and
//! `docs/live.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::core::speech;
use crate::core::types::{
    ConfigCommand, ConfigLive, ConfigPrice, ConfigSpeech, ConfigWatchers, ModelRates,
};

/// The todo-watcher's dispatch command (`docs/todo-watcher.md`).
pub const TODO_WATCHER: &str = "todo-watcher";
/// The inbox-watcher's triage command (`docs/inbox-watcher.md`).
pub const INBOX_WATCHER: &str = "inbox-watcher";
/// The Agents surface's "add agent" command (`docs/agents.md`).
pub const AGENT_SPAWN: &str = "agent-spawn";
/// The live conversation's agent (`docs/live.md`).
pub const LIVE_AGENT: &str = "live-agent";

/// Every configurable command, in the order the docs and the Settings page
/// list them. The single source of truth for "which keys mesa configures" —
/// [`default_command`] answers the same question one key at a time.
pub const ACTIONS: [&str; 4] = [TODO_WATCHER, INBOX_WATCHER, AGENT_SPAWN, LIVE_AGENT];

/// Built-in default for [`TODO_WATCHER`] — the argv mesa shipped before the
/// config file existed, spelled as a template. `{bin}`/`{agent}` carry the
/// pre-existing `MESA_CLAUDE_BIN`/`MESA_CLAUDE_AGENT` env seams, so with no
/// config file the resulting argv is byte-identical to the hardcoded one.
///
/// Note the quotes around the prompt: a slash command and its argument are
/// **one** argv entry (`claude` takes the prompt as a single positional), and
/// tokenization is by whitespace. Unquoted, `/execute-mesa-task {id}` would
/// arrive as two arguments and the id would be lost.
pub const DEFAULT_TODO_WATCHER: &str =
    r#"{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}""#;
/// Built-in default for [`INBOX_WATCHER`]; see [`DEFAULT_TODO_WATCHER`].
pub const DEFAULT_INBOX_WATCHER: &str =
    r#"{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}""#;
/// Built-in default for [`AGENT_SPAWN`]. No `{id}`/`{name}`: this spawn is
/// driven by a request body, not a mesa record, and the prompt is optional —
/// absent, the `-- {prompt}` pair drops out and the session starts idle.
pub const DEFAULT_AGENT_SPAWN: &str = "{bin} --bg --agent {agent} -- {prompt}";
/// Built-in default for [`LIVE_AGENT`]. The union of the two shapes above: a
/// live session is a mesa record (so it has an `{id}` and a `{name}`) *and*
/// carries a prompt mesa supplies — `core::live::agent_prompt`, the loop the
/// conversation runs — so the feature works with no user configuration.
pub const DEFAULT_LIVE_AGENT: &str = "{bin} --bg --agent {agent} --name {name} -- {prompt}";

/// The built-in template for `action`, or `None` if `action` isn't one of
/// [`ACTIONS`]. Public so the docs check and the API can report the shipped
/// default.
pub fn default_command(action: &str) -> Option<&'static str> {
    match action {
        TODO_WATCHER => Some(DEFAULT_TODO_WATCHER),
        INBOX_WATCHER => Some(DEFAULT_INBOX_WATCHER),
        AGENT_SPAWN => Some(DEFAULT_AGENT_SPAWN),
        LIVE_AGENT => Some(DEFAULT_LIVE_AGENT),
        _ => None,
    }
}

/// `MESA_CONFIG_FILE` if set (the test seam, mirroring `MESA_HOOKS_FILE`),
/// else `~/.mesa/config.json`. `~/.mesa` may also be the JSON file itself —
/// accepted because "a config in ~/.mesa" reads both ways, and a user who
/// wrote one file shouldn't get silent no-ops.
pub fn config_file() -> PathBuf {
    if let Ok(p) = std::env::var("MESA_CONFIG_FILE") {
        return PathBuf::from(p);
    }
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    let dot = home.join(".mesa");
    if dot.is_file() {
        return dot;
    }
    dot.join("config.json")
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
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
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
                env_vars: offered_env_vars(action)
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
pub fn save_commands(updates: &HashMap<String, String>) -> Result<(), SaveError> {
    save_commands_in(&config_file(), updates)
}

fn save_commands_in(path: &Path, updates: &HashMap<String, String>) -> Result<(), SaveError> {
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
            validate(action, template).map_err(SaveError::Validation)?;
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

/// Rejects a template the spawn path would fail on later — an unterminated
/// quote, a placeholder this action doesn't offer, or one that expands to an
/// empty argv; in script mode, a `{placeholder}` (which a script never gets)
/// or a bash syntax error. Every value is supplied, so only template-shaped
/// mistakes are caught here; the per-call drop rule stays [`expand`]'s
/// business.
///
/// The point is *when* the failure lands: at save time, in the editor, rather
/// than at the next dispatch, in a watcher log the user isn't reading.
pub fn validate(action: &str, template: &str) -> Result<(), String> {
    if is_script(template) {
        let script = template.trim();
        check_script(action, script)?;
        return bash_syntax_check(action, script);
    }
    let vars = Vars {
        bin: Some("claude"),
        agent: Some("swe"),
        id: Some(1),
        name: Some("name"),
        prompt: Some("prompt"),
    };
    expand(action, template, &vars).map(|_| ())
}

/// True when this value is a **script** rather than an argv template: its
/// trimmed text spans more than one line.
///
/// Mode is chosen by the value, not by a second config key — a JSON string
/// already carries `\n` and the Settings box is already a `<textarea>`, so
/// there is nothing to migrate and every existing (single-line) template keeps
/// its exact behavior. Trimming first is deliberate: surrounding blank lines
/// are whitespace, and whitespace alone must not silently switch modes.
pub fn is_script(template: &str) -> bool {
    template.trim().contains('\n')
}

/// How a resolved command will actually be run — the two modes, decided by
/// [`is_script`] and produced by [`resolve`].
#[derive(Debug, Clone, PartialEq)]
pub enum Spawn {
    /// A tokenized argv, run directly with no shell (the original mode).
    Argv(Vec<String>),
    /// A bash script, run as `bash -c <script>` with `env` set on the child.
    /// The script text is passed through verbatim — nothing is substituted
    /// into it, which is what keeps untrusted values out of shell parsing.
    Script {
        script: String,
        env: Vec<(String, String)>,
    },
}

/// Resolves one action's configured (or default) `template` into the thing to
/// run. The mode split lives here so both surfaces — the spawn path and the
/// Settings preview — can never disagree about which one applies.
pub fn resolve(action: &str, template: &str, vars: &Vars) -> Result<Spawn, String> {
    if is_script(template) {
        let script = template.trim();
        check_script(action, script)?;
        return Ok(Spawn::Script {
            script: script.to_string(),
            env: script_env(action, vars),
        });
    }
    Ok(Spawn::Argv(expand(action, template, vars)?))
}

/// Every placeholder name, paired with the environment variable a script reads
/// instead. The one mapping, shared by the env handoff, the save-time error and
/// the vocabulary the Settings page advertises.
const PLACEHOLDER_ENV: [(&str, &str); 5] = [
    ("bin", "MESA_BIN"),
    ("agent", "MESA_AGENT"),
    ("id", "MESA_ID"),
    ("name", "MESA_NAME"),
    ("prompt", "MESA_PROMPT"),
];

/// The environment variable names `action` offers a script, in the same order
/// [`offered_placeholders`] lists their `{}` twins. Public so the Settings page
/// can only ever advertise variables the handoff actually sets.
pub fn offered_env_vars(action: &str) -> &'static [&'static str] {
    match action {
        AGENT_SPAWN => &["MESA_BIN", "MESA_AGENT", "MESA_PROMPT"],
        LIVE_AGENT => &[
            "MESA_BIN",
            "MESA_AGENT",
            "MESA_ID",
            "MESA_NAME",
            "MESA_PROMPT",
        ],
        _ => &["MESA_BIN", "MESA_AGENT", "MESA_ID", "MESA_NAME"],
    }
}

/// Every variable script mode ever sets, offered or not — the list
/// [`crate::core::agents`] explicitly *removes* from the child before setting
/// the ones that apply, so "not offered" and "no value on this call" are both
/// genuinely **unset** rather than inherited from mesa's own environment.
pub const ALL_ENV_VARS: [&str; 5] = [
    "MESA_BIN",
    "MESA_AGENT",
    "MESA_ID",
    "MESA_NAME",
    "MESA_PROMPT",
];

/// The variables to set for one script call: the action's own vocabulary,
/// minus any value that is absent on this call.
///
/// That omission is the script-mode analogue of [`expand`]'s drop rule — an
/// absent value leaves its variable **unset**, never set to `""`, so `set -u`
/// fires and `${MESA_PROMPT:-}` reads as "no prompt" rather than "empty
/// prompt".
pub fn script_env(action: &str, vars: &Vars) -> Vec<(String, String)> {
    PLACEHOLDER_ENV
        .iter()
        .filter_map(|(key, var)| {
            let value = vars.lookup(key, action).ok()??;
            Some(((*var).to_string(), value))
        })
        .collect()
}

/// Rejects a script the spawn path would refuse later: an empty body, or a
/// `{placeholder}` that script mode does not substitute. Runs on **both** the
/// save path and the spawn path, so a config file edited by hand fails the same
/// way the editor would have failed it.
fn check_script(action: &str, script: &str) -> Result<(), String> {
    if script.is_empty() {
        return Err(format!("the {action} command is empty"));
    }
    if let Some(key) = find_placeholder(script) {
        let var = PLACEHOLDER_ENV
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| *v)
            .unwrap_or_default();
        if !offered_env_vars(action).contains(&var) {
            return Err(format!(
                "unsupported placeholder {{{key}}} in the {action} command; \
                 {action} offers {}",
                offered_list(action)
            ));
        }
        return Err(format!(
            "the {action} command is a multi-line script, so {{{key}}} is not \
             substituted; use the ${var} environment variable instead"
        ));
    }
    Ok(())
}

/// The first `{placeholder}` in a script, if any. Only the five known names
/// count, and only when the `{` is not preceded by `$` — so a script's own
/// `${MESA_NAME}`, `{a,b}` brace expansion and `{ …; }` grouping are left
/// alone, and the error only ever fires on the mistake it exists to name.
fn find_placeholder(script: &str) -> Option<&str> {
    let bytes = script.as_bytes();
    for (open, _) in script.match_indices('{') {
        if open > 0 && bytes[open - 1] == b'$' {
            continue;
        }
        let rest = &script[open + 1..];
        let close = match rest.find('}') {
            Some(c) => c,
            None => continue,
        };
        let key = &rest[..close];
        if PLACEHOLDER_ENV.iter().any(|(k, _)| *k == key) {
            return Some(key);
        }
    }
    None
}

/// Parses the script with `bash -n` — a syntax check that executes nothing —
/// so an unbalanced `fi` lands in the editor rather than in a watcher log.
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
/// "not available for this call" — see [`expand`]'s drop rule. `bin`/`agent`
/// are filled from the env seams by `agents::argv_for`, not by callers.
#[derive(Debug, Default, Clone)]
pub struct Vars<'a> {
    pub bin: Option<&'a str>,
    pub agent: Option<&'a str>,
    pub id: Option<i64>,
    pub name: Option<&'a str>,
    pub prompt: Option<&'a str>,
}

impl Vars<'_> {
    /// `Some(value)` if this placeholder is available, `None` if it is a
    /// recognized placeholder with no value on this call. `Err` for a name
    /// this action doesn't offer at all.
    fn lookup(&self, key: &str, action: &str) -> Result<Option<String>, String> {
        let (offered, value) = match key {
            "bin" => (true, self.bin.map(str::to_string)),
            "agent" => (true, self.agent.map(str::to_string)),
            "id" => (action != AGENT_SPAWN, self.id.map(|i| i.to_string())),
            "name" => (action != AGENT_SPAWN, self.name.map(str::to_string)),
            "prompt" => (
                action == AGENT_SPAWN || action == LIVE_AGENT,
                self.prompt.map(str::to_string),
            ),
            _ => (false, None),
        };
        if !offered {
            return Err(format!(
                "unsupported placeholder {{{key}}} in the {action} command; \
                 {action} offers {}",
                offered_list(action)
            ));
        }
        Ok(value)
    }
}

/// The placeholder names `action` offers, `{}`-delimited and in doc order.
/// Shared by the "unsupported placeholder" error below and by [`settings`],
/// so the Settings page can only ever advertise placeholders [`Vars::lookup`]
/// actually accepts.
pub fn offered_placeholders(action: &str) -> &'static [&'static str] {
    match action {
        AGENT_SPAWN => &["{bin}", "{agent}", "{prompt}"],
        // The union: a live session is a mesa record *and* carries a prompt.
        LIVE_AGENT => &["{bin}", "{agent}", "{id}", "{name}", "{prompt}"],
        _ => &["{bin}", "{agent}", "{id}", "{name}"],
    }
}

fn offered_list(action: &str) -> String {
    offered_placeholders(action).join(", ")
}

/// Expands `template` into an argv for `action`.
///
/// Two passes, in this order — the order is the safety property:
/// 1. [`tokenize`] splits the template on whitespace, honoring quotes, so the
///    token count is fixed by the *template* alone.
/// 2. Each token's `{placeholder}`s are replaced in place. A substituted value
///    is never re-split or re-quoted, so untrusted text (a task name, an
///    inbox body) lands as exactly one argv entry.
///
/// A token holding a placeholder that has no value is **dropped**, along with
/// an immediately preceding token that starts with `-`. That one rule is what
/// makes the defaults reproduce today's behavior: with no `--name` available
/// `--name {name}` disappears as a pair (rather than leaving a dangling flag
/// that would swallow the next argument), and with no prompt `-- {prompt}`
/// goes too.
pub fn expand(action: &str, template: &str, vars: &Vars) -> Result<Vec<String>, String> {
    let tokens = tokenize(template)
        .map_err(|e| format!("cannot parse the {action} command {template:?}: {e}"))?;
    let mut argv: Vec<String> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        match substitute(action, token, vars)? {
            Some(arg) => argv.push(arg),
            None => {
                if argv.last().is_some_and(|prev| prev.starts_with('-')) {
                    argv.pop();
                }
            }
        }
    }
    if argv.is_empty() {
        return Err(format!(
            "the {action} command {template:?} expands to nothing"
        ));
    }
    Ok(argv)
}

/// `Ok(None)` = this token must be dropped (an available-but-unset
/// placeholder). A `{` that opens no valid placeholder is a literal brace.
fn substitute(action: &str, token: &str, vars: &Vars) -> Result<Option<String>, String> {
    let mut out = String::with_capacity(token.len());
    let mut rest = token;
    while let Some(open) = rest.find('{') {
        let (before, from_brace) = rest.split_at(open);
        out.push_str(before);
        let Some(close) = from_brace.find('}') else {
            out.push_str(from_brace);
            return Ok(Some(out));
        };
        let key = &from_brace[1..close];
        match vars.lookup(key, action)? {
            Some(value) => out.push_str(&value),
            None => return Ok(None),
        }
        rest = &from_brace[close + 1..];
    }
    out.push_str(rest);
    Ok(Some(out))
}

/// Splits a command template into tokens: whitespace-separated, with `'…'`
/// (literal) and `"…"` (backslash-escapable) quoting, so a template can carry
/// an argument containing spaces. Quotes are removed; an empty quoted string
/// is a real, empty token. `Err` on an unterminated quote or a trailing
/// backslash — a typo the user should see, not a silently mangled argv.
///
/// Not `shell_words`-complete on purpose: no expansion, no substitution, no
/// operators. `|`, `>`, `&&`, `$VAR` are ordinary characters here, because
/// nothing downstream is a shell.
pub fn tokenize(s: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => return Err("unterminated single quote".to_string()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(esc) => cur.push(esc),
                            None => return Err("trailing backslash".to_string()),
                        },
                        Some(c) => cur.push(c),
                        None => return Err("unterminated double quote".to_string()),
                    }
                }
            }
            '\\' => {
                started = true;
                match chars.next() {
                    Some(esc) => cur.push(esc),
                    None => return Err("trailing backslash".to_string()),
                }
            }
            c => {
                started = true;
                cur.push(c);
            }
        }
    }
    if started {
        tokens.push(cur);
    }
    Ok(tokens)
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

/// Every key the `watchers` section understands, for the unknown-key error.
const WATCHER_KEYS: &[&str] = &[TODO_CONCURRENCY];

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

/// The watcher settings for the Settings page (`GET /api/config/watchers`):
/// the configured value (verbatim, or `null` when the file says nothing) plus
/// the built-in default behind it — the `{value, default}` idiom
/// [`ConfigPrice`] and [`ConfigCommand`] already use.
pub fn watchers() -> Result<ConfigWatchers, String> {
    watchers_in(&config_file())
}

fn watchers_in(path: &Path) -> Result<ConfigWatchers, String> {
    Ok(ConfigWatchers {
        todo_concurrency: read_watchers(path)?.todo_concurrency,
        todo_concurrency_default: DEFAULT_TODO_CONCURRENCY,
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
            validate_limit(key, value).map_err(SaveError::Validation)?;
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

/// A watcher limit has to be a whole number of agents inside the sanity
/// bound: `0` (which would stop the watcher rather than configure it), a
/// negative, a fraction and anything over [`MAX_TODO_CONCURRENCY`] are all
/// named rather than silently coerced.
fn validate_limit(key: &str, value: &serde_json::Value) -> Result<(), String> {
    let Some(n) = value.as_u64() else {
        return Err(format!(
            "{key} must be a whole number between 1 and {MAX_TODO_CONCURRENCY}, got {value}"
        ));
    };
    if n < 1 || n > u64::from(MAX_TODO_CONCURRENCY) {
        return Err(format!(
            "{key} must be between 1 and {MAX_TODO_CONCURRENCY}, got {n}"
        ));
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
        voices: speech::voices().to_vec(),
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
    save_speech_in(&config_file(), updates, speech::voices())
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
// Live (mesa task 867)
// ---------------------------------------------------------------------------

/// The config key holding the instruction block a live agent is spawned with.
pub const LIVE_PROMPT: &str = "prompt";

/// The config key holding how long a settled dictation draft waits before the
/// page sends it (mesa task 886).
pub const LIVE_AUTO_SEND_MS: &str = "auto-send-ms";

/// Every key the `live` section understands, for the unknown-key error.
const LIVE_KEYS: &[&str] = &[LIVE_PROMPT, LIVE_AUTO_SEND_MS];

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

/// How long a configured prompt may be. Generous — the built-in is a few
/// kilobytes and a person elaborating on it should not hit a wall — but
/// bounded, because the text becomes one `Command::arg` on every spawn.
pub const MAX_LIVE_PROMPT: usize = 16 * 1024;

/// The `live` map, deserialized on its own for the reason every other section
/// is: five independent features share one file, and a broken value in any of
/// them must not take the other four down.
#[derive(Debug, Default, Deserialize)]
struct LiveConfig {
    #[serde(default)]
    live: LiveSection,
}

#[derive(Debug, Default, Deserialize)]
struct LiveSection {
    #[serde(default)]
    prompt: Option<String>,
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

/// The configured live prompt, or `None` for "the block mesa ships"
/// ([`crate::core::live::AGENT_PROMPT`]).
///
/// Read **on every spawn**, like [`command_for`] is, so an edit lands on the
/// next conversation with no restart. Blank is absence — the file's own
/// spelling of "the default". Only the *outer* whitespace is trimmed: the text
/// is prose a person wrote, and its internal shape is theirs.
pub fn live_prompt() -> Result<Option<String>, String> {
    live_prompt_in(&config_file())
}

fn live_prompt_in(path: &Path) -> Result<Option<String>, String> {
    Ok(read_live(path)?
        .prompt
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty()))
}

/// The live settings for the Settings page (`GET /api/config/live`): the
/// configured prompt and auto-send wait (`null` each when the file says
/// nothing) plus the built-in block and the built-in wait, so the editor can
/// show what blank means and start an edit from it without shipping a second
/// copy of either.
pub fn live() -> Result<ConfigLive, String> {
    live_in(&config_file())
}

fn live_in(path: &Path) -> Result<ConfigLive, String> {
    Ok(ConfigLive {
        prompt: live_prompt_in(path)?,
        default_prompt: crate::core::live::AGENT_PROMPT.to_string(),
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
                // Prose is stored trimmed (its outer whitespace is not part of
                // what a person wrote); a number is stored as it validated.
                let value = match value.as_str() {
                    Some(text) => serde_json::Value::String(text.trim().to_string()),
                    None => value.clone(),
                };
                section.insert(key.clone(), value);
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
/// ships": `null` for either key, and a blank string for the prompt box, whose
/// editor sends what the textarea holds.
fn is_live_reset(value: &serde_json::Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
}

/// The rule for one live value, dispatched on the key: the prompt is prose with
/// a length bound, the wait is a whole number of milliseconds inside the sanity
/// bounds. A value of the wrong *shape* is named here too — a prompt sent as a
/// number, or a wait sent as a string — rather than coerced into something the
/// person did not ask for.
fn validate_live(key: &str, value: &serde_json::Value) -> Result<(), String> {
    if key == LIVE_AUTO_SEND_MS {
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
        return Ok(());
    }
    let Some(text) = value.as_str() else {
        return Err(format!("{key} must be text, got {value}"));
    };
    validate_live_prompt(text.trim())
}

/// A live prompt is free prose — it is spoken instructions for a model, not a
/// command line — so the only rule is a length bound. It is never parsed by a
/// shell and never substituted into one: it reaches the agent as a single
/// `Command::arg` (or as `$MESA_PROMPT` in script mode), exactly as the
/// built-in block does.
pub fn validate_live_prompt(prompt: &str) -> Result<(), String> {
    if prompt.len() > MAX_LIVE_PROMPT {
        return Err(format!(
            "the live prompt is {} bytes; the limit is {MAX_LIVE_PROMPT}",
            prompt.len()
        ));
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
        // The placeholder vocabulary is per-action, matching `Vars::lookup`.
        assert_eq!(
            settings[0].placeholders,
            ["{bin}", "{agent}", "{id}", "{name}"]
        );
        assert_eq!(settings[2].action, AGENT_SPAWN);
        assert_eq!(settings[2].placeholders, ["{bin}", "{agent}", "{prompt}"]);
        // The live agent offers the union of the two shapes: it is a mesa
        // record with an id and a name, and mesa supplies its prompt.
        assert_eq!(settings[3].action, LIVE_AGENT);
        assert_eq!(settings[3].default, DEFAULT_LIVE_AGENT);
        assert_eq!(
            settings[3].placeholders,
            ["{bin}", "{agent}", "{id}", "{name}", "{prompt}"]
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
        save_commands_in(&path, &update(&[(AGENT_SPAWN, "  mytool -- {prompt}  ")])).unwrap();
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
        save_commands_in(&path, &update(&[(INBOX_WATCHER, "mytool triage {id}")])).unwrap();
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
        save_commands_in(&path, &update(&[(TODO_WATCHER, "   ")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        // Removed, not stored blank: the default is expressed by absence.
        assert!(written["commands"].get(TODO_WATCHER).is_none());
        assert_eq!(written["commands"]["agent-spawn"], "mytool");
        assert_eq!(command_in(&path, TODO_WATCHER).unwrap(), None);
    }

    #[test]
    fn save_commands_rejects_a_bad_template_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"commands": {"todo-watcher": "mytool {id}"}}"#;
        let path = write_config(dir.path(), before);
        // Unsupported placeholder for this action…
        let err =
            save_commands_in(&path, &update(&[(TODO_WATCHER, "mytool {prompt}")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unsupported placeholder")),
            "{err:?}"
        );
        // …an unterminated quote…
        let err = save_commands_in(&path, &update(&[(AGENT_SPAWN, "mytool \"oops")])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unterminated")),
            "{err:?}"
        );
        // …and a key mesa doesn't configure.
        let err = save_commands_in(&path, &update(&[("tsak", "mytool")])).unwrap_err();
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
        let err = save_commands_in(
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
        let err = save_commands_in(&path, &update(&[(TODO_WATCHER, "mytool {id}")])).unwrap_err();
        // Unavailable, not validation: the user's template was fine, the file
        // on this machine isn't — and overwriting it would destroy content.
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn saved_templates_expand_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_commands_in(
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
        assert_eq!(
            expand(TODO_WATCHER, &template, &vars).unwrap(),
            ["mytool", "--name", "a b", "--", "/go 7"]
        );
    }

    #[test]
    fn tokenize_splits_on_whitespace_and_honors_quotes() {
        assert_eq!(tokenize("claude --bg").unwrap(), ["claude", "--bg"]);
        assert_eq!(tokenize("  a\t b \n").unwrap(), ["a", "b"]);
        assert_eq!(
            tokenize(r#"a "two words" 'and more'"#).unwrap(),
            ["a", "two words", "and more"]
        );
        // Quotes join, they don't separate: adjacent runs are one token.
        assert_eq!(tokenize(r#"--name="a b""#).unwrap(), ["--name=a b"]);
        assert_eq!(tokenize(r#"a "" b"#).unwrap(), ["a", "", "b"]);
        assert_eq!(tokenize(r#""a\"b" c\ d"#).unwrap(), [r#"a"b"#, "c d"]);
        // No shell downstream, so operators are literal characters.
        assert_eq!(tokenize("a | b > c").unwrap(), ["a", "|", "b", ">", "c"]);
        assert_eq!(tokenize("$HOME").unwrap(), ["$HOME"]);
    }

    #[test]
    fn tokenize_rejects_unterminated_quotes_and_backslash() {
        assert!(tokenize(r#"a "b"#).unwrap_err().contains("double quote"));
        assert!(tokenize("a 'b").unwrap_err().contains("single quote"));
        assert!(tokenize("a b\\").unwrap_err().contains("backslash"));
    }

    #[test]
    fn default_templates_reproduce_the_pre_config_argv() {
        // The exact argv mesa hardcoded before this config existed. If any of
        // these three change, the check scripts' stub-argv assertions and the
        // agent CLI contract change with them.
        let vars = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(731),
            name: Some("mesa: do the thing"),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--name",
                "mesa: do the thing",
                "--",
                "/execute-mesa-task 731",
            ]
        );
        assert_eq!(
            expand(INBOX_WATCHER, DEFAULT_INBOX_WATCHER, &vars).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--name",
                "mesa: do the thing",
                "--",
                "/inbox-triage 731",
            ]
        );
        let spawn = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            prompt: Some("look at the tests"),
            ..Default::default()
        };
        assert_eq!(
            expand(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &spawn).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--",
                "look at the tests"
            ]
        );
        // The live agent takes both halves: a named session id *and* the loop
        // prompt mesa supplies. The prompt is one argv entry however long or
        // hostile its text — it is never re-split after substitution.
        let live = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(12),
            name: Some("mesa live 12"),
            prompt: Some("listen; then say \"hi\""),
        };
        assert_eq!(
            expand(LIVE_AGENT, DEFAULT_LIVE_AGENT, &live).unwrap(),
            [
                "claude",
                "--bg",
                "--agent",
                "swe",
                "--name",
                "mesa live 12",
                "--",
                "listen; then say \"hi\"",
            ]
        );
    }

    #[test]
    fn absent_value_drops_the_token_and_its_flag() {
        // No agent (MESA_CLAUDE_AGENT="") → `--agent {agent}` vanishes as a
        // pair; no prompt → so does `-- {prompt}`. Both are today's behavior.
        let vars = Vars {
            bin: Some("claude"),
            ..Default::default()
        };
        assert_eq!(
            expand(AGENT_SPAWN, DEFAULT_AGENT_SPAWN, &vars).unwrap(),
            ["claude", "--bg"]
        );
        let named = Vars {
            bin: Some("claude"),
            id: Some(7),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &named).unwrap(),
            ["claude", "--bg", "--", "/execute-mesa-task 7"]
        );
        // A dropped token only takes a *flag* with it, never a positional.
        let vars = Vars {
            bin: Some("t"),
            id: Some(1),
            ..Default::default()
        };
        assert_eq!(
            expand(TODO_WATCHER, "{bin} run {name}", &vars).unwrap(),
            ["t", "run"]
        );
    }

    #[test]
    fn untrusted_values_stay_one_argv_token() {
        // The whole point of substituting after tokenizing: a name full of
        // spaces, quotes and shell metacharacters is one argument, and the
        // argv length is fixed by the template.
        let hostile = r#"drop "; rm -rf / #' --dangerously-skip-permissions"#;
        let vars = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(1),
            name: Some(hostile),
            ..Default::default()
        };
        let argv = expand(TODO_WATCHER, DEFAULT_TODO_WATCHER, &vars).unwrap();
        assert_eq!(argv.len(), 8);
        assert_eq!(argv[5], hostile);
    }

    #[test]
    fn placeholders_are_scoped_to_the_action() {
        let vars = Vars {
            bin: Some("claude"),
            id: Some(1),
            prompt: Some("p"),
            ..Default::default()
        };
        // agent-spawn has no mesa record behind it, so no {id}/{name}…
        let err = expand(AGENT_SPAWN, "{bin} {id}", &vars).unwrap_err();
        assert!(err.contains("{id}"), "{err}");
        assert!(err.contains("{bin}, {agent}, {prompt}"), "{err}");
        // …and the watchers' prompt is theirs to write, not mesa's to inject.
        let err = expand(TODO_WATCHER, "{bin} {prompt}", &vars).unwrap_err();
        assert!(err.contains("{prompt}"), "{err}");
        let err = expand(TODO_WATCHER, "{bin} {nope}", &vars).unwrap_err();
        assert!(err.contains("{nope}"), "{err}");
    }

    #[test]
    fn expand_handles_braces_that_are_not_placeholders() {
        let vars = Vars {
            bin: Some("t"),
            id: Some(5),
            ..Default::default()
        };
        // An unclosed brace is literal text, and a placeholder can sit inside
        // a larger token (`mesa-{id}` is one argument).
        assert_eq!(
            expand(TODO_WATCHER, "{bin} a{b mesa-{id}", &vars).unwrap(),
            ["t", "a{b", "mesa-5"]
        );
    }

    #[test]
    fn expand_rejects_a_template_that_yields_no_argv() {
        let vars = Vars::default();
        assert!(
            expand(TODO_WATCHER, "   ", &vars)
                .unwrap_err()
                .contains("nothing")
        );
        assert!(
            expand(TODO_WATCHER, "{name}", &vars)
                .unwrap_err()
                .contains("nothing")
        );
        assert!(
            expand(TODO_WATCHER, r#"a "b"#, &vars)
                .unwrap_err()
                .contains("double quote")
        );
    }

    // ---- script mode (mesa task 667) ------------------------------------

    #[test]
    fn is_script_is_decided_by_a_newline_in_the_trimmed_value() {
        assert!(!is_script(DEFAULT_TODO_WATCHER));
        assert!(!is_script("mytool run {id}"));
        // Surrounding blank lines are whitespace, not a second line.
        assert!(!is_script("\n\n  mytool run {id}  \n\n"));
        assert!(is_script("cd /repo\nmytool run"));
        assert!(is_script("mytool \\\n  run"));
    }

    #[test]
    fn resolve_returns_argv_for_a_single_line_and_a_script_for_many() {
        let vars = Vars {
            bin: Some("claude"),
            agent: Some("swe"),
            id: Some(7),
            name: Some("n"),
            ..Default::default()
        };
        assert_eq!(
            resolve(TODO_WATCHER, "{bin} run {id}", &vars).unwrap(),
            Spawn::Argv(vec!["claude".into(), "run".into(), "7".into()])
        );
        // The stored body is trimmed, and the env is the action's vocabulary
        // minus what has no value on this call.
        assert_eq!(
            resolve(TODO_WATCHER, "\n cd /repo\n exec claude \n", &vars).unwrap(),
            Spawn::Script {
                script: "cd /repo\n exec claude".to_string(),
                env: vec![
                    ("MESA_BIN".to_string(), "claude".to_string()),
                    ("MESA_AGENT".to_string(), "swe".to_string()),
                    ("MESA_ID".to_string(), "7".to_string()),
                    ("MESA_NAME".to_string(), "n".to_string()),
                ],
            }
        );
    }

    #[test]
    fn script_env_is_scoped_per_action_and_omits_absent_values() {
        // agent-spawn gets a prompt and never an id/name…
        let spawn = Vars {
            bin: Some("claude"),
            id: Some(7),
            name: Some("n"),
            prompt: Some("p"),
            ..Default::default()
        };
        assert_eq!(
            script_env(AGENT_SPAWN, &spawn),
            [
                ("MESA_BIN".to_string(), "claude".to_string()),
                ("MESA_PROMPT".to_string(), "p".to_string()),
            ]
        );
        // …and an absent value is omitted entirely rather than set empty —
        // the script-mode analogue of the argv drop rule.
        let bare = Vars {
            bin: Some("claude"),
            ..Default::default()
        };
        assert_eq!(
            script_env(TODO_WATCHER, &bare),
            [("MESA_BIN".to_string(), "claude".to_string())]
        );
        assert_eq!(script_env(AGENT_SPAWN, &bare).len(), 1);
    }

    #[test]
    fn a_placeholder_in_a_script_is_an_error_naming_its_env_var() {
        let err = validate(TODO_WATCHER, "cd /repo\nclaude --name {name}").unwrap_err();
        assert!(err.contains("{name}"), "{err}");
        assert!(err.contains("$MESA_NAME"), "{err}");
        // A placeholder this action doesn't offer keeps the existing message,
        // because the fix is not "use the variable" — there isn't one.
        let err = validate(TODO_WATCHER, "cd /repo\nclaude -- {prompt}").unwrap_err();
        assert!(err.contains("unsupported placeholder"), "{err}");
        // The spawn path refuses it too, not just the editor.
        let err = resolve(
            AGENT_SPAWN,
            "cd /repo\nclaude -- {prompt}",
            &Vars::default(),
        )
        .unwrap_err();
        assert!(err.contains("$MESA_PROMPT"), "{err}");
    }

    #[test]
    fn a_scripts_own_shell_syntax_is_not_mistaken_for_a_placeholder() {
        // `${VAR}`, brace expansion and `{ …; }` grouping all contain braces;
        // only a bare, known placeholder name is the mistake being named.
        for script in [
            "cd /repo\nexec \"$MESA_BIN\" --name \"${MESA_NAME}\"",
            "cd /repo\ncp a.txt{,.bak}\n{ echo one; echo two; }",
            "cd /repo\necho \"{id: 1}\" | tee out.json",
        ] {
            assert_eq!(validate(TODO_WATCHER, script), Ok(()), "{script}");
        }
    }

    #[test]
    fn a_script_with_a_bash_syntax_error_is_refused_at_save_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let err = save_commands_in(
            &path,
            &update(&[(TODO_WATCHER, "cd /repo\nif true; then\necho stuck")]),
        )
        .unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("not valid bash")),
            "{err:?}"
        );
        assert!(!path.exists(), "a rejected save must write nothing");
        // A well-formed script round-trips and stays a script on the way back.
        let script = "cd /repo\nexec \"$MESA_BIN\" --bg -- \"work on $MESA_ID\"";
        save_commands_in(&path, &update(&[(TODO_WATCHER, script)])).unwrap();
        let stored = command_in(&path, TODO_WATCHER).unwrap().unwrap();
        assert_eq!(stored, script);
        assert!(is_script(&stored));
    }

    #[test]
    fn a_blank_value_still_clears_the_key_in_either_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"commands": {"todo-watcher": "cd /repo\nexec claude"}}"#,
        );
        save_commands_in(&path, &update(&[(TODO_WATCHER, "\n  \n")])).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["commands"].get(TODO_WATCHER).is_none());
    }

    #[test]
    fn settings_reports_the_script_mode_vocabulary_beside_the_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"commands": {}}"#);
        let settings = settings_in(&path).unwrap();
        assert_eq!(
            settings[0].env_vars,
            ["MESA_BIN", "MESA_AGENT", "MESA_ID", "MESA_NAME"]
        );
        assert_eq!(
            settings[2].env_vars,
            ["MESA_BIN", "MESA_AGENT", "MESA_PROMPT"]
        );
        assert_eq!(
            settings[3].env_vars,
            [
                "MESA_BIN",
                "MESA_AGENT",
                "MESA_ID",
                "MESA_NAME",
                "MESA_PROMPT"
            ]
        );
        // The two vocabularies line up one-for-one, in the same order.
        for row in &settings {
            assert_eq!(row.placeholders.len(), row.env_vars.len(), "{}", row.action);
        }
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
        save_commands_in(&path, &update(&[(INBOX_WATCHER, "mytool triage {id}")])).unwrap();
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
            assert_eq!(root["future"]["x"], 1, "{label}");
            root
        };

        // Saving watchers leaves every other section alone.
        save_watchers_in(&path, &watcher(&[(TODO_CONCURRENCY, Some(7))])).unwrap();
        assert_eq!(survives("watchers")["watchers"][TODO_CONCURRENCY], 7);
        // …and each of the other savers leaves `watchers` alone.
        save_commands_in(&path, &update(&[("todo-watcher", "mytool run {id}")])).unwrap();
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
        save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some("Be brief."))])).unwrap();
        let root = survives("live");
        assert_eq!(root["watchers"][TODO_CONCURRENCY], 7);
        assert_eq!(root["live"][LIVE_PROMPT], "Be brief.");
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

    /// The whole live-prompt contract in one pass: nothing configured is the
    /// built-in block, a saved prompt is what the spawn path reads, and blank
    /// or `null` removes the key rather than storing an empty prompt that
    /// would spawn an agent with no instructions at all.
    #[test]
    fn live_prompt_round_trips_and_resets_to_the_built_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert_eq!(live_prompt_in(&path).unwrap(), None);
        assert_eq!(
            live_in(&path).unwrap().default_prompt,
            crate::core::live::AGENT_PROMPT
        );

        save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some("  Be brief.  "))])).unwrap();
        assert_eq!(live_prompt_in(&path).unwrap().as_deref(), Some("Be brief."));
        assert_eq!(live_in(&path).unwrap().prompt.as_deref(), Some("Be brief."));

        for reset in [None, Some("")] {
            save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some("Be brief."))])).unwrap();
            save_live_in(&path, &live_update(&[(LIVE_PROMPT, reset)])).unwrap();
            let written: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(written["live"].get(LIVE_PROMPT).is_none(), "{reset:?}");
            assert_eq!(live_prompt_in(&path).unwrap(), None);
        }
    }

    /// The auto-send wait's whole contract (mesa task 886): nothing configured
    /// is the two seconds mesa shipped before the setting existed, a saved
    /// value is what the page reads back, `null` removes the key, and the two
    /// live keys are written and reset independently — one section, two
    /// settings, neither able to clobber the other.
    #[test]
    fn live_auto_send_round_trips_beside_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert_eq!(live_in(&path).unwrap().auto_send_ms, None);
        assert_eq!(
            live_in(&path).unwrap().auto_send_ms_default,
            DEFAULT_LIVE_AUTO_SEND_MS
        );

        save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some("Be brief."))])).unwrap();
        save_live_in(
            &path,
            &live_json(LIVE_AUTO_SEND_MS, Some(serde_json::json!(4500))),
        )
        .unwrap();
        assert_eq!(live_in(&path).unwrap().auto_send_ms, Some(4500));
        // The number is stored as a number, not as the string the box held.
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["live"][LIVE_AUTO_SEND_MS], 4500);
        // …and the prompt beside it is untouched by that write.
        assert_eq!(live_prompt_in(&path).unwrap().as_deref(), Some("Be brief."));

        save_live_in(&path, &live_json(LIVE_AUTO_SEND_MS, None)).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(written["live"].get(LIVE_AUTO_SEND_MS).is_none());
        assert_eq!(live_in(&path).unwrap().auto_send_ms, None);
        assert_eq!(live_prompt_in(&path).unwrap().as_deref(), Some("Be brief."));
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
        // A prompt sent as a number is the same class of mistake.
        assert!(matches!(
            save_live_in(&path, &live_json(LIVE_PROMPT, Some(serde_json::json!(7)))),
            Err(SaveError::Validation(_))
        ));

        for hand_edited in [0, 999_999] {
            let path = write_config(
                dir.path(),
                &format!(r#"{{"live": {{"auto-send-ms": {hand_edited}}}}}"#),
            );
            assert_eq!(live_in(&path).unwrap().auto_send_ms, Some(hand_edited));
        }
    }

    /// A rejected save leaves the file byte-identical, and an unknown key in
    /// the section is named rather than silently written.
    #[test]
    fn save_live_rejects_an_oversized_prompt_and_an_unknown_key() {
        let dir = tempfile::tempdir().unwrap();
        let before = r#"{"live": {"prompt": "Be brief."}}"#;
        let path = write_config(dir.path(), before);

        let huge = "x".repeat(MAX_LIVE_PROMPT + 1);
        let err = save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some(&huge))])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("live prompt")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        let err = save_live_in(&path, &live_update(&[("voice", Some("af_heart"))])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Validation(m) if m.contains("unknown live setting")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // Nothing named writes nothing — no empty `"live": {}` appears.
        let path = dir.path().join("untouched.json");
        save_live_in(&path, &HashMap::new()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn live_refuses_a_malformed_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "not json");
        let err = live_prompt_in(&path).unwrap_err();
        assert!(err.contains("malformed mesa config"), "{err}");
        assert!(live_in(&path).is_err());
        let err = save_live_in(&path, &live_update(&[(LIVE_PROMPT, Some("hi"))])).unwrap_err();
        assert!(
            matches!(&err, SaveError::Unavailable(m) if m.contains("malformed mesa config")),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn every_default_names_a_known_action() {
        for action in [TODO_WATCHER, INBOX_WATCHER, AGENT_SPAWN, LIVE_AGENT] {
            assert!(default_command(action).is_some(), "{action}");
        }
        assert_eq!(default_command("task-execute"), None);
    }
}
