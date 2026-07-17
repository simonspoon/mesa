import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import * as ptyPool from '../lib/ptyPool'
import { PtyTerminal } from './PtyTerminal'

/**
 * The single always-mounted owner of every open leaf's `PtyTerminal` (mesa
 * task 399 / .scratch/arch.md §6.2). Portals one `<PtyTerminal>` per
 * registered pool entry into that entry's own stable container — a node
 * whose identity never changes for a leaf's whole life, so relocating that
 * container across tree positions (`PtySlot`'s `appendChild`) never
 * unmounts the portaled subtree.
 *
 * Mounted once, unconditionally, in `App.tsx` as a permanent sibling of
 * `AgentSidebar`/`TerminalPage` — never inside the routed page. Re-renders
 * only when the pool's own membership changes (a real open/close), never on
 * a reparent (see `ptyPool.ts`'s `notify()` comment).
 */
export function PtyPool() {
  const ids = useSyncExternalStore(ptyPool.subscribe, ptyPool.getIds)
  return (
    <>
      {ids.map((id) => {
        const e = ptyPool.get(id)
        if (!e) return null
        return createPortal(
          <PtyTerminal key={id} endpoint={e.endpoint} closedMessage={e.closedMessage} />,
          e.container,
        )
      })}
    </>
  )
}
