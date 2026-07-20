// Shared suppression predicate for mesa's global single-key keyboard
// shortcuts (mesa spec 449, .scratch/arch-449-keyboard.md §1). Every global
// shortcut listener (the 'a' create-task shortcut, and the h/j/k/l spatial
// nav to follow) must check this before acting on a keydown.

/**
 * True when a global single-key shortcut must ignore this keystroke.
 *
 * Checks, in order:
 * 1. A modifier chord (Cmd/Ctrl/Alt) is held — those belong to their
 *    existing owners (Cmd/Ctrl+Shift+P command palette, Cmd/Ctrl+D
 *    duplicate-frame, etc).
 * 2. The event target is inside a text input, textarea, contenteditable, or
 *    native <select> — typing and native select option-cycling/type-ahead.
 * 3. The event target is inside an xterm terminal pane (`.xterm` or
 *    `.agent-terminal`).
 * 4. A storyboard canvas is mounted anywhere on the page (`.storyboard`) —
 *    it owns its own key handling and is its own spatial surface.
 * 5. A modal that owns its own key handling is open (create-task/
 *    create-project/command-palette backdrops).
 */
export function shouldIgnoreShortcut(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true

  const target = e.target instanceof Element ? e.target : null

  if (
    target?.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    )
  )
    return true

  if (target?.closest('.xterm, .agent-terminal')) return true

  if (document.querySelector('.storyboard') !== null) return true

  if (
    document.querySelector(
      '.create-task-backdrop, .command-palette-backdrop',
    ) !== null
  )
    return true

  return false
}
