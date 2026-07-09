import { useState } from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus'
import { Markdown } from '../components/Markdown'
import { getProjectFiles, getProjectFilesContent } from '../api'
import type { FileTreeEntry } from '../types/FileTreeEntry'
import { useFetch } from '../useFetch'

// Registered once at module load. PrismLight (the sync "light" build) ships
// no language grammar unless registered and has no fallback-fetch for
// unregistered ones (unlike PrismAsyncLight, whose per-language dynamic
// imports pull Prism's entire ~290-language catalog into the build output),
// so the bundle only grows by the ~15 languages this file's own
// EXTENSION_LANGUAGE table can actually produce.
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('c', c)
SyntaxHighlighter.registerLanguage('cpp', cpp)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('ruby', ruby)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('toml', toml)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('yaml', yaml)

// Our EXTENSION_LANGUAGE tag -> the Prism grammar name it's registered under
// above (mostly identical; a few Prism names differ from our tags).
const PRISM_LANGUAGE: Record<string, string> = {
  rust: 'rust',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  shell: 'bash',
  html: 'markup',
  css: 'css',
  go: 'go',
  ruby: 'ruby',
  c: 'c',
  cpp: 'cpp',
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
  go: 'go',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
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
 * and binary/truncation indicators in place of raw/garbled bytes (M5/M6). */
function ContentPane({
  projectId,
  path,
}: {
  projectId: number
  path: string
}) {
  const { data, error } = useFetch(
    () => getProjectFilesContent(projectId, path),
    `files-content-${projectId}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

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
      </p>
      {data.is_binary ? (
        <p className="muted">Binary file — cannot display.</p>
      ) : data.language === 'markdown' ? (
        <div className="files-markdown-body">
          <Markdown text={data.content} />
        </div>
      ) : (
        <FileCode content={data.content} language={data.language} />
      )}
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
  const prismLanguage = PRISM_LANGUAGE[language ?? '']
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

/** One tree row (directory or file), recursing into an expanded directory's
 * children. Returns a fragment of sibling <li>s so it drops straight into
 * the parent <ul> with no extra wrapper element. */
function TreeNode({
  entry,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelectFile,
}: {
  entry: FileTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
}) {
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  if (entry.is_dir) {
    const isOpen = expanded.has(entry.path)
    return (
      <>
        <li
          className="files-tree-dir"
          style={indent}
          onClick={() => onToggle(entry.path)}
        >
          <span className={`files-tree-toggle ${isOpen ? 'open' : ''}`}>
            {isOpen ? '▾' : '▸'}
          </span>
          {entry.name}
        </li>
        {isOpen &&
          (entry.children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
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
 * expandable per directory, with the selected file's content on the right —
 * read-only, no edit/save/delete affordance anywhere (M11). Rendered in
 * place inside ProjectTasksPage's frame, like GitView/AgentsView. Empty
 * states are quiet placeholders, matching the Git/Agents tabs' ladder, never
 * a hard error (M10).
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
  // Reset on project change (render-time, off the changed prop — same
  // pattern as GitView/HistoryPane): this component isn't remounted when the
  // route moves between projects, so a stale selection from project A must
  // not leak into project B.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedPath(null)
    setExpanded(new Set())
  }

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
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
          <ul className="files-tree">
            {data.tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                selectedPath={selectedPath}
                onSelectFile={setSelectedPath}
              />
            ))}
          </ul>
          <div className="files-content-pane">
            {selectedPath !== null ? (
              <ContentPane projectId={projectId} path={selectedPath} />
            ) : (
              <p className="muted">Select a file to see its content.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
