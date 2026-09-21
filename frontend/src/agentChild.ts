// The child cards hanging off an agent row (mesa task 1277) — the three
// decisions they need, kept out of `AgentSidebar.tsx` so they can be
// unit-tested (the repo's rule: logic worth testing never lives inline in a
// `.tsx`).
//
// Everything here is pure: the elapsed clock takes `now` as an argument
// rather than reading `Date.now()`, exactly as `timeAgo` in `time.ts` does,
// so a test pins a duration instead of chasing one.

import type { AgentChild } from './types/AgentChild'
import { responsePreview } from './agentRow'
import { parseTimestamp } from './time'

/**
 * The one-line label a child card leads with: a subagent's agent type
 * (`implementer`, `diff-reviewer`), a shell's command line.
 *
 * Both arrive bounded from the server; this only makes them fit on one line,
 * collapsing every run of whitespace the way `responsePreview` does — a
 * multi-line `bash -c` script would otherwise turn the card into a block.
 * The caller puts the same string in `title`, so the clamped line stays
 * readable in full.
 *
 * Never `null`: a card with no label is unreadable, so a name that survives
 * nothing falls back to what kind of thing it is.
 */
export function childLabel(child: AgentChild): string {
  return responsePreview(child.name) ?? child.kind
}

/**
 * How long a child has been running, in the compact form a card has room
 * for: `7s`, `4m`, `2h`, `3d`. Floors rather than rounds, so it never claims
 * more time than has passed, and a clock-skewed future stamp reads `0s`
 * rather than a negative.
 *
 * `null` — and therefore nothing rendered — when the server could not say
 * when this child started. An absent start time must not read as one that
 * started this instant.
 */
export function childElapsed(startedAt: string | null, now: number): string | null {
  if (startedAt === null) return null
  const started = parseTimestamp(startedAt).getTime()
  if (!Number.isFinite(started)) return null
  const secs = Math.max(0, Math.floor((now - started) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The order the cards are rendered in: **running before finished**, and
 * within each state **subagents before shells**.
 *
 * State outranks kind because a finished subagent is only still on screen at
 * all while its transcript stays inside the freshness window — it is on its
 * way out, and must not sit above work that is still happening. Subagents
 * lead their state because one stands for a whole delegated job while a
 * shell is a single tool call, and a session running several shells would
 * otherwise bury it.
 *
 * Stable within a group: the server's order is the transcript/process order,
 * which is what keeps a card from hopping between polls.
 */
export function orderedChildren(children: AgentChild[]): AgentChild[] {
  const rank = (child: AgentChild) =>
    (child.state === 'running' ? 0 : 2) + (child.kind === 'subagent' ? 0 : 1)
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => rank(a.child) - rank(b.child) || a.index - b.index)
    .map(({ child }) => child)
}
