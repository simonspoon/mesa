# Filesystem browse (server-side directory listing for the folder picker)

Backs the web UI's folder pickers (`DirBrowser`, mesa task 406) — the
new-project form's (`CreateProjectModal`) and, since task 682, the project
Settings tab's `project folder` control (`ProjectSettingsView`, which PATCHes
`local_path` on the project that already exists). One component, two consumers:
browser-native file pickers withhold real
absolute paths, so the folder picker instead drives one server-side
directory-listing endpoint (plus, since task 489, a create-one-folder
mutation on the same route). Unlike the Git/Files tabs, this surface is **not
project-scoped and not rooted at any project's `local_path`** — it lists any
directory the calling OS user can read, anywhere on the machine (`/opt`,
`/Volumes`, an external drive), because that's what picking a not-yet-linked
folder requires.

- `GET /api/fs/dirs?path=<absolute path, optional>` → `DirListing` via
  `core::files::list_dir`. `path` is an absolute filesystem path, not
  project-relative — a different query contract from the Files tab's
  `?path=<relpath>`, don't pattern-match that route. Missing `?path=` lists
  `directories::BaseDirs::new().home_dir()` (the same call `terminal_attach`/
  `bridge_attach` already use) — a default starting point only, not an
  enforced floor; navigation from there is unbounded (see below). Any failure
  (path doesn't resolve, isn't a directory, or is unreadable) collapses to one
  404 `not_found`, matching the Files tab's "one case for
  traversal/absolute/unlisted/directory" precedent.
- `DirListing { path, parent, entries }` / `DirEntry { name, path }`
  (`src/core/types.rs`, ts-rs exported) — `path` is the canonical absolute
  directory actually listed, `parent` is its canonical parent or `None` at
  `/` (lets the frontend do "up one level" without its own path math),
  `entries` are directories only, sorted alphabetically by name. No `is_dir`
  field (every entry already is one, unlike `FileTreeEntry`) and no git-repo
  decoration — that stays exclusively with `GET /api/git-status`, not
  duplicated here.
- `POST /api/fs/dirs` `{path, name}` → the new `DirEntry`, via
  `core::files::create_dir` (mesa task 489) — creates ONE folder named `name`
  directly inside `path`, so a project can be started in a folder that
  doesn't exist yet. `fs::create_dir`, never `create_dir_all`: one level, and
  an occupied name is a 409 `conflict` the user sees rather than a silent
  success. `name` must be a single path component — separators, NUL, `.` and
  `..` are 422 `validation`, and that rejection is the *entire* containment
  story (it is what keeps `parent.join(name)` inside `parent`); there is
  deliberately no `safe_path` here, for the same reason `list_dir` has none.
  A parent that no longer resolves collapses to the same 404 `not_found` the
  GET returns for it. The echoed `DirEntry` is shaped exactly like the ones
  the GET lists, so the picker navigates into the new folder without a second
  request.

The picker remembers the folder last confirmed with "use this folder" in
`localStorage` (`frontend/src/lastFolder.ts`, `mesa-last-folder`) and reopens
there instead of `$HOME`. Machine-local convenience only, like `boardView`/
`author` — never server or project state, and explicitly NOT a second home
for `local_path`. A remembered folder that has since been deleted 404s; the
browser catches that *in its loader*, forgets the key, and falls back to
`$HOME` (an effect keyed on `error` would set state during an effect, which
the frontend lint rejects).

## Access gate: `require_agent_access`, on both verbs

Gated by `require_agent_access(&state, &addr, &headers)` (`src/api.rs`) —
the agent routes' own gate, which this endpoint moved onto in **mesa task
1022**, replacing the loopback-only-in-both-modes check it used to share with
the `local_path` write. Listing a directory (or creating an empty one) is
filesystem exposure adjacent to the execution-anchor concept, not plain CRUD,
so it belongs in that capability class.

