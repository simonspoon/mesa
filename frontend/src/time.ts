/**
 * Parsing/formatting for mesa's own timestamp strings.
 *
 * Every timestamp the store writes comes from SQLite `datetime('now')`, which
 * is **UTC** rendered as `YYYY-MM-DD HH:MM:SS` — with no `T` and no zone
 * marker. `new Date("2026-07-26 05:30:32")` reads that bare form as *local*
 * time, so a viewer at UTC-4 sees every age skewed by four hours with nothing
 * on screen to suggest it. Re-spell it as ISO-8601 UTC before parsing.
 */
export function parseTimestamp(ts: string): Date {
  return new Date(`${ts.replace(' ', 'T')}Z`)
}

/** Absolute local rendering, for the tooltip behind a relative age. */
export function formatTimestamp(ts: string): string {
  return parseTimestamp(ts).toLocaleString()
}

/**
 * Coarse "how long ago", the form a claim's live-vs-abandoned question is
 * actually read in. Floors rather than rounds, so the label never claims more
 * elapsed time than has passed; a clock-skewed future stamp falls into the
 * `just now` arm rather than printing a negative.
 */
export function timeAgo(ts: string, now: number = Date.now()): string {
  const secs = Math.floor((now - parseTimestamp(ts).getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
