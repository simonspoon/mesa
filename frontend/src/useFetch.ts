import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Runs `load` on mount, whenever `key` changes, and on window focus —
 * agents mutate the DB underneath the UI, so views refetch on refocus
 * (spec Requirement 10). `refetch` re-runs `load` without clearing the
 * current data (used after mutations like a kanban drop).
 */
export function useFetch<T>(
  load: () => Promise<T>,
  key: string,
): { data: T | null; error: string | null; refetch: () => void } {
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
    const run = () => {
      loadRef.current().then(
        (d) => {
          if (!cancelled) {
            setData(d)
            setError(null)
          }
        },
        (e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        },
      )
    }
    runRef.current = run
    run()
    window.addEventListener('focus', run)
    return () => {
      cancelled = true
      window.removeEventListener('focus', run)
    }
  }, [key])

  const refetch = useCallback(() => runRef.current(), [])

  return { data, error, refetch }
}
