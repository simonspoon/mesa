// The Scripts page's run pane (mesa task 1196): the pure half. The pane reads
// `POST /api/scripts/{id}/run/stream` — NDJSON, one `ScriptRunEvent` per line
// — and shows one interleaved, timestamped log under a resizable split. Every
// decision in that which could ship wrong without a rendered tree lives here:
// cutting chunked text into whole lines, whether the log is still following,
// how far the split may be dragged, and how times read.

import type { ScriptRunEvent } from './types/ScriptRunEvent'
import type { ScriptStream } from './types/ScriptStream'

/** One rendered log line. `t` is ms since the run started (server clock). */
export interface LogLine {
  stream: ScriptStream
  t: number
  text: string
}

/**
 * Appends a decoded chunk to what was left over from the last one and cuts
 * out every complete line. A chunk boundary falls wherever the network put
 * it — mid-line, mid-JSON — so only text followed by `\n` is a line; the tail
 * waits for the next chunk (or for {@link finishNdjson} at end of body).
 * Blank lines are dropped.
 */
export function splitNdjson(
  pending: string,
  chunk: string,
): { lines: string[]; rest: string } {
  const parts = (pending + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((l) => l.trim() !== ''), rest }
}

/** The leftover at end of body: a last line the server did not terminate. */
export function finishNdjson(pending: string): string[] {
  return pending.trim() === '' ? [] : [pending]
}

/** One NDJSON line as an event, or `null` for anything that is not one — a
 * garbled line must not take the whole log down with it. */
export function parseEvent(line: string): ScriptRunEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  return type === 'line' || type === 'exit' || type === 'error'
    ? (value as ScriptRunEvent)
    : null
}

/** How close to the bottom still counts as "at the bottom": sub-pixel
 * scroll positions and a zoomed page never land on exactly zero. */
export const FOLLOW_SLACK_PX = 8

/**
 * Whether the log is scrolled to its end — the follow predicate. Follow is
 * turned off when a scroll leaves the bottom (the reader went up to look at
 * something) and back on when a scroll returns to it, so this is asked on
 * every scroll event, never on the programmatic scroll follow itself makes
 * (that one lands at the bottom and answers `true` anyway).
 */
export function isAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= FOLLOW_SLACK_PX
}

/** The form pane never shrinks below this while it is shown — collapsing is
 * a separate toggle, not a drag to zero. */
export const MIN_FORM_PX = 96
/** The log keeps at least this much of the split. */
export const MIN_LOG_PX = 120
/** The form pane's height before anyone drags. */
export const DEFAULT_FORM_PX = 260

/**
 * Clamps a dragged form-pane height into what the split can hold: at least
 * {@link MIN_FORM_PX}, at most the container minus {@link MIN_LOG_PX}. A
 * container too small for both gives the form its floor — never a max below
 * the min. A non-finite value (a drag before layout) is the default.
 */
export function clampFormHeight(px: number, containerPx: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FORM_PX
  const max = Math.max(MIN_FORM_PX, containerPx - MIN_LOG_PX)
  return Math.round(Math.max(MIN_FORM_PX, Math.min(px, max)))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A running clock: `mm:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** A finished run's length: `0.8s`, `12.3s`, `4m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}m ${pad(total % 60)}s`
}

/** Local wall-clock `HH:MM:SS` of an epoch-ms instant — a line's timestamp is
 * the run's start plus its `t`. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A value as the CLI would need it typed: bare when it is plainly a word,
 * single-quoted otherwise. Display only — nothing parses this. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The run as the equivalent CLI call, for the log header:
 * `release --set version=0.30.0`. Values in declared-key order as given. */
export function commandLine(name: string, values: Record<string, string>): string {
  const sets = Object.entries(values).map(([k, v]) => `--set ${shellWord(`${k}=${v}`)}`)
  return [shellWord(name), ...sets].join(' ')
}

/** The log as plain text for the clipboard: one line per entry, timestamped,
 * stderr tagged — what the pane shows, minus the colour. */
export function logText(lines: LogLine[], startedAt: number): string {
  return lines
    .map(
      (l) =>
        `${formatClock(startedAt + l.t)} ${l.stream === 'stderr' ? 'stderr ' : ''}${l.text}`,
    )
    .join('\n')
}
