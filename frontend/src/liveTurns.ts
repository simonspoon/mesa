import type { LiveTurn } from './types/LiveTurn'

/**
 * The transcript arithmetic of a live conversation (mesa task 855).
 *
 * The page polls `GET /api/live?after=<cursor>`, so each answer is only what is
 * *new*: the transcript on screen is accumulated here rather than replaced, and
 * the cursor that asks for the next page is derived from what has landed. Both
 * of those, plus "which turn does the page speak next", are decisions that have
 * historically shipped wrong in a `.tsx` — so they live here, next to a test,
 * and `LiveView.tsx` only performs them.
 *
 * The run this feeds is the inbox's read-all rule (`inboxQueue.ts`) with one
 * difference: the queue is not a snapshot. A live conversation keeps arriving,
 * so the next item is always chosen from what is on hand *now*, minus what the
 * page has already taken in hand (`handled`) — which is what keeps a turn that
 * failed to speak, or one the server has not yet stamped `played_at` for, from
 * being said twice.
 */

/**
 * The `after=` cursor for the next poll: the highest turn id seen. Turns arrive
 * ascending, but the max is taken rather than the last element — a cursor that
 * could go *backwards* would re-deliver turns the page has already merged, and
 * an empty page must leave it exactly where it was.
 */
export function advanceCursor(
  cursor: number | null,
  turns: readonly LiveTurn[],
): number | null {
  let next = cursor
  for (const turn of turns) {
    if (next === null || turn.id > next) next = turn.id
  }
  return next
}

/**
 * The transcript after a page lands: everything already held plus what is new,
 * ascending by id and one row per id. A turn that arrives twice — a cursor that
 * was not advanced, a refocus refetch — replaces the copy held, since the later
 * copy is the one carrying `played_at`.
 */
export function mergeTurns(
  held: readonly LiveTurn[],
  incoming: readonly LiveTurn[],
): LiveTurn[] {
  const byId = new Map<number, LiveTurn>()
  for (const turn of held) byId.set(turn.id, turn)
  for (const turn of incoming) byId.set(turn.id, turn)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * The next turn the page has to act on, oldest first — a mesa turn the browser
 * has not played and this page has not already taken in hand.
 *
 * `played_at` is the server's record and `handled` is this page's: the stamp
 * only lands on the *next* poll, so without the second set every poll in that
 * window would start the same turn again. A user turn is never a candidate —
 * the page wrote it, and it is not spoken back.
 */
export function nextUnplayed(
  turns: readonly LiveTurn[],
  handled: ReadonlySet<number>,
): LiveTurn | null {
  for (const turn of turns) {
    if (turn.role !== 'mesa') continue
    if (turn.played_at !== null) continue
    if (handled.has(turn.id)) continue
    return turn
  }
  return null
}

/**
 * What a turn says out loud, or null when it says nothing. A pure action turn
 * carries no text — it changes the page and is silent — so the page must
 * be able to tell "nothing to speak" from "speak an empty string", which the
 * synthesiser would refuse.
 */
export function spokenText(turn: LiveTurn): string | null {
  if (turn.role !== 'mesa') return null
  const text = turn.text.trim()
  return text === '' ? null : text
}

/**
 * Where a turn sends the browser, or null when it sends it nowhere. A target
 * without the action, or an action whose target is missing, moves nothing:
 * `Store` rejects both, and the page is the last place to trust a route from
 * the wire — it is about to be written straight into `location.hash`.
 */
export function navigateTarget(turn: LiveTurn): string | null {
  if (turn.action !== 'navigate') return null
  const target = turn.target?.trim() ?? ''
  return target.startsWith('#/') ? target : null
}

/** What a turn asks the app's two side panels to do. */
export type SidebarsIntent = 'collapse' | 'expand'

/**
 * Whether a turn folds the sidebars away or brings them back, or null when it
 * leaves them alone (mesa task 859).
 *
 * The other half of `navigateTarget`: both answer "what does this turn do to
 * what the person is looking at". A `target` is irrelevant here — `Store`
 * refuses one on these actions — so the verb alone decides, and an action the
 * page does not know is the same as none rather than a crash.
 */
export function sidebarsIntent(turn: LiveTurn): SidebarsIntent | null {
  if (turn.action === 'collapse-sidebars') return 'collapse'
  if (turn.action === 'expand-sidebars') return 'expand'
  return null
}

/** One side of the conversation, drawn as a run of consecutive turns. */
export interface TurnGroup {
  /** Who is speaking, which is what the bubble's side and colour come from. */
  role: LiveTurn['role']
  turns: LiveTurn[]
}

/**
 * The transcript as alternating runs: consecutive turns by the same side are
 * one group, so a reply split over three sentences reads as one utterance
 * rather than three stacked bubbles.
 */
export function turnGroups(turns: readonly LiveTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  for (const turn of turns) {
    const last = groups[groups.length - 1]
    if (last && last.role === turn.role) last.turns.push(turn)
    else groups.push({ role: turn.role, turns: [turn] })
  }
  return groups
}

/**
 * Who a group is, in words. "you" for the dictated side, "mesa" for the spoken
 * one — the same vocabulary the agent chat's bubbles use, so the two
 * conversations in this app read the same way.
 */
export function turnLabel(role: LiveTurn['role']): string {
  return role === 'user' ? 'you' : 'mesa'
}
