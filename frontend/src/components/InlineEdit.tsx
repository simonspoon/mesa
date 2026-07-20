import { useLayoutEffect, useRef, useState } from 'react'

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * Click-to-edit text field: renders the value (or a muted placeholder),
 * clicking switches to an input/textarea with save/cancel. Enter saves
 * (single-line only), Escape cancels. Save errors (e.g. the API's 422 on
 * an empty title) render inline and keep edit mode open, so the previous
 * value survives a cancel.
 */
export function InlineEdit({
  value,
  onSave,
  multiline = false,
  placeholder = 'empty — click to edit',
  className,
}: {
  value: string
  /** Resolve to exit edit mode (caller refetches); reject to show the error. */
  onSave: (next: string) => Promise<unknown>
  multiline?: boolean
  placeholder?: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Existing descriptions can already span many lines, so size once on
  // entering edit mode, not just as the user types.
  useLayoutEffect(() => {
    if (editing && multiline) autosize(textareaRef.current)
  }, [editing, multiline])

  function start() {
    setDraft(value)
    setError(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  function save() {
    setSaving(true)
    onSave(draft).then(
      () => {
        setSaving(false)
        setEditing(false)
        setError(null)
      },
      (e: unknown) => {
        setSaving(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (!editing) {
    return (
      <span
        className={`inline-edit${className ? ` ${className}` : ''}`}
        title="click to edit"
        role="button"
        tabIndex={0}
        onClick={start}
        onKeyDown={(e) => {
          if (e.key === 'Enter') start()
        }}
      >
        {value || <span className="muted">{placeholder}</span>}
      </span>
    )
  }

  const field = multiline ? (
    <textarea
      ref={textareaRef}
      autoFocus
      value={draft}
      rows={4}
      onChange={(e) => {
        setDraft(e.target.value)
        autosize(e.target)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel()
      }}
    />
  ) : (
    <input
      autoFocus
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') cancel()
      }}
    />
  )

  return (
    <span className={`inline-edit editing${className ? ` ${className}` : ''}`}>
      {field}
      <span className="inline-edit-actions">
        <button onClick={save} disabled={saving}>
          save
        </button>
        <button onClick={cancel} disabled={saving}>
          cancel
        </button>
      </span>
      {error && <span className="error">{error}</span>}
    </span>
  )
}
