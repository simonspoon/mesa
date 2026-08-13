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
  paths in one check. `read_file`, `read_file_download`, `write_file`,
  `tree_level` and `create_file` are its only callers — and `create_file` is
  the one that resolves something other than the request path itself (see
  below).
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
  branches — it describes the file, not the content. `.xml` and .NET's
  `.csproj`/`.xaml` — XML documents wearing a bespoke extension — all tag as
  `xml` (task 823), which `prismGrammar` resolves onto the already-registered
  `markup` grammar, so this costs no new grammar in the bundle.
- `pub fn read_file_download(root: &str, rel: &str) -> Result<(String,
  Vec<u8>), DownloadFileError>` (task 683) returns `(basename, full bytes)` —
  the file, not a view of it. It resolves `rel` through the same `safe_path`
  and rejects a directory the same way, but shares nothing else with
  `read_file`: no `FILE_CONTENT_CAP`, no binary sniff, no lossy UTF-8. It
  stats first (`fs::metadata().len()`) and returns `TooLarge` for anything
  over `FILE_DOWNLOAD_CAP` (100 MiB) rather than reading it; every other
  failure — `safe_path` rejecting `rel`, a directory, any `fs` error —
  collapses to `NotFound`, `write_file`'s precedent. The cap exists because
  the crate has no streaming-body dependency (no `tokio-util`), so the
  response is built from a `Vec<u8>` held whole in memory; adding a
  dependency to stream instead is a separate decision. The basename is the
  **resolved** path's final component (never a directory prefix out of
  `rel`), falling back to `rel` only when there is none. `read_file` and
  `FILE_CONTENT_CAP` are untouched by this path.
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
- `GET /api/projects/{id}/files/download?path=<relpath>` (task 683) → the
  file's raw bytes via `files::read_file_download`. Same `?path=` contract as
  the content GET above and the same error mapping — missing `?path=` is 422
  `validation`, and no `local_path` / dead folder / anything `safe_path`
  rejects is 404 `not_found` with the identical `file not found: <path>`
  message. `DownloadFileError::TooLarge` is the one addition: 422
  `validation`, "file is larger than mesa can download". No new error code.

  **Why a route and not a client-side blob of `content`:** the content GET
  returns `content: ""` for a binary file and caps text at
  `FILE_CONTENT_CAP`, so building the download in the browser from that
  payload would hand the user an empty or silently truncated file — and
  binary and truncated files are precisely the two the viewer can show
  nothing useful for, which is where the button earns its place. So the
  affordance is offered for **every** file, unlike Edit.

  `Content-Type` is a **fixed** `application/octet-stream` — never sniffed,
  never derived from the extension, so a repo's own `.html`/`.svg` can never
  be served inline as same-origin markup off this API. `Content-Disposition`
  comes from the **existing** `content_disposition()` helper the attachments
  download uses (quoting + RFC 5987 escaping included), not a second copy.
  Gate: the standard `guard` only, like the content GET and the git reads —
  it is a read, so neither `require_local_path_write` nor
  `require_agent_access` applies and the Content-Type gate doesn't fire on a
  GET. Adding a download does not make this surface a delete, rename or move:
  it still has none of those.
- `GET /api/projects/{id}/files/raw?path=<relpath>` (task 801) → the file's
  raw bytes with a **real image mime type**, for an `<img src>`. Same `?path=`
  contract and the same `files::read_file_download` read as the download route
  above — missing `?path=` is 422 `validation`, `TooLarge` is 422, and no
  `local_path` / dead folder / anything `safe_path` rejects is 404
  `not_found`. What is new is a gate between the path resolve and the read:
  the extension allowlist (`files::image_mime`), which is the only thing that
  decides a content type on this API and answers 422 `validation`
  (`not a previewable image: <path>`) for everything else — see the section
  below. Response headers are fixed: `Content-Type: <the allowlisted mime>`,
  `Content-Disposition: inline; filename="…"` (the **same**
  `content_disposition()` helper the download and attachments routes use, with
  `inline` in place of `attachment`), `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`. Gate: the standard `guard` only, like the tree/content/download
  reads — it is a read, reachable in default mode and under `--lan`, and the
  Content-Type gate doesn't fire on a GET.
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
- Tree listing, content reads and the byte download stay standard-guard-only,
  like the Git tab —
  no agent-style gate (browsing executes nothing) and no Content-Type gate
  (GET-only). The two writes above are the exception: both are gated by
  `require_agent_access` and both, being mutations with JSON bodies, sit
  inside the global Content-Type/CSRF gate.
- Web UI: `FilesView` (`frontend/src/pages/FilesView.tsx`) under the project
  tabs — a left-hand expandable file tree (`.files-tree`, directories
  toggled open/closed in local component state, no deep-linking) and a
  right-hand **content half holding many open files as tabs** (task 670, see
  its own section below), registered like the Git/Agents/Diagrams tabs (a
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
  The viewer's header is `position: sticky` inside `.files-pane-body` (task
  697) — the pane is the only scroller, so the path, badges and the action
  group stay pinned at its top and Edit/History/Download are reachable from
  the bottom of a long file instead of being a scroll back up; it is opaque
  and bleeds into the pane's gutters so the file passes fully behind it, and
  the pane gives up its top padding to the header for the same reason. Inert
  at the ≤860px tier, where the pane sizes to content and `main` scrolls.
  The header (`.files-header-actions`, hidden in edit mode) carries
  up to three controls. **Download** (task 683) is the only one shown
  unconditionally — binary and truncated files get it too — and sits last,
  after Edit and History. It is a real `<button>`, not an `<a download>`,
  because the app's button chrome hangs off the `button` element selector in
  `index.css`; consequently the feature needed no new CSS. Clicking it
  `fetch`es `projectFileDownloadUrl()`, then clicks a throwaway
  `<a download={basename(path)}>` at an object URL it revokes immediately.
  Going through `fetch` rather than a plain link is what keeps a 404/422
  *inside* the pane (the API's own `error.message`, in the existing
  `saveError` slot) instead of navigating the SPA away to a JSON error page;
  the button is disabled while a download is in flight, mirroring Save. A
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
  `InlineEdit`'s own error handling. **Closing** a tab mid-edit discarded its
  draft silently until task 809, which put one inline prompt in front of that
  one click — the app's only confirmation, and only where the close actually
  destroys work (see the task 809 section below). Merely *switching* tabs
  discards nothing: see the tabs section below for which half of that changed
  in task 670 and why.
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
  already used for diagram frame cards) instead of raw/highlighted text —
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
  discards it — since task 809 behind a prompt when that is what the close
  destroys, but the mechanism is unchanged: every `TabsState` write goes through
  `FilesView`'s `commit()`, which drops the `FileUiState` of any path no longer
  in `openPaths()`. Only the **active** tab of each pane is mounted, so a dozen
  open files is never a dozen live syntax highlighters; `ContentPane` still
  carries `key={path}` so `useFetch` and the editor start clean per file,
  exactly as the pre-tabs `key={selectedPath}` did.
