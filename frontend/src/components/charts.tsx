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

/** One column of a stacked bar chart: a label plus its coloured segments. */
export type StackedBar = { label: string; segments: Slice[] }

/**
 * Stacked vertical bars scaled to the tallest column. Rendered in a 100×height
 * viewBox stretched to the container width, so it's responsive without JS.
 */
export function StackedBars({
  bars,
  height = 160,
}: {
  bars: StackedBar[]
  height?: number
}) {
  const totals = bars.map((b) => b.segments.reduce((s, x) => s + x.value, 0))
  const max = Math.max(1, ...totals)
  const n = Math.max(1, bars.length)
  const bw = 100 / n
  const gap = Math.min(bw * 0.25, 1.5)
  // Flatten to absolute rects up front (pure prefix-sums; no mutation).
  const rects = bars.flatMap((b, i) => {
    const x = i * bw + gap / 2
    const w = bw - gap
    const hs = b.segments.map((seg) => (seg.value / max) * height)
    return b.segments.map((seg, j) => {
      const below = hs.slice(0, j + 1).reduce((a, c) => a + c, 0)
      return {
        key: `${b.label}-${seg.label}`,
        x,
        y: height - below,
        w,
        h: hs[j],
        color: seg.color,
        title: `${b.label} · ${seg.label}`,
      }
    })
  })
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className="bars"
      role="img"
    >
      {rects.map((r) => (
        <rect key={r.key} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.color}>
          <title>{r.title}</title>
        </rect>
      ))}
    </svg>
  )
}
