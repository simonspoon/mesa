import { useState } from 'react'
import { getCcDashboard } from '../api'
import { Donut, StackedBars, type Slice } from '../components/charts'
import type { CcDashboard } from '../types/CcDashboard'
import { useFetch } from '../useFetch'

// CC Dashboard: telemetry over Claude Code's own session transcripts — sessions,
// token usage, models, skills, agents, and estimated cost. Read-only; it reads
// ~/.claude/projects via the API, not the mesa store. The headline use is
// optimizing skills/agents (which burn the most tokens per use).

const WINDOWS: { id: string; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
]

// Token-type colours, shared by the legend, the daily chart, and the breakdown.
const TOK = {
  input: { label: 'input', color: 'var(--cyan)' },
  output: { label: 'output', color: 'var(--magenta)' },
  cache_read: { label: 'cache read', color: 'var(--green)' },
  cache_creation: { label: 'cache write', color: 'var(--amber)' },
} as const

// Donut palette for the model split.
const PALETTE = [
  'var(--cyan)',
  'var(--magenta)',
  'var(--green)',
  'var(--amber)',
  'var(--red)',
  '#7a8cff',
  '#5d7f8f',
]

const fmtInt = (n: number) => n.toLocaleString()
const fmtTok = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${n}`
const fmtUsd = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`
const fmtMin = (n: number) =>
  n >= 60 ? `${(n / 60).toFixed(1)}h` : `${Math.round(n)}m`
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`

// ---- generic sortable table ----

type Col<T> = {
  key: string
  label: string
  render: (r: T) => React.ReactNode
  sort?: (r: T) => number | string
  numeric?: boolean
}

function DataTable<T>({
  rows,
  cols,
  initialKey,
  initialDir = 'desc',
  empty,
  rowKey,
}: {
  rows: T[]
  cols: Col<T>[]
  initialKey: string
  initialDir?: 'asc' | 'desc'
  empty: string
  // Stable identity per row so React reconciles correctly across re-sorts.
  rowKey: (r: T) => string
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
        {sorted.map((r) => (
          <tr key={rowKey(r)}>
            {cols.map((c) => (
              <td key={c.key} className={c.numeric ? 'num' : ''}>
                {c.render(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="cc-kpi">
      <div className="cc-kpi-value">{value}</div>
      <div className="cc-kpi-label">{label}</div>
      {sub && <div className="cc-kpi-sub">{sub}</div>}
    </div>
  )
}

export function CCDashboardView() {
  const [window, setWindow] = useState('30d')
  const { data, error } = useFetch(() => getCcDashboard(window), `cc-${window}`, {
    pollMs: 20000,
  })

  return (
    <div className="cc-dashboard-page">
      <div className="cc-head">
        <h1>CC Dashboard</h1>
        <div className="cc-window">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              className={w.id === window ? 'active' : ''}
              onClick={() => setWindow(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        Telemetry from Claude Code session transcripts. Costs are estimates from a
        static price table.
      </p>

      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <Dashboard data={data} />
      )}
    </div>
  )
}

function Dashboard({ data }: { data: CcDashboard }) {
  const o = data.overview

  // Daily activity: one stacked bar per day, segmented by token type.
  const bars = data.daily.map((d) => ({
    label: d.date,
    segments: [
      { label: TOK.input.label, value: d.tokens.input, color: TOK.input.color },
      { label: TOK.cache_read.label, value: d.tokens.cache_read, color: TOK.cache_read.color },
      { label: TOK.cache_creation.label, value: d.tokens.cache_creation, color: TOK.cache_creation.color },
      { label: TOK.output.label, value: d.tokens.output, color: TOK.output.color },
    ],
  }))

  // Model split donut (top models by tokens; rest folded into "other").
  const modelSlices: Slice[] = data.models.slice(0, 6).map((m, i) => ({
    label: m.model,
    value: m.total_tokens,
    color: PALETTE[i % PALETTE.length],
  }))
  const restTokens = data.models
    .slice(6)
    .reduce((s, m) => s + m.total_tokens, 0)
  if (restTokens > 0)
    modelSlices.push({ label: 'other', value: restTokens, color: '#3a4a55' })

  return (
    <>
      <div className="cc-kpis">
        <Kpi label="Sessions" value={fmtInt(o.sessions)} sub={`${o.active_days} active days`} />
        <Kpi label="Messages" value={fmtInt(o.messages)} sub={`${fmtInt(Math.round(o.avg_tokens_per_session))} tok/session`} />
        <Kpi label="Tokens" value={fmtTok(o.total_tokens)} sub={`${fmtTok(o.tokens.input)} in · ${fmtTok(o.tokens.output)} out`} />
        <Kpi label="Est. cost" value={fmtUsd(o.est_cost_usd)} sub="estimated" />
        <Kpi label="Cache hit" value={fmtPct(o.cache_hit_ratio)} sub={`${fmtTok(o.tokens.cache_read)} cached`} />
        <Kpi label="Avg session" value={fmtMin(o.avg_session_minutes)} sub={`median ${fmtMin(o.median_session_minutes)}`} />
      </div>

      <div className="cc-grid">
        <section className="cc-panel cc-span2">
          <h2>Daily token usage</h2>
          <Legend />
          <StackedBars bars={bars} height={170} />
          <div className="cc-axis">
            <span>{data.daily[0]?.date ?? ''}</span>
            <span>{data.daily[data.daily.length - 1]?.date ?? ''}</span>
          </div>
        </section>

        <section className="cc-panel">
          <h2>Models</h2>
          <div className="cc-donut-wrap">
            <Donut slices={modelSlices} />
            <ul className="cc-legend-list">
              {modelSlices.map((s) => (
                <li key={s.label}>
                  <span className="swatch" style={{ background: s.color }} />
                  <span className="cc-legend-name">{s.label}</span>
                  <span className="num">{fmtTok(s.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="cc-panel">
        <h2>Skills</h2>
        <p className="muted cc-hint">
          Where token spend goes by skill — the lever for optimization. Click a
          column to sort.
        </p>
        <DataTable
          rows={data.skills}
          rowKey={(s) => s.skill}
          initialKey="tokens"
          empty="No skill-attributed usage in this window."
          cols={[
            { key: 'skill', label: 'Skill', render: (s) => s.skill, sort: (s) => s.skill },
            { key: 'sessions', label: 'Sessions', numeric: true, render: (s) => fmtInt(s.sessions), sort: (s) => s.sessions },
            { key: 'messages', label: 'Msgs', numeric: true, render: (s) => fmtInt(s.messages), sort: (s) => s.messages },
            { key: 'tokens', label: 'Tokens', numeric: true, render: (s) => fmtTok(s.total_tokens), sort: (s) => s.total_tokens },
            { key: 'avg', label: 'Avg/msg', numeric: true, render: (s) => fmtTok(Math.round(s.total_tokens / Math.max(1, s.messages))), sort: (s) => s.total_tokens / Math.max(1, s.messages) },
            { key: 'cost', label: 'Est. cost', numeric: true, render: (s) => fmtUsd(s.est_cost_usd), sort: (s) => s.est_cost_usd },
          ]}
        />
      </section>

      <section className="cc-panel">
        <h2>Agents</h2>
        <p className="muted cc-hint">Usage by subagent (attributionAgent).</p>
        <DataTable
          rows={data.agents}
          rowKey={(a) => a.agent}
          initialKey="tokens"
          empty="No agent-attributed usage in this window."
          cols={[
            { key: 'agent', label: 'Agent', render: (a) => a.agent, sort: (a) => a.agent },
            { key: 'sessions', label: 'Sessions', numeric: true, render: (a) => fmtInt(a.sessions), sort: (a) => a.sessions },
            { key: 'messages', label: 'Msgs', numeric: true, render: (a) => fmtInt(a.messages), sort: (a) => a.messages },
            { key: 'tokens', label: 'Tokens', numeric: true, render: (a) => fmtTok(a.total_tokens), sort: (a) => a.total_tokens },
            { key: 'cost', label: 'Est. cost', numeric: true, render: (a) => fmtUsd(a.est_cost_usd), sort: (a) => a.est_cost_usd },
          ]}
        />
      </section>

      <section className="cc-panel">
        <h2>Projects</h2>
        <DataTable
          rows={data.projects}
          rowKey={(p) => p.path}
          initialKey="tokens"
          empty="No project activity in this window."
          cols={[
            { key: 'project', label: 'Project', render: (p) => <span title={p.path}>{p.project}</span>, sort: (p) => p.project },
            { key: 'sessions', label: 'Sessions', numeric: true, render: (p) => fmtInt(p.sessions), sort: (p) => p.sessions },
            { key: 'messages', label: 'Msgs', numeric: true, render: (p) => fmtInt(p.messages), sort: (p) => p.messages },
            { key: 'tokens', label: 'Tokens', numeric: true, render: (p) => fmtTok(p.total_tokens), sort: (p) => p.total_tokens },
            { key: 'cost', label: 'Est. cost', numeric: true, render: (p) => fmtUsd(p.est_cost_usd), sort: (p) => p.est_cost_usd },
          ]}
        />
      </section>

      <section className="cc-panel">
        <h2>Sessions</h2>
        <p className="muted cc-hint">
          {data.sessions.length < o.sessions
            ? `Showing ${data.sessions.length} of ${fmtInt(o.sessions)} (most recent).`
            : `${data.sessions.length} sessions.`}
        </p>
        <DataTable
          rows={data.sessions}
          rowKey={(s) => s.session_id}
          initialKey="start"
          empty="No sessions in this window."
          cols={[
            { key: 'start', label: 'Started', render: (s) => s.start.replace('T', ' ').slice(0, 16), sort: (s) => s.start },
            { key: 'project', label: 'Project', render: (s) => s.project ?? '—', sort: (s) => s.project ?? '' },
            { key: 'models', label: 'Model(s)', render: (s) => s.models.map((m) => m.replace('claude-', '')).join(', ') },
            { key: 'dur', label: 'Duration', numeric: true, render: (s) => fmtMin(s.duration_minutes), sort: (s) => s.duration_minutes },
            { key: 'msgs', label: 'Msgs', numeric: true, render: (s) => fmtInt(s.messages), sort: (s) => s.messages },
            { key: 'tokens', label: 'Tokens', numeric: true, render: (s) => fmtTok(s.total_tokens), sort: (s) => s.total_tokens },
            { key: 'cost', label: 'Est. cost', numeric: true, render: (s) => fmtUsd(s.est_cost_usd), sort: (s) => s.est_cost_usd },
          ]}
        />
      </section>
    </>
  )
}

function Legend() {
  return (
    <ul className="cc-legend">
      {Object.values(TOK).map((t) => (
        <li key={t.label}>
          <span className="swatch" style={{ background: t.color }} />
          {t.label}
        </li>
      ))}
    </ul>
  )
}
