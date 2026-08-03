# Files tab (project file browser + editor)

The **Files** tab on a project page (web UI, `#/projects/:id/files`) browses
the file tree of the project's `local_path`, reads individual file contents,
and (task 327) can edit and save a text file's content back to disk —
`local_path`-anchored like the Git tab (touches the store only to read
`local_path`, no CLI: an agent in a terminal edits files directly). Browsing
(the tree, reading content) stays read-only; there are exactly two writes —
overwriting an existing text file's full content, and creating one new empty
file from the tree (task 672) — and no delete, rename or move anywhere in
this surface. Creating a *folder* is not here either: the new-project picker's
`POST /api/fs/dirs` remains the only folder create, on its own stricter gate
(`docs/fs-browse.md`).

- `pub fn safe_path(root: &str, rel: &str) -> Option<PathBuf>`
  (`src/core/files.rs`) is the sole traversal-defense chokepoint: canonicalizes
  both `root` and `root.join(rel)` (resolving `.`/`..` **and** symlinks) and
  requires the result to be `root` itself or a descendant — rejects
  `../` traversal, absolute-path smuggling, symlink escapes, and nonexistent
  paths in one check. `read_file`, `write_file`, `tree_level` and
  `create_file` are its only callers — and `create_file` is the one that
  resolves something other than the request path itself (see below).
- `pub fn tree_level(root: &str, rel: &str) -> Option<(Vec<FileTreeEntry>, bool)>`
  (mesa task 410) lists ONE directory level — `root` itself when `rel` is
  `""`, else the subdirectory `rel` resolves to underneath `root`, resolved
  via [`safe_path`] exactly like `read_file`/`write_file` (`None` for
  traversal, absolute-path smuggling, a nonexistent path, or a `rel` that
  resolves to a file). Excludes `EXCLUDED_DIRS` (`.git`, `node_modules`,
  `target`, `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.next`,
  `vendor`, `.cache`) by name, sorting directories before files. Caps at
  `MAX_TREE_ENTRIES` (2,000 entries) — now a **per-directory** cap, not a
  whole-tree one, since a call only ever lists one level; the client re-calls
  this per directory on expand to go deeper. A single flat directory with
  more than 2,000 entries is still capped — laziness alone doesn't solve
  that, it only moves the cap from the whole tree to one folder at a time.
  Symlinks are listed as file leaves and never followed (one rule covers both
  escape and cycle risk). Replaces the old whole-tree recursive `tree_of`/
  `walk_dir` (and the `MAX_TREE_DEPTH` cap that bounded its recursion) —
  depth is now driven entirely by which directories the client has expanded,
  not by a server-side limit.
