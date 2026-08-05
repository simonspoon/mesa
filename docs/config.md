# Config (`~/.mesa/config.json`)

mesa starts a coding agent from exactly four places. Each one's command line
is a **template** in `~/.mesa/config.json`, so the program, its flags, the
persona and the slash command can all change without rebuilding mesa:

| Key | Used by | Built-in default |
| --- | --- | --- |
| `todo-watcher` | `serve --watch-todo` dispatch (`docs/todo-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}"` |
| `refine-watcher` | `serve --watch-refine` refinement pass (`docs/refine-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "First use \`mesa\` to get the task info from id {id}. …"` |
| `inbox-watcher` | `serve --watch-inbox` triage (`docs/inbox-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}"` |
| `agent-spawn` | `POST /api/projects/{id}/agents`, the Agents sidebar's **add agent** (`docs/agents.md`) | `{bin} --bg --agent {agent} -- {prompt}` |

```json
{
  "commands": {
    "todo-watcher":   "claude --bg --agent swe --name {name} -- \"/execute-mesa-task {id}\"",
    "refine-watcher": "claude --bg --agent planner --name {name} -- \"/refine-mesa-task {id}\"",
    "inbox-watcher":  "codex exec --cd . \"triage mesa inbox item {id}\"",
    "agent-spawn":    "claude --bg -- {prompt}"
  }
}
```

Everything lives in `src/core/config.rs`; `MESA_CONFIG_FILE` overrides the path
for tests (mirroring `MESA_DB`/`MESA_HOOKS_FILE`). `~/.mesa` may be the JSON
file itself instead of a directory — both are accepted, since "a config in
`~/.mesa`" reads either way and a user who wrote one file shouldn't get a
silent no-op.

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
  (backslash-escapable). **The prompt in all three watcher defaults is quoted
  for exactly this reason** — `-- "/execute-mesa-task {id}"` is one argument;
  unquoted, it would be two and the id would be lost. The refine-watcher's
  default is a whole *sentence* of prompt inside those quotes; it is one argv
  entry for the same reason, and nothing about it is re-split after `{id}` is
  substituted.
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
| `{bin}` | all four | `MESA_CLAUDE_BIN`, else `claude` |
| `{agent}` | all four | `MESA_CLAUDE_AGENT`, else `swe`; unavailable when set empty |
| `{id}` | watchers | the task id / inbox item id |
| `{name}` | watchers | the session name mesa derives — `<project>: <task name>` (todo- and refine-watcher), or `inbox <id>: <first body line>` (**untrusted text**) |
| `{prompt}` | `agent-spawn` | the POST body's `prompt`; unavailable when omitted |

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
| `{bin}` | `MESA_BIN` | all four |
| `{agent}` | `MESA_AGENT` | all four |
| `{id}` | `MESA_ID` | watchers |
| `{name}` | `MESA_NAME` | watchers |
| `{prompt}` | `MESA_PROMPT` | `agent-spawn` |

Two rules mirror the argv ones:

- **A variable this command doesn't offer is not set** — a watcher script never
  sees `MESA_PROMPT`, an `agent-spawn` script never sees `MESA_ID`/`MESA_NAME`.
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
task to `todo`; the refine- and inbox-watchers drop the id from their
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
argv that will actually run spelled out beneath.

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
- The write is **loopback-only in both serve modes** — one notch stronger than
  the agent routes, which `--lan` does open to LAN peers. Rewriting these
  templates chooses the *program* mesa will execute on the next dispatch, so it
  gets the `local_path` rule (`require_local_path_write`), not the agent one.
  The read sits in the agents' class (`require_agent_access`).

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

The two sections are siblings over one document: saving `pricing` preserves
`commands` (and any section mesa doesn't know) and vice versa. Nothing is
cached — the table is loaded **once per dashboard request** and a save applies
to the next read, past sessions included, with no restart. Cost is derived on
every read, so there is no stored figure to migrate.

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
  `require_local_path_write` — **loopback-only in both serve modes**, exactly
  like `PUT /api/config`: it is the same file, and which file a LAN peer may
  rewrite is not a per-section question.

`/api/config`'s own shape is unchanged — a bare `ConfigCommand[]` and
`{commands: {…}}` — because that is what agents and `config-check.sh` assert.

## Gate

`scripts/config-check.sh` — all four commands driven by a configured template
(placeholders, quoting, the drop rule), the built-in argv proven unused while
they are set and byte-for-byte unchanged when they aren't, the `id: null`
no-receipt path, hot reload with no restart, and the malformed /
unsupported-placeholder failures — plus `GET`/`PUT /api/config`: the round
trip, the blank-clears-the-key rule, untouched keys and unknown sections
preserved, a just-saved template driving the very next spawn, and the 422/502
refusals leaving the file byte-identical — and, for script mode, a script
driving each of the four actions, the per-action variables present/absent, the
unset-not-empty rule, a hostile `{name}` proven not to reach a shell, and the
422s for `{}`-in-a-script and a bash syntax error. It writes a real
`~/.mesa/config.json` under a throwaway `HOME` rather than using
`MESA_CONFIG_FILE`, so the default path resolution is covered too.

For pricing it also covers the round trip: `GET` showing the built-ins with
null values, an override and a wholly new prefix landing, `PUT null` restoring
one and deleting the other, each section surviving the other's write, a
negative rate and a whitespace-bearing prefix as 422, both verbs 502 on a
malformed file, and a request that isn't from this machine's own page refused
without touching the file.
