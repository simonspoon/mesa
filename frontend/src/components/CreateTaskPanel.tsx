import { useState } from 'react'
import { createTask } from '../api'
import { parseTags } from '../tags'
import type { Priority } from '../types/Priority'

const PRIORITIES: Priority[] = ['low', 'medium', 'high']

/**
 * New-task form in the right-hand panel. A successful create calls
 * `onCreated` (the page refetches and collapses the panel); the close
 * button discards without saving.
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
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createTask({
      project_id: projectId,
      title,
      description: description === '' ? undefined : description,
      priority,
      tags: parseTags(tags),
    }).then(
      () => {
        setError(null)
        onCreated()
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <>
      <p className="panel-head">
        <button className="panel-close" onClick={onClose}>
          ✕
        </button>
      </p>
      <h2>New task</h2>
      <form className="panel-form" onSubmit={submit}>
        <input
          type="text"
          value={title}
          placeholder="title"
          required
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          value={description}
          placeholder="description (optional)"
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
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
    </>
  )
}
