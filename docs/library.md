# Library (agents, skills, hooks, prompts, CLAUDE.md)

Naru stores Claude Code's agent definitions, skills, hooks and CLAUDE.md
files as first-class records — the library — and syncs them file-by-file
against `.claude` (and a project's root `CLAUDE.md`), with the user picking a
winner per file (mesa task 919). It also holds a fifth kind, **prompts**:
text Naru itself reads — the live-conversation summariser's prompt, which used
to be a `~/.mesa/config.json` key (`docs/config.md`), and anything a hook
template splices in as `{prompt:<name>}` (mesa task 1138) — each of which may
*also* be exported to `.claude/commands/<name>.md` as a slash command (mesa
task 1139, see [Prompts that are also slash
commands](#prompts-that-are-also-slash-commands)). The live agent's own
instructions are the `naru-live` **agent definition** (mesa task 1068) — see
[Where the live prompt went](#where-the-live-prompt-went).

## The record

Table `library_items` (migration index 47, resulting `user_version` 48):

| column | type | note |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `/`, `\` or `..` — it is half a filename |
| `kind` | TEXT NOT NULL | `agent \| skill \| hook \| prompt \| claude-md` — `command` until migration index 54 folded it into `prompt` |
| `scope` | TEXT NOT NULL | `user \| project` |
| `project_id` | INTEGER NULL | FK `ON DELETE CASCADE`; required iff `scope = project`, must be NULL iff `scope = user` |
| `body` | TEXT NOT NULL | the file's contents; may be empty |
| `builtin_id` | TEXT NULL, UNIQUE | the built-in this row forked from, or NULL for a purely user-authored row |
| `synced_body` | TEXT NULL | the last body Naru and the disk agreed on — the sync baseline |
| `synced_at` | TEXT NULL | when that agreement was recorded |
| `export_command` | INTEGER NOT NULL DEFAULT 0 | a prompt's "also a slash command" flag (migration index 54, mesa task 1139); `validation` when set on any other kind |
| `created_at` / `updated_at` | TEXT NOT NULL | |

`(kind, scope, project_id, name)` is unique at the schema level too — two
rows cannot claim one path — but not as a plain `UNIQUE` column list: a
`user`-scoped row always has `project_id = NULL`, and SQLite treats two
`NULL`s as distinct in a `UNIQUE` constraint, so that shape would silently
never fire for exactly the rows that are most common. Instead it is a unique
index over an expression with no `NULL`s —
`CREATE UNIQUE INDEX library_items_identity ON library_items (kind, scope,
COALESCE(project_id, -1), name)` — which genuinely holds at the DB level for
every row, `user`-scoped ones included, regardless of a race between two
concurrent creates. `Store::ensure_library_name_free` still runs first and is
what produces the friendly `conflict` message naming the clashing id; the
index is the backstop underneath it, exactly as `builtin_id UNIQUE` is the
backstop under `Store::ensure_library_builtin`.

Table `library_versions` — the history:

| column | type |
| --- | --- |
| `id` | INTEGER PK |
| `item_id` | INTEGER NOT NULL, FK → `library_items` `ON DELETE CASCADE` |
| `body` | TEXT NOT NULL |
| `source` | TEXT NOT NULL — `edit \| sync-pull` |
| `created_at` | TEXT NOT NULL |

A version row is appended **only when the body actually changes**
(`Store::update_library_item`, `Store::pull_library_body`, byte comparison) —
creating a row writes version 1; a save that leaves the body byte-identical
writes none. History is therefore a list of *distinct contents*, not a list of
PATCHes — the same property `Store::update_task`'s no-op-writes-no-event rule
has.

Deleting an item cascades its versions (`ON DELETE CASCADE`); deleting a
project cascades its `project`-scoped library items along with everything
else scoped to it.

Two more validation rules, both in `Store`, not the schema: `name` is ≤ 100
characters (`LIBRARY_NAME_MAX`) — generous relative to a script argument's
64-character bound, because a library name becomes a filename, not an
env-var suffix — and `body` is ≤ 1 MiB (`LIBRARY_BODY_MAX`), because a sync
can write it straight to disk and nothing about this feature should be able
to produce an unbounded file.

`Store::list_library_items(project)` answers what is *visible from a given
context*, not a strict ownership filter: with a project given, that project's
own `scope: project` rows plus every `scope: user` row (a project's library
view shows both what is bound to it and what is personal, since either could
apply there); with no project, only `scope: user` rows — the user-level view
that is not standing in any particular project. This is the shape both the
CLI's `library list [PROJECT]` and `GET /api/library?project=<id>` expose.

## Built-ins are code, not rows

`core::library::BUILTINS` is a `&[Builtin]` static — `id`, `name`, `kind`,
`scope`, `body` — the same shape `config.rs` already used for "blank means
the block Naru ships." A built-in is **never inserted at migration time**.
`core::library::effective_items` (what `list`/`GET /api/library` actually
return) is `Store::list_library_items` plus every `BUILTINS` entry **not**
shadowed by a db row carrying its `builtin_id`; an unshadowed built-in is
reported with `id: null`, `builtin: true`, and a `path` derived the same way
a real row's is.

That split is the whole point:

- **Editing a built-in forks it.** The API's `POST /api/library/builtins/{id}/fork`
  and the CLI's edit path both go through `Store::create_library_item` with
  `builtin_id: Some(id)` — a real db row appears, carrying the new body, and
  from then on Naru **never updates it**. A Naru upgrade that improves a
  built-in's shipped text changes only the *unshadowed* ones; a user's fork is
  theirs to keep, forever, until they choose to sync it back.
- **Deleting the fork restores the built-in.** `Store::delete_library_item`
  on the forked row just removes that row; `effective_items` immediately
  reports the built-in again, unshadowed, `id: null`. Deleting an *unshadowed*
  built-in never reaches `Store` at all — there is no numeric id to delete —
  so the CLI answers `validation` ("there is nothing to delete") rather than
  a silent no-op.
- **A built-in forks at most once.** `builtin_id` is schema-`UNIQUE`, and
  `Store::create_library_item`/the fork route both check
  `Store::find_library_fork` first and answer `conflict` on a second attempt.

The starter set is deliberately tiny — seven rows:

| `id` | kind | scope | what it is |
| --- | --- | --- | --- |
| `naru-live` | `agent` | `user` | The agent definition the live conversation runs as — literally `core::live::AGENT_DEFINITION`, YAML frontmatter plus `core::live::AGENT_PROMPT`, moved here rather than duplicated (mesa task 1068) |
| `supervisor` | `agent` | `user` | The agent definition an auto-dispatched `/execute-todo` run is supervised as — literally `core::supervisor::SUPERVISOR_DEFINITION` (mesa task 1075), seeded to `~/.claude/agents/supervisor.md` by `core::supervisor::ensure_agent_definition` before the `todo-watcher` spawn |
| `inbox-triage` | `agent` | `user` | The agent definition a `serve --watch-inbox` dispatch triages one inbox item as — literally `core::inbox_triage::INBOX_TRIAGE_DEFINITION` (mesa task 1168, `docs/inbox-watcher.md`): `opus` at medium effort, no `Edit`/`Write`, seeded to `~/.claude/agents/inbox-triage.md` by `core::inbox_triage::ensure_agent_definition` before the `inbox-watcher` spawn |
| `live-summary-prompt` | `prompt` | `user` | The instructions for the short-lived agent that writes a live conversation's memory once it ends (mesa task 921) — literally `core::live::SUMMARY_PROMPT`, placed immediately after the prompt it belongs beside |
| `starter-claude-md` | `claude-md` | `user` | A short starting-point CLAUDE.md |
| `stop-notify` | `hook` | `user` | A minimal shell hook that echoes when Claude Code stops — its *name* is `stop-notify.sh`, since a hook's name carries its own extension |
| `task-stop-guard` | `hook` | `user` | A `Stop` hook that keeps a task agent from ending its turn before its Naru task is handled — literally `core::stop_guard::STOP_GUARD_HOOK` (mesa task 1190, "The task-stop-guard hook" below); name `task-stop-guard.sh` |

`naru-live`'s body being the literal `AGENT_DEFINITION` constant (and
`live-summary-prompt`'s the literal `SUMMARY_PROMPT`) is what lets
`docs/live.md`'s tests of "the loop is fully stated" keep passing unchanged —
each built-in and its constant are the same text, never two copies that could
drift.

The two Naru agent definitions were `mesa-live` and `mesa-retro` until mesa
task 1302. The old ids still name them (`core::library::RENAMED_BUILTINS`,
read through `canonical_builtin_id` by `builtin`, `Store::find_library_fork`
and `Store::create_library_item`). Migration index 71 moved each stored
fork. Its `builtin_id` moved, a `name` equal to the old id moved too, and so
did the frontmatter line `name: mesa-live` (or `mesa-retro`), with LF or
CRLF line endings. When the name
moved, the sync baseline was cleared, because the path moved with it. The
rest of the body and the version history are untouched, and a row that
would collide is skipped. A bundle exported before the rename is read the
same way, so its `mesa-live` fork imports as the fork of `naru-live`. The
old `~/.claude/agents/mesa-live.md` is left on disk; sync lists it as
`disk-new`.
A fork whose frontmatter name line is not the plain `name: mesa-live` form
(quoted, or with trailing whitespace) keeps that line, and so does a
pre-1302 version restored from history; fix the line by hand, or
`claude --agent naru-live` will not find the agent.

### A name collision folds into the row that owns the file

`effective_items` shadows a built-in **only** by `builtin_id` — a fork. A db
row that merely collides by `(kind, scope, name)` — one adopted from disk by
a sync, say — is a different row as far as the store is concerned, so both
come back and the list showed the same name twice. Only one of them can be
the file on disk, so the page folds them (mesa task 1111,
`frontend/src/libraryOverride.ts::foldOverrides`): the built-in drops out of
the list and the user's row wears an **overrides built-in** badge. The match
is exact on `kind`, `scope` and `name`, case-sensitively — the triple the
store's own uniqueness rule is stated in — and applies only where the user
row's `builtin_id` is null. A **fork** is untouched: its built-in is already
absent from the list, so there is nothing to fold.

A folded row also offers **diff vs built-in**, an inline panel below the row
rendering `libraryOverride.ts::diffLines(userBody, builtinBody)` through the
sync modal's own `diffLineClass`/`diffMark` markup. That function is a
deliberate **second implementation** of `core::library::diff_lines`, and the
one place the "no second implementation" rule below is knowingly broken: both
bodies are already in the browser (they arrive on the list `GET /api/library`
answers), so a server-side diff would mean a new gated route for data the page
already holds. It is a faithful port — the same line-splitting semantics, the
same tie-break, the same `DIFF_MAX_CELLS`/`DIFF_MAX_LINES` bounds degrading to
the same marker line — and the two must stay in step; `libraryOverride.test.ts`
pins the shape.

Everything else about a row is one line now: name, scope (and project), path
(the one part that truncates) and any badges on the left, `edit · history ·
diff vs built-in · delete` right-aligned on the same line, with the edit form,
the version history and the diff all opening below it as before.

`history` opens **two columns** (mesa task 1112): every version as one line on
the left — timestamp, source and how many lines it added and removed against
the version immediately older — and on the right the selected version's `diff
vs previous` or its `full text`. Newest first, newest selected. The oldest
version has nothing before it, so it carries no counts, reads `created` rather
than its stored `edit`, and its diff tab shows the whole body. The counts are
read off the very `LibraryDiffLine[]` the diff renders, so the line and the
panel beside it can never disagree, and a diff that degraded to a marker line
reports no counts rather than counts of the part that fits
(`frontend/src/libraryHistory.ts`, pinned by `libraryHistory.test.ts`).
`restore this version` is an ordinary body update — the same
`PATCH /api/library/{id}` the editor makes, with no route of its own — so the
store appends a version for the restored body exactly as it does for any other
edit, and restoring the newest version changes nothing and writes nothing.

## Where a row lives on disk

`core::library::relative_path(kind, scope, name, export_command)`, relative
to the **scope base** — the home directory for `user`, a project's
`local_path` for `project` (`core::library::scope_base`):

| kind | user scope | project scope |
| --- | --- | --- |
| `agent` | `.claude/agents/<name>.md` | `.claude/agents/<name>.md` |
| `skill` | `.claude/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| `hook` | `.claude/hooks/<name>` | `.claude/hooks/<name>` |
| `claude-md` | `.claude/CLAUDE.md` | `CLAUDE.md` (the repo root — where Claude Code actually reads it) |
| `prompt`, `export_command` on | `.claude/commands/<name>.md` | `.claude/commands/<name>.md` |
| `prompt`, `export_command` off | **none** | **none** |

`hook` is the one kind that appends nothing (mesa task 1114): a hook is
whatever script the user drops in — `poll-guard.py` as readily as
`stop-notify.sh`, or no extension at all — so its **name is the whole
filename** and the extension travels with the item, which is what lets an
imported hook land back on disk as the file it came from. `scan_disk` lists
every regular file in `.claude/hooks/` regardless of extension, silently
skipping any whose filename `Store`'s name rule would reject (a file Naru
cannot name is one it could not round-trip) — dotfiles included, since that
rule requires an alphanumeric first character. Migration index 52 appended
`.sh` to every pre-existing hook row's name, which is exactly the path it
already had.

## Prompts that are also slash commands

Until mesa task 1139 there were two kinds for what is one thing: a `command`
(text under `.claude/commands/`, reachable only by typing `/<name>` at
Claude) and a `prompt` (text Naru reads — the summariser's instructions, and
since mesa task 1138 anything a hook template names as `{prompt:<name>}`).
The same paragraph could not be both. Now there is **one kind, `prompt`**,
and a per-row flag, **`export_command`**, saying whether it is *also* written
to Claude's commands folder: one source of truth in Naru, two consumption
paths. A prompt with the flag off is mesa-internal exactly as before — no
path, invisible to `scan_disk` and `sync_status` by construction — and one
with it on owns `.claude/commands/<name>.md` and syncs like an agent or a
skill. The three rows that were `command`s (`execute-todo`,
`execute-refine`, `execute-triage-inbox`) migrated to prompts with the flag
on — same id, so their version history came along untouched, same path and
body, so their sync baseline still holds — and are reachable from a hook
template as `{prompt:execute-todo}` etc. with nothing else done.

**The stored body is canonical and the export is byte-identical.** No YAML
frontmatter is synthesised from the item's description, no `{placeholder}` is
rewritten to `$ARGUMENTS`, no argument translation of any kind. The task
floated a translation as a leaning; it is rejected because `classify` (below)
compares three plain strings — mesa body, disk body, baseline — so any
transform on the way out is a permanent `both-changed` conflict on every
row, and the whole requirement is that a sync right after an export sees no
diff. The migrated items already carry `$ARGS`/`$ARGUMENTS` prose and keep
working as slash commands unchanged; a prompt that wants frontmatter writes
it into its body. The flag is a prompt's alone — `Store` answers
`validation` for `export_command: true` on any other kind, since every other
kind already owns a path — and a **built-in** carries no flag (a built-in is
code, and `live-summary-prompt` has no business in `.claude/commands`);
forking one gives it a row, and the row may set the flag like any other.

**Turning the flag off removes the file** — the one write to disk outside
the sync flow, made by `core::library::update_item`, the wrapper both `mesa
library update` and `PATCH /api/library/{id}` go through instead of
`Store::update_library_item` directly (the store never opens the
filesystem). A file left behind would still be a slash command Claude Code
offers while Naru no longer knew about it. It is removed **only while it is
still Naru's own**: its bytes equal the row's body as it was before the
patch, or the sync baseline (an edit made in Naru but not yet pushed leaves
the disk file equal to the baseline, and that file is still Naru's). A file
the user hand-edited since is left where it is, and the next `sync status`
reports it `disk-new` — the row the user resolves. Either way
`synced_body`/`synced_at` are cleared (`Store::clear_library_synced`): the
baseline describes a file the row no longer claims, and kept, it would read
the row as `disk-deleted` the moment it exported again. The removal is
best-effort — a filesystem failure never fails the update, whose row is
already written. The path goes through `resolve` like every other; it is the
one the row had *before* the patch, so a rename in the same call gives up the
old file. Turning the flag **on** writes nothing: the row is `mesa-new` on
the next scan and the sync writes it, so a mistaken tick costs no file.

The `command` kind is **removed outright**, not aliased: `mesa library create
command …` and `{"kind": "command"}` on the API are `validation`, and
`LibraryKind::parse` does not know the word. The one legacy shim is the
**bundle**: a `LibraryBundleItem` deserializes `"kind": "command"` as a
prompt with `export_command` on (a hand-written `Deserialize` in `types.rs`,
mirrored by `libraryBundle.ts::parseBundle`), so an export taken before 1139
still imports as the row the migration would have made. A bundle carries the
flag from then on, absent reading as off.

On `#/library` the flag is the **also a slash command** box a prompt's form
offers (and only a prompt's — `libraryDraft.ts::offersExport`; a tick left
behind after the kind is changed away is folded off in `payloadFor`, since
the server would refuse it), a `slash command` badge on the row, and beside
every prompt's name its `{prompt:<name>}` form as selectable text
(`promptPlaceholders.ts::promptPlaceholder`, the one spelling the Settings
list uses too).

## The traversal chokepoint, held twice

A library name is half a filename — `core::library::relative_path` builds a
path out of it directly — so `Store::validate_library_name` is the first, and
primary, guard: no `/`, no `\`, no `..` substring, `.`/`..` rejected outright,
and the remaining charset is `^[A-Za-z0-9][A-Za-z0-9._-]*$`. A name that fails
this can never become a path in the first place.

`core::library::resolve(base, rel)` is the second, independent check — the
`files.rs::safe_path()` line held a second time, because a library row writes
an agent definition, a hook script or a CLAUDE.md onto the user's disk, which
is code execution exactly as a Files-tab write is. It does not just trust the
name rule: it lexically normalizes `rel` onto `base`'s own component stack
before ever touching the filesystem (rejecting a `..` that would climb past
`base`, and rejecting an absolute `rel` outright rather than letting
`PathBuf::join` silently replace `base` with it — the "absolute-path
smuggling" case `safe_path`'s own doc comment names), then canonicalizes
whatever prefix of the result already exists to close the symlink-escape hole,
and only then confirms the canonical result still starts with `base`. An
earlier draft of this function walked up via `Path::file_name()`/`.parent()`
until something existed, which is a real bug: `file_name()` returns `None` for
a trailing `..` component, so that approach silently *dropped* a
`../../../escaped.md` instead of climbing past `base` — caught by a test
before it shipped. `resolve`'s test suite covers a symlink escaping the base,
an absolute path passed as the relative one, and `..` climbing through
directories that do not yet exist (the case a create-file write hits, since
the target's parent may not exist on disk yet).

## Registering a hook in `.claude/settings.json`

A hook *file* under `.claude/hooks/` does nothing on its own. Claude Code
runs it only when `.claude/settings.json` says so, under an event name, in a
group carrying a matcher and a list of commands:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh" }]
      }
    ]
  }
}
```

mesa task 1115 makes that wiring a first-class part of the library:
`core::library::hook_registrations` (read), `register_hook` and
`unregister_hook`, each answering the same `LibraryHookStatus`
(`item_id`, `name`, `settings_path`, `command`, `registered`,
`registrations[]`, `events[]`) so a caller reads the file's resulting state
rather than assuming its request landed. `events` is
`core::library::HOOK_EVENTS` carried on the wire, so an editor's event list
is the same list the server validates against and cannot drift from it.

**Only a `hook` item has a registration.** Every other kind is read by Claude
Code because of *where it sits* — an agent definition is found by being in
`.claude/agents/`, a CLAUDE.md by being at the repo root — so there is
nothing to wire up, and asking about one is `validation` (exit 1 / 422)
rather than an empty answer.

**Which settings file follows the item's own scope**, exactly as its body's
path does: `user` → `<home>/.claude/settings.json`, `project` → the
project's `local_path`. A project-scope hook whose project has no
`local_path` recorded is `validation` saying so — the same condition
`sync_status` reports by simply having no base to scan. The path goes
through `core::library::resolve`, the same traversal chokepoint the bodies
take; nothing here opens a second path-joining route.

**The command Naru writes** is `$CLAUDE_PROJECT_DIR/.claude/hooks/<name>` for
a `project`-scope hook — Claude Code's own variable for the repo it is
running in, so the registration stays portable across clones and worktrees —
and the absolute `<home>/.claude/hooks/<name>` for a `user`-scope one, which
has no such anchor.

**The matching rule.** A command in settings.json is arbitrary shell, so
"is this hook registered" cannot be string equality against what Naru would
have written: `bash $CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh --quiet`
is plainly the same hook. A command counts as this hook's iff it is exactly
the absolute path, **or** it contains the relative path
`.claude/hooks/<name>` at a **path boundary on both sides** — the character
before and after the match may not itself be a filename character
(`[A-Za-z0-9._-]`). The boundary is the whole of the rule's safety: it is
what keeps `.claude/hooks/foo.sh` from reading as the hook named `oo.sh`,
and `…/foo.sh.bak` from reading as `foo.sh`. It errs toward *not* claiming a
command Naru is unsure about, since the cost of a false positive is
unregistering someone else's line.

**Enabling** ensures a group under the chosen event whose command list holds
this hook. A group with the same matcher is **appended into** rather than
duplicated (two groups with one matcher fire on exactly the same events, so a
second one is noise the user would have to reconcile by hand); a group with
no `matcher` key at all is read as `*`, since that is what Claude Code does
with it. Enabling something already registered for that `(event, matcher)`
is a **no-op success** — not a duplicate, and not even an mtime change,
because a write that would change nothing is skipped outright. The matcher
defaults to `*`, is capped at `HOOK_MATCHER_MAX` (200) characters and may not
contain a newline. An event outside `HOOK_EVENTS` — `PreToolUse`,
`PostToolUse`, `Notification`, `UserPromptSubmit`, `Stop`, `SubagentStop`,
`PreCompact`, `SessionStart`, `SessionEnd` — is `validation`, because a
mistyped event silently never fires and looks exactly like a broken hook.

**Enabling also seeds the hook's script**, if it is not on disk already:
a built-in hook is code and a fork is a database row, so neither reaches
`.claude/hooks/<name>` until the user runs a sync — and a registration
naming a file that does not exist is worse than a mistyped event, because it
fires and errors on every session. So `register_hook` writes the item's body
there first, creating the parent directory and setting the executable bit
(a hook is a script Claude Code runs, not a file it reads). It **never
overwrites**: this is deliberately `core::live::ensure_agent_definition`'s
posture, for the same reason — a spawn there and a registration here may not
depend on something the user has to run first, but after the first seed the
file belongs to the sync flow, where a difference between disk and Naru is a
row the user resolves.

**Disabling** removes every command matching this hook, then cleans up
upward: a group whose command list empties is dropped, an event whose group
list empties is dropped, and a `hooks` key that empties is **removed from the
file** rather than left behind as `{}`. It can be narrowed to one `event`
and/or one `matcher`; with neither, every registration of that hook goes.
Disabling something that was never registered is a no-op success, the mirror
of enabling's idempotence — including on a file whose `hooks` is `null`,
which both the parser and both splices read as an empty one rather than as
something Naru refuses to touch.

The matcher rules above are **input** rules, and a disable's matcher is not
an input: it is a filter naming which existing registrations to cut, and
nothing is written from it. So it is passed through unvalidated — the 200-byte
cap and the newline rule do not apply, an empty string means the group
actually named `""` rather than `*`, and a matcher already hand-written into
the file stays reachable however it got there. (The web UI's per-row disable
button posts `reg.matcher` verbatim, straight from the file, so any other
reading would make that button permanently broken for such a row.)

### The write is a splice, not a round trip

Naru does not own `.claude/settings.json` — the user's model, environment,
permissions and everything else live beside the `hooks` key — so a
parse-and-reserialize round trip would silently reformat a file Naru merely
edits one key of. Instead `splice_register` and `splice_unregister` navigate the raw text with
a small hand-written scanner (it walks an object or array tracking string
state, escapes and brace/bracket depth, and only ever runs on text
`serde_json` has already parsed, so it may assume well-formed input) and cut
or insert at the span of **the one entry being added or removed** — not the
`hooks` value, and not even the event under it.

A register writes only the innermost structure that does not exist yet: an
existing group gains one command entry; a missing group, event or `hooks`
key is introduced whole, but spliced in beside its siblings rather than
replacing them, at their own indentation and comma style. A new key is
**appended after its existing siblings**, not inserted at the top. An
unregister escalates the same way in reverse — a group whose command list
would empty is cut instead of its commands, an event whose group list would
empty is cut instead of its groups, and a `hooks` key that would empty is cut
from the file rather than left behind as `{}`.

**Every byte Naru did not semantically change comes through byte-identical** —
a sibling command, another group, another event, key order, indentation,
blank lines and every setting Naru knows nothing about. Directly unit-tested
at each depth an entry can be introduced or removed, including a removal from
the first, middle or last position (taking exactly one separating comma with
it and leaving its neighbours' indentation intact).

Two consequences worth stating:

- Inside **the newly-introduced fragment alone** — never in anything that was
  already there — keys come out **alphabetical**. `serde_json::Map` is a
  `BTreeMap`, and Naru deliberately does not enable the `preserve_order`
  feature: its reach is the whole product, and the CLI's documented `--quiet`
  contract (`CLAUDE.md`) says a rebuilt `serde_json::Value` payload has
  alphabetical keys. One settings key's ordering is not worth changing that.
- The **one** case that does not preserve bytes is a file with no top-level
  entries at all — `{}`, empty, or whitespace only. There is nothing to
  preserve, so a fresh pretty-printed document is written (and the parent
  directory created if needed).

**A settings file Naru cannot understand is refused, never rewritten.**
Invalid JSON, a top level that is not an object, a `hooks` that is not an
object, an event whose value is not an array — each is `validation` naming
the file, with the file left exactly as it was. A best-effort repair would
destroy configuration Naru did not write and cannot reconstruct.

### The task-stop-guard hook

`task-stop-guard` (mesa task 1190, body `core::stop_guard::STOP_GUARD_HOOK`)
is a Claude Code **Stop** hook for *task agents* — sessions the todo-watcher
(or a person) dispatched with the task-execute prompt. Installed through the
ordinary registration flow, user scope:

```
mesa library hook enable task-stop-guard --event Stop
```

which seeds `~/.claude/hooks/task-stop-guard.sh` and names it under `Stop`
in `~/.claude/settings.json`. It needs only `bash`, `jq` and `mesa` on PATH
(`MESA_DB` is honoured, since Naru reads it itself) and **never wedges a
session**: a missing tool, an unreadable transcript, an unknown task or any
Naru error is an allow — exit 0, nothing printed — and `stop_hook_active`
is the loop guard.

It reads the Stop payload's `transcript_path` once. The task id is the
**first** user message — `/execute-mesa-task <id>` (`DEFAULT_TASK_EXECUTE`),
the same slash command recorded as `<command-name>` + `<command-args>`, or
a one-line customised prompt ending in `task: <id>` — that loose form only
in a session launched with `--agent`, which writes an `agent-setting`
header record no interactive session has, so "please take a look at task
1" typed into a plain session is not a task agent; a session whose first
message names no task is left alone either way (the task's `owner` is not
used, being cleared when the task leaves `in_progress`).
Pending background work is every `run_in_background` shell (`Command
running in background with ID: …`) and async `Agent` launch (`agentId: …`)
minus every close — a `<task-notification>` for that id whether it arrived
as a user turn or was absorbed mid-turn into a `queue-operation` record, a
`KillShell`/`TaskStop` naming it, or a subagent hand-back — counted
conservatively. A question is any inbox item with that `task_id` filed at
or after the transcript's first timestamp (`mesa inbox list`, archived
included). Then, off `mesa task show <id>`:

| status | pending work | question filed | verdict |
| --- | --- | --- | --- |
| `in_progress` | yes | — | allow — the harness will wake the agent |
| `in_progress` | no | no | **block**: keep going, close it (`mesa task update <id> --status done\|cancelled`), park it in `todo`/`backlog` with a result, or file the question (`mesa inbox add --task <id> --kind change-request …`) |
| `in_progress` | no | yes | allow |
| anything else | yes | — | **block**, listing the shell/agent ids to stop |
| anything else | no | — | allow |

Waiting on a notification is the legitimate way to wait, which is why
pending work allows rather than blocks — blocking it would force polling.
A block is `{"decision":"block","reason":"…"}` on stdout, exit 0.
`scripts/stop-guard-check.sh` runs the extracted body against synthetic
transcripts and a throwaway `MESA_DB`/`HOME`.

### Hooks wired from outside `.claude/hooks/`

A settings.json command may name a script anywhere — `bash
~/.claude/helios-warm.sh`, `/Users/x/bin/warm.py` — and the library, which
only ever looks at `.claude/hooks/`, cannot see it (mesa task 1128). Naru
does **not** model such a script as a library item: that would need a stored
absolute path on the row, breaking "path is derived, never stored", and a
second containment story beside `resolve`. Instead it **discovers** them and
offers to **adopt** them — move the script into `.claude/hooks/<name>` and
rewrite the command(s) naming it — on the user's explicit action, so every
library item stays in-tree and `resolve` is untouched.

**Discovery** (`core::library::orphan_hooks`, `mesa library hook orphans
[--scope user|project --project P]`, `GET
/api/library/hooks/orphans?scope=&project=`) reads one scope's settings file
and walks every event → group → command. For each command it takes the
**first whitespace-separated token that names a path** — one starting `/`,
`~/`, `$HOME/` or `$CLAUDE_PROJECT_DIR/`, a pair of surrounding quotes
stripped — and expands it: `~/` and `$HOME/` against `$HOME`,
`$CLAUDE_PROJECT_DIR/` against the project's `local_path` (only a
project-scope file has one; in a user-scope file Claude Code supplies it per
session, so such a command is left alone). A `…/env` first token
(`/usr/bin/env python3 ~/x.py`) is passed over as the interpreter shim. It
is the *first* such token whatever its role, so `mytool --config
/etc/x.conf` picks `/etc/x.conf` — read the path before pressing adopt. A
command with no path token (`npm run lint`) is arbitrary shell Naru does not
try to read and is skipped. The expanded path is canonicalised (symlinks in
its existing prefix followed, `resolve`'s own rule) and, if it lands inside
`<scope_base>/.claude/hooks/`, it is the library's already — a registration,
`hook_registrations`'s business — and is **never listed**, whatever spelling
it uses. Everything else is one `LibraryOrphanHook` row per script, however
many events name it: `scope`, `project_id`, `settings_path`, `path` (the
canonical absolute one, the key `adopt` takes), `exists`, `name` (the file's
own name — a hook's name is its whole filename), `registrations[]` (`event`,
`matcher`, `command` verbatim) and `conflict`. A script that is **not on
disk is listed with `exists: false`**, never dropped and never an error: a
registration naming a missing file fires and errors every session, which is
exactly worth seeing. `conflict` says why adoption would be refused right
now — the name would not survive `Store`'s name rule, `.claude/hooks/<name>`
already exists, or a hook item of that name already exists at that scope —
so the page disables the button with the reason rather than offering a press
that 409s. Discovery is a pure read.

**Adoption** (`core::library::adopt_hook`, `mesa library hook adopt <PATH>
[--scope … --project …]`, `POST /api/library/hooks/adopt` `{scope,
project_id, path}`) takes a row's `path` — anything else is `not_found`, as
is a row whose script is not on disk, and a row carrying a `conflict` is
`conflict` — and does, in this order:

1. copies the script to `.claude/hooks/<name>` (through `relative_path` +
   `resolve`, parent directory created, the mode bits and so the executable
   bit kept);
2. rewrites settings.json, replacing in every command naming this script
   **exactly the path token**, original spelling, with the in-tree path —
   the absolute `<home>/.claude/hooks/<name>` at `user` scope,
   `$CLAUDE_PROJECT_DIR/.claude/hooks/<name>` at `project` scope, exactly
   what `register_hook` writes — keeping any prefix (`bash `) and trailing
   arguments (`--fast`). This is a third splice beside the two above,
   `splice_replace_commands`: the one span touched per entry is the
   `command` value's own, so the entry's `type` key, its neighbours, every
   other registration and every unrelated byte come through identical, and
   the write goes through the same re-parse self-check and tmp+rename;
3. removes the original — the path **as the command spells it**, expanded
   but not resolved, so when that is a symlink the link itself goes and its
   target (not Naru's to delete) stays, while the body was read through the
   resolved path;
4. creates the `hook` library row with its sync baseline set, so `sync
   status` reads `in-sync` at once, and answers its `LibraryHookStatus`.

The order is the safety property. **If the settings write fails, the copy is
removed again**, so a failed adoption leaves both the script and
settings.json exactly as they were. Only once settings.json names the new
path is the original removed; a failure *there* is reported (the message
says what to do) and nothing is rolled back, because the state is already
consistent — the file settings.json names exists — and a library sync picks
the copy up as `disk-new`. An existing `.claude/hooks/<name>` is never
overwritten: it is a `conflict` on the read and on the press.

Both surfaces print JSON; neither takes `--quiet` (exit 2, like the trio).
On `#/library` the rows sit in their own section, "Hooks outside
.claude/hooks", read for the user scope and every project with a
`local_path` (`libraryHooks.ts::orphanScopesFor`; a scope whose file Naru
refuses to parse is dropped rather than failing the rest), each with its
scope, path, registrations, a "missing on disk" badge and an **adopt**
button disabled with the reason (`orphanAdoptDisabledReason`). A successful
adoption refetches the items, the registrations and the orphans together,
since all three change at once.

## The sync model

Sync compares three strings per path: the **mesa body** (M, from the item's
`body`), the **disk body** (D, the file's current contents, or absent), and
the **baseline** (B, the item's `synced_body` — the body Naru and the disk
last agreed on, or absent if never synced). `core::library::classify` is the
pure, total function deciding a status from the three:

| condition | status | what a resolution does |
| --- | --- | --- |
| M == D | `in-sync` | nothing — not offered as a resolvable row |
| no file, B is null | `mesa-new` | `mesa`: write the file |
| no file, B == M | `disk-deleted` | `mesa`: re-create the file / `disk`: delete the row — the disk side won, and the disk side is absence |
| B == D, M != D | `mesa-changed` | `mesa`: push M to disk |
| B == M, D != M | `disk-changed` | `disk`: pull D into the body |
| M != B and D != B (or B is null and a file exists) | `both-changed` | the one real conflict — the user picks a side |
| a file with no library row at all | `disk-new` | `disk`: adopt it into the library / left alone otherwise |

`core::library::sync_status` assembles this per project: it starts from
`effective_items` (so a sync scan sees forks *and* unshadowed built-ins),
skips every item with no `path` (a prompt whose `export_command` is off),
resolves each item's file through `resolve`, classifies it, and then walks
`scan_disk` over both scope bases to find `disk-new` files — anything on disk
that no item's path already claimed. A `.claude/commands` file found there
adopts as a prompt with the flag **on** — a sync row exists only for a path,
and a prompt has one only while it exports, so `apply_disk` needs no separate
flag on the row.

**The claimed-path set is keyed by resolved *path*, not by
`(scope, kind, name)`.** `claude-md`'s path does not depend on its name at
all — `.claude/CLAUDE.md` for `user` scope, `CLAUDE.md` at the repo root for
`project` scope, always (see the path table above) — so a name-keyed check
could never recognise that an item already claims `.claude/CLAUDE.md`, and
the same file would be reported twice: once correctly, from the item, and
once as a phantom `disk-new` row from `scan_disk`. Two rows sharing one path
is exactly the shape that must be impossible, since it is also what would let
a caller submit two resolutions for the same file in one `sync_apply` batch.
There is a general invariant test asserting no two rows in one `sync_status`
result ever share a `path`.

### What a row carries besides the three bodies

A `LibrarySyncRow` also reports **when each side last changed** and, for a
two-sided row, **how they differ** (mesa task 1097) — all three derived on
every read, nothing stored:

| field | value |
| --- | --- |
| `disk_mtime` | the file's mtime, in Naru's own `YYYY-MM-DD HH:MM:SS` UTC text (the shape SQLite's `datetime('now')` writes), read off the metadata `read_bounded_with_mtime` already has rather than a second stat. `null` when there is no file, or when the filesystem reports no mtime — a value Naru could not determine is null, never a zero |
| `mesa_updated_at` | the newest `library_versions.created_at` for the item, else its `updated_at` — versions first because `updated_at` also moves on a rename. `null` for an unshadowed built-in (there is no row) and for a `disk-new` row (there is no mesa side) |
| `diff` | a `LibraryDiffLine[]`, `null` unless **both** sides exist *and* differ — so `in-sync` and every one-sided status carry none, and the whole body of the side that exists is the whole story there |

`core::library::diff_lines` computes the diff: a hand-rolled line-level LCS,
no crate and no new route — the row already carries both bodies, so the diff
rides back with them and the *sync modal* never runs a second implementation
of its own (the item list's override diff does, deliberately and for a
different pair of bodies — see above). Each line is `{kind, mesa_line, disk_line, text}` with `kind` one of
`context | mesa-only | disk-only`; line numbers are 1-based and set only on
the side the line exists in, so a mesa-only line has a null `disk_line`. A
replaced line is exactly one `mesa-only` and one `disk-only` — there is no
"changed" kind, because a resolution picks a *side*. Both bodies are split
with `str::lines`, so a missing trailing newline is not a diff line of its
own.

The result is bounded twice, and both bounds degrade to a **marker** line —
`kind: context` with *both* line numbers null, the one line that is not
content from either side — rather than to an error or an unbounded response:
a table over `DIFF_MAX_CELLS` is not built at all (the marker names both line
counts), and a result past `DIFF_MAX_LINES` (2000) is cut, the marker saying
how many lines were dropped.

The diff is **two-way on purpose**: `baseline` rides on the row separately,
and mesa-vs-disk is what a resolution actually picks between — see the next
paragraph.

The modal draws that diff **oriented** (mesa task 1151,
`librarySync.ts::diffOrientation`): the server's lines are always mesa-vs-disk,
but which side's only-lines are red `-` and which green `+` follows the row's
radio. A picked side is where the apply ends, so the diff reads from the side
being overwritten to the pick (`disk` picked: mesa → disk; `mesa` picked:
disk → mesa) and a red line is one the apply removes. While nothing is picked
(`skip`, the default for a `both-changed` row) it reads from the older side to
the newer one by `newerSide`, so a line deleted on disk yesterday shows as a
removal rather than as a mesa addition; with no usable dates it is mesa → disk.
A direction line with the `-`/`+` legend sits above the diff and turns with
the radio. The `diff vs built-in` panel and the version history pass no
orientation and keep their fixed reading.

**There is deliberately no automatic merging and no three-way merge.** The
common case — Claude edited a skill on disk, or the user edited it in Naru —
is one-sided (`mesa-changed`/`disk-changed`), and the baseline is exactly what
makes that classification possible: without it, every difference between M
and D would look identical, whether one side changed or both did. A
`both-changed` row shows the mesa-vs-disk diff (with both whole bodies one
click away) and the user takes a side; Naru never
guesses which half of two independently-changed texts to keep. That is a
deliberate, permanent property of this feature, not a v1 gap.

`core::library::sync_apply` takes a batch of `(path, choice)` pairs — `choice`
is `mesa | disk | skip` — and applies each **independently**: a failing row is
reported in its own `LibrarySyncResult` with an `error`, and the rest of the
batch still applies. A half-written `.claude` from one bad row is worse than a
reported per-row failure, so apply is never all-or-nothing.

**A path repeated within one batch is refused, not applied twice.** The
`status` a batch resolves against is one snapshot taken up front; applying a
second resolution for a path already handled in that same batch would run
against that stale snapshot rather than what the first resolution just wrote
— silently reverting it, a last-write-loses-to-a-stale-read bug, not even a
clean last-write-wins. `sync_apply` refuses the repeat outright instead: the
first occurrence for a path wins, and every later occurrence comes back as
its own failed `LibrarySyncResult` naming the path, rather than a second
write nobody asked for.

`skip` touches nothing, including the baseline. `mesa` writes the body to disk (creating
parent directories) and stamps the baseline — on a `disk-deleted` row this
re-creates the file; a built-in with no db row is written with no baseline
stamp, since it is re-derivable from `BUILTINS` and needs none. `disk` reads
the file into the body, appends a `sync-pull` version, and stamps the
baseline to the same value — on `disk-deleted` it **deletes the row** instead
(the disk side won, and the disk side is absence), and on `disk-new` it
**creates** a row from the file (forking a built-in if the row was one, via
the same `builtin_id`-carrying `create_library_item` call the fork route
uses).

`Store::set_library_synced` (stamps `synced_body`/`synced_at`) deliberately
**does not** move `updated_at` — the `claimed_at` asymmetry held a second
time: recording that Naru and the disk agree is not an edit to what Naru
holds. `Store::pull_library_body` (the `disk` choice's write) does move
`updated_at`, because it *does* change the body.

## Import / export

A library can travel between Naru instances as one downloadable **bundle** —
a JSON document holding the library's *contents*, not its identity. Three new
ts-rs types carry it: `LibraryBundleItem` (`name`, `kind`, `scope`, an
optional `project` **name** — present iff `scope` is `project` — `body`, an
optional `builtin_id`, and `export_command`, absent in a pre-1139 bundle and
read as off — see [Prompts that are also slash
commands](#prompts-that-are-also-slash-commands) for the `command` shim), `LibraryBundle` (`version`, `exported_at`, and a
`Vec<LibraryBundleItem>`), and `LibraryImportResult` (the per-item outcome of
an import, the same posture as `LibrarySyncResult`).

**Export carries db rows only — never an unshadowed built-in.** A built-in is
code (`core::library::BUILTINS`), identical on the receiving instance by
construction, so exporting it would be noise that imports as a pointless
fork. A *forked* built-in is exported, and carries its `builtin_id` so it
lands as a fork on the far side too — the fork/restore rule holds across
instances, not just within one. Scope of an export follows `list`'s own
visibility rule: no project scopes to `user`-only rows, a project scopes to
that project's rows plus every `user`-scope row.

**What never travels, and why:** `id`, `created_at`, `updated_at`, `path` and
version history are all machine-local or derived — an id and timestamps mean
nothing on another instance, `path` is recomputed from `(kind, scope, name)`
on arrival, and history is a list of *past* contents, while a bundle carries
only current ones. Above all, `synced_body`/`synced_at` never travel: the
sync baseline is a fact about *this machine's* disk, and shipping it to
another machine would assert an agreement that machine's disk never actually
reached. A `project`-scope item travels by the project's **name**, resolved
against `Store::find_project_by_name` on import — ids are machine-local, and
an unknown name fails that one item rather than the whole batch.

**Import is per-item, exactly like `sync_apply`, with one whole-bundle
exception.** An unknown `version` refuses the entire bundle up front
(`validation`) — the one all-or-nothing check, because there is no format to
interpret an item against. Past that, each item resolves independently
against any existing row at its `(kind, scope, project, name)` — and, failing
that, against the existing fork of its `builtin_id`. None existing creates
it; one existing is a **conflict**, and the conflict is *shown and picked*,
not decided by a batch-wide policy (mesa task 1292).

**A conflict is previewed, then resolved per item.** `POST
/api/library/import/preview` (`core::library::import_preview`, `mesa library
import <path> --preview`) answers one `LibraryImportRow` per bundle item in
one of **four** statuses: `new` (nothing here claims it), `identical` (a row
holds it byte for byte), `conflict` (a row holds it with a different body) or
`unresolvable` (the item could not be matched at all — an unknown project
name, a scope/project pairing the bundle got wrong — and importing it would
fail the same way). The row carries both bodies, when the local side last
changed, and — for a `conflict` alone, `LibrarySyncRow`'s own rule — the
line-level `diff` between them, computed by the same `diff_lines` a sync
row's is. `unresolvable` is its own status rather than a `new` row wearing an
`error`, because the JSON *is* the interface on this surface: a caller
counting `new` rows to learn what an import would create must never be handed
an item that is going to fail. The variant says *that* it cannot resolve;
`error` still says why. It **writes nothing**; it is the read a person
makes before choosing. It is a *server-side* preview on purpose: the rule
matching a bundle item to an existing row is import's own (that `builtin_id`
fork fallback is not something a browser could guess), so
`resolve_existing` is factored out and both the preview and the apply go
through it — one matching rule, or the preview would be a preview of a
different import.

The apply then takes a `resolutions` array beside `on_conflict`: each entry
names one item by its **identity** — `(name, kind, scope, project)`, never
its index in the bundle, which would silently resolve the wrong row the
moment a caller reordered what it previewed — and carries the same two words,
`skip` (keep the existing row) or `replace` (take the imported body,
overwriting its body only, never its name and never the sync baseline). An
item no resolution names falls back to the batch-wide `on_conflict`, so a
caller sending none behaves byte-identically to how import always has. The
web page sends one resolution per conflicting row and renders the whole
thing through the **same diff-and-pick component the sync modal uses**
(`LibraryDiffPick` in `LibraryView.tsx`, labelled `local`/`imported` here and
`mesa`/`disk` there) — the surfaces ask the same question of two bodies, so
they ask it once.

**The preview is a snapshot, and the apply re-resolves — deliberately.**
Unlike `sync_apply`, which takes its `sync_status` scan inside the same call
it applies against, a preview and its import are two separate HTTP calls, and
nothing is held between them: no lock, no body hash, no precondition. Every
item is matched again by `resolve_existing` at apply time, so a `replace`
resolves against the local body **as it is then**, not as it was previewed —
if a concurrent CLI write or another browser tab changed that row in
between, the body overwritten is one the person never saw in the diff. That
is accepted rather than fixed: Naru is a single-user local tool, the exposure
is no worse than the batch-wide `on_conflict: replace` this replaced (which
overwrote without showing anything at all), and a subtly wrong optimistic
concurrency check would cost more than the race does. The same goes for a row
*created* between the two calls, which previews as `new` and imports as a
conflict decided by the fallback `on_conflict` — `skip`, so it lands on the
harmless side.

`on_conflict` still defaults to `skip`, and so does every conflicting row's
pre-selected pick, for the same reason: import is something a person runs
deliberately, often to *pull in* items from elsewhere, and a body they
already have replaced out from under them with no warning is the more
dangerous default. Taking the imported side is opt-in, now per item rather
than per call.

Every failure stays per item, `sync_apply`'s posture: a bad project name or
any other `Store` rejection (the name rule, the body cap) fails only that
item; an unrecognised choice fails only that item, and an item that would
fail to resolve at all previews as `unresolvable` with its `error` set rather
than as a plain `new` row, so the page shows it as unresolvable instead of
offering a choice nobody could apply; a resolution naming an item this bundle does not
carry — or a second resolution for an item already resolved, `sync_apply`'s
"only the first is applied" rule — is reported as its own `failed` result
while the rest of the batch still applies. The CLI deliberately has no
per-item resolve flag: the pick is made against a diff, which is a thing to
read rather than to type, so `--preview` reports and the web flow decides.

**Import never touches disk.** It writes rows the same way `create`/`update`
do, and nothing more — no file is written, no baseline is stamped. A freshly
imported row therefore has a null `synced_body`, so the very next `sync
status` reports it honestly: `mesa-new` if nothing sits at its path yet, or
`both-changed` if a file already does. That is correct, not a gap — Naru and
this machine's disk have never actually agreed on that row's contents, and
the sync model must not pretend otherwise just because the row arrived from
somewhere else.

## Gate posture

| Route | Success | Gate |
| --- | --- | --- |
| `GET /api/library` (`?project=<id>`) | 200, bare array (`effective_items`) | `require_agent_access` |
| `POST /api/library` | 201 | `require_agent_access` |
| `GET /api/library/{id}` | 200 | `require_agent_access` |
| `PATCH /api/library/{id}` | 200 | `require_agent_access` |
| `DELETE /api/library/{id}` | 200, destroyed record | `require_agent_access` |
| `GET /api/library/{id}/versions` | 200, bare array | `require_agent_access` |
| `GET /api/library/{id}/hook` | 200, the `LibraryHookStatus` | `require_agent_access` |
| `POST /api/library/{id}/hook` (`{"event", "matcher"?}`) | 200, the status after the write | `require_agent_access` |
| `DELETE /api/library/{id}/hook` (`?event=&matcher=`) | 200, the status after the write | `require_agent_access` |
| `POST /api/library/builtins/{builtin_id}/fork` | 201 | `require_agent_access` |
| `GET /api/library/sync` (`?project=<id>`) | 200, bare array | `require_agent_access` |
| `POST /api/library/sync` | 200, results array | `require_agent_access` |
| `GET /api/library/export` (`?project=<id>`) | 200, the `LibraryBundle` | `require_agent_access` |
| `POST /api/library/import` | 200, results array | `require_agent_access` |
| `POST /api/library/import/preview` | 200, bare array of `LibraryImportRow` | `require_agent_access` |
| `GET /api/library/hooks/orphans` (`?scope=&project=`) | 200, bare array of `LibraryOrphanHook` | `require_agent_access` |
| `POST /api/library/hooks/adopt` (`{"scope", "project_id", "path"}`) | 200, the new row's `LibraryHookStatus` | `require_agent_access` |

**All seventeen routes are `require_agent_access`** (mesa task 1004; the
hook-registration trio joined them in mesa task 1115, the orphan pair in
mesa task 1128, the import preview in mesa task 1292) — the same
gate the agents, terminal and scripts-run routes carry. This is not a
read/write split: unlike scripts (`docs/scripts.md`'s "the read/write
asymmetry is the point", where a LAN peer may *trigger* a stored script but
never *author* one), every route on this surface is treated alike, because a
row's `body` **is** an agent definition, a hook shell script or a CLAUDE.md —
the same bytes the sync routes read straight off disk, only after they have
been stored in the database (a bundle is just every one of those bytes at
once). There is no coherent line to draw between reading such a row and
writing one.

What that gate means, per mode:

- **Default (`mesa serve`)** — a **loopback TCP peer** (`require_loopback`),
  **plus** a local `Host` (`require_local_host`) **plus** a local `Origin`
  (`require_local_origin`). That is *strictly stronger* than the loopback-only
  check this surface used to carry (`require_local_path_write`, removed
  outright by mesa task 1022), which checked the peer alone and leaned on the
  router-wide `guard` for the Host.
  Nothing about the ordinary single-machine install loosened; a cross-site
  page's `Origin` is now refused by the route itself.
- **`--lan` (`mesa serve --lan`)** — the peer check *relaxes*: a browser on
  the network reaches the library, so the Library page actually works from
  the phone or tablet `--lan` exists to serve. Both confused-deputy defenses
  stay shut — `require_lan_agent_host` (the `Host` must be `localhost` or an
  IP literal on our port — or one of the exact hostnames `serve --lan
  --allow-host <name>` named — so a DNS-rebinding page is refused) and
  `require_origin_matches_host` (a browser `Origin` must equal that vetted
  `Host`). The Content-Type gate on mutations is unchanged in both modes.
  Neither defense is authentication, and neither is claimed to be: they stop
  a *browser* being used as a confused deputy, and nothing more. A
  non-browser client on the network — a `curl` sending an IP-literal `Host`
  on our port and no `Origin` at all (every `Origin` check in `api.rs`
  returns `Ok` on a missing header) — is served, exactly as it already is by
  `/api/terminal` and `POST /api/scripts/{id}/run`. That *is* the `--lan`
  posture rather than a gap in it, which is the whole of the reasoning below.

The reasoning for the relax: `--lan` is already an explicit, no-auth "trust
every device on this network" posture, and under it that network is handed a
terminal (`/api/agents`), a shell (`/api/terminal`) and script execution
(`POST /api/scripts/{id}/run`). Refusing that same network the library rows
while granting it the shell was a distinction with no security content — the
peer that can run anything gains nothing by being denied the catalogue, and
loses the entire page. This is the posture `POST /api/live/transcribe` took
for the same reason (`docs/live.md`, `docs/listen.md`): `require_agent_access`
relaxes rather than refuses. **mesa task 1022** finished the job: the
scripts' *authoring* routes, the `local_path` write, `GET`/`POST
/api/fs/dirs` and the CC index reset — the last routes still loopback-only in
both modes — moved onto this same gate for the same reason, and
`require_local_path_write` was deleted. Nothing in the API is loopback-only
in both modes any more.

**How the boundary is actually proved.** A same-machine `curl` to `127.0.0.1`
cannot exercise the peer-address half of any of this, in either serve mode:
in default mode the global `guard` middleware refuses a foreign `Host` for
every route before the per-route gate is ever reached, and under `--lan` a
loopback-connected `curl` makes the relaxed and strict gates identical. So
`scripts/library-check.sh` proves only the *portable* half — a DNS-name
`Host` (rebinding) and a foreign `Origin` (cross-site) refused under `--lan`,
a foreign `Host` and a foreign `Origin` refused in default mode, on all
seventeen routes. The genuinely remote-peer case — does a LAN device now get
*in*, and does a rebound one still get turned away — can only be proved with
a forged non-loopback `SocketAddr`, which a shell script driving a real
`curl` cannot produce. That is a Rust unit test,
`lan_page_may_read_and_author_the_library_but_not_from_a_rebound_page` in
`src/api.rs` (with
`lan_page_may_import_the_library_but_not_from_a_rebound_page` for the bundle
half), mirroring `lan_page_may_author_a_script_but_not_from_a_rebound_page`: it
calls `list_library`/`show_library`/`list_library_versions`/`export_library`
and `create_library` directly with `ConnectInfo` set to a LAN address and
asserts they now succeed, that the same peer behind a DNS-name `Host` or a
foreign `Origin` is still refused, and that in default mode that peer reaches
neither a read nor a write. Do not "strengthen" the shell gate into asserting
this instead; against a loopback `curl` it cannot fail, so it would prove
nothing.

## The CLI

`mesa library {create,list,show,update,delete,versions,hook,sync}` (`show` also
answers to `get`). An `ITEM` argument, everywhere one appears, is a numeric id
or a name — a built-in resolves by name too, since its name and its
`builtin_id` are the same string in the starter set
(`resolve_library`/`library::effective_items`).

- `create` takes `KIND`, `NAME` and `BODY`, each positionally or as
  `--kind`/`--name`/`--body`, plus `--body-file <PATH>` (`-` = stdin) as a
  third way to supply the body — the same three-way choice a task's
  `--description-file` offers. `--scope` is `user|project`, defaulting to
  `user`; `--project <id-or-name>` is required iff `--scope project`.
  `--export-command` sets a prompt's flag (`validation` on any other kind).
- `update ITEM` requires at least one of `--name`, `--body`,
  `--body-file`, `--export-command`, `--no-export-command` (an `ArgGroup`,
  so no field flag is `usage`, exit 2; the last two conflict); both `--name`
  and `--body` are replace-only, mirroring `script update`. Updating an
  unshadowed built-in **forks** it rather than failing — a new db row appears
  carrying its `builtin_id`, with the flag as given.

- `delete ITEM` has no confirmation and echoes the destroyed record — the
  recoverable transcript that stands in for the prompt Naru doesn't have.
  Deleting the fork of a built-in restores it unshadowed; deleting an
  unshadowed built-in (there is no row) is `validation`.
- `list [PROJECT] [--kind KIND]` and `versions ITEM` print bare JSON arrays —
  `list` by kind then name, `versions` newest first (empty for an unshadowed
  built-in, which has no history).
- `sync status [PROJECT]` prints one `LibrarySyncRow` per path as a bare JSON
  array — including `disk_mtime`, `mesa_updated_at` and, for a two-sided row
  that differs, the `diff`. There is deliberately no `--diff` flag and no
  second subcommand: CLI output is JSON only, so the fields on these rows
  *are* the CLI exposure. `sync apply [PROJECT]` takes either repeatable
  `--resolve PATH=naru|mesa|disk|skip` flags (`naru` and `mesa` are one
  choice, echoed as given, while `--all-naru`/`--all-mesa` report the choice
  as `mesa`) or one of `--all-naru` (alias
  `--all-mesa`)/`--all-disk` (resolve every non-`in-sync` row toward one
  side at once) — the three are
  mutually exclusive — and prints the resulting `LibrarySyncResult[]`.
- `hook status ITEM`, `hook enable ITEM --event EVENT [--matcher M]` and
  `hook disable ITEM [--event EVENT] [--matcher M]` read and write the
  `.claude/settings.json` registration described above; all three print the
  same `LibraryHookStatus` object, so `enable`/`disable` report the file's
  state *after* their write. `ITEM` must be a `hook`; anything else is
  `validation`. `disable` with no `--event` removes every registration of
  that hook.
- `hook orphans [--scope user|project] [--project P]` lists the hook
  commands in that scope's settings.json whose script lives outside
  `.claude/hooks/` (a bare `LibraryOrphanHook[]`, "Hooks wired from outside
  `.claude/hooks/`" above), and `hook adopt <PATH> [--scope …] [--project …]`
  moves one in, rewrites its command(s) and creates the row, printing the
  new row's `LibraryHookStatus`. `--scope` defaults to `user`; `--project`
  is required with `project` and refused with `user`, `create`'s own rule.
- `export [PROJECT] [--project P] [--output PATH]` prints the `LibraryBundle`
  JSON to stdout by default; `--output PATH` writes it there instead (refusing
  to clobber an existing path, mirroring `backup`) and prints
  `{"path": "...", "items": <n>}`. `PROJECT`/`--project` is the same
  positional-or-flag pair `list` takes.
- `import <PATH> [--on-conflict skip|replace] [--preview]` reads a bundle from
  `PATH` (or `-` for stdin, the `--body-file` convention) and prints the
  resulting `LibraryImportResult[]` as a bare array; a malformed or
  unparseable bundle is `validation`, exit 1. `--on-conflict` defaults to
  `skip`. `--preview` (mesa task 1292, conflicting with `--on-conflict`)
  prints the `LibraryImportRow[]` instead and **writes nothing** — every
  item's status, both bodies and, for a real conflict, the diff. There is
  deliberately no per-item `--resolve` flag to go with it, unlike `sync
  apply`'s: a pick is made *against a diff*, which is a thing to read rather
  than to type, so the CLI reports and the web page decides.

`--quiet` follows the house rule (`CLAUDE.md`): accepted on `create`,
`update`, `delete` and `show`/`get`, dropping `body` and `synced_body`
(`QUIET_DROP_LIBRARY`) while keeping `name`, `kind`, `scope`, the bounded
`export_command` flag and the derived `path`; **not defined at all** on `list`, `versions`, any `hook` or `sync`
subcommand, or `export`/`import`, so passing it there is clap's
unknown-argument error, exit 2 — those commands answer with a bundle, a
results array or a status, not a record, so there is nothing for `--quiet` to
project.
On `update` it sits outside the required field `ArgGroup`, so `--quiet` alone,
with no field flag, is still the usage error rather than a legal no-op call.

## Where the live prompt went

`~/.mesa/config.json`'s `live.prompt` (mesa task 867, `docs/config.md`) is
**gone**, not shadowed — the library is the only place the live agent's
instructions live now. Since mesa task 1068 they are the `naru-live` **agent
definition** (kind `agent`, user scope) rather than the `live-agent-prompt`
*prompt* they were between tasks 919 and 1068: `core::live::AGENT_DEFINITION`
is YAML frontmatter (`name`, `description`, `model`, `effort` — and no
`tools:` line since mesa task 1350, so the agent inherits every tool,
including the image reader `naru live look` needs and the `Agent` tool rule
12 delegates long jobs through, mesa task 1156) followed by `core::live::AGENT_PROMPT`,
the loop text, unchanged.

Being an `agent` rather than a `prompt` gives it a real path,
`.claude/agents/naru-live.md`, so it rides the ordinary sync flow like every
other agent definition instead of being invisible to it. The `live-agent`
command template spawns `claude --bg --agent naru-live …`
(`core::config::DEFAULT_LIVE_AGENT`), and Claude Code errors on an agent it has
never seen, so **the first spawn seeds the file**:
`core::live::ensure_agent_definition(store)` runs at both spawn sites
(`api.rs`'s `spawn_live_agent`, `cli.rs`'s `LiveCmd::Start`) before
`agents::spawn_bg`. It resolves the effective row — the fork
(`store.find_library_fork("naru-live")`) if there is one, the built-in
otherwise — computes the target through this module's own `relative_path`,
`scope_base` and `resolve`, so `$HOME` is honoured and the traversal check
holds exactly as it does on the sync path, creates the parent directory, and
writes the body.

It **never overwrites an existing file**. After the first seed the file belongs
to the sync flow, where a difference between disk and Naru is a row the user
resolves; rewriting it on every start would make one side of that decision
impossible to keep. A failure (no `HOME`, an unwritable `.claude`) is returned
as an error and both spawn sites treat it exactly like a failed spawn —
`unavailable`, and the session that was just opened is ended again.

What `core::live::agent_prompt(store, session_id)` injects is now only what the
definition cannot know: `Drive naru live session <id> (lease <n>).`, plus the recall block
of earlier session summaries when there are any. Forking `naru-live`
**replaces** the built-in rather than extending it — the same rule the old
config key followed, just moved: what the forked row holds is the whole of what
the agent is.

`config.rs`'s `LiveSection` now holds one key, `auto-send-ms`
(`docs/config.md`); a `live.prompt` key left behind by an older Naru, or
hand-edited into the file, is **silently ignored** — never an error, and never
read from — because the struct simply has no field for it any more.

### And where the summariser's went

`live-summary-prompt` (mesa task 921) is still a `prompt`: nothing spawns the
summariser *by name*, so it has no reason to be an agent definition, and —
being mesa-internal — it has no on-disk path either (`relative_path` answers
`None` for a prompt whose `export_command` is off, which a built-in's always
is). `core::live::summary_prompt(store,
session_id)` resolves it the way the live agent's block used to be resolved: a
fork of `live-summary-prompt` if one exists, else `core::live::SUMMARY_PROMPT`.
**A store error resolving the fork also falls back to the built-in** rather
than failing the call: a database hiccup must not be what stops the short-lived
summariser from being spawned, and the very next step is `agents::spawn_bg`
reading the same store for the command template, which reports *that* failure
as `unavailable` if the database is genuinely unreachable — so a real problem
still surfaces once, not twice. It never existed as a config key in the first
place, so there is nothing here for an old `config.json` to leave behind.

## Gate

`scripts/library-check.sh` (123 checks) covers, over both the CLI and the
API:

- **CRUD**: create (positional and flag forms, `--body-file`, the name-rule
  rejections — `../evil`, `a/b`, `..`, `.`, empty — as 422/`validation`,
  a duplicate `(kind, scope, name)` as 409/`conflict`), list (bare array,
  `--kind`/`?project=` filtering), show/get (case-insensitive name
  resolution, an unknown id/name as 404/`not_found`), update (one field at a
  time, an explicit `null` name/body refused as an erasure) and delete
  (echoes the destroyed record, a later read is `not_found`).
- **`--quiet`**: exactly `body`+`synced_body` dropped on `create`/`show`/
  `update`/`delete`, and rejected as an unknown argument (usage, exit 2) on
  `list`, `versions`, `sync status` and `sync apply`.
- **The built-in fork/restore rule**: editing an unshadowed built-in
  (`stop-notify` is the fixture) forks it — `list` stops offering it
  unshadowed the moment the fork exists — deleting the fork restores it
  unshadowed with its original body, and deleting an unshadowed built-in
  (nothing to delete) is `validation`.
- **Version history**: creation writes version 1 (`source: edit`), a real
  body change appends a version, a no-op update and a rename with the body
  unchanged append none, and an unshadowed built-in's history is an empty
  array (no row, no history).
- **The full sync loop**: every status in the table above, reached by
  actually manipulating the file and the Naru row (a fresh item with no file
  is `mesa-new`; applying `mesa` writes it and the next scan reports
  `in-sync`; editing the file reports `disk-changed`, and applying `disk`
  pulls it in and appends a `sync-pull` version; editing the body reports
  `mesa-changed`, and applying `mesa` pushes it back out; an unclaimed file is
  `disk-new`, and applying `disk` adopts it into a new row; a `disk-deleted`
  row's `mesa` re-creates the file and its `disk` deletes the row; a
  `both-changed` row shows both bodies, and `skip` leaves both sides and the
  status untouched on the next scan).
- **The API DTOs and status codes** for all seventeen routes, a malformed JSON
  body as 422 (never a 500), and every mutating route (create, update,
  delete, fork, sync apply, import, import preview) refusing a request with no
  JSON `Content-Type` as 415.
- **The `require_agent_access` gate, on all seventeen routes, reads included**,
  in both `default` and `--lan` serve modes: in default mode a foreign `Host`
  and a foreign `Origin` are each refused (a request with no `Origin` at all —
  curl, or a same-origin browser GET — is fine); under `--lan`, a DNS-name
  `Host` (rebinding) and a foreign `Origin` (cross-site) refused while a
  genuinely local Host+Origin — including a loopback peer authoring, not just
  reading — still succeeds; every refused request leaves the row untouched;
  and the Content-Type gate still fires under `--lan` too. This is the *portable*
  half of the boundary a shell script can prove — see [Gate posture](#gate-posture)
  above for why the peer-address half needs a Rust test instead.
- **Import/export round trip**: exporting a library holding a user row and a
  forked built-in produces a bundle containing both, containing no unshadowed
  built-in, and with no item carrying an `id`, a `synced_*` key, or
  `created_at`; importing that bundle into a second, empty `MESA_DB`
  reproduces the rows with byte-identical bodies, the fork still carrying its
  `builtin_id`, and the built-in it shadows no longer offered unshadowed.
  Re-importing the same bundle with the default `on_conflict` reports every
  item `skipped` with bodies untouched; re-importing with `--on-conflict
  replace` after editing the source reports `replaced` with the new body
  present. A project-scoped item whose project does not exist on the
  receiving instance is `failed` on its own, with the rest of the batch still
  applied. A bundle carrying an unknown `version` is refused whole
  (`validation`, exit 1, nothing written). `--quiet` on `export` and on
  `import` is the unknown-argument error, exit 2. `--output` to a path that
  already exists refuses rather than overwriting.
- **The live conversation's agent definition coming from the library**:
  `naru-live` starts unshadowed (`id: null`, kind `agent`, path
  `.claude/agents/naru-live.md`) and appears in `sync status`; `sync apply`
  with mesa winning writes it to `$HOME/.claude/agents/naru-live.md`; editing
  it forks it (`builtin_id: naru-live`, `id` no longer null); and the prompt that
  `mesa live start` spawns the stub `claude` with carries the session line
  only — never the loop text, which now travels as the definition.
- **Hook registration**: `status` on a fresh hook reporting its settings
  file, its command and the nine-event vocabulary; `enable` registering it
  under one event **and seeding the hook's own script to disk**, executable,
  where nothing had written it — and never overwriting one that is already
  there; a following `status`, reading the file back, seeing it; `disable`
  removing it and giving the settings file back **byte-identical**, asserted
  with `cmp` against a copy taken before the enable of a file that already
  held an unrelated top-level key, an unrelated block and somebody else's own
  `PreToolUse` hook (each of which survives the enable); a second `disable`
  as a no-op success touching nothing; a `"hooks": null` file read as an
  empty one by both verbs rather than refused; a mistyped event naming the
  vocabulary, a non-hook item and an unknown item each exit 1; and `--quiet`
  rejected on all three subcommands (usage, exit 2, empty stdout).
- **Hooks wired from outside `.claude/hooks/`** (mesa task 1128): against a
  settings file holding an unrelated key, somebody else's registration, an
  in-tree `.claude/hooks/` command, `bash $HOME/scripts/warm.sh --fast`
  under two events and a `~/gone/missing.py`, `hook orphans` listing exactly
  the two out-of-tree rows (`exists` true/false, two registrations on the
  first, the in-tree one absent); `adopt` on the missing one exit 1
  `not_found`; a pre-created `.claude/hooks/warm.sh` making it `conflict`
  with the settings file untouched (`cmp`); then a real adoption — source
  gone, destination present and executable, both commands now naming the
  in-tree path with `bash ` and `--fast` kept, the file otherwise
  **byte-identical** (`cmp` against a `sed` of the original), `hook status`
  on the new item seeing both registrations and `sync status` reading
  `in-sync`, `orphans` no longer listing it; `--quiet` rejected on both;
  and the two routes serving over the API and joining the gate sweeps (now
  seventeen routes) in both serve modes.
- **The command kind folded into prompt** (mesa task 1139): a db wound back
  to the pre-1139 schema with `sqlite3` and holding a `command` row with two
  versions opens as a prompt with `export_command` on — same id, path, body,
  baseline and history, no `command` row surviving, listed under `--kind
  prompt`; `--export-command` on a non-prompt and `create command` are each
  `validation` (422 over the API, the retired kind included); an exporting
  prompt's file is **byte-identical** to its body (`cmp`) and `sync status`
  reads `in-sync` on the very next scan; a prompt with the flag off has no
  path and is absent from the scan; `--no-export-command` removes the file
  Naru wrote and clears the baseline, but leaves a hand-edited one for the
  scan to report `disk-new`; `--quiet` keeps the flag; `PATCH` carries it;
  and a bundle still saying `"kind": "command"` imports as an exporting
  prompt while a fresh export carries the flag.

The same pairing `api-check.sh` holds for tasks and `config-check.sh` holds
for the config-write routes. The "a configured prompt replaces the built-in
at spawn" assertion that used to live in `config-check.sh` lives here now,
proved through the `naru-live` library row instead of a config key.
