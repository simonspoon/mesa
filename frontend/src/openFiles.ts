// Each project's open Files-tab tabs, remembered across leaving and returning
// (mesa task 696). Machine-local (localStorage), like lastView.ts /
// lastFolder.ts / filesTreeWidth.ts — never project or server data, so there is
// no DB column, no API route and no CLI flag behind it.
//
// Only `TabsState` is stored: the two panes' tabs, their active tab, which pane
// is focused and the split ratio. Deliberately *not* stored: edit drafts and
// the rest of `fileUi` (an unsaved draft surviving a browser restart is a
// different, riskier feature), tree expansion and scroll.
//
// `fileTabs.ts` stays storage-free — it is the pure transitions module, and
// this one is the pure storage module that sanitizes into it.

import {
  clampRatio,
  collapseSplit,
  emptyTabsState,
  type Pane,
  type TabsState,
} from './fileTabs'

const KEY = 'mesa-open-files'

/** The id → state map, total: absent, unparseable and non-object all read as
 *  an empty map, same posture as `lastView.ts`'s `readProjectTabs()`. */
function readAll(): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) ?? '')
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

/** A pane out of untrusted JSON, repaired rather than rejected: non-strings and
 *  duplicates drop out of `tabs`, and an `active` that isn't a member becomes
 *  the first tab — the invariants `fileTabs.ts` documents, restored. */
function sanitizePane(raw: unknown): Pane {
  if (raw === null || typeof raw !== 'object') return { tabs: [], active: null }
  const { tabs, active } = raw as { tabs?: unknown; active?: unknown }
  const seen = new Set<string>()
  if (Array.isArray(tabs)) {
    for (const t of tabs) if (typeof t === 'string' && t !== '') seen.add(t)
  }
  const list = [...seen]
  const at = typeof active === 'string' && seen.has(active) ? active : (list[0] ?? null)
  return { tabs: list, active: at }
}

function sanitize(raw: unknown): TabsState {
  if (raw === null || typeof raw !== 'object') return emptyTabsState()
  const v = raw as { left?: unknown; right?: unknown; focused?: unknown; ratio?: unknown }
  let left = sanitizePane(v.left)
  // A pane with no tabs can't be half of a split — the transitions collapse
  // one the moment it empties, so a stored one is corrupt, not a state to keep.
  let right = v.right === null || v.right === undefined ? null : sanitizePane(v.right)
  if (right !== null && right.tabs.length === 0) right = null
  if (left.tabs.length === 0 && right !== null) {
    left = right
    right = null
  }
  return {
    left,
    right,
    focused: right !== null && v.focused === 'right' ? 'right' : 'left',
    ratio: clampRatio(typeof v.ratio === 'number' ? v.ratio : NaN),
  }
}

/**
 * This project's remembered open set, or an empty one for anything absent or
 * unusable. Never throws and never returns a state violating `fileTabs.ts`'s
 * invariants.
 *
 * `narrow` folds a stored split before returning: `onNarrowTierChange` is
 * edge-triggered, so a split stored on a wide screen and restored on a 360px
 * one would otherwise never be folded.
 */
export function loadOpenFiles(projectId: number, narrow: boolean): TabsState {
  const state = sanitize(readAll()[String(projectId)])
  return narrow ? collapseSplit(state) : state
}

/** Record this project's open set. An empty one **deletes** the entry rather
 *  than storing an empty object, so the key doesn't accumulate noise. */
export function saveOpenFiles(projectId: number, state: TabsState): void {
  const all = readAll()
  const id = String(projectId)
  if (state.left.tabs.length === 0 && (state.right?.tabs.length ?? 0) === 0) {
    if (!(id in all)) return
    delete all[id]
  } else {
    all[id] = state
  }
  localStorage.setItem(KEY, JSON.stringify(all))
}
