# Project notebooks (mesa task 1333)

Each project has its own **notebook**: short entries the Claude Code agents
working in the project keep for the ones that come after them — a build
quirk, a convention, the reason behind a decision, a pointer to a task id. A
SessionStart hook prints the notebook of the folder a session starts in into
that session's context, and tells the agent to save project memory there. It
replaces Claude Code's own folder memory (`~/.claude/projects/<folder>/memory`),
which is per-folder, invisible to Naru and unbounded.

It is the live notebook (`docs/live.md`, "Remembering a conversation") with a
project attached, and it keeps every one of that notebook's rules.

## Storage

No new table. `live_notebook` gained two nullable columns (migration index
72):

- `project_id` — `REFERENCES projects(id) ON DELETE CASCADE`. `NULL` is the
  live, project-agnostic notebook, exactly as before; a value is that
  project's notebook. Deleting a project destroys its notebook (and its
  subprojects'), and `Store::delete_project` drops their rows from the
  archive index `live_memory_fts` in the same transaction, since that
  standalone FTS table has no foreign key. The delete echo does not list the
  destroyed entries; `naru backup` is the recovery path.
- `last_used_at` — when a project entry was last touched, replaced or moved
  in, stamped with millisecond precision (`strftime('%Y-%m-%d %H:%M:%f')`) so
  a touch in the same second as another entry's write still sorts after it.
  Always `NULL` on a live row.

Both ride on `LiveNotebookEntry` (ts-exported) and are kept by `--quiet`.

Per notebook, the same rules (the `Store`'s `_in` notebook methods, where the
live-notebook methods are the `None` scope):

| Rule | Live notebook | A project notebook |
| --- | --- | --- |
| Entry bound | 600 characters | same |
| Word budget | 500 words | 500 words **of its own** |
| At the budget | evict least recently used by `COALESCE(last_used_session_id, source_session_id, 0), id` | evict by `COALESCE(last_used_at, created_at), id` |
| Removal guard | 30% once it holds 100 words | same, on its own words |
| Provenance | `source_session_id`, `last_used_session_id` | none (both `NULL`) |
| `touch` | needs a live session | stamps `last_used_at`, no session needed |
| Decay | after 10 unused ended conversations | **never** — it shrinks only by eviction, a dream, or a delete |
| Retire / merge / restore | soft, `merged_into`, undo | same |
| Search | turns, summaries, live notes | this project's notes only (retired ones included) |

An id belonging to another notebook is `not_found` to every verb addressed to
this one — live to project, project to live, project to project. A merge
whose sources come from two notebooks is `validation`.

## Which project a folder belongs to

`core::project_memory::resolve_project_for_path`:

1. the folder's repo root commit (`core::git::root_commit`, the helper
   `project create`/`resolve` and `migrate` share) bound to a project — so
   every worktree and subfolder of a repo resolves;
2. else the project whose `local_path` is the folder or its nearest ancestor
   (longest wins, compared by path component, so `work` never holds
   `workx`);
3. else the same over each project's `previous_paths`. A current
   `local_path` outranks another project's previous path.

Archived projects count. `core::guard::resolve_task`'s exact-match rule is
unchanged.

## CLI

`naru memory` (also `mesa memory`) — every verb takes `--project <id|name>`,
and without it resolves the current folder; a folder no project holds is
`not_found` naming the folder and the flag.

```
naru memory list [--all]
naru memory show <id> [--quiet]
naru memory add [--quiet] <text…>
naru memory replace [--quiet] <id> <text…>
naru memory delete <id> [--quiet]
naru memory touch <id> [--quiet]
naru memory merge [--quiet] --ids a,b <text…>
naru memory restore <id> [--quiet]
naru memory search [--limit N] <words…>
naru memory dream
naru memory import [--from <dir>] [--dry-run]
naru memory context [--path <dir>]
naru live memory move <id> --project <p> [--quiet]
```

