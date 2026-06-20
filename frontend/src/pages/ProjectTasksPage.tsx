import { useState } from 'react'
import { deleteProject, getProject, listTasks, updateProject } from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { CreateTaskPanel } from '../components/CreateTaskPanel'
import { InlineEdit } from '../components/InlineEdit'
import { TaskPanel } from '../components/TaskPanel'
import { TaskRow } from '../components/TaskRow'
import { KanbanBoard } from '../KanbanBoard'
import type { Priority } from '../types/Priority'
import type { Status } from '../types/Status'
import { useFetch } from '../useFetch'
import { StoryboardBoardView } from './StoryboardBoardView'
import { StoryboardListView } from './StoryboardListView'

import type { TaskSummary } from '../types/TaskSummary'

const STATUSES: Status[] = ['todo', 'in_progress', 'done', 'cancelled']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']

// Order tasks so each subtask sits directly under its parent, indented one
// level (spec S6, one level only). Parents keep the incoming order; a subtask
// whose parent is absent from the list (filtered out) stays in place at the
// top level so it is never dropped.
function nestSubtasks(
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
    // Skip subtasks whose parent is also in the list; they are emitted under
    // the parent below. Orphaned subtasks fall through at depth 0.
    if (t.parent_id !== null && present.has(t.parent_id)) continue
    out.push({ task: t, depth: 0 })
    for (const child of byParent.get(t.id) ?? []) {
      out.push({ task: child, depth: 1 })
    }
  }
  return out
}

