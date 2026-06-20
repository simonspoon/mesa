import type { TaskSummary } from '../types/TaskSummary'

export function TaskRow({
  task,
  depth = 0,
}: {
  task: TaskSummary
  depth?: number
}) {
  return (
    <li className={depth > 0 ? 'subtask-row' : undefined}>
      <a href={`#/projects/${task.project_id}/tasks/${task.id}`}>
        {task.title}
      </a>{' '}
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
