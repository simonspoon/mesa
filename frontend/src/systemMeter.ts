/**
 * Arithmetic for the Settings page's System section — the used/total meters
 * over `GET /api/system` (`core::system`).
 *
 * It exists as its own module for the reason `usageMeter.ts` does, and shares
 * that module's bands so a meter never means one thing here and another
 * there: **warn from 70%, crit from 90%**.
 *
 * The one rule this file is really about: **`null` is not zero.** A host that
 * will not report a figure sends `null`, and a `null` must reach the page as
 * `null` all the way through — a meter drawn at 0% would say "this machine
 * has none of that", which is a different claim from "this machine did not
 * say". Every function here therefore takes the unknown case and hands it
 * back rather than defaulting it.
 */

export type SystemSeverity = 'ok' | 'warn' | 'crit'

/**
 * `used` as a percentage of `total`, clamped to 0–100. `null` when either
 * side is missing or not a finite number, and when `total` is zero — a host
 * with no swap at all is not a host whose swap is 0% full.
 */
export function usedPct(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (used === null || used === undefined || total === null || total === undefined) return null
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  return clampPct((used / total) * 100)
}

/** A percentage the host reported directly, clamped to 0–100; `null` for an
 * unknown or non-finite one. Live readings are trusted for their meaning, not
 * their range (the `usagePct` posture). */
export function clampPct(pct: number | null | undefined): number | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

/** Meter colour band, identical to `usageSeverity`: warn from 70, crit from 90. */
export function systemSeverity(pct: number): SystemSeverity {
  return pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok'
}

/** Binary units, since every byte count here comes from the OS. */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/**
 * A byte count as a short human string ("15.6 GiB"). `null` becomes the
 * em-dash placeholder the section uses everywhere for "not reported", so an
 * unknown value can never be typeset as a number.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const negative = bytes < 0
  let n = Math.abs(bytes)
  let unit = 0
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024
    unit += 1
  }
  // Whole bytes read as noise with a decimal point; everything else gets one.
  const text = unit === 0 ? String(Math.round(n)) : n.toFixed(1)
  return `${negative ? '-' : ''}${text} ${UNITS[unit]}`
}

/** An uptime in seconds as "3d 4h", "4h 12m", "12m" or "45s". */
export function formatUptime(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs) || secs < 0) return '—'
  const s = Math.floor(secs)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}
