// Shared suppression predicates for mesa's global keyboard shortcuts (mesa
// spec 449, .scratch/arch-449-keyboard.md §1). Every global single-key
// shortcut listener (the 'a' create-task shortcut, and the h/j/k/l spatial
// nav) must check `shouldIgnoreShortcut` before acting on a keydown; a
// *chord* shortcut that steals a browser binding checks its own sibling
// below, for the reason set out there.

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

/** Which of the Files tab's chords is asking: `'find'` is Cmd/Ctrl+F, `'tabs'`
 * is Alt+W and Alt+[ / Alt+]. The two differ on exactly one control — see
 * `shouldIgnoreFilesShortcut`. */
export type FilesChord = 'find' | 'tabs'

/**
 * True when a Files-tab chord (Cmd/Ctrl+F, Alt+W, Alt+[ / Alt+]) must let the
 * keystroke go — to the browser's own binding, or to whatever else is on
 * screen.
 *
 * One predicate for all of them rather than one per chord: they ask nearly the
 * same question — "may the Files tab claim a chord right now?" — and two copies
 * of an answer are two things to keep in step. (It was
 * `shouldIgnoreFindShortcut` while find was the only chord; slice 4's tab
 * bindings gave it a second caller, not a second rule.) The `chord` argument is
 * the one place they part company, and it is required rather than defaulted so
 * a third caller has to say which kind it is instead of inheriting whichever
 * answer happened to be the default.
 *
 * A separate export rather than a branch of `shouldIgnoreShortcut`, because
 * that predicate's very first rule is "a modifier chord belongs to its existing
 * owner" — it answers `true` for every chord by construction, so a chord
 * shortcut cannot consult it and must not be the reason someone weakens it.
 * It lives here anyway, beside its sibling, so there is still exactly one file
 * that decides which surface may claim a keystroke; a hand-rolled check inside
 * a component is how one surface starts eating another's keys.
 *
 * Two reasons to stand down, both about *what is focused*, since the listener
 * is already scoped to a mounted, focused Files pane:
 * 1. A modal that owns its own keys is open (the shared `.create-task-backdrop`
 *    — create-task, create-project and the task detail — or the command
 *    palette). The Files tab is still mounted underneath it, and typing in a
 *    task field must never be interrupted by a find bar behind the modal.
 * 2. The caret is in a text control that is *not* the tab's own: the tree's
 *    new-file naming row, or any other field inside the tab. Two controls do
 *    claim these chords — the editor (`.files-content-editor`), since finding
 *    text in the file you are editing is the whole point, and the find bar's
 *    own box (`.files-find-input`), where a second Cmd/Ctrl+F is the reflex for
 *    "select what I typed and let me retype it".
 *
 * The find bar's box is where `'find'` and `'tabs'` part company, because the
 * two chords do not do the same thing to it: Cmd/Ctrl+F acts *in* that input,
 * while Alt+W and Alt+[ / ] act by tearing it down — the pane's active path
 * changes, `ContentPane` remounts and the bar is unmounted while its input holds
 * focus, which drops focus on `<body>` (Tab restarts at the top of the page,
 * Escape answers nothing). That is the precise outcome `closeFind`'s focus
 * hand-back exists to prevent, and the tab chords have nowhere to hand it: the
 * pane that would receive it does not exist yet at the moment they commit. So
 * they stand down while the caret is in the query box — a chord pressed *into* a
 * text field the user is typing in is the weaker claim of the two — and every
 * other route to those chords (the code editor, the file, the strip) is
 * untouched.
 */
export function shouldIgnoreFilesShortcut(
  e: KeyboardEvent,
  chord: FilesChord,
): boolean {
  if (
    document.querySelector(
      '.create-task-backdrop, .command-palette-backdrop',
    ) !== null
  )
    return true

  const target = e.target instanceof Element ? e.target : null
  const field = target?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  )
  if (
    field &&
    !field.classList.contains('files-content-editor') &&
    !(chord === 'find' && field.classList.contains('files-find-input'))
  )
    return true

  return false
}
