# Config (`~/.mesa/config.json`)

mesa starts a coding agent from exactly three places. Each one's command line
is a **template** in `~/.mesa/config.json`, so the program, its flags, the
persona and the slash command can all change without rebuilding mesa:

| Key | Used by | Built-in default |
| --- | --- | --- |
| `todo-watcher` | `serve --watch-todo` dispatch (`docs/todo-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "/execute-mesa-task {id}"` |
| `inbox-watcher` | `serve --watch-inbox` triage (`docs/inbox-watcher.md`) | `{bin} --bg --agent {agent} --name {name} -- "/inbox-triage {id}"` |
| `agent-spawn` | `POST /api/projects/{id}/agents`, the Agents sidebar's **add agent** (`docs/agents.md`) | `{bin} --bg --agent {agent} -- {prompt}` |

```json
{
  "commands": {
    "todo-watcher":  "claude --bg --agent swe --name {name} -- \"/execute-mesa-task {id}\"",
    "inbox-watcher": "codex exec --cd . \"triage mesa inbox item {id}\"",
    "agent-spawn":   "claude --bg -- {prompt}"
  }
}
```

Everything lives in `src/core/config.rs`; `MESA_CONFIG_FILE` overrides the path
for tests (mirroring `MESA_DB`/`MESA_HOOKS_FILE`). `~/.mesa` may be the JSON
file itself instead of a directory — both are accepted, since "a config in
`~/.mesa`" reads either way and a user who wrote one file shouldn't get a
silent no-op.

## Argv, not a shell

A template is **tokenized and executed directly** — there is no `sh -c`
anywhere on this path, unlike `hooks.json` (`docs/hooks.md`), which genuinely
is a shell string.

That is load-bearing. Both watchers pass untrusted free text as the session
name: a task's derived name, or an inbox item's first line. What makes that
safe is that the text arrives as one `Command::arg`. So substitution happens **after**
tokenization: the argv length is fixed by the template alone, and no value can
split into extra arguments or be re-read as a flag. A name of
`"; rm -rf / #` is just a long, silly session name.

The consequences of having no shell:

- `|`, `>`, `&&`, `$VAR`, `~` are ordinary characters. No pipes, no
  redirection, no environment expansion, no globbing. Write absolute paths.
- Quote an argument that contains spaces: `'…'` (literal) or `"…"`
  (backslash-escapable). **The prompt in the two watcher defaults is quoted for
  exactly this reason** — `-- "/execute-mesa-task {id}"` is one argument;
  unquoted, it would be two and the id would be lost.
- An unterminated quote or a trailing backslash is an error, not a
  silently-mangled argv.
- Need a shell? Name one: `sh -c "…"` as the template. That is your choice to
  make explicitly, and then the quoting of untrusted values is yours to get
  right.

## Placeholders

`{}`-delimited, substituted per token. Which ones a command may use depends on
what that spawn actually knows about:

| Placeholder | Where | Value |
| --- | --- | --- |
| `{bin}` | all three | `MESA_CLAUDE_BIN`, else `claude` |
| `{agent}` | all three | `MESA_CLAUDE_AGENT`, else `swe`; unavailable when set empty |
| `{id}` | watchers | the task id / inbox item id |
| `{name}` | watchers | the session name mesa derives — `<project>: <task name>`, or `inbox <id>: <first body line>` (**untrusted text**) |
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
task to `todo`, the inbox-watcher un-claims the item so a later tick retries).

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
  key). Validation runs over the whole batch before anything is written, so a
  rejected save leaves the file byte-identical.

Behind it, `GET /api/config` and `PUT /api/config` (`core::config::settings` /
`save_commands`):

- `GET` returns one row per action — `{action, value, default, placeholders}`,
  where `value` is `null` when the action is falling back. A file that exists
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

## Gate

`scripts/config-check.sh` — all three commands driven by a configured template
(placeholders, quoting, the drop rule), the built-in argv proven unused while
they are set and byte-for-byte unchanged when they aren't, the `id: null`
no-receipt path, hot reload with no restart, and the malformed /
unsupported-placeholder failures — plus `GET`/`PUT /api/config`: the round
trip, the blank-clears-the-key rule, untouched keys and unknown sections
preserved, a just-saved template driving the very next spawn, and the 422/502
refusals leaving the file byte-identical. It writes a real
`~/.mesa/config.json` under a throwaway `HOME` rather than using
`MESA_CONFIG_FILE`, so the default path resolution is covered too.
