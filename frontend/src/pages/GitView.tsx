import { useState } from 'react'
import { getProjectGit, getProjectGitDiff } from '../api'
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

/** The selected file's unified diff. Diff text is untrusted data: it is
 * rendered as a plain text node inside <pre> only — never interpreted as
 * markup (spec M11). Binary files carry git's own "Binary files ... differ"
 * line as the diff text, which serves as the notice (S3). */
function DiffPane({ projectId, path }: { projectId: number; path: string }) {
  const { data, error } = useFetch(
    () => getProjectGitDiff(projectId, path),
    `git-diff-${projectId}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  if (data.diff === '') return <p className="muted">No diff.</p>
  return <pre className="git-diff-text">{data.diff}</pre>
}

function fileLabel(f: GitFile): string {
  // Rename/copy lines carry the source path: show "orig → path".
  return f.orig_path !== null ? `${f.orig_path} → ${f.path}` : f.path
}

/**
 * The GIT tab: working-tree status of the project's linked folder — branch +
 * ahead/behind header, changed/untracked file list on the left, the selected
 * file's diff on the right. Rendered in place inside ProjectTasksPage's
 * frame, like AgentsView. Read-only; refetches on window focus (no poll —
 * git state changes from terminal work outside the app, and the server
 * caches the status call for 5s anyway).
 */
export function GitView({ projectId }: { projectId: number }) {
  const { data, error } = useFetch(
    () => getProjectGit(projectId),
    `git-${projectId}`,
  )
  // Selected path is component state, not URL (no deep-linking a file).
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
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
  if (data.repo === null) {
    return (
      <div className="git-placeholder muted">
        <p>
          <code>{data.path}</code> is not a git repository (or the folder no
          longer exists).
        </p>
      </div>
    )
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

      {files.length === 0 ? (
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
