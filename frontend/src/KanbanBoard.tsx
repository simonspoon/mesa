import { useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { updateTaskStatus } from './api'
import type { Status } from './types/Status'
import type { TaskSummary } from './types/TaskSummary'

const COLUMNS: Status[] = ['todo', 'in_progress', 'done', 'cancelled']

function Card({ task, depth = 0 }: { task: TaskSummary; depth?: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: task.id })
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined
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
      <span className="card-id muted">#{task.id}</span>
      <a href={`#/projects/${task.project_id}/tasks/${task.id}`}>
        {task.title}
      </a>
      <div>
        <span className="badge">{task.priority}</span>
        {task.blocked && <span className="badge blocked">blocked</span>}
      </div>
    </li>
  )
}

// Order a column's tasks so each subtask sits directly under its parent,
// indented one level (spec S6). A subtask whose parent is in another column
// (different status) stays at the top level so it is never dropped.
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
  return (
    <div ref={setNodeRef} className={`kanban-column${isOver ? ' over' : ''}`}>
      <h2>
        {status} <span className="muted">{tasks.length}</span>
      </h2>
      <ul>
        {nestColumn(tasks).map(({ task, depth }) => (
          <Card key={task.id} task={task} depth={depth} />
        ))}
      </ul>
    </div>
  )
}

/**
 * Per-project kanban board: one droppable column per status, draggable
 * task cards. A drop fires PATCH /api/tasks/:id with the new status
 * (spec Requirement 10), then `onMoved` so the caller refetches.
 */
export function KanbanBoard({
  tasks,
  onMoved,
}: {
  tasks: TaskSummary[]
  onMoved: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  // distance: 5 lets plain clicks reach the card's link without starting
  // a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const id = Number(active.id)
    const status = over.id as Status
    const task = tasks.find((t) => t.id === id)
    if (!task || task.status === status) return
    updateTaskStatus(id, status).then(
      () => {
        setError(null)
        onMoved()
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="kanban">
          {COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasks.filter((t) => t.status === status)}
            />
          ))}
        </div>
      </DndContext>
    </>
  )
}
