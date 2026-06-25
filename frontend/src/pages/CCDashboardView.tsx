import { useState } from 'react'
import { getCcDashboard, getCcLive, getCcUsage } from '../api'
import { Donut, DivergingBars, Sparkbars, type Slice } from '../components/charts'
import type { CcDashboard } from '../types/CcDashboard'
import type { CcLiveSession } from '../types/CcLiveSession'
import type { CcUsageWindow } from '../types/CcUsageWindow'
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
const fmtAgo = (s: number) =>
  s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
const shortModel = (m: string) => m.replace('claude-', '')

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

      {error && <p className="error">{error}</p>}

      <div className="cc-top">
        <LiveSessions />
        <SubscriptionCard />
      </div>

      {!data && !error && <p className="muted">Loading…</p>}
      {data && <Dashboard data={data} />}
    </div>
  )
}

// The daily diverging-bar chart. Cache (read + write) stacks upward on the
// right-axis scale, input/output stacks downward on the left-axis scale —
// independent scales so the small in/out series stays legible next to the
// much larger cache series.
function DailyChart({ data }: { data: CcDashboard }) {
  const bars = data.daily.map((d) => ({
    label: d.date,
    up: [
      { label: TOK.cache_read.label, value: d.tokens.cache_read, color: TOK.cache_read.color },
      { label: TOK.cache_creation.label, value: d.tokens.cache_creation, color: TOK.cache_creation.color },
    ],
    down: [
      { label: TOK.input.label, value: d.tokens.input, color: TOK.input.color },
      { label: TOK.output.label, value: d.tokens.output, color: TOK.output.color },
    ],
  }))
  const upMax = Math.max(0, ...bars.map((b) => b.up.reduce((s, x) => s + x.value, 0)))
  const downMax = Math.max(0, ...bars.map((b) => b.down.reduce((s, x) => s + x.value, 0)))

  return (
    <>
      <Legend />
      <div className="cc-diverge">
        <div className="cc-diverge-axis" aria-hidden>
          <span className="unit" />
          <span>0</span>
          <span className="cap">
            {fmtTok(downMax)}
            <em>in/out</em>
          </span>
        </div>
        <DivergingBars bars={bars} height={120} />
        <div className="cc-diverge-axis right" aria-hidden>
          <span className="cap">
            {fmtTok(upMax)}
            <em>cache</em>
          </span>
          <span>0</span>
          <span className="unit" />
        </div>
      </div>
      <div className="cc-axis">
        <span>{data.daily[0]?.date ?? ''}</span>
        <span>{data.daily[data.daily.length - 1]?.date ?? ''}</span>
      </div>
    </>
  )
}

// ---- Subscription limits ----
//
// Live Claude Code plan-limit utilization (5-hour + weekly windows, reset
// times, extra-usage credits), fetched from Anthropic's usage endpoint via the
// API (which reuses the local OAuth token). Polled on the server's cache TTL.
// `utilization` is already a 0–100 percentage of the plan limit.

