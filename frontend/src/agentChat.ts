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
  /** `other` is a turn kind this build does not know — see `chatGroups`. */
  kind: 'prompt' | 'response' | 'tools' | 'other'
  turns: CcChatTurn[]
}

/**
 * Group a payload's turns into render blocks, preserving order. Consecutive
 * `tool` turns merge; everything else stands alone.
 *
 * A `kind` this build does not know — an older UI against a server that has
 * learned a fourth one — becomes `other`, **not** `response`. It is shown
 * (dropping turns silently is worse than an unstyled row) but it is not
 * attributed to anyone: labelling an unknown turn "agent" is exactly the
 * mis-attribution the server side guards against when it refuses to read an
 * injected `user` line as something the assistant said, and a version skew is
 * the one situation where that guard would otherwise be undone here.
 */
export function chatGroups(turns: CcChatTurn[]): ChatGroup[] {
  const out: ChatGroup[] = []
  for (const turn of turns) {
    const last = out[out.length - 1]
    if (turn.kind === 'tool' && last?.kind === 'tools') {
      last.turns.push(turn)
      continue
    }
    const kind =
      turn.kind === 'tool'
        ? 'tools'
        : turn.kind === 'prompt'
          ? 'prompt'
          : turn.kind === 'response'
            ? 'response'
            : 'other'
    out.push({ id: turn.id, kind, turns: [turn] })
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
 * How a tool call's target is shown in a row.
 *
 * A row's width is a few hundred pixels and CSS truncates from the *end* —
 * which is right for a command (you want to know it was `cargo test …`) and
 * exactly wrong for a path, whose leading directories are the part every row
 * shares and whose basename is the only part that distinguishes it. So a
 * target that is a single absolute path is elided from the front instead,
 * keeping its last three segments; everything else is returned verbatim for
 * CSS to truncate normally. The full value is always in the row's `title`.
 *
 * "A single path" is deliberately narrow — no whitespace, leading `/` or `~/`
 * — so a shell command that merely *contains* a path is untouched.
 */
export function chatToolTarget(text: string): string {
  const isPath = /^(\/|~\/)/.test(text) && !/\s/.test(text)
  if (!isPath) return text
  const parts = text.split('/').filter((p) => p !== '')
  if (parts.length <= 3) return text
  return `…/${parts.slice(-3).join('/')}`
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
 * bottomed-out box read as "scrolled up" and freeze the follow.
 *
 * It is **capped** at a quarter of the box, not floored at one. A pane in a
 * 2x2 auto-tile is often 150-250px tall, where a flat 80px is a third of
 * everything the reader can see: they nudge up to re-read a line, are still
 * "near the bottom", and the next poll snaps them back. Scaling *down* on a
 * small pane is the fix; scaling up on a large one would be the same bug in
 * the other direction, so 80px is the ceiling and a large pane behaves
 * exactly as it did. The 16px floor is the rounding allowance, which is all
 * the slack was ever for.
 */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  const slack = Math.max(16, Math.min(80, clientHeight * 0.25))
  return scrollHeight - clientHeight - scrollTop <= slack
}