- **Lifetime.** Tabs, order, active tab, focus, split and ratio (`TabsState`)
  are **remembered per project** in `localStorage` under one key,
  `mesa-open-files`, so leaving the tab, switching project or reloading comes
  back to the same open set (mesa task 696). `frontend/src/openFiles.ts` owns
  that key — `fileTabs.ts` stays storage-free, the pure transitions module.
  `FilesView` seeds its state from `loadOpenFiles(projectId, narrow)` (at mount
  *and* on the render-time project-change reset) and persists with one effect
  on `[projectId, tabs]`; every mutation already funnels through `commit()`, so
  there are no save calls in the handlers.
  - Reads are **total**: absent, unparseable, non-object or structurally
    invalid all resolve to `emptyTabsState()`, and a salvageable entry is
    *repaired* rather than trusted — duplicate/non-string tabs dropped, an
    `active` that isn't in its pane pulled back to a member, an empty right
    pane dropped, `focused: 'right'` without a right pane corrected, `ratio`
    through `clampRatio`. A hand-edited or older-shape value can never render
    a state `fileTabs.ts`'s invariants forbid.
  - `narrow === true` folds a stored split via `collapseSplit()` **on load**:
    the tier fold below is edge-triggered, so a split stored at 1400px and
    restored at 360px would otherwise never be folded.
  - An empty state **deletes** that project's entry instead of storing an empty
    object, so the key doesn't accumulate noise.
  - Still **not** persisted, deliberately: `fileUi` (edit drafts, edit mode,
    open History, selected commit) — an unsaved draft surviving a browser
    restart is a different, riskier feature, so drafts keep the component's
    lifetime and die on unmount; tree `expanded`/`childrenCache`/`treeOpen` and
    scroll; and anything server-side — no DB column, no migration, no API
    route, no CLI change. This is machine-local browser state, like
    `lastView.ts` / `lastFolder.ts` / `filesTreeWidth.ts`. There is still no
    URL hash deep-linking into the tree.
  - **Stale paths are not pruned.** A remembered file deleted or renamed on
    disk since is restored as a tab and shows `ContentPane`'s ordinary per-file
    fetch error; closing it drops it from storage. No validation round-trip, no
    reconciliation against the tree fetch.
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
  unchanged. (Task 809 later added *chords* — `Alt+W`, `Alt+[`/`]` and
  `Cmd/Ctrl+F` — on a sibling suppression predicate; still no single-key
  shortcut, and the reasoning is in `docs/keyboard.md`.)

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

## Inline images (task 801)

An image in the tree used to be "Binary file — cannot display", and a
`![](./logo.png)` in a rendered `.md` was a broken-image icon: the content GET
returns `content: ""` for a binary file, and nothing on this API would hand a
browser bytes it would paint. `GET .../files/raw` is that one route, and its
whole design is about giving up as little as possible to get it.

**The extension allowlist is the boundary.** `files::image_mime` maps a
path's lowercased final extension to one of exactly eight types — `image/png`,
`image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/x-icon`,
`image/svg+xml` — and answers `None` for everything else, which the route
turns into 422 before it reads a single byte. There is no sniff, no
fallback type and no `text/html` anywhere on this API: an extension not on
that list cannot come back from this route *at all*, so "which content types
can mesa emit for repo bytes" is answerable by reading one `match`. Only the
final extension counts, so `foo.png.html` is an `.html` file and is refused.

The allowlist is checked **after** `safe_path` and before the read, so the two
refusals never blur: anything that escapes the root is 404 `not_found`
(`?path=../../etc/passwd` and `?path=../logo.png` alike, image extension or
not), exactly like every other read on this tab, and 422 means only "inside
the repo, not an image". Ordering it this way keeps the route from becoming an
oracle that tells a caller which of the two it got wrong, and resolving a path
is cheap — the allowlist still stands between a non-image and any file read.

**`/files/download` is deliberately not relaxed.** It keeps its fixed
`application/octet-stream` + `Content-Disposition: attachment` and serves
every file; raw serves only images and always `inline`. Two routes, two
postures — merging them would mean either sniffing types on the download (the
thing its own docs above rule out) or letting the inline route serve
arbitrary bytes. The gate script asserts the download's headers precisely
because raw is the change that could have tempted a relaxation.

**An SVG gets a real mime only because of how it is consumed.** `image/svg+xml`
is same-origin markup that can carry script, so it is the one entry on the
list that would be dangerous served naively. Three things hold it: it is only
ever loaded through an `<img>` element (which never runs script in an SVG),
`X-Content-Type-Options: nosniff` stops a browser re-deciding the type, and
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
sandbox` neuters the document if it is ever opened directly — no fetches, no
script, no same-origin identity. Removing any one of the three is what would
make this unsafe; they ship together or not at all. (`style-src
'unsafe-inline'` is the single concession, so a legitimate SVG's inline
`<style>` still paints.) The content GET's `language_of` also learned `"svg"`,
so an `.svg` opened in the editor is still ordinary text with syntax colour —
raw is about how it is *rendered*, not about reclassifying it.

**Markdown image resolution is client-side and refuses more than it
resolves.** `frontend/src/markdownAssets.ts`'s `resolveMarkdownImageSrc(fileDir,
src)` answers the repo-relative path to load, or `null` for "render no image".
Relative sources resolve against the **markdown file's own directory**
(`fileDir`, `""` at the root), a leading `/` against the repo root, and the
result is served through the raw route. `null` — rendered as inert muted alt
text (`.markdown-img-missing`), never a broken-image icon — covers `http:`/
`https:`/`data:`/any other scheme, protocol-relative `//host/…`, a bare
`#anchor`, and any `..` chain that walks above the repo root, so the browser
never issues a request mesa would have to refuse. `Markdown.tsx` gained one
optional `resolveImageSrc` prop for this; every other caller omits it and
keeps react-markdown's own `img` untouched. `frontend/src/fileImage.ts` holds
the client's mirror of the server allowlist (same relationship
`syntaxHighlighter.ts` has to `language_of`) and decides when the *content
pane itself* shows an image instead of the binary placeholder.

