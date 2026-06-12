import { useEffect, useRef, useState } from 'react'

/**
 * Runs `load` on mount, whenever `key` changes, and on window focus —
 * agents mutate the DB underneath the UI, so views refetch on refocus
 * (spec Requirement 10).
 */
export function useFetch<T>(
  load: () => Promise<T>,
  key: string,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `load` closes over per-render state; the ref keeps the latest one
  // without making it an effect dependency (the `key` controls refetching).
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
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
    run()
    window.addEventListener('focus', run)
    return () => {
      cancelled = true
      window.removeEventListener('focus', run)
    }
  }, [key])

  return { data, error }
}
