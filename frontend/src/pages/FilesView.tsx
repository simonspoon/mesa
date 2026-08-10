import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react'
import {
  SyntaxHighlighter,
  vscDarkPlus,
  highlightOverlaySource,
  prismGrammar,
} from '../syntaxHighlighter'
import {
  activateTab,
  closeTab,
  collapseSplit,
  dropIndex,
  focusPane,
  moveTab,
  openFile,
  openPaths,
  setRatio,
  splitPane,
  splitWithTab,
  type PaneSide,
  type TabSource,
  type TabsState,
} from '../fileTabs'
import {
  clampFilesTreeWidth,
  clearFilesTreeWidth,
  DEFAULT_FILES_TREE_WIDTH,
  loadFilesTreeCollapsed,
  loadFilesTreeWidth,
  saveFilesTreeCollapsed,
  saveFilesTreeWidth,
} from '../filesTreeWidth'
import { onNarrowTierChange, useNarrowTier } from '../phoneTier'
import { Markdown } from '../components/Markdown'
import { SideBySideDiff } from '../components/SideBySideDiff'
import { splitFrontmatter } from '../frontmatter'
import { isImagePath } from '../fileImage'
import { resolveMarkdownImageSrc } from '../markdownAssets'
import { newFilePath } from '../newFile'
import { loadOpenFiles, saveOpenFiles } from '../openFiles'
import {
  ApiError,
  createProjectFile,
  getProjectFiles,
  getProjectFilesContent,
  getProjectGitCommitDiff,
  getProjectGitFileLog,
  projectFileDownloadUrl,
  projectFileRawUrl,
  updateProjectFilesContent,
} from '../api'
import type { FileTreeEntry } from '../types/FileTreeEntry'
import type { GitCommit } from '../types/GitCommit'
import { useFetch } from '../useFetch'

/** The content half's own floor, the twin of `MIN_MAIN_WIDTH` in Sidebar.tsx /
 * AgentSidebar.tsx: dragging the tree wider may never squeeze the file it
 * exists to open down to a strip. */
const MIN_FILES_CONTENT_WIDTH = 320

/** The widest the tree pane may be right now, or null while either half is
 * unmounted (the tab is still loading) and there is nothing to measure.
 *
 * `.files-layout` puts a gap between the two, so the room the tree can take is
 * the distance to the panes' right edge *minus that gap* — measured, not
 * assumed, since it is a `rem` in App.css — minus the content half's own
 * floor. Left out, the ceiling hands the content a pane one gap under its
 * floor. */
function maxTreeWidth(
  tree: HTMLElement | null,
  panes: HTMLElement | null,
): number | null {
  if (tree === null || panes === null) return null
  const t = tree.getBoundingClientRect()
  const p = panes.getBoundingClientRect()
  return p.right - t.left - (p.left - t.right) - MIN_FILES_CONTENT_WIDTH
}

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
  svg: 'svg',
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

/**
 * One open tab's view state, the part that must outlive a tab switch (mesa
 * task 670).
 *
 * Before tabs there was one open file and `ContentPane` was
 * `key={selectedPath}`-remounted, which meant this state simply died with the
 * old file. That is still the right answer for *closing* a tab or switching
 * project — but flipping to another tab and back is a navigation, and a
 * navigation that silently ate a half-typed edit would be a bug. So it is
 * lifted into `FilesView`, keyed by path, and this component is controlled.
 *
 * Deliberately not lifted: `saving`/`downloading`/`saveError`, which describe
 * one in-flight request rather than the file, and which the pane has to be
 * mounted to show.
 */
interface FileUiState {
  editing: boolean
  draft: string
  historyOpen: boolean
  /** The commit shown as a diff in place of the content, if any. */
  selectedCommit: GitCommit | null
}

const BLANK_FILE_UI: FileUiState = {
  editing: false,
  draft: '',
  historyOpen: false,
  selectedCommit: null,
}

/** The selected file's content: monospace, with a language-tinted header,
 * binary/truncation indicators in place of raw/garbled bytes (M5/M6), and an
 * Edit affordance (task 327) for anything neither binary nor truncated — a
 * truncated file's displayed bytes aren't its full content, so saving them
 * back would corrupt it; the same reason the API itself refuses that write. */
