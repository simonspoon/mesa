# Files tab (project file browser + editor)

The **Files** tab on a project page (web UI, `#/projects/:id/files`) browses
the file tree of the project's `local_path`, reads individual file contents,
and (task 327) can edit and save a text file's content back to disk —
`local_path`-anchored like the Git tab (touches the store only to read
`local_path`, no CLI: an agent in a terminal edits files directly). Browsing
(the tree, reading content) stays read-only; the one write is overwriting an
existing text file's full content — no create, delete, or rename anywhere in
this surface.

- `pub fn safe_path(root: &str, rel: &str) -> Option<PathBuf>`
  (`src/core/files.rs`) is the sole traversal-defense chokepoint: canonicalizes
  both `root` and `root.join(rel)` (resolving `.`/`..` **and** symlinks) and
  requires the result to be `root` itself or a descendant — rejects
  `../` traversal, absolute-path smuggling, symlink escapes, and nonexistent
  paths in one check. `read_file` and `write_file` are its only callers.
- `pub fn tree_of(root: &str) -> (Vec<FileTreeEntry>, bool)` walks `root`
  (assumed already verified as a live directory by the caller), excluding
  `EXCLUDED_DIRS` (`.git`, `node_modules`, `target`, `dist`, `build`, `.venv`,
  `venv`, `__pycache__`, `.next`, `vendor`, `.cache`) at any depth, sorting
  directories before files. Stops adding/descending at `MAX_TREE_ENTRIES`
  (2,000 nodes) or `MAX_TREE_DEPTH` (12 levels), returning a `truncated` flag.
  Symlinks are listed as file leaves and never followed (one rule covers both
  escape and cycle risk).
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
- `GET /api/projects/{id}/files` → `ProjectFileTree` via `files::tree_of`.
  Same three-rung empty-state ladder as the Git tab: no `local_path` →
  `{path: null, tree: null}`; dead/unreadable folder → `{path, tree: null}`;
  live folder → `{path, tree: Some(entries), truncated}`. Never an error.
  Cached 5s per folder (`AppState.files_tree_cache`) — walking a large repo
  isn't free either.
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
- Tree listing and content reads stay standard-guard-only, like the Git tab —
  no agent-style gate (browsing executes nothing) and no Content-Type gate
  (GET-only). The write above is the one exception, gated as just described.
- Web UI: `FilesView` (`frontend/src/pages/FilesView.tsx`) under the project
  tabs — a left-hand expandable file tree (`.files-tree`, directories
  toggled open/closed in local component state, no deep-linking) and a
  right-hand content pane, registered like the Git/Agents/Storyboards tabs (a
  boolean `files` route prop threaded `App.tsx` → `ProjectTasksPage.tsx`'s tab
  bar + content switch). A non-binary, non-truncated file's content pane
  shows an **Edit** button; clicking it swaps the rendered content for a
  full-height `<textarea>` (`.files-content-editor`) pre-filled with the
  current content, with Save/Cancel actions (Escape cancels, Cmd/Ctrl+Enter
  saves) — the same draft/saving/error-state shape as `InlineEdit`, but
  purpose-built rather than reusing that component: `InlineEdit`'s
  click-anywhere-to-edit trigger would fight selecting/copying source code,
  and its fixed `rows={4}` textarea doesn't fit a whole file. Save errors
  (e.g. a 422 if the file changed underneath into something non-editable
  since it was loaded) render inline and keep edit mode open, mirroring
  `InlineEdit`'s own error handling. Switching to a different file mid-edit
  silently discards the draft (`ContentPane` is `key={selectedPath}`-remounted
  on every selection change) — no confirm, matching this app's
  no-confirmation posture on other destructive UI actions. Tree-row and
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
  build (`frontend/src/pages/FilesView.tsx`), registered for the same ~15
  languages `EXTENSION_LANGUAGE` recognizes — the sync "light" Prism build was
  chosen over the async build specifically because the async build's
  per-language dynamic-import fallback pulls Prism's entire ~290-language
  catalog into the bundle even when only a handful are ever registered; an
  unrecognized language falls back to plain monospace `<pre>` text, matching
  the pre-281 behavior. `.md` files render as formatted markdown via the
  existing `Markdown` component (`frontend/src/components/Markdown.tsx`,
  already used for storyboard frame cards) instead of raw/highlighted text —
  safe against untrusted content the same way (no raw HTML passthrough). A
  binary file still renders "Binary file — cannot display" instead of raw
  content; the no-`local_path` and dead-folder empty-state rungs render the
  same quiet-placeholder pattern as the Git tab, never a hard error.
