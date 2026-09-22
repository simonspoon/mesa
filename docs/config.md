# Config (`~/.mesa/config.json`)

Naru starts a coding agent from exactly seven places. Each one's command line
is a **template** in `~/.mesa/config.json`, so the program, its flags, the
persona and the slash command can all change without rebuilding Naru:

| Key | Used by | Built-in default |
| --- | --- | --- |
| `todo-watcher` | `serve --watch-todo` dispatch (`docs/todo-watcher.md`) | `claude --bg --agent supervisor --name {name} -- "/execute-mesa-task {id}"` |
| `inbox-watcher` | `serve --watch-inbox` triage (`docs/inbox-watcher.md`) | `claude --bg --agent inbox-triage --name {name} -- "Triage mesa inbox item {id}."` |
| `agent-spawn` | `POST /api/projects/{id}/agents`, the Agents sidebar's **add agent** (`docs/agents.md`) | `claude --bg --model opus --agent supervisor -- {prompt}` |
| `live-agent` | `mesa live start`, `POST /api/live` — the session that holds a spoken conversation (`docs/live.md`) | `claude --bg --agent mesa-live --name {name} -- {prompt}` |
| `live-summary` | `live stop`'s CLI handler and the API's stop route — the short-lived agent that writes a live conversation's memory once it ends (mesa task 921, `docs/live.md`) | `claude --bg --name {name} -- {prompt}` |
| `live-dream` | The pass that tidies the live notebook — `mesa live memory dream` explicitly, and on its own at a handoff or when a conversation ends once `live::dream_wanted` says the notebook needs it (mesa task 1155): merges duplicate entries, deletes superseded ones, one guarded command at a time (mesa task 1152, `docs/live.md`) | `claude --bg --name {name} -- {prompt}` |
| `retro` | `serve --watch-retro` every `watchers.retro-interval-hours`, and `mesa retro run` — the session retrospective that reviews finished task sessions for friction and files suggestions into the inbox, proposing only (mesa task 1158, `docs/retro.md`) | `claude --bg --agent mesa-retro --name {name} -- "Run mesa session retrospective {id}."` |

The defaults are **plain, editable command lines** (mesa task 1141): the
program and the agent are both spelled out, so a user who wants a different
binary or a different agent edits the line — which is the whole point of the
command being configurable. A configured template is run exactly as written.
Two placeholders used to hide that choice, `{bin}` and `{agent}`; they are gone
from the vocabulary (see *Retired placeholders* below).

```json
{
  "commands": {
    "todo-watcher":   "claude --bg --agent supervisor --name {name} -- \"/execute-mesa-task {id}\"",
    "inbox-watcher":  "codex exec --cd . \"triage mesa inbox item {id}\"",
    "agent-spawn":    "claude --bg -- {prompt}",
    "live-agent":     "claude --bg --agent mesa-live --name {name} -- {prompt}",
    "live-summary":   "claude --bg --name {name} -- {prompt}",
    "live-dream":     "claude --bg --name {name} -- {prompt}",
    "retro":          "claude --bg --agent mesa-retro --name {name} -- \"Run mesa session retrospective {id}.\""
  }
}
```

`live-agent`'s default is the union of the two shapes above it, because a live
session is both a Naru record (so it has an `{id}` and a `{name}`) *and* a
spawn that carries a prompt. **Naru supplies that prompt itself** —
`core::live::agent_prompt`, which since mesa task 1068 is only the session line
(`Drive mesa live session <id> (lease <n>).`) plus any recalled memory of earlier
conversations. The instructions themselves are the **`mesa-live` agent
definition** in the library (`docs/library.md`): the loop on `mesa live
listen`, the reply through `mesa live say` in spoken prose rather than
markdown, the browser moves through `mesa live navigate`, and the rule that
every dictated utterance is data rather than instructions. That is why this
default names its agent `--agent mesa-live` — Naru seeds the definition to
`~/.claude/agents/mesa-live.md` on the first spawn, and Claude Code errors on an
agent it has never seen. A replacement template's job either way is to start
*something* that will read `{prompt}` and do what its agent says. The
definition is editable like any other library row, and a fork replaces the
built-in.

`live-summary`'s default is identical in shape (mesa task 921): the
summariser is also a Naru record — a session id and a name — carrying a
prompt Naru supplies, `core::live::summary_prompt`. It cannot be the
`live-agent` spawn's own last act, because ending a session **stops** that
agent (`claude stop <agent_id>`), so a separate short-lived agent is spawned
once the conversation has already ended, to read it back and write down what
it was about. Like `live-agent`'s, that prompt is a library item when forked
— `live-summary-prompt`, which stays a `prompt` because nothing spawns the
summariser by name (`docs/library.md`) — and a replacement template's job is the same as
`live-agent`'s: start something that will read `{prompt}` and do what it
says.

