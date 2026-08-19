import { getCcSessionDetail } from '../api'
import { Donut, Sparkbars } from '../components/charts'
import { DataTable, Kpi } from '../components/ccTable'
import { shortModel } from '../sessionGraph'
import {
  bucketSeries,
  cacheHitRatio,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtTok,
  fmtUsd,
  tokenSlices,
  tokensPerMinute,
  topTools,
} from '../sessionDetail'
import type { CcSessionDetail } from '../types/CcSessionDetail'
import type { CcSessionThreadStat } from '../types/CcSessionThreadStat'
import { useLiveContext } from '../liveContext'
import { useFetch } from '../useFetch'

// One session's detail page (`#/cc/sessions/:id`) — the DEFAULT drill-down from
// the Sessions table. KPIs, a token-composition donut, an activity series over
// the span, and per-tool / per-model / per-subagent breakdowns; the call tree
// itself is one link away at `#/cc/sessions/:id/graph`.
//
// Every number here comes from `GET /api/cc/sessions/{id}`, which aggregates
// every persisted row server-side. None of it is derived from the graph
// payload: that one caps its tool nodes and its tool/response nodes repeat one
// message's usage, so a per-tool count taken from it would silently cover a
// prefix and a token-over-time series is not recoverable at all.
//
// `agent`, `skill`, `description`, tool names and `project`/`cwd` are untrusted
// transcript text — every one of them is rendered as a text child or a `title`,
// never as markup, a URL or an `href`.

const TOP_TOOLS = 12

const stamp = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—')
const clock = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(11, 16) : '')

export function CCSessionDetailView({ sessionId }: { sessionId: string }) {
  const { data, error } = useFetch(
    () => getCcSessionDetail(sessionId),
    `cc-detail:${sessionId}`,
  )
  // What the person is looking at (mesa task 888). The whole session id is the
  // identity; the label is what the heading says out loud — the project it ran
  // in, once that has landed, and the short id nobody would read a UUID for.
  useLiveContext({
    kind: 'dashboard',
    id: sessionId,
    label: data?.project
      ? `${data.project} session ${sessionId.split('-')[0]}`
      : `session ${sessionId.split('-')[0]}`,
    detail: null,
  })

  return (
    <div className="cc-dashboard-page">
      <header className="cc-graph-head">
        <a className="cc-graph-back" href="#/cc/sessions">
          ← Sessions
        </a>
        <h1>Session {sessionId.split('-')[0]}</h1>
        {data && (
          <div className="cc-graph-meta">
            {data.project && <span className="cc-badge">{data.project}</span>}
            {data.git_branch && <span className="cc-graph-branch">{data.git_branch}</span>}
            <span>
              {stamp(data.start)} → {clock(data.end) || '—'}
            </span>
          </div>
        )}
        <a className="cc-graph-back cc-detail-graphlink" href={timelineHref(sessionId)}>
          Timeline →
        </a>
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <Body d={data} />}
    </div>
  )
}

function timelineHref(sessionId: string) {
  return `#/cc/sessions/${encodeURIComponent(sessionId)}/timeline`
}

