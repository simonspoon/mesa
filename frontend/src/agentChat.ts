import type { CcChatTurn } from './types/CcChatTurn'

/**
 * Pure presentation logic for the Agent sidebar's chat view (task 814) — the
 * rendered alternative to a pane's raw terminal.
 *
 * Lives here rather than inline in `AgentChat.tsx` per CLAUDE.md's
 * frontend-test rule: the grouping below is exactly the kind of predicate that
 * ships wrong, and vitest covers `.ts` modules only.
 */

/**
 * One block of the transcript as the chat renders it. A prompt and a response
 * are each their own block; a *run* of consecutive tool calls is one block,
 * because that is what it is — the agent working between two things it said,
 * and a session routinely puts 30 calls between two replies. Rendering each as
 * its own row would bury the conversation in its own machinery.
 */
export type ChatGroup = {
  /** The first turn's id — unique within a payload, so it keys a React list. */
  id: string
  kind: 'prompt' | 'response' | 'tools'
  turns: CcChatTurn[]
}

/**
 * Group a payload's turns into render blocks, preserving order. Consecutive
 * `tool` turns merge; everything else stands alone. An unknown `kind` (a
 * server that has learned a fourth one) is passed through as its own block
 * rather than dropped — a chat that silently omits turns is worse than one
 * showing a row it has no special styling for.
 */
export function chatGroups(turns: CcChatTurn[]): ChatGroup[] {
  const out: ChatGroup[] = []
  for (const turn of turns) {
    const last = out[out.length - 1]
    if (turn.kind === 'tool' && last?.kind === 'tools') {
      last.turns.push(turn)
      continue
    }
    out.push({
      id: turn.id,
      kind: turn.kind === 'tool' ? 'tools' : turn.kind === 'prompt' ? 'prompt' : 'response',
      turns: [turn],
    })
  }
  return out
}

/**
 * The one-line label for a tool row: the tool's name, then its bounded target
 * when it has one. Both come from the transcript and are rendered as text.
 */
export function chatToolLabel(turn: CcChatTurn): string {
  const name = turn.name ?? 'tool'
  return turn.text ? `${name} · ${turn.text}` : name
}

/**
 * A collapsed tool run's summary: each distinct tool name in first-use order,
 * with a `×n` only when it repeats — `Bash ×3 · Read · Edit ×2`. Capped at
 * four names plus a `+n` tail so one run can never outgrow its own header.
 */
export function chatToolSummary(turns: CcChatTurn[]): string {
  const counts = new Map<string, number>()
  for (const t of turns) {
    const name = t.name ?? 'tool'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = [...counts.entries()]
  const shown = names.slice(0, 4).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  if (names.length > shown.length) shown.push(`+${names.length - shown.length}`)
  return shown.join(' · ')
}

/**
 * `HH:MM` in the reader's own timezone from a transcript timestamp, or `''`
 * when the line carried none / the value doesn't parse. Minutes, not seconds:
 * a chat bubble is read as conversation, and the second-level clock belongs to
 * the CC timeline page, which is read as a trace.
 */
export function chatClock(ts: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Whether a scroll box is close enough to its end to be "following" the
 * conversation. The chat auto-scrolls on new turns only while this holds, so
 * scrolling up to read something older is never yanked back by the next poll.
 *
 * The slack absorbs the sub-pixel rounding a zoomed/fractional-DPI viewport
 * gives `scrollHeight - clientHeight`, which otherwise makes an apparently
 * bottomed-out box read as "scrolled up" and freeze the follow. It is a
 * *fraction* of the box rather than a flat 80px because a pane in a 2x2
 * auto-tile is often only 150-250px tall, where a flat 80px would mean the
 * reader has to scroll up a third of everything they can see before the follow
 * lets go — and anything less gets snapped back by the next poll. The 80px
 * floor keeps the behaviour identical on any pane large enough for it to have
 * been right in the first place.
 */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= Math.max(80, clientHeight * 0.25)
}
