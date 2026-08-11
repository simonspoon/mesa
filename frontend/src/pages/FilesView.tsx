import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  RefObject,
} from 'react'
import { SyntaxHighlighter, vscDarkPlus, prismGrammar } from '../syntaxHighlighter'
import {
  activateTab,
  closeTab,
  collapseSplit,
  cycleTab,
  dropIndex,
  focusPane,
  moveTab,
  openFile,
  openPaths,
  paneOf,
  setRatio,
  splitPane,
  splitWithTab,
  type PaneSide,
  type TabSource,
  type TabsState,
} from '../fileTabs'
import {
  closeLabel,
  dirtyPaths,
  needsCloseConfirm,
  tabLabel,
} from '../fileDirty'
import {
  clampFilesTreeWidth,
  clearFilesTreeWidth,
  DEFAULT_FILES_TREE_WIDTH,
  loadFilesTreeCollapsed,
  loadFilesTreeWidth,
  saveFilesTreeCollapsed,
  saveFilesTreeWidth,
} from '../filesTreeWidth'
import {
  gutterText,
  lineAtScroll,
  lineCount,
  normalizeNewlines,
  offsetForLine,
  viewerLineCount,
  type CaretPosition,
} from '../editorStatus'
import {
  anchorAfterStep,
  boxNeedsReveal,
  findMatches,
  matchIndexFrom,
  matchLabel,
  scrollLeftForBox,
  stepMatch,
  type FindMatch,
} from '../fileFind'
import {
  MAX_SEARCH_QUERY,
  searchRequestQuery,
  searchSummary,
  snippetSegments,
} from '../fileSearch'
import { shouldIgnoreFilesShortcut } from '../keyboardScope'
import { loadWordWrap, saveWordWrap } from '../wordWrap'
import { onNarrowTierChange, useNarrowTier } from '../phoneTier'
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor'
import { FindLayer } from '../components/FindLayer'
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
  searchProjectFiles,
  updateProjectFilesContent,
} from '../api'
import type { FileTreeEntry } from '../types/FileTreeEntry'
import type { ProjectFileSearch } from '../types/ProjectFileSearch'
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
  /** The file's bytes as they were when this draft started — and again after a
   * successful save (task 809, slice 4). Kept beside the draft rather than
   * compared against the fetched content, because the tab strip that has to
   * paint the unsaved-changes dot lives two components above the only one
   * holding that response: `fileDirty.ts` can answer from this pair alone. */
  baseline: string
  historyOpen: boolean
  /** The commit shown as a diff in place of the content, if any. */
  selectedCommit: GitCommit | null
}

const BLANK_FILE_UI: FileUiState = {
  editing: false,
  draft: '',
  baseline: '',
  historyOpen: false,
  selectedCommit: null,
}

/**
 * The find bar's whole state (task 809, slice 3).
 *
 * Deliberately *not* part of `FileUiState`: a search is a question about the
 * bytes on screen right now, not an edit that would be a bug to lose, so it
 * dies with the mounted pane exactly as `saving` and `caret` do — the same
 * split `FileUiState`'s own doc draws.
 *
 * `anchor` is where the search runs from — the caret when the bar was opened
 * over the editor, the first line on screen over the viewer. Kept rather than
 * re-read per keystroke so that growing the query walks *forward from where the
 * user was*, instead of the result jumping about as the caret follows each new
 * selection. It moves on exactly one event, a step (`anchorAfterStep`), because
 * a step is the user saying "here is where I am now": without that, narrowing a
 * query after walking five matches down the file teleports back to the top of
 * the original search.
 */
interface FindState {
  open: boolean
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  /** Index into the current match list, or -1 for none. */
  index: number
  anchor: number
  /** Whether the bar should take the caret as it comes up. True for every way
   * a *user* opens it (Cmd/Ctrl+F is "let me type a query"), false for the one
   * way it opens without being asked for — a project-search result landing in
   * this pane (task 813), where the caret belongs to the panel the user is
   * still clicking through. */
  autoFocus: boolean
}

const BLANK_FIND: FindState = {
  open: false,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  index: -1,
  anchor: 0,
  autoFocus: true,
}

/**
 * A result clicked in the project-search panel (mesa task 813), handed to the
 * pane that opens the file so it can show the reader *which* line matched.
 *
 * It is deliberately expressed as a search rather than as a scroll offset: the
 * pane already knows how to run a query, land on the first match at or after an
 * anchor, and reveal it in either mode and either wrap setting (`runFind`, and
 * the machinery task 809 built under it). Handing it a line and the query that
 * found the line reuses all of that — and leaves the reader with the in-file
 * bar open on the same query, which is where they wanted to be next anyway.
 *
 * `seq` is what makes a second click on the *same* result land again: every
 * other field can be identical, and only a fresh number says "this is a new
 * click" to the pane that already consumed the last one.
 */
