import { useState } from 'react'
import { createAttachment, createTask } from '../api'
import { imageFilesFromClipboard } from '../clipboardFiles'
import { parseTags } from '../tags'
import type { Priority } from '../types/Priority'

const PRIORITIES: Priority[] = ['low', 'medium', 'high']

// Mirrors AttachmentUploadForm's (TaskPanel.tsx) client-side base64 read —
// the API only accepts base64-in-JSON, never FormData/multipart.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * New-task form in the right-hand panel. A successful create calls
 * `onCreated` (the page refetches and collapses the panel); the close
 * button discards without saving.
 *
 * Files staged below the fields are uploaded as attachments right after the
 * task is created (attachments require an existing task id — there's no
 * "stage before create" endpoint). If some uploads fail, the task itself
 * still exists: the form stays open with only the failed files staged so
 * submitting again retries just those, instead of creating a duplicate task.
 * A clipboard image pasted anywhere in the form stages the same way — see
 * `clipboardFiles.ts` for why it arrives renamed.
 *
 * The submit button sends no `status`, so the API defaults new tasks to
 * `backlog` (spec 302).
 */
export function CreateTaskPanel({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: number
  onClose: () => void
  onCreated: () => void
}) {
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [tags, setTags] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [createdTaskId, setCreatedTaskId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length > 0) setPendingFiles((prev) => [...prev, ...files])
  }

  // Clipboard images stage exactly like picked files (task 775). The handler
  // lives on the <form>, not window/document, so it only fires while the modal
  // has focus and never touches the global keyboard machinery
  // (`keyboardScope.ts` / `shouldIgnoreShortcut()`).
  function pasteFiles(e: React.ClipboardEvent<HTMLFormElement>) {
    if (submitting || createdTaskId !== null) return
    const files = imageFilesFromClipboard(e.clipboardData, Date.now())
    // No image -> no preventDefault, so a text paste into the description or
    // the tags input still inserts text.
    if (files.length === 0) return
    e.preventDefault()
    setPendingFiles((prev) => [...prev, ...files])
  }

  function removeFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      let taskId = createdTaskId
      if (taskId === null) {
        const task = await createTask({
          project_id: projectId,
          description,
          priority,
          tags: parseTags(tags),
        })
        taskId = task.id
        setCreatedTaskId(taskId)
      }
      const results = await Promise.all(
        pendingFiles.map((file) =>
          readFileAsBase64(file)
            .then((content_base64) =>
              createAttachment(taskId as number, {
                filename: file.name,
                content_base64,
              }),
            )
            .then(
              () => ({ file, ok: true as const }),
              (err: unknown) => ({
                file,
                ok: false as const,
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
        ),
      )
      const failed = results.filter((r) => !r.ok)
      setPendingFiles(failed.map((r) => r.file))
      setSubmitting(false)
      if (failed.length > 0) {
        setError(
          `task created; ${failed.length} attachment(s) failed to upload — remove or retry`,
        )
        return
      }
      onCreated()
    } catch (err) {
      setSubmitting(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <p className="panel-head">
        <button className="panel-close" onClick={onClose}>
          ✕
        </button>
      </p>
      <h2>New task</h2>
      <form
        className="panel-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onPaste={pasteFiles}
      >
        {/* The one identity field (task 660). It keeps the autoFocus the
            title input used to hold: the `a` shortcut and the command
            palette both open this form expecting a focused first field. */}
        <textarea
          value={description}
          placeholder="what the task is — the first line becomes its name"
          rows={4}
          required
          autoFocus
          disabled={createdTaskId !== null}
          onChange={(e) => setDescription(e.target.value)}
        />
        <select
          value={priority}
          disabled={createdTaskId !== null}
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
          disabled={createdTaskId !== null}
          onChange={(e) => setTags(e.target.value)}
        />
        <input type="file" multiple onChange={addFiles} disabled={submitting} />
        {pendingFiles.length > 0 && (
          <ul className="card-list">
            {pendingFiles.map((file, i) => (
              <li key={i}>
                <span className="attachment-name">{file.name}</span>{' '}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => removeFile(i)}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="inline-edit-actions">
          <button type="submit" disabled={submitting}>
            {createdTaskId === null
              ? 'create'
              : pendingFiles.length > 0
                ? `retry ${pendingFiles.length} attachment(s)`
                : 'done'}
          </button>
        </div>
        {error && <span className="error">{error}</span>}
      </form>
    </>
  )
}
