/**
 * Plan-limit meter arithmetic, shared by the header's usage chips and the CC
 * dashboard's Subscription Limits card so the two can never disagree about
 * what "42%" or "red" means.
 *
 * `utilization` arrives from Anthropic as a 0–100 percentage of the plan limit
 * (see `core::usage`), but it is a live third-party number: clamp it rather
 * than trusting the range.
 */
import type { CcUsageWindow } from './types/CcUsageWindow'

export type UsageSeverity = 'ok' | 'warn' | 'crit'

/** The window's utilization clamped to 0–100; `null` for a missing window. */
export function usagePct(w: CcUsageWindow | null | undefined): number | null {
  if (!w || !Number.isFinite(w.utilization)) return null
  return Math.max(0, Math.min(100, w.utilization))
}

/** Bar/chip colour band: warn from 70%, crit from 90%. */
export function usageSeverity(pct: number): UsageSeverity {
  return pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok'
}
