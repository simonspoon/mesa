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

// --- The read-only child pane (mesa task 1278) -------------------------
//
// Tapping a child card opens it as a pane beside its parent, so every child
// needs a **pane id**: unique across the sidebar's one tree, and stable for
// the whole life of the child — a poll that reorders the cards, or drops one,
// must not rename an open pane out from under itself. An index is therefore
// not usable, and neither is the card's rendered label.

/** Marks a pane id as a child's rather than an agent's. A background job id
 *  is a short opaque token from `claude agents --json` and carries no colon,
 *  so the two id spaces cannot collide. */
const CHILD_PANE_PREFIX = 'child:'

/** What a child pane id says: whose child it is, and which child. */
export type ChildPaneRef = {
  /** The parent pane's own id — the background job id the agent pane is
   *  keyed by, and the row this pane's data is looked up under. */
  parentId: string
  /** The subagent transcript id this pane reads, or `null` for a shell. */
  agentId: string | null
  /** The command line a shell pane is keyed by, or `null` for a subagent. */
  name: string | null
}

/**
 * The pane id for one child of `parentId`.
 *
 * A subagent is keyed by its transcript id — the same id the pane fetches its
 * conversation with, and the only thing about a subagent that never changes.
 * Everything else about it (its detail line, its token count, its state) moves
 * on every poll.
 *
 * A shell has no such id (`AgentChild.id` is `null` for one, deliberately:
 * a `ps` row holds nothing transcript-derived), so it is keyed by its
 * **command line** — which is a shell's whole identity for the whole of its
 * life, since the process leaves the table the instant its Bash call returns.
 * A subagent whose id failed to read falls back to the same rule rather than
 * to no pane at all.
 */
export function childPaneId(parentId: string, child: AgentChild): string {
  return child.id !== null
    ? `${CHILD_PANE_PREFIX}${parentId}:sub:${child.id}`
    : `${CHILD_PANE_PREFIX}${parentId}:cmd:${child.name}`
}

/** Whether a pane id names a child rather than an attached agent — the one
 *  test the sidebar's ptyPool calls are guarded by, since a child pane owns no
 *  PTY to remove. */
export function isChildPaneId(paneId: string): boolean {
  return paneId.startsWith(CHILD_PANE_PREFIX)
}

/**
 * Read a child pane id back. `null` for anything that is not one — including
 * a truncated one, so a malformed id renders nothing rather than a pane
 * pointing at an empty parent.
 *
 * Only the first two separators are structural: a command line may itself
 * contain colons, so the rest of the id is taken whole.
 */
export function parseChildPaneId(paneId: string): ChildPaneRef | null {
  if (!isChildPaneId(paneId)) return null
  const rest = paneId.slice(CHILD_PANE_PREFIX.length)
  const split = rest.indexOf(':')
  if (split <= 0) return null
  const parentId = rest.slice(0, split)
  const tail = rest.slice(split + 1)
  if (tail.startsWith('sub:')) return { parentId, agentId: tail.slice(4), name: null }
  if (tail.startsWith('cmd:')) return { parentId, agentId: null, name: tail.slice(4) }
  return null
}

/**
 * The child a pane is showing, out of its parent session's current children —
 * or `null` when it is no longer among them.
 *
 * `null` is a normal state, not an error: a subagent stays listed only while
 * its transcript is inside the freshness window, and a shell leaves the
 * process table the moment its call returns. The pane goes on rendering what
 * it can (a subagent's transcript is still on disk), so this only decides
 * whether the live figures — tokens, elapsed, state — have anything to say.
 */
export function childForPane(ref: ChildPaneRef, children: AgentChild[]): AgentChild | null {
  return (
    children.find((c) => (ref.agentId !== null ? c.id === ref.agentId : c.id === null && c.name === ref.name)) ?? null
  )
}

/**
 * What to call the child a pane is showing. Prefers the live row's own label,
 * since that is the agent type a card shows; falls back to the id the pane
 * was opened under, so a child that has left the list keeps its name rather
 * than going anonymous.
 */
export function childPaneName(ref: ChildPaneRef, child: AgentChild | null): string {
  if (child !== null) return childLabel(child)
  return responsePreview(ref.name) ?? ref.agentId ?? 'child'
}

/**
 * The pane header's one line: `<child> · <kind> of <parent>`.
 *
 * The kind comes from the **pane id**, not from the live row, so the header
 * does not change its mind about what it is showing when the child drops off
 * the list.
 */
export function childPaneHeading(
  ref: ChildPaneRef,
  child: AgentChild | null,
  parentLabel: string,
): string {
  const kind = ref.agentId !== null ? 'subagent' : 'shell'
  return `${childPaneName(ref, child)} · ${kind} of ${parentLabel}`
}

/**
 * Who a subagent's opening turn is from and to (`supervisor → implementer`).
 *
 * A subagent transcript's first user line is not something a person typed: it
 * is the task prompt its parent handed it. Labelling it `you`, as the session
 * chat labels a human prompt, would attribute the parent's instructions to
 * the reader.
 */
export function childPromptLabel(parentLabel: string, childName: string): string {
  return `${parentLabel} → ${childName}`
}
