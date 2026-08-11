// Which open files have unsaved edits, and what that costs a close (mesa task
// 809, slice 4).
//
// Same reason `fileTabs.ts` exists (CLAUDE.md): "is this tab dirty" and "would
// closing it throw work away" are predicates, and a predicate that decides
// whether the app warns you is exactly the kind that historically ships wrong —
// so it lives where vitest can reach it rather than inline in `FilesView.tsx`.
// The `.tsx` keeps the state and the DOM; every question this file names is
// answered here.
//
// It deliberately owns no state of its own. `FilesView` already keeps one
// `FileUiState` per open path and already drops it when the last tab for that
// path closes; this module reads that map, it does not duplicate it.

import { paneOf, type PaneSide, type TabsState } from './fileTabs'

/**
 * The part of a tab's view state that decides dirtiness.
 *
 * A structural subset of `FileUiState` rather than an import of it, so this
 * module stays a function of three plain fields — that is what lets a test
 * describe a dirty tab without building the rest of the Files tab's state.
 *
 * `baseline` is the file's bytes as they were when editing started (and as
 * they are again after a successful save). Comparing against it rather than
 * against the live fetched content is what makes this answerable *outside* the
 * mounted pane: only `ContentPane` has the response in hand, and the tab strip
 * that has to paint the dot is two components above it.
 */
export interface DraftState {
  editing: boolean
  draft: string
  baseline: string
}

/**
 * True when this tab is holding work that is not on disk.
 *
 * `editing` is part of the test, not an optimization: cancelling an edit leaves
 * the abandoned draft in place (that is what lets a re-open of the same tab
 * still show it), and a cancelled edit is not unsaved work the user is about to
 * lose — they already said to drop it.
 *
 * A missing entry is a file nobody has opened the editor on, which is clean.
 */
export function isDirty(ui: DraftState | undefined): boolean {
  if (ui === undefined || !ui.editing) return false
  return ui.draft !== ui.baseline
}

/** Every path with unsaved edits — the key set the tab strips paint a dot for,
 *  and the one `beforeunload` is armed by. A set rather than a boolean because
 *  each strip asks about its own tabs, and re-deriving per tab would walk the
 *  map once per tab. */
export function dirtyPaths(
  fileUi: ReadonlyMap<string, DraftState>,
): Set<string> {
  const out = new Set<string>()
  for (const [path, ui] of fileUi) if (isDirty(ui)) out.add(path)
  return out
}

/**
 * Whether closing this tab has to ask first.
 *
 * Dirty is only half of it. The same path may be open in **both** panes of a
 * split (`fileTabs.ts`'s one allowed duplicate), and `FilesView` drops a draft
 * only when the *last* tab for a path closes — so closing one of the two
 * destroys nothing and a prompt would be a lie about what the click does. Only
 * the close that would take the draft with it is worth interrupting.
 */
export function needsCloseConfirm(
  state: TabsState,
  side: PaneSide,
  path: string,
  dirty: ReadonlySet<string>,
): boolean {
  if (!dirty.has(path)) return false
  const pane = paneOf(state, side)
  if (pane === null || !pane.tabs.includes(path)) return false
  const other = side === 'left' ? state.right : state.left
  return !(other?.tabs.includes(path) ?? false)
}

/** A tab's accessible name. The dot beside the label is `aria-hidden` — it is a
 *  convention a sighted editor user reads instantly and a screen reader cannot
 *  read at all — so the state has to arrive in words somewhere, and the label
 *  the tab is activated by is that place. */
export function tabLabel(path: string, dirty: boolean): string {
  return dirty ? `${path} — unsaved changes` : path
}

/** The close button's accessible name, which carries the same warning: the ×
 *  and the tab label are two different controls, and a screen reader user may
 *  well meet the × first. */
export function closeLabel(path: string, dirty: boolean): string {
  return dirty ? `Close ${path} — unsaved changes` : `Close ${path}`
}
