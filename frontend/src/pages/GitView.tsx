import { useState } from 'react'
import {
  getProjectGit,
  getProjectGitCommitDiff,
  getProjectGitCommitFiles,
  getProjectGitDiff,
  getProjectGitLog,
} from '../api'
import type { GitCommit } from '../types/GitCommit'
import type { GitCommitFile } from '../types/GitCommitFile'
import type { GitFile } from '../types/GitFile'
import { useFetch } from '../useFetch'

// Human word for one porcelain-v2 status char. X = staged column,
// Y = unstaged column, '.' = unchanged in that column.
const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'conflict',
}

/** "MM" → "modified (staged), modified (unstaged)"; "??" → "untracked";
 * any unknown char → the raw pair verbatim. */
function statusLabel(status: string): string {
  if (status === '??') return 'untracked'
  const parts: string[] = []
  const columns: [string | undefined, string][] = [
    [status[0], 'staged'],
    [status[1], 'unstaged'],
  ]
  for (const [c, column] of columns) {
    if (c === undefined || c === '.') continue
    const word = STATUS_WORDS[c]
    if (word === undefined) return status
    parts.push(`${word} (${column})`)
  }
  return parts.length > 0 ? parts.join(', ') : status
}

/** Per-commit status label: a single name-status token (`A`/`M`/`D`/`T`/`U`/
 * `X`, or `R100`/`C100` with a similarity score) — a commit has no staged/
 * unstaged distinction, so this is a small sibling of statusLabel, not a
 * call to it verbatim. */
function commitStatusLabel(status: string): string {
  const word = STATUS_WORDS[status[0]]
  return word ?? status
}

/** CSS class for one unified-diff line, by prefix. File headers (---/+++)
 * and other metadata (diff --git, index, mode/rename lines, "Binary files
 * ... differ", "\ No newline...") are checked before the one-char +/-
 * content prefixes they would otherwise match. */
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk'
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('Binary files ') ||
    line.startsWith('\\')
  )
    return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-ctx'
}

/** Renders a unified diff, color-coded per line. Diff text is untrusted
 * data: each line is rendered as a plain text node inside a <span> in the
 * <pre> — classified by prefix for CSS only, never interpreted as markup
 * (spec M11). Binary files carry git's own "Binary files ... differ" line
 * as the diff text, which serves as the notice (S3). Shared by the
 * working-tree DiffPane and the per-commit CommitDiffPane below (M3: same
 * diff-line classification, reused verbatim). */
function DiffText({ diff }: { diff: string }) {
  if (diff === '') return <p className="muted">No diff.</p>
  return (
    <pre className="git-diff-text">
      {diff.split('\n').map((line, i) => (
        <span key={i} className={diffLineClass(line)}>
          {line + '\n'}
        </span>
      ))}
    </pre>
  )
}

