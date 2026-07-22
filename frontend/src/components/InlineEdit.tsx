import { useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * True when the event came from a link inside rendered markdown. Such a link
 * owns its own click/Enter — following it must not also drop the field into
 * edit mode.
 */
function fromLink(e: React.SyntheticEvent): boolean {
  return e.target instanceof Element && e.target.closest('a') !== null
}

/**
 * Click-to-edit text field: renders the value (or a muted placeholder),
 * clicking switches to an input/textarea with save/cancel. Enter saves
 * (single-line only), Escape cancels. Save errors (e.g. the API's 422 on
 * an empty title) render inline and keep edit mode open, so the previous
 * value survives a cancel.
 *
 * `markdown` renders the *display* value through `Markdown` (the edit field
 * always shows the raw source). It is opt-in because the markdown branch has
 * to change the wrapper element: react-markdown emits block elements
 * (`<p>`, `<ul>`, `<table>`), which are invalid inside the `<span>` the plain
 * branch uses, so browsers would silently reparent them and wreck the layout.
 * Callers must likewise not wrap a markdown InlineEdit in a `<p>`.
 */
export function InlineEdit({
  value,
  onSave,
  multiline = false,
  markdown = false,
  placeholder = 'empty — click to edit',
  className,
}: {
  value: string
  /** Resolve to exit edit mode (caller refetches); reject to show the error. */
  onSave: (next: string) => Promise<unknown>
  multiline?: boolean
  /** Render the display value as markdown. Forces a block-level wrapper. */
  markdown?: boolean
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
    const classes = `inline-edit${className ? ` ${className}` : ''}`
    const activation = {
      title: 'click to edit',
      role: 'button' as const,
      tabIndex: 0,
      onClick: (e: React.MouseEvent) => {
        if (!fromLink(e)) start()
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !fromLink(e)) start()
      },
    }
    const empty = <span className="muted">{placeholder}</span>
    // Block wrapper for markdown — see the note on the `markdown` prop.
    if (markdown)
      return (
        <div className={`${classes} markdown-body`} {...activation}>
          {value ? <Markdown text={value} /> : empty}
        </div>
      )
    return (
      <span className={classes} {...activation}>
        {value || empty}
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

  const editBody = (
    <>
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
    </>
  )
  const editClasses = `inline-edit editing${className ? ` ${className}` : ''}`
  // Match the display branch's wrapper so switching in and out of edit mode
  // doesn't change the element type under the caller's layout.
  return markdown ? (
    <div className={editClasses}>{editBody}</div>
  ) : (
    <span className={editClasses}>{editBody}</span>
  )
}
