import { useEffect } from 'react'
import { TaskPanel } from './TaskPanel'

/**
 * Centered modal wrapper around `TaskPanel`, replacing the old right-hand
 * side-panel mount so task detail gets the full width of the viewport
 * instead of a 26rem column (mesa task 472).
 *
 * Mirrors `CreateTaskModal`: backdrop click and Escape both close, a click
 * inside the box does not. Reuses `.create-task-backdrop` — the shared
 * backdrop class (CreateProjectModal uses it too), and one of the selectors
 * `shouldIgnoreShortcut()` already watches, so global single-key shortcuts
 * stay suppressed while this is open (docs/keyboard.md).
 */
export function TaskModal({
  taskId,
  onClose,
  onChanged,
}: {
  taskId: number
  onClose: () => void
  onChanged: () => void
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Escape is layered: a text field owns it first. `InlineEdit` cancels an
      // open title/description/tags edit on Escape but does not stop the event
      // (InlineEdit.tsx), and the subtask draft fields have no Escape handler
      // at all — so closing the modal unconditionally would discard an edit or
      // a typed draft along with it, on the exact flow this modal exists for.
      // Skip those; a second Escape (nothing focused) closes the modal.
      const target = e.target instanceof Element ? e.target : null
      if (
        target?.closest(
          'input, textarea, [contenteditable=""], [contenteditable="true"]',
        )
      )
        return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="create-task-backdrop" onClick={onClose}>
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <TaskPanel taskId={taskId} onClose={onClose} onChanged={onChanged} />
      </div>
    </div>
  )
}