export function ProjectTasksPage({
  projectId,
  taskId,
  storyboards,
  storyboardId,
  onProjectsChanged,
}: {
  projectId: number
  taskId: number | null
  // Storyboards is a URL-driven view (refresh-/back-stable): `storyboards` is
  // true on the boards routes, `storyboardId` selects a single board's canvas.
  storyboards: boolean
  storyboardId: number | null
  onProjectsChanged: () => void
}) {
  // Status and tag are passed through to the API's query filters; priority
  // is filtered client-side (the API has no priority filter).
  const [status, setStatus] = useState<Status | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tag, setTag] = useState('')
  // List/Board is an in-place toggle held in local state; Storyboards is
  // URL-driven (the `storyboards` prop). `view` only distinguishes list vs
  // board — when Storyboards is active it governs neither tab's content.
  const [view, setView] = useState<'list' | 'board'>('list')
  // Create-form panel state is ephemeral (spec Assumption 2); the task
  // panel is URL-driven via `taskId`. Latest action wins: opening a task
  // closes the create form.
  const [creating, setCreating] = useState(false)
  // Latest action wins: opening a task (taskId becomes non-null) closes the
  // create form. Adjust the state during render off the changed prop rather
  // than in an effect (avoids a cascading re-render).
  const [prevTaskId, setPrevTaskId] = useState(taskId)
  if (taskId !== prevTaskId) {
    setPrevTaskId(taskId)
    if (taskId !== null) setCreating(false)
  }

  const {
    data: project,
    error: projectError,
    refetch: refetchProject,
  } = useFetch(() => getProject(projectId), `project-${projectId}`)
  // The board always shows every status column, so it fetches unfiltered;
  // the list filters apply only to the list view.
  const { data: tasks, error: tasksError, refetch } = useFetch(
    () =>
      view === 'board'
        ? listTasks({ project: projectId })
        : listTasks({
            project: projectId,
            status: status === '' ? undefined : status,
            tag: tag === '' ? undefined : tag,
          }),
    view === 'board'
      ? `board-${projectId}`
      : `tasks-${projectId}-${status}-${tag}`,
    // Live-sync the List/Board: agents mutate the DB underneath the UI, so
    // poll for changes instead of waiting for a window refocus. No-op polls
    // are dropped in useFetch, so an unchanged view never re-renders.
    { pollMs: 3000 },
  )
  // Unfiltered count for the delete confirmation: the list fetch above may
  // be filtered, but the cascade destroys every task in the project.
  const { data: allTasks, refetch: refetchCount } = useFetch(
    () => listTasks({ project: projectId }),
    `count-${projectId}`,
  )

  // Storyboards is its own view with its own fetches/error handling, so a
  // failed task fetch must not block it; only surface it on the task views.
  const error = projectError ?? (storyboards ? null : tasksError)
  if (error) return <p className="error">{error}</p>

  const visible = tasks?.filter((t) => priority === '' || t.priority === priority)

  function onTasksChanged() {
    refetch()
    refetchCount()
  }

  // Switch to a task view (List/Board). When a storyboards route is open this
  // also returns the hash to the project URL so the switch happens in place,
  // matching how the tabs toggle among any views (M5 symmetric return).
  function selectView(next: 'list' | 'board') {
    setView(next)
    if (storyboards) window.location.hash = `#/projects/${projectId}`
  }

  function closePanel() {
    setCreating(false)
    if (taskId !== null) window.location.hash = `#/projects/${projectId}`
  }

  function openCreate() {
    setCreating(true)
    // One panel, latest action wins: drop an open task back to the
    // project URL (the create form is not URL-addressed).
    if (taskId !== null) window.location.hash = `#/projects/${projectId}`
  }

  const panel = creating ? (
    <CreateTaskPanel
      projectId={projectId}
      onClose={closePanel}
      onCreated={() => {
        setCreating(false)
        onTasksChanged()
      }}
    />
  ) : taskId !== null ? (
    <TaskPanel
      key={taskId}
      taskId={taskId}
      onClose={closePanel}
      onChanged={onTasksChanged}
    />
  ) : null

  const listView = (
    <>
      <div className="filters">
        <label>
          Status{' '}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status | '')}
          >
            <option value="">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority{' '}
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority | '')}
          >
            <option value="">all</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag{' '}
          <input
            type="text"
            value={tag}
            placeholder="filter by tag"
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
      </div>

      {!visible ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">No tasks match.</p>
      ) : (
        <ul className="card-list">
          {nestSubtasks(visible).map(({ task, depth }) => (
            <TaskRow key={task.id} task={task} depth={depth} />
          ))}
        </ul>
      )}
    </>
  )

  return (
    <div className={panel ? 'project-split' : ''}>
      <div className="project-main">
        <h1>
          {project ? (
            <InlineEdit
              value={project.name}
              onSave={(name) =>
                updateProject(projectId, { name }).then(() => {
                  refetchProject()
                  onProjectsChanged()
                })
              }
            />
          ) : (
            `Project ${projectId}`
          )}
        </h1>
        {project && (
          <p className="muted">
            <InlineEdit
              value={project.description ?? ''}
              multiline
              placeholder="no description — click to add"
              onSave={(d) =>
                updateProject(projectId, {
                  description: d === '' ? null : d,
                }).then(refetchProject)
              }
            />
          </p>
        )}
        <div className="tabs">
          <button
            className={!storyboards && view === 'list' ? 'active' : ''}
            onClick={() => selectView('list')}
          >
            List
          </button>
          <button
            className={!storyboards && view === 'board' ? 'active' : ''}
            onClick={() => selectView('board')}
          >
            Board
          </button>
          {/* Third in-place view: drives the URL (boards/canvas are refresh-
              and back-stable) while keeping this frame around the content. */}
          <button
            className={storyboards ? 'active' : ''}
            onClick={() => {
              if (!storyboards)
                window.location.hash = `#/projects/${projectId}/storyboards`
            }}
          >
            Storyboards
          </button>
        </div>

        {/* Create action lives where the user is working: below the tabs, on
            the List/Board views only (spec S5), not on Storyboards. */}
        {!storyboards && (
          <p className="task-actions">
            <button onClick={openCreate}>add task</button>
          </p>
        )}

        {storyboards ? (
          storyboardId !== null ? (
            <StoryboardBoardView
              projectId={projectId}
              storyboardId={storyboardId}
            />
          ) : (
            <StoryboardListView projectId={projectId} />
          )
        ) : view === 'board' ? (
          !tasks ? (
            <p className="muted">Loading…</p>
          ) : (
            <KanbanBoard tasks={tasks} onMoved={onTasksChanged} />
          )
        ) : (
          listView
        )}

        {/* Destructive action tucked away, de-emphasized (spec S8): rarely
            used, kept reachable in a low-key project footer. */}
        <p className="project-danger">
          <ConfirmDelete
            label="delete project"
            message={`Deletes this project and ${allTasks?.length ?? '?'} task(s).`}
            onDelete={() =>
              deleteProject(projectId).then(() => {
                onProjectsChanged()
                window.location.hash = '#/'
              })
            }
          />
        </p>
      </div>
      {panel && <aside className="side-panel">{panel}</aside>}
    </div>
  )
}