function ContentPane({
  projectId,
  path,
  ui,
  onUi,
}: {
  projectId: number
  path: string
  ui: FileUiState
  onUi: (patch: Partial<FileUiState>) => void
}) {
  const { data, error, refetch } = useFetch(
    () => getProjectFilesContent(projectId, path),
    `files-content-${projectId}-${path}`,
  )
  // In-flight state for one save, and the error it may leave behind — the only
  // two the tab does not carry (see `FileUiState`).
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const editable = !data.is_binary && !data.truncated
  const { editing, draft, historyOpen, selectedCommit } = ui

  function closeHistory() {
    onUi({ historyOpen: false, selectedCommit: null })
  }

  function startEdit() {
    // Editing and browsing history are mutually exclusive views of the same
    // area — entering edit mode closes history rather than trying to show a
    // textarea and a commit diff in the same pane.
    setSaveError(null)
    onUi({
      historyOpen: false,
      selectedCommit: null,
      draft: data!.content,
      editing: true,
    })
  }

  function cancelEdit() {
    setSaveError(null)
    onUi({ editing: false })
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      await updateProjectFilesContent(projectId, path, draft)
      onUi({ editing: false })
      refetch()
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Failed to save file.')
    } finally {
      setSaving(false)
    }
  }

  /** Saves the file to disk as its real bytes (task 683). `fetch` + a blob
   * rather than an `<a href>`: a 404/422 must render in this pane, not
   * navigate the SPA away to a JSON error page — and the bytes have to come
   * from the download route, since `data.content` is blank for a binary file
   * and short for a truncated one. */
  async function download() {
    setDownloading(true)
    setSaveError(null)
    try {
      const resp = await fetch(projectFileDownloadUrl(projectId, path))
      if (!resp.ok) {
        setSaveError(await downloadErrorMessage(resp))
        return
      }
      const url = URL.createObjectURL(await resp.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = basename(path)
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setSaveError('Failed to download file.')
    } finally {
      setDownloading(false)
    }
  }

  // The file itself, in whichever form applies. Pulled out of the JSX below
  // because history mode renders it in a narrower column beside the commit
  // list — and swaps it for a commit's diff once one is picked.
  const body = editing ? (
    <FileEditor
      value={draft}
      language={data.language}
      onChange={(next) => onUi({ draft: next })}
      onCancel={cancelEdit}
      onSave={save}
    />
  ) : isImagePath(data.path) ? (
    // Ahead of the binary branch, so the one image test covers both halves of
    // the allowlist uniformly: a raster arrives as `is_binary` with blank
    // content, an `.svg` arrives as ordinary text. Neither is displayable as
    // its bytes; both are displayable as an image. Keyed on the path so the
    // load-error state below can't leak from one file into the next.
    <FileImageBody key={data.path} projectId={projectId} path={data.path} />
  ) : data.is_binary ? (
    <p className="muted">Binary file — cannot display.</p>
  ) : data.language === 'markdown' ? (
    <MarkdownBody
      projectId={projectId}
      path={data.path}
      content={data.content}
    />
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
              onClick={() =>
                historyOpen ? closeHistory() : onUi({ historyOpen: true })
              }
            >
              {historyOpen ? 'Hide history' : 'History'}
            </button>
            {/* Unlike Edit, offered for EVERY file — a binary or truncated
             * file is exactly the case the viewer can show nothing useful
             * for. A real <button> because the app's button chrome hangs off
             * the `button` element selector in index.css; an <a download>
             * would need all of it duplicated. */}
            <button
              className="files-edit-btn"
              onClick={download}
              disabled={downloading}
            >
              {downloading ? 'Downloading…' : 'Download'}
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
            onSelect={(commit) => onUi({ selectedCommit: commit })}
          />
          <div className="files-history-main">
            {selectedCommit !== null ? (
              <CommitSideBySidePane
                projectId={projectId}
                commit={selectedCommit}
                path={path}
                onBack={() => onUi({ selectedCommit: null })}
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

/** The message out of a failed download response's `{"error": {code, message}}`
 * envelope — the same shape `request()` unwraps into an `ApiError`, re-read
 * here because this one call goes through raw `fetch` to keep the bytes out of
 * the JSON wrapper. A non-JSON or shapeless body falls back to a generic line
 * rather than showing the raw text. */
async function downloadErrorMessage(resp: Response): Promise<string> {
  const fallback = 'Failed to download file.'
  try {
    const body: unknown = await resp.json()
    const error =
      typeof body === 'object' && body !== null
        ? (body as { error?: { message?: unknown } }).error
        : undefined
    return typeof error?.message === 'string' ? error.message : fallback
  } catch {
    return fallback
  }
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
function MarkdownBody({
  projectId,
  path,
  content,
}: {
  projectId: number
  path: string
  content: string
}) {
  const { frontmatter, body } = splitFrontmatter(content)
  // A relative `![alt](img/x.png)` in a repo file means "beside this file", so
  // resolution is anchored on the md file's own directory ("" at the root) and
  // the result goes through the raw route rather than the SPA's own URL space.
  // `resolveMarkdownImageSrc` answers null for everything that must not be
  // fetched (remote/data/protocol-relative sources, or a path escaping the
  // project root) — Markdown then renders the alt text inert.
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const resolveImageSrc = useCallback(
    (src: string) => {
      const rel = resolveMarkdownImageSrc(dir, src)
      return rel === null ? null : projectFileRawUrl(projectId, rel)
    },
    [dir, projectId],
  )
  return (
    <div className="markdown-body">
      {frontmatter !== null && (
        <div className="files-frontmatter">
          <p className="files-frontmatter-label muted">Frontmatter</p>
          <FileCode content={frontmatter} language="yaml" />
        </div>
      )}
      <Markdown text={body} resolveImageSrc={resolveImageSrc} />
    </div>
  )
}

/** An image file, rendered as the image itself rather than as its bytes
 * (task 801) — the one file kind whose content view is not text. The bytes
 * come from the raw route via a plain `<img src>`, never through `fetch`: the
 * route is the only place they are served with an image mime, and keeping the
 * load in the element means the browser's own decoder is what interprets
 * them.
 *
 * `onError` covers everything the element cannot show — a file the server
 * refused, or bytes with an image extension that are not a decodable image —
 * with the same muted line the non-image binary branch uses, so a failure
 * reads as a state rather than as a broken-image icon. The parent keys this
 * component on the path, which is what resets the flag when the tab switches
 * files. */
function FileImageBody({
  projectId,
  path,
}: {
  projectId: number
  path: string
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="muted">Binary file — cannot display.</p>
  return (
    <div className="files-content-image-wrap">
      <img
        className="files-content-image"
        src={projectFileRawUrl(projectId, path)}
        alt={basename(path)}
        onError={() => setFailed(true)}
      />
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

/** The create-a-file affordance's whole state, threaded through the tree as
 * one object rather than five props (mesa task 672). `parent` is the directory
 * whose naming row is open — `''` for the project root, `null` for none, and
 * at most one at a time, which is why this is a single field and not a set.
 * The naming *decision* isn't here: it is `newFile.ts`. */
interface TreeCreate {
  parent: string | null
  error: string | null
  busy: boolean
  onStart: (parent: string) => void
  onSubmit: (name: string) => void
  onCancel: () => void
}

/** The `+` that opens a naming row, on a directory row and on the tree pane's
 * own header (the project root). The row it sits on toggles the directory on
 * click, so this must stop the event from reaching it. */
function NewFileButton({
  parent,
  label,
  create,
}: {
  parent: string
  label: string
  create: TreeCreate
}) {
  return (
    <button
      type="button"
      className="files-tree-add"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        create.onStart(parent)
      }}
    >
      +
    </button>
  )
}

/** The inline naming row: one autofocused input, Enter to create, Escape or
 * blur to cancel. The typed name is local — nothing above needs a keystroke,
 * only the submitted name — while the error below it comes from the parent,
 * since it can be either `newFile.ts`'s reason (no request made) or the
 * server's own 409/422/404, rendered the same way for both. */
function NewFileRow({ depth, create }: { depth: number; create: TreeCreate }) {
  const [name, setName] = useState('')
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  return (
    <>
      <li className="files-tree-new" style={indent}>
        <input
          autoFocus
          className="files-tree-new-input"
          value={name}
          placeholder="new-file.ts"
          spellCheck={false}
          aria-label="New file name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              create.onSubmit(name)
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              create.onCancel()
            }
          }}
          // Deliberately never `disabled` while a create is in flight: the
          // browser blurs a control it disables, and blur cancels — so
          // disabling would close the row mid-request. `busy` is enforced in
          // the submit handler instead.
          onBlur={create.onCancel}
        />
      </li>
      {create.error !== null && (
        <li className="files-tree-note error" style={indent}>
          {create.error}
        </li>
      )}
    </>
  )
}

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
  create,
}: {
  entry: FileTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (entry: FileTreeEntry) => void
  childrenCache: Map<string, DirState>
  selectedPath: string | null
  onSelectFile: (path: string) => void
  create: TreeCreate
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
          <NewFileButton
            parent={entry.path}
            label={`New file in ${entry.path}`}
            create={create}
          />
        </li>
        {/* First row of this directory's children — above the loading note as
            much as above the entries, so it never jumps once the level
            lands. */}
        {create.parent === entry.path && (
          <NewFileRow depth={depth + 1} create={create} />
        )}
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
              create={create}
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

/** A path's last segment — what a tab is labelled with. The full relative
 *  path stays on the tab's `title`, since basenames collide constantly
 *  (`mod.rs`, `index.ts`) and the strip has no room to disambiguate. */
function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** The tab being dragged, for the length of one HTML5 drag.
 *
 * Module scope rather than component state on purpose: `dragover` fires many
 * times a second and must be able to *read* the source to decide whether the
 * drop is legal, and `DataTransfer.getData` is deliberately blank outside
 * `drop` for exactly that read. A ref would work too; a module-level slot is
 * simpler and there is only ever one drag in flight in one window. */
let dragging: TabSource | null = null

/** Where a drop indicator is currently showing: a strip and the gap in it. */
interface DropMark {
  side: PaneSide
  index: number
}

/**
 * One pane's tab strip: its open files in order, plus the Split control.
 *
 * All of the decision-making is `fileTabs.ts`; this owns the DOM half of it —
 * measuring the tabs so `dropIndex` has rects to work with, and painting the
 * indicator at the gap that measurement chose.
 */
function TabStrip({
  side,
  tabs,
  active,
  focused,
  canSplit,
  mark,
  onActivate,
  onClose,
  onSplit,
  onDragBegin,
  onDragFinish,
  onDragOverStrip,
  onDropOnStrip,
  onDragLeaveStrip,
}: {
  side: PaneSide
  tabs: string[]
  active: string | null
  focused: boolean
  canSplit: boolean
  mark: DropMark | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onSplit: () => void
  onDragBegin: () => void
  onDragFinish: () => void
  onDragOverStrip: (index: number) => void
  onDropOnStrip: (index: number) => void
  onDragLeaveStrip: () => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)

  // The pure part is `dropIndex`; the measuring stays here, where the DOM is.
  function indexAt(clientX: number): number {
    const strip = stripRef.current
    if (strip === null) return tabs.length
    const rects = [...strip.querySelectorAll('[data-file-tab]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
    return dropIndex(rects, clientX)
  }

  // `dragenter` and `dragover` do the same thing, and both must: a browser
  // treats an element as a drop target only from the moment one of them calls
  // `preventDefault()`, so a pointer that crosses into a strip and releases
  // before the first `dragover` fires would otherwise see the drop rejected.
  function over(e: ReactDragEvent) {
    if (dragging === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    onDragOverStrip(indexAt(e.clientX))
  }

  return (
    <div
      className={`files-tab-strip${focused ? ' focused' : ''}`}
      ref={stripRef}
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={onDragLeaveStrip}
      onDrop={(e) => {
        if (dragging === null) return
        e.preventDefault()
        onDropOnStrip(indexAt(e.clientX))
      }}
    >
      {tabs.map((path, i) => (
        <div
          key={path}
          data-file-tab=""
          title={path}
          draggable
          className={`files-tab ${accentClass(languageOfName(basename(path)))}${
            path === active ? ' active' : ''
          }${mark !== null && mark.side === side && mark.index === i ? ' drop-before' : ''}`}
          onDragStart={(e) => {
            dragging = { side, path }
            e.dataTransfer.effectAllowed = 'move'
            // Some browsers cancel a drag that carries no payload at all.
            e.dataTransfer.setData('text/plain', path)
            onDragBegin()
          }}
          onDragEnd={() => {
            dragging = null
            onDragFinish()
          }}
          // Middle-click closes, the editor convention. `auxclick` rather than
          // `mouseup` so it fires once and only for a real button-2 click.
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(path)
            }
          }}
        >
          <button
            type="button"
            className="files-tab-label"
            onClick={() => onActivate(path)}
          >
            {basename(path)}
          </button>
          <button
            type="button"
            className="files-tab-close"
            aria-label={`Close ${path}`}
            onClick={() => onClose(path)}
          >
            ×
          </button>
        </div>
      ))}
      {/* The tail gap, so a drop past the last tab has something to mark. */}
      {mark !== null && mark.side === side && mark.index >= tabs.length && (
        <span className="files-tab-drop-tail" aria-hidden="true" />
      )}
      {canSplit && (
        <button
          type="button"
          className="files-split-btn"
          onClick={onSplit}
          title="Show a second file beside this one"
        >
          Split
        </button>
      )}
    </div>
  )
}

/** A tab strip over the pane's active file — or, with nothing open, the same
 *  empty state the single pane showed before tabs existed. */
function FilePane({
  projectId,
  side,
  tabs,
  active,
  focused,
  canSplit,
  mark,
  fileUi,
  onUi,
  onFocus,
  onActivate,
  onClose,
  onSplit,
  onDragBegin,
  onDragFinish,
  onDragOverStrip,
  onDropOnStrip,
  onDragLeaveStrip,
  style,
}: {
  projectId: number
  side: PaneSide
  tabs: string[]
  active: string | null
  focused: boolean
  canSplit: boolean
  mark: DropMark | null
  fileUi: Map<string, FileUiState>
  onUi: (path: string, patch: Partial<FileUiState>) => void
  onFocus: () => void
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onSplit: () => void
  onDragBegin: () => void
  onDragFinish: () => void
  onDragOverStrip: (index: number) => void
  onDropOnStrip: (index: number) => void
  onDragLeaveStrip: () => void
  style?: CSSProperties
}) {
  return (
    <section
      className={`files-content-pane${focused ? ' focused' : ''}`}
      style={style}
      onMouseDown={onFocus}
    >
      <TabStrip
        side={side}
        tabs={tabs}
        active={active}
        focused={focused}
        canSplit={canSplit}
        mark={mark}
        onActivate={onActivate}
        onClose={onClose}
        onSplit={onSplit}
        onDragBegin={onDragBegin}
        onDragFinish={onDragFinish}
        onDragOverStrip={onDragOverStrip}
        onDropOnStrip={onDropOnStrip}
        onDragLeaveStrip={onDragLeaveStrip}
      />
      <div className="files-pane-body">
        {active !== null ? (
          // Only the *active* tab of each pane is mounted, so a dozen open
          // files never means a dozen live syntax highlighters. What survives
          // the switch is `fileUi`, one plain object per path, in the parent.
          // `key` still carries the path so `useFetch` and the editor start
          // clean per file, exactly as the pre-tabs `key={selectedPath}` did.
          <ContentPane
            key={active}
            projectId={projectId}
            path={active}
            ui={fileUi.get(active) ?? BLANK_FILE_UI}
            onUi={(patch) => onUi(active, patch)}
          />
        ) : (
          <p className="muted">Select a file to see its content.</p>
        )}
      </div>
    </section>
  )
}

/**
 * The Files tab: the project's file tree (rooted at local_path) on the left,
 * expandable per directory, with the open files' content on the right.
 * The root level loads eagerly with the tab; each directory's own contents
 * load lazily on first expand and are cached thereafter (mesa task 410),
 * so the per-directory entry cap applies to one folder at a time instead of
 * truncating the whole tree. A non-binary, non-truncated file can be edited
 * and saved back to disk (task 327, `ContentPane`'s Edit affordance);
 * everything else — browsing, the tree, no create/delete/rename — stays
 * read-only. Rendered in place inside ProjectTasksPage's frame, like
 * GitView. Empty states are quiet placeholders, matching the Git tab's
 * ladder, never a hard error (M10).
 *
 * The content half holds *many* open files as a strip of draggable tabs and
 * can split once, into two side-by-side panes with independent strips (mesa
 * task 670). None of that is deep-linked or persisted: it is component state
 * with the same lifetime `selectedPath` had, reset on project change.
 */
export function FilesView({ projectId }: { projectId: number }) {
  const { data, error, refetch } = useFetch(
    () => getProjectFiles(projectId),
    `files-${projectId}`,
  )
  // A split of a ≤860px content area is two unusable columns, and the split is
  // a React data structure rather than styling — so unlike `treeOpen` below
  // this one genuinely needs the breakpoint in JS (`docs/mobile.md`, same
  // exception the terminal's pane tree takes one tier down). Read before the
  // open set because the seed folds a stored split against it.
  const narrow = useNarrowTier()
  // The open set — tabs, order, which pane is focused, whether it is split and
  // at what ratio — together with the per-open-path view state that must
  // outlive a tab switch. The tabs half is remembered per project in
  // localStorage (`openFiles.ts`, mesa task 696); `fileUi` is not — a draft
  // keeps the component's lifetime and is dropped on unmount. Still no URL
  // deep-linking into the tree.
  //
  // **One** state object, not two, and that is load-bearing: dropping a
  // closed path's draft has to happen in the same update that closes it, and
  // an updater is the only place with both the previous and the next tabs in
  // hand. `fileUi` is keyed by path, so the same file open in both panes of a
  // split shares one draft — the only coherent answer when both are editing
  // the same bytes.
  const [open, setOpen] = useState<{
    tabs: TabsState
    fileUi: Map<string, FileUiState>
  }>(() => ({ tabs: loadOpenFiles(projectId, narrow), fileUi: new Map() }))
  const { tabs, fileUi } = open
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
  // The open naming row (mesa task 672), if any: the directory it belongs to
  // (`''` = the project root), the message under it, and whether its create is
  // in flight. One row at a time, so one slot, not a map.
  const [newFileParent, setNewFileParent] = useState<string | null>(null)
  const [newFileError, setNewFileError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // The wide-tier tree pane's own width and collapse (mesa task 671), both
  // persisted globally for the Files tab (`filesTreeWidth.ts`). Deliberately
  // independent of `treeOpen` above: that one is the phone tier's control and
  // is inert above 600px, these two are the wide tier's and are made inert at
  // and below 860px by CSS alone — neither flag ever reads the other, and no
  // second `matchMedia` is introduced (`docs/mobile.md`).
  const [treeWidth, setTreeWidth] = useState(loadFilesTreeWidth)
  const [treeCollapsed, setTreeCollapsed] = useState(loadFilesTreeCollapsed)
  const [treeResizing, setTreeResizing] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  // Whether a tab drag is in flight at all — what arms the right-edge split
  // zone. Distinct from `mark`, which is only set while the pointer is over a
  // strip: leaving the strip for the edge clears the indicator but must not
  // take the drop target it is heading for with it.
  const [dragActive, setDragActive] = useState(false)
  // Where the drop indicator is painting, for the length of one drag.
  const [mark, setMark] = useState<DropMark | null>(null)
  // Whether a tab is currently over the right-edge split zone.
  const [edgeArmed, setEdgeArmed] = useState(false)
  const panesRef = useRef<HTMLDivElement>(null)
  // Edge-triggered on the crossing, never derived: re-deriving would re-fold a
  // split the user opened at, say, 800px, on every render.
  useEffect(
    () =>
      onNarrowTierChange((isNarrow) => {
        if (!isNarrow) return
        setOpen((prev) =>
          prev.tabs.right === null
            ? prev
            : { ...prev, tabs: collapseSplit(prev.tabs) },
        )
      }),
    [],
  )
  // A stored width is loaded unclamped (`filesTreeWidth.ts` can't see the
  // layout), so pull it into range once the tree is mounted and on every
  // window resize — the state must never *hold* an out-of-range value, not
  // merely render as one. `data` is a dependency because the tree only exists
  // once the fetch has landed; until then there is nothing to measure against.
  useEffect(() => {
    const clampToLayout = () => {
      const max = maxTreeWidth(treeRef.current, panesRef.current)
      if (max === null) return
      setTreeWidth((w) => clampFilesTreeWidth(w, max))
    }
    clampToLayout()
    window.addEventListener('resize', clampToLayout)
    return () => window.removeEventListener('resize', clampToLayout)
  }, [treeCollapsed, data])

  // Listeners go on `document`, not the handle, so the drag keeps tracking
  // when the pointer outruns it. The new width is the pointer's distance from
  // the tree's own left edge (the handle is on its *right* edge — this is the
  // left pane, the mirror of the nav's and the agent rail's). The <body> class
  // matches `body.nav-resizing` so a sweep across the page doesn't select text
  // under it.
  useEffect(() => {
    if (!treeResizing) return
    // The listeners live for the whole drag, so they'd close over the
    // `treeWidth` this effect started with. `latest` carries the value forward
    // for `onUp` to persist without re-subscribing on every move. It stays
    // null until the pointer actually moves, so a press-and-release that never
    // dragged writes nothing.
    let latest: number | null = null
    const onMove = (e: MouseEvent) => {
      const treeLeft = treeRef.current?.getBoundingClientRect().left
      const max = maxTreeWidth(treeRef.current, panesRef.current)
      if (treeLeft === undefined || max === null) return
      latest = clampFilesTreeWidth(e.clientX - treeLeft, max)
      setTreeWidth(latest)
    }
    // Persist on drag end only: once per drag, not once a frame. Written here
    // rather than from a `[treeWidth]` effect so the double-click reset's
    // `clearFilesTreeWidth()` isn't immediately undone by a re-save of the
    // default.
    const onUp = () => {
      setTreeResizing(false)
      if (latest !== null) saveFilesTreeWidth(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('files-tree-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('files-tree-resizing')
    }
  }, [treeResizing])

  // Persist the open set (never `fileUi`). Every tabs write funnels through
  // `commit()`, so this one effect covers open/close/activate/focus/split/
  // move/ratio — no save calls sprinkled through the handlers.
  useEffect(() => saveOpenFiles(projectId, tabs), [projectId, tabs])

  // Reset on project change (render-time, off the changed prop — same
  // pattern as GitView/HistoryPane): this component isn't remounted when the
  // route moves between projects, so a stale selection from project A must
  // not leak into project B. Tabs are the one thing that *restores* rather
  // than empties — the new project's own remembered set, never A's.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setOpen({ tabs: loadOpenFiles(projectId, narrow), fileUi: new Map() })
    setExpanded(new Set())
    setChildrenCache(new Map())
    setTreeOpen(true)
    setNewFileParent(null)
    setNewFileError(null)
  }

  /**
   * Every tabs write goes through here, as a **transition off the previous
   * state** rather than off the render's `tabs` — so two opens landing in one
   * batch both take effect, instead of the second overwriting the first from
   * a stale closure. A `null` transition (`fileTabs.ts`'s no-op answer) writes
   * nothing at all.
   *
   * It is also where a path whose last tab just closed drops its draft and
   * history — the "closing a tab discards its draft, no confirm" half of the
   * state lifetime, and the reason this is one updater and not two.
   */
  function commit(step: (prev: TabsState) => TabsState | null) {
    setOpen((prev) => {
      const next = step(prev.tabs)
      if (next === null || next === prev.tabs) return prev
      const keep = new Set(openPaths(next))
      const stale = [...prev.fileUi.keys()].filter((p) => !keep.has(p))
      if (stale.length === 0) return { tabs: next, fileUi: prev.fileUi }
      const fileUi = new Map(prev.fileUi)
      for (const p of stale) fileUi.delete(p)
      return { tabs: next, fileUi }
    })
  }

  function patchUi(path: string, patch: Partial<FileUiState>) {
    setOpen((prev) => ({
      ...prev,
      fileUi: new Map(prev.fileUi).set(path, {
        ...(prev.fileUi.get(path) ?? BLANK_FILE_UI),
        ...patch,
      }),
    }))
  }

  /** Fetches one directory level and installs it in the cache, replacing
   *  whatever was there — the "drop the entry and re-fetch" half of a create,
   *  and the fetch half of `ensureChildren`'s first expand. */
  function loadDir(path: string) {
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

  function ensureChildren(path: string) {
    if (childrenCache.has(path)) return // loaded or already loading
    loadDir(path)
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

  /** Opens the naming row under `parent` (`''` = the project root), expanding
   *  that directory first so the row has somewhere to appear. */
  function startCreate(parent: string) {
    setNewFileError(null)
    setNewFileParent(parent)
    if (parent === '') return
    setExpanded((prev) => new Set(prev).add(parent))
    ensureChildren(parent)
  }

  /** Enter on the naming row. The client-side name rules run first
   *  (`newFile.ts`) so an obviously bad name is an instant message rather than
   *  a round trip; the server re-validates everything regardless, and its own
   *  409/422/404 lands in the same place. */
  async function submitCreate(name: string) {
    if (newFileParent === null || creating) return
    const parent = newFileParent
    const decided = newFilePath(parent, name)
    if (!decided.ok) {
      setNewFileError(decided.reason)
      return
    }
    setCreating(true)
    setNewFileError(null)
    try {
      await createProjectFile(projectId, decided.path)
      setNewFileParent(null)
      // The server already evicted its own tree cache for this level, so a
      // re-fetch now sees the new file. The root level is the tab's own
      // loader; anything deeper is the per-directory cache.
      if (parent === '') refetch()
      else loadDir(parent)
      commit((prev) => openFile(prev, decided.path))
      // Same reason the tree closes when a file is picked: on the phone tier
      // a full column of rows would push the file below the fold. Inert above
      // 600px.
      setTreeOpen(false)
    } catch (e) {
      setNewFileError(
        e instanceof ApiError ? e.message : 'Failed to create file.',
      )
    } finally {
      setCreating(false)
    }
  }

  const create: TreeCreate = {
    parent: newFileParent,
    error: newFileError,
    busy: creating,
    onStart: startCreate,
    onSubmit: submitCreate,
    onCancel: () => {
      setNewFileParent(null)
      setNewFileError(null)
    },
  }

  // Same `dragenter`-as-well-as-`dragover` rule as the strips above.
  function armEdge(e: ReactDragEvent) {
    if (dragging === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setEdgeArmed(true)
  }

  function endDrag() {
    setDragActive(false)
    setMark(null)
    setEdgeArmed(false)
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

  const split = tabs.right !== null
  // The tree's highlight follows the focused pane's active tab — the file the
  // user is looking at, in a split as much as out of one.
  const selectedPath = (split && tabs.focused === 'right' ? tabs.right! : tabs.left)
    .active

  function paneProps(side: PaneSide) {
    const pane = side === 'left' ? tabs.left : tabs.right!
    return {
      projectId,
      side,
      tabs: pane.tabs,
      active: pane.active,
      focused: !split || tabs.focused === side,
      // One level of splitting, and the control only makes sense with
      // something to show in the second pane.
      canSplit: !split && !narrow && pane.active !== null,
      mark,
      fileUi,
      onUi: patchUi,
      onFocus: () => commit((prev) => focusPane(prev, side)),
      onActivate: (path: string) => commit((prev) => activateTab(prev, side, path)),
      onClose: (path: string) => commit((prev) => closeTab(prev, side, path)),
      onSplit: () => commit(splitPane),
      onDragBegin: () => setDragActive(true),
      onDragFinish: endDrag,
      onDragOverStrip: (index: number) => {
        setEdgeArmed(false)
        setMark({ side, index })
      },
      onDropOnStrip: (index: number) => {
        const from = dragging
        if (from !== null) commit((prev) => moveTab(prev, from, side, index))
        endDrag()
      },
      // Only the indicator goes; the drag is still live and may yet land on
      // the other strip or the split zone.
      onDragLeaveStrip: () => setMark(null),
    }
  }

  return (
    <div className="files-view">
      {data.truncated && (
        <p className="muted files-truncated-note">
          This folder is larger than what's shown here — the tree was capped.
        </p>
      )}
      {/* An empty root is a row inside the tree, not a placeholder instead of
          it (task 672): the layout has to render for the root's own `+` to
          exist, and creating the first file in an empty project is exactly
          when it is wanted. */}
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
        {/* The tree pane (mesa task 671): the sized, collapsible box the
            tree scrolls inside. The width is applied as a custom property,
            never an inline `width` — the ≤860px tier stacks the panes into
            a column and relaxes the tree to `width: auto`, and an inline
            width would beat that rule and hand a 390px screen a drag-width
            tree. The collapse is CSS-only for the same reason: the rail and
            the tree are both always rendered, and only the wide tier has a
            rule that hides either, so the flag cannot leak downward. */}
        <div
          className={`files-tree-pane${treeCollapsed ? ' collapsed' : ''}${
            treeResizing ? ' resizing' : ''
          }${treeOpen ? '' : ' files-tree-collapsed'}`}
          ref={treeRef}
          style={{ '--files-tree-width': `${treeWidth}px` } as CSSProperties}
        >
          {/* Header rail above the tree: the root's own `+` beside the
              collapse toggle, since the root has no row of its own to hang
              one on. */}
          <div className="files-tree-head">
            <NewFileButton
              parent=""
              label="New file in the project root"
              create={create}
            />
            <button
              type="button"
              className="files-tree-collapse-toggle"
              aria-expanded={!treeCollapsed}
              aria-label={
                treeCollapsed ? 'Expand file tree' : 'Collapse file tree'
              }
              title={treeCollapsed ? 'Expand file tree' : 'Collapse file tree'}
              // Written straight through rather than from a `[treeCollapsed]`
              // effect: an updater with a localStorage write inside it isn't
              // pure, and an effect would also re-save on mount.
              onClick={() => {
                setTreeCollapsed(!treeCollapsed)
                saveFilesTreeCollapsed(!treeCollapsed)
              }}
            >
              {treeCollapsed ? '»' : '«'}
            </button>
          </div>
          <ul className="files-tree">
            {create.parent === '' && <NewFileRow depth={0} create={create} />}
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
                  // Opens into the focused pane and activates it — or just
                  // activates the tab already holding it, wherever that is.
                  commit((prev) => openFile(prev, path))
                  // Opening a file closes the tree, which is what makes the
                  // phone tier's stacked layout usable: the tree is a full
                  // column of rows, so leaving it up pushes the file itself
                  // below the fold (measured at 390x844: the content pane's
                  // top sat at 643px of an 844px viewport). Inert above
                  // 600px, per `treeOpen` above.
                  setTreeOpen(false)
                }}
                create={create}
              />
            ))}
            {data.tree.length === 0 && (
              <li className="files-tree-note muted">This folder is empty.</li>
            )}
          </ul>
          {/* Drag handle on the pane's own right edge — absolutely
              positioned so the tree's `overflow-y: auto` can't scroll it
              away, straddling the border so it's grabbable from either
              side (the agent rail's trick). Hidden along with the tree
              while collapsed, and by CSS at every tier that stacks. */}
          <div
            className="files-tree-resize-handle"
            onMouseDown={(e) => {
              e.preventDefault()
              setTreeResizing(true)
            }}
            onDoubleClick={() => {
              setTreeWidth(DEFAULT_FILES_TREE_WIDTH)
              clearFilesTreeWidth()
            }}
          />
        </div>
        <div className="files-panes" ref={panesRef}>
          <FilePane
            {...paneProps('left')}
            style={split ? { flex: `0 0 calc(${tabs.ratio * 100}% - 0.25rem)` } : undefined}
          />
          {split && (
            <>
              {/* Pointer events, not HTML5 drag: a divider is a continuous
                  resize, and a drag image following the cursor would be
                  nonsense. Capture keeps the drag alive over the panes'
                  own iframes/textareas. */}
              <div
                className="files-pane-divider"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                  const box = panesRef.current?.getBoundingClientRect()
                  if (box === undefined || box.width === 0) return
                  const ratio = (e.clientX - box.left) / box.width
                  commit((prev) => setRatio(prev, ratio))
                }}
                onPointerUp={(e) => {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }}
              />
              <FilePane {...paneProps('right')} style={{ flex: '1 1 0' }} />
            </>
          )}
          {/* Drag a tab onto the right edge to open the split. Rendered
              only mid-drag, so it never eats a click, and never at the
              narrow tier, where there is no split to enter. */}
          {!split && !narrow && dragActive && (
            <div
              className={`files-split-drop${edgeArmed ? ' armed' : ''}`}
              onDragEnter={armEdge}
              onDragOver={armEdge}
              onDragLeave={() => setEdgeArmed(false)}
              onDrop={(e) => {
                if (dragging === null) return
                e.preventDefault()
                const from = dragging
                commit((prev) => splitWithTab(prev, from))
                endDrag()
              }}
            >
              <span>Split</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
