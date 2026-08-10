import { useEffect } from 'react'
import { ScriptRunPanel } from './ScriptRunPanel'
import type { Script } from '../types/Script'

/**
 * Centered modal wrapper around `ScriptRunPanel`, the twin of
 * `CreateTaskModal`: backdrop click and Escape both close it, a click inside
 * the box does not.
 *
 * It reuses `.create-task-backdrop` / `.create-task-modal` on purpose. Those
 * class names are what `keyboardScope.ts::shouldIgnoreShortcut` keys the
 * global single-key shortcuts off, so mounting the run form inside them means
 * typing an argument value can never fire a board shortcut — with zero changes
 * to that module.
 */
export function ScriptRunModal({
  script,
  onClose,
}: {
  script: Script
  onClose: () => void
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="create-task-backdrop" onClick={onClose}>
      <div className="create-task-modal" onClick={(e) => e.stopPropagation()}>
        <ScriptRunPanel script={script} onClose={onClose} />
      </div>
    </div>
  )
}
