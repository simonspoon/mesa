import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { updateTaskPosition } from './api'
import type { Status } from './types/Status'
import type { TaskSummary } from './types/TaskSummary'

const COLUMNS: Status[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled']

function CardBody({ task }: { task: TaskSummary }) {
  return (
    <>
      <span className="card-id muted">#{task.id}</span>
      <a href={`#/projects/${task.project_id}/tasks/${task.id}`}>
        {task.title}
      </a>
      <div>
        <span className={`badge priority-${task.priority}`}>{task.priority}</span>
        {task.blocked && <span className="badge blocked">blocked</span>}
      </div>
    </>
  )
}

function Card({ task, depth = 0 }: { task: TaskSummary; depth?: number }) {
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
    >
      <CardBody task={task} />
    </li>
  )
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

function Column({ status, tasks }: { status: Status; tasks: TaskSummary[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const ordered = nestColumn(tasks)
  return (
    <div ref={setNodeRef} className={`kanban-column${isOver ? ' over' : ''}`}>
      <h2>
        {status} <span className="muted">{tasks.length}</span>
      </h2>
      <SortableContext
        items={ordered.map(({ task }) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul>
          {ordered.map(({ task, depth }) => (
            <Card key={task.id} task={task} depth={depth} />
          ))}
        </ul>
      </SortableContext>
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
}: {
  tasks: TaskSummary[]
  onMoved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  // distance: 5 lets plain clicks reach the card's link without starting
  // a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
      tasks.filter((t) => t.status === status && t.id !== id),
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
              <CardBody task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  )
}
