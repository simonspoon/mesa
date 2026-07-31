import { useDeferredValue, useRef, useState } from 'react'
import {
  SyntaxHighlighter,
  vscDarkPlus,
  highlightOverlaySource,
  prismGrammar,
} from '../syntaxHighlighter'
import { Markdown } from '../components/Markdown'
import { SideBySideDiff } from '../components/SideBySideDiff'
import { splitFrontmatter } from '../frontmatter'
import {
  ApiError,
  getProjectFiles,
  getProjectFilesContent,
  getProjectGitCommitDiff,
  getProjectGitFileLog,
  updateProjectFilesContent,
} from '../api'
import type { FileTreeEntry } from '../types/FileTreeEntry'
import type { GitCommit } from '../types/GitCommit'
import { useFetch } from '../useFetch'

// Extension -> language tag, a client-side copy of core::files::language_of's
// table (arch.md §4 / src/core/files.rs). The TREE endpoint carries no
// `language` field per entry (would multiply payload size by up to
// MAX_TREE_ENTRIES for a value the frontend can derive for free from
// `name`), so tree-row tinting looks this table up directly off
// `FileTreeEntry.name`'s extension; the CONTENT endpoint returns `language`
// already computed server-side and is used verbatim (not re-derived here).
const EXTENSION_LANGUAGE: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  html: 'html',
  css: 'css',
  go: 'go',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
}

// Language tag -> one of the theme's five neon accent hues. The Tron palette
// (index.css) has only cyan/magenta/amber/green/red, far fewer than the
// language vocabulary above, so this groups by rough category (systems,
// scripting, web markup, data/config) rather than assigning each language its
// own hue — enough tint to tell entries apart at a glance and to visually
// agree between a tree row and the content-pane header once clicked, without
// inventing a second color per language.
const LANGUAGE_ACCENT: Record<string, string> = {
  rust: 'cyan',
  go: 'cyan',
  c: 'cyan',
  cpp: 'cyan',
  csharp: 'cyan',
  python: 'green',
  ruby: 'green',
  shell: 'green',
  javascript: 'magenta',
  typescript: 'magenta',
  html: 'magenta',
  css: 'magenta',
  json: 'amber',
  yaml: 'amber',
  toml: 'amber',
  markdown: 'amber',
}

/** Extension-derived language tag for a filename, or null when unrecognized
 * (no extension, a dotfile like ".gitignore", or an unlisted extension). */
function languageOfName(name: string): string | null {
  const i = name.lastIndexOf('.')
  if (i <= 0) return null
  return EXTENSION_LANGUAGE[name.slice(i + 1).toLowerCase()] ?? null
}

/** CSS class for a language tag (or its absence) — shared by tree rows
 * (client-derived) and the content header (server-derived), so the two
 * always render the same tint for the same file. */
function accentClass(language: string | null): string {
  return `files-accent-${LANGUAGE_ACCENT[language ?? ''] ?? 'muted'}`
}

/** Same "no linked folder" copy shape as GitView's placeholder (M10), worded
 * for browsing files instead of git status. */
function NoLocalPathPlaceholder({ projectId }: { projectId: number }) {
  return (
    <div className="files-placeholder muted">
      <p>
        This project has no linked folder, so mesa cannot browse its files.
        Run <code>mesa project resolve</code> inside the repo, or{' '}
        <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
        link one.
      </p>
    </div>
  )
}

/** Dead/unreadable folder — collapses "gone" and "unreadable" into one rung,
 * same as the API's own ladder (arch.md §3) and the Git tab's precedent. */
function DeadFolderPlaceholder({ path }: { path: string }) {
  return (
    <div className="files-placeholder muted">
      <p>
        <code>{path}</code> no longer exists or is not readable.
      </p>
    </div>
  )
}

/** The selected file's content: monospace, with a language-tinted header,
 * binary/truncation indicators in place of raw/garbled bytes (M5/M6), and an
 * Edit affordance (task 327) for anything neither binary nor truncated — a
 * truncated file's displayed bytes aren't its full content, so saving them
 * back would corrupt it; the same reason the API itself refuses that write. */
