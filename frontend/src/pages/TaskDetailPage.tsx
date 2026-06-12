import { getTask, listDependencies, listTasks } from '../api'
import { useFetch } from '../useFetch'
import { TaskRow } from './ProjectTasksPage'

export function TaskDetailPage({ taskId }: { taskId: number }) {
  const { data, error } = useFetch(async () => {
    const task = await getTask(taskId)
    const [siblings, blockers] = await Promise.all([
      listTasks({ project: task.project_id }),
      listDependencies(taskId),
    ])
    // One level of nesting only (spec Assumption 6).
    const subtasks = siblings.filter((t) => t.parent_id === taskId)
    return { task, subtasks, blockers }
  }, `task-${taskId}`)

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const { task, subtasks, blockers } = data
  return (
    <>
      <p>
        <a href={`#/projects/${task.project_id}`}>← back to project</a>
      </p>
      <h1>
        #{task.id} {task.title}
      </h1>
      <p>
        <span className={`badge status-${task.status}`}>{task.status}</span>{' '}
        <span className="badge">{task.priority}</span>
        {task.blocked && <span className="badge blocked"> blocked</span>}
        {task.tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </p>
      {task.parent_id !== null && (
        <p className="muted">
          Subtask of <a href={`#/tasks/${task.parent_id}`}>task #{task.parent_id}</a>
        </p>
      )}
      {task.description && <p className="description">{task.description}</p>}

      <h2>Subtasks</h2>
      {subtasks.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="card-list">
          {subtasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}

      <h2>Blocked by</h2>
      {blockers.length === 0 ? (
        <p className="muted">Nothing.</p>
      ) : (
        <ul className="card-list">
          {blockers.map((b) => (
            <li key={b.id}>
              <a href={`#/tasks/${b.id}`}>
                #{b.id} {b.title}
              </a>{' '}
              <span className={`badge status-${b.status}`}>{b.status}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
