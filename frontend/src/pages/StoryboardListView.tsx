import { useState } from 'react'
import { createStoryboard, listStoryboards } from '../api'
import { getAuthor, setAuthor } from '../author'
import { useFetch } from '../useFetch'

/**
 * Lists a project's storyboards and creates new ones. A board is a freeform
 * canvas; this is just the index — the canvas lives in StoryboardView. Rendered
 * in place inside ProjectTasksPage's frame (project header + tab row supply the
 * surrounding chrome), so it carries no header or back link of its own.
 */
export function StoryboardListView({ projectId }: { projectId: number }) {
  const { data: boards, error, refetch } = useFetch(
    () => listStoryboards(projectId),
    `storyboards-${projectId}`,
  )
  const [title, setTitle] = useState('')
  const [author, setAuthorState] = useState(getAuthor())
  const [createError, setCreateError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setAuthor(author)
    createStoryboard({ project_id: projectId, title, author }).then(
      (sb) => {
        setTitle('')
        setCreateError(null)
        refetch()
        window.location.hash = `#/projects/${projectId}/storyboards/${sb.id}`
      },
      (err: unknown) =>
        setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  return (
    <>
      <form className="create-form" onSubmit={submit}>
        <input
          type="text"
          value={title}
          placeholder="new storyboard title"
          required
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          type="text"
          value={author}
          placeholder="you"
          title="your name — stamped on what you create"
          onChange={(e) => setAuthorState(e.target.value)}
        />
        <button type="submit">create</button>
        {createError && <span className="error">{createError}</span>}
      </form>

      {error ? (
        <p className="error">{error}</p>
      ) : !boards ? (
        <p className="muted">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="muted">No storyboards yet.</p>
      ) : (
        <ul className="card-list">
          {boards.map((b) => (
            <li key={b.id}>
              <a href={`#/projects/${projectId}/storyboards/${b.id}`}>
                {b.title}
              </a>
              {b.description && (
                <span className="muted"> — {b.description}</span>
              )}
              <div className="muted storyboard-meta">
                {b.author && <span>by {b.author} · </span>}
                <span>updated {b.updated_at}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