- `pub fn read_file(root: &str, rel: &str) -> Option<FileContentView>`
  resolves `rel` via `safe_path`, rejects directories, detects binaries via an
  extension allowlist or a NUL-byte sniff (`content: ""` for those), else
  reads up to `FILE_CONTENT_CAP` (256 KiB, mirrors the Git tab's `DIFF_CAP`)
  bytes with the same lossy-UTF8/char-boundary truncation as `git.rs::capped`.
  `language` is an extension→tag lookup (e.g. `rs`→`rust`) set in both
  branches — it describes the file, not the content.
- `pub fn write_file(root: &str, rel: &str, content: &str) -> Result<(),
  WriteFileError>` (task 327) reuses `read_file` to resolve `rel` and check
  editability before writing a byte, then re-resolves via `safe_path` for the
  actual `fs::write` — never a second path-resolution rule. Rejects (as
  `WriteFileError::Validation(reason)`, never writing anything): a binary
  target, a target whose `read_file` view was itself `truncated` (its true
  on-disk size exceeds `FILE_CONTENT_CAP`, so the capped view the editor
  showed wasn't the whole file — saving it back would silently truncate it),
  or new `content` that itself exceeds `FILE_CONTENT_CAP`. Everything
  `read_file` itself collapses to `None` (traversal, absolute path,
  unlisted/nonexistent path, a directory) — plus an `fs::write` I/O failure —
  collapses the same way here, to `WriteFileError::NotFound`.
- `pub fn create_file(root: &str, rel: &str) -> Result<(), CreateFileError>`
  (task 672) creates ONE empty file at `rel` — the only write in the module
  that brings a new path into existence.

  **It resolves the PARENT through `safe_path`, never the new file itself,**
  and that is the whole design: `safe_path` canonicalizes its candidate, so a
  path that does not exist yet always errors out to `None` — the target could
  never be resolved through it. Relaxing `safe_path` to tolerate a
  nonexistent path was the alternative and is not available: that rejection
  is exactly what `read_file`/`write_file`/`tree_level` rely on. So `rel` is
  split on its last `/` into `(parent_rel, name)` (an empty `parent_rel`
  meaning the project root, anchored as `"."`), the parent is resolved with
  `safe_path` and required to be a directory, and the final component is held
  inside it by the SAME single-component rules `create_dir` applies — trim,
  no empty, not `.`/`..`, no `/`, `\` or NUL — which is what makes
  `parent.join(name)` provably stay inside `parent`. One chokepoint, one
  containment rule, no second path-resolution model.

  An existing target is `Conflict`, tested with `symlink_metadata()` rather
  than `exists()` (a dangling symlink is a name taken — `create_dir`'s rule).
  The file is created with `fs::write(target, "")` — always EMPTY, never
  `create_dir_all`, never a caller-supplied body: content arrives afterwards
  through `write_file`, so there is no second content cap, binary sniff or
  truncation rule to keep in sync. An I/O failure is `NotFound`,
  `AlreadyExists` is `Conflict`, mirroring `create_dir`.
- `GET /api/projects/{id}/files[?path=<rel>]` → `ProjectFileTree` via
  `files::tree_level` — one directory level per call (mesa task 410). `path`
  omitted lists `local_path` itself (the root level); `path` given lists that
  subdirectory instead. The three-rung empty-state ladder (no `local_path` →
  `{path: null, tree: null}`; dead/unreadable folder → `{path, tree: null}`;
  live folder → `{path, tree: Some(entries), truncated}`, never an error)
  applies only to the root call — a `path`-scoped call for an invalid/
  traversal/nonexistent/non-directory subpath is 404 `not_found` instead,
  matching the content route's own collapse-many-causes precedent. Each
  entry no longer nests a recursive `children` field: the frontend fetches a
  directory's contents lazily, on first expand, via a separate `?path=` call
  for that directory, and caches the result itself — "not yet fetched" lives
  only in frontend state, never on the wire. Cached 5s per `(local_path,
  path)` pair (`AppState.files_tree_cache`) — walking a directory isn't free
  either.
- `GET /api/projects/{id}/files/content?path=<relpath>` → `FileContentView`
  via `files::read_file`. Missing `?path=` is 422 `validation` (matches the
  Git tab's diff routes). No `local_path` / dead folder, or `read_file`
  returning `None` (traversal, absolute path, unlisted/nonexistent path, or a
  directory given for a file) all collapse to 404 `not_found` — one case,
  matching the Git tab's "bad sha and no repo both mean not_found"
  precedent. Content reads are not cached (on-demand, one file, cheap, like
  the Git tab's diff routes).
- `PATCH /api/projects/{id}/files/content` (task 327; same path as the GET
  above, body `{path, content}` — JSON, not a query string, so this mutating
  call stays inside the Content-Type CSRF gate, same reasoning as the
  attachments upload) → re-reads and returns the fresh `FileContentView` on
  success (every mutation in this API echoes the full updated object).
  `write_file`'s `NotFound` is 404 `not_found`; `Validation(reason)` is 422
  `validation`. Gated by `require_agent_access` — **not** the plain guard the
  read routes above use, and not `require_local_path_write` either: writing
  file *content* under `local_path` is code-execution-adjacent (the bytes
  written can be a hook script, a git hook, anything that later executes),
  the same capability class the agents/hooks routes already guard — under
  `--lan` a peer who can already spawn an agent or run a hook in this folder
  gains nothing new here, so reusing that gate is the coherent choice, not a
  looser one.
- `POST /api/projects/{id}/files/content` (task 672; the same path as the GET
  and PATCH above, body `{path}` and nothing else — the new file is always
  empty, so there is no `content` field to cap or sniff a second time) →
  `files::create_file`, echoing the freshly read `FileContentView` for the new
  path on success, like every other mutation here. Gated by
  `require_agent_access` — the **same** gate as the PATCH, for the same
  reason: the bytes are written under `local_path`, and a peer who can already
  overwrite a file in that folder gains nothing new from being able to add
  one. Error mapping matches `create_fs_dir`'s: `NotFound` → 404 `not_found`
  (parent doesn't resolve, isn't a directory, or the write failed — plus the
  no-`local_path`/dead-folder rung its neighbours share), `Validation(reason)`
  → 422 `validation`, `Conflict` → 409 `conflict`.

  The handler **evicts the `files_tree_cache` entry for the created file's
  own directory** — key `(local_path, rel_key)`, where `rel_key` is the
  parent's relative path and `""` is the root — before responding. That is a
  requirement, not a nicety: the cache has a 5s TTL and the client refetches
  that level immediately, so leaving the entry in place would show a tree that
  does not contain the file just created. Only that one key is dropped;
  nothing about any other level changed.
- The tab reads one route it does not own: `GET
  /api/projects/{id}/git/file-log?path=<rel>` (mesa task 542) backs the
  per-file History pane below. It is documented with the other git reads in
  `docs/git-tab.md` — it is a `git log` shell-out with that tab's posture —
  but its `?path=` is gated by this tab's own `safe_path`, not by a
  git-output allowlist, because the path always comes from the file tree
  here. The commit a user then picks is diffed through the **existing**
  `GET /api/projects/{id}/git/commits/{sha}/diff?path=` route unchanged; no
  new diff endpoint exists for this feature.
- Tree listing and content reads stay standard-guard-only, like the Git tab —
  no agent-style gate (browsing executes nothing) and no Content-Type gate
  (GET-only). The two writes above are the exception: both are gated by
  `require_agent_access` and both, being mutations with JSON bodies, sit
  inside the global Content-Type/CSRF gate.
- Web UI: `FilesView` (`frontend/src/pages/FilesView.tsx`) under the project
  tabs — a left-hand expandable file tree (`.files-tree`, directories
  toggled open/closed in local component state, no deep-linking) and a
  right-hand **content half holding many open files as tabs** (task 670, see
  its own section below), registered like the Git/Agents/Storyboards tabs (a
  boolean `files` route prop threaded `App.tsx` → `ProjectTasksPage.tsx`'s tab
  bar + content switch). The root level loads eagerly with the tab (one
  `getProjectFiles(id)` call); each directory's contents load lazily on
  first expand (`getProjectFiles(id, path)`) and are cached in a
  `childrenCache: Map<path, DirState>` (`DirState` = `'loading' | 'error' |
  {entries, truncated}`) that lives for the component's lifetime, so
  collapsing and re-expanding a directory never re-fetches it — reset only
  on project change, same as `selectedPath`/`expanded`. A `truncated`
  directory shows its own inline note (`.files-tree-note`) rather than one
  global banner, since the cap is now per-directory (mesa task 410). At the
  phone tier the two panes are stacked (≤860px) and opening a file also
  *collapses* the tree behind a breadcrumb toggle (`treeOpen`, task 559),
  because a full tree above the file pushes the file below the fold; the flag
  is inert at every wider width, and the reasoning is in `docs/mobile.md`. A
  non-binary, non-truncated file's content pane
  shows an **Edit** button; clicking it swaps the rendered content for a
  full-height `<textarea>` (`.files-content-editor`) pre-filled with the
  current content, with Save/Cancel actions (Escape cancels, Cmd/Ctrl+Enter
  saves) — the same draft/saving/error-state shape as `InlineEdit`, but
  purpose-built rather than reusing that component: `InlineEdit`'s
  click-anywhere-to-edit trigger would fight selecting/copying source code,
  and its fixed `rows={4}` textarea doesn't fit a whole file.
  That textarea is syntax-highlighted while you type (task 658, `FileEditor`):
  a `<textarea>` can only paint one colour, so the coloured copy is a
  separate, inert layer *behind* it (`.files-editor-stack` is the sized,
  resizable box; `.files-editor-highlight` the layer; the textarea's own text
  is `color: transparent` with a visible `caret-color`). It runs the same
  `prismGrammar` + PrismLight pair as the read-only `FileCode`, so edit mode
  colours exactly what view mode does, and a language with no registered
  grammar falls back to the plain textarea task 327 shipped. Four things keep
  the layers aligned, each load-bearing: identical font metrics and zero
  padding on both, `wrap="off"` on the textarea (it must never soft-wrap where
  the `<pre>` would not), `highlightOverlaySource()` (a `<pre>` swallows one
  trailing newline, which would otherwise shear every line below the caret —
  the one piece of pure logic here, unit-tested in
  `syntaxHighlighter.test.ts`), and mirroring the textarea's `scrollTop`/
  `scrollLeft` onto the layer on every scroll event. Only the textarea is a
  real control — the layer is `aria-hidden` and pointer-transparent, so caret,
  selection and the accessibility tree all still come from the one element
  holding the text; its `::selection` is overridden translucent because the
  global opaque one would blank out the glyphs showing through from behind.
  The highlight source is a `useDeferredValue` of the draft, so re-tokenising
  a large file lags a frame behind the caret instead of sitting between the
  key and the character. This is also the only caller that resolves a
  **markdown** grammar for a whole file — a saved `.md` renders as prose (see
  below), but editing one shows markdown source, so `markdown`/`md` map to
  Prism's markdown grammar in the shared table. Save errors
  (e.g. a 422 if the file changed underneath into something non-editable
  since it was loaded) render inline and keep edit mode open, mirroring
  `InlineEdit`'s own error handling. **Closing** a tab mid-edit silently
  discards its draft — no confirm, matching this app's no-confirmation posture
  on other destructive UI actions. Merely *switching* tabs does not: see the
  tabs section below for which half of that changed in task 670 and why.
  Beside **Edit** sits a **History** toggle (task 542). Open, it renders
  `FileHistoryPane` — a vertical commit list (`.files-history-pane`) for the
  selected file — to the *left* of the content, which keeps rendering as
  normal; picking a commit swaps only that content half for
  `CommitSideBySidePane`, an old|new rendering of that commit's change to
  this file, with a `← File` affordance back. History state rides with the
  open tab, alongside its edit draft (see the tabs section) — one file's
  history can never be shown against
  another file's content. Edit and History are mutually exclusive views of
  the same area: entering edit mode closes history rather than trying to
  show a textarea and a commit diff at once. The pane's empty states are the
  Git tab's ladder plus one rung this route adds — an empty commit list
  means the file exists on disk but was never committed, a state, not a
  failure.
  `SideBySideDiff` (`frontend/src/components/SideBySideDiff.tsx`) does the
  splitting **client-side** from the same unified diff the Git tab renders —
  no second endpoint, no server-side split-diff format. It pairs each run of
  `-` lines opposite the matching run of `+` lines, renders the leftover of
  the longer run against a blank cell, and takes real line numbers from each
  `@@ -a,b +c,d @@` header. Everything before the first hunk is dropped (the
  pane already names the file, and `git show`'s commit header would
  otherwise be misread as content by the `-`/`+` prefix checks); a diff with
  no hunk at all — a binary file's `Binary files … differ`, an empty diff —
  falls back to rendering the server's text verbatim. Cells go straight into
  one four-column grid with no per-row wrapper, so both halves of a line
  share column tracks and stay aligned however a long line wraps. That flat
  emission is also what lets the phone tier turn the *same* markup into a
  unified diff in CSS alone — hence the `diff-split-l`/`-r` side class every
  cell carries, which nothing in the component reads (task 559,
  `docs/mobile.md`). Diff text
  is untrusted: every line is a plain text node in a `<span>`, classified by
  prefix for CSS only, exactly as in `GitView`'s unified `DiffText`.
  Tree-row and
  content-header tinting is still extension/language-derived:
  tree rows derive their tint client-side from `FileTreeEntry.name`'s
  extension via a local copy of `files.rs`'s extension→language table (the
  tree endpoint carries no `language` field, by design — see the API section
  above); the content pane uses `FileContentView.language` verbatim for its
  header tint. Both map onto the same five
  `--cyan`/`--magenta`/`--amber`/`--green`/`--red` accent classes
  (`.files-accent-*`), grouped by rough language category since the theme has
  far fewer hues than languages.
  Spec 277 originally shipped this tab with dependency-free color-by-extension
  only (no tokenizing highlighter); task 281 revisited that call and added
  real syntax highlighting via `react-syntax-highlighter`'s `PrismLight`
  build, registered for the same ~15 languages `EXTENSION_LANGUAGE`
  recognizes — the sync "light" Prism build was chosen over the async build
  specifically because the async build's per-language dynamic-import fallback
  pulls Prism's entire ~290-language catalog into the bundle even when only a
  handful are ever registered; an unrecognized language falls back to plain
  monospace `<pre>` text, matching the pre-281 behavior. Task 521 lifted that
  one-time registration (plus the vsc-dark-plus style and the token→grammar
  resolver `prismGrammar`) out of `FilesView.tsx` into a shared
  `frontend/src/syntaxHighlighter.ts`, so the same registered grammars now back
  both this tab and markdown fenced code blocks without registering twice or
  growing the bundle. `.md` files render as formatted markdown via the
  existing `Markdown` component (`frontend/src/components/Markdown.tsx`,
  already used for storyboard frame cards) instead of raw/highlighted text —
  safe against untrusted content the same way (no raw HTML passthrough). That
  component carries `remark-gfm` (task 432), so GitHub-flavoured tables,
  strikethrough, task lists and autolinks render as real elements rather than
  raw pipe-and-dash source; it is a source-parser extension only and does not
  widen the no-raw-HTML guarantee. Fenced code blocks inside that markdown are
  themselves colour-coded (task 521): the component's `pre` override routes a
  block's ```` ```lang ```` tag through the same shared `prismGrammar`/PrismLight
  pair as this tab, so ` ```rust ` in a task description or frame card tokenises
  exactly like a `.rs` file here — a bare or unknown-language fence stays a
  plain monospace literal `<pre>`, and the highlighter only ever emits inert
  `<span>`s, so untrusted body text can't smuggle markup through it. A
  binary file still renders "Binary file — cannot display" instead of raw
  content; the no-`local_path` and dead-folder empty-state rungs render the
  same quiet-placeholder pattern as the Git tab, never a hard error.

## Open files: tabs and the one-level split (task 670)

The content half holds *many* open files, as a horizontally-scrolling strip of
tabs above the file, and can split once into two side-by-side panes each with
its own strip, active file and content. Frontend-only — every tab reads the
same `GET /api/projects/{id}/files/content?path=` the single pane always read,
and no route, `src/core/files.rs` function, store method or migration changed.

**The decisions live in `frontend/src/fileTabs.ts`**, unit-tested in
`fileTabs.test.ts` — same rule and same reason as `navOrder.ts` (CLAUDE.md):
what an open, a close or a drop *resolves to* is the part that ships wrong, and
it must be reachable by vitest rather than only by khora. `FilesView.tsx` keeps
the fetching, the DOM and the drag events; it measures tab rects and hands them
to `dropIndex`, and every state transition is one of that module's exports.

The model is a `left` pane, an optional `right` pane, a `focused` side and a
`ratio` — deliberately **not** a recursive pane tree. One split, side by side,
is the whole feature; a tree would be a data structure most of whose states no
UI can produce. Invariants the module preserves and its tests assert:
`right === null` implies `focused === 'left'`; a pane's `active` is `null`
exactly when it has no tabs and is otherwise one of them; no pane lists a path
twice.

- **Opening.** A tree click opens into the focused pane and activates it.
  Already open in that pane → activate, never a second tab. Already open in the
  *other* pane → focus that pane and activate it there, rather than minting a
  duplicate. Dedupe is therefore **per pane**, and the one place the same path
  is legitimately open twice is what the Split control produces (below). The
  tree's `selected` row highlight follows the focused pane's active tab.
- **Closing.** The × or a middle-click. Closing the active tab activates its
  right-hand neighbour, else its left. Emptying a pane while split *collapses*
  the split and the survivor takes the full width; emptying the only pane
  leaves the same "Select a file" empty state as before.
- **Split.** Entered from the strip's **Split** button — which **copies** the
  active tab into a new right pane, because moving it would empty a one-tab
  source pane and collapse the split it just created — or by dragging a tab
  onto the right-hand edge zone, which **moves** it, and is refused (no-op)
  when it is the source pane's only tab, for the same reason. A
  `.files-pane-divider` sets the ratio, clamped to 0.15–0.85: a zero-width pane
  still holds tabs and a focus, i.e. state with no way back to it.
- **Drag.** Native HTML5 drag, not dnd-kit — this is a desktop-only affordance
  over two short strips, with none of the collision detection or sortable
  context the board and nav need. The dragged tab is held in a module-level
  slot rather than `DataTransfer`, because `dragover` has to *read* it to
  decide the drop and `getData` is deliberately blank outside `drop`. The drop
  index is the board's midpoint scheme (`dropIndex`); a same-strip drop at the
  tab's own index or the one just past it writes nothing, which is also what
  makes "dropped on itself" a no-op with no special case.
- **Per-tab state.** An open tab's edit draft, edit mode, open History and
  selected commit are one `FileUiState` per path in `FilesView`, so flipping
  to another tab and back is lossless — a navigation that silently ate a
  half-typed edit would be a bug. Closing the tab (or switching project)
  discards it, with no confirm: every `TabsState` write goes through
  `FilesView`'s `commit()`, which drops the `FileUiState` of any path no longer
  in `openPaths()`. Only the **active** tab of each pane is mounted, so a dozen
  open files is never a dozen live syntax highlighters; `ContentPane` still
  carries `key={path}` so `useFetch` and the editor start clean per file,
  exactly as the pre-tabs `key={selectedPath}` did.
- **Lifetime.** Tabs, order, split and ratio are component state with the same
  lifetime the old single `selectedPath` had: reset on project change, no URL
  hash, no `localStorage`, no server persistence. (Contrast `navWidth.ts`,
  which *is* persisted — this matches the tab's existing "no deep-linking into
  the tree" posture instead.)
- **Mobile.** No split below the **narrow** tier (≤860px): a two-up split of a
  360px screen is unusable, the Split control is not rendered, and a split open
  when the viewport crosses that tier is folded onto the focused pane. That
  fold is edge-triggered off `onNarrowTierChange()` in `phoneTier.ts` — which
  gained the narrow query for this, under that module's standing rule of one
  `MediaQueryList` **per tier** and never a second for the same one
  (`docs/mobile.md`). It is in JS rather than CSS for the same reason the
  terminal's pane tree is: the split is a React data structure, and a CSS rule
  could only *hide* the second pane, leaving state whose meaning no longer
  matches the screen. The strip scrolls horizontally at every width rather than
  wrapping — a wrapping strip changes height as tabs open, which moves the file
  underneath it. The phone tier's existing `treeOpen` breadcrumb collapse is
  untouched.
- **Keyboard.** No new global single-key shortcuts (`docs/keyboard.md`). Each
  tab's label and its × are real `<button>`s reachable by Tab, as is Split, and
  the editor's existing Escape-cancels / Cmd-Ctrl+Enter-saves bindings are
  unchanged.

Non-goals of *that* task, deliberately: no new file operations, no recursive
or stacked splits, no third pane, and nothing about `SideBySideDiff`, the
markdown path or `syntaxHighlighter.ts` changed. (Task 672 later added exactly
one file operation — create — described in its own section below; delete,
rename and move remain non-goals.)

## Tree pane: drag-resize and collapse (task 671)

The tree half is a resizable, collapsible pane, the way the left nav (task 665)
and the agent sidebar's list rail (task 414) already are — before this it was a
hard-coded `width: 19rem`, too narrow for a deep tree and unshrinkable when you
only wanted the editor. Frontend-only: no route, no `Store` write, no new type.

- **Drag-resize.** A 6px `col-resize` handle on the pane's *right* edge — this
  is the left pane, so the mirror of the nav's and the agent rail's left-edge
  handles. It is absolutely positioned against `.files-tree-pane` rather than
  living in the tree, because the tree is a scroll box that would clip it and
  scroll it away. Listeners go on `document`, not the handle, so the drag keeps
  tracking when the pointer outruns it; `document.body` carries a
  `files-tree-resizing` class for the length of the drag (joining
  `body.nav-resizing` on one rule) so a sweep doesn't select text under it. The
  width is persisted **once, on drag end** — not once a frame. Double-clicking
  the handle resets to the default by *clearing* the stored key rather than
  storing the default, the nav's rule: a later change to the default should be
  picked up, not pinned by a leftover entry.
- **Collapse.** A `«`/`»` toggle in the pane's top-right shrinks it to a narrow
  rail carrying the expander; `.files-panes` is `flex: 1`, so the content half
  simply takes the freed width and keeps rendering its open tabs untouched.
  Same shape as `.sidebar.collapsed` and `.agent-sidebar-list-rail.collapsed`.

**State lives in `frontend/src/filesTreeWidth.ts`**, unit-tested in
`filesTreeWidth.test.ts` (CLAUDE.md's frontend-test invariant: testable logic
belongs in a pure module, not inline in a `.tsx`). It holds
`DEFAULT_FILES_TREE_WIDTH` (304 — the px twin of the old `19rem`, and the CSS
fallback must move with it), `MIN_FILES_TREE_WIDTH` (160, below which rows clip;
the collapse toggle, not the drag, is how you get smaller),
`clampFilesTreeWidth(width, max)` — `max` measured live off the layout by the
caller (`.files-panes`' right edge minus the content half's own 320px floor), so
it is not a constant in the module — plus `load`/`save`/`clear` and the
collapsed flag. Every path out of the module returns an in-range value or the
default: a stored value is as untrusted as a mid-drag pointer position, and the
component clamps again on mount and on every window resize, so the state never
*holds* an out-of-range width, it does not merely render one.

Both preferences are **localStorage**, machine-local, and **one global setting
for the Files tab across every project** — not per-project, not a store column,
no route, no place in a backup. Same posture as `navWidth`/`navCollapse`/
`lastFolder`. (They are therefore not reset by the project-change reset that
clears tabs, `expanded` and `childrenCache`.)

Two things about the layout are load-bearing:

- **The width is a CSS custom property (`--files-tree-width`) on the pane,
  never an inline `width`.** At ≤860px the panes stack and the pane relaxes to
  `width: auto`; an inline width would beat that rule and hand a 390px screen a
  drag-width tree — exactly the trap `navWidth` documents.
- **The collapse is CSS-only, and every rule for it lives in one
  `@media (min-width: 861px)` block.** The rail and the tree are both always
  rendered; below the wide tier there is simply no rule to hide either, so the
  collapsed flag cannot leak into the stacked layout. That is what keeps it
  independent of the phone tier's `treeOpen` (task 559), which collapses the
  tree behind a breadcrumb toggle at ≤600px and is inert above it: neither flag
  reads the other, and no new `matchMedia` was introduced — the breakpoint stays
  in CSS alone (`docs/mobile.md`). `treeOpen`'s own hide rule moved from the
  `<ul>` to the pane, so a phone-tier collapse takes the wide tier's toggle with
  it instead of leaving a lone `«` above the file.

Scope is the tree pane only: the `files-panes` split ratio divider (task 670),
`FileHistoryPane` and the editor stack are unchanged.

## Creating a file from the tree (task 672)

The surface's one create. Scope is deliberately a *file*: no delete, rename,
move or duplicate, no folder create (that stays `POST /api/fs/dirs` in the
new-project picker, on its own stricter loopback-only gate), and no implicit
intermediate directories — `create_file` is one `fs::write`, never
`create_dir_all`.

- **The affordance.** A `+` on every directory row (`.files-tree-add`), and one
  for the project root in the tree pane's header rail (`.files-tree-head`,
  beside the collapse toggle — the root has no row of its own to hang it on).
  Revealed on hover and on `:focus-visible`, so it stays reachable by Tab
  without adding permanent noise to a column of paths, and always visible under
  `@media (hover: none)`, where there is no hover to reveal it with. A
  directory row's own `onClick` toggles that directory, so the button
  `stopPropagation()`s.
- **The naming row.** Clicking `+` opens an inline `<li>` with an autofocused
  input as the first child of that directory (root creates go at the top of
  `.files-tree`), expanding the directory first so the row has somewhere to
  appear. Enter submits, Escape cancels, blur cancels; at most one row is open
  at a time, which is why `FilesView` holds a single `newFileParent: string |
  null` (`''` = root) rather than a set. The input is never `disabled` while
  the create is in flight — a browser blurs a control it disables, and blur
  cancels — so "busy" is enforced in the submit handler instead.
- **The naming rules are a pure module**, `frontend/src/newFile.ts` with
  `newFile.test.ts` (CLAUDE.md's frontend-test invariant: logic worth testing
  lives in a module, not inline in a `.tsx` — the rule that produced
  `navOrder.ts` and `fileTabs.ts`). `newFilePath(parent, name)` trims and
  answers either the relative path to POST or a rejection reason, applying the
  client-side twin of the server's single-component checks (empty, `.`/`..`,
  any `/`, `\` or NUL). The server stays authoritative: this copy exists to
  turn an obviously bad name into an instant inline message instead of a round
  trip, never to be the boundary. A rejected name fires no request; a server
  409/422/404 renders in the same place and keeps the row open, the same shape
  as the editor's inline `saveError`.
- **After a create.** The target directory is expanded, its `childrenCache`
  entry replaced by a fresh `getProjectFiles(projectId, dir)` (root creates
  re-fetch the root through the tab's own loader) — which sees the new file
  because the handler already evicted the server's 5s tree-cache entry for that
  level — and the new file is opened in the focused pane through `fileTabs.ts`'s
  `openFile` via the existing `commit()`, never a hand-rolled `TabsState`
  transition. The file is empty and non-binary, so the existing **Edit** button
  works on it unchanged; that is how content gets in.
- **An empty project root now renders the tree pane** with a
  `This folder is empty.` row inside `.files-tree`, instead of replacing the
  whole layout with a placeholder. The layout has to exist for the root's `+`
  to exist, and an empty project is precisely when creating the first file is
  wanted.
- **No new keyboard surface** (`docs/keyboard.md`): the `+` and the input are
  ordinary focusable controls, no global single-key shortcut. The naming row
  lives inside `.files-tree-pane`, so the pane's width/collapse (task 671) and
  the phone tier's stack (task 559) apply to it unchanged.
