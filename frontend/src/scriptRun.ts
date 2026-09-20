// The Scripts page's run pane (mesa task 1196): the pure half. The pane reads
// `POST /api/scripts/{id}/run/stream` — NDJSON, one `ScriptRunEvent` per line
// — and shows one interleaved, timestamped log under a resizable split. Every
// decision in that which could ship wrong without a rendered tree lives here:
// cutting chunked text into whole lines, whether the log is still following,
// how far the split may be dragged, and how times read.
//
// Since mesa task 1224 the pane shows a **stored** run rather than one it is
// itself performing, so the second half of this module reads a
// `ScriptRunRecord`: which of the five words the pane renders a run is in,
// which run is the live one, and — the one that could silently ship wrong —
// what the clock counts from. A reopened run's elapsed time is measured from
// the server's `started_at`, never from the mount that is showing it.

import { parseTimestamp } from './time'
import type { ScriptRunEvent } from './types/ScriptRunEvent'
import type { ScriptRunRecord } from './types/ScriptRunRecord'
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


// ---- a stored run (mesa task 1224) ----

/** What the pane calls the run it is showing. Four of these are the server's
 * own `ScriptRunStatus`; `idle` is the fifth, the pane with no run open at
 * all, which no row can ever say. */
export type RunState = 'idle' | 'running' | 'finished' | 'stopped' | 'failed'

/**
 * The state word for the run on screen, `idle` when there is none.
 *
 * Almost the row's own `status`, with one rule: a `finished` row whose
 * `exit_code` is null reads as `failed`, because "finished" is the pane's
 * word for *an exit status was collected* — every caller that prints
 * `exit {code}` relies on that pairing, and a row that ended with no code
 * has nothing to print.
 */
export function runState(run: ScriptRunRecord | null): RunState {
  if (run === null) return 'idle'
  if (run.status === 'finished' && run.exit_code === null) return 'failed'
  return run.status
}

/** The line events from a run's stream — replayed or live — as log lines.
 * `exit` and `error` are not lines and are dropped here, in one place. */
export function logLinesFrom(events: ScriptRunEvent[]): LogLine[] {
  const lines: LogLine[] = []
  for (const event of events) {
    if (event.type === 'line') {
      lines.push({ stream: event.stream, t: event.t, text: event.text })
    }
  }
  return lines
}

/**
 * When the run started, in epoch ms, or `null` for a stamp that will not
 * parse. The one place a restored run's timebase is decided: `started_at` is
 * a mesa UTC timestamp, which `new Date` would otherwise read as local time
 * (see `time.ts`), so every elapsed reading would be hours out.
 */
export function runStartedMs(run: ScriptRunRecord): number | null {
  const ms = parseTimestamp(run.started_at).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * How long the run has been going, or how long it took: `started_at` to
 * `ended_at`, or to `now` while it is still going. Null when the row's
 * stamps will not parse. Never negative — a clock skewed the other way
 * reads as zero rather than counting backwards.
 */
export function runElapsedMs(run: ScriptRunRecord, now: number): number | null {
  const started = runStartedMs(run)
  if (started === null) return null
  const endedRaw = run.ended_at === null ? now : parseTimestamp(run.ended_at).getTime()
  const ended = Number.isNaN(endedRaw) ? now : endedRaw
  return Math.max(0, ended - started)
}

/**
 * The newest run of this script that is still going, or `null` — the list's
 * `● running` badge. Newest by id rather than by position, so it does not
 * depend on the order the server happened to answer in.
 */
export function activeRun(runs: ScriptRunRecord[], scriptId: number): ScriptRunRecord | null {
  let newest: ScriptRunRecord | null = null
  for (const run of runs) {
    if (run.script_id !== scriptId || run.status !== 'running') continue
    if (newest === null || run.id > newest.id) newest = run
  }
  return newest
}

/** One script's runs, newest first, at most `limit` of them. Sorted here
 * rather than trusted from the response, for `activeRun`'s reason. */
export function runsForScript(
  runs: ScriptRunRecord[],
  scriptId: number,
  limit: number,
): ScriptRunRecord[] {
  return runs
    .filter((r) => r.script_id === scriptId)
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.max(0, limit))
}

/**
 * A run row's one-line label: when it started, how it went, how long — e.g.
 * `14:03:22 · exit 0 · 0.8s`, or `14:03:22 · running · 01:12` for a live one,
 * whose clock runs from the server's `started_at`. A row whose stamps will
 * not parse still names itself rather than printing `NaN`.
 */
export function formatRunLabel(run: ScriptRunRecord, now: number): string {
  const state = runState(run)
  const verb = state === 'finished' ? `exit ${run.exit_code}` : state
  const started = runStartedMs(run)
  const elapsed = runElapsedMs(run, now)
  const clock = started === null ? `run ${run.id}` : formatClock(started)
  if (elapsed === null) return `${clock} · ${verb}`
  return `${clock} · ${verb} · ${
    run.status === 'running' ? formatElapsed(elapsed) : formatDuration(elapsed)
  }`
}
