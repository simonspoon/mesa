import type { TaskSummary } from '../types/TaskSummary'

export function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <li>
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