function ContentPane({
  projectId,
  path,
}: {
  projectId: number
  path: string
}) {
  const { data, error, refetch } = useFetch(
    () => getProjectFilesContent(projectId, path),
    `files-content-${projectId}-${path}`,
  )
  // Not path-keyed off `data` (which reloads under the same component
  // instance as `path` changes) — the parent remounts this component on
  // every path change via a `key={path}` prop, so this state naturally
  // starts fresh per file; switching files mid-edit discards the draft,
  // matching this app's no-confirmation posture on other destructive UI
  // actions (deletes, etc.).
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // History pane (task 542): a per-file commit list beside the content, and
  // the commit currently being shown as a side-by-side diff in place of the
  // content. Both live here rather than in FilesView so they reset with the
  // same `key={selectedPath}` remount that discards an in-progress edit —
  // one file's history must never be shown against another file's content.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const editable = !data.is_binary && !data.truncated

  function closeHistory() {
    setHistoryOpen(false)
    setSelectedCommit(null)
  }

  function startEdit() {
    // Editing and browsing history are mutually exclusive views of the same
    // area — entering edit mode closes history rather than trying to show a
    // textarea and a commit diff in the same pane.
    closeHistory()
    setDraft(data!.content)
    setSaveError(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setSaveError(null)
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      await updateProjectFilesContent(projectId, path, draft)
      setEditing(false)
      refetch()
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Failed to save file.')
    } finally {
      setSaving(false)
    }
  }

  // The file itself, in whichever form applies. Pulled out of the JSX below
  // because history mode renders it in a narrower column beside the commit
  // list — and swaps it for a commit's diff once one is picked.
  const body = editing ? (
    <FileEditor
      value={draft}
      language={data.language}
      onChange={setDraft}
      onCancel={cancelEdit}
      onSave={save}
    />
  ) : data.is_binary ? (
    <p className="muted">Binary file — cannot display.</p>
  ) : data.language === 'markdown' ? (
    <MarkdownBody content={data.content} />
  ) : (
    <FileCode content={data.content} language={data.language} />
  )

  return (
    <div className="files-content">
      <p className={`files-content-header ${accentClass(data.language)}`}>
        <span className="files-content-path">{data.path}</span>
        {data.language !== null && (
          <span className="badge files-lang-badge">{data.language}</span>
        )}
        {data.truncated && (
          <span className="badge files-truncated-badge">truncated</span>
        )}
        {!editing && (
          <span className="files-header-actions">
            {editable && (
              <button className="files-edit-btn" onClick={startEdit}>
                Edit
              </button>
            )}
            <button
              className="files-edit-btn"
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
            >
              {historyOpen ? 'Hide history' : 'History'}
            </button>
          </span>
        )}
        {editing && (
          <span className="files-edit-actions">
            <button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancelEdit} disabled={saving}>
              Cancel
            </button>
          </span>
        )}
      </p>
      {saveError && <p className="error">{saveError}</p>}
      {historyOpen ? (
        <div className="files-history-layout">
          <FileHistoryPane
            projectId={projectId}
            path={path}
            selected={selectedCommit}
            onSelect={setSelectedCommit}
          />
          <div className="files-history-main">
            {selectedCommit !== null ? (
              <CommitSideBySidePane
                projectId={projectId}
                commit={selectedCommit}
                path={path}
                onBack={() => setSelectedCommit(null)}
              />
            ) : (
              body
            )}
          </div>
        </div>
      ) : (
        body
      )}
    </div>
  )
}

/** The selected file's own commit history, as a vertical pane beside the
 * content. Same three-rung empty-state ladder as GitView's HistoryPane —
 * quiet placeholders, never a hard error — plus a fourth rung this route
 * adds: an empty list means the file exists on disk but has no commits yet
 * (never committed), which is a state, not a failure. */
