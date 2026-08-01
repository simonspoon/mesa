import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { updateTaskPosition } from './api'
import { capColumn, liveAgentCount, DONE_INITIAL, DONE_PAGE } from './boardView'
import { formatTimestamp, timeAgo } from './time'
import type { AgentSession } from './types/AgentSession'
import type { Status } from './types/Status'
import type { TaskSummary } from './types/TaskSummary'

const COLUMNS: Status[] = ['backlog', 'refine', 'todo', 'in_progress', 'done']

function CardBody({ task, liveAgents }: { task: TaskSummary; liveAgents: number }) {
  return (
    <>
      <span className="card-id muted">#{task.id}</span>
      <a href={`#/projects/${task.project_id}/tasks/${task.id}`}>
        {task.name}
      </a>
      <div>
        <span className={`badge priority-${task.priority}`}>{task.priority}</span>
        {task.blocked && <span className="badge blocked">blocked</span>}
        {/* Claim marker. A non-null `owner` only ever occurs on an
            `in_progress` row (Store clears the claim on any status change out
            of it), so this needs no column check of its own — see TaskPanel.
            The card has no room for the age, so it rides in the tooltip
            alongside the untruncated owner. */}
        {task.owner !== null && (
          <span
            className="badge claim-badge"
            title={
              `held by ${task.owner}` +
              (task.claimed_at === null
                ? ''
                : ` · claimed ${timeAgo(task.claimed_at)} (${formatTimestamp(
                    task.claimed_at,
                  )})`)
            }
          >
            held {task.owner}
          </span>
        )}
        {/* Live-agent marker (mesa task 663): a *running* Claude Code session
            whose name matches this project+task, not a stored status — so it
            fires in every column, `refine` included, and an `in_progress` row
            whose agent crashed stops pulsing. Best-effort by construction; see
            `liveAgentCount`. It lives in `CardBody` so the DragOverlay copy
            carries it too. */}
        {liveAgents > 0 && (
          <span
            className="live-dot on card-live-dot"
            title={`${liveAgents} agent${liveAgents === 1 ? '' : 's'} working`}
          />
        )}
      </div>
    </>
  )
}

function Card({
  task,
  depth = 0,
  liveAgents,
}: {
  task: TaskSummary
  depth?: number
  liveAgents: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`kanban-card${isDragging ? ' dragging' : ''}${
        depth > 0 ? ' subtask-card' : ''
      }`}
      {...listeners}
      {...attributes}
      // dnd-kit's `attributes` injects `role="button"`/`tabIndex={0}` for a
      // KeyboardSensor this board doesn't configure — that would make the
      // <li> a dead second tab stop ahead of the real one, the <a> below.
      // Force it back off so Tab lands on the link, which already opens the
      // task detail on Enter natively.
      tabIndex={-1}
    >
      <CardBody task={task} liveAgents={liveAgents} />
    </li>
  )
}

