import type { ReactNode } from 'react'

// --- Stable per-leaf PTY container pool ---------------------------------
//
// Fix for mesa task 399 / .scratch/arch.md §6: reparenting a leaf (a
// drag-to-edge split, or a cross-split move) changes the keyed child set at
// that tree position, so React unmounts/remounts the whole subtree there —
// including whatever `PtyTerminal` used to render right at that spot, which
// would close its websocket and (for the Terminal page, no server-side
// session to reconnect to) permanently kill the shell process.
//
// The fix: a leaf's `PtyTerminal` never renders at the tree position at all.
// It renders once, here, into a plain `document.createElement('div')` this
// pool owns and never recreates for a given leaf id's whole life. `PtySlot`
// (the tree-position placeholder, `./PtySlot.tsx` equivalent — see
// `frontend/src/components/PtySlot.tsx`) just `appendChild`s that stable
// container into wherever its own slot div currently lives. A reparent
// relocates the slot div (a fresh mount, fresh layout effect) but the
// container — and everything portaled into it — is simply moved, not
// recreated: no unmount, no reconnect, no lost scrollback.
//
// Shared by both `AgentSidebar.tsx` and `TerminalPage.tsx` — same bug class,
// same mechanism, one flat id namespace (safe: ids are minted by
// `newSplitId()` / are `claude agents --json` session ids, no cross-surface
// coordination needed, not a realistic collision risk).

type PoolEntry = {
  endpoint: string
  closedMessage: ReactNode
  container: HTMLDivElement
}

const pool = new Map<string, PoolEntry>()

// A referentially-stable snapshot array, rebuilt only when the pool's own
// membership actually changes (`ensure`/`remove` below) — never on every
// `getIds()` call. `useSyncExternalStore` (in `PtyPool.tsx`) treats any new
// array identity as a change; returning a fresh array on every read would
// make a reparent (which calls `ensure` again for an id that's already
// registered, an idempotent no-op) look like a membership change too,
// either throwing ("getSnapshot should be cached") or looping. Precisely
// because `ensure` only rebuilds the snapshot on a genuinely NEW id, a
// reparent produces no `PtyPool` re-render at all — the container just
// moves via `appendChild`, and the portal keeps rendering into the same
// node regardless of where in the DOM that node currently lives.
let idsSnapshot: string[] = []
const listeners = new Set<() => void>()

function notify(): void {
  idsSnapshot = Array.from(pool.keys())
  for (const l of listeners) l()
}

/**
 * Idempotent: returns the existing entry untouched (no `notify()`, no new
 * container) if `id` is already registered — this is what makes a reparent
 * a no-op here. Only creates a new stable container, registers it, and
 * notifies subscribers the first time a given leaf id is seen.
 */
export function ensure(
  id: string,
  descriptor: { endpoint: string; closedMessage: ReactNode },
): PoolEntry {
  const existing = pool.get(id)
  if (existing) return existing
  const container = document.createElement('div')
  // Matches what `PtyTerminal`'s own wrapper used to inherit for free as a
  // direct flex child of `.agent-sidebar-pane` — there's now an extra DOM
  // layer (`PtySlot`'s own div) between the flex parent and this container,
  // so this sizing has to be carried over by hand.
  container.style.flex = '1 1 auto'
  container.style.display = 'flex'
  container.style.minWidth = '0'
  container.style.minHeight = '0'
  container.style.width = '100%'
  container.style.height = '100%'
  const entry: PoolEntry = { endpoint: descriptor.endpoint, closedMessage: descriptor.closedMessage, container }
  pool.set(id, entry)
  notify()
  return entry
}

/**
 * Explicit removal only — called at the exact call sites that actually
 * close a leaf (never inferred from tree diffing; see arch.md §6.2/§6.5). A
 * plain reparent never calls this, so its container/process survive
 * untouched.
 */
export function remove(id: string): void {
  if (!pool.has(id)) return
  pool.delete(id)
  notify()
}

export function get(id: string): PoolEntry | undefined {
  return pool.get(id)
}

export function getIds(): string[] {
  return idsSnapshot
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
