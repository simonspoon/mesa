# Library (agents, skills, hooks, commands, prompts, CLAUDE.md)

mesa stores Claude Code's agent definitions, skills, hooks, commands, and
CLAUDE.md files as first-class records — the library — and syncs them
file-by-file against `.claude` (and a project's root `CLAUDE.md`), with the
user picking a winner per file (mesa task 919). It also absorbs a fifth kind
mesa itself uses: the live-conversation summariser's prompt, which used to be a
`~/.mesa/config.json` key (`docs/config.md`) — as did the live agent's own
instructions, now the `mesa-live` **agent definition** (mesa task 1068) — see
[Where the live prompt went](#where-the-live-prompt-went).

## The record

Table `library_items` (migration index 47, resulting `user_version` 48):

| column | type | note |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `/`, `\` or `..` — it is half a filename |
| `kind` | TEXT NOT NULL | `agent \| skill \| hook \| command \| prompt \| claude-md` |
| `scope` | TEXT NOT NULL | `user \| project` |
| `project_id` | INTEGER NULL | FK `ON DELETE CASCADE`; required iff `scope = project`, must be NULL iff `scope = user` |
| `body` | TEXT NOT NULL | the file's contents; may be empty |
| `builtin_id` | TEXT NULL, UNIQUE | the built-in this row forked from, or NULL for a purely user-authored row |
| `synced_body` | TEXT NULL | the last body mesa and the disk agreed on — the sync baseline |
| `synced_at` | TEXT NULL | when that agreement was recorded |
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
the block mesa ships." A built-in is **never inserted at migration time**.
`core::library::effective_items` (what `list`/`GET /api/library` actually
return) is `Store::list_library_items` plus every `BUILTINS` entry **not**
shadowed by a db row carrying its `builtin_id`; an unshadowed built-in is
reported with `id: null`, `builtin: true`, and a `path` derived the same way
a real row's is.

That split is the whole point:

- **Editing a built-in forks it.** The API's `POST /api/library/builtins/{id}/fork`
  and the CLI's edit path both go through `Store::create_library_item` with
  `builtin_id: Some(id)` — a real db row appears, carrying the new body, and
  from then on mesa **never updates it**. An mesa upgrade that improves a
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

The starter set is deliberately tiny — five rows:

| `id` | kind | scope | what it is |
| --- | --- | --- | --- |
| `mesa-live` | `agent` | `user` | The agent definition the live conversation runs as — literally `core::live::AGENT_DEFINITION`, YAML frontmatter plus `core::live::AGENT_PROMPT`, moved here rather than duplicated (mesa task 1068) |
| `supervisor` | `agent` | `user` | The agent definition an auto-dispatched `/execute-todo` run is supervised as — literally `core::supervisor::SUPERVISOR_DEFINITION` (mesa task 1075), seeded to `~/.claude/agents/supervisor.md` by `core::supervisor::ensure_agent_definition` before the `todo-watcher` spawn |
| `live-summary-prompt` | `prompt` | `user` | The instructions for the short-lived agent that writes a live conversation's memory once it ends (mesa task 921) — literally `core::live::SUMMARY_PROMPT`, placed immediately after the prompt it belongs beside |
| `starter-claude-md` | `claude-md` | `user` | A short starting-point CLAUDE.md |
| `stop-notify` | `hook` | `user` | A minimal shell hook that echoes when Claude Code stops |

`mesa-live`'s body being the literal `AGENT_DEFINITION` constant (and
`live-summary-prompt`'s the literal `SUMMARY_PROMPT`) is what lets
`docs/live.md`'s tests of "the loop is fully stated" keep passing unchanged —
each built-in and its constant are the same text, never two copies that could
drift.

## Where a row lives on disk

`core::library::relative_path(kind, scope, name)`, relative to the **scope
base** — the home directory for `user`, a project's `local_path` for
`project` (`core::library::scope_base`):

| kind | user scope | project scope |
| --- | --- | --- |
| `agent` | `.claude/agents/<name>.md` | `.claude/agents/<name>.md` |
| `skill` | `.claude/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| `hook` | `.claude/hooks/<name>.sh` | `.claude/hooks/<name>.sh` |
| `command` | `.claude/commands/<name>.md` | `.claude/commands/<name>.md` |
| `claude-md` | `.claude/CLAUDE.md` | `CLAUDE.md` (the repo root — where Claude Code actually reads it) |
| `prompt` | **none** | **none** |

`prompt` is mesa-internal: the live-conversation prompt is not a file Claude
Code reads, so it has no path at all, and the sync scanner (`scan_disk`) skips
it entirely by construction — it is never one of the kinds a directory walk
produces. This is the entire reason `prompt` is its own kind rather than a
`command` — a slash command has a path and syncs; the live prompt does
neither.

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

## The sync model

Sync compares three strings per path: the **mesa body** (M, from the item's
`body`), the **disk body** (D, the file's current contents, or absent), and
the **baseline** (B, the item's `synced_body` — the body mesa and the disk
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
skips `prompt` items outright (they have no path), resolves each item's file
through `resolve`, classifies it, and then walks `scan_disk` over both scope
bases to find `disk-new` files — anything on disk that no item's path already
claimed.

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

**There is deliberately no automatic merging and no three-way merge.** The
common case — Claude edited a skill on disk, or the user edited it in mesa —
is one-sided (`mesa-changed`/`disk-changed`), and the baseline is exactly what
makes that classification possible: without it, every difference between M
and D would look identical, whether one side changed or both did. A
`both-changed` row shows both bodies and the user takes a side; mesa never
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
time: recording that mesa and the disk agree is not an edit to what mesa
holds. `Store::pull_library_body` (the `disk` choice's write) does move
`updated_at`, because it *does* change the body.

## Import / export

A library can travel between mesa instances as one downloadable **bundle** —
a JSON document holding the library's *contents*, not its identity. Three new
ts-rs types carry it: `LibraryBundleItem` (`name`, `kind`, `scope`, an
optional `project` **name** — present iff `scope` is `project` — `body`, and
an optional `builtin_id`), `LibraryBundle` (`version`, `exported_at`, and a
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
against any existing row at its `(kind, scope, project, name)`: none existing
creates it; one existing is a **conflict**, decided by `on_conflict` (`skip`
by default, `replace` as the opt-in) — `skip` leaves the existing row
untouched, `replace` overwrites its body only, never its name and never the
sync baseline. The default is `skip` because import is something a person
runs deliberately, often to *pull in* items from elsewhere, and a body they
already have replaced out from under them with no warning is the more
dangerous default; `replace` exists for the deliberate re-import case, and
is opt-in per call. Any other `Store` failure for one item (the name rule,
the body cap) fails only that item; the rest of the batch still applies.

**Import never touches disk.** It writes rows the same way `create`/`update`
do, and nothing more — no file is written, no baseline is stamped. A freshly
imported row therefore has a null `synced_body`, so the very next `sync
status` reports it honestly: `mesa-new` if nothing sits at its path yet, or
`both-changed` if a file already does. That is correct, not a gap — mesa and
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
| `POST /api/library/builtins/{builtin_id}/fork` | 201 | `require_agent_access` |
| `GET /api/library/sync` (`?project=<id>`) | 200, bare array | `require_agent_access` |
| `POST /api/library/sync` | 200, results array | `require_agent_access` |
| `GET /api/library/export` (`?project=<id>`) | 200, the `LibraryBundle` | `require_agent_access` |
| `POST /api/library/import` | 200, results array | `require_agent_access` |

**All eleven routes are `require_agent_access`** (mesa task 1004) — the same
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
  IP literal on our port, so a DNS-rebinding page is refused) and
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
eleven routes. The genuinely remote-peer case — does a LAN device now get
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

`mesa library {create,list,show,update,delete,versions,sync}` (`show` also
answers to `get`). An `ITEM` argument, everywhere one appears, is a numeric id
or a name — a built-in resolves by name too, since its name and its
`builtin_id` are the same string in the starter set
(`resolve_library`/`library::effective_items`).

- `create` takes `KIND`, `NAME` and `BODY`, each positionally or as
  `--kind`/`--name`/`--body`, plus `--body-file <PATH>` (`-` = stdin) as a
  third way to supply the body — the same three-way choice a task's
  `--description-file` offers. `--scope` is `user|project`, defaulting to
  `user`; `--project <id-or-name>` is required iff `--scope project`.
- `update ITEM` requires at least one of `--name`, `--body`,
  `--body-file` (an `ArgGroup`, so no field flag is `usage`, exit 2); both
  `--name` and `--body` are replace-only, mirroring `script update`. Updating
  an unshadowed built-in **forks** it rather than failing — a new db row
  appears carrying its `builtin_id`.
- `delete ITEM` has no confirmation and echoes the destroyed record — the
  recoverable transcript that stands in for the prompt mesa doesn't have.
  Deleting the fork of a built-in restores it unshadowed; deleting an
  unshadowed built-in (there is no row) is `validation`.
- `list [PROJECT] [--kind KIND]` and `versions ITEM` print bare JSON arrays —
  `list` by kind then name, `versions` newest first (empty for an unshadowed
  built-in, which has no history).
- `sync status [PROJECT]` prints one `LibrarySyncRow` per path as a bare JSON
  array. `sync apply [PROJECT]` takes either repeatable
  `--resolve PATH=mesa|disk|skip` flags or one of `--all-mesa`/`--all-disk`
  (resolve every non-`in-sync` row toward one side at once) — the three are
  mutually exclusive — and prints the resulting `LibrarySyncResult[]`.
- `export [PROJECT] [--project P] [--output PATH]` prints the `LibraryBundle`
  JSON to stdout by default; `--output PATH` writes it there instead (refusing
  to clobber an existing path, mirroring `backup`) and prints
  `{"path": "...", "items": <n>}`. `PROJECT`/`--project` is the same
  positional-or-flag pair `list` takes.
- `import <PATH> [--on-conflict skip|replace]` reads a bundle from `PATH` (or
  `-` for stdin, the `--body-file` convention) and prints the resulting
  `LibraryImportResult[]` as a bare array; a malformed or unparseable bundle
  is `validation`, exit 1. `--on-conflict` defaults to `skip`.

`--quiet` follows the house rule (`CLAUDE.md`): accepted on `create`,
`update`, `delete` and `show`/`get`, dropping `body` and `synced_body`
(`QUIET_DROP_LIBRARY`) while keeping `name`, `kind`, `scope` and the derived
`path`; **not defined at all** on `list`, `versions`, either `sync`
subcommand, or `export`/`import`, so passing it there is clap's
unknown-argument error, exit 2 — those commands answer with a bundle or a
results array, not a record, so there is nothing for `--quiet` to project.
On `update` it sits outside the required field `ArgGroup`, so `--quiet` alone,
with no field flag, is still the usage error rather than a legal no-op call.

## Where the live prompt went

`~/.mesa/config.json`'s `live.prompt` (mesa task 867, `docs/config.md`) is
**gone**, not shadowed — the library is the only place the live agent's
instructions live now. Since mesa task 1068 they are the `mesa-live` **agent
definition** (kind `agent`, user scope) rather than the `live-agent-prompt`
*prompt* they were between tasks 919 and 1068: `core::live::AGENT_DEFINITION`
is YAML frontmatter (`name`, `description`, `model`, `tools: Bash, Read` — the
image reader `mesa live look` needs) followed by `core::live::AGENT_PROMPT`,
the loop text, unchanged.

Being an `agent` rather than a `prompt` gives it a real path,
`.claude/agents/mesa-live.md`, so it rides the ordinary sync flow like every
other agent definition instead of being invisible to it. The `live-agent`
command template spawns `claude --bg --agent mesa-live …`
(`core::config::DEFAULT_LIVE_AGENT`), and Claude Code errors on an agent it has
never seen, so **the first spawn seeds the file**:
`core::live::ensure_agent_definition(store)` runs at both spawn sites
(`api.rs`'s `spawn_live_agent`, `cli.rs`'s `LiveCmd::Start`) before
`agents::spawn_bg`. It resolves the effective row — the fork
(`store.find_library_fork("mesa-live")`) if there is one, the built-in
otherwise — computes the target through this module's own `relative_path`,
`scope_base` and `resolve`, so `$HOME` is honoured and the traversal check
holds exactly as it does on the sync path, creates the parent directory, and
writes the body.

It **never overwrites an existing file**. After the first seed the file belongs
to the sync flow, where a difference between disk and mesa is a row the user
resolves; rewriting it on every start would make one side of that decision
impossible to keep. A failure (no `HOME`, an unwritable `.claude`) is returned
as an error and both spawn sites treat it exactly like a failed spawn —
`unavailable`, and the session that was just opened is ended again.

What `core::live::agent_prompt(store, session_id)` injects is now only what the
definition cannot know: `Drive mesa live session <id>.`, plus the recall block
of earlier session summaries when there are any. Forking `mesa-live`
**replaces** the built-in rather than extending it — the same rule the old
config key followed, just moved: what the forked row holds is the whole of what
the agent is.

`config.rs`'s `LiveSection` now holds one key, `auto-send-ms`
(`docs/config.md`); a `live.prompt` key left behind by an older mesa, or
hand-edited into the file, is **silently ignored** — never an error, and never
read from — because the struct simply has no field for it any more.

### And where the summariser's went

`live-summary-prompt` (mesa task 921) is still a `prompt`: nothing spawns the
summariser *by name*, so it has no reason to be an agent definition, and —
being mesa-internal — it has no on-disk path either (`relative_path` answers
`None` for every `prompt` row). `core::live::summary_prompt(store,
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

`scripts/library-check.sh` (95 checks) covers, over both the CLI and the
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
  actually manipulating the file and the mesa row (a fresh item with no file
  is `mesa-new`; applying `mesa` writes it and the next scan reports
  `in-sync`; editing the file reports `disk-changed`, and applying `disk`
  pulls it in and appends a `sync-pull` version; editing the body reports
  `mesa-changed`, and applying `mesa` pushes it back out; an unclaimed file is
  `disk-new`, and applying `disk` adopts it into a new row; a `disk-deleted`
  row's `mesa` re-creates the file and its `disk` deletes the row; a
  `both-changed` row shows both bodies, and `skip` leaves both sides and the
  status untouched on the next scan).
- **The API DTOs and status codes** for all eleven routes, a malformed JSON
  body as 422 (never a 500), and every mutating route (create, update,
  delete, fork, sync apply, import) refusing a request with no JSON
  `Content-Type` as 415.
- **The `require_agent_access` gate, on all eleven routes, reads included**,
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
  `mesa-live` starts unshadowed (`id: null`, kind `agent`, path
  `.claude/agents/mesa-live.md`) and appears in `sync status`; `sync apply`
  with mesa winning writes it to `$HOME/.claude/agents/mesa-live.md`; editing
  it forks it (`builtin_id: mesa-live`, `id` no longer null); and the prompt that
  `mesa live start` spawns the stub `claude` with carries the session line
  only — never the loop text, which now travels as the definition.

The same pairing `api-check.sh` holds for tasks and `config-check.sh` holds
for the config-write routes. The "a configured prompt replaces the built-in
at spawn" assertion that used to live in `config-check.sh` lives here now,
proved through the `mesa-live` library row instead of a config key.