function Body({ d }: { d: CcSessionDetail }) {
  const slices = tokenSlices(d.tokens)
  const perMin = tokensPerMinute(d.total_tokens, d.duration_minutes)
  const tools = topTools(d.tools, TOP_TOOLS)
  const maxCalls = Math.max(1, ...tools.map((t) => t.calls))
  const threads: CcSessionThreadStat[] = [d.main, ...d.agents]

  return (
    <>
      <div className="cc-kpis">
        <Kpi
          label="Tokens"
          value={fmtTok(d.total_tokens)}
          sub={`${fmtTok(d.tokens.input)} in · ${fmtTok(d.tokens.output)} out`}
        />
        <Kpi label="Est. cost" value={fmtUsd(d.est_cost_usd)} sub="estimated" />
        <Kpi label="Duration" value={fmtDuration(d.duration_minutes)} sub={stamp(d.start)} />
        <Kpi label="Messages" value={fmtInt(d.messages)} />
        <Kpi
          label="Tool calls"
          value={fmtInt(d.tool_calls)}
          sub={`${d.tools.length} distinct tools`}
        />
        <Kpi
          label="Subagents"
          value={fmtInt(d.agent_runs)}
          sub={d.agent_runs > 0 ? `${fmtTok(subagentTokens(d))} tok` : 'none'}
        />
        <Kpi
          label="Cache hit"
          value={fmtPct(cacheHitRatio(d.tokens))}
          sub={`${fmtTok(d.tokens.cache_read)} cached`}
        />
        <Kpi label="Tokens/min" value={fmtTok(Math.round(perMin))} sub="over the span" />
      </div>

      <div className="cc-grid">
        <section className="cc-panel">
          <h2>Token composition</h2>
          {slices.length === 0 ? (
            <p className="muted">This session recorded no token usage.</p>
          ) : (
            <div className="cc-donut-wrap">
              <Donut slices={slices} />
              <ul className="cc-legend-list">
                {slices.map((s) => (
                  <li key={s.label}>
                    <span className="swatch" style={{ background: s.color }} />
                    <span className="cc-legend-name">{s.label}</span>
                    <span className="num">{fmtTok(s.value)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="cc-panel">
          <h2>Activity</h2>
          <p className="muted cc-hint">
            {d.activity.length === 1
              ? 'The session has no measurable span — one bucket holds everything.'
              : `${d.activity.length} equal buckets across the session.`}
          </p>
          {/* Two series rather than one stacked chart: tokens and tool calls
              differ by three orders of magnitude, so sharing a scale would
              flatten the calls into the axis. */}
          <div className="cc-spark-row">
            <span className="cc-spark-label">tokens</span>
            <Sparkbars values={bucketSeries(d.activity, 'total_tokens')} color="var(--cyan)" />
          </div>
          <div className="cc-spark-row">
            <span className="cc-spark-label">tool calls</span>
            <Sparkbars values={bucketSeries(d.activity, 'tool_calls')} color="var(--magenta)" />
          </div>
          <div className="cc-axis">
            <span>{stamp(d.start)}</span>
            <span>{stamp(d.end)}</span>
          </div>
        </section>
      </div>

      <section className="cc-panel">
        <h2>Top tools</h2>
        {tools.length === 0 ? (
          <p className="muted">This session made no tool calls.</p>
        ) : (
          <ul className="cc-toolbars">
            {tools.map((t) => (
              <li key={t.name}>
                {/* Untrusted transcript text: a text child, and the title is
                    plain text too. */}
                <span className="cc-toolbar-name" title={t.name}>
                  {t.name}
                </span>
                <span className="cc-toolbar-track">
                  <span
                    className="cc-toolbar-fill"
                    style={{ width: `${(t.calls / maxCalls) * 100}%` }}
                  />
                </span>
                <span className="cc-toolbar-num">{fmtInt(t.calls)}</span>
                <span className="cc-toolbar-sub muted">
                  {t.subagent_calls > 0 ? `${fmtInt(t.subagent_calls)} by subagents` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.skills.length > 0 && (
        <section className="cc-panel">
          <h2>Skills</h2>
          <DataTable
            rows={d.skills}
            rowKey={(s) => s.name}
            initialKey="calls"
            empty="No skill invocations in this session."
            cols={[
              { key: 'name', label: 'Skill', render: (s) => s.name, sort: (s) => s.name },
              {
                key: 'calls',
                label: 'Calls',
                numeric: true,
                render: (s) => fmtInt(s.calls),
                sort: (s) => s.calls,
              },
            ]}
          />
        </section>
      )}

      <section className="cc-panel">
        <h2>Models</h2>
        <DataTable
          rows={d.models}
          rowKey={(m) => m.model}
          initialKey="tokens"
          empty="This session recorded no model usage."
          cols={[
            {
              key: 'model',
              label: 'Model',
              render: (m) => <span title={m.model}>{shortModel(m.model) ?? m.model}</span>,
              sort: (m) => m.model,
            },
            {
              key: 'messages',
              label: 'Msgs',
              numeric: true,
              render: (m) => fmtInt(m.messages),
              sort: (m) => m.messages,
            },
            {
              key: 'tokens',
              label: 'Tokens',
              numeric: true,
              render: (m) => fmtTok(m.total_tokens),
              sort: (m) => m.total_tokens,
            },
            {
              key: 'cost',
              label: 'Est. cost',
              numeric: true,
              render: (m) => fmtUsd(m.est_cost_usd),
              sort: (m) => m.est_cost_usd,
            },
          ]}
        />
      </section>

      <section className="cc-panel">
        <h2>Threads</h2>
        <p className="muted cc-hint">
          {d.agents.length === 0
            ? 'This session ran no subagents — everything below is the main thread.'
            : 'The main thread and each subagent, so their spend is directly comparable.'}
        </p>
        <DataTable
          rows={threads}
          rowKey={(t) => t.agent_id ?? 'main'}
          initialKey="tokens"
          empty="No threads recorded."
          cols={[
            {
              key: 'thread',
              label: 'Thread',
              render: (t) =>
                t.agent_id == null ? (
                  <strong>main</strong>
                ) : (
                  <span title={t.agent_id}>{t.agent ?? 'subagent'}</span>
                ),
              sort: (t) => (t.agent_id == null ? '' : (t.agent ?? t.agent_id)),
            },
            { key: 'skill', label: 'Skill', render: (t) => t.skill ?? '—' },
            {
              key: 'description',
              label: 'Description',
              render: (t) => <span title={t.description ?? undefined}>{t.description ?? '—'}</span>,
            },
            {
              key: 'depth',
              label: 'Depth',
              numeric: true,
              render: (t) => (t.spawn_depth == null ? '—' : String(t.spawn_depth)),
              sort: (t) => t.spawn_depth ?? 0,
            },
            {
              key: 'model',
              label: 'Model',
              render: (t) => (t.model ? (shortModel(t.model) ?? t.model) : '—'),
            },
            {
              key: 'messages',
              label: 'Msgs',
              numeric: true,
              render: (t) => fmtInt(t.messages),
              sort: (t) => t.messages,
            },
            {
              key: 'tools',
              label: 'Tools',
              numeric: true,
              render: (t) => fmtInt(t.tool_calls),
              sort: (t) => t.tool_calls,
            },
            {
              key: 'tokens',
              label: 'Tokens',
              numeric: true,
              render: (t) => fmtTok(t.total_tokens),
              sort: (t) => t.total_tokens,
            },
            {
              key: 'cost',
              label: 'Est. cost',
              numeric: true,
              render: (t) => fmtUsd(t.est_cost_usd),
              sort: (t) => t.est_cost_usd,
            },
          ]}
        />
      </section>

      <section className="cc-panel">
        <h2>Details</h2>
        <dl className="cc-details">
          <dt>Session id</dt>
          <dd>{d.session_id}</dd>
          <dt>Working dir</dt>
          <dd>{d.cwd ?? '—'}</dd>
          <dt>Branch</dt>
          <dd>{d.git_branch ?? '—'}</dd>
          <dt>Entrypoint</dt>
          <dd>{d.entrypoint ?? '—'}</dd>
          <dt>Start</dt>
          <dd>{stamp(d.start)}</dd>
          <dt>End</dt>
          <dd>{stamp(d.end)}</dd>
        </dl>
        <p className="muted cc-hint">
          Costs are estimates from a static price table. <a href={timelineHref(d.session_id)}>
            Open the timeline →
          </a>
        </p>
      </section>
    </>
  )
}

function subagentTokens(d: CcSessionDetail): number {
  return d.agents.reduce((s, a) => s + a.total_tokens, 0)
}