Relative markdown **links** (`<a href>`) are still **not** rewritten — a
`[see](./other.md)` remains whatever react-markdown makes of it. Resolving
those means navigating the SPA into another file tab, a different feature with
its own questions (which pane, does it open a tab, what about a link out of
the repo); images are a render, links are a navigation.

`scripts/files-check.sh` is the gate: it seeds a throwaway project folder (a
real PNG, an SVG in a subdirectory, an `.html`, an `.md` and an extensionless
file), asserts the mime/`inline`/`nosniff`/CSP headers and byte-identical
bodies for both image types, the 422 for every non-image, the traversal and
missing-`?path=` cases, the download route's unchanged headers, and — in
**both** serve modes — that raw is reachable while the PATCH write keeps its
`require_agent_access` + Content-Type gate.

## Editor affordances: gutter, status bar, indentation, find, dirty tabs (task 809)

Four slices that make the pane behave like an editor rather than a textarea.
**Frontend-only**: no route, no `src/core/files.rs` function, no store method,
no migration, and the same two writes as before (`PATCH` content, `POST`
create). Everything here is a rendering or a keystroke.

As everywhere in this app, the decisions are pure modules with vitest
coverage and the `.tsx` files hold only the DOM: `editorStatus.ts`
(caret/line arithmetic), `editorInput.ts` (what a keystroke edits),
`fileFind.ts` (matching and stepping), `wordWrap.ts` (the stored preference)
and `fileDirty.ts` (what "unsaved" means), plus `cycleTab` in `fileTabs.ts`
and `shouldIgnoreFilesShortcut` in `keyboardScope.ts`.

