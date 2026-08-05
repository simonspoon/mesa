// Pure logic for the CC session detail page (`#/cc/sessions/:id`) — ratios,
// formatting, chart series and the top-N rollup. It lives here rather than
// inline in CCSessionDetailView.tsx because these are exactly the predicates
// that ship wrong (a zero denominator, an empty series, a single bucket), and
// vitest covers this module while it cannot cover a `.tsx`.

import type { Slice } from './components/charts'
import type { CcSessionBucket } from './types/CcSessionBucket'
import type { CcSessionToolStat } from './types/CcSessionToolStat'
import type { CcTokens } from './types/CcTokens'

/**
 * Token-type colours, shared by the dashboard's daily chart and legend and by
 * the detail page's composition donut. One definition so the two surfaces can
 * never disagree about which colour "cache write" is.
 */
export const TOK = {
  input: { label: 'input', color: 'var(--cyan)' },
  output: { label: 'output', color: 'var(--magenta)' },
  cache_read: { label: 'cache read', color: 'var(--green)' },
  cache_creation: { label: 'cache write', color: 'var(--amber)' },
} as const

export const fmtInt = (n: number) => n.toLocaleString()

export const fmtTok = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${n}`

export const fmtUsd = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`

export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`

/** Minutes → the coarsest unit that still reads: `45s` / `12m` / `2.4h`. */
export function fmtDuration(minutes: number): string {
  if (!(minutes > 0)) return '0m'
  if (minutes < 1) return `${Math.round(minutes * 60)}s`
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`
}

/**
 * How much input context was served from the prompt cache:
 * `cache_read / (cache_read + input)`. A session with neither is 0, not NaN —
 * the KPI renders a number, so the guard belongs here.
 */
export function cacheHitRatio(t: CcTokens): number {
  const denom = t.cache_read + t.input
  return denom > 0 ? t.cache_read / denom : 0
}

/** Tokens per minute over the session span; 0 for a session with no span. */
export function tokensPerMinute(totalTokens: number, durationMinutes: number): number {
  return durationMinutes > 0 ? totalTokens / durationMinutes : 0
}

/**
 * The token-composition donut. Zero-valued types are dropped: a legend row
 * reading "cache write 0" is noise, and a zero slice draws nothing anyway. An
 * all-zero session yields no slices, which the page renders as a quiet empty.
 */
export function tokenSlices(t: CcTokens): Slice[] {
  return (
    [
      ['input', t.input],
      ['output', t.output],
      ['cache_read', t.cache_read],
      ['cache_creation', t.cache_creation],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ label: TOK[k].label, value: v, color: TOK[k].color }))
}

/** One bucket field as a `Sparkbars` series, oldest→newest. */
export function bucketSeries(
  buckets: CcSessionBucket[],
  key: 'messages' | 'tool_calls' | 'total_tokens' | 'output_tokens',
): number[] {
  return buckets.map((b) => b[key])
}

/**
 * Top `n` tools by calls, with everything past them folded into one `other`
 * row so the bar list still adds up to the session's tool-call count. The
 * input is already sorted server-side (`calls` desc, `name` asc); this never
 * re-sorts, so the two surfaces agree on ties.
 */
export function topTools(tools: CcSessionToolStat[], n: number): CcSessionToolStat[] {
  if (tools.length <= n) return tools
  const head = tools.slice(0, n)
  const rest = tools.slice(n)
  return [
    ...head,
    {
      name: `other (${rest.length})`,
      calls: rest.reduce((s, t) => s + t.calls, 0),
      subagent_calls: rest.reduce((s, t) => s + t.subagent_calls, 0),
    },
  ]
}