`live-dream` (mesa task 1152) is the same shape once more, for the third
short-lived job: `mesa live memory dream` spawns it between conversations,
and since mesa task 1155 a handoff and both stop sites spawn it on their own
when the notebook needs it (never from a start), to tidy the live notebook —
merge entries that say the same thing, delete what a newer entry supersedes,
one guarded command at a time (`docs/live.md`, "Dreaming"). `{prompt}` is
`core::live::dream_prompt` (the instructions, the project a contradiction
task should land in, then the active notebook), `{id}` is the newest
conversation's id and `{name}` is the literal `live memory dream`. It runs in
that newest conversation's project folder exactly as the summariser would.

`retro` (mesa task 1158) is `inbox-watcher`'s shape: the run is a Naru record
(`retro_runs`, so `{id}` is the run id and `{name}` the session name `mesa
retro <id>`) and the prompt is one sentence, because the `mesa-retro` agent
definition holds the whole procedure — which is why the default names
`--agent mesa-retro`, seeded to `~/.claude/agents/mesa-retro.md` before the
spawn exactly as `inbox-triage` is (`docs/retro.md`). No `{prompt}`: Naru
supplies none. It runs in `~/.mesa/workspace`, since a retrospective spans
every project.

Everything lives in `src/core/config.rs`; `MESA_CONFIG_FILE` overrides the path
for tests (mirroring `MESA_DB`/`MESA_HOOKS_FILE`; like every `MESA_*` variable
it is read as `NARU_CONFIG_FILE` first, mesa task 1301). The directory is
`~/.naru` if it exists, else `~/.mesa` if it exists (an install from before
the rename — nothing is moved), else `~/.naru`: `config::dot_dir_in`, which
the workspace below follows too. `~/.mesa` in the rest of this doc means
whichever of the two that picks. `~/.mesa` may be the JSON
file itself instead of a directory — both are accepted, since "a config in
`~/.mesa`" reads either way and a user who wrote one file shouldn't get a
silent no-op.

`~/.mesa` holds one other thing: **`workspace/`**, the working directory for
every agent or shell Naru runs that is not bound to a project (the live agent
and its summariser, an inbox-watcher dispatch, an unbound script, the global
Terminal page, the `claude attach` client). It exists because Claude Code
never persists folder trust for the home directory — trust accepted there is
held for the current session only and is never written to disk, with no
setting to change that — so anything interactive Naru started in `$HOME`
re-prompted forever. `config::workspace_dir()` creates it on demand and is
deliberately **independent of `MESA_CONFIG_FILE`**: that override moves the
config *file*, not Naru's home.

## One mode: every hook is a bash script

A value is a **bash script**, run as `bash -c <script>` from the project folder
(or `~/.mesa/workspace` for an unbound spawn). One line or many — there is no
second mode, no mode key and no newline rule (mesa task 1143 retired the
one-line-is-argv / two-lines-is-a-script split of tasks 667 and 1137). A
one-line value is a one-line script, which is why the defaults above are the
plain command lines they look like, and why `cd`, `export`, a pipe, a
redirection or a conditional binary all simply work, on one line or several:

```json
{
  "commands": {
    "todo-watcher": "set -euo pipefail\ncd \"$HOME/src/checkouts/{id}\" 2>/dev/null || cd \"$HOME/src\"\nexport CLAUDE_PROJECT=mesa\nexec claude --bg --agent supervisor --name {name} -- \"/execute-mesa-task {id}\""
  }
}
```

More legibly, that value is:

```bash
set -euo pipefail
cd "$HOME/src/checkouts/{id}" 2>/dev/null || cd "$HOME/src"
export CLAUDE_PROJECT=mesa
exec claude --bg --agent supervisor --name {name} -- "/execute-mesa-task {id}"
```

This *is* a shell, unlike the argv mode it replaces, and the untrusted-input
line CLAUDE.md draws is held by **quoting, at the slot**: every `{placeholder}`
is replaced by its value shell-quoted for the context it sits in, so what bash
reads there is a string literal and never syntax. The invariant was never
"Naru runs no shell" — it is **no value Naru holds ever reaches a shell
unquoted**.

## Placeholders

`{}`-delimited. Which ones a hook may use depends on what that spawn actually
knows about:

