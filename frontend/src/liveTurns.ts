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
 * The transcript after a poll lands, and whether it belongs to a different
 * conversation than the one on screen (mesa task 862).
 *
 * A poll answers for exactly one session — or for none, which is what ending a
 * conversation looks like on the wire (`{session: null, turns: []}`). Either
 * change is a *new* transcript: the turns held belong to the conversation that
 * just went away, and merging them forward leaves the page holding mesa turns
 * whose `played_at` never came back (the `after=` cursor means those rows are
 * never re-sent) — which the run would then speak from the top, all of them,
 * the moment the session ended.
 *
 * `fresh` is that decision, answered once and returned rather than re-derived:
 * the caller uses it for the turns *and* for the set of turns it has taken in
 * hand, and the two must never disagree — a cleared `handled` beside a kept
 * transcript is precisely the replay this exists to stop.
 */
export function transcriptFor(
  held: readonly LiveTurn[],
  shown: number | null,
  arriving: number | null,
  incoming: readonly LiveTurn[],
): { turns: LiveTurn[]; fresh: boolean } {
  const fresh = arriving !== shown
  return { turns: mergeTurns(fresh ? [] : held, incoming), fresh }
}

/**
 * Every turn the page still has to act on, oldest first — the mesa turns the
 * browser has not played and this page has not already taken in hand.
 *
 * `played_at` is the server's record and `handled` is this page's: the stamp
 * only lands on the *next* poll, so without the second set every poll in that
 * window would start the same turn again. A user turn is never a candidate —
 * the page wrote it, and it is not spoken back.
 *
 * The whole list rather than only its head, because a page that may not
 * *speak* (mesa task 1267 — it is not the session's speaker) still walks past
 * the turns it cannot say to perform what they do to the browser. It takes
 * none of them in hand, so each stays on this list until somebody speaks it.
 */
export function pendingTurns(
  turns: readonly LiveTurn[],
  handled: ReadonlySet<number>,
): LiveTurn[] {
  return turns.filter(
    (turn) => turn.role === 'mesa' && turn.played_at === null && !handled.has(turn.id),
  )
}

/**
 * The next turn the page has to act on — [`pendingTurns`]'s head, and the
 * whole of what a page that may speak ever needs.
 */
export function nextUnplayed(
  turns: readonly LiveTurn[],
  handled: ReadonlySet<number>,
): LiveTurn | null {
  return pendingTurns(turns, handled)[0] ?? null
}

/**
 * Whether this page still has a turn's *action* to perform: it does something
 * to the browser, and this page has not done it yet.
 *
 * A second record beside `handled`, and deliberately not the same one (mesa
 * task 1267). The two sets answer different questions: `handled` is "this page
 * took the turn in hand to **say** it", `performed` is "this page has already
 * done what the turn does to the browser". Conflating them orphaned a turn
 * that a non-speaking page skipped — it was in `handled` for ever, with
 * nothing to re-admit it, so the page could never say it even once the claim
 * went free. Every browser showing the conversation performs a `navigate` or a
 * sidebar fold, exactly once each; only one of them says the words.
 */
export function actsOn(turn: LiveTurn, performed: ReadonlySet<number>): boolean {
  if (performed.has(turn.id)) return false
  return navigateTarget(turn) !== null || sidebarsIntent(turn) !== null
}

/**
 * Hands a turn back to the run so it is said again from its start (mesa task
 * 1161): the one the player was sounding when a pause cut it off.
 *
 * `run()` takes a turn in hand *before* it sounds and `played_at` is stamped
 * only when it ends, so a turn silenced mid-sentence is in `handled` and
 * nowhere else — Resume would skip it and the sentence would be lost. Removing
 * it is the whole repair: it is the oldest unplayed mesa turn by id, so
 * `nextUnplayed` returns it first and everything queued behind it follows in
 * order. Nothing sounding (a second "hold on" while already paused, a pause
 * between turns) releases nothing, and an id already absent is a no-op — the
 * set is edited in place, as the hub edits it.
 */
export function releaseForReplay(
  handled: Set<number>,
  sounding: number | null,
): void {
  if (sounding !== null) handled.delete(sounding)
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
  /** Whether this run is mesa's own report about the agent rather than its
   *  words (mesa task 1157) — its own group, labelled apart. */
  notice: boolean
  turns: LiveTurn[]
}

/**
 * The transcript as alternating runs: consecutive turns by the same side are
 * one group, so a reply split over three sentences reads as one utterance
 * rather than three stacked bubbles. A notice turn never joins the agent's
 * run on either side of it: it is labelled apart, so it is grouped apart.
 */
export function turnGroups(turns: readonly LiveTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  for (const turn of turns) {
    const last = groups[groups.length - 1]
    const notice = turn.notice !== null
    if (last && last.role === turn.role && last.notice === notice) last.turns.push(turn)
    else groups.push({ role: turn.role, notice, turns: [turn] })
  }
  return groups
}

/**
 * Who a group is, in words. "you" for the dictated side, "mesa" for the spoken
 * one — the same vocabulary the agent chat's bubbles use, so the two
 * conversations in this app read the same way — and "notice" for mesa's own
 * report about the agent (mesa task 1157), which is not something it said.
 */
export function turnLabel(role: LiveTurn['role'], notice = false): string {
  if (notice) return 'notice'
  return role === 'user' ? 'you' : 'mesa'
}
