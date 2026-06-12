import { useState } from 'react'
import {
  createTask,
  deleteTask,
  getTask,
  listDependencies,
  listTasks,
  updateTask,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { InlineEdit } from '../components/InlineEdit'
import type { Priority } from '../types/Priority'
import type { Status } from '../types/Status'
import { parseTags } from '../tags'
import { useFetch } from '../useFetch'
import { TaskRow } from './ProjectTasksPage'

const STATUSES: Status[] = ['todo', 'in_progress', 'done', 'cancelled']
const PRIORITIES: Priority[] = ['low', 'medium', 'high']

function CreateSubtaskForm({
  projectId,
  parentId,
  onCreated,
}: {
  projectId: number
  parentId: number
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createTask({ project_id: projectId, title, parent_id: parentId }).then(
      () => {
        setTitle('')
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
        placeholder="new subtask title"
        required
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="submit">add subtask</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

export function TaskDetailPage({ taskId }: { taskId: number }) {
  const [selectError, setSelectError] = useState<string | null>(null)
  const { data, error, refetch } = useFetch(async () => {
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

  // Status/priority save on change; errors land in the shared slot below.
  function patchSelect(patch: Parameters<typeof updateTask>[1]) {
    updateTask(taskId, patch).then(
      () => {
        setSelectError(null)
        refetch()
      },
      (e: unknown) => {
        setSelectError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <>
      <p>
        <a href={`#/projects/${task.project_id}`}>← back to project</a>
      </p>
      <h1>
        #{task.id}{' '}
        <InlineEdit
          value={task.title}
          onSave={(title) => updateTask(taskId, { title }).then(refetch)}
        />
      </h1>
      <p className="task-controls">
        <select
          value={task.status}
          onChange={(e) => patchSelect({ status: e.target.value as Status })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>{' '}
        <select
          value={task.priority}
          onChange={(e) =>
            patchSelect({ priority: e.target.value as Priority })
          }
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {task.blocked && <span className="badge blocked"> blocked</span>}
        {selectError && <span className="error">{selectError}</span>}
      </p>
      <p className="tags-line">
        Tags:{' '}
        <InlineEdit
          value={task.tags.join(', ')}
          placeholder="none — click to add"
          onSave={(t) => updateTask(taskId, { tags: parseTags(t) }).then(refetch)}
        />
      </p>
      {task.parent_id !== null && (
        <p className="muted">
          Subtask of <a href={`#/tasks/${task.parent_id}`}>task #{task.parent_id}</a>
        </p>
      )}
      <p className="description">
        <InlineEdit
          value={task.description ?? ''}
          multiline
          placeholder="no description — click to add"
          onSave={(d) =>
            updateTask(taskId, { description: d === '' ? null : d }).then(refetch)
          }
        />
      </p>
      <p>
        <ConfirmDelete
          label="delete task"
          message={`Deletes this task and ${subtasks.length} subtask(s).`}
          onDelete={() =>
            deleteTask(taskId).then(() => {
              window.location.hash = `#/projects/${task.project_id}`
            })
          }
        />
      </p>

      <h2>Subtasks</h2>
      <CreateSubtaskForm
        projectId={task.project_id}
        parentId={taskId}
        onCreated={refetch}
      />
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
