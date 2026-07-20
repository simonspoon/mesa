import { useState } from 'react'
import {
  attachmentDownloadUrl,
  createAttachment,
  createTask,
  deleteAttachment,
  deleteTask,
  getTask,
  listAttachments,
  listDependencies,
  listTasks,
  updateTask,
} from '../api'
import { parseTags } from '../tags'
import type { Attachment } from '../types/Attachment'
import type { Priority } from '../types/Priority'
import type { Status } from '../types/Status'
import { useFetch } from '../useFetch'
import { ConfirmDelete } from './ConfirmDelete'
import { InlineEdit } from './InlineEdit'
import { TaskRow } from './TaskRow'

const STATUSES: Status[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled']
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
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createTask({
      project_id: projectId,
      title,
      parent_id: parentId,
      // Subtasks stay 'todo' by default — only the top-level Add Task button
      // and INBOX triage default to 'backlog'.
      status: 'todo',
      // Omit when empty, matching CreateTaskPanel.
      ...(description === '' ? {} : { description }),
    }).then(
      () => {
        setTitle('')
        setDescription('')
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
      <textarea
        value={description}
        placeholder="description (optional)"
        onChange={(e) => setDescription(e.target.value)}
      />
      <button type="submit">add subtask</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * File picker that reads the selected file client-side and POSTs it as
 * base64 JSON — never FormData/multipart (the API only accepts
 * base64-in-JSON, see `api.ts`'s `AttachmentCreate`).
 */
function AttachmentUploadForm({
  taskId,
  onUploaded,
}: {
  taskId: number
  onUploaded: () => void
}) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset so selecting the same file again still fires onChange.
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL yields "data:<mime>;base64,<content>" — strip the prefix.
      const dataUrl = reader.result as string
      const content_base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      createAttachment(taskId, { filename: file.name, content_base64 }).then(
        () => {
          setUploading(false)
          onUploaded()
        },
        (err: unknown) => {
          setUploading(false)
          setError(err instanceof Error ? err.message : String(err))
        },
      )
    }
    reader.onerror = () => {
      setUploading(false)
      setError('failed to read file')
    }
    reader.readAsDataURL(file)
  }

  return (
    <p className="create-form">
      <input type="file" onChange={handleFile} disabled={uploading} />
      {uploading && <span className="muted"> uploading…</span>}
      {error && <span className="error"> {error}</span>}
    </p>
  )
}

function AttachmentRow({
  attachment,
  onDeleted,
}: {
  attachment: Attachment
  onDeleted: () => void
}) {
  const url = attachmentDownloadUrl(attachment.id)
  return (
    <li>
      <span className="attachment-name">{attachment.filename}</span>{' '}
      <span className="muted">
        {formatBytes(attachment.size_bytes)}
        {attachment.content_type && ` · ${attachment.content_type}`}
      </span>
      <div className="task-controls">
        <a href={url} download={attachment.filename}>
          download
        </a>
        <ConfirmDelete
          label="delete"
          message={`Delete "${attachment.filename}"?`}
          onDelete={() => deleteAttachment(attachment.id).then(onDeleted)}
        />
      </div>
      {attachment.content_type?.startsWith('image/') && (
        <img
          className="attachment-preview"
          src={url}
          alt={attachment.filename}
        />
      )}
    </li>
  )
}

/**
 * Task detail body, mounted inside `TaskModal`'s centered overlay. Mutations
 * call `onChanged` so the project view's list/board refetches alongside this
 * component's own refetch.
 */
export function TaskPanel({
  taskId,
  onClose,
  onChanged,
}: {
  taskId: number
  onClose: () => void
  onChanged: () => void
}) {
  const [selectError, setSelectError] = useState<string | null>(null)
  const { data, error, refetch } = useFetch(async () => {
    const task = await getTask(taskId)
    const [siblings, blockers, attachments] = await Promise.all([
      listTasks({ project: task.project_id }),
      listDependencies(taskId),
      listAttachments(taskId),
    ])
    // One level of nesting only (spec Assumption 6).
    const subtasks = siblings.filter((t) => t.parent_id === taskId)
    return { task, subtasks, blockers, attachments }
  }, `task-${taskId}`)

  const head = (
    <p className="panel-head">
      <button className="panel-close" onClick={onClose}>
        ✕
      </button>
    </p>
  )

  if (error)
    return (
      <>
        {head}
        <p className="error">{error}</p>
      </>
    )
  if (!data)
    return (
      <>
        {head}
        <p className="muted">Loading…</p>
      </>
    )

  const { task, subtasks, blockers, attachments } = data

  function changed() {
    refetch()
    onChanged()
  }

  // Status/priority save on change; errors land in the shared slot below.
  function patchSelect(patch: Parameters<typeof updateTask>[1]) {
    updateTask(taskId, patch).then(
      () => {
        setSelectError(null)
        changed()
      },
      (e: unknown) => {
        setSelectError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <>
      {head}
      <h1>
        #{task.id}{' '}
        <InlineEdit
          value={task.title}
          onSave={(title) => updateTask(taskId, { title }).then(changed)}
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
          onSave={(t) =>
            updateTask(taskId, { tags: parseTags(t) }).then(changed)
          }
        />
      </p>
      {task.parent_id !== null && (
        <p className="muted">
          Subtask of{' '}
          <a href={`#/projects/${task.project_id}/tasks/${task.parent_id}`}>
            task #{task.parent_id}
          </a>
        </p>
      )}
      <p className="description">
        <InlineEdit
          value={task.description ?? ''}
          multiline
          placeholder="no description — click to add"
          onSave={(d) =>
            updateTask(taskId, { description: d === '' ? null : d }).then(
              changed,
            )
          }
        />
      </p>
      <p>
        <ConfirmDelete
          label="delete task"
          message={`Deletes this task and ${subtasks.length} subtask(s).`}
          onDelete={() =>
            deleteTask(taskId).then(() => {
              onChanged()
              onClose()
            })
          }
        />
      </p>

      <h2>Subtasks</h2>
      <CreateSubtaskForm
        projectId={task.project_id}
        parentId={taskId}
        onCreated={changed}
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
              <a href={`#/projects/${b.project_id}/tasks/${b.id}`}>
                #{b.id} {b.title}
              </a>{' '}
              <span className={`badge status-${b.status}`}>{b.status}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Attachments</h2>
      <AttachmentUploadForm taskId={taskId} onUploaded={changed} />
      {attachments.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="card-list attachment-list">
          {attachments.map((a) => (
            <AttachmentRow key={a.id} attachment={a} onDeleted={changed} />
          ))}
        </ul>
      )}
    </>
  )
}
