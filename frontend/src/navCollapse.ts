// Which project subtrees are collapsed in the left nav (mesa task 668).
//
// Persisted in localStorage, the `navWidth.ts` / `lastFolder.ts` pattern —
// deliberately NOT the ephemeral `useState` the "Projects" and "archived"
// section headers use. Those two collapse one fixed group; this collapses a
// subtree the user arranged themselves, and having a nesting you curated snap
// back open on every reload is the whole complaint. Like the nav width it is a
// per-browser preference about one screen: no column, no route, no backup.
//
// A stored value is as untrusted as any other localStorage entry (hand-edited,
// left over from an older shape, written by a different version), so every
// path out of this module returns a clean `Set<number>` — a malformed entry
// reads as "nothing collapsed", never as a crash.

const KEY = 'mesa-nav-collapsed'

/** The collapsed project ids, or an empty set when nothing is stored or the
 *  stored value isn't an array of finite numbers. */
export function loadCollapsed(): Set<number> {
  const raw = localStorage.getItem(KEY)
  if (raw === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
  } catch {
    return new Set()
  }
}

export function saveCollapsed(ids: Set<number>): void {
  localStorage.setItem(KEY, JSON.stringify([...ids]))
}

/** `ids` with `id` collapsed or expanded — a new set, never a mutation, so a
 *  React state update actually re-renders. */
export function toggleCollapsed(ids: Set<number>, id: number): Set<number> {
  const next = new Set(ids)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * `ids` with every one of `ancestors` expanded.
 *
 * Navigating to a project inside a collapsed subtree has to reveal it —
 * otherwise the nav highlights a row nobody can see. Returns the SAME set when
 * nothing was collapsed, so the caller can skip a state write (and the render
 * loop it would cause) on the overwhelmingly common case.
 */
export function expandAncestors(ids: Set<number>, ancestors: number[]): Set<number> {
  if (!ancestors.some((a) => ids.has(a))) return ids
  const next = new Set(ids)
  for (const a of ancestors) next.delete(a)
  return next
}
