import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import * as ptyPool from '../lib/ptyPool'

/**
 * Tree-position placeholder for one leaf's PTY (mesa task 399 /
 * .scratch/arch.md §6.2). Renders AT the leaf's actual position in
 * `AgentPane`'s / `ShellPane`'s tree — but as a purely imperative mount
 * point: it never has React-rendered children of its own. Its
 * `useLayoutEffect` moves the leaf's stable pool container (owned by
 * `PtyPool`, `./PtyPool.tsx`) into this slot's own div via `appendChild`,
 * which relocates the container from wherever it currently lives (even a
 * different slot mid-unmount) with no unmount of whatever's portaled inside
 * it.
 *
 * `ensure()` is called from INSIDE this same layout effect, not from a
 * separate effect on the owning surface (`AgentSidebar`/`TerminalPage`) —
 * load-bearing ordering, not a style choice. React runs a child's layout
 * effects before its parent's; if registration lived in a passive effect up
 * in the parent, the sequence on first mount would be: this effect runs
 * first and finds nothing registered yet (no `appendChild`), then the
 * parent's effect creates the container afterward with nothing left to
 * re-run this effect and attach it — a permanently detached, invisible
 * terminal. Colocating `ensure` here makes "create the container" and
 * "attach it to this slot" the same synchronous step every time.
 *
 * Only ever mounted by a leaf that actually wants a PTY: `AgentSidebar`'s
 * every tree leaf is now an attached agent terminal (mesa task 414 pulled
 * the 'Agents' session list out of the tree into its own fixed rail), so
 * there is no separate "skip a non-PTY leaf" registration path to get
 * right — only leaves that render a `PtySlot` ever register at all.
 */
export function PtySlot({
  id,
  endpoint,
  closedMessage,
}: {
  id: string
  endpoint: string
  closedMessage: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Idempotent: a no-op that just returns the existing entry if `id` is
    // already registered (e.g. this slot mounted because its leaf was
    // reparented, not newly opened). Deliberately `[id]` only, not
    // `[id, endpoint, closedMessage]` (arch.md §6.2): a leaf's endpoint/
    // closed-copy never changes across its own lifetime — re-running this
    // on every parent re-render (which would happen if `closedMessage`,
    // often a fresh string each render even when equal by value, were
    // treated as needing a re-run) is unnecessary churn, not correctness.
    const entry = ptyPool.ensure(id, { endpoint, closedMessage })
    if (ref.current) ref.current.appendChild(entry.container)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return <div ref={ref} className="pty-slot" />
}
