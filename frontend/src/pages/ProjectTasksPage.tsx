import { useState } from 'react'
import {
  createTask,
  deleteProject,
  getProject,
  listTasks,
  updateProject,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { InlineEdit } from '../components/InlineEdit'
import { KanbanBoard } from '../KanbanBoard'
import { parseTags } from '../tags'
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

function CreateTaskForm({
  projectId,
  onCreated,
}: {
  projectId: number
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createTask({
      project_id: projectId,
      title,
      priority,
      tags: parseTags(tags),
    }).then(
      () => {
        setTitle('')
        setPriority('medium')
        setTags('')
        setError(null)
        onCreated()
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <input
        type="text"
        value={title}
        placeholder="new task title"
        required
        onChange={(e) => setTitle(e.target.value)}
      />
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
      >
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={tags}
        placeholder="tags, comma-separated"
        onChange={(e) => setTags(e.target.value)}
      />
      <button type="submit">create</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

export function ProjectTasksPage({ projectId }: { projectId: number }) {
  // Status and tag are passed through to the API's query filters; priority
  // is filtered client-side (the API has no priority filter).
  const [status, setStatus] = useState<Status | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [tag, setTag] = useState('')
  const [view, setView] = useState<'list' | 'board'>('list')

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
      <h1>
        {project ? (
          <InlineEdit
            value={project.name}
            onSave={(name) =>
              updateProject(projectId, { name }).then(refetchProject)
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
      <p>
        <ConfirmDelete
          label="delete project"
          message={`Deletes this project and ${allTasks?.length ?? '?'} task(s).`}
          onDelete={() =>
            deleteProject(projectId).then(() => {
              window.location.hash = '#/'
            })
          }
        />
      </p>

      <CreateTaskForm projectId={projectId} onCreated={onTasksChanged} />

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
          <KanbanBoard tasks={tasks} onMoved={onTasksChanged} />
        )
      ) : (
        listView
      )}
    </>
  )
}