// The Done column reads as a completion log (spec 366): most recently
// completed first, by `updated_at` (a done task is not normally edited
// again, so it stands in for a completion timestamp). Every other column
// keeps the manual `sort_order` order already baked into the array from
// GET /api/tasks.
function orderColumn(status: Status, tasks: TaskSummary[]): TaskSummary[] {
  if (status !== 'done') return tasks
  return [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

// Order a column's tasks so each subtask sits directly under its parent,
// indented one level (spec S6). A subtask whose parent is in another column
// (different status) stays at the top level so it is never dropped. This is
// also the visual order dragging reorders against (spec 328) — the id list
// this returns doubles as both render order and the SortableContext's item
// list, so drop position always matches what's on screen.
function nestColumn(
  tasks: TaskSummary[],
): { task: TaskSummary; depth: number }[] {
  const byParent = new Map<number, TaskSummary[]>()
  for (const t of tasks) {
    if (t.parent_id !== null) {
      const group = byParent.get(t.parent_id) ?? []
      group.push(t)
      byParent.set(t.parent_id, group)
    }
  }
  const present = new Set(tasks.map((t) => t.id))
  const out: { task: TaskSummary; depth: number }[] = []
  for (const t of tasks) {
    if (t.parent_id !== null && present.has(t.parent_id)) continue
    out.push({ task: t, depth: 0 })
    for (const child of byParent.get(t.id) ?? []) {
      out.push({ task: child, depth: 1 })
    }
  }
  return out
}

function Column({
  status,
  tasks,
  projectName,
  sessions,
  shown,
  onShowMore,
}: {
  status: Status
  tasks: TaskSummary[]
  projectName: string | null
  sessions: AgentSession[] | null
  shown: number
  onShowMore: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  // Cap between the sort and the nesting, so the `done` slice is the 20 (then
  // 70, …) most recently completed rows — see `capColumn`.
  const { visible, hidden } = capColumn(status, orderColumn(status, tasks), shown)
  const ordered = nestColumn(visible)
  return (
    <div ref={setNodeRef} className={`kanban-column${isOver ? ' over' : ''}`}>
      <h2>
        {/* The *total*, not the shown count: a capped column must not read as
            missing data. */}
        {status} <span className="muted">{tasks.length}</span>
      </h2>
      <SortableContext
        items={ordered.map(({ task }) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul>
          {ordered.map(({ task, depth }) => (
            <Card
              key={task.id}
              task={task}
              depth={depth}
              liveAgents={liveAgentCount(task, projectName, sessions)}
            />
          ))}
        </ul>
      </SortableContext>
      {/* Deliberately outside the SortableContext <ul>: it is not a card, not
          draggable and not a drop target. */}
      {hidden > 0 && (
        <button type="button" className="kanban-load-more" onClick={onShowMore}>
          Load {Math.min(hidden, DONE_PAGE)} more ({hidden} hidden)
        </button>
      )}
    </div>
  )
}

/**
 * Per-project kanban board: one droppable column per status, sortable task
 * cards. A drop fires PATCH /api/tasks/:id with the new status when the
 * column changed (spec Requirement 10) and/or a new `sort_order` reflecting
 * the drop position within the destination column (spec 328), then
 * `onMoved` so the caller refetches.
 */
export function KanbanBoard({
  tasks,
  onMoved,
  projectName,
  sessions,
}: {
  tasks: TaskSummary[]
  onMoved: () => void
  // The two halves of the live-agent marker (mesa task 663). Both are
  // nullable and purely decorative: the board renders identically when the
  // project hasn't loaded or `/api/agents` is unavailable (it is gated, and
  // 502s `unavailable` with no `claude` binary), so nothing here may become
  // a render dependency.
  projectName: string | null
  sessions: AgentSession[] | null
}) {
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  // How many `done` cards to render (mesa task 664). Component state, not
  // derived from `tasks`, so an expansion survives the board's ordinary
  // refetches — `onMoved` and the window-focus refetch both hand down a fresh
  // array, and expanding to 120 then dragging a card must not snap back to 20.
  // It resets when the board unmounts, i.e. on navigating away.
  const [shownDone, setShownDone] = useState(DONE_INITIAL)
  // Mouse and touch get *different* activation gestures, which is why this is
  // MouseSensor + TouchSensor rather than the one PointerSensor that covers
  // both (mesa task 555).
  //
  // Mouse — distance: 5 lets plain clicks reach the card's link without
  // starting a drag.
  //
  // Touch — delay, NOT distance. Under a distance constraint a 5px swipe is
  // already a drag, so the card had to carry `touch-action: none` to stop the
  // browser panning first; on a phone the board is a single column of cards
  // (App.css `@media (max-width: 600px)`), so that made almost the whole board
  // un-scrollable by touch. A delay constraint inverts it: dnd-kit's
  // AbstractPointerSensor.handleMove returns *before* its `preventDefault()`
  // while activation is still pending, and cancels outright once the finger
  // passes `tolerance` — so a swipe scrolls natively and only a stationary
  // 250ms press becomes a drag. That is what lets `.kanban-card` drop to
  // `touch-action: pan-y`.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    setActiveId(Number(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const id = Number(active.id)
    const task = tasks.find((t) => t.id === id)
    if (!task) return

    // `over` is either a column's own droppable id (dropped on empty
    // column space) or another card's id (dropped near a card) — resolve
    // both to a target status and the destination column's rendered order.
    const overTask = tasks.find((t) => t.id === Number(over.id))
    const status = overTask ? overTask.status : (over.id as Status)
    const destOrdered = nestColumn(
      orderColumn(status, tasks.filter((t) => t.status === status && t.id !== id)),
    ).map(({ task: t }) => t)
    const overIndex = overTask ? destOrdered.findIndex((t) => t.id === overTask.id) : -1
    const insertAt = overIndex === -1 ? destOrdered.length : overIndex

    const prev = insertAt > 0 ? destOrdered[insertAt - 1].sort_order : null
    const next = insertAt < destOrdered.length ? destOrdered[insertAt].sort_order : null
    const sortOrder =
      prev === null && next === null
        ? 1
        : prev === null
          ? next! - 1
          : next === null
            ? prev + 1
            : (prev + next) / 2

    if (status === task.status && sortOrder === task.sort_order) return
    updateTaskPosition(id, status === task.status ? undefined : status, sortOrder).then(
      () => {
        setError(null)
        onMoved()
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  const activeTask = activeId === null ? null : tasks.find((t) => t.id === activeId)

  return (
    <>
      {error && <p className="error">{error}</p>}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="kanban">
          {COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasks.filter((t) => t.status === status)}
              projectName={projectName}
              sessions={sessions}
              shown={shownDone}
              onShowMore={() => setShownDone((n) => n + DONE_PAGE)}
            />
          ))}
        </div>
        {/* Portals the dragged card to document.body (dnd-kit's DragOverlay)
            so it escapes the stacking context each `.kanban-column` forms via
            its `clip-path` — without this, a card dragged over a
            later-DOM-order sibling column rendered underneath that column's
            own painted contents (bug 329), no z-index on the card itself
            could fix it. */}
        <DragOverlay>
          {activeTask ? (
            <div
              className={`kanban-card drag-overlay${
                activeTask.parent_id !== null ? ' subtask-card' : ''
              }`}
            >
              <CardBody
                task={activeTask}
                liveAgents={liveAgentCount(activeTask, projectName, sessions)}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  )
}
