import { useEffect, useState } from 'react'
import { createDiagram, getDiagram, listDiagrams } from '../api'
import { getAuthor, setAuthor } from '../author'
import { diagramThumb } from '../diagramThumb'
import { formatTimestamp, timeAgo } from '../time'
import type { DiagramType } from '../types/DiagramType'
import type { DiagramView } from '../types/DiagramView'
import { useFetch } from '../useFetch'

/** The three board styles a new diagram can be created as (Must #1/#9) —
 *  offered as a plain `<select>` alongside title/author, defaulting to the
 *  original generic board so existing creation behavior is unchanged unless
 *  the user picks otherwise. */
const DIAGRAM_TYPES: DiagramType[] = ['storyboard', 'flowchart', 'erd', 'brainstorm']

/** Thumbnail box, in the SVG's own units — matches `.diagram-thumb` in
 *  App.css, which is what actually sizes it on screen. */
const THUMB_W = 128
const THUMB_H = 80

/**
 * The board's saved state as a mini-map (mesa task 854). All the geometry is
 * `diagramThumb.ts`; this only paints it. A board still loading, one whose
 * view failed to fetch, and one with no frames all render the same inert
 * placeholder — nothing here is a link or a control, so the row stays a
 * single target.
 */
function DiagramThumbnail({ view }: { view: DiagramView | undefined }) {
  const thumb = view ? diagramThumb(view.frames, view.edges, THUMB_W, THUMB_H) : null
  if (!thumb) return <div className="diagram-thumb diagram-thumb-empty" aria-hidden="true" />
  return (
    <svg className="diagram-thumb" viewBox={thumb.viewBox} aria-hidden="true">
      {thumb.lines.map((l) => (
        <line key={l.id} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      ))}
      {thumb.rects.map((r) => (
        <rect
          key={r.id}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          // The capsule shapes read as capsules even this small; every other
          // shape is a small rounded rect, deliberately not a silhouette.
          rx={r.shape === 'central' || r.shape === 'start_end' ? Math.min(r.h / 2, 6) : 1.5}
          // A frame's own colour hint wins over the sheet's default stroke.
          style={r.color ? { stroke: r.color } : undefined}
        />
      ))}
    </svg>
  )
}

/**
 * Each listed board's full view, keyed by id — what the thumbnails draw. The
 * list endpoint returns `Diagram` rows only, so the frames/edges are a second
 * read per row. Fetched once per *set of ids* (and on refocus, like every
 * other view), never per render: the effect's only dependency is that id
 * list flattened to a string, so a resolved fetch writing state cannot
 * re-trigger it. A row whose view fails keeps no entry and shows the
 * placeholder — one broken board never takes the page down.
 */
function useDiagramViews(ids: number[]): Record<number, DiagramView> {
  const [views, setViews] = useState<Record<number, DiagramView>>({})
  const idsKey = ids.join(',')

  useEffect(() => {
    if (idsKey === '') return
    let cancelled = false
    const run = () => {
      for (const id of idsKey.split(',').map(Number)) {
        getDiagram(id).then(
          (v) => {
            if (!cancelled) setViews((prev) => ({ ...prev, [id]: v }))
          },
          () => {},
        )
      }
    }
    run()
    window.addEventListener('focus', run)
    return () => {
      cancelled = true
      window.removeEventListener('focus', run)
    }
  }, [idsKey])

  return views
}

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
  const views = useDiagramViews(boards ? boards.map((b) => b.id) : [])

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
            <li key={b.id} className="diagram-row">
              <DiagramThumbnail view={views[b.id]} />
              <div className="diagram-row-main">
                <a
                  className="diagram-row-title"
                  href={`#/projects/${projectId}/diagrams/${b.id}`}
                >
                  {b.title}
                </a>
                {b.description && (
                  <p className="muted diagram-row-desc">{b.description}</p>
                )}
                <div className="muted diagram-meta">
                  {b.author && <span>by {b.author} · </span>}
                  <span>{b.diagram_type} · </span>
                  <span title={formatTimestamp(b.updated_at)}>
                    updated {timeAgo(b.updated_at)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