/** The selected working-tree file's unified diff vs HEAD. */
function DiffPane({ projectId, path }: { projectId: number; path: string }) {
  const { data, error } = useFetch(
    () => getProjectGitDiff(projectId, path),
    `git-diff-${projectId}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return <DiffText diff={data.diff} />
}

/** The selected file's unified diff as introduced by one commit. Sibling of
 * DiffPane: same rendering, fetched via `git show <sha> -- path` instead of
 * against the working tree. */
function CommitDiffPane({
  projectId,
  sha,
  path,
}: {
  projectId: number
  sha: string
  path: string
}) {
  const { data, error } = useFetch(
    () => getProjectGitCommitDiff(projectId, sha, path),
    `git-commit-diff-${projectId}-${sha}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return <DiffText diff={data.diff} />
}

function fileLabel(f: GitFile): string {
  // Rename/copy lines carry the source path: show "orig → path".
  return f.orig_path !== null ? `${f.orig_path} → ${f.path}` : f.path
}

function commitFileLabel(f: GitCommitFile): string {
  // Same rename display convention as fileLabel.
  return f.orig_path !== null ? `${f.orig_path} → ${f.path}` : f.path
}

/** Same "no linked folder" copy for both Working-tree and History modes
 * (M9) — factored out once so the two ladders can't drift. */
function NoLocalPathPlaceholder({ projectId }: { projectId: number }) {
  return (
    <div className="git-placeholder muted">
      <p>
        This project has no linked folder, so mesa cannot see its git
        status. Run <code>mesa project resolve</code> inside the repo, or{' '}
        <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
        link one.
      </p>
    </div>
  )
}

/** Same "not a repo" copy for both Working-tree and History modes (M9). */
function NotARepoPlaceholder({ path }: { path: string }) {
  return (
    <div className="git-placeholder muted">
      <p>
        <code>{path}</code> is not a git repository (or the folder no
        longer exists).
      </p>
    </div>
  )
}

/**
 * The changed-file list for one selected commit, with a "back to commits"
 * affordance. Reuses the same card-list row shape as the working-tree file
 * list, with commitStatusLabel/commitFileLabel in place of statusLabel/
 * fileLabel (M2).
 */
function CommitFileList({
  projectId,
  commit,
  selectedPath,
  onSelectPath,
  onBack,
}: {
  projectId: number
  commit: GitCommit
  selectedPath: string | null
  onSelectPath: (path: string) => void
  onBack: () => void
}) {
  const { data, error } = useFetch(
    () => getProjectGitCommitFiles(projectId, commit.hash),
    `git-commit-files-${projectId}-${commit.hash}`,
  )
  return (
    <div className="git-file-list">
      <button type="button" className="git-back" onClick={onBack}>
        ← Commits
      </button>
      <p className="git-commit-summary">
        <span className="badge git-status-badge">{commit.short_hash}</span>{' '}
        {commit.subject}
      </p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.length === 0 && (
        <p className="muted">This commit changed no files.</p>
      )}
      {data && data.length > 0 && (
        <ul className="card-list">
          {data.map((f) => (
            <li
              key={f.path}
              className={f.path === selectedPath ? 'selected' : ''}
              onClick={() => onSelectPath(f.path)}
            >
              <span className="badge git-status-badge">{f.status}</span>
              <span className="git-file-path">{commitFileLabel(f)}</span>
              <div className="muted git-file-label">
                {commitStatusLabel(f.status)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The History sub-view: commit list → changed files → diff, in the same
 * two-column git-layout the Working-tree mode uses. Fetches the commit log
 * lazily (only once mounted, i.e. only once History mode is first opened —
 * GitView conditionally mounts this component). Empty-state ladder mirrors
 * ProjectGitView's exactly, one level deeper (M9).
 */
function HistoryPane({ projectId }: { projectId: number }) {
  const { data: log, error: logError } = useFetch(
    () => getProjectGitLog(projectId),
    `git-log-${projectId}`,
  )
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)
  const [selectedCommitPath, setSelectedCommitPath] = useState<string | null>(
    null,
  )
  // Same prevProject-during-render reset pattern as GitView itself: this
  // component is not remounted on project change while History mode stays
  // open, so a stale commit selection from project A must not leak into B.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedCommit(null)
    setSelectedCommitPath(null)
  }

  if (logError && !log) return <p className="error">{logError}</p>
  if (!log) return <p className="muted">Loading…</p>

  // Quiet empty states (M9) — data shapes, not errors.
  if (log.path === null) return <NoLocalPathPlaceholder projectId={projectId} />
  if (log.commits === null) return <NotARepoPlaceholder path={log.path} />
  if (log.commits.length === 0) return <p className="muted">No commits yet.</p>

  return (
    <div className="git-layout">
      {selectedCommit === null ? (
        <ul className="card-list git-file-list">
          {log.commits.map((c) => (
            <li key={c.hash} onClick={() => setSelectedCommit(c)}>
              <span className="badge git-status-badge">{c.short_hash}</span>
              <span className="git-file-path">{c.subject}</span>
              <div className="muted git-file-label">
                {c.author} · {c.date}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <CommitFileList
          projectId={projectId}
          commit={selectedCommit}
          selectedPath={selectedCommitPath}
          onSelectPath={setSelectedCommitPath}
          onBack={() => {
            setSelectedCommit(null)
            setSelectedCommitPath(null)
          }}
        />
      )}
      <div className="git-diff-pane">
        {selectedCommit !== null && selectedCommitPath !== null ? (
          <CommitDiffPane
            projectId={projectId}
            sha={selectedCommit.hash}
            path={selectedCommitPath}
          />
        ) : (
          <p className="muted">
            {selectedCommit === null
              ? 'Select a commit to see its changed files.'
              : 'Select a file to see its diff.'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The GIT tab: working-tree status of the project's linked folder — branch +
 * ahead/behind header, changed/untracked file list on the left, the selected
 * file's diff on the right — plus a History sub-view (commit list → changed
 * files → diff) reachable via a toggle, without leaving the tab (M1/S2).
 * Rendered in place inside ProjectTasksPage's frame, like AgentsView.
 * Read-only; refetches on window focus (no poll — git state changes from
 * terminal work outside the app, and the server caches the status call for
 * 5s anyway).
 */
export function GitView({ projectId }: { projectId: number }) {
  const { data, error } = useFetch(
    () => getProjectGit(projectId),
    `git-${projectId}`,
  )
  // Selected path is component state, not URL (no deep-linking a file).
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Working tree | History — default Working tree (today's behavior,
  // unchanged, S2). History mode is a small component that's only mounted
  // once selected, so its commit-log fetch is lazy for free.
  const [mode, setMode] = useState<'tree' | 'history'>('tree')
  // This component is not remounted when the route moves between projects
  // (App renders ProjectTasksPage at a stable position), so a stale selection
  // would carry project A's file into project B. Reset it when the project
  // changes — during render, off the changed prop (AgentsView pattern).
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedPath(null)
  }

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  // Quiet empty states (M5) — data shapes, not errors.
  if (data.path === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (data.repo === null) {
    return <NotARepoPlaceholder path={data.path} />
  }

  const { status, files } = data.repo
  // Selection survives refetches by path; a file that left the list (e.g.
  // committed from a terminal) simply drops back to "select a file" instead
  // of fetching a diff the server would now 404.
  const selected =
    selectedPath !== null
      ? (files.find((f) => f.path === selectedPath) ?? null)
      : null

  return (
    <div className="git-view">
      <p className="git-repo-header">
        <span className="git-branch">{status.branch}</span>
        {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {status.behind > 0 && (
          <span className="git-behind">↓{status.behind}</span>
        )}
        <span className="muted git-repo-path">{data.path}</span>
      </p>

      <div className="git-mode-toggle">
        <button
          type="button"
          className={mode === 'tree' ? 'active' : ''}
          onClick={() => setMode('tree')}
        >
          Working tree
        </button>
        <button
          type="button"
          className={mode === 'history' ? 'active' : ''}
          onClick={() => setMode('history')}
        >
          History
        </button>
      </div>

      {mode === 'history' ? (
        <HistoryPane projectId={projectId} />
      ) : files.length === 0 ? (
        <p className="muted">Working tree clean — no changed files.</p>
      ) : (
        <div className="git-layout">
          <ul className="card-list git-file-list">
            {files.map((f) => (
              <li
                key={f.path}
                className={f.path === selectedPath ? 'selected' : ''}
                onClick={() => setSelectedPath(f.path)}
              >
                <span className="badge git-status-badge">{f.status}</span>
                <span className="git-file-path">{fileLabel(f)}</span>
                <div className="muted git-file-label">{statusLabel(f.status)}</div>
              </li>
            ))}
          </ul>
          <div className="git-diff-pane">
            {selected !== null ? (
              <DiffPane projectId={projectId} path={selected.path} />
            ) : (
              <p className="muted">Select a file to see its diff.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
