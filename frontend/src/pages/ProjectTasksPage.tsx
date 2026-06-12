import { useState } from 'react'
import { getProject, listTasks } from '../api'
import { KanbanBoard } from '../KanbanBoard'
import type { Priority } from '../types/Priority'
import type { Status } from '../types/Status'
import type { TaskSummary } from '../types/TaskSummary'
import { useFetch } from '../useFetch'

const STATUSES: Status[] = ['todo', 'in_progress', 'done', 'cancelled']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']

export function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <li>
      <a href={`#/tasks/${task.id}`}>{task.title}</a>{' '}
      <span className={`badge status-${task.status}`}>{task.status}</span>{' '}
      <span className="badge">{task.priority}</span>
      {task.blocked && <span className="badge blocked"> blocked</span>}
      {task.tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </li>
  )
}

export function ProjectTasksPage({ projectId }: { projectId: number }) {
  // Status and tag are passed through to the API's query filters; priority
  // is filtered client-side (the API has no priority filter).
  const [status, setStatus] = useState<Status | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tag, setTag] = useState('')
  const [view, setView] = useState<'list' | 'board'>('list')

  const { data: project, error: projectError } = useFetch(
    () => getProject(projectId),
    `project-${projectId}`,
  )
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

  const error = projectError ?? tasksError
  if (error) return <p className="error">{error}</p>

  const visible = tasks?.filter((t) => priority === '' || t.priority === priority)

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
    <>
      <h1>{project ? project.name : `Project ${projectId}`}</h1>
      {project?.description && <p className="muted">{project.description}</p>}

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
      </div>

      {view === 'board' ? (
        !tasks ? (
          <p className="muted">Loading…</p>
        ) : (
          <KanbanBoard tasks={tasks} onMoved={refetch} />
        )
      ) : (
        listView
      )}
    </>
  )
}