- **Line numbers and a status bar.** The gutter is another layer of the
  existing `.files-editor-stack` in edit mode and a sticky-left column beside
  the code in view mode — `aria-hidden`, `user-select: none`, so a copied
  selection is code and nothing else, and aligned *by construction* (one
  `<pre>` of newline-joined numbers inheriting the row's font metrics), never
  by measurement.
  - **"By construction" costs one `!important` per stack, and it is
    load-bearing.** react-syntax-highlighter puts vsc-dark-plus's
    `pre[class*="language-"]` block *inline* on the `<pre>` it emits —
    `font-size: 13px; line-height: 1.5` — and `customStyle` overrides only
    margin/padding/background, so the highlighted path is 19.5px per line while
    a 0.8rem/1.4 gutter or find layer beside it is 17.92px. That is 1.58px of
    shear per line: a full line wrong by line 12 and two by line 30, on every
    file with a registered grammar, i.e. the case users hit most. Both stacks
    therefore state the metrics once on the container (`.files-editor-stack`,
    `.files-code-layout`) and force the Prism `<pre>`/`<code>` back to them
    (`.files-editor-highlight pre`, `.files-code-main pre`). An inline style
    beats any class selector, so `!important` is the mechanism, not a
    shortcut — and the metrics living on the container is what makes
    "inherit" mean the right thing for the code, the numbers and the
    highlights at once.
  - **`tab-size: 4` is part of those metrics, and `font: inherit` does not
    carry it.** The `font` shorthand resets the font properties and nothing
    else, so the Prism `<pre>` forced back to the row's font kept
    vsc-dark-plus's inline `tab-size: 4` while the gutter and the find layer
    beside it used the initial 8 — on a tab-indented file with a grammar (Go,
    shell) every highlight landed four columns right per leading tab, half a
    word off one tab in and highlighting the wrong text three tabs in. Both
    stacks state it on the container beside the other metrics; the viewer
    matching the editor is also what stops Edit visibly reflowing every
    indented line to half its width and back again on Cancel.
  - The editor's gutter is **sized from the count it holds**, not fixed:
    `gutterDigits(lineCount)` rides down as a `--files-gutter-digits` custom
    property that feeds both the rail's width and the padding clearing the text
    layers of it, so the two can never be sized against different numbers. Its
    predecessor was a fixed 3.25rem, about five digits, with
    `text-align: right` and `overflow: hidden` — which clips on the *left*, so
    line 131072 of a 256 KiB log painted as `31072`: not a truncated number a
    reader would recognise but a plausible wrong one. The view-mode gutter has
    never needed this (it is `flex: none` and sizes to its content).
  - **Being opaque and over the scrollport, the editor's gutter has to be
    declared to two separate reveals.** The padding that clears the text layers
    of it is scrollable content, not a reserved strip, so at any `scrollLeft > 0`
    the leftmost visible column is real text. The find reveal is handled in JS
    (`scrollLeftForBox`'s lead-in, below), but the *caret* reveal is the
    browser's own and scrolls the minimum amount: holding ArrowLeft back along a
    line longer than the pane parked the caret flush at the padding-box edge —
    behind the numbers, with the user typing and deleting text they could not
    see. `scroll-padding-left` on the textarea, sized from the same
    `--files-gutter-digits` as the padding and the rail, is the one hook a UA
    scroll-into-view offers for "this band of the scrollport is covered", which
    is why it is a declaration rather than a caret listener. Both reveals clear
    the gutter by the identical amount — the full padding, so a match or a caret
    arrives with the 0.75rem channel of code beside it rather than abutting the
    numbers. Neither applies under soft wrap, where there is no gutter.
  - The view-mode row is also `width: max-content`: a `position: sticky`
    column is clamped to its containing block, so a row only as wide as the
    scroller lets the gutter detach and scroll away once a minified file or a
    long import line is scrolled further right than that.
  - **That row's sideways scroll is caught by its own box**
    (`.files-code-scroll`), not by the pane. The pane's three bars — header,
    find bar, status bar — are sticky on the vertical axis only, and `top`/
    `bottom` pin nothing sideways, so a `max-content` row overflowing the *pane*
    slid all three leftwards out from under the code and off screen, and in
    history mode dragged the commit list with them. Making them stick sideways
    too is not the fix it looks like: a sticky box is clamped to its containing
    block, so `.files-content` would have to be `max-content` wide as well, and
    everything else in that column — rendered markdown, the history layout, an
    error line — would then lay out at the width of the file's longest line,
    prose included. Two boxes, because a scroller's own children are clamped to
    its width: the row that overflows and the box that scrolls it cannot be the
    same element. Vertical scrolling is untouched (the box's height is its
    content's), and this is what vsc-dark-plus's inline `overflow: auto` on the
    Prism `<pre>` already did for every highlighted file before the gutter
    existed.
  - The status bar (`.files-status-bar`) is pinned to the bottom
    of the pane the way the header is pinned to its top, and carries Ln/Col while
    editing, the line count, the language and the wrap toggle. **Not by the same
    mechanism**, though: the header sticks at the *start* of the flow and is on
    screen from the first paint, while a sticky *bottom* only engages once the
    column outgrows the scrollport — so on any file shorter than the pane the
    bar would sit in normal flow under the last line with dead pane below it.
    `.files-content` is a full-height flex column (`min-height: 100%`) and the
    bar takes the slack with `margin-top: auto`; sticky carries the long-file
    half. The 0.5rem that used to be the header's bottom margin is the column's
    `gap`, so the auto margin cannot eat it. Sitting *flush* is a third thing
    again, and it is the pane's: a sticky box pins against the scroll
    container's content box, so the pane's own 0.5rem bottom padding left the
    bar 8px short of the bottom edge with the scrolled file painting through the
    strip below it. The pane gives that padding up wherever this bar is rendered
    (`.files-pane-body:has(.files-status-bar)`), which fixes both halves at once
    — the column is `min-height: 100%`, so it grows by the same 0.5rem — and a
    negative bottom margin on the bar does not, since it moves the box and not
    the pin.
  - **In this pane the editor stack takes the pane's height** rather than the
    base rule's 60vh (`.files-content > .files-editor-stack { flex: 1 }`), and
    gives up its resize grabber with it. The status bar is what made the
    difference conspicuous: with the column full-height and the bar taking its
    slack, any window taller than 60vh put the Ln/Col readout at the pane's
    bottom edge with a band of empty pane between it and the last line — and the
    textarea's own scrollbar nested inside the pane's. An IDE's editor fills its
    pane. Scoped to this context rather than changed on the base rule, because
    the Scripts page's body box is one field of a form, where a fixed 18rem and
    a grabber are right; `min-height: 12rem` still holds the box open on the
    stacked/narrow tier, where the pane is sized by its content.
  - **Two line counts, deliberately** (`lineCount` vs `viewerLineCount`): a
    textarea shows a trailing newline as a real empty last line and a `<pre>`
    swallows one, so the editor and the viewer count differently. Each drives
    *both* its own gutter and its own status bar, which is what makes it
    impossible for the bar and the last number beside it to disagree.
  - **Soft wrap hides the gutter outright**, in both modes. A wrapped logical
    line is several visual rows, so logical numbers cannot stay beside it;
    numbering *visual* rows needs the browser to report where each wrap fell,
    which it will not. Hiding is the one answer that cannot silently desync.
    The preference is `wordWrap.ts` — localStorage, one global setting for the
    tab, same posture as `filesTreeWidth.ts`; held in `FilesView` so both panes
    of a split and every tab agree on it, and threaded as far as a markdown
    file's frontmatter panel, so one pane never renders its two halves under two
    different wrap rules.

    "Wrap on means no line numbers" is a **known gap**, and the way every other
    editor closes it does not reach here. They give each logical line its own
    grid row — a number cell beside a code cell as tall as that line wrapped —
    which needs the code split into one element per line. In the editor the code
    is a single `<textarea>`: one element by definition, and the only thing
    holding the caret, the selection and the undo stack. In the viewer it is one
    Prism tree whose spans cut across line boundaries, so cutting it into rows
    means rewriting somebody else's markup by offset — precisely what the
    overlay `FindLayer` exists to avoid. Neither is a measurement problem, so
    neither is fixed by measuring more carefully.
  - **Soft wrap is what made a scrollbar an alignment problem**, so all three
    layers of the editor stack carry `scrollbar-gutter: stable`. Only the
    textarea scrolls, and on any platform with classic space-taking scrollbars
    (Windows, most Linux, macOS set to "Show scroll bars: Always") it alone lost
    ~15px of content width to one — wrapping a character or two earlier than the
    overlay layers, which put the colours and the find marks a whole visual row
    off the caret from the first differing line down, and worse with each one
    after. With `wrap="off"` the difference cost nothing because nothing wrapped;
    that is what the toggle removed, and reserving the same strip on every layer
    is what restores "aligned by construction" rather than "aligned on machines
    with overlay scrollbars".
- **Editing keys** are decided entirely by `editorKeyEdit()` in
  `editorInput.ts`: Tab/Shift+Tab (indent, block-indent a multi-line selection,
  dedent), Enter (carry the leading whitespace, one more unit after `{ [ (`,
  the three-line expansion when the closer is under the caret), auto-closing
  and typing over a pair, and Backspace between an empty pair. `null` — the
  default answer — means the keystroke is untouched, which is what leaves IME,
  spellcheck and ordinary typing alone. Three things make that claim true rather
  than nearly true:
  - **A composing keystroke is never ours.** `CodeEditor` returns on
    `e.nativeEvent.isComposing` before anything else. The Enter that *commits*
    an IME candidate arrives as a keydown with `key: 'Enter'` and
    `isComposing: true`, and `autoIndent` answers non-null on any indented
    line — so without the guard the one key IME users press most tore the
    composition down and inserted a newline instead of the candidate.
  - **Escape arms one Tab as a plain focus move** (`tabEscapeAfter`), the
    CodeMirror convention, and any other typed key disarms it. Taking Tab from
    the browser otherwise takes the last keyboard route out of the box on any
    indented line: Tab inserts, and Shift+Tab only falls through once there is
    nothing left to dedent. That is a keyboard trap (WCAG 2.1.2) — worst on the
    Scripts page, where this editor is one field of a form whose other controls
    sit below it and nothing binds Escape at all (`docs/scripts.md`).
  - **The indent unit is the file's, not this repo's** (`detectIndentUnit`).
    This editor browses arbitrary repos — mesa's own `src/*.rs` is four spaces
    and `scripts/*.sh` is tabs — and a hardcoded two spaces indented both
    wrongly, the second one *mixedly*: `autoIndent` carries the line's existing
    tabs (correctly, it is whitespace-agnostic) and then appended two spaces
    after `{`, so a tool opened to change one line wrote tabs-and-spaces back to
    disk. The rule is a tally of the leading whitespace of the first 200
    indented lines — most common width wins, ties to the narrower, tabs winning
    outright when they outnumber every single space width — with `INDENT_UNIT`
    as the fallback for a file with nothing to learn from. It decides what a
    *new* indent looks like and never rewrites indentation already on disk, so a
    wrong answer is only ever as wrong as the fixed unit was.
  - **Typing over a closer asks whether that closer is already spoken for**
    (`typeOverStepsPast`), not merely whether one is under the caret. The bare
    rule made a literal closer *untypable* wherever one already sat there:
    `foo)` with the caret before the `)` could never become `foo))`. VS Code
    answers it from a record of the pairs it inserted, remapped through every
    later edit — a mutable per-document decoration this pure module has nothing
    to hold — so it asks the question that tracking is a proxy for. For a
    bracket that is an unmatched opener before the caret (`bar(|)` steps over,
    `foo|)` inserts), which covers every auto-closed pair exactly, since the
    editor only ever closes after inserting the opener. For a quote there is no
    opener to tell from a closer, so it is an odd number of that quote earlier
    on the line — the caret is inside the run this one terminates. That also
    fixes a case the bare rule got wrong in the other direction: typing `'` in
    front of an existing string (`x + |'b'`) no longer jumps silently into
    somebody else's. It does not open a pair there either — the keystroke falls
    through to the auto-close rule, which refuses to close in front of a `'`, so
    the browser types one bare quote, exactly as a plain textarea always did.
    Both are heuristics over text with no
    grammar behind them, the same standing every rule in this module has.

  **Applying an answer goes through `document.execCommand('insertText')`**
  (or `'delete'`, since `insertText('')` is a no-op in some engines), never an
  assignment: setting a textarea's value from script wipes the browser's undo
  stack, so one auto-indent would otherwise cost the user every keystroke typed
  before it. `replacementRange(before, after)` reduces any answer to the single
  contiguous span to select first, because execCommand only ever replaces the
  selection. A refused command falls back to the plain `onChange` — correct
  text, forfeited undo, never a dropped keystroke. The caret is restored in a
  layout effect, before paint.
- **Find in file** (`Cmd/Ctrl+F`) is a literal scan, **never a `RegExp`** — a
  query is typing, not a pattern language. Case folding is per *character*
  rather than `text.toLowerCase()`, because `'İ'.toLowerCase()` is two code
  units and a lowercased copy is no longer offset-for-offset the string about
  to be highlighted. Whole-word demands a boundary only on the sides the query
  itself ends in a word character (VS Code's rule), so `(x` still finds `f(x)`.
  Capped at `MAX_FIND_MATCHES` (2000), found one *past* the cap so the `2000+`
  label is exact rather than "the array happened to be full".

  **Highlights are a separate inert `<pre>` of the same text laid over
  untouched Prism output** — one shared `FindLayer`
  (`frontend/src/components/FindLayer.tsx`) for both the viewer and the editor
  stack, so the class marking the current match cannot drift between them.
  Never spliced into Prism's markup, whose nested spans cut across match
  boundaries: the worst a bug in an overlay can do is misplace a background.
  Same trick and same alignment rules as the editor's highlight layer.
  Revealing a match deliberately does **not** focus the textarea — the bar
  keeps the caret so Enter keeps stepping — which is exactly why the editor
  needs that layer at all, since browsers paint an unfocused selection faintly
  or not at all. The editor's reveal-scroll is arithmetic
  (`scrollTopForLine`, minimal movement, since there is no element inside a
  textarea to scroll to) with wrap **off**, and a measurement of the current
  `<mark>`'s own `offsetTop` (`scrollTopForBox`, from an effect, since the mark
  does not exist in the DOM until React has rendered the new index) with wrap
  **on** — wrapped, a logical line is several visual rows and the arithmetic
  undershoots, and skipping the scroll instead was worse than either: the
  counter stepped and the view sat still, silently, for the rest of a session in
  which the user had turned wrap on.

  **Sideways is measured in both wrap modes** (`scrollLeftForBox`, from the same
  effect), and it is not optional: because the reveal deliberately does not
  focus, nothing scrolls the selection into view on its own, so a match past the
  pane's right edge — a long import, a minified file, any line past ~100 columns
  in a split pane — moved the counter and the current-match class and showed the
  user nothing, while the *viewer* revealed the same match correctly on the same
  keystroke. Measured rather than calculated because a column offset is not a
  pixel offset once a tab or a wide glyph is in the line. It carries a **lead-in
  for the gutter**, which is an opaque layer over the left edge of the same box:
  without it a match brought exactly to `scrollLeft` lands under the numbers and
  the reveal reports success. Nothing vertical needs one — the header and the
  status bar are outside that box.

  That effect is armed by the `reveal` call
  itself — a `pendingReveal` ref, the same shape as the pending caret — and
  **not** by a dependency list, because a step is an event and neither value it
  could be inferred from says so: `matches` is a fresh array on every keystroke,
  so listing it scrolled the pane back to the match on every character typed
  while the caret was elsewhere in the file, and `current` alone misses the
  legitimate no-op step (`(0 + 1) % 1 === 0` — Enter on a one-match file), which
  is the "counter stepped, view sat still" failure over again.

  **The viewer's reveal is a real `scrollIntoView` on the current `<mark>`
  vertically, and the same `scrollLeftForBox` sideways** — armed by the same
  `pendingReveal` ref, for the same reason: a one-match file's Enter is
  `(0 + 1) % 1 === 0`, so a dependency list on `current`/`matches` never fires
  and the counter reads "1 of 1" over a view that has not moved. The vertical
  half is correct in both wrap modes and needs nothing else — the element exists,
  so the browser is the thing that knows where it ended up — except for the one
  thing `block: 'center'` will not do, which is *not* scroll: it re-centres
  unconditionally, so stepping between two matches on one screenful threw the
  file by half a pane on every Enter while the editor beside it (whose
  `scrollTopForBox` returns the scroll it was given for a box already in view)
  sat still on the same keystroke. `boxNeedsReveal` is that missing test, asked
  about the *readable* band rather than the scrollport — the sticky block covers
  its top and the status bar its bottom, and a match painted under either is not
  one the reader can see. (`block: 'nearest'` is not the answer: it would land
  the match flush at the scrollport's top edge, i.e. behind the header — the
  vertical twin of the gutter problem below.) The sideways half cannot be
  left to it: `.files-code-gutter` is `position: sticky` over the left edge of
  `.files-code-scroll`, and `inline: 'nearest'` brings a match lying left of the
  current view flush to that edge — under the numbers, with the counter and the
  `.current` class both reporting success, repaired by one more step, which is
  the flaky-not-broken signature this pane has produced before. `scrollIntoView`
  has no notion of an overlay; the scroller has a real `scrollLeft` and the
  gutter a real `offsetWidth`, so the correction is the editor's own pure
  function with the viewer's numbers, not a second rule. Only the *lead-in* half
  of it applies here (the vertical reveal has already happened), which is why the
  function takes the obscured band as an argument rather than owning one — and
  the viewer's number is the gutter's width **plus `.files-code-main`'s 0.5rem
  channel**, which is the same total the editor passes as one computed
  `padding-left`, so a match revealed from the left arrives with a column of code
  beside it in both panes rather than flush against the numbers in one of them.

  **A layer that mounts while the textarea is already scrolled is mirrored from
  a layout effect**, keyed on the two conditions that mount one (a non-empty
  match list, and `wrap`). `mirrorScroll` otherwise runs only from the
  textarea's `scroll` event and from a reveal, and neither fires when a *layer*
  appears — so the find layer, which mounts on the first match of a fresh query,
  painted lines 1-40's highlights over the text of line 80 with the current
  match nowhere on screen, repairing itself on the second character typed (which
  is what made it read as flaky rather than broken); and the gutter, which
  remounts when Wrap is turned off, showed 1..40 beside line 500. A layout
  effect, so the correction lands before the frame the layer first appears in is
  painted.

  **A fresh search anchors on what you are looking at** — the caret while
  editing, and in view mode the first line still on screen, measured off the
  pane's scroll (`lineAtScroll` + `offsetForLine`). Anchoring at 0 made Cmd+F
  halfway down a 2,000-line file land on the first match at the *top* and
  `scrollIntoView` yank the pane there. "On screen" means *readable*, so the
  sticky block's own height counts as scrolled away too: it covers the top of
  the scrollport, and without subtracting it the anchor was the first line in
  the scrollport rather than the first line the user can see — enough for a
  fresh Cmd+F to anchor on, and land on, a match hidden behind the header. Under
  soft wrap the anchor stays 0,
  deliberately: pixels ÷ line-height counts visual rows there, and overshooting
  *past* what you were reading is a worse answer than starting at the top.

  **The anchor then follows each step** (`anchorAfterStep`), and only a step
  moves it. Growing a query walks forward from the anchor, which is right while
  the bar has just been opened and wrong the moment the user has walked the
  file: Enter four times to a match 800 lines down and then one more character
  of query would otherwise teleport them back to the first hit of the *original*
  search. Re-anchoring on the current match is what makes refining narrow in
  place, and it leaves the fresh-open behaviour above untouched. The crossing
  between view and edit mode resets the anchor and the index instead of moving
  them: the two modes search different strings (the bytes on disk vs the
  LF-normalised draft), so in a CRLF file a carried offset is one character per
  preceding line wrong — the same reason `startEdit` resets the caret.

  **Cmd/Ctrl+F selects the query every time the bar comes up**, open or closed,
  because Cmd+F-then-type is the reflex the bar is for. On an already-open bar
  that is a `focus()` *and then* a `select()` — `select()` alone sets a range
  without moving focus, and the chord is deliberately allowed while the caret is
  in the code, so it left the next characters typed going into the file. On a
  fresh open it is an effect on `findOpen` rather than a call in `openFind`,
  since the input does not exist until React has rendered it: `closeFind` keeps
  the query, so the second Cmd/Ctrl+F re-mounts the box with the previous one in
  it, and `autoFocus` focuses without selecting — typing appended (`foofoobar`)
  instead of replacing.

  **The draft is LF-normalised at `startEdit`** (`normalizeNewlines`). A
  textarea's value is spec-defined to hand back every CR/CRLF as a single LF, so
  a draft seeded from the bytes on disk is not offset-for-offset the string the
  DOM reports: in a CRLF file the painted highlights were right while the
  textarea's selection and the reveal built from it were one character per line
  early, until the first keystroke replaced the draft with the browser's own
  copy. Normalising once makes that impossible, and makes the dirty comparison
  honest as well; the trade is that saving a CRLF file writes LF, which is
  already what happened the moment the user typed anything.

  **Every button in the bar hands the caret back to the query box.** Otherwise
  clicking `Aa` or `↓` moves focus onto that button and the next Enter
  re-activates *it* — re-toggling the option, or stepping the same way whatever
  Shift says — while Escape is answered by nothing. **Closing the bar hands the
  caret on rather than dropping it**, for the same reason: the query box is
  unmounted while it holds focus, and a control that disappears focused leaves
  focus on `<body>`, so Tab restarts at the top of the page and Escape reads as
  having done nothing. Editing, it goes to the code with the last match still
  selected in it. In view mode there is no control to hand it to, so
  `.files-content` carries a `tabIndex={-1}` purely as that target (and
  `outline: none` with it — a ring traced around the whole pane would read as a
  control). In view mode Escape is also
  bound at the document level while the bar is up, since there is no editor
  there to route it (`docs/keyboard.md`).

  Find is offered only where offsets mean something: not for a binary or an
  image, not over a commit's diff, and **not for markdown in view mode** — that
  pane is rendered prose, so the key is left to the browser's own find, which
  searches exactly what is painted. In edit mode markdown is source again and is
  findable.
- **A save keeps you in the editor.** It moves the `baseline` onto the draft and
  nothing else — the tab reads clean (below) with the caret, the scroll and the
  find bar all still where they were. Exiting on save was defensible while
  clicking a button was the only way to ask for one; binding Cmd/Ctrl+S changed
  what the action *means*, since that chord is the every-thirty-seconds reflex
  pressed mid-thought, and each press dropped the caret and the scroll, closed
  the bar and — on a markdown file — landed the user in rendered prose instead
  of the source they were editing. The button shares the keystroke's meaning
  rather than the other way round; **Cancel** is how edit mode is left.
- **Dirty tabs.** `isDirty` is `editing && draft !== baseline` — a
  `baseline` set at `startEdit` and moved onto the draft on a successful save —
  **not** a diff against the fetched content, because only `ContentPane` has
  that response and the strip painting the dot is two components above it.
  `editing` is part of the test rather than an optimisation: a *cancelled* edit
  leaves its draft behind and the user already said to drop it.

  A dirty tab wears a dot where its × goes, swapped back on hover or
  `:focus-within` in CSS alone — and shown *beside* the dot under
  `@media (hover: none)`, the same escape hatch the tree's `+` carries (task
  672), because the only touch route to a hidden × is to tap the label, which
  activates the tab, and Alt+W is not a phone answer. The dot is `aria-hidden`,
  so the state arrives
  in words through `tabLabel`/`closeLabel` on the two controls. Closing one
  **prompts** — `CloseConfirmBar`, the house inline two-step, never
  `window.confirm`. It answers Enter (its autofocused "keep editing") *and*
  Escape, which it binds on itself and stops from bubbling — the universal
  cancel was inert on the tab's one prompt, and the editor underneath answers
  Escape by discarding the very draft the bar exists to protect. It is raised
  only when the close actually discards something:
  `needsCloseConfirm` says no for a clean tab and no for a dirty file the other
  pane still holds, and the *same call* decides on every render whether the bar
  stays up, so it self-clears when the file is saved underneath it or the tab is
  dragged away. **Hiding the bar is not clearing the state**, and both happen:
  `needsCloseConfirm` is not monotonic, so a `pendingClose` left armed behind a
  hidden bar re-mounts the prompt the moment the tab goes dirty again — and its
  autofocused "keep editing" button then pulls the caret out of the code
  mid-keystroke. `requestClose` is the only thing that arms it; a render-time
  check against the same predicate is the only thing that disarms it without an
  answer. That is the one exception to the "closing a tab silently
  discards its draft" rule stated in the tabs section above; a `beforeunload`
  listener, armed by its effect's lifetime rather than by a flag inside a
  permanently-registered handler (which would also disable the bfcache), covers
  a reload or a window close.

  **What the dot covers is exactly four exits**, and the limit is deliberate:
  the tab's ×, a middle-click, Alt+W (all three `requestClose`), and a real page
  unload. Switching projects in the left nav and leaving the Files tab both
  still discard a draft with no prompt. There is nothing to put a bar in front
  of by the time either is observable here — the route has already moved, and
  the pane that would host the prompt is about to show another project's files —
  and the app has no navigation guard to hold it in. Keeping the drafts across a
  project change instead would be worse than losing them: `fileUi` is keyed by a
  path relative to the project, so the same `src/main.rs` in two projects would
  inherit the other one's unsaved text.

**Keyboard is `docs/keyboard.md`'s**, including why the chords are `Alt`-based,
why `Cmd/Ctrl+W` is deliberately unbound, and the Escape precedence between the
find bar and the editor. The Scripts page's body box mounts the *same*
`CodeEditor` and therefore inherits the gutter, the editing keys and the
Escape-then-Tab hatch that keeps them from trapping focus in a form field —
one component, no fork, per that component's own doc — but has no status bar, no
find bar and no `onSave`, so it keeps the browser's own Cmd/Ctrl+S. That
inheritance is recorded on the other surface's doc too (`docs/scripts.md`),
since a maintainer editing the Scripts form reads that one first.

Nothing here is reachable by `scripts/files-check.sh` — it gates the API, and
this task added none. The gate is `npm --prefix frontend run test` over the
modules above, plus khora for anything needing a rendered tree, real focus
routing or a trusted keystroke (CLAUDE.md's standing split).

## Project-wide search (task 813)

`Cmd/Ctrl+Shift+F` — every match of a literal query across the project's tree,
grouped by file, in a panel that takes the **tree pane's** place. Clicking a
result opens the file and shows the line.

This is the one slice since task 327 that is not frontend-only: the browser has
no tree to walk, so the search is a route and a `core::files` function, with
one pure module and the panel on top of them.

### The route

`GET /api/projects/{id}/files/search?q=<literal>[&case=true][&word=true]` →
`ProjectFileSearch` via `files::search_files`. A **fourth** read route rather
than a mode of the tree listing: that one answers "what is in this directory"
out of a 5s cache keyed on the directory, and a search is keyed on a query
nobody repeats — so nothing is cached here, like the content and diff reads.

- The `?q=` contract mirrors the content route's `?path=`: missing, empty, or
  longer than `files::MAX_SEARCH_QUERY` (200 characters) is 422 `validation`.
  No `local_path`, a dead folder, or a root that no longer resolves is 404
  `not_found` — the content route's collapse, *not* `ProjectFileTree`'s
  three-rung ladder, because a search is a request about a specific root rather
  than a description of the project's state. A query that simply matches
  nothing is a **200 with an empty `files`**: a state, not a failure, the same
  way an empty commit list is on the Git tab.
- Gate: the standard `guard` only, like the tree, content, download and raw
  reads beside it. It executes nothing, and the Content-Type gate does not fire
  on a GET. `spawn_blocking`, because it is a filesystem walk.
- **A literal scan, never a `RegExp`** — `fileFind.ts`'s rule, for its reason: a
  query is a user's typing, not a pattern language. The two options are the same
  two the find bar offers, with the same rules implemented the same way: case
  folded **per character** (a lowercased copy of a line is not
  character-for-character the line the snippet is cut out of), and whole-word
  demanding a boundary only on the sides the query itself ends in a word
  character (so `(x` still finds `f(x)`), against the same ASCII word set.

### What it reads is exactly what the tab can show

That correspondence is the reason this is not a `grep` shell-out, and every
piece of it is a reuse rather than a parallel rule:

- The walk is `tree_level`'s, applied recursively — `EXCLUDED_DIRS` skipped by
  name, directories before files alphabetically, and **symlinks never followed**
  (one rule covering escape and cycle at once). No result can name a path the
  tree would not list.
- A file is opened through the same `FILE_CONTENT_CAP`-bounded read and the same
  extension/NUL binary rules `read_file` applies. So a hit's **line number
  always exists in the viewer that opens next**, and binary bytes are never
  scanned or quoted.
- `root` is resolved once through `safe_path` and every descendant is reached by
  walking real directory entries from there — there is no request path to
  traverse with, and nothing outside `local_path` is ever opened.

Four caps bound the answer and the work, and hitting any of them sets
`truncated` on the result (the per-file one sets it on that file too, which is
what its `12+` count means): 50 matches per file, 200 files, 1,000 matches
total, and 20,000 files *opened* — the first three bound the response and the
DOM built from it, the fourth bounds a query that matches nothing in a huge
tree. The panel says `+` rather than claiming the project holds exactly this
many; an exhaustive answer for one file is the in-file bar, which has its own,
larger cap.

### Snippets carry no offsets

`FileSearchMatch` is `{line, text}` and nothing else. `text` is shaped
server-side — leading indentation dropped, windowed around the match
(40 characters of lead-in, 240 long), `…` marking either cut — and the panel
re-runs the **same literal scan** over it to paint the highlight
(`fileSearch.ts::snippetSegments`, delegating to `fileFind.ts`).

That is deliberate: a char offset computed in Rust is not a UTF-16 offset in JS,
and this side already owns the identical scan. When the two do disagree — a
snippet windowed through the middle of a match, a case-folding difference at the
edges — the cost is a row painted **without** a highlight, never a row pointing
somewhere wrong. Same posture as the find layer: the worst an overlay bug can do
is misplace a background.

### The panel

`SearchPanel` in `FilesView.tsx`, rendered **in place of** `.files-tree` inside
`.files-tree-pane`. That is the whole layout decision: it inherits the pane's
drag-width, collapse, resize handle and phone-tier stack (tasks 671/559) with no
new rule, and it leaves the file it points into fully visible beside it —
reading a result *is* reading the file. The tree is unmounted while it is up, so
the two can never scroll past each other in one column; reopening costs nothing,
since `childrenCache` outlives the swap.

- **The search runs on submit, not per keystroke.** Every other query box in
  this tab searches a string already in memory; this one is a filesystem walk of
  the whole project, and one request per character would have the server reading
  every file under `local_path` five times for `needle`. Enter sends it, a
  toggle re-sends it (a deliberate re-ask of the same question, and only once
  there is a result to re-ask), and the summary line says `Press Enter to
  search` before the first one.
- **The result carries the query it was found with** (`SearchRun`), so rows stay
  highlighted against *that* query while a new one is being typed over it.
- A stale response is dropped by a sequence number: a walk is slow enough that
  the answer to an older question can land after a newer one, and overwriting
  the new with the old is the classic version of this bug. The same counter is
  bumped on a project change, so an in-flight walk of project A can never land
  in project B.
- Nothing is persisted or deep-linked — no `localStorage`, no URL hash, no
  server state. Component lifetime, like the find bar one file down, and reset
  wholesale on a project change.

### Clicking a result: a landing, not a scroll

A click opens the file exactly as a tree click does (`fileTabs.ts::openFile`
through the existing `commit()`), and hands the pane that gets it a
`SearchLanding` — `{seq, path, line, query, caseSensitive, wholeWord}`.

The pane turns that into an **ordinary find**: the line becomes an anchor
(`offsetForLine`, the same function the status bar counts with) and the query
becomes the query, so `matchIndexFrom` picks the match and task 809's whole
reveal machinery shows it — correct in view *and* edit mode, wrap on *and* off,
with no second scroll rule. The reader also arrives with the in-file bar open on
that query, able to keep stepping through the file, which is the next thing they
want and would otherwise be a second `Cmd/Ctrl+F`.

Three details are load-bearing:

- **The find state is derived, not assigned.** `ContentPane` computes
  `find` as "the landing's, while one is active; otherwise the stored state",
  and every write to the bar (`setFind`) records the landing as consumed. So
  "take over from the panel" is one condition rather than an effect racing the
  first paint — and clicking the *same* result twice lands twice, because a
  fresh `seq` is simply not the consumed one. An effect would have painted the
  top of the file first and jumped a frame later, and would have needed its own
  answer to the second-click question.
- **The bar does not take the caret on a landing** (`FindState.autoFocus`,
  `FindBar`'s `takeFocus`). Focus belongs to the panel the reader is still
  clicking through; every way a *user* opens the bar still focuses and selects
  it.
- **The landing goes to whichever pane holds that path**, not to a chosen side.
  The same file can be open in both panes of a split, and both should show the
  line that was clicked.
- **The reveal is marked done when the match arrives, not when it is
  attempted** — and this one was found live. A *step* is armed by a call and
  lands on a pane that is already laid out; a landing is armed by a render of a
  pane that is usually still mounting, and on a large file (`src/api.rs`, 6,800
  lines) that first pass measured a layout the browser had not settled: the
  scroll was issued and nothing moved, leaving the counter reading `3 of 30`
  over the top of the file — the "counter stepped, view sat still" failure this
  whole reveal exists to prevent. So the effect re-measures after scrolling and
  only consumes the landing once the mark is inside the readable band,
  retrying on the next render otherwise, bounded by `MAX_LANDING_REVEALS` so a
  match the band can never contain cannot re-scroll indefinitely.

**A markdown file in view mode is the one result that opens without landing** —
it has no offsets once rendered as prose, which is exactly why `findable` is
false there, and there the click is simply "open this file" (the browser's own
find still works on what is painted). Being a *condition* on the derivation
rather than a discard, it resolves itself the moment there is something to point
at: pressing Edit on that file makes it source again, and the landing lands.

### Gates

`scripts/files-check.sh` section 5 covers the route: hits grouped by file over a
seeded tree where an excluded directory and a NUL-carrying file hold the query
too (both absent from the result, skipped server-side rather than filtered by a
client), the snippet's dropped indentation, both option toggles, a miss as a
200, and the whole `?q=` contract — plus, in **both** serve modes, that search
is reachable while the PATCH write keeps its gate. `core::files::search_files`
has unit tests for the walk, the caps, the snippet window and the symlink
refusal; `fileSearch.test.ts` covers the summary, the query gate and the
snippet highlighting; `keyboardScope.test.ts` covers the `'search'` chord.
Everything else — the panel's focus routing, the landing's reveal — is khora's,
per CLAUDE.md's standing split.