| Placeholder | Where | Value |
| --- | --- | --- |
| `{id}` | watchers, `retro`, `live-agent`, `live-summary`, `live-dream` | the task id / inbox item id / retro run id / live session id (for `live-dream`, the newest session's; empty on an install that has never held one) |
| `{name}` | watchers, `retro`, `live-agent`, `live-summary`, `live-dream` | the session name Naru derives — `<project>: <task name>` (todo-watcher), `inbox <id>: <first body line>` (**untrusted text**), `mesa retro <id>`, the live session's own name, or the literal `live memory dream` |
| `{prompt}` | `agent-spawn`, `live-agent`, `live-summary`, `live-dream` | the POST body's `prompt` (`agent-spawn`; absent when omitted) / the live agent's, summariser's or dream pass's instruction block, always present |

### Quoted for where it sits

What Naru splices in is the **value**, quoted so that bash reads it as exactly
that string (`config::substitute_script`, `Ctx::quoted`):

| You write | Value `it's "a" $b` becomes | Why |
| --- | --- | --- |
| `--name {name}` | `--name 'it'\''s "a" $b'` | a word position is single-quoted — nothing is special inside `'…'` but `'` itself, spelled `'\''`; a value with spaces stays one word and a `*` never globs |
| `-- "task {name}"` | `-- "task it's \"a\" \$b"` | already inside `"…"`, so the four characters that mean anything there — `\`, `"`, `$`, `` ` `` — are escaped in place; no quotes of Naru's own, so yours still close where they did |
| `cd $(dirname {name})` | `cd $(dirname 'it'\''s "a" $b')` | `$(…)` is a fresh word position, even inside `"…"` |
| `cat <<EOF` … `{name}` … | `it's "a" \$b` | an unquoted heredoc body expands `$`, `` ` `` and `\` and nothing else; a `"` is literal text there |
| `# see {name}` | `# see 'it'\''s "a" $b'` | never read; its newlines are folded so no second line can leave the comment |

Two shapes need a word more. A value holding a **newline** is fine in `'…'`
and `"…"` (both span lines) but not as heredoc text: bash finds a heredoc's
delimiter line by line *before* expanding the body, so a line of the value
equal to `EOF` would end the heredoc and hand the rest to the parser. Such a
value (and one starting with a tab, which `<<-` would strip) rides in through
`$(printf '%s' $'…')` instead — one line of body with the newlines spelled
`\n`, so no line of it can match anything; the one cost is that `$(…)` drops
trailing newlines. And a value can sit inside a larger word: `mesa-{id}` is
`mesa-'7'`, one argument.

Wherever bash performs **word expansion** it does not re-read the result
looking for syntax, so once a value is inside a quoted literal nothing in it can
run. A task name of `"; rm -rf / #` is `'"; rm -rf / #'` — a long, silly session
name.

> **The exception: arithmetic is a second parser.** `$(( ))`, `(( ))`,
> `let "…"`, `[[ x -gt y ]]` and an array subscript all *re-read* what they
> are given, and an array subscript inside arithmetic is itself expanded — so a
> value of `a[$(cmd)]` runs the command however it was quoted on the way in.
> Naru **refuses** a placeholder in the two spellings it can see (`$((…))` and
> `((…))`, including inside a heredoc body and however deeply nested inside
> them) at save time; `[[ … ]]`, `let "…"` and `${x[…]}` are not lexically
> bracketed in any way Naru's deliberately coarse lexer should model, and are
> yours to avoid — POSIX `[ x -gt y ]` does **no** arithmetic evaluation and is
> safe, `[[ x -gt y ]]` is not. `eval "{name}"` and `bash -c "{name}"` are the
> same category and equally yours: they ask bash to parse the value as a
> program, and no quoting can make that safe.

**Refused at save time**, each naming the context it found:

| Where | Why |
| --- | --- |
| `'…'` | a `'` in the value would end the run |
| `$'…'` | ANSI-C quoting: the same, **and** a `\n` or `\x41` in the value would be *interpreted* |
| `<<'EOF'` body | a quoted delimiter means nothing expands and nothing escapes, so there is no way to put a value there |
| `` `…` `` | write `$(…)`, whose rules Naru does model |
| `cat <<{name}` | a delimiter is a label bash matches the closing line against, not text it expands |
| `$((…))`, `((…))` | arithmetic re-parses what it is given — see the box above |

The code that classifies a slot's context (`config::scan_script`) is a coarse
lexer over bash's quoting forms, and since it now decides the bytes bash sees
it is worth saying exactly what a wrong classification costs. Every form Naru
emits is inert in every context that expands anything, so a mis-lex costs a
**mangled value** — a single-quoted string read where bash wanted double-quote
escaping has stray quote characters in it; an escaped one read as a bare word
splits on spaces — never execution. The two contexts where a wrong guess
*could* reach execution are the ones above that are refused rather than
guessed at. (An earlier draft of this feature substituted values too, and a
security review put three holes in its lexer in one pass — `$'…'` read as
`'…'`, a subshell's `)` closing a `$(` that was never opened, `#` starting a
comment after `)`. All three are tracked now and pinned by tests; the refusals
are what make the remaining lexer mistakes cheap.)

### Absent values, unknown braces

- **A placeholder the hook isn't offered is an error**, named in the message
  (`{id}` in `agent-spawn`, `{prompt}` in a watcher, a typo like `{tsak}`) —
  raised at save time and again before anything runs. A brace holding only
  name characters (`[A-Za-z0-9_-]`) is a placeholder as far as Naru is
  concerned, since bash has no use for `{tsak}` either. Every other brace —
  `cp a{,.bak}`, `{ …; }`, jq's `{id: 1}`, `{1..3}` — is bash text and passes
  through **literally**, and a `{` preceded by `$` is bash's own parameter
  expansion (`${HOME}`).
- **A placeholder that is offered but has no value on this call is the empty
  string** — `''` in a word position, nothing inside quotes. Free-form shell
  text has no token to drop, so the old argv rule (drop the token and its
  flag) is gone with the argv mode: a promptless
  `POST /api/projects/{id}/agents` runs `claude --bg --model opus --agent supervisor -- ''`, an
  empty prompt. There is no `MESA_*` variable to tell "absent" from "blank"
  any more; a hook that must tell them apart tests `[ -n {name} ]`.

### Retired placeholders: `{bin}` and `{agent}`

Until mesa task 1141 two more placeholders stood at the front of every default:
`{bin}` resolved to `MESA_CLAUDE_BIN` else `claude`, and `{agent}` to
`MESA_CLAUDE_AGENT` else `swe`. Neither was visible or editable in Settings, so
a user who wanted a different binary or agent had no obvious lever. Both are
gone, and the defaults name `claude` and their agent literally.

- **A saved template that still holds them is migrated on read.** Every time a
  template is read from the file, `{bin}` becomes `claude` and `{agent}`
  becomes `swe`, in memory (`config::migrate_retired_placeholders`). An
  upgraded install's custom template therefore keeps working with no silent
  spawn failure. **The file is never rewritten behind the user's back**;
  Settings shows the already-migrated literal text, so the next Save writes the
  literal form and the file heals itself.
- **Saving either token anew is refused** — an ordinary 422 `validation` from
  the unsupported-placeholder rule, because the vocabulary no longer offers
  them. The Settings page never shows those tokens, so from the editor this
  path is unreachable.
- **`MESA_CLAUDE_BIN` is a test seam, not a user lever.** It still names the
  `claude` Naru uses for everything that is *not* a template — listing
  sessions, `claude stop`, the attach bridge, the terminal pane — and on the
  spawn path it stands in for the leading `claude` of a **built-in default**
  only (single-quoted into the script, so a stub path with a space in it is
  still one word), so the check scripts' stub binary keeps working. A template
  the user configured is run exactly as written, byte for byte: the env var is
  never where a hook's binary silently comes from. `MESA_CLAUDE_AGENT` is
  deleted outright.

### Retired variables: `$MESA_ID`, `$MESA_NAME`, `$MESA_PROMPT`

Until mesa task 1143 a multi-line value read its values as environment
variables — `MESA_ID`, `MESA_NAME`, `MESA_PROMPT`, and `MESA_PROMPT_<NAME>` for
a library prompt — and a `{placeholder}` in a script was rewritten to a
reference to one (`"${MESA_NAME-}"`). Naru sets none of them now; a value is
quoted straight into the script.

- **A saved hook that still reads them is migrated on read**, the same way as
  `{bin}`/`{agent}` (`config::migrate_env_references`): `$MESA_ID`,
  `${MESA_ID}` and `${MESA_ID-}`, each optionally wrapped in `"…"`, become
  `{id}` (likewise `{name}` and `{prompt}`), and `$MESA_PROMPT_NIGHTLY_BRIEF`
  in the same forms becomes `{prompt:nightly-brief}` — the name lowercased with
  `_` folded to `-`. The enclosing `"…"` is consumed because the placeholder
  arrives quoted already. The file is never rewritten; Settings shows the
  migrated text and the next Save writes it. A migrated prompt name the
  library no longer holds (or one whose real name had a `_`) fails the next
  spawn with the ordinary unknown-prompt error, naming it, rather than starting
  an agent with no instructions. Only those names are touched: `$MESA_DB` or
  `$MESA_IDX` in a script is some other variable and is left alone — as is a
  `$MESA_ID` written inside `'…'`, which was literal text before and, being
  migrated to `{id}` in single quotes, is now a refused spawn; unquote it.
- **Saving a hook that reads one of them anew is refused** — 422 `validation`
  naming the reference and the placeholder to write instead — so a hand-typed
  `"$MESA_NAME"` can never save and then silently read as the empty string on
  every dispatch.

### `{prompt:<name>}` — a library prompt

**Every action also offers the library's prompts** (mesa task 1138):
`{prompt:<name>}` resolves to the body of the library item of kind `prompt`
named `<name>` — the same view `mesa library list` and `#/library` show, so a db
row, an unshadowed built-in and a **fork overriding** a built-in all work, and
editing the prompt on that page changes what the next spawn runs with no config
edit at all. Since mesa task 1139 that includes every prompt that is *also* a
slash command (`export_command` on, `docs/library.md`): `{prompt:execute-todo}`
splices in exactly the text `/execute-todo` types, since the body is stored
once and exported byte-identical. The Settings page lists this install's prompts beside the
placeholder vocabulary, live.

It cannot collide with the built-in `{prompt}`, which has no colon. Unlike the
three above it is **not** scoped to a subset of the actions: those are per-call
data a given spawn may not have, while a library prompt is static text any spawn
may quote.

- **Name matching is case-insensitive exact** — `{prompt:Nightly-Brief}` and
  `{prompt:nightly-brief}` are the same prompt, the rule
  `mesa project resolve` already uses for a project name. Any library name is
  usable, a `.` included: nothing but the library has to hold it any more.
- **An unknown name is an error, never an empty string.** At save time
  (`PUT /api/config`, the Settings page) that is a `validation` / 422 naming the
  missing prompt and listing the ones the library has — library names are known
  then, so the failure belongs in the editor. If the row is deleted *after* the
  save, the next spawn fails the same way rather than starting an agent with its
  instructions silently missing.
- **An empty body is legal** and resolves to the empty string — one empty
  argument.
- **A prompt body may itself hold placeholders, expanded exactly one pass.**
  Within the resolved body the three built-ins are replaced with their values for
  this call — but only those the action offers and has a value for. Anything
  else is left **literal and is never an error**: an unknown `{foo}`, a
  placeholder the action does not offer, and a nested `{prompt:other}` all come
  through as written. A library body is data somebody wrote, not a template the
  config author reviewed, so a stray brace in it must never break a hook; one
  pass is what makes recursion impossible.
- **The body is then quoted like any other value** — however many lines,
  quotes or backticks it holds, it reaches the program as one argument, and
  every refusal above (`'…'`, `$'…'`, a quoted heredoc delimiter, backticks,
  arithmetic, a heredoc's delimiter word) applies to this form identically; it
  is not special-cased.

Anything that is not a name the library could hold is not a placeholder at all,
so `{prompt: see below}` in a script body is the literal prose it looks like.

### Also refused at save time

- An **empty** script. (Blank still *clears* the key back to the built-in
  default, and it wins: a whitespace-only value is a reset, not an error.)
- A **bash syntax error**, checked with `bash -n` — which parses and executes
  nothing — over the script *with the placeholders already replaced by sample
  values*, so it sees the shape bash will really be handed; an unterminated
  quote is caught here. A machine with no `bash` on PATH skips the check
  rather than failing the save; Naru can't prove a script is wrong there, and
  such a machine can't run it either.

  Unlike the refusals above, this one is **save-time only** — the spawn path
  does not re-run `bash -n`, so a hand-edited config may hold a script that
  parses badly, and that shows up as a failed spawn. Deliberate: a `bash`
  subprocess on every dispatch would cost more than it catches.

## Resolution and failure

- **Read on every spawn**, not cached at startup: edit the file and the next
  dispatch uses it, with no server restart.
- **Absent file, absent key, or a blank value ⇒ the built-in default.** Blank
  is the natural way to un-set one command back to the default.
- **A file that exists but can't be read or parsed is an error**, surfaced
  where the spawn happens (the watcher logs it and releases its claim; the API
  answers 502 `unavailable`). A broken config must never read as
  "unconfigured" — same rule as `hooks.json`.
- The defaults are templates run through the same resolver as a user's, so
  there is one code path. The one difference is the `MESA_CLAUDE_BIN` test
  seam, which stands in for a **default's** leading `claude` only (see *Retired
  placeholders*); a configured template runs exactly as written.

## What a replacement command owes Naru

Only its **exit code**. Nonzero is a failed spawn (the todo-watcher reverts the
task to `todo`; the inbox-watcher drops the id from its
in-memory dispatched set, so a later tick retries). The script runs with stdin
closed and nothing set in its environment beyond what `mesa serve` inherited.

Printing `backgrounded · <id>` is optional. Naru parses that line when it is
there and `POST /api/projects/{id}/agents` returns the id; with no such line
the response is still `201` with **`id: null`**, and clients must read that as
"created, find it in the session list" — the Agents sidebar just can't
pre-open an attach pane for it. Nothing in Naru treats a missing receipt as
failure.

Two surfaces stay bound to `claude` regardless of these templates, because
neither *starts* a session: the session list (`claude agents --json`) and the
attach bridge (`claude attach <id>`), both of which use `MESA_CLAUDE_BIN`
directly. Point a template at a different tool and its sessions will run —
they just won't appear in, or be attachable from, the Agents sidebar.

## The Settings page

The same file is editable from the web UI: **Settings**, pinned to the bottom
of the left nav (`#/settings`, `SettingsView.tsx`, mesa task 654). Its Hooks
tab is a form over `commands` — a text box per action, the built-in default
shown as the box's placeholder, the action's placeholder vocabulary listed
under it, and the script that will actually run spelled out beneath — and the
other tabs hold one section each for the rest of the file (Watchers, Keyboard
shortcuts, Live conversation, Speech, Model pricing) — plus a **Memory** tab
(mesa task 1147) that is not over this file at all but over the live
notebook, a db table (`docs/live.md`).
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

Three behaviors it exists to make legible, all of them the file's semantics
rather than presentation:

- **A blank box is the built-in default**, not an empty command — so *reset* is
  literally "clear the box", and a saved blank **removes the key** rather than
  storing `""`.
- **A bad template is refused at save time**, with the same message the spawn
  path would have produced later (`{tsak}`, a placeholder in single quotes or
  arithmetic, a `$MESA_NAME`, an unknown key, a bash syntax error).
  Validation runs over the whole batch before anything is written, so a
  rejected save leaves the file byte-identical.
- **The vocabulary is visible while typing.** One short note above the rows
  says what every hook is — a bash script, its placeholders quoted in — and a
  `{placeholder}` the action does not offer is named inline
  (`settingsDraft.ts::placeholderError`), before the save. The other refusals
  need a shell lexer and are the PUT's, which names the context it found.

Behind it, `GET /api/config` and `PUT /api/config` (`core::config::settings` /
`save_commands`):

- `GET` returns one row per action —
  `{action, value, default, placeholders}`, where `value` is `null` when the
  action is falling back (already migrated: a stored `{bin}` or `$MESA_NAME`
  reads back as its placeholder). A file that exists
  but can't be parsed is **502 `unavailable`** here exactly as it is on a spawn:
  the page says the config is broken rather than rendering an empty editor a
  save would then write over the wreckage.
- `PUT` takes `{"commands": {<action>: <template>}}` and touches **only** the
  keys present; other keys, and any other top-level section of the file, are
  preserved verbatim (this file is meant to grow sections Naru doesn't know
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
  tokens** and all four are required; Naru never derives a cache rate from the
  input rate.
- Naru ships defaults for `claude-fable`, `claude-mythos`, `claude-opus`,
  `claude-sonnet` and `claude-haiku` (`config::DEFAULT_PRICES`). An **absent
  key uses the built-in**; the config only ever overlays.
- **Longest matching prefix wins** over the merged table, so a variant can be
  priced beside its family. A model no prefix matches estimates **$0** — no
  cost rather than a wrong one.
- A prefix Naru has never heard of is allowed. That is the point.
- Removing a key (`PUT` value `null`) restores the built-in for a shipped
  family and deletes a user-added prefix outright.
- A malformed config is `unavailable`, never a silent fall back to the
  built-ins — the same rule the spawn path follows.

Validation happens in `core::config` before anything is written, and is
all-or-nothing: a prefix must be non-empty after trimming, whitespace-free and
≤ 64 characters, and every rate must be finite and ≥ 0. A rejected save leaves
the file byte-identical.

`pricing` is a sibling of `commands` (and, below, `watchers`) over one
document: saving one preserves the others (and any section Naru doesn't
know). Nothing is
cached — the table is loaded **once per dashboard request** and a save applies
to the next read, past sessions included, with no restart. Cost is derived on
every read, so there is no stored figure to migrate.

In the Settings editor a row's four boxes show the built-in rate as their
**placeholder**, so a box left blank on a part-filled row means "keep that
rate": Naru fills the untouched boxes from the default before the PUT, which
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

A third, independent section holds per-watcher tuning knobs — two: the
todo-watcher's per-project concurrency limit (mesa task 777,
`docs/todo-watcher.md`) and the retrospective's cadence (mesa task 1158,
`docs/retro.md`).

