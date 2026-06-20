import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Runs `load` on mount, whenever `key` changes, and on window focus —
 * agents mutate the DB underneath the UI, so views refetch on refocus
 * (spec Requirement 10). `refetch` re-runs `load` without clearing the
 * current data (used after mutations like a kanban drop).
 *
 * Pass `pollMs` to live-sync: `load` re-runs on that interval so changes
 * made by the CLI/agents (which write SQLite directly, out of the server's
 * sight — no push channel is possible) appear without a manual refocus.
 * Polling pauses while the tab is hidden, and a poll whose result is
 * byte-for-byte identical to the current data is dropped, so an idle view
 * never re-renders (no flicker, no interrupted drag).
 */
export function useFetch<T>(
  load: () => Promise<T>,
  key: string,
  options?: { pollMs?: number },
): { data: T | null; error: string | null; refetch: () => void } {
  const pollMs = options?.pollMs
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Clear stale data/error when the `key` changes by adjusting state during
  // render off the changed prop, not in the effect (avoids a cascading
  // re-render). The effect below then performs the actual fetch.
  const [prevKey, setPrevKey] = useState(key)
  if (key !== prevKey) {
    setPrevKey(key)
    setData(null)
    setError(null)
  }
  // `load` closes over per-render state; the ref keeps the latest one
  // without making it an effect dependency (the `key` controls refetching).
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  // Points at the current effect's `run` so `refetch` respects cancellation.
  const runRef = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    // Serialized snapshot of the last applied data, used to drop no-op polls.
    // Local to the effect so it resets whenever `key` changes (new effect).
    let lastJson: string | null = null
    const run = () => {
      loadRef.current().then(
        (d) => {
          if (cancelled) return
          // Drop polls that changed nothing so an idle view never re-renders.
          const json = JSON.stringify(d)
          if (json !== lastJson) {
            lastJson = json
            setData(d)
          }
          setError(null)
        },
        (e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        },
      )
    }
    runRef.current = run
    run()
    window.addEventListener('focus', run)
    // Live-sync: re-run on an interval, but skip ticks while the tab is
    // hidden (the focus listener catches up on return).
    const timer =
      pollMs !== undefined
        ? setInterval(() => {
            if (!document.hidden) run()
          }, pollMs)
        : undefined
    return () => {
      cancelled = true
      window.removeEventListener('focus', run)
      if (timer !== undefined) clearInterval(timer)
    }
  }, [key, pollMs])

  const refetch = useCallback(() => runRef.current(), [])

  return { data, error, refetch }
}
