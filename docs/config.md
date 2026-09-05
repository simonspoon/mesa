# Config (`~/.mesa/config.json`)

mesa starts a coding agent from exactly five places. Each one's command line
is a **template** in `~/.mesa/config.json`, so the program, its flags, the
persona and the slash command can all change without rebuilding mesa:

| Key | Used by | Built-in default |
| --- | --- | --- |
| `todo-watcher` | `serve --watch-todo` dispatch (`docs/todo-watcher.md`) | `{bin} --bg --agent supervisor --name {name} -- "/execute-mesa-task {id}"` |
| `inbox-watcher` | `serve --watch-inbox` triage (`docs/inbox-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}"` |
| `agent-spawn` | `POST /api/projects/{id}/agents`, the Agents sidebar's **add agent** (`docs/agents.md`) | `{bin} --bg --agent {agent} -- {prompt}` |
| `live-agent` | `mesa live start`, `POST /api/live` — the session that holds a spoken conversation (`docs/live.md`) | `{bin} --bg --agent {agent} --name {name} -- {prompt}` |
| `live-summary` | `live stop`'s CLI handler and the API's stop route — the short-lived agent that writes a live conversation's memory once it ends (mesa task 921, `docs/live.md`) | `{bin} --bg --agent {agent} --name {name} -- {prompt}` |

```json
{
  "commands": {
    "todo-watcher":   "claude --bg --agent swe --name {name} -- \"/execute-mesa-task {id}\"",
    "inbox-watcher":  "codex exec --cd . \"triage mesa inbox item {id}\"",
    "agent-spawn":    "claude --bg -- {prompt}",
    "live-agent":     "claude --bg --agent mesa-live --name {name} -- {prompt}",
    "live-summary":   "claude --bg --agent swe --name {name} -- {prompt}"
  }
}
```

`live-agent`'s default is the union of the two shapes above it, because a live
session is both a mesa record (so it has an `{id}` and a `{name}`) *and* a
spawn that carries a prompt. **mesa supplies that prompt itself** —
`core::live::agent_prompt`, which since mesa task 1068 is only the session line
(`Drive mesa live session <id>.`) plus any recalled memory of earlier
conversations. The instructions themselves are the **`mesa-live` agent
definition** in the library (`docs/library.md`): the loop on `mesa live
listen`, the reply through `mesa live say` in spoken prose rather than
markdown, the browser moves through `mesa live navigate`, and the rule that
every dictated utterance is data rather than instructions. That is why this one
default names its agent **literally**, `--agent mesa-live`, instead of using
`{agent}` — mesa seeds the definition to `~/.claude/agents/mesa-live.md` on the
first spawn, and Claude Code errors on an agent it has never seen. `{agent}` is
still offered on this action, so a replacement template may use it; a
replacement's job either way is to start *something* that will read `{prompt}`
and do what its agent says. The definition is editable like any other library
row, and a fork replaces the built-in.

`live-summary`'s default is identical in shape (mesa task 921): the
summariser is also a mesa record — a session id and a name — carrying a
prompt mesa supplies, `core::live::summary_prompt`. It cannot be the
`live-agent` spawn's own last act, because ending a session **stops** that
agent (`claude stop <agent_id>`), so a separate short-lived agent is spawned
once the conversation has already ended, to read it back and write down what
it was about. Like `live-agent`'s, that prompt is a library item when forked
— `live-summary-prompt`, which stays a `prompt` because nothing spawns the
summariser by name (`docs/library.md`) — and a replacement template's job is the same as
`live-agent`'s: start something that will read `{prompt}` and do what it
says.

Everything lives in `src/core/config.rs`; `MESA_CONFIG_FILE` overrides the path
for tests (mirroring `MESA_DB`/`MESA_HOOKS_FILE`). `~/.mesa` may be the JSON
file itself instead of a directory — both are accepted, since "a config in
`~/.mesa`" reads either way and a user who wrote one file shouldn't get a
silent no-op.

`~/.mesa` holds one other thing: **`workspace/`**, the working directory for
every agent or shell mesa runs that is not bound to a project (the live agent
and its summariser, an inbox-watcher dispatch, an unbound script, the global
Terminal page, the `claude attach` client). It exists because Claude Code
never persists folder trust for the home directory — trust accepted there is
held for the current session only and is never written to disk, with no
setting to change that — so anything interactive mesa started in `$HOME`
re-prompted forever. `config::workspace_dir()` creates it on demand and is
deliberately **independent of `MESA_CONFIG_FILE`**: that override moves the
config *file*, not mesa's home.

A value has **two modes**, chosen by the value itself: one line is an argv
template (below), more than one is a bash script
([Script mode](#script-mode)). There is no mode key and nothing to migrate —
every template that exists today is one line and behaves byte-for-byte as it
always has.

## Argv, not a shell

A single-line template is **tokenized and executed directly** — there is no
`sh -c` anywhere on this path, unlike `hooks.json` (`docs/hooks.md`), which
genuinely is a shell string.

That is load-bearing. Every watcher passes untrusted free text as the session
name: a task's derived name, or an inbox item's first line. What makes that
safe is that the text arrives as one `Command::arg`. So substitution happens **after**
tokenization: the argv length is fixed by the template alone, and no value can
split into extra arguments or be re-read as a flag. A name of
`"; rm -rf / #` is just a long, silly session name.

Script mode does **not** weaken this. It runs `bash`, but no mesa value is ever
spliced into the script text: the body reaches `bash -c` verbatim and the values
arrive out-of-band, in the child's environment. The invariant was never "mesa
runs no shell" — it is **mesa never interpolates a value into a string a shell
parses**, and both modes hold it.

The consequences of having no shell:

- `|`, `>`, `&&`, `$VAR`, `~` are ordinary characters. No pipes, no
  redirection, no environment expansion, no globbing. Write absolute paths.
- Quote an argument that contains spaces: `'…'` (literal) or `"…"`
  (backslash-escapable). **The prompt in both watcher defaults is quoted
  for exactly this reason** — `-- "/execute-mesa-task {id}"` is one argument;
  unquoted, it would be two and the id would be lost.
- An unterminated quote or a trailing backslash is an error, not a
  silently-mangled argv.
- Need a shell? Write a second line — see script mode below. (`sh -c "…"` as a
  one-line template also works, but then the quoting of untrusted values is
  yours to get right; script mode hands them to you already safe.)

## Placeholders

`{}`-delimited, substituted per token. Which ones a command may use depends on
what that spawn actually knows about:

| Placeholder | Where | Value |
| --- | --- | --- |
| `{bin}` | all five | `MESA_CLAUDE_BIN`, else `claude` |
| `{agent}` | all five | `MESA_CLAUDE_AGENT`, else `swe`; unavailable when set empty |
| `{id}` | watchers, `live-agent`, `live-summary` | the task id / inbox item id / live session id |
| `{name}` | watchers, `live-agent`, `live-summary` | the session name mesa derives — `<project>: <task name>` (todo-watcher), `inbox <id>: <first body line>` (**untrusted text**), or the live session's own name |
| `{prompt}` | `agent-spawn`, `live-agent`, `live-summary` | the POST body's `prompt` (`agent-spawn`; unavailable when omitted) / the live agent's or summariser's instruction block, always present |

Two rules cover the edges:

- **A placeholder the command isn't offered is an error**, named in the
  message (`{id}` in `agent-spawn`, `{prompt}` in a watcher, a typo like
  `{tsak}`) — raised before anything runs, rather than passing a literal
  `{tsak}` to a program.
- **A placeholder that is offered but has no value on this call drops its
  token, plus an immediately preceding token starting with `-`.** So
  `--name {name}` and `-- {prompt}` vanish as pairs rather than leaving a
  dangling flag to swallow the next argument. This is what makes the defaults
  reproduce mesa's pre-config behavior exactly: `MESA_CLAUDE_AGENT=""` drops
  `--agent {agent}`, and a promptless spawn drops `-- {prompt}` and starts an
  idle session.

A `{` that opens nothing is a literal brace, and a placeholder may sit inside a
larger token (`--name mesa-{id}`).

## Script mode

**A value whose trimmed text contains a newline is a bash script**, run as
`bash -c <script>` from the same folder the argv would have run in. That is the
whole switch: no new key, no flag. Surrounding blank lines are whitespace and
do not by themselves make a value a script.

It exists because a single program call cannot `cd`, export an env var, pick a
binary conditionally, or run a setup step first.

```json
{
  "commands": {
    "todo-watcher": "set -euo pipefail\ncd \"$HOME/src/checkouts/$MESA_ID\" 2>/dev/null || cd \"$HOME/src\"\nexport CLAUDE_PROJECT=mesa\nexec \"$MESA_BIN\" --bg --agent swe --name \"$MESA_NAME\" -- \"/execute-mesa-task $MESA_ID\""
  }
}
```

More legibly, that value is:

```bash
set -euo pipefail
cd "$HOME/src/checkouts/$MESA_ID" 2>/dev/null || cd "$HOME/src"
export CLAUDE_PROJECT=mesa
exec "$MESA_BIN" --bg --agent swe --name "$MESA_NAME" -- "/execute-mesa-task $MESA_ID"
```

### Values arrive as environment variables

**Nothing is substituted into a script.** The body goes to `bash` verbatim and
the values are set on the child process instead — which is what keeps untrusted
free text out of shell parsing in this mode too. Each placeholder has one
variable, offered on exactly the commands its `{}` twin is:

| Placeholder | Variable | Where |
| --- | --- | --- |
| `{bin}` | `MESA_BIN` | all five |
| `{agent}` | `MESA_AGENT` | all five |
| `{id}` | `MESA_ID` | watchers, `live-agent`, `live-summary` |
| `{name}` | `MESA_NAME` | watchers, `live-agent`, `live-summary` |
| `{prompt}` | `MESA_PROMPT` | `agent-spawn`, `live-agent`, `live-summary` |

Two rules mirror the argv ones:

- **A variable this command doesn't offer is not set** — a watcher script never
  sees `MESA_PROMPT`, an `agent-spawn` script never sees `MESA_ID`/`MESA_NAME`.
  A `live-agent` script sees all five, since that spawn knows all five.
  mesa explicitly *removes* all five before setting the ones that apply, so a
  variable can't leak in from the environment `mesa serve` was started with.
- **A value with nothing to say on this call leaves its variable unset**, not
  empty — the analogue of the drop rule. `MESA_CLAUDE_AGENT=""` means no
  `MESA_AGENT`; a promptless `POST /api/projects/{id}/agents` means no
  `MESA_PROMPT`. So `set -u` fires and `${MESA_PROMPT:-}` reads as "no prompt"
  rather than "empty prompt".

Quote your uses (`"$MESA_NAME"`), as in any bash script — a task name has
spaces in it.

### `{placeholder}` in a script is an error

`{}` syntax is meaningless in script mode and would collide with `${VAR}`
besides, so a script containing one is **refused at save time**, with a message
naming the variable to use instead. It is neither silently expanded nor
silently ignored. `PUT /api/config` answers 422 `validation` and the file is
left byte-identical.

Only the five known names count, and only when the `{` isn't preceded by `$` —
a script's own `${MESA_NAME}`, `cp a{,.bak}` brace expansion and `{ …; }`
grouping are left alone.

### Also refused at save time

- An **empty** script, exactly as an empty template is. (Blank still *clears*
  the key back to the built-in default — that is the same rule in both modes,
  and it wins: a whitespace-only value is a reset, not an error.)
- A **bash syntax error**, checked with `bash -n` — which parses and executes
  nothing. A machine with no `bash` on PATH skips the check rather than failing
  the save; mesa can't prove a script is wrong there, and such a machine can't
  run it either.

### What is unchanged

Everything on the far side of the spawn. A script is read fresh on every spawn
(no caching, no restart), only its **exit code** matters, and a
`backgrounded · <id>` line on stdout is still parsed as the optional receipt —
see "What a replacement command owes mesa" below. The watchers' revert/retry
paths don't know which mode ran.

## Resolution and failure

- **Read on every spawn**, not cached at startup: edit the file and the next
  dispatch uses it, with no server restart.
- **Absent file, absent key, or a blank value ⇒ the built-in default.** Blank
  is the natural way to un-set one command back to the default.
- **A file that exists but can't be read or parsed is an error**, surfaced
  where the spawn happens (the watcher logs it and releases its claim; the API
  answers 502 `unavailable`). A broken config must never read as
  "unconfigured" — same rule as `hooks.json`.
- The defaults are template strings run through the same expander as a user's,
  so there is one code path, and `MESA_CLAUDE_BIN`/`MESA_CLAUDE_AGENT` keep
  working as the check scripts' seams. A template that hardcodes its program
  has simply opted out of `MESA_CLAUDE_BIN`.

## What a replacement command owes mesa

Only its **exit code**. Nonzero is a failed spawn (the todo-watcher reverts the
task to `todo`; the inbox-watcher drops the id from its
in-memory dispatched set, so a later tick retries).

Printing `backgrounded · <id>` is optional. mesa parses that line when it is
there and `POST /api/projects/{id}/agents` returns the id; with no such line
the response is still `201` with **`id: null`**, and clients must read that as
"created, find it in the session list" — the Agents sidebar just can't
pre-open an attach pane for it. Nothing in mesa treats a missing receipt as
failure.

Two surfaces stay bound to `claude` regardless of these templates, because
neither *starts* a session: the session list (`claude agents --json`) and the
attach bridge (`claude attach <id>`), both of which use `MESA_CLAUDE_BIN`
directly. Point a template at a different tool and its sessions will run —
they just won't appear in, or be attachable from, the Agents sidebar.

## The Settings page

The same file is editable from the web UI: **Settings**, pinned to the bottom
of the left nav (`#/settings`, `SettingsView.tsx`, mesa task 654). It is a form
over `commands` — a text box per action, the built-in default shown as the
box's placeholder, the action's placeholder vocabulary listed under it, and the
argv that will actually run spelled out beneath — followed by one section per
other part of the file (Watchers, Live conversation, Speech, Model pricing).
**Each section has
its own endpoint, draft and save button**: they are separate writes, so one
form's rejection must never strand another's edits.

The page's title row also carries **Restart server** (`POST /api/restart`),
right-aligned opposite the heading — moved here off the left nav's footer in
mesa task 655, since relaunching the binary is the same machine-level concern
the page already owns. It renders in all three of the page's states, including
the unreadable-config error: a restart must stay reachable exactly when the
page's own data won't load. Nothing about the config needs it — a save is live
on the next dispatch — so the two never interact.

Two behaviors it exists to make legible, both of them the file's semantics
rather than presentation:

- **A blank box is the built-in default**, not an empty command — so *reset* is
  literally "clear the box", and a saved blank **removes the key** rather than
  storing `""`.
- **A bad template is refused at save time**, with the same message the spawn
  path would have produced later (`{tsak}`, an unbalanced quote, an unknown
  key; in script mode a `{placeholder}` or a bash syntax error). Validation runs
  over the whole batch before anything is written, so a rejected save leaves the
  file byte-identical.
- **The mode is visible while typing.** Each row's "will run" line switches to
  `bash -c` plus the variables that will be set the moment the box holds a
  second line, and the vocabulary listed under the box switches with it —
  `{}` placeholders in argv mode, `$MESA_*` in script mode, never both, since
  showing both invites the mistake the server rejects. A `{placeholder}` typed
  into a script is named inline, before the save.

Behind it, `GET /api/config` and `PUT /api/config` (`core::config::settings` /
`save_commands`):

- `GET` returns one row per action —
  `{action, value, default, placeholders, env_vars}`, where `value` is `null`
  when the action is falling back and the two vocabularies line up one-for-one
  (`{id}` ↔ `MESA_ID`), so the editor can name whichever mode applies. A file that exists
  but can't be parsed is **502 `unavailable`** here exactly as it is on a spawn:
  the page says the config is broken rather than rendering an empty editor a
  save would then write over the wreckage.
- `PUT` takes `{"commands": {<action>: <template>}}` and touches **only** the
  keys present; other keys, and any other top-level section of the file, are
  preserved verbatim (this file is meant to grow sections mesa doesn't know
  about). It echoes the settings re-read from disk. A rejected template is
  **422 `validation`**; an unreadable/unwritable file is **502 `unavailable`**.
  The write is a temp-file rename, since the config is read on every spawn with
  no lock between the two.
- The write is gated by **`require_agent_access`** — the same gate as the read
  beside it (mesa task 1021, the reversal mesa task 1004 already made for the
  library's eleven routes). In **default** mode that is strictly stronger than
  the loopback-only check this route used to carry: loopback peer **plus**
  local Host **plus** local Origin. Under **`--lan`** it *relaxes rather than
  refuses* — a page this server handed a phone may edit Settings, while both
  confused-deputy defenses stay shut (`require_lan_agent_host` for DNS
  rebinding, `require_origin_matches_host` for a cross-site fetch). `--lan` is
  already the opt-in "trust every device on this network" choice that hands
  that network a terminal, a shell and script execution, so refusing it the
  Settings page while granting it the shell was a distinction with no security
  content. As of **mesa task 1022** nothing is loopback-only in both modes any
  more: the scripts' *authoring* routes, the `local_path` write,
  `/api/fs/dirs` and the CC index reset all moved onto this same gate, and
  `require_local_path_write` is gone.

Nothing is cached: a save is live on the next dispatch, with no restart.

## Pricing

A second, independent section prices model families for the CC Dashboard's
estimated cost (`docs/cc-dashboard.md`). It exists so a price change or a whole
new model family is a Settings edit rather than a rebuild — before it, the
table was an `if`-chain in `src/core/cc.rs` and anything unrecognized silently
estimated $0.

```json
{
  "pricing": {
    "claude-opus":        {"input": 5.0, "output": 25.0, "cache_read": 0.5, "cache_write": 6.25},
    "claude-opus-5-mini": {"input": 1.0, "output": 5.0,  "cache_read": 0.1, "cache_write": 1.25}
  }
}
```

- Keys are model-family **prefixes**, matched against a transcript's model id
  with `starts_with` — the same rule the hardcoded table used, so a point
  release prices correctly with no edit. All four rates are USD per **1M
  tokens** and all four are required; mesa never derives a cache rate from the
  input rate.
- mesa ships defaults for `claude-fable`, `claude-mythos`, `claude-opus`,
  `claude-sonnet` and `claude-haiku` (`config::DEFAULT_PRICES`). An **absent
  key uses the built-in**; the config only ever overlays.
- **Longest matching prefix wins** over the merged table, so a variant can be
  priced beside its family. A model no prefix matches estimates **$0** — no
  cost rather than a wrong one.
- A prefix mesa has never heard of is allowed. That is the point.
- Removing a key (`PUT` value `null`) restores the built-in for a shipped
  family and deletes a user-added prefix outright.
- A malformed config is `unavailable`, never a silent fall back to the
  built-ins — the same rule the spawn path follows.

Validation happens in `core::config` before anything is written, and is
all-or-nothing: a prefix must be non-empty after trimming, whitespace-free and
≤ 64 characters, and every rate must be finite and ≥ 0. A rejected save leaves
the file byte-identical.

`pricing` is a sibling of `commands` (and, below, `watchers`) over one
document: saving one preserves the others (and any section mesa doesn't
know). Nothing is
cached — the table is loaded **once per dashboard request** and a save applies
to the next read, past sessions included, with no restart. Cost is derived on
every read, so there is no stored figure to migrate.

In the Settings editor a row's four boxes show the built-in rate as their
**placeholder**, so a box left blank on a part-filled row means "keep that
rate": mesa fills the untouched boxes from the default before the PUT, which
sends all four numbers as the server requires (mesa task 1020). A blank box is
only an error on a prefix the user added, which has no default to fall back on;
a row whose boxes are *all* blank is still the reset, not four copies of the
built-in.

The Settings page renders the pricing rows in a **Model pricing** section, and
that section also carries the one non-config control on the page: **Reset CC
index** (`POST /api/cc/reset`, mesa task 698) — a confirmed operator action
that purges the stored `cc_*` telemetry and re-ingests the transcripts on disk,
which is what corrects costs recorded before the usage-dedupe fix. It lives
here because it is the other half of "what the dashboard's cost says", not in
the title row, where Restart is deliberately the one always-reachable control.
See `docs/cc-dashboard.md` for the permanent-loss property.

### Routes

- `GET /api/config/pricing` → `ConfigPrice[]`: the built-in families in
  declaration order, then any user-added prefix, sorted. Each row carries
  `value` (the override, `null` when unset) and `default` (the built-in,
  `null` for a user-added prefix). Gated like `GET /api/config`
  (`require_agent_access`); a malformed config is **502 `unavailable`**.
- `PUT /api/config/pricing`, body `{"pricing": {"<prefix>": {rates} | null}}`
  → echoes the getter. Only the keys present are touched, so two editors can't
  clobber each other. A bad prefix or rate is **422 `validation`**. Gated with
  `require_agent_access` — exactly like `PUT /api/config` (mesa task 1021): it
  is the same file, and which section a write lands in is not the distinction
  that matters.

`/api/config`'s own shape is unchanged — a bare `ConfigCommand[]` and
`{commands: {…}}` — because that is what agents and `config-check.sh` assert.

## Watchers

A third, independent section holds per-watcher tuning knobs — currently one:
the todo-watcher's per-project concurrency limit (mesa task 777,
`docs/todo-watcher.md`).

```json
{
  "watchers": {
    "todo-concurrency": 3
  }
}
```

- `todo-concurrency` bounds how many `in_progress` **leaf** tasks a single
  project may hold at once. **Absent or `null` ⇒ the built-in default, 1** —
  today's one-agent-per-project behavior, unchanged for anyone who never
  touches this key. The editor (`PUT`) requires an integer in `1..=20`; zero,
  negative, non-integer or over 20 is `422 validation`, writing nothing. The
  upper bound is a sanity cap against a typo, not a policy — there is no
  larger "unlimited" escape hatch. A hand-edited value outside that range
  (found in the file, not written through `PUT`) is **clamped** into it on
  read rather than failing the tick — a stray `0` obviously means "one at a
  time", and refusing to dispatch at all over a typo would be the worse
  answer. Only the write path is strict.
- **Read at the top of every tick, not cached** — the same rule `commands`
  and `pricing` follow: edit the file and the very next tick uses it, no
  restart. A malformed file is `unavailable` here exactly as it is on the
  other two routes — never a silent fall back to the default.
- Lowering the limit never touches work already dispatched: an
  already-`in_progress` leaf stays `in_progress` regardless of what the limit
  now says. It only narrows what the *next* tick is willing to start.

### Routes

- `GET /api/config/watchers` → `ConfigWatchers`:
  `{todo_concurrency, todo_concurrency_default}`, where `todo_concurrency` is
  the override (`null` when unset) and `todo_concurrency_default` is the
  built-in, 1. Gated like `GET /api/config`/`GET /api/config/pricing`
  (`require_agent_access`); a malformed config is **502 `unavailable`**.
- `PUT /api/config/watchers`, body `{"todo_concurrency": <1..=20> | null}` →
  echoes the getter. `null` removes the key, restoring the default. An
  out-of-range or non-integer value is **422 `validation`**, writing nothing.
  Gated with `require_agent_access` — the same posture as the other two config
  writes (mesa task 1021): it is the same file, and which section a write lands
  in is not the distinction that matters.

The sections are siblings over one document: saving `watchers` preserves
`commands`, `pricing`, `speech`, `guard` and any section mesa doesn't know
about, and vice versa.

## Speech

A fourth, independent section picks the **voice** the Inbox's play button
reads an item in (mesa task 822, `docs/inbox.md`).

```json
{
  "speech": {
    "voice": "bm_george"
  }
}
```

- **Absent or blank ⇒ no `-v` at all.** mesa names no default
  voice of its own: with nothing configured the argv is byte-for-byte the one
  it ran before this key existed, and which voice that means is
  `kokoro-rs`'s business. That is why `ConfigSpeech` has no `voice_default`
  twin to `todo_concurrency_default` — there is no mesa-side default to
  report.
- **The list of voices comes from the binary**, not from mesa:
  `kokoro-rs --list-voices`, filtered to bounded identifiers and cached for
  the life of the process (`core::speech::voices`). An **empty list means mesa
  could not ask** — no binary, or an answer that wasn't a list of names —
  never "there are no voices", so the editor falls back to a plain text box
  and the save-time membership check is skipped. mesa never ships a voice list
  a model update could silently make wrong. The cache is per process, so
  installing the synthesiser (or a model that adds a voice) while `mesa serve`
  is already running needs a **Restart server** before the picker sees it —
  the button is in the Settings page's own title row. `--list-voices` runs with
  `--no-download`: listing names must never turn into a model fetch, because
  the call sits behind a `OnceLock` where one hang would wedge every later
  reader.
- **A voice is a bounded identifier** (`core::speech::is_voice_name`: up to 64
  ASCII letters/digits/`_`/`-`, starting with a letter or digit) — one
  `Command::arg` after `-v`, so a value can never be read as an option or
  reach a shell. The save path refuses anything else (`422`), and the *read*
  path drops it: a hand-edited `"--output /tmp/x"` speaks in the default voice
  rather than reaching the argv. A config file that cannot be *read* is not a
  fallback at all — the speak route answers **503 `unavailable`**, the same
  answer the editor gets, rather than guessing at a setting it couldn't read.
  The Settings page still shows the raw stored value, the same split the
  watcher clamp draws — the editor must be able to see and fix what the file
  says.
- **Read on every press**, like `commands` on every spawn: change the voice
  and the next play uses it, no restart. A malformed config file is
  `unavailable` on the speak route too (503) rather than a guessed default.

### Routes

- `GET /api/config/speech` → `ConfigSpeech`: `{voice, voices}`, `voice` being
  the override (`null` when unset) and `voices` what the installed binary
  offers (`[]` when mesa couldn't ask — **not** an error, since the setting
  must stay visible on a machine where the synthesiser isn't installed yet).
  Gated like the other config getters (`require_agent_access`); a malformed
  config is **502 `unavailable`**.
- `PUT /api/config/speech`, body `{"voice": "<name>" | null}` → echoes the
  getter. `null` **and** blank both remove the key, restoring the binary's own
  voice. A name that isn't a voice — or, when mesa has a list, isn't on it —
  is **422 `validation`**, writing nothing. Gated with
  `require_agent_access`, the same posture as every other config write (mesa
  task 1021).

There is deliberately **no Settings page UI** for this section — there never
was one, and task 1054 did not add one. The routes exist so a future editor
has something to talk to, and so the gate can drive the validation.
- `GET /api/config/speech/preview?voice=<name>` → `audio/wav`, streamed, no
  `Content-Length`: the **test** button beside the picker (mesa task 824),
  which is how a voice is heard *before* it is saved. Two things make it a
  preview rather than a second way to play the stored setting: the voice comes
  off the **query string**, and the config file is neither read nor written.
  The spoken text is a mesa constant (`core::speech::SAMPLE`), so the voice is
  the only caller-supplied value on the path — and it must pass the same shape
  rule (`422 validation` otherwise, before anything is spawned). A blank or
  absent voice adds no `-v`, so the dropdown's *default* entry is auditionable
  too. Unlike a save, membership in the offered list is **not** required: a
  voice this binary rejects is the synthesiser's answer to give, and hearing
  that failure (**503 `unavailable`**) is a legitimate result of pressing test.
  Gated exactly like `/api/inbox/{id}/speak` — `require_agent_access` plus the
  `Origin`-independent half a no-cors `<audio src>` needs — since it is the
  same synthesis.

## Live

A fifth, independent section holds settings for the live conversation
(`docs/live.md`). It used to carry two keys — the **prompt** its agent is
spawned with (mesa task 867) and the **wait** before a settled capture-box
draft is sent (mesa task 886, until mesa task 977 narrowed it to the
microphone's held recording alone — a typed line is now sent by Enter) — but
as of mesa task 919 the prompt moved out to the **library**
(`docs/library.md`): it is now the `mesa-live` agent definition (mesa task 1068
made it an agent rather than a prompt), forked like any other library row when
someone edits it, and edited on `#/library` rather than in this file. This section holds the one key that is left.

```json
{
  "live": {
    "auto-send-ms": 2000
  }
}
```

**A `live.prompt` key left behind by an older mesa, or hand-edited into the
file, is silently ignored** — never an error, and never read from — since
`LiveSection` simply has no field for it any more. Everything the prompt used
to be is unchanged in spirit, it has just moved: a configured prompt still
**replaces** the built-in rather than extending it (forking a built-in starts
from its text, the same "start from the built-in" idea the old editor offered
as a button), mesa still appends only the session line —
`You are driving mesa live session <id>.` — and the text is still never
parsed by a shell, reaching the agent as one `Command::arg` or as
`$MESA_PROMPT` in [script mode](#script-mode). Rewriting it is how a live
conversation changes character, but the loop it describes is what makes the
feature work at all — a prompt that never mentions `mesa live listen` produces
an agent that hears nothing. `docs/live.md` is the contract the text has to
keep; `docs/library.md` covers the fork/restore mechanics and
`core::live::agent_prompt`'s resolution (fork, else the built-in, falling back
to the built-in on any store error so a database hiccup never stops a
conversation starting).

`auto-send-ms` is this section's key:

- **How long the person may fall silent before the page sends the microphone's
  held recording as a `user` turn** (mesa task 977 narrowed this key to the
  recording alone — a typed line is sent by Enter, since the capture box is a
  deliberate keystroke away). Dictation never presses Enter, so that pause is
  what ends a spoken sentence; how long a pause means "finished" is the
  person's own cadence, which is why it is a setting rather than a constant.
- **Absent or `null` ⇒ `core::config::DEFAULT_LIVE_AUTO_SEND_MS` (2000)**, the
  value hardcoded in `liveCapture.ts` before the key existed, so an
  unconfigured install waits exactly as long as it always did.
- **A whole number of milliseconds, 250..=60000** (`MIN_LIVE_AUTO_SEND_MS` /
  `MAX_LIVE_AUTO_SEND_MS`) — sanity bounds, not policy: below the gap between
  two spoken words mesa would post half a sentence, and a minute of silence is
  a conversation that has stopped. Outside them, or the wrong shape (a string,
  a fraction), is **422 `validation`** writing nothing.
- **A hand-edited value outside the bounds is not rejected on read.**
  `ConfigLive.auto_send_ms` reports the file verbatim, so the editor shows what
  the file actually says; the **page** clamps it
  (`frontend/src/liveCapture.ts::autoSendIdleMs`), so a hand-written `0` waits
  the minimum instead of posting a word at a time.
- **Read once per conversation the page joins** — a `useEffect` in `LiveHub`
  on going live, not on mount, since the hub is mounted for the life of the
  app — so an edit lands on the next conversation with no restart. If the read
  fails, the built-in wait applies: a settings file must never be what stalls
  a conversation.
- **It governs the microphone's held recording only** (mesa task 977 — a typed
  line is sent by Enter, since the capture box is a deliberate keystroke
  away). While the browser is listening, the recording flushes on
  whichever comes first: this silence boundary (`shouldFlushSilence`) or the
  listen switch.

### Routes

- `GET /api/config/live` → `ConfigLive`: `{auto_send_ms, auto_send_ms_default}`
  — the override (`null` when unset) beside the value mesa ships, sent by the
  server so the editor can show what blank means without a second copy of it
  in TypeScript. `prompt`/`default_prompt` are gone from this route entirely
  (mesa task 919) — not null, absent, since the prompt is a library item now
  (`GET /api/library`, `docs/library.md`). Gated like the other config
  getters (`require_agent_access`); a malformed config is **502
  `unavailable`**.
- `PUT /api/config/live`, body `{"auto_send_ms": <ms> | null}` → echoes the
  getter. Absent leaves the setting alone, `null` removes it, restoring the
  built-in. A wait outside 250..=60000, or the wrong shape, is **422
  `validation`**, writing nothing. (`save_live` takes a raw JSON value, like
  `save_watchers`, so a bad value is named in a sentence rather than rejected
  by the deserializer as a 400.) `prompt` is no longer a key this route
  accepts — naming it is the same "unknown live setting" mistake naming
  `voice` here always was, not a special case. Gated with
  `require_agent_access`, the same posture as every other config write (mesa
  task 1021).

## Listen

A sixth, independent section names the **model** `live transcribe` runs the
external `auris` speech-to-text binary with (mesa task 955) — the input-side
mirror of Speech, above.

```json
{
  "listen": {
    "model": "parakeet-tdt-0.6b-v2-int8"
  }
}
```

- **Absent or blank ⇒ no `-m` at all.** mesa names no default model of its
  own: with nothing configured the argv is byte-for-byte the one it ran
  before this key existed, and which model that means is `auris`'s business.
  There is deliberately **no `language` key** — `auris` has no `--language`
  flag, so one would drive no argv — and vocabulary is **not** a config key
  either: it is derived per request, not stored here.
- **The list of models comes from the binary**, not from mesa:
  `auris --no-download --list-models`, filtered to bounded identifiers and
  cached for the life of the process (`core::listen::models`). An **empty
  list means mesa could not ask** — no binary, or an answer that wasn't a
  list of names — never "there are no models", so the editor falls back to a
  plain text box and the save-time membership check is skipped. The cache is
  per process, so installing `auris` (or a model that adds one) while `mesa
  serve` is already running needs a **Restart server** before the picker sees
  it. `--list-models` runs with `--no-download`: listing names must never
  turn into a model fetch.
- **A model is a bounded identifier** (`core::listen::is_model_name`: up to
  64 ASCII letters/digits/`_`/`-`/`.`, starting with a letter or digit — the
  one deliberate difference from a voice's shape rule, since `auris`'s only
  model today, `parakeet-tdt-0.6b-v2-int8`, contains a `.`) — passed as two
  `Command::arg`s after `-m`, so a value can never be read as an option or
  reach a shell. The save path refuses anything else (`422`), and the *read*
  path drops it: a hand-edited `"--output /tmp/x"` transcribes with the
  default model rather than reaching the argv. A config file that cannot be
  *read* is not a fallback at all — `live transcribe` answers **503
  `unavailable`**, the same answer the editor gets, rather than guessing at a
  setting it couldn't read. The Settings page still shows the raw stored
  value, the same split the watcher clamp draws.
- **Read on every request**, like `commands` on every spawn: change the model
  and the next transcription uses it, no restart. A malformed config file is
  `unavailable` on the transcribe route too (503) rather than a guessed
  default.

### Routes

- `GET /api/config/listen` → `ConfigListen`: `{model, models}`, `model` being
  the override (`null` when unset) and `models` what the installed binary
  offers (`[]` when mesa couldn't ask — **not** an error, since the setting
  must stay visible on a machine where `auris` isn't installed yet). Gated
  like the other config getters (`require_agent_access`); a malformed config
  is **502 `unavailable`**.
- `PUT /api/config/listen`, body `{"model": "<name>" | null}` → echoes the
  getter. `null` **and** blank both remove the key, restoring the binary's own
  model. A name that isn't a model — or, when mesa has a list, isn't on it —
  is **422 `validation`**, writing nothing. Gated with
  `require_agent_access`, the same posture as every other config write (mesa
  task 1021).

## Guard

A seventh, independent section holds the **cost-guard** settings — the numbers
`serve --watch-cost` and `mesa cc guard` compare a running Claude Code session
against, and what the watcher does about a session that crosses one (mesa tasks
1018 and 1054, `docs/cost-guard.md`).

```json
{
  "guard": {
    "cost-usd": 25.0,
    "total-tokens": 100000000,
    "cache-read-share": 0.98,
    "cache-read-min-tokens": 20000000,
    "repeat-count": 30,
    "action": "stop"
  }
}
```

- `cost-usd` — estimated dollars inside the guard's hour-wide window at which
  a session is reported. **Absent or `null` ⇒ the built-in 25.** The editor
  requires a number greater than 0 and at most 100000; the upper bound is a
  sanity cap against a typo that would silently switch the rule off, not a
  policy.
- `total-tokens` — tokens in the same window at which a session is reported
  regardless of cost, since a cheap model can burn enormous volume for very
  little money. **Absent or `null` ⇒ 100000000.** A whole number ≥ 1.
- `cache-read-share` — the share of a session's tokens that must be cache
  **reads** for the spin-loop rule to fire. **Absent or `null` ⇒ 0.98.**
  Between 0.5 and 1: below half, "mostly cache reads" stops describing a loop
  and starts describing a healthy long session.
- `cache-read-min-tokens` — the token floor the spin-loop rule needs before it
  fires at all. **Absent or `null` ⇒ 20000000.** A whole number ≥ 1. A session
  three messages long is trivially 100% cache-read and perfectly healthy; this
  is what separates it from an agent re-reading its context forever.
- `repeat-count` — how many times in a row a session may run the **same**
  trivial `Bash` command before it is reported. **Absent or `null` ⇒ 30.** A
  whole number between 1 and 100000; the upper bound is the `cost-usd` sanity
  cap, not a policy. "Trivial" means the command's output was under 16 bytes,
  which is what separates a wedged `echo idle` loop from an agent legitimately
  re-running something that produces work.
- `action` — what the watcher **does** about a breach. **Absent or `null` ⇒
  `"stop"`.** Exactly one of two lowercase strings:
  - `"stop"` — run `claude stop <job id>` on the session, then file the alert
    saying so. The conversation survives; `claude attach <job id>` resumes it.
  - `"report"` — file the alert and nothing else, the behaviour before task
    1054.

  Anything else is refused by the editor, and in a hand-edited file falls back
  to the built-in like an out-of-range number.
- **Read at the top of every tick, not cached** — the `watchers` rule: edit
  the file (or Settings) and the very next tick uses it, no restart. A config
  file that cannot be *parsed* skips the tick and logs, rather than guarding
  against guessed numbers.
- A hand-edited value of the right type but outside its bound (found in the
  file, not written through `PUT`) falls back to the built-in **for that key
  alone** on read, the same clamp posture `todo-concurrency` takes — a stray
  `0` must not switch the guard off silently. Only the write path is strict,
  and the Settings page still shows the raw stored value.

### Routes

- `GET /api/config/guard` → `ConfigGuard`: each of the six keys **verbatim**
  (`null` when unset) beside its built-in (`cost_usd_default`,
  `total_tokens_default`, `cache_read_share_default`,
  `cache_read_min_tokens_default`, `repeat_count_default`, `action_default`). Gated like the other config getters
  (`require_agent_access`); a malformed config is **502 `unavailable`**.
- `PUT /api/config/guard`, body `{"cost_usd": <n> | null, "total_tokens": …,
  "cache_read_share": …, "cache_read_min_tokens": …, "repeat_count": …,
  "action": "stop" | "report" | null}` → echoes the getter.
  Absent leaves a key alone; `null` removes it, restoring the built-in. Any
  out-of-range or wrong-typed value is **422 `validation`**, writing nothing —
  the whole update is checked before the file is touched. Gated with
  `require_agent_access`, the same posture as every other config write (mesa
  task 1021).

## Gate

`scripts/config-check.sh` — all three commands driven by a configured template
(placeholders, quoting, the drop rule), the built-in argv proven unused while
they are set and byte-for-byte unchanged when they aren't, the `id: null`
no-receipt path, hot reload with no restart, and the malformed /
unsupported-placeholder failures — plus `GET`/`PUT /api/config`: the round
trip, the blank-clears-the-key rule, untouched keys and unknown sections
preserved, a just-saved template driving the very next spawn, and the 422/502
refusals leaving the file byte-identical — and, for script mode, a script
driving each of the three actions, the per-action variables present/absent, the
unset-not-empty rule, a hostile `{name}` proven not to reach a shell, and the
422s for `{}`-in-a-script and a bash syntax error. It writes a real
`~/.mesa/config.json` under a throwaway `HOME` rather than using
`MESA_CONFIG_FILE`, so the default path resolution is covered too. For
watchers it also covers the round trip (`GET` reporting the default with a
`null` override, `PUT` setting/clearing `todo_concurrency`), 0 and a
non-integer rejected as 422 writing nothing, 502 on a malformed file, and
`commands`/`pricing`/an unknown section surviving a watchers write and vice
versa.

For speech it covers the round trip against a stub synthesiser (`GET`
reporting `voice: null` and offering exactly the names the stub's
`--list-voices` printed, non-name lines filtered out), the saved voice
reaching the synthesiser's argv as `-v <voice>` on the very next press, `null`
**and** `""` both removing the key, the unconfigured argv proven to carry no
`-v` at all, a voice that isn't a bounded identifier and a well-shaped one the
binary never offered both 422 writing nothing, 502 on a malformed file, each
of the other four savers preserving `speech` and vice versa, and both verbs
refused to a request that isn't from this machine's own page. The **preview**
route is `scripts/api-check.sh`'s, beside the speak route whose contract and
gate it shares (5c): mesa's own sentence on stdin, the query's voice as one
argv after `-v`, no `-v` for a blank one, and an option-shaped name refused
before anything is spawned. Its "reads no config" half is here instead, where a
voice is actually configured: with `bm_george` saved, a preview of `af_bella`
still speaks `af_bella` and a blank one still adds no `-v` — and a preview
works even under the malformed file every other config verb answers 502 to.

For live it covers `auto-send-ms`, the section's one remaining key: `GET`
reporting `null` beside the built-in 2000 and no longer mentioning `prompt` or
`default_prompt` at all, a saved wait written as a JSON number (a quoted one
would read back as nothing) and echoed, `null` removing the key, 0 / -1 / 2.5 /
60001 / `"2000"` each 422 `validation` writing nothing, `prompt` and `voice`
both rejected as an unknown live setting, 502 on a malformed file, each of the
other savers preserving `live` and vice versa, both verbs refused to a request
that isn't from this machine's own page, and the migration case: a
`live.prompt` key left behind by an older mesa survives a `GET` unread and a
`PUT` of `auto-send-ms` untouched. "A configured prompt reaches the spawn,
replacing the built-in" moved with the prompt itself (mesa task 919) — it is
now `scripts/library-check.sh`'s assertion, proved through a forked library
row instead of a config key.

For guard the coverage lives in its own gate, `scripts/cost-guard-check.sh`
(`docs/cost-guard.md`), since the thresholds are only meaningful against a live
session: `GET` reporting all-null values beside the four built-ins, a saved
threshold governing the very next verdict with no restart, `null` restoring the
built-in, every out-of-range and wrong-typed value 422 writing nothing, an
unknown body key ignored, and **all six** other sections surviving the guard
section's save.

For pricing it also covers the round trip: `GET` showing the built-ins with
null values, an override and a wholly new prefix landing, `PUT null` restoring
one and deleting the other, each section surviving the other's write, a
negative rate and a whitespace-bearing prefix as 422, both verbs 502 on a
malformed file, and a request that isn't from this machine's own page refused
without touching the file.
