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

const STATUSES: Status[] = ['todo', 'in_progress', 'done', 'cancelled']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']

export function ProjectTasksPage({
  projectId,
  taskId,
  onProjectsChanged,
}: {
  projectId: number
  taskId: number | null
  onProjectsChanged: () => void
}) {
  // Status and tag are passed through to the API's query filters; priority
  // is filtered client-side (the API has no priority filter).
  const [status, setStatus] = useState<Status | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tag, setTag] = useState('')
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
  )
  // Unfiltered count for the delete confirmation: the list fetch above may
  // be filtered, but the cascade destroys every task in the project.
  const { data: allTasks, refetch: refetchCount } = useFetch(
    () => listTasks({ project: projectId }),
    `count-${projectId}`,
  )

  const error = projectError ?? tasksError
  if (error) return <p className="error">{error}</p>

  const visible = tasks?.filter((t) => priority === '' || t.priority === priority)

  function onTasksChanged() {
    refetch()
    refetchCount()
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
          {visible.map((t) => (
            <TaskRow key={t.id} task={t} />
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
        <p className="project-actions">
          <button onClick={openCreate}>add task</button>
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

        <div className="tabs">
          <button
            className={view === 'list' ? 'active' : ''}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            className={view === 'board' ? 'active' : ''}
            onClick={() => setView('board')}
          >
            Board
          </button>
          {/* Navigates to the separate boards area (not an in-place view
              toggle); rendered as a peer button to match List/Board styling. */}
          <button
            onClick={() => {
              window.location.hash = `#/projects/${projectId}/storyboards`
            }}
          >
            Storyboards
          </button>
        </div>

        {view === 'board' ? (
          !tasks ? (
            <p className="muted">Loading…</p>
          ) : (
            <KanbanBoard tasks={tasks} onMoved={onTasksChanged} />
          )
        ) : (
          listView
        )}
      </div>
      {panel && <aside className="side-panel">{panel}</aside>}
    </div>
  )
}