function FileHistoryPane({
  projectId,
  path,
  selected,
  onSelect,
}: {
  projectId: number
  path: string
  selected: GitCommit | null
  onSelect: (commit: GitCommit) => void
}) {
  const { data, error } = useFetch(
    () => getProjectGitFileLog(projectId, path),
    `files-log-${projectId}-${path}`,
  )
  if (error) return <div className="files-history-pane error">{error}</div>
  if (!data) return <div className="files-history-pane muted">Loading…</div>
  if (data.path === null || data.commits === null) {
    return (
      <div className="files-history-pane muted">
        No git repository for this project's folder.
      </div>
    )
  }
  if (data.commits.length === 0) {
    return (
      <div className="files-history-pane muted">
        No commits touch this file yet.
      </div>
    )
  }
  return (
    <ul className="card-list files-history-pane">
      {data.commits.map((c) => (
        <li
          key={c.hash}
          className={c.hash === selected?.hash ? 'selected' : ''}
          onClick={() => onSelect(c)}
        >
          <span className="badge git-status-badge">{c.short_hash}</span>
          <span className="git-file-path">{c.subject}</span>
          <div className="muted git-file-label">
            {c.author} · {c.date}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** One commit's change to the selected file, rendered old|new. Reuses the
 * Git tab's per-commit diff route verbatim — every commit `FileHistoryPane`
 * lists is one that route accepts for this path (that's why the server's
 * file log doesn't follow renames). */
function CommitSideBySidePane({
  projectId,
  commit,
  path,
  onBack,
}: {
  projectId: number
  commit: GitCommit
  path: string
  onBack: () => void
}) {
  const { data, error } = useFetch(
    () => getProjectGitCommitDiff(projectId, commit.hash, path),
    `files-commit-diff-${projectId}-${commit.hash}-${path}`,
  )
  return (
    <>
      <button type="button" className="git-back" onClick={onBack}>
        ← File
      </button>
      <p className="git-commit-summary">
        <span className="badge git-status-badge">{commit.short_hash}</span>{' '}
        {commit.subject}
      </p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <SideBySideDiff diff={data.diff} />}
    </>
  )
}

/** Markdown content, with a leading YAML frontmatter block (if any) split off
 * and rendered as a highlighted YAML panel instead of being fed to
 * react-markdown — untouched, it renders as two stray `<hr>`s around plain
 * paragraph text (`---` is a thematic break, not a block react-markdown
 * knows). */
function MarkdownBody({ content }: { content: string }) {
  const { frontmatter, body } = splitFrontmatter(content)
  return (
    <div className="markdown-body">
      {frontmatter !== null && (
        <div className="files-frontmatter">
          <p className="files-frontmatter-label muted">Frontmatter</p>
          <FileCode content={frontmatter} language="yaml" />
        </div>
      )}
      <Markdown text={body} />
    </div>
  )
}

/** Non-markdown file content: Prism-highlighted for a recognized language,
 * plain monospace text otherwise (unknown extension or a language our
 * highlighter build doesn't carry a grammar for). */
function FileCode({
  content,
  language,
}: {
  content: string
  language: string | null
}) {
  const prismLanguage = prismGrammar(language)
  if (prismLanguage === undefined) {
    return <pre className="files-content-text">{content}</pre>
  }
  return (
    <SyntaxHighlighter
      language={prismLanguage}
      style={vscDarkPlus}
      customStyle={{
        margin: 0,
        padding: 0,
        background: 'transparent',
      }}
      codeTagProps={{ className: 'files-content-text' }}
    >
      {content}
    </SyntaxHighlighter>
  )
}

/** The edit-mode twin of `FileCode` (task 658): the same Prism colouring, but
 * live under the caret.
 *
 * A `<textarea>` can only paint one colour, so the highlighted copy is a
 * separate, inert layer *behind* a transparent-text textarea — the standard
 * overlay editor. Everything that keeps the two aligned is load-bearing:
 * identical font metrics and zero padding on both (`.files-editor-*` in
 * App.css), `wrap="off"` so the textarea never soft-wraps where the `<pre>`
 * would not, `highlightOverlaySource` for the trailing-newline mismatch, and
 * scroll mirrored from the textarea onto the layer on every scroll event.
 * Only the textarea is a real control: the layer is `aria-hidden` and
 * pointer-transparent, so selection, the caret and the accessibility tree all
 * still come from the one element that holds the text.
 *
 * A language we carry no grammar for falls back to the plain textarea this
 * pane shipped with in task 327 — same rule as `FileCode`'s plain `<pre>`. */
function FileEditor({
  value,
  language,
  onChange,
  onCancel,
  onSave,
}: {
  value: string
  language: string | null
  onChange: (next: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const highlightRef = useRef<HTMLDivElement>(null)
  // Re-tokenising a 256 KiB file on every keystroke would sit between the key
  // and the caret. Deferring lets React paint the typed character first and
  // recolour behind it, so the colours can lag a frame but the caret never
  // does.
  const deferred = useDeferredValue(value)
  const prismLanguage = prismGrammar(language)

  const textarea = (
    <textarea
      autoFocus
      className="files-content-editor"
      value={value}
      spellCheck={false}
      wrap="off"
      onChange={(e) => onChange(e.target.value)}
      onScroll={(e) => {
        const layer = highlightRef.current
        if (layer === null) return
        layer.scrollTop = e.currentTarget.scrollTop
        layer.scrollLeft = e.currentTarget.scrollLeft
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave()
      }}
    />
  )

  if (prismLanguage === undefined) return textarea

  return (
    <div className="files-editor-stack">
      <div className="files-editor-highlight" ref={highlightRef} aria-hidden="true">
        <SyntaxHighlighter
          language={prismLanguage}
          style={vscDarkPlus}
          customStyle={{
            margin: 0,
            padding: 0,
            background: 'transparent',
          }}
          codeTagProps={{ className: 'files-content-text' }}
        >
          {highlightOverlaySource(deferred)}
        </SyntaxHighlighter>
      </div>
      {textarea}
    </div>
  )
}

/** A directory's fetched-or-not-yet-fetched state (mesa task 410's lazy
 * per-directory walk). `'loading'`/`'error'` are transient states a
 * `Loaded` entry replaces once the fetch settles; a `Loaded` entry stays in
 * the cache across collapse/re-expand so re-opening a directory never
 * re-fetches it. */
type DirState =
  | 'loading'
  | 'error'
  | { entries: FileTreeEntry[]; truncated: boolean }

/** One tree row (directory or file), recursing into an expanded directory's
 * children via the shared `childrenCache` (fetched lazily on first expand,
 * not carried on the entry itself — the tree endpoint returns one level per
 * call now). Returns a fragment of sibling <li>s so it drops straight into
 * the parent <ul> with no extra wrapper element. */
function TreeNode({
  entry,
  depth,
  expanded,
  onToggle,
  childrenCache,
  selectedPath,
  onSelectFile,
}: {
  entry: FileTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (entry: FileTreeEntry) => void
  childrenCache: Map<string, DirState>
  selectedPath: string | null
  onSelectFile: (path: string) => void
}) {
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  if (entry.is_dir) {
    const isOpen = expanded.has(entry.path)
    const state = childrenCache.get(entry.path)
    return (
      <>
        <li
          className="files-tree-dir"
          style={indent}
          onClick={() => onToggle(entry)}
        >
          <span className={`files-tree-toggle ${isOpen ? 'open' : ''}`}>
            {isOpen ? '▾' : '▸'}
          </span>
          {entry.name}
        </li>
        {isOpen && state === 'loading' && (
          <li className="files-tree-note muted" style={indent}>
            Loading…
          </li>
        )}
        {isOpen && state === 'error' && (
          <li className="files-tree-note error" style={indent}>
            Failed to load.
          </li>
        )}
        {isOpen &&
          state !== undefined &&
          state !== 'loading' &&
          state !== 'error' &&
          state.entries.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              childrenCache={childrenCache}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
        {isOpen &&
          state !== undefined &&
          state !== 'loading' &&
          state !== 'error' &&
          state.truncated && (
            <li
              className="files-tree-note muted"
              style={{ paddingLeft: `${(depth + 1) * 1.1 + 0.5}rem` }}
            >
              This folder is larger than what's shown here.
            </li>
          )}
      </>
    )
  }
  const language = languageOfName(entry.name)
  return (
    <li
      className={`files-tree-file ${accentClass(language)} ${
        entry.path === selectedPath ? 'selected' : ''
      }`}
      style={indent}
      onClick={() => onSelectFile(entry.path)}
    >
      {entry.name}
    </li>
  )
}

/**
 * The Files tab: the project's file tree (rooted at local_path) on the left,
 * expandable per directory, with the selected file's content on the right.
 * The root level loads eagerly with the tab; each directory's own contents
 * load lazily on first expand and are cached thereafter (mesa task 410),
 * so the per-directory entry cap applies to one folder at a time instead of
 * truncating the whole tree. A non-binary, non-truncated file can be edited
 * and saved back to disk (task 327, `ContentPane`'s Edit affordance);
 * everything else — browsing, the tree, no create/delete/rename — stays
 * read-only. Rendered in place inside ProjectTasksPage's frame, like
 * GitView. Empty states are quiet placeholders, matching the Git tab's
 * ladder, never a hard error (M10).
 */
export function FilesView({ projectId }: { projectId: number }) {
  const { data, error } = useFetch(
    () => getProjectFiles(projectId),
    `files-${projectId}`,
  )
  // Selected path and expanded dirs are component state, not URL (no
  // deep-linking into the tree, matching GitView's selectedPath).
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Fetched-directory cache (mesa task 410's lazy per-directory walk):
  // populated on first expand, kept for the component's lifetime so
  // collapsing and re-expanding a directory never re-fetches it.
  const [childrenCache, setChildrenCache] = useState<Map<string, DirState>>(
    new Map(),
  )
  // Whether the tree is showing. Only the phone tier can turn this off, and
  // only the phone tier renders anything that reacts to it — above 600px the
  // toggle button is `display: none` and `.files-tree-collapsed` has no rule
  // at all, so the tree is always up and this flag is inert. That is
  // deliberate: the breakpoint stays in CSS alone, with no second
  // `matchMedia` for the component to keep in sync (same rule the phone tab
  // bar follows, App.css).
  const [treeOpen, setTreeOpen] = useState(true)
  // Reset on project change (render-time, off the changed prop — same
  // pattern as GitView/HistoryPane): this component isn't remounted when the
  // route moves between projects, so a stale selection from project A must
  // not leak into project B.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedPath(null)
    setExpanded(new Set())
    setChildrenCache(new Map())
    setTreeOpen(true)
  }

  function ensureChildren(path: string) {
    if (childrenCache.has(path)) return // loaded or already loading
    setChildrenCache((prev) => new Map(prev).set(path, 'loading'))
    getProjectFiles(projectId, path).then(
      (res) => {
        setChildrenCache((prev) =>
          new Map(prev).set(path, {
            entries: res.tree ?? [],
            truncated: res.truncated,
          }),
        )
      },
      () => {
        setChildrenCache((prev) => new Map(prev).set(path, 'error'))
      },
    )
  }

  function toggle(entry: FileTreeEntry) {
    const opening = !expanded.has(entry.path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (opening) ensureChildren(entry.path)
  }

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  // Quiet empty states (M10) — data shapes, not errors.
  if (data.path === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (data.tree === null) {
    return <DeadFolderPlaceholder path={data.path} />
  }

  return (
    <div className="files-view">
      {data.truncated && (
        <p className="muted files-truncated-note">
          This folder is larger than what's shown here — the tree was capped.
        </p>
      )}
      {data.tree.length === 0 ? (
        <p className="muted">This folder is empty.</p>
      ) : (
        <div className="files-layout">
          {/* Phone-tier affordance for the collapse above; hidden by CSS at
              every wider tier, where the tree never leaves. Rendered before
              the tree so it stays put as the tree comes and goes, and so the
              two read as one control in the tab order. */}
          <button
            type="button"
            className="files-tree-phone-toggle"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((open) => !open)}
          >
            {treeOpen ? '▾' : '▸'} file tree
            {!treeOpen && selectedPath !== null && (
              <span className="files-tree-phone-crumb"> — {selectedPath}</span>
            )}
          </button>
          <ul className={`files-tree${treeOpen ? '' : ' files-tree-collapsed'}`}>
            {data.tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                childrenCache={childrenCache}
                selectedPath={selectedPath}
                onSelectFile={(path) => {
                  setSelectedPath(path)
                  // Opening a file closes the tree, which is what makes the
                  // phone tier's stacked layout usable: the tree is a full
                  // column of rows, so leaving it up pushes the file itself
                  // below the fold (measured at 390x844: the content pane's
                  // top sat at 643px of an 844px viewport). Inert above
                  // 600px, per `treeOpen` above.
                  setTreeOpen(false)
                }}
              />
            ))}
          </ul>
          <div className="files-content-pane">
            {selectedPath !== null ? (
              // `key={selectedPath}` remounts on every file switch, which is
              // what discards any in-progress edit's local state (draft,
              // editing) when the user picks a different file — simpler than
              // threading a reset effect through ContentPane.
              <ContentPane
                key={selectedPath}
                projectId={projectId}
                path={selectedPath}
              />
            ) : (
              <p className="muted">Select a file to see its content.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