// "resets in 1h 48m" / "2d 4h"; collapses to a coarse unit past a day.
function fmtReset(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting…'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `resets in ${hrs}h ${mins % 60}m`
  return `resets in ${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

function UsageBar({ label, w }: { label: string; w: CcUsageWindow }) {
  const pct = Math.max(0, Math.min(100, w.utilization))
  const sev = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok'
  // Guard on the formatted output, not just presence: a present-but-unparseable
  // resets_at yields '' and should hide the row, not render an empty div.
  const reset = w.resets_at ? fmtReset(w.resets_at) : ''
  return (
    <div className="cc-sub-row">
      <div className="cc-sub-rowtop">
        <span className="cc-sub-label">{label}</span>
        <span className="cc-sub-pct">{pct.toFixed(0)}%</span>
      </div>
      <div className="cc-sub-track">
        <div className={`cc-sub-fill ${sev}`} style={{ width: `${pct}%` }} />
      </div>
      {reset && <div className="cc-sub-reset">{reset}</div>}
    </div>
  )
}

function SubscriptionCard() {
  // Poll on the server's cache TTL (60s); each miss hits Anthropic's endpoint.
  const { data, error } = useFetch(getCcUsage, 'cc-usage', { pollMs: 60000 })
  return (
    <section className="cc-panel cc-sub">
      <div className="cc-sub-head">
        <h2>Subscription Limits</h2>
        {data?.plan_tier && <span className="cc-badge">{data.plan_tier}</span>}
      </div>
      {error ? (
        <p className="muted cc-hint">
          Usage unavailable — {error}
        </p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {data.five_hour && <UsageBar label="5-hour session" w={data.five_hour} />}
          {data.seven_day && <UsageBar label="Weekly · all models" w={data.seven_day} />}
          {data.seven_day_opus && <UsageBar label="Weekly · Opus" w={data.seven_day_opus} />}
          {data.seven_day_sonnet && (
            <UsageBar label="Weekly · Sonnet" w={data.seven_day_sonnet} />
          )}
          {data.extra_usage?.is_enabled && (
            <div className="cc-sub-extra muted">
              Extra-usage credits on · {fmtUsd(data.extra_usage.used_credits)} used
            </div>
          )}
          <div className="cc-sub-foot muted">live from Anthropic · % of plan limit</div>
        </>
      )}
    </section>
  )
}

// ---- Live sessions ----
//
// A near-real-time view of sessions with transcript activity in the last N
// minutes, polled every 5s on its own (cheap) endpoint so it stays fresh
// without re-parsing the whole dashboard. Each session shows a per-minute token
// "heartbeat" plus active/idle status (active = an event within ~90s).

const LIVE_WINDOWS: { m: number; label: string }[] = [
  { m: 15, label: '15m' },
  { m: 60, label: '1h' },
]

function LiveSessions() {
  const [mins, setMins] = useState(15)
  const { data, error } = useFetch(() => getCcLive(mins), `cc-live-${mins}`, {
    pollMs: 5000,
  })

  return (
    <section className="cc-panel cc-live">
      <div className="cc-live-head">
        <h2>
          <span className={`live-dot ${data && data.active_count > 0 ? 'on' : 'off'}`} />
          Live Sessions
        </h2>
        <div className="cc-live-meta">
          {data && (
            <>
              <span>
                <strong>{fmtInt(data.active_count)}</strong> active
              </span>
              <span>
                <strong>{fmtInt(data.live_count)}</strong> live
              </span>
              <span>
                <strong>{fmtTok(Math.round(data.tokens_per_min))}</strong>/min
              </span>
              <span>
                <strong>{fmtUsd(data.est_cost_usd)}</strong>
              </span>
            </>
          )}
          <div className="cc-window">
            {LIVE_WINDOWS.map((w) => (
              <button
                key={w.m}
                type="button"
                className={w.m === mins ? 'active' : ''}
                onClick={() => setMins(w.m)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="muted cc-hint">
        Sessions active in the last {mins < 60 ? `${mins} minutes` : `${mins / 60} hour`}.
        Refreshes every 5s; the bars are tokens per minute.
      </p>

      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : data.sessions.length === 0 ? (
        <p className="muted">No sessions active in this window.</p>
      ) : (
        <div className="cc-live-list">
          {data.sessions.map((s) => (
            <LiveCard key={s.session_id} s={s} />
          ))}
        </div>
      )}
    </section>
  )
}

function LiveCard({ s }: { s: CcLiveSession }) {
  const active = s.status === 'active'
  return (
    <div className={`cc-live-card ${active ? 'active' : 'idle'}`}>
      <div className="cc-live-card-top">
        <span className={`live-dot ${active ? 'on' : 'idle'}`} title={s.status} />
        <span className="cc-live-project" title={s.cwd ?? undefined}>
          {s.project ?? '—'}
        </span>
        {s.git_branch && <span className="cc-live-branch">{s.git_branch}</span>}
        {s.used_subagent && <span className="cc-badge">subagent</span>}
        <span className="cc-live-models">{s.models.map(shortModel).join(', ')}</span>
        <span className="cc-live-ago">{fmtAgo(s.idle_seconds)}</span>
      </div>
      <Sparkbars values={s.spark} color={active ? 'var(--green)' : 'var(--amber)'} />
      <div className="cc-live-stats">
        <span>
          <em>{fmtInt(s.messages)}</em> msgs
        </span>
        <span>
          <em>{fmtTok(s.total_tokens)}</em> tok
        </span>
        <span>
          <em>{fmtUsd(s.est_cost_usd)}</em>
        </span>
      </div>
      {s.subagents.length > 0 && (
        <div className="cc-live-subs">
          {s.subagents.map((sa) => (
            <div className="cc-live-sub" key={sa.agent_id}>
              <span className="live-dot on" title="running" />
              <span className="cc-live-sub-name">{sa.agent ?? 'subagent'}</span>
              {sa.skill && <span className="cc-live-sub-skill">/{sa.skill}</span>}
              {sa.models.length > 0 && (
                <span className="cc-live-sub-models">{sa.models.map(shortModel).join(', ')}</span>
              )}
              <span className="cc-live-sub-tok">{fmtTok(sa.total_tokens)} tok</span>
              <span className="cc-live-sub-ago">{fmtAgo(sa.idle_seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Dashboard({ data }: { data: CcDashboard }) {
  const o = data.overview

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
      <div className="cc-grid">
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

        <section className="cc-panel cc-daily">
          <h2>Daily token usage</h2>
          <DailyChart data={data} />
        </section>
      </div>

      <div className="cc-kpis">
        <Kpi label="Sessions" value={fmtInt(o.sessions)} sub={`${o.active_days} active days`} />
        <Kpi label="Messages" value={fmtInt(o.messages)} sub={`${fmtInt(Math.round(o.avg_tokens_per_session))} tok/session`} />
        <Kpi label="Tokens" value={fmtTok(o.total_tokens)} sub={`${fmtTok(o.tokens.input)} in · ${fmtTok(o.tokens.output)} out`} />
        <Kpi label="Est. cost" value={fmtUsd(o.est_cost_usd)} sub="estimated" />
        <Kpi label="Cache hit" value={fmtPct(o.cache_hit_ratio)} sub={`${fmtTok(o.tokens.cache_read)} cached`} />
        <Kpi label="Avg session" value={fmtMin(o.avg_session_minutes)} sub={`median ${fmtMin(o.median_session_minutes)}`} />
      </div>

      <div className="cc-pair">
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
      </div>

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
