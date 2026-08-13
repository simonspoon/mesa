import { useState } from 'react'
import { createDiagram, listDiagrams } from '../api'
import { getAuthor, setAuthor } from '../author'
import type { DiagramType } from '../types/DiagramType'
import { useFetch } from '../useFetch'

/** The three board styles a new diagram can be created as (Must #1/#9) —
 *  offered as a plain `<select>` alongside title/author, defaulting to the
 *  original generic board so existing creation behavior is unchanged unless
 *  the user picks otherwise. */
const DIAGRAM_TYPES: DiagramType[] = ['storyboard', 'flowchart', 'erd', 'brainstorm']

/**
 * Lists a project's diagrams and creates new ones. A board is a freeform
 * canvas; this is just the index — the canvas lives in DiagramBoardView. Rendered
 * in place inside ProjectTasksPage's frame (project header + tab row supply the
 * surrounding chrome), so it carries no header or back link of its own.
 */
export function DiagramListView({ projectId }: { projectId: number }) {
  const { data: boards, error, refetch } = useFetch(
    () => listDiagrams(projectId),
    `diagrams-${projectId}`,
  )
  const [title, setTitle] = useState('')
  const [author, setAuthorState] = useState(getAuthor())
  const [diagramType, setDiagramType] = useState<DiagramType>('storyboard')
  const [createError, setCreateError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setAuthor(author)
    createDiagram({
      project_id: projectId,
      title,
      author,
      diagram_type: diagramType,
    }).then(
      (d) => {
        setTitle('')
        setCreateError(null)
        refetch()
        window.location.hash = `#/projects/${projectId}/diagrams/${d.id}`
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
          placeholder="new diagram title"
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
        <select
          value={diagramType}
          title="diagram type — fixed once created"
          onChange={(e) => setDiagramType(e.target.value as DiagramType)}
        >
          {DIAGRAM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="submit">create</button>
        {createError && <span className="error">{createError}</span>}
      </form>

      {error ? (
        <p className="error">{error}</p>
      ) : !boards ? (
        <p className="muted">Loading…</p>
      ) : boards.length === 0 ? (
        <p className="muted">No diagrams yet.</p>
      ) : (
        <ul className="card-list">
          {boards.map((b) => (
            <li key={b.id}>
              <a href={`#/projects/${projectId}/diagrams/${b.id}`}>
                {b.title}
              </a>
              {b.description && (
                <span className="muted"> — {b.description}</span>
              )}
              <div className="muted diagram-meta">
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
