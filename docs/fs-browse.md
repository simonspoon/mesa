# Filesystem browse (server-side directory listing for the folder picker)

Backs the web UI's new-project folder picker (`CreateProjectModal` /
`DirBrowser`, mesa task 406): browser-native file pickers withhold real
absolute paths, so the folder picker instead drives one server-side
directory-listing endpoint. Unlike the Git/Files tabs, this surface is **not
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

## Access gate: the same `require_local_path_write`, now parameterized

Gated by `require_local_path_write(&state, &addr, &headers, message)`
(`src/api.rs`) — reused as-is, not a new or separate gate function. This is
the same loopback-only-in-BOTH-`serve`-modes check that already guards
writing a project's `local_path` (an execution-anchor input for
`claude --bg`/`claude agents`): `require_loopback` always, plus
`require_lan_page_access` under `--lan`. A read-only directory listing is a
different capability than writing `local_path`, but the same rationale class
applies — filesystem-exposure adjacent to the execution-anchor concept, not
plain CRUD — so under `--lan` a peer who could already point a future agent
at an arbitrary folder gains nothing new from also being able to browse for
one.

The one adjustment made to land this reuse: `require_local_path_write`'s
loopback-rejection message used to be hardcoded to `local_path`-specific
copy ("local_path is an agent execution anchor; it can only be set from this
machine"), which reads wrong for a listing rejection. It now takes a
caller-supplied `message: &'static str` — both existing call sites
(`create_project`, `update_project`) pass their original copy explicitly,
and `list_fs_dirs` passes its own ("this endpoint is loopback-only; connect
from this machine"). Do not read this as a second gate: the loopback +
LAN-page-access logic itself is untouched and still lives in exactly one
function.

GET, so the Content-Type/CSRF gate does not apply.

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
  once a caller clears the loopback gate, they *are* the same OS user mesa
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