In **default** mode the new gate is strictly stronger than the old one:
`require_loopback` **plus** `require_local_host` **plus**
`require_local_origin`, the last being new here. Under **`--lan`** it relaxes
rather than refuses — a page this server handed out may browse, while both
confused-deputy defenses stay shut (`require_lan_agent_host` for DNS
rebinding, `require_origin_matches_host` for a cross-site fetch). `--lan` is
already the opt-in "trust every device on this network" posture that hands
that network a terminal, which can list any folder on this machine anyway; so
refusing it the picker while granting it the shell was a distinction with no
security content.

**Both** verbs on the route take that same gate, and always must: creating a
directory is a strictly larger capability than listing one, so it can never be
gated more loosely than its own read. A same-machine `curl` cannot prove the
peer-address half (its peer is always loopback, which makes the relaxed and
strict gates identical under `--lan`), so that half is pinned by
`lan_page_may_browse_fs_dirs_but_not_from_a_rebound_page` and
`create_fs_dir_is_gated_exactly_like_the_listing_beside_it` in `src/api.rs`.

The GET, being a GET, skips the Content-Type/CSRF gate; the POST sits inside
it like every other mutation in the API.

## Navigation bound: the OS permission model, not a mesa-imposed path prefix

Deliberately **not** `safe_path()`'s model (root + relative path, containment
check) — there is no root here to be contained within, so `list_dir` does not
call or extend `safe_path`. Reaching for `safe_path()` to "harden" this
endpoint is the wrong move; don't.

- Navigation is unbounded: up to and including `/`, and down into any
  OS-readable directory tree, no mesa-side ceiling or floor. A folder
  someone might reasonably link a project from can live anywhere on the
  filesystem, not just under `$HOME` — a mesa-imposed path prefix would block
  that legitimate case for no real security gain.
- The actual boundary is **who may call the endpoint at all** (the gate
  above), not which paths it may return. mesa is local-first, single-user:
  once a caller clears the access gate, they *are* the same OS user mesa
  runs as, who already has Finder/Terminal-level read access to everything
  their account can read. A mesa-side path bound on top of that would protect
  nothing the user couldn't already `ls` themselves — it would only be a
  footgun-reduction UX device, at the cost of blocking `/opt`/`/Volumes`.
  What actually enforces the bound is the OS itself: `fs::canonicalize` /
  `fs::read_dir` erroring on any path the caller's OS user can't reach (e.g.
  another account's home directory, SIP-protected paths) collapses to the
  same `not_found` as any other failure.
- Symlinks are **followed, not rejected** — the opposite choice from
  `tree_of`/`walk_dir` (which uses `symlink_metadata` to list a symlinked
  directory as an inert file leaf, specifically to avoid escape/cycle risk in
  a *recursive, bound-checked* walk). Neither risk exists here: there's no
  bound to escape and a single-level listing can't cycle. A symlinked
  directory is a real, reachable folder a user may legitimately want to pick
  (e.g. an aliased dev folder); rejecting or misclassifying it would make it
  unpickable for no security benefit. `list_dir` uses `entry.path().metadata()`
  (follows symlinks) to classify entries, but each `DirEntry.path` stays the
  symlink's own location, not a further-resolved target — `basename(path) ==
  name` always holds, so the frontend never has to special-case symlinked
  entries.
- `EXCLUDED_DIRS` (`.git`, `node_modules`, `target`, …) is **deliberately not
  reused** here. That list de-noises a recursive project-tree walk; applying
  it to this endpoint would make `node_modules` or a dotfile-prefixed folder
  impossible to pick as a project root, which is a real use case this
  endpoint must not block. Every real subdirectory is listed, dotfiles
  included.
- This is a **single, non-recursive, one-level listing per request** — the
  immediate children of exactly one path, not a walk like `tree_of`. There is
  no unbounded-depth risk and no cycle risk to guard against: depth is
  naturally capped at 1 by the request shape itself, and the client only sees
  the next level down by issuing another request for it.

If a future change wants to reintroduce a path bound, symlink rejection, or
`EXCLUDED_DIRS` filtering here to mirror the Files tab's `safe_path`/`tree_of`
pattern, that is not a bug fix — it's a deliberate reversal of the design
above, and needs the same design-level sign-off this doc records, not a
quiet "consistency" patch.
