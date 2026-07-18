import { useState } from 'react'
import { createProject } from '../api'
import { DirBrowser } from './DirBrowser'

/**
 * New-project form, mirroring `CreateTaskPanel`'s shape: title (required),
 * description (optional), plus a folder picker unique to projects. The
 * folder field is optional — submitting without one behaves exactly like
 * the old inline sidebar form (name/description only, `local_path` unset).
 */
export function CreateProjectPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    createProject(
      name,
      description === '' ? undefined : description,
      localPath === '' ? undefined : localPath,
    ).then(
      () => {
        setSubmitting(false)
        onCreated()
      },
      (err: unknown) => {
        setSubmitting(false)
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
      <h2>New project</h2>
      <form className="panel-form" onSubmit={submit}>
        <input
          type="text"
          value={name}
          placeholder="title"
          required
          autoFocus
          disabled={submitting}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          value={description}
          placeholder="description (optional)"
          rows={4}
          disabled={submitting}
          onChange={(e) => setDescription(e.target.value)}
        />
        {browsing ? (
          <DirBrowser
            onSelect={(path) => {
              setLocalPath(path)
              setBrowsing(false)
            }}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
          <div className="dir-picker-field">
            <span className="dir-picker-value">
              {localPath || <span className="muted">no folder selected</span>}
            </span>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setBrowsing(true)}
            >
              choose folder…
            </button>
            {localPath !== '' && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => setLocalPath('')}
              >
                clear
              </button>
            )}
          </div>
        )}
        {!browsing && (
          <div className="inline-edit-actions">
            <button type="submit" disabled={submitting || name.trim() === ''}>
              create
            </button>
          </div>
        )}
        {error && <span className="error">{error}</span>}
      </form>
    </>
  )
}
