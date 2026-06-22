// Tiny hand-rolled SVG chart primitives for the CC Dashboard. No charting
// dependency — these are a handful of <svg> elements themed with the app's CSS
// variables, which keeps the bundle small and the neon aesthetic consistent.

/** One coloured slice of a donut or a stacked bar. */
export type Slice = { label: string; value: number; color: string }

/**
 * Donut chart drawn with stroke-dasharray on concentric arcs. `slices` need not
 * sum to anything in particular — they're normalised to the total.
 */
export function Donut({
  slices,
  size = 168,
  thickness = 24,
}: {
  slices: Slice[]
  size?: number
  thickness?: number
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  // Precompute each arc's length and cumulative offset (pure — no mutation).
  const lens = slices.map((s) => (s.value / total) * c)
  const arcs = slices.map((s, i) => ({
    ...s,
    len: lens[i],
    offset: lens.slice(0, i).reduce((a, b) => a + b, 0),
  }))
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="donut"
      role="img"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={thickness}
      />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {arcs.map((s) => (
          <circle
            key={s.label}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={`${s.len} ${c - s.len}`}
            strokeDashoffset={-s.offset}
          >
            <title>{s.label}</title>
          </circle>
        ))}
      </g>
    </svg>
  )
}

/**
 * A compact "heartbeat" sparkline of per-bucket values (e.g. tokens per minute),
 * drawn as thin bars normalised to the series max. Oldest→newest, left→right.
 * Stretched to the container width via preserveAspectRatio="none"; an empty or
 * all-zero series renders a flat baseline.
 */
export function Sparkbars({
  values,
  height = 34,
  color = 'var(--cyan)',
}: {
  values: number[]
  height?: number
  color?: string
}) {
  const n = Math.max(1, values.length)
  const max = Math.max(1, ...values)
  const bw = 100 / n
  const gap = Math.min(bw * 0.3, 1.2)
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className="spark"
      role="img"
    >
      {values.map((v, i) => {
        // Floor a nonzero value to 1px so any activity is visible.
        const h = v > 0 ? Math.max((v / max) * height, 1) : 0
        return (
          <rect
            key={i}
            x={i * bw + gap / 2}
            y={height - h}
            width={bw - gap}
            height={h}
            fill={color}
          />
        )
      })}
    </svg>
  )
}

/**
 * One day of the diverging chart: segments stacked upward from a centre baseline
 * and segments stacked downward. The two halves are scaled independently so a
 * small series (input/output) stays readable next to a large one (cache).
 */
export type DivergingBar = { label: string; up: Slice[]; down: Slice[] }

/**
 * Diverging stacked bars about a centre baseline. The upper half (`up`) and the
 * lower half (`down`) each get their own scale and half of `height`, so the two
 * series read on independent axes — the caller labels the max of each side. A
 * compact alternative to one stacked bar when the segments span wildly different
 * magnitudes. Rendered in a 100×height viewBox stretched to the container width
 * (preserveAspectRatio="none"); the baseline keeps a constant 1px via
 * vector-effect.
 */
export function DivergingBars({
  bars,
  height = 120,
}: {
  bars: DivergingBar[]
  height?: number
}) {
  const sum = (xs: Slice[]) => xs.reduce((s, x) => s + x.value, 0)
  const upMax = Math.max(1, ...bars.map((b) => sum(b.up)))
  const downMax = Math.max(1, ...bars.map((b) => sum(b.down)))
  const n = Math.max(1, bars.length)
  const bw = 100 / n
  const gap = Math.min(bw * 0.25, 1.5)
  const mid = height / 2 // baseline; up region is [0, mid], down region [mid, height]
  // Flatten both halves to absolute rects up front (pure prefix-sums).
  const rects = bars.flatMap((b, i) => {
    const x = i * bw + gap / 2
    const w = bw - gap
    const up = b.up.map((seg, j) => {
      const below = sum(b.up.slice(0, j)) // already-stacked height below this seg
      const h = (seg.value / upMax) * mid
      return {
        key: `${b.label}-u-${seg.label}`,
        x,
        y: mid - (below / upMax) * mid - h,
        w,
        h,
        color: seg.color,
        title: `${b.label} · ${seg.label}`,
      }
    })
    const down = b.down.map((seg, j) => {
      const above = sum(b.down.slice(0, j))
      const h = (seg.value / downMax) * (height - mid)
      return {
        key: `${b.label}-d-${seg.label}`,
        x,
        y: mid + (above / downMax) * (height - mid),
        w,
        h,
        color: seg.color,
        title: `${b.label} · ${seg.label}`,
      }
    })
    return [...up, ...down]
  })
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className="bars diverging"
      role="img"
    >
      {rects.map((r) => (
        <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.color}>
          <title>{r.title}</title>
        </rect>
      ))}
      <line
        x1={0}
        y1={mid}
        x2={100}
        y2={mid}
        stroke="var(--border)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
