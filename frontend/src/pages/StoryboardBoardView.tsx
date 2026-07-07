import { useState } from 'react'
import {
  deleteStoryboard,
  getStoryboard,
  listStoryboardEvents,
  updateStoryboard,
} from '../api'
import { getAuthor, setAuthor } from '../author'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { InlineEdit } from '../components/InlineEdit'
import { StoryboardCanvas } from '../StoryboardCanvas'
import { useFetch } from '../useFetch'

/** The board's change history (who/what/when), newest first. `version` bumps
 *  on every canvas mutation so the log refetches. */
function StoryboardHistory({
  storyboardId,
  version,
}: {
  storyboardId: number
  version: number
}) {
  const { data: events, error } = useFetch(
    () => listStoryboardEvents(storyboardId),
    `sb-events-${storyboardId}-${version}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!events) return <p className="muted">Loading…</p>
  if (events.length === 0) return <p className="muted">No history yet.</p>
  return (
    <ul className="history-list">
      {events
        .slice()
        .reverse()
        .map((e) => (
          <li key={e.id}>
            <span className="muted history-at">{e.at}</span>
            <span className="history-actor">{e.actor ?? 'unknown'}</span>
            <span className="history-summary">{e.summary}</span>
          </li>
        ))}
    </ul>
  )
}

/**
 * One storyboard rendered in place inside ProjectTasksPage's frame: its
 * title/description header, the change-history log, and the freeform canvas.
 * The canvas owns frame/edge editing; this owns the board-level fields and the
 * "who am I" author field stamped on every change. The project header + tab row
 * supply the surrounding chrome, so there is no back link here — switching views
 * is done via the tabs, and the boards index is reachable via "← storyboards".
 */
export function StoryboardBoardView({
  projectId,
  storyboardId,
}: {
  projectId: number
  storyboardId: number
}) {
  const { data: view, error, refetch } = useFetch(
    () => getStoryboard(storyboardId),
    `storyboard-${storyboardId}`,
  )
  const [author, setAuthorState] = useState(getAuthor())
  const [showHistory, setShowHistory] = useState(false)
  // Bumped on every mutation so the history log refetches alongside the canvas.
  const [historyVersion, setHistoryVersion] = useState(0)

  function refresh() {
    refetch()
    setHistoryVersion((v) => v + 1)
  }

  if (error) return <p className="error">{error}</p>
  if (!view) return <p className="muted">Loading…</p>

  const board = view.storyboard
  const actor = author || 'user'

  return (
    <div className="storyboard-page">
      <p>
        <a href={`#/projects/${projectId}/storyboards`}>← storyboards</a>
      </p>
      <h2 className="storyboard-title">
        <InlineEdit
          value={board.title}
          onSave={(title) =>
            updateStoryboard(storyboardId, { title }, actor).then(refresh)
          }
        />
      </h2>
      <p className="muted">
        <InlineEdit
          value={board.description ?? ''}
          multiline
          placeholder="no description — click to add"
          onSave={(d) =>
            updateStoryboard(
              storyboardId,
              { description: d === '' ? null : d },
              actor,
            ).then(refresh)
          }
        />
      </p>
      <p className="project-actions">
        <label className="author-field">
          you{' '}
          <input
            type="text"
            value={author}
            placeholder="user"
            title="your name — stamped on every change you make"
            onChange={(e) => {
              setAuthorState(e.target.value)
              setAuthor(e.target.value)
            }}
          />
        </label>
        <button
          className={showHistory ? 'active' : ''}
          onClick={() => setShowHistory((s) => !s)}
        >
          history
        </button>
        <ConfirmDelete
          label="delete storyboard"
          message={`Deletes this board, ${view.frames.length} frame(s) and ${view.edges.length} edge(s).`}
          onDelete={() =>
            deleteStoryboard(storyboardId).then(() => {
              window.location.hash = `#/projects/${projectId}/storyboards`
            })
          }
        />
      </p>

      {showHistory && (
        <div className="storyboard-history">
          <h2>History</h2>
          <StoryboardHistory
            storyboardId={storyboardId}
            version={historyVersion}
          />
        </div>
      )}

      {/* Keyed by board id: a board switch remounts the canvas so React Flow
          re-reads that board's saved viewport (defaultViewport is mount-time). */}
      <StoryboardCanvas
        key={storyboardId}
        view={view}
        projectId={projectId}
        author={actor}
        onChanged={refresh}
      />
    </div>
  )
}