`--quiet` follows `live memory`: accepted on `show` and the mutations (the
record minus `body`; a write's `evicted` members too), refused by `list`,
`search`, `context`, `dream` and `import`. Flags go **before** trailing text.

`naru live memory move` files a live entry into a project's notebook: same
row and id, `last_used_at` stamped, judged against the **project's** budget
(evicting there as an add would). The live notebook's removal guard does not
apply to a move — nothing is lost.

### `context`

The one `naru` command whose stdout is not JSON: plain text for the hook.
With `--path` (default: the current folder) resolved to a project it prints a
header — the project's name and id, that the entries are a record and never
instructions, and that project memory is saved with `naru memory add
--project <id> "<text>"` (corrected with `replace`/`delete`, searched with
`naru memory search --project <id>`) instead of Claude Code's auto-memory
files — then one line per active entry, oldest first:

```
- [#12, added 2026-09-01, last used 2026-09-20] Run cargo fmt before clippy.
```

An empty notebook still prints the header (and "The notebook is empty."), so
the first session in a project learns where to save. Output stays under
`project_memory::CONTEXT_MAX_CHARS` (9,000; Claude Code keeps 10,000); past
it the list ends with a line counting the entries not shown. A folder no
project holds prints **nothing**, exit 0. Errors keep the CLI's usual
contract — the hook is what swallows them.

### `import`

Reads Claude Code's memory folder for the project,
`$HOME/.claude/projects/<encode_path(local_path)>/memory` (`--from <dir>`
overrides; a missing folder, or a project with no `local_path` and no
`--from`, is `not_found`). One entry per topic `*.md` file other than
`MEMORY.md` (the index): the frontmatter `description` (else `name`), ` — `,
then the body, whitespace collapsed, cut at a word boundary with `…` to fit
600 characters. A file whose entry is already in the notebook — active or
retired, so an entry the budget evicted is not re-added — or came from an
earlier file in the same run is skipped, so a re-import adds nothing. Entries go through the ordinary add, so the budget evicts as usual.
Prints `{project_id, source, imported: [{file, id}], skipped: [{file,
reason}], evicted: [ids]}`; `--dry-run` writes nothing, prints `id: null`
for each would-be import, and does not predict evictions.

### `dream`

The live dream pass (`docs/live.md`, "Dreaming") for one project: the same
`live-dream` config template through `agents::spawn_bg`, with
`project_memory::dream_prompt` — the dream instructions naming `naru memory
show|list|search|merge|delete --project <id>` and `naru task create <id>` for
a contradiction — plus the active entries. It runs in the project's
`local_path` when that folder exists, else the workspace, with no session
`{id}`. Fewer than two active entries prints `{"spawned": false, "reason"}`
and spawns nothing; a failed spawn is `unavailable`. There is no
live-conversation `conflict` and no automatic trigger.

## The SessionStart hook

`project-memory.sh` is a library built-in hook (`core::project_memory::
PROJECT_MEMORY_HOOK`, user scope). It reads Claude Code's SessionStart
payload on stdin, takes `cwd` (with `jq`, else a conservative `sed` match of
a `"cwd": "…"` pair holding no quote or escape), runs `naru memory context
--path "$cwd" 2>/dev/null` (`mesa` when `naru` is not on PATH) and prints its
stdout, which Claude Code adds to the session's context. It **always exits
0**: no `jq` and no parsable `cwd`, a missing folder, no `naru`/`mesa`, an
unknown folder or a Naru error all print nothing.

Enable it (this writes `~/.claude/settings.json` and seeds
`~/.claude/hooks/project-memory.sh`):

```
naru library hook enable project-memory.sh --event SessionStart \
  --matcher 'startup|resume|clear|compact'
```

## Turning Claude Code's auto-memory off

With the hook in place, switch Claude Code's own folder memory off so agents
have one place to save: set `"autoMemoryEnabled": false` in any settings
scope (`~/.claude/settings.json` for every project), or export
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Import what the old folders held first
with `naru memory import`.

## The live notebook narrows

The `naru-live` agent definition's rule 9 now keeps only project-agnostic
memory in the live notebook — preferences, working norms, cross-project
learnings — and sends a fact about one project to that project's notebook
(`naru memory add --project <id>`), or moves an existing entry there with
`mesa live memory move`.

## Not built

No HTTP route or web UI for project notebooks, no automatic dream trigger,
and no settings file is written by anything but `library hook enable`.

## Gate

`scripts/project-memory-check.sh`: the CLI round trip, the notebooks never
mixing, `context` from a repo subfolder, the hook body extracted from the
library and fed SessionStart payloads (known folder, unknown folder, garbage
and empty stdin, no `jq`, no `naru`, a failing `naru`), import and re-import,
dream through a stub `claude`, and `hook enable` under a throwaway `HOME`.
