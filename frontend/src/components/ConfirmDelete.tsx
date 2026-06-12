import { useState } from 'react'

/**
 * Two-step inline delete: the first click arms it, showing the cascade
 * message ("Deletes 4 tasks") with confirm/cancel in place — no native
 * dialog, no modal. Errors from the DELETE render inline.
 */
export function ConfirmDelete({
  label,
  message,
  onDelete,
}: {
  label: string
  /** What confirming destroys, e.g. "Deletes 4 task(s)". */
  message: string
  /** Resolve on success (caller navigates away); reject to show the error. */
  onDelete: () => Promise<unknown>
}) {
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function confirm() {
    setDeleting(true)
    onDelete().catch((e: unknown) => {
      setDeleting(false)
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  if (!armed) {
    return (
      <button className="danger" onClick={() => setArmed(true)}>
        {label}
      </button>
    )
  }

  return (
    <span className="confirm-delete">
      <span className="confirm-message">{message}</span>
      <button className="danger" onClick={confirm} disabled={deleting}>
        confirm
      </button>
      <button onClick={() => setArmed(false)} disabled={deleting}>
        cancel
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  )
}