interface SearchLanding {
  seq: number
  path: string
  /** 1-based, over the same capped bytes the content route serves. */
  line: number
  query: string
  caseSensitive: boolean
  wholeWord: boolean
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
  wrap,
  onWrapChange,
  focused,
  landing,
}: {
  projectId: number
  path: string
  ui: FileUiState
  onUi: (patch: Partial<FileUiState>) => void
  /** Soft wrap — one preference for the whole tab, owned by `FilesView` and
   * persisted there, so both panes and every tab agree on it. */
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  /** Whether this is the pane a Files-tab keystroke belongs to. Only it binds
   * Cmd/Ctrl+F — in a split, both panes are mounted, and two find bars racing
   * for one keystroke is the bug that scoping avoids. */
  focused: boolean
  /** The project-search result this pane was opened for, if any (task 813) —
   * consumed once, by `seq`. Null in every other case, which is every case
   * before this feature existed. */
  landing: SearchLanding | null
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
  // The caret the status bar reports (task 809). Local, and not in
  // `FileUiState`: it describes where one live textarea's cursor is, so it dies
  // with the mounted editor exactly as `saving` does. A freshly opened editor
  // autofocuses at offset 0, which is where this starts.
  const [caret, setCaret] = useState<CaretPosition>({ line: 1, col: 1 })
  // Find-in-file (task 809). Same lifetime as `caret` above, for the reason
  // `FindState` sets out. `find` itself is *derived* just below — a search
  // result landing in this pane overrides it until the user touches the bar,
  // which is what `setFind` records (task 813).
  const [findState, setFindState] = useState<FindState>(BLANK_FIND)
  const [consumedLanding, setConsumedLanding] = useState<number | null>(null)
  const editorRef = useRef<CodeEditorHandle>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Armed by `reveal` in view mode and consumed by the effect that measures the
  // mark — a flag rather than a dependency list, for the reason stated at both.
  const pendingReveal = useRef(false)
  // The last search result this pane actually scrolled to (task 813), so one
  // click reveals once however many times the pane re-renders after it.
  const revealedLanding = useRef<number | null>(null)

  // Everything below is computed before the early returns, because hooks are:
  // `data` is still loading on the first renders, and a search over "" is a
  // search with no matches, which is exactly the right answer then.
  const searchText = ui.editing ? ui.draft : (data?.content ?? '')
  // Where a search is even meaningful: over text this pane is showing *as
  // text*. A binary or an image has no offsets; a commit's diff is another
  // revision's bytes, not these; and a markdown file in view mode is rendered
  // prose whose paragraphs no longer correspond to source offsets — there the
  // key is deliberately left to the browser's own find, which works on exactly
  // what is painted. In edit mode a markdown file is source again, so it is
  // findable like anything else.
  const findable =
    data != null &&
    !data.is_binary &&
    !isImagePath(data.path) &&
    ui.selectedCommit === null &&
    (ui.editing || data.language !== 'markdown')
  /**
   * A project-search result the user clicked, still waiting to be shown
   * (task 813): the pane is displaying the file, the reader is looking for the
   * line, and nothing they have done since says otherwise.
   *
   * It stops being active the moment the bar is touched — every write to the
   * find state goes through `setFind` below, which records the landing as
   * consumed — so this is "the search panel's answer, until you take over",
   * not a mode. It also needs the fetch to have landed, since the line is an
   * offset into content that may not be here yet, and needs the file to be
   * findable at all: a binary, an image or markdown rendered as prose has no
   * offsets to point at, and there the click is just "open this file".
   */
  const landingActive =
    landing !== null && landing.seq !== consumedLanding && data != null && findable
  /**
   * The bar's state: normally the state above, and a landing's own while one
   * is active.
   *
   * Derived rather than written into state from an effect, which is the same
   * choice `blocked` is in the store and `findOpen` is two lines down: an
   * effect would paint the top of the file first and jump a frame later, and
   * it would have to decide what "the same result clicked twice" means. Here
   * that falls out — a fresh `seq` is not the consumed one, so the derivation
   * simply answers differently.
   */
  const find: FindState = landingActive
    ? {
        open: true,
        // The caret stays with the panel the reader is clicking through; the
        // bar is here to be stepped, not typed in, until they say otherwise.
        autoFocus: false,
        query: landing.query,
        caseSensitive: landing.caseSensitive,
        wholeWord: landing.wholeWord,
        index: -1,
        // The line becomes an anchor through the same function the status bar
        // counts lines with — so "which match" is `matchIndexFrom`'s ordinary
        // answer rather than a second rule about landings.
        anchor: offsetForLine(ui.editing ? ui.draft : (data?.content ?? ''), landing.line),
      }
    : findState
  /** Every write to the bar — typing, a toggle, a step, a close — and the one
   * place a landing is marked as taken over. They are the same event: the user
   * has said where they are now, so the panel's answer stops overriding it. */
  function setFind(next: FindState | ((prev: FindState) => FindState)) {
    // An updater resolves against the *derived* state, not the stored one:
    // crossing into or out of edit mode while a landing is showing means
    // taking that landing over, and `{...f}` there has to be what is on
    // screen.
    setFindState(typeof next === 'function' ? next(find) : next)
    setConsumedLanding(landing?.seq ?? null)
  }
  // Whether the bar is actually *up*, which is what every reader below wants —
  // `find.open` alone is not it. The two part company on their own: cancelling
  // an edit turns a markdown file back into rendered prose, which is not
  // findable, and the flag would otherwise stay set behind a bar that is no
  // longer rendered. Deriving it once is what keeps the render, the Escape
  // routing and the highlights from each answering that question differently.
  const findOpen = findable && find.open
  // A closed bar searches for nothing, which is how the highlights go away
  // without a second flag deciding whether to paint them.
  const { matches, capped } = useMemo(
    () =>
      findMatches(searchText, findOpen ? find.query : '', {
        caseSensitive: find.caseSensitive,
        wholeWord: find.wholeWord,
      }),
    [searchText, findOpen, find.query, find.caseSensitive, find.wholeWord],
  )
  // Clamped rather than trusted: the list shrinks under the index every time
  // the query grows a character. A landing has no index to clamp — it has a
  // line — so it asks the same question `runFind` asks: the first match at or
  // after the anchor, wrapping if there is none past it.
  const current = landingActive
    ? matchIndexFrom(matches, find.anchor, true)
    : matches.length === 0
      ? -1
      : Math.min(Math.max(find.index, 0), matches.length - 1)

  /** Search for `next`'s query/options from `anchor` and land on a match.
   *
   * Recomputes rather than reading the render's `matches`, because every caller
   * is changing one of the three inputs and needs the answer for the value it
   * is *setting*, not the one on screen. `findMatches` is a linear scan of a
   * string that is already in memory, so this is cheaper than the re-render it
   * triggers. */
  function runFind(next: FindState, forward: boolean) {
    const { matches: found } = findMatches(searchText, next.query, next)
    const index = matchIndexFrom(found, next.anchor, forward)
    setFind({ ...next, index })
    reveal(found[index])
  }

  /** Show a match. Editing, the editor does it; in view mode the work is the
   * effect below, because the highlight to measure does not exist in the DOM
   * until React has painted the new `current`.
   *
   * The viewer's half is therefore *armed* here rather than performed — a flag,
   * the same shape as `CodeEditor`'s own `pendingReveal`, and for the same
   * reason: a step is an event, and no value the effect could list reports one.
   * `matches` is a fresh array on every keystroke, so listing it scrolled the
   * pane back on every character typed; and `current` alone misses the
   * legitimate no-op step — `(0 + 1) % 1 === 0`, Enter on a one-match file —
   * which leaves the counter stepping while the view sits still, the exact
   * failure the reveal exists to prevent.
   *
   * Focus stays in the query box on purpose: Enter has to keep stepping, and a
   * textarea that grabbed the caret on every step would swallow the next
   * character of the query. Closing the bar is what hands focus back
   * (`closeFind`), with this selection already in place and ready to be typed
   * over. */
  function reveal(match: FindMatch | undefined) {
    if (match === undefined) return
    if (ui.editing) editorRef.current?.reveal(match.start, match.end)
    else pendingReveal.current = true
  }

  function openFind() {
    if (findOpen) {
      // Cmd+F on an open bar is "let me retype that", the browser's own
      // behaviour for its find bar. `select()` sets a selection range and does
      // NOT move focus, so the focus call is half of it and not a belt-and-
      // braces extra: the chord is deliberately allowed while the caret is in
      // the code (`shouldIgnoreFilesShortcut`), which is the case where the
      // characters typed next would otherwise land in the file.
      findInputRef.current?.focus()
      findInputRef.current?.select()
      return
    }
    runFind({ ...find, open: true, autoFocus: true, anchor: findAnchor() }, true)
  }

  // ...and the same selection when the bar comes *up*, which is the reopen the
  // branch above cannot reach: `closeFind` keeps the query, so the second
  // Cmd/Ctrl+F re-mounts the box with the previous one in it, and `autoFocus`
  // focuses without selecting — so typing appended (`foofoobar`) instead of
  // replacing. Cmd+F-then-type is the reflex the whole bar is for, and it is
  // the browser's own behaviour for its find bar. An effect rather than a call
  // in `openFind`, because on a fresh open the input does not exist until React
  // has rendered it.
  useEffect(() => {
    if (findOpen && find.autoFocus) findInputRef.current?.select()
  }, [findOpen, find.autoFocus])

  /** Where a fresh search starts from: what the user is looking at.
   *
   * Editing, that is the caret. Read-only there is no caret, so it is the first
   * line still on screen — measured off the pane's own scroll, since the code
   * and the scroller are both real elements here. Without it Cmd+F halfway down
   * a 2,000-line file lands on the first match at the *top* of the file and
   * `scrollIntoView` yanks the pane there, which is the opposite of what the
   * key was pressed for.
   *
   * "On screen" means *readable*, so the sticky block's own height counts as
   * scrolled-away too: `.files-content-top` covers the top of the scrollport
   * (two rows of code, more once the find bar itself is up), and without
   * subtracting it the anchor is the first line in the scrollport rather than
   * the first line the user can see — which is how a fresh Cmd+F could anchor
   * on, and land on, a match hidden behind the header.
   *
   * Anchored at 0 under soft wrap, and that is deliberate rather than a gap: a
   * wrapped logical line is several visual rows, so pixels-scrolled ÷
   * line-height counts rows and would overshoot into the file — the same reason
   * the gutter is hidden and the editor's reveal is measured rather than
   * calculated when wrap is on. Landing at the top is a worse anchor; landing
   * past what you were reading is a wrong one. */
  function findAnchor(): number {
    if (ui.editing) return editorRef.current?.caretOffset() ?? 0
    const content = contentRef.current
    const code = content?.querySelector<HTMLElement>('.files-code-main')
    // `.files-content` is the scrolling pane body's only child (`FilePane`), so
    // its parent is the scrollport the line is or is not inside.
    const port = content?.parentElement
    if (wrap || content == null || code == null || port == null) return 0
    const header = content.querySelector<HTMLElement>('.files-content-top')
    const hidden =
      port.getBoundingClientRect().top -
      code.getBoundingClientRect().top +
      (header?.offsetHeight ?? 0)
    const line = lineAtScroll(hidden, parseFloat(getComputedStyle(code).lineHeight))
    return offsetForLine(searchText, line)
  }

  function closeFind() {
    setFind({ ...find, open: false, index: -1 })
    // Focus has to land somewhere deliberate: the query box is unmounted while
    // it holds the caret, and a control that disappears focused drops focus on
    // `<body>` — Tab then restarts at the top of the page and Escape reads as
    // having done nothing at all. Editing, the code is where it belongs, with
    // the last match still selected in it and ready to be typed over. In view
    // mode there is no control to hand it to, so the content column takes it
    // (`tabIndex={-1}`, focusable only programmatically) and Tab carries on
    // from the file the user was reading. `preventScroll` because this is a
    // hand-back, not a reveal — the pane is already where the reader left it.
    if (ui.editing) editorRef.current?.focus()
    else contentRef.current?.focus({ preventScroll: true })
  }

  function stepFind(forward: boolean) {
    const index = stepMatch(matches, current, forward)
    // The anchor follows the step (`anchorAfterStep`): refining a query after
    // walking to the 5th match must narrow *there*, not throw the user back to
    // wherever the bar was opened. Only a step moves it — a fresh open still
    // anchors on what is on screen.
    setFind({ ...find, index, anchor: anchorAfterStep(matches, index, find.anchor) })
    reveal(matches[index])
  }

  // The one keystroke the Files tab takes off the browser. Scoped three ways
  // before it is claimed: this pane must be the focused one, the file must be
  // findable at all, and `shouldIgnoreFilesShortcut` must agree the caret is not
  // somewhere with a better claim (a task modal's field, the tree's naming
  // row). `preventDefault` fires only after all three pass, so everywhere else
  // in the app Cmd/Ctrl+F still opens the browser's own find.
  //
  // No dependency array: the handler closes over the live query and anchor, and
  // listing them would be listing most of this component's state. One
  // add/remove of one cheap listener per render is the smaller price.
  useEffect(() => {
    if (!focused || !findable) return
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the bar from anywhere in view mode, not only from the
      // query box: the option and step buttons are focusable, and clicking one
      // used to leave the key answered by nothing at all. In edit mode the
      // editor's own `onCancel` already routes it by precedence (find first,
      // then discard) and this must not race that.
      if (e.key === 'Escape' && findOpen && !ui.editing) {
        if (shouldIgnoreFilesShortcut(e, 'find')) return
        e.preventDefault()
        closeFind()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      // Cmd/Ctrl+**Shift**+F is "find in files" everywhere it is bound, and on
      // some setups a browser or extension chord — swallowing it to open the
      // in-file bar is claiming a key this tab was never offered.
      if (e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      if (shouldIgnoreFilesShortcut(e, 'find')) return
      e.preventDefault()
      openFind()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // The viewer's scroll-into-view, consuming what `reveal` armed — no
  // dependency list, for the reason spelled out there and in `CodeEditor`'s
  // twin of this effect.
  //
  // *Vertically* this one can be a real `scrollIntoView`, unlike the editor's:
  // the current match is a real element in the highlight layer, so the browser
  // is the thing that knows where it ended up — no line arithmetic, and it is
  // correct with soft wrap on as much as off. What the browser will not do is
  // *not* scroll: `block: 'center'` re-centres unconditionally, so stepping
  // between two matches a screenful apart threw the file by half a pane on every
  // Enter while the editor, whose `scrollTopForBox` returns the scroll it was
  // given for a box already in view, sat still on the same keystroke. Asking
  // first (`boxNeedsReveal`) is what makes the two panes answer alike. The band
  // it is asked about is not the scrollport: `.files-content-top` is pinned over
  // its top and the status bar over its bottom, and a match painted under either
  // is not one the reader can see — the vertical twin of the gutter lead-in
  // below. `block: 'nearest'` is not that answer, since it would land the match
  // flush at the scrollport's top edge, i.e. behind the header.
  //
  // Sideways it cannot be a `scrollIntoView` at all, and that is not a second
  // answer to the same question but the one thing the call does not know:
  // `.files-code-gutter` is `position: sticky` over the left edge of
  // `.files-code-scroll`, and `inline: 'nearest'` aligns a match lying left of
  // the current view flush to that edge — under the numbers, with the counter
  // and the `.current` class both reporting success. It is the same overlay the
  // editor's `scrollLeftForBox` lead-in exists for, so it is the same call: the
  // scroller has a real `scrollLeft`, the gutter a real `offsetWidth` and
  // `.files-code-main` the same 0.5rem channel past it the editor's computed
  // `padding-left` already includes — so a match revealed from the left arrives
  // with a column of code beside it in *both* panes, rather than abutting the
  // numbers in one of them. Measured off rects rather than `offsetLeft` because
  // the mark's offset parent is `.files-code-main`, one box in from the
  // scroller.
  //
  // A **landing** arms it too (task 813), and by the same kind of flag rather
  // than by watching `landing`: the pane is being *rendered* with the panel's
  // answer in place (`landingActive`), and the mark to measure exists only
  // after that render — which is exactly the state this effect already exists
  // to handle. `revealedLanding` is the once-per-`seq` guard; a second click on
  // the same result is a new `seq` and reveals again, while an unrelated
  // re-render (a keystroke elsewhere, a resize) is the same one and does not.
  // Editing, there is no mark to measure and the editor does it, which is the
  // one branch that leaves this effect early.
  useEffect(() => {
    const landed =
      landingActive && current >= 0 && revealedLanding.current !== landing.seq
    if (landed) revealedLanding.current = landing.seq
    if (!pendingReveal.current && !landed) return
    pendingReveal.current = false
    if (landed && ui.editing) {
      const match = matches[current]
      if (match !== undefined) editorRef.current?.reveal(match.start, match.end)
      return
    }
    const content = contentRef.current
    const mark = content?.querySelector<HTMLElement>('.files-find-hit.current')
    if (content == null || mark == null || !findOpen || ui.editing || current < 0) {
      return
    }
    // `.files-content` is the scrolling pane body's only child (`FilePane`), so
    // its parent is the scrollport the sticky bars are pinned inside.
    const port = content.parentElement
    const band = port?.getBoundingClientRect()
    if (band !== undefined) {
      const head = content.querySelector<HTMLElement>('.files-content-top')
      const status = content.querySelector<HTMLElement>('.files-status-bar')
      const box = mark.getBoundingClientRect()
      if (
        boxNeedsReveal(
          box.top,
          box.height,
          band.top + (head?.offsetHeight ?? 0),
          band.bottom - (status?.offsetHeight ?? 0),
        )
      ) {
        mark.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    }
    const scroller = mark.closest<HTMLElement>('.files-code-scroll')
    if (scroller === null) return
    const gutter = scroller.querySelector<HTMLElement>('.files-code-gutter')
    const main = mark.closest<HTMLElement>('.files-code-main')
    const channel = main === null ? 0 : parseFloat(getComputedStyle(main).paddingLeft)
    // After the call above, so the rect is read against the scroll position it
    // left behind rather than the one before it.
    const box = mark.getBoundingClientRect()
    const rect = scroller.getBoundingClientRect()
    scroller.scrollLeft = scrollLeftForBox(
      box.left - rect.left + scroller.scrollLeft,
      box.width,
      scroller.clientWidth,
      scroller.scrollLeft,
      (gutter?.offsetWidth ?? 0) + (Number.isFinite(channel) ? channel : 0),
    )
  })

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
    // The editor autofocuses at offset 0, so the status bar must start there
    // too rather than keeping a caret from a previous edit of this file.
    setCaret({ line: 1, col: 1 })
    // LF, whatever the file on disk uses: a textarea hands its value back
    // LF-normalised, so a CRLF draft would not be offset-for-offset the string
    // the browser reports — find would paint its highlights correctly and
    // select a range one character per line early in the textarea underneath.
    // See `normalizeNewlines`.
    const content = normalizeNewlines(data!.content)
    // A find running over the viewer was running over the file's bytes; the
    // draft is those bytes LF-normalised, so in a CRLF file every offset the
    // bar is holding is one character per preceding line too large. The bar
    // stays up (source is findable), but its anchor and its index are answers
    // about the other string — same reason the caret above is reset rather than
    // carried.
    setFind((f) => ({ ...f, index: -1, anchor: 0 }))
    onUi({
      historyOpen: false,
      selectedCommit: null,
      draft: content,
      // The baseline the dirty dot is measured from: what is on disk right
      // now, which is what this draft starts as.
      baseline: content,
      editing: true,
    })
  }

  function cancelEdit() {
    setSaveError(null)
    // The crossing back is the same offset problem as `startEdit`'s, in the
    // other direction: the viewer searches the bytes on disk, the draft was
    // LF-normalised.
    setFind((f) => ({ ...f, index: -1, anchor: 0 }))
    onUi({ editing: false })
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      await updateProjectFilesContent(projectId, path, draft)
      // The draft *is* the file now, so the baseline moves onto it, which is
      // what makes the tab read clean (`fileDirty.ts`: dirty is `editing &&
      // draft !== baseline`).
      //
      // Edit mode deliberately STAYS open. Cmd/Ctrl+S is bound to this, and in
      // every editor that chord is the every-thirty-seconds reflex pressed
      // mid-thought — swapping the textarea for the viewer on each press drops
      // the caret, the scroll and the find bar, and on a markdown file lands
      // the user in rendered prose instead of the source they were editing. The
      // Save button shares the binding's meaning rather than the other way
      // round; Cancel is how edit mode is left.
      onUi({ baseline: draft })
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
    <CodeEditor
      value={draft}
      language={data.language}
      onChange={(next) => onUi({ draft: next })}
      // Escape means two things here, and which one it gets is not decided by
      // focus: the bar's own box handles the key when the caret is in it, but
      // stepping matches deliberately leaves the caret in the code, so the
      // editor is where Escape usually lands while a find is running. With the
      // bar up it therefore closes the bar; only once it is gone does the key
      // discard the edit. The other order would let one keystroke throw away a
      // whole draft as the answer to "I'm done searching".
      onCancel={findOpen ? closeFind : cancelEdit}
      onSave={save}
      wrap={wrap}
      onCaret={setCaret}
      matches={matches}
      current={current}
      ref={editorRef}
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
      wrap={wrap}
    />
  ) : (
    <FileCode
      content={data.content}
      language={data.language}
      wrap={wrap}
      numbered
      matches={matches}
      current={current}
    />
  )

  return (
    // `tabIndex={-1}`: not in the tab order, but a place `closeFind` can put
    // focus back when the bar it was in disappears (see there).
    <div className="files-content" ref={contentRef} tabIndex={-1}>
      {/* Header and find bar in one sticky block, so the bar cannot scroll
          away from the file it is searching — two independently sticky rows
          would have to agree on each other's height to stack. */}
      <div className="files-content-top">
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
        {findOpen && (
          <FindBar
            query={find.query}
            caseSensitive={find.caseSensitive}
            wholeWord={find.wholeWord}
            label={matchLabel(current, matches.length, capped)}
            takeFocus={find.autoFocus}
            inputRef={findInputRef}
            onSearch={(patch) => runFind({ ...find, ...patch }, true)}
            onStep={stepFind}
            onClose={closeFind}
          />
        )}
      </div>
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
      {/* Not over a commit's diff: the bar describes the file on disk, and
          beside another revision's diff its counts would be a lie. Not for a
          binary or an image either — neither has lines. */}
      {selectedCommit === null && !data.is_binary && !isImagePath(data.path) && (
        <FileStatusBar
          editing={editing}
          caret={caret}
          lines={editing ? lineCount(draft) : viewerLineCount(data.content)}
          language={data.language}
          wrap={wrap}
          onWrapChange={onWrapChange}
        />
      )}
    </div>
  )
}

/** The pane's status bar (task 809): where the caret is, how long the file is,
 * what language it is being read as, and the wrap toggle.
 *
 * The caret is shown only while editing, because that is the only state where
 * there is one — a read-only `<pre>` has a selection at most, and a "Ln 1, Col
 * 1" that never moved would read as a broken indicator rather than an absent
 * one. The line count is the one the gutter beside it was built from, so the
 * bar and the last number in the gutter can never disagree. */
function FileStatusBar({
  editing,
  caret,
  lines,
  language,
  wrap,
  onWrapChange,
}: {
  editing: boolean
  caret: CaretPosition
  lines: number
  language: string | null
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
}) {
  return (
    <div className="files-status-bar">
      {editing && (
        <span>
          Ln {caret.line}, Col {caret.col}
        </span>
      )}
      <span>
        {lines} {lines === 1 ? 'line' : 'lines'}
      </span>
      <span>{language ?? 'plain text'}</span>
      <button
        type="button"
        className="files-edit-btn"
        aria-pressed={wrap}
        onClick={() => onWrapChange(!wrap)}
      >
        Wrap: {wrap ? 'on' : 'off'}
      </button>
    </div>
  )
}

/** Find-in-file's controls (task 809): the query box, the counter, the two
 * option toggles and the step/close buttons.
 *
 * Presentational on purpose — it decides nothing. Which match is current, what
 * the counter says and where the view scrolls to are all `fileFind.ts` and
 * `ContentPane`; this component turns a keystroke into one `onSearch`/`onStep`
 * call. That split is what lets the whole feature be unit-tested without
 * rendering a component.
 *
 * Enter/Shift+Enter step rather than submit: there is no form here, and Enter
 * is the one key every editor's find box binds. Escape closes, which is also
 * the textarea's own discard binding — but the bar is a separate control, so a
 * keystroke aimed at it never reaches the editor underneath.
 *
 * **Every button hands the caret back to the query box** (`refocus`), which is
 * what keeps those two keys meaning what they say. Left alone, clicking `Aa`
 * moves focus to that button, and the next Enter re-toggles case sensitivity
 * instead of stepping — with Shift+Enter and Enter suddenly identical, and
 * Escape answered by nothing. VS Code keeps the caret in the box for exactly
 * this reason. The close button is the one exception: it is *leaving*, and the
 * caret it hands back belongs to the editor (`closeFind`). */
function FindBar({
  query,
  caseSensitive,
  wholeWord,
  label,
  takeFocus,
  inputRef,
  onSearch,
  onStep,
  onClose,
}: {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  /** Already-formatted "n of N" / "No results" — the arithmetic is
   * `matchLabel`'s, not this component's. */
  label: string
  /** Whether the query box takes the caret as the bar mounts. False for the
   * one open nobody asked for — a project-search result landing in this pane
   * (task 813), where the caret stays with the panel being clicked through. */
  takeFocus: boolean
  /** Held by the parent so a second Cmd/Ctrl+F can re-select the query. */
  inputRef: RefObject<HTMLInputElement | null>
  /** Any change that re-runs the search from the anchor. */
  onSearch: (patch: { query?: string; caseSensitive?: boolean; wholeWord?: boolean }) => void
  onStep: (forward: boolean) => void
  onClose: () => void
}) {
  /** Do the thing, then put the caret back where the typing goes. */
  function refocus<T>(act: (arg: T) => void): (arg: T) => void {
    return (arg) => {
      act(arg)
      inputRef.current?.focus()
    }
  }
  return (
    <div className="files-find-bar">
      <input
        autoFocus={takeFocus}
        ref={inputRef}
        className="files-find-input"
        value={query}
        placeholder="Find"
        spellCheck={false}
        aria-label="Find in file"
        onChange={(e) => onSearch({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(!e.shiftKey)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="files-find-count">{label}</span>
      {/* `aria-pressed` rather than a checkbox: these are toggle buttons in
          every editor that has them, and a checkbox would need a label the
          strip has no room for. */}
      <button
        type="button"
        className="files-find-toggle"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={refocus(() => onSearch({ caseSensitive: !caseSensitive }))}
      >
        Aa
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-pressed={wholeWord}
        title="Whole word"
        onClick={refocus(() => onSearch({ wholeWord: !wholeWord }))}
      >
        |ab|
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        onClick={refocus(() => onStep(false))}
      >
        ↑
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Next match"
        title="Next match (Enter)"
        onClick={refocus(() => onStep(true))}
      >
        ↓
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        ×
      </button>
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
  wrap,
}: {
  projectId: number
  path: string
  content: string
  /** The tab's soft-wrap preference, threaded through for the frontmatter
   * panel alone: the prose below it wraps whatever the toggle says, so a
   * frontmatter block scrolling sideways beside it is one pane rendering under
   * two wrap rules. It is still `numbered={false}` — an excerpt has no line
   * numbers — which is the one thing that stays asked-for explicitly here. */
  wrap: boolean
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
          <FileCode content={frontmatter} language="yaml" wrap={wrap} />
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
 * highlighter build doesn't carry a grammar for).
 *
 * `numbered` puts a line-number gutter beside it (task 809) — asked for
 * explicitly rather than always, because the same component also renders a
 * markdown file's frontmatter panel, which is an excerpt rather than a file and
 * has no line numbers to speak of. The gutter is dropped while `wrap` is on for
 * the reason `CodeEditor` sets out: a soft-wrapped logical line is several
 * visual rows, so logical numbers cannot stay beside it.
 *
 * Find matches are painted as their **own inert layer over untouched Prism
 * output**, never spliced into it (task 809, slice 3). Prism's markup is a tree
 * of nested spans whose text nodes cut across match boundaries at will, so
 * inserting `<mark>`s into it by offset would mean rewriting somebody else's
 * DOM and getting every boundary right — one mistake and the colouring is
 * corrupt, silently and for that file only. A second `<pre>` of the same text
 * with the same metrics, absolutely positioned over the first with transparent
 * glyphs, cannot corrupt anything: the worst a bug in it can do is misplace a
 * background. It is the same trick, and the same alignment rules, as the
 * editor's highlight layer — which is the precedent this follows rather than
 * invents — and it is the same `FindLayer` the editor stack mounts, so the two
 * panes cannot come to disagree about what a highlight means. */
function FileCode({
  content,
  language,
  wrap = false,
  numbered = false,
  matches = [],
  current = -1,
}: {
  content: string
  language: string | null
  wrap?: boolean
  numbered?: boolean
  /** Offsets into `content`, from `fileFind.ts`. Empty means no find is
   * running, and no layer is rendered at all. */
  matches?: FindMatch[]
  /** Which of them is the one being stepped to, or -1. */
  current?: number
}) {
  const prismLanguage = prismGrammar(language)
  const code =
    prismLanguage === undefined ? (
      <pre className="files-content-text">{content}</pre>
    ) : (
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
  if (!numbered && !wrap && matches.length === 0) return code
  return (
    // Two boxes, not one: the row is sized to the file's longest line (so the
    // sticky gutter stays pinned across the whole sideways scroll) and this
    // wrapper is what scrolls it. They cannot be the same element — a
    // scroller's children are clamped to its own width — and the scroll has to
    // be caught here rather than left to the pane, or the pane's sticky
    // header/find bar/status bar, which pin vertically only, slide out from
    // under the code. See `.files-code-scroll` in App.css.
    <div className="files-code-scroll">
      <div className={`files-code-layout${wrap ? ' wrap' : ''}`}>
        {numbered && !wrap && (
          // Built from the count a <pre> actually paints, and inert to the
          // accessibility tree and to selection — copying the file must never
          // copy its line numbers.
          <pre className="files-code-gutter" aria-hidden="true">
            {gutterText(viewerLineCount(content))}
          </pre>
        )}
        <div className="files-code-main">
          {code}
          {matches.length > 0 && (
            <FindLayer
              className="files-find-layer files-content-text"
              text={content}
              matches={matches}
              current={current}
            />
          )}
        </div>
      </div>
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

/** A path's directory part, `''` at the project root — the dimmed half of a
 *  search result's heading, for the same reason a tab shows its basename: the
 *  names collide, the paths do not. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** What the panel is searching for and how, plus whether it is showing at
 *  all. The result of the last search it *ran* is separate state: the two part
 *  company the moment a character is typed, and the rows on screen must keep
 *  being highlighted against the query they were found with, not against the
 *  one being typed over it. */
interface SearchState {
  open: boolean
  query: string
  caseSensitive: boolean
  wholeWord: boolean
}

/** One completed search: the answer, and the query and options it answers —
 *  carried together so a row can never be highlighted against a query that
 *  found something else. */
interface SearchRun {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  data: ProjectFileSearch
}

/**
 * The project-wide search panel (mesa task 813) — Cmd/Ctrl+Shift+F.
 *
 * It takes the tree pane's place rather than opening over the file, so it
 * inherits that pane's width, collapse and phone-tier stacking (task 671/559)
 * and leaves the editor beside it fully visible: reading a result *is*
 * reading the file it points into.
 *
 * **The search runs on submit, not on every keystroke.** Every other query box
 * in this tab searches a string already in memory; this one is a filesystem
 * walk of the whole project, and firing one per character would have the
 * server re-reading every file under `local_path` five times for `needle`. So
 * Enter (or a toggle, which is a deliberate re-ask of the same question) is
 * what sends it, and the box says so.
 */
function SearchPanel({
  state,
  run,
  busy,
  error,
  inputRef,
  onChange,
  onSubmit,
  onOpen,
  onClose,
}: {
  state: SearchState
  /** The last completed search, or null before the first one — which is what
   * makes an empty panel silent rather than claiming "No results". */
  run: SearchRun | null
  busy: boolean
  error: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (patch: Partial<SearchState>) => void
  onSubmit: () => void
  onOpen: (path: string, line: number) => void
  onClose: () => void
}) {
  /** Do the thing, then put the caret back in the query box — the find bar's
   * rule and its reason: otherwise the next Enter re-activates the button that
   * was clicked instead of re-running the search. */
  function refocus(act: () => void): () => void {
    return () => {
      act()
      inputRef.current?.focus()
    }
  }
  const options = {
    caseSensitive: run?.caseSensitive ?? false,
    wholeWord: run?.wholeWord ?? false,
  }
  return (
    <div
      className="files-search-panel"
      // Escape is bound here rather than on `document`, and that is the whole
      // scoping: the panel sits beside the file instead of over it, so the
      // editor's own Escape (discard the edit) and the find bar's (close the
      // bar) must keep working while it is open. A React handler on this
      // wrapper answers the key exactly when focus is inside the panel.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onClose()
      }}
    >
      <div className="files-search-bar">
        <input
          autoFocus
          ref={inputRef}
          className="files-search-input"
          value={state.query}
          maxLength={MAX_SEARCH_QUERY}
          placeholder="Search project"
          spellCheck={false}
          aria-label="Search in project files"
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            onSubmit()
          }}
        />
        <button
          type="button"
          className="files-find-toggle"
          aria-pressed={state.caseSensitive}
          title="Match case"
          onClick={refocus(() => onChange({ caseSensitive: !state.caseSensitive }))}
        >
          Aa
        </button>
        <button
          type="button"
          className="files-find-toggle"
          aria-pressed={state.wholeWord}
          title="Whole word"
          onClick={refocus(() => onChange({ wholeWord: !state.wholeWord }))}
        >
          |ab|
        </button>
        <button
          type="button"
          className="files-find-toggle"
          aria-label="Close search"
          title="Close (Escape)"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="files-search-summary muted">
        {busy ? 'Searching…' : (searchSummary(run?.data ?? null) || 'Press Enter to search')}
      </p>
      {error !== null && <p className="error">{error}</p>}
      {run !== null && (
        <ul className="files-search-results">
          {run.data.files.map((file) => (
            <li key={file.path} className="files-search-group">
              {/* The heading opens the file at its first hit — the same thing
                  a tree row does, with a line to land on. */}
              <button
                type="button"
                className={`files-search-file ${accentClass(file.language)}`}
                title={file.path}
                onClick={() => onOpen(file.path, file.matches[0]?.line ?? 1)}
              >
                <span className="files-search-file-name">{basename(file.path)}</span>
                <span className="files-search-file-dir">{dirname(file.path)}</span>
                <span className="files-search-file-count">
                  {file.matches.length}
                  {file.truncated ? '+' : ''}
                </span>
              </button>
              <ul>
                {file.matches.map((match, i) => (
                  // Index in the key because a file legitimately holds two
                  // hits on one line — that is two rows, not one.
                  <li key={`${match.line}-${i}`}>
                    <button
                      type="button"
                      className="files-search-hit"
                      onClick={() => onOpen(file.path, match.line)}
                    >
                      <span className="files-search-hit-line">{match.line}</span>
                      <span className="files-search-hit-text">
                        {/* Highlighted by re-running the same literal scan the
                            find bar uses, never by offsets off the wire —
                            `fileSearch.ts` says why. */}
                        {snippetSegments(match.text, run.query, options).map((seg, s) =>
                          seg.match < 0 ? (
                            <span key={s}>{seg.text}</span>
                          ) : (
                            <mark key={s} className="files-search-mark">
                              {seg.text}
                            </mark>
                          ),
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
  dirty,
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
  /** Paths with unsaved edits, from `fileDirty.ts` — the whole tab's set, not
   * this strip's, since a path may be open in both. */
  dirty: ReadonlySet<string>
  onActivate: (path: string) => void
  /** *Requests* a close: a dirty tab's is answered by the confirm bar rather
   * than by the tab going away (`FilesView.requestClose`). */
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
          title={tabLabel(path, dirty.has(path))}
          draggable
          className={`files-tab ${accentClass(languageOfName(basename(path)))}${
            path === active ? ' active' : ''
          }${dirty.has(path) ? ' dirty' : ''}${
            mark !== null && mark.side === side && mark.index === i ? ' drop-before' : ''
          }`}
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
            // The visible text is the basename, which collides constantly; the
            // accessible name is the full path plus, when it applies, the
            // unsaved-changes state the dot beside it shows sighted users.
            aria-label={tabLabel(path, dirty.has(path))}
            onClick={() => onActivate(path)}
          >
            {basename(path)}
          </button>
          {/* The editor convention: a dirty tab wears a dot where its × goes,
              and hovering (or tabbing into) the tab swaps the two back — CSS
              alone, App.css, since both elements are always rendered and only
              one is ever shown. */}
          {dirty.has(path) && (
            <span className="files-tab-dirty" aria-hidden="true">
              ●
            </span>
          )}
          <button
            type="button"
            className="files-tab-close"
            aria-label={closeLabel(path, dirty.has(path))}
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

/**
 * The prompt a dirty tab's close puts up instead of going away (task 809).
 *
 * Deliberately the house two-step pattern, not `window.confirm`: mesa's
 * confirmations are inline and non-modal everywhere else, and a native dialog
 * here would also be the only thing in the app able to block the render loop.
 *
 * It reuses `ConfirmDelete`'s *classes* (`.confirm-delete`/`.confirm-message`,
 * the red confirm button) but not the component. `ConfirmDelete` owns its own
 * trigger — a labelled `danger` button that arms on the first click — and takes
 * an async `onDelete` whose rejection it renders. Here the trigger already
 * exists (the tab's ×, plus middle-click and Alt+W, three ways into the same
 * state), the armed state must survive being raised from any of them, and
 * closing a tab is synchronous local state that cannot fail. Wrapping that in a
 * component built to own a button and await a promise would mean fighting both
 * halves of it.
 *
 * The wording names what is lost rather than asking a yes/no question, and the
 * discarding button is the red one: this is the one place in the Files tab
 * where a click destroys work that was never on disk.
 */
function CloseConfirmBar({
  path,
  onDiscard,
  onCancel,
}: {
  path: string
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="files-close-confirm confirm-delete"
      role="alert"
      // Escape is the universal cancel, and this is the one modal-ish prompt in
      // the tab — without it the bar answered Enter (the autofocused "keep
      // editing") and nothing else, since the find bar's document-level Escape
      // is scoped to view mode. It resolves the safe way, so there is no
      // precedence question with the editor underneath; the event is stopped
      // all the same, because that editor's own Escape discards the draft this
      // bar exists to protect.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <span className="confirm-message">
        {basename(path)} has unsaved changes.
      </span>
      <button className="danger" onClick={onDiscard}>
        discard and close
      </button>
      {/* Autofocused so the keyboard route in (Alt+W) has a keyboard route
          back out, and so Enter answers the safe way. */}
      <button autoFocus onClick={onCancel}>
        keep editing
      </button>
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
  dirty,
  pendingClose,
  fileUi,
  onUi,
  wrap,
  onWrapChange,
  landing,
  onFocus,
  onActivate,
  onClose,
  onConfirmClose,
  onCancelClose,
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
  dirty: ReadonlySet<string>
  /** The path in *this* pane awaiting a discard/keep answer, if any. */
  pendingClose: string | null
  fileUi: Map<string, FileUiState>
  onUi: (path: string, patch: Partial<FileUiState>) => void
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  /** The project-search result to land on, if it names a file this pane has
   * open (task 813). Handed to whichever pane is showing that path rather than
   * to a chosen side: the same file can be open in both, and both should show
   * the reader the line they clicked. */
  landing: SearchLanding | null
  onFocus: () => void
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onConfirmClose: () => void
  onCancelClose: () => void
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
        dirty={dirty}
        onActivate={onActivate}
        onClose={onClose}
        onSplit={onSplit}
        onDragBegin={onDragBegin}
        onDragFinish={onDragFinish}
        onDragOverStrip={onDragOverStrip}
        onDropOnStrip={onDropOnStrip}
        onDragLeaveStrip={onDragLeaveStrip}
      />
      {/* Under the strip rather than over the file: it answers a click on a
          tab, and pushing the content down is what makes it impossible to
          miss. */}
      {pendingClose !== null && (
        <CloseConfirmBar
          path={pendingClose}
          onDiscard={onConfirmClose}
          onCancel={onCancelClose}
        />
      )}
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
            wrap={wrap}
            onWrapChange={onWrapChange}
            focused={focused}
            landing={landing?.path === active ? landing : null}
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
  // Soft wrap (mesa task 809), persisted globally for the Files tab like the
  // tree width above. Held here rather than per pane so a split, and every tab
  // in it, reads code the same way — the toggle in one pane's status bar is a
  // statement about the tab, not about that file.
  const [wrap, setWrap] = useState(loadWordWrap)
  // Project-wide search (mesa task 813): what the panel is asking, the last
  // answer it got, and whether one is in flight. Component state with the
  // tab's lifetime — nothing about a search is persisted or deep-linked, the
  // same posture the find bar takes one file down.
  const [search, setSearch] = useState<SearchState>({
    open: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
  })
  const [searchRun, setSearchRun] = useState<SearchRun | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // Which request the panel is still interested in. A search is a filesystem
  // walk, so a slow one can land after a later, narrower one — and the answer
  // to the older question overwriting the newer one is the classic version of
  // this bug.
  const searchSeq = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Where the caret goes when the panel closes: a real control that outlives
  // it. Closing without a hand-off drops focus on <body>, which is the same
  // trap `closeFind` documents.
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  // The result being opened, if any — handed to whichever pane holds that file
  // so it can reveal the line (`SearchLanding`). Its `seq` is what makes a
  // second click on the same result land again.
  const [landing, setLanding] = useState<SearchLanding | null>(null)
  const landingSeq = useRef(0)
  // The tab whose close is waiting on a discard/keep answer (task 809, slice
  // 4), or null. One at a time and identified by pane *and* path, since the
  // same file can be open in both panes of a split and only one of the two
  // closes is the one being asked about.
  const [pendingClose, setPendingClose] = useState<{
    side: PaneSide
    path: string
  } | null>(null)
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

  // Which open files hold work that is not on disk. Derived, never stored: it
  // is a function of the drafts `fileUi` already carries, and a second copy
  // would be a second thing to keep true.
  const dirty = useMemo(() => dirtyPaths(fileUi), [fileUi])

  // Warn on a real page unload while any tab is dirty — a reload or a close is
  // the one exit this app cannot intercept and put a confirm bar in front of.
  // Armed and disarmed by the effect's own lifetime rather than by a flag
  // inside the handler, so a clean tab set genuinely has no listener attached
  // (a permanently registered `beforeunload` is also what disables the
  // browser's back/forward cache).
  //
  // Keyed on *whether* anything is dirty, not on the set: `fileUi` is a fresh
  // `Map` per keystroke, so `dirty` is a fresh `Set` per character typed and
  // listing it tore the listener down and put it back on every one of them —
  // which is also the one window in which the claim above is false.
  const anyDirty = dirty.size > 0
  useEffect(() => {
    if (!anyDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // The browser writes the prompt; a page-supplied string has been ignored
      // for years. `preventDefault` is the whole API that is left.
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [anyDirty])

  // The Files tab's tab-management chords (task 809, slice 4).
  //
  // **Not Cmd/Ctrl+W.** That chord closes the browser tab and no page can
  // intercept it — Chrome and Safari deliver it to the browser, not to the
  // document — so binding it would ship a shortcut that works nowhere and
  // loses the window. Alt+W is the closest thing that is actually the page's
  // to take, and Alt+[ / Alt+] cycle, in place of Ctrl+Tab and
  // Cmd/Ctrl+Shift+[ / ], which are browser-tab switching for the same reason.
  //
  // Matched on `e.code`, not `e.key`: Alt+W on macOS *is* the character `∑`,
  // and Alt+[ is `“` — the physical key is the only stable thing about these.
  // `preventDefault` fires only once a binding has actually decided to act, so
  // an Alt chord this tab does nothing with still reaches whatever else wants
  // it.
  //
  // Which is the trade, and it is paid in the editor: `shouldIgnoreFilesShortcut`
  // deliberately does NOT stand down in `.files-content-editor` — closing or
  // cycling the file you are editing is what these are for — so with the caret in
  // the code `∑`, `“` and `‘` do not type. Alt is the only chord space this page
  // owns (Cmd/Ctrl+W and Ctrl+Tab are the browser's), and a curly quote lost in a
  // code editor is the smaller loss; `docs/keyboard.md` names it rather than
  // claiming the characters survive everywhere. The find bar's own query box is
  // the one control these stand down in (`'tabs'`, not `'find'`): closing or
  // cycling a tab unmounts that input while it holds focus, and unlike
  // `closeFind` there is nowhere to hand the caret — the pane that would take it
  // is about to be remounted.
  //
  // No dependency array, for the same reason the find effect above has none:
  // the handler closes over the live tabs and dirty set, and listing them is
  // listing most of this component's state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      const side = tabs.focused
      if (e.code === 'KeyW') {
        const active = paneOf(tabs, side)?.active
        if (active == null || shouldIgnoreFilesShortcut(e, 'tabs')) return
        e.preventDefault()
        requestClose(side, active)
        return
      }
      if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return
      const forward = e.code === 'BracketRight'
      // Asked before claiming the key: a pane with nothing to step to leaves
      // the chord alone rather than swallowing it to do nothing.
      if (cycleTab(tabs, side, forward) === null) return
      if (shouldIgnoreFilesShortcut(e, 'tabs')) return
      e.preventDefault()
      commit((prev) => cycleTab(prev, side, forward))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Cmd/Ctrl+Shift+F — the project-search chord (mesa task 813).
  //
  // This is the chord the in-file find bar deliberately let go: Cmd/Ctrl+F
  // excludes Shift because "find in files" is what Cmd/Ctrl+Shift+F means
  // everywhere it is bound, and the tab had no such surface to open. It has
  // one now, so the tab claims the key it was already declining to misuse —
  // and `docs/keyboard.md` moved with it.
  //
  // Bound on `FilesView` rather than on a pane, unlike Cmd/Ctrl+F: the panel
  // belongs to the tab, not to a file, so there is no focused-pane condition
  // and nothing to race in a split. Escape is NOT bound here — it belongs to
  // whatever has focus (the editor's discard, the find bar's close), and the
  // panel answers it from its own subtree instead.
  //
  // No dependency array, for the reason the tab chords' listener above states.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      if (shouldIgnoreFilesShortcut(e, 'search')) return
      e.preventDefault()
      openSearch()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Select the query on a fresh open, the same reflex — and for the same
  // reason — as the find bar's twin of this effect: the input does not exist
  // until React has rendered the panel, and a re-open keeps the last query,
  // which `autoFocus` would focus without selecting.
  useEffect(() => {
    if (search.open) searchInputRef.current?.select()
  }, [search.open])

  // Persist the open set (never `fileUi`). Every tabs write funnels through
  // `commit()`, so this one effect covers open/close/activate/focus/split/
  // move/ratio — no save calls sprinkled through the handlers.
  useEffect(() => saveOpenFiles(projectId, tabs), [projectId, tabs])

  // Reset on project change (render-time, off the changed prop — same
  // pattern as GitView/HistoryPane): this component isn't remounted when the
  // route moves between projects, so a stale selection from project A must
  // not leak into project B. Tabs are the one thing that *restores* rather
  // than empties — the new project's own remembered set, never A's.
  //
  // This drops any unsaved draft with it, unprompted, and so does leaving the
  // Files tab (which unmounts this component). That is a real limit on what the
  // dirty dot promises and it is deliberate rather than pending: by the time
  // this runs the route has already moved, and the app has no navigation guard
  // to hold it — the nav click is in another component and the tab strip's
  // confirm bar belongs to a pane that is about to show project B's files.
  // Carrying the drafts across instead would be worse: `fileUi` is keyed by a
  // path relative to the project, so the same `src/main.rs` in two projects
  // would inherit the other one's unsaved text. What the dot does cover is
  // stated in docs/files-tab.md, and it is the three exits this component
  // actually owns: the tab's ×, a middle-click, Alt+W — plus `beforeunload`
  // for a reload or a window close.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setOpen({ tabs: loadOpenFiles(projectId, narrow), fileUi: new Map() })
    setExpanded(new Set())
    setChildrenCache(new Map())
    setTreeOpen(true)
    setNewFileParent(null)
    setNewFileError(null)
    setPendingClose(null)
    // A search is about one project's tree, and so is the result open on
    // screen; both are meaningless against the next one. The query itself goes
    // with them rather than being carried over, since the panel would
    // otherwise show project A's hits under project B's name until the next
    // Enter. Bumping `searchSeq` is what stops an in-flight walk of A from
    // landing in B.
    searchSeq.current++
    setSearch({ open: false, query: '', caseSensitive: false, wholeWord: false })
    setSearchRun(null)
    setSearchBusy(false)
    setSearchError(null)
    setLanding(null)
  }

  // Drop a pending close whose reason has gone — the file was saved from the
  // pane underneath the bar, the tab was dragged to the other pane, or the
  // other pane opened the same file so closing this one discards nothing.
  // Hiding the bar (which `paneProps` does by re-asking the same predicate) is
  // NOT clearing it: `needsCloseConfirm` is not monotonic, so a tab that goes
  // clean and then dirty again would re-mount a prompt nobody raised — and its
  // "keep editing" button is autofocused, so it would pull the caret out of the
  // code mid-keystroke. `requestClose` is the only thing that arms this, and
  // this is the only thing that disarms it without an answer.
  if (
    pendingClose !== null &&
    !needsCloseConfirm(tabs, pendingClose.side, pendingClose.path, dirty)
  ) {
    setPendingClose(null)
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

  /**
   * The one way a tab is closed — the × , a middle-click and Alt+W all land
   * here (task 809, slice 4).
   *
   * `closeTab` discards the draft with the tab, deliberately and with no
   * confirmation (`fileTabs.ts`, and the app's no-prompt posture generally).
   * That is right for a clean tab and wrong for unsaved work, so this is the
   * one close that stops to ask — and only when the answer matters:
   * `needsCloseConfirm` says no for a clean tab, and no for a dirty file the
   * other pane still holds, where nothing is discarded at all.
   */
  function requestClose(side: PaneSide, path: string) {
    if (needsCloseConfirm(tabs, side, path, dirty)) {
      setPendingClose({ side, path })
      return
    }
    setPendingClose(null)
    commit((prev) => closeTab(prev, side, path))
  }

  /** "discard and close" — the prompt's one destructive answer. */
  function confirmClose() {
    const pending = pendingClose
    if (pending === null) return
    setPendingClose(null)
    commit((prev) => closeTab(prev, pending.side, pending.path))
  }

  /** Cmd/Ctrl+Shift+F, and the tree pane's Search toggle.
   *
   * On an already-open panel it is "let me retype that" — a `focus()` *and* a
   * `select()`, the pair `openFind` documents: `select()` alone sets a range
   * without moving focus, and this chord is deliberately claimed from the
   * editor, where the characters typed next would otherwise land in the file.
   *
   * Opening also undoes whatever is hiding the pane the panel appears in: the
   * wide tier's collapse and the phone tier's `treeOpen`. A shortcut that
   * opened a surface the user cannot see would read as doing nothing. */
  function openSearch() {
    setTreeCollapsed(false)
    saveFilesTreeCollapsed(false)
    setTreeOpen(true)
    if (search.open) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    setSearch((prev) => ({ ...prev, open: true }))
  }

  /** Closing keeps the query and the results — the panel reopens where it was,
   *  the same promise `closeFind` makes one file down — and hands the caret to
   *  the toggle that reopens it, rather than dropping it on `<body>`. */
  function closeSearch() {
    setSearch((prev) => ({ ...prev, open: false }))
    searchToggleRef.current?.focus()
  }

  /** Run the search: Enter in the box, or a toggle click (a deliberate re-ask
   *  of the same question). Never a keystroke — see `SearchPanel`.
   *
   *  `next` is passed in rather than read from state because a toggle click
   *  runs the search for the value it is *setting*, not the one on screen —
   *  the same reason `runFind` recomputes instead of reading its render's
   *  matches. */
  function runSearch(next: SearchState) {
    const query = searchRequestQuery(next.query)
    if (query === null) {
      setSearchRun(null)
      setSearchError(null)
      return
    }
    const seq = ++searchSeq.current
    setSearchBusy(true)
    setSearchError(null)
    const options = {
      caseSensitive: next.caseSensitive,
      wholeWord: next.wholeWord,
    }
    searchProjectFiles(projectId, query, options).then(
      (data) => {
        // A walk that lands after a later one asked a different question is
        // an answer nobody is waiting for.
        if (seq !== searchSeq.current) return
        setSearchBusy(false)
        setSearchRun({ query, ...options, data })
      },
      (e) => {
        if (seq !== searchSeq.current) return
        setSearchBusy(false)
        setSearchError(e instanceof ApiError ? e.message : 'Search failed.')
      },
    )
  }

  /** A result clicked: open the file the way the tree opens one, and hand the
   *  pane that gets it the line to land on (`SearchLanding`). */
  function openResult(path: string, line: number) {
    commit((prev) => openFile(prev, path))
    setLanding({
      seq: ++landingSeq.current,
      path,
      line,
      query: searchRun?.query ?? '',
      caseSensitive: searchRun?.caseSensitive ?? false,
      wholeWord: searchRun?.wholeWord ?? false,
    })
    // Same reason a tree click does it: on the phone tier the pane and the
    // file are stacked, so leaving the panel up pushes the file below the
    // fold. Inert above 600px, where both are on screen at once.
    setTreeOpen(false)
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

  // Written through on every flip rather than in an effect: this is one
  // deliberate click, and storage should carry exactly what the status bar
  // shows.
  function toggleWrap(next: boolean) {
    setWrap(next)
    saveWordWrap(next)
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
      dirty,
      // Re-asked every render rather than trusted: the prompt must vanish by
      // itself if its own reason does — the file gets saved from the pane
      // underneath, the tab is dragged to the other pane, or the other pane
      // opens the same file and closing this one stops discarding anything.
      // The same predicate that raised it is the one that keeps it up.
      pendingClose:
        pendingClose?.side === side &&
        needsCloseConfirm(tabs, side, pendingClose.path, dirty)
          ? pendingClose.path
          : null,
      fileUi,
      onUi: patchUi,
      wrap,
      onWrapChange: toggleWrap,
      landing,
      onFocus: () => commit((prev) => focusPane(prev, side)),
      onActivate: (path: string) => commit((prev) => activateTab(prev, side, path)),
      onClose: (path: string) => requestClose(side, path),
      onConfirmClose: confirmClose,
      onCancelClose: () => setPendingClose(null),
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
            {/* The mouse route to the same panel Cmd/Ctrl+Shift+F opens, and
                the control the panel hands the caret back to when it closes.
                Rendered whether or not the panel is open, so that hand-off
                always has somewhere to go. */}
            <button
              type="button"
              ref={searchToggleRef}
              className="files-tree-search-toggle"
              aria-pressed={search.open}
              aria-label="Search in project files"
              title="Search in project files (Cmd/Ctrl+Shift+F)"
              onClick={() => (search.open ? closeSearch() : openSearch())}
            >
              ⌕
            </button>
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
          {/* The panel takes the tree's place rather than opening over the
              file (mesa task 813): it inherits this pane's width, collapse
              and phone-tier stack, and leaves the file it points into fully
              visible beside it. The tree is unmounted while it is up, so the
              two can never scroll past each other in one column — reopening
              the tree costs nothing, since `childrenCache` outlives this. */}
          {search.open ? (
            <SearchPanel
              state={search}
              run={searchRun}
              busy={searchBusy}
              error={searchError}
              inputRef={searchInputRef}
              onChange={(patch) => {
                const next = { ...search, ...patch }
                setSearch(next)
                // A toggle is a deliberate re-ask of the same question, so it
                // re-runs immediately — but only once there is a query to
                // re-ask, and never for typing, which is what `onSubmit` is.
                if (patch.query === undefined && searchRun !== null) runSearch(next)
              }}
              onSubmit={() => runSearch(search)}
              onOpen={openResult}
              onClose={closeSearch}
            />
          ) : (
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
          )}
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
