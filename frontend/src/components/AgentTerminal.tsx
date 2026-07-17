import type { ReactNode } from 'react'

/**
 * Descriptor (endpoint + "closed" copy) for one agent session's PTY —
 * `/api/agents/:id/attach`. No longer a rendered component: mesa task 399
 * (.scratch/arch.md §6.2) demoted it from mounting its own `PtyTerminal` to
 * this thin pure helper, since `AgentPane` (`AgentSidebar.tsx`) now renders
 * a `PtySlot` directly at its tree position, backed by the always-mounted
 * `PtyPool` — the terminal itself lives in the pool, not here, so a
 * split/move reparent never remounts it. This file keeps just the
 * `{endpoint, closedMessage}` derivation so `AgentSidebar.tsx` doesn't
 * duplicate it.
 */
export function agentTerminalDescriptor(agentId: string): { endpoint: string; closedMessage: ReactNode } {
  return {
    endpoint: `/api/agents/${agentId}/attach`,
    closedMessage: 'connection closed — the background session keeps running in the folder',
  }
}
