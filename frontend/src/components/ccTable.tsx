import { useState } from 'react'

// The CC surfaces' two pieces of shared furniture: the sortable table and the
// KPI card. Lifted out of CCDashboardView.tsx unchanged when the session detail
// page needed both — one implementation rather than a second, drifting copy of
// a 90-line generic table.

export type Col<T> = {
  key: string
  label: string
  render: (r: T) => React.ReactNode
  sort?: (r: T) => number | string
  numeric?: boolean
}

export function DataTable<T>({
  rows,
  cols,
  initialKey,
  initialDir = 'desc',
  empty,
  rowKey,
  rowHref,
}: {
  rows: T[]
  cols: Col<T>[]
  initialKey: string
  initialDir?: 'asc' | 'desc'
  empty: string
  // Stable identity per row so React reconciles correctly across re-sorts.
  rowKey: (r: T) => string
  // Optional drill-down target. The first cell becomes a real `<a>` — so the
  // row is reachable by keyboard, announced as a link, and middle-clickable —
  // and the whole row additionally navigates on click, which is what a table
  // of clickable rows is expected to do.
  rowHref?: (r: T) => string
}) {
  const [key, setKey] = useState(initialKey)
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir)
  const col = cols.find((c) => c.key === key)
  const sorted =
    col?.sort != null
      ? [...rows].sort((a, b) => {
          const av = col.sort!(a)
          const bv = col.sort!(b)
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return dir === 'asc' ? cmp : -cmp
        })
      : rows
  function clickHeader(c: Col<T>) {
    if (!c.sort) return
    if (c.key === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setKey(c.key)
      setDir('desc')
    }
  }
  if (rows.length === 0) return <p className="muted">{empty}</p>
  return (
    // The scroll box wraps the table only — scrolling the panel instead takes
    // its heading and hint along, which is what a 390px screen exposed.
    <div className="cc-table-wrap">
      <table className="cc-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={`${c.numeric ? 'num' : ''}${c.sort ? ' sortable' : ''}`}
                onClick={() => clickHeader(c)}
              >
                {c.label}
                {c.key === key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const href = rowHref?.(r)
            return (
              <tr
                key={rowKey(r)}
                className={href ? 'cc-row-link' : undefined}
                onClick={
                  href
                    ? (e) => {
                        // The first cell's own `<a>` already navigates, and a
                        // drag that ends up selecting text is not a click —
                        // reacting to either would hijack the gesture.
                        if ((e.target as HTMLElement).closest('a')) return
                        if (window.getSelection()?.toString()) return
                        window.location.hash = href
                      }
                    : undefined
                }
              >
                {cols.map((c, i) => (
                  <td key={c.key} className={c.numeric ? 'num' : ''}>
                    {href && i === 0 ? <a href={href}>{c.render(r)}</a> : c.render(r)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Kpi({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="cc-kpi">
      <div className="cc-kpi-value">{value}</div>
      <div className="cc-kpi-label">{label}</div>
      {sub && <div className="cc-kpi-sub">{sub}</div>}
    </div>
  )
}