```json
{
  "watchers": {
    "todo-concurrency": 3,
    "retro-interval-hours": 72
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
- `retro-interval-hours` is how many hours `serve --watch-retro` waits
  between two retrospectives, and what `mesa retro run` judges its `conflict`
  against. **Absent or `null` ⇒ the built-in default, 72** (three days). The
  editor requires an integer in `1..=8760` — a year, a sanity cap like the
  one above — and is `422 validation` otherwise, writing nothing; a
  hand-edited out-of-range value is clamped on read, exactly as
  `todo-concurrency` is. Read on every tick and on every `retro run`/`status`,
  so an edit lands on the next tick with no restart.

### Routes

- `GET /api/config/watchers` → `ConfigWatchers`:
  `{todo_concurrency, todo_concurrency_default, retro_interval_hours,
  retro_interval_hours_default}`, where each `*` is the override (`null` when
  unset) and each `*_default` is the built-in (1 and 72). The two retro keys
  are `ts(skip)`ped off the generated TypeScript type — the retrospective has
  no page, so the Settings editor neither shows nor writes them. Gated like
  `GET /api/config`/`GET /api/config/pricing` (`require_agent_access`); a
  malformed config is **502 `unavailable`**.
- `PUT /api/config/watchers`, body `{"todo_concurrency": <1..=20> | null,
  "retro_interval_hours": <1..=8760> | null}` (either key may be absent,
  which leaves it alone) → echoes the getter. `null` removes the key,
  restoring the default. An out-of-range or non-integer value is **422
  `validation`**, writing nothing.
  Gated with `require_agent_access` — the same posture as the other two config
  writes (mesa task 1021): it is the same file, and which section a write lands
  in is not the distinction that matters.

The sections are siblings over one document: saving `watchers` preserves
`commands`, `pricing`, `speech`, `guard`, `keymap` and any section Naru doesn't
know about, and vice versa.

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

- **Absent or blank ⇒ no `-v` at all.** Naru names no default
  voice of its own: with nothing configured the argv is byte-for-byte the one
  it ran before this key existed, and which voice that means is
  `kokoro-rs`'s business. That is why `ConfigSpeech` has no `voice_default`
  twin to `todo_concurrency_default` — there is no mesa-side default to
  report.
- **The list of voices comes from the binary**, not from Naru:
  `kokoro-rs --list-voices`, filtered to bounded identifiers and cached for
  the life of the process (`core::speech::voices`). An **empty list means Naru
  could not ask** — no binary, or an answer that wasn't a list of names —
  never "there are no voices", so the editor falls back to a plain text box
  and the save-time membership check is skipped. Naru never ships a voice list
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
  offers (`[]` when Naru couldn't ask — **not** an error, since the setting
  must stay visible on a machine where the synthesiser isn't installed yet).
  Gated like the other config getters (`require_agent_access`); a malformed
  config is **502 `unavailable`**.
- `PUT /api/config/speech`, body `{"voice": "<name>" | null}` → echoes the
  getter. `null` **and** blank both remove the key, restoring the binary's own
  voice. A name that isn't a voice — or, when Naru has a list, isn't on it —
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
  The spoken text is a Naru constant (`core::speech::SAMPLE`), so the voice is
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

**A `live.prompt` key left behind by an older Naru, or hand-edited into the
file, is silently ignored** — never an error, and never read from — since
`LiveSection` simply has no field for it any more. Everything the prompt used
to be is unchanged in spirit, it has just moved: a configured prompt still
**replaces** the built-in rather than extending it (forking a built-in starts
from its text, the same "start from the built-in" idea the old editor offered
as a button), Naru still appends only the session line —
`You are driving mesa live session <id>.` — and the text is still never
parsed by a shell, quoted into the `live-agent` hook as one value
([Placeholders](#placeholders)). Rewriting it is how a live
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
  two spoken words Naru would post half a sentence, and a minute of silence is
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
  — the override (`null` when unset) beside the value Naru ships, sent by the
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

- **Absent or blank ⇒ no `-m` at all.** Naru names no default model of its
  own: with nothing configured the argv is byte-for-byte the one it ran
  before this key existed, and which model that means is `auris`'s business.
  There is deliberately **no `language` key** — `auris` has no `--language`
  flag, so one would drive no argv — and vocabulary is **not** a config key
  either: it is derived per request, not stored here.
- **The list of models comes from the binary**, not from Naru:
  `auris --no-download --list-models`, filtered to bounded identifiers and
  cached for the life of the process (`core::listen::models`). An **empty
  list means Naru could not ask** — no binary, or an answer that wasn't a
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
  offers (`[]` when Naru couldn't ask — **not** an error, since the setting
  must stay visible on a machine where `auris` isn't installed yet). Gated
  like the other config getters (`require_agent_access`); a malformed config
  is **502 `unavailable`**.
- `PUT /api/config/listen`, body `{"model": "<name>" | null}` → echoes the
  getter. `null` **and** blank both remove the key, restoring the binary's own
  model. A name that isn't a model — or, when Naru has a list, isn't on it —
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

## Keymap

An eighth, independent section rebinds the web UI's **global** keyboard
shortcuts (mesa task 1079, `docs/keyboard.md`) — and the only one edited from
Settings that Naru's own Rust reads nothing from.

```json
{
  "keymap": {
    "create-task": ["n"],
    "focus-left": ["a", "ArrowLeft"]
  }
}
```

- One entry per **action**, holding a **list** of chords — because the spatial
  nav has always answered to a letter *and* an arrow. The seven actions are
  `command-palette`, `focus-left`, `focus-down`, `focus-up`, `focus-right`,
  `create-task` and `live-listen`: exactly the four global `window` keydown
  listeners the app mounts. The Files tab's chords, the code editor's
  Cmd/Ctrl+S and a modal's Escape are deliberately **not** here — each belongs
  to one panel that is on screen and owns the keyboard while it is, which is a
  different thing from a binding the whole app answers to.
- **An absent action ⇒ the chords Naru ships**, so defaults are never written:
  only overrides live in the file, and `PUT null` removes an entry rather than
  storing the default back. The shipped table is
  `config::KEYMAP_ACTIONS` — `Mod+Shift+P`; `h`/`ArrowLeft`, `j`/`ArrowDown`,
  `k`/`ArrowUp`, `l`/`ArrowRight`; `a`; `Mod+Shift+L` — which is exactly what
  the app answered to before the section existed.
- A **chord** is written modifiers-then-key, `Mod+Alt+Shift+<key>`, and stored
  canonicalized (modifiers in that order, a single-character key lowercased),
  so the file never holds two spellings of one binding. `Mod` is
  meta-**or**-ctrl: one name for both platforms, because a keymap saved on a
  Mac has to mean the same thing on the Linux box reading the same file. The
  key itself is whatever `KeyboardEvent.key` reports (`ArrowLeft`, `Enter`,
  `/`, `a`) — Naru invents no key names, so what the editor records from a real
  keystroke is exactly what is stored.
- **A collision between two actions is refused**, which is the one rule no
  other section has: a keymap is not a set of independent values but a
  partition of the keyboard, so an override is judged against the whole map the
  save would leave behind — including the actions the user never touched. The
  server refuses exactly what the editor refuses.
- **Nothing in Rust reads this section.** The shortcuts are the page's; Naru's
  job is to store them and to refuse what the editor refuses.
- The read path is **forgiving** where the write path is strict, the
  `todo-concurrency` clamp posture: a hand-edited entry Naru cannot use — a
  non-list, an empty list, a malformed chord, an action it does not bind — is
  dropped, costing **that action** its override and nothing else. The page then
  falls back to that one action's shipped chords.
- The page fetches the section **once, at mount** (`frontend/src/keymapStore.ts`
  — one `GET` however many listeners ask), and the shipped chords are in force
  until it answers, so a refused or unreadable config leaves the app with
  shortcuts rather than none. A save publishes its own response straight to the
  listeners, so a rebind takes effect with no reload.

### Routes

- `GET /api/config/keymap` → `ConfigKeymap`: `{actions: [{action, value,
  default}]}` in the shipped order, where `value` is the override (`null` when
  unset) and `default` is the chords Naru ships. Gated like the other config
  getters (`require_agent_access`); a malformed config is **502
  `unavailable`**.
- `PUT /api/config/keymap`, body a **flat map of action id to chords** —
  `{"create-task": ["n"], "focus-up": null}` — → echoes the getter. Unlike its
  fixed-key siblings the body is a table, because the actions are one: an
  absent action is left alone, `null` removes its override, a list replaces it.
  An unknown action id (named in the message), a malformed chord, an empty list
  and a chord two actions would share are each **422 `validation`**, writing
  nothing. Gated with `require_agent_access`, the same posture as every other
  config write (mesa task 1021).

## Gate

`scripts/config-check.sh` — all three commands driven by a configured hook
(placeholders, a quoted template token, a name with spaces as one argument,
an absent value as the empty string), the built-in argv proven unused while
they are set and byte-for-byte unchanged when they aren't, the `id: null`
no-receipt path, hot reload with no restart, and the malformed /
unsupported-placeholder failures — plus `GET`/`PUT /api/config`: the round
trip, the blank-clears-the-key rule, untouched keys and unknown sections
preserved, a just-saved template driving the very next spawn, and the 422/502
refusals leaving the file byte-identical — and, for multi-line hooks, a script
driving each of the three actions, a hostile `{name}`/`{prompt}` (quotes,
backticks, `$()`, a trailing backslash, a newline) arriving byte-identical in
a word position, inside `"…"`, inside `$( (…) )` and in a heredoc body while
executing nothing, a configured hook whose value holds a space and a quote
reaching the stub as **one** argument, the `$MESA_*` read-time migration and
save-time refusal, and the 422s for an out-of-scope placeholder, one in single
or `$'…'` quotes, a heredoc delimiter, arithmetic, and a bash syntax error. It writes a real
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
gate it shares (5c): Naru's own sentence on stdin, the query's voice as one
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
`live.prompt` key left behind by an older Naru survives a `GET` unread and a
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

For keymap it covers the round trip (`GET` reporting all seven actions with a
`null` override beside the chords Naru ships, the spatial nav's letter-and-arrow
pair included), a chord stored **canonicalized** and only the override stored,
`PUT null` removing an entry, `commands`/`watchers`/`live`/an unknown section
surviving a keymap write and vice versa, an action absent from the body left
alone, a malformed chord / an unknown action (named in the message) / a chord
the spatial nav already holds / two clashing actions in one body each 422
writing nothing, both verbs refused to a request that isn't from this machine's
own page, and the forgiving read: a hand-edited entry Naru cannot use dropped
beside a good one that survives.

For pricing it also covers the round trip: `GET` showing the built-ins with
null values, an override and a wholly new prefix landing, `PUT null` restoring
one and deleting the other, each section surviving the other's write, a
negative rate and a whitespace-bearing prefix as 422, both verbs 502 on a
malformed file, and a request that isn't from this machine's own page refused
without touching the file.
