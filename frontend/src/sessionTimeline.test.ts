import { describe, expect, it } from 'vitest'
import { filterRows, threadOf, threadOptions, timelineRows } from './sessionTimeline'
import type { CcGraphNode } from './types/CcGraphNode'
import type { CcSessionGraph } from './types/CcSessionGraph'

const ZERO = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }

const node = (
  id: string,
  kind: CcGraphNode['kind'],
  extra: Partial<CcGraphNode> = {},
): CcGraphNode => ({
  id,
  kind,
  name: id,
  target: null,
  model: null,
  tokens: ZERO,
  total_tokens: 0,
  tokens_are_rollup: kind !== 'tool',
  est_cost_usd: 0,
  ts: null,
  skill: null,
  description: null,
  spawn_depth: null,
  messages: 0,
  tool_calls: 0,
  caller: null,
  ...extra,
})

const graph = (nodes: CcGraphNode[], edges: { from: string; to: string }[]): CcSessionGraph => ({
  session_id: 's',
  cwd: null,
  project: null,
  git_branch: null,
  start: null,
  end: null,
  tokens: ZERO,
  total_tokens: 0,
  est_cost_usd: 0,
  nodes,
  edges,
  truncated: false,
  omitted_tool_calls: 0,
  omitted_responses: 0,
})

// session ─ t1
//         ├ a1 (agent) ─ t2
//         └ t3
const simple = () =>
  graph(
    [
      node('session', 'session', { total_tokens: 900 }),
      node('t1', 'tool', { name: 'Bash', target: 'ls -la' }),
      node('a1', 'agent', { name: 'Explore', total_tokens: 300 }),
      node('t2', 'tool', { name: 'Read', target: '/src/store.rs' }),
      node('t3', 'tool', { name: 'Edit', target: '/src/api.rs' }),
    ],
    [
      { from: 'session', to: 't1' },
      { from: 'session', to: 'a1' },
      { from: 'a1', to: 't2' },
      { from: 'session', to: 't3' },
    ],
  )

describe('threadOf', () => {
  it('maps main-thread nodes to null and a subagent’s children to its id', () => {
    const t = threadOf(simple())
    expect(t.get('t1')).toBeNull()
    expect(t.get('t3')).toBeNull()
    // The agent node itself belongs to the thread that spawned it.
    expect(t.get('a1')).toBeNull()
    expect(t.get('t2')).toBe('a1')
  })

  it('finds the nearest agent ancestor when subagents nest', () => {
    const g = graph(
      [node('session', 'session'), node('a1', 'agent'), node('a2', 'agent'), node('t', 'tool')],
      [
        { from: 'session', to: 'a1' },
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 't' },
      ],
    )
    const t = threadOf(g)
    expect(t.get('a2')).toBe('a1')
    expect(t.get('t')).toBe('a2')
  })

  it('ignores edges naming absent nodes and defaults a parentless node to main', () => {
    const g = graph([node('session', 'session'), node('t1', 'tool')], [{ from: 'ghost', to: 't1' }])
    expect(threadOf(g).get('t1')).toBeNull()
  })

  it('terminates on a cyclic payload', () => {
    const g = graph(
      [node('a', 'tool'), node('b', 'tool')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    )
    expect(threadOf(g).get('a')).toBeNull()
  })
})

describe('timelineRows', () => {
  it('drops the session root and keeps payload order', () => {
    expect(timelineRows(simple()).map((r) => r.node.id)).toEqual(['t1', 'a1', 't2', 't3'])
  })

  it('does not re-sort equal or missing timestamps', () => {
    const g = graph(
      [
        node('session', 'session'),
        node('r', 'response', { ts: '2026-08-05T00:00:01Z' }),
        node('t', 'tool', { ts: '2026-08-05T00:00:01Z' }),
        node('z', 'tool', { ts: null }),
      ],
      [],
    )
    expect(timelineRows(g).map((r) => r.node.id)).toEqual(['r', 't', 'z'])
  })

  it('hoists a trailing agent node to the head of its own thread', () => {
    // The server appends every agent node AFTER the whole tool/response block,
    // so at its literal payload position the header row would land at the
    // bottom of the page, far below the run it names.
    const g = graph(
      [node('session', 'session'), node('t1', 'tool'), node('t2', 'tool'), node('a1', 'agent')],
      [
        { from: 'session', to: 't1' },
        { from: 'a1', to: 't2' },
        { from: 'session', to: 'a1' },
      ],
    )
    expect(timelineRows(g).map((r) => r.node.id)).toEqual(['t1', 'a1', 't2'])
  })

  it('emits an outer thread’s header before a nested one’s', () => {
    const g = graph(
      [node('session', 'session'), node('t', 'tool'), node('a2', 'agent'), node('a1', 'agent')],
      [
        { from: 'session', to: 'a1' },
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 't' },
      ],
    )
    expect(timelineRows(g).map((r) => r.node.id)).toEqual(['a1', 'a2', 't'])
  })

  it('still shows an agent whose every row was truncated away', () => {
    const g = graph(
      [node('session', 'session'), node('a1', 'agent')],
      [{ from: 'session', to: 'a1' }],
    )
    expect(timelineRows(g).map((r) => r.node.id)).toEqual(['a1'])
  })

  it('indents subagent rows and only those', () => {
    const rows = timelineRows(simple())
    expect(rows.map((r) => [r.node.id, r.indent])).toEqual([
      ['t1', 0],
      ['a1', 0],
      ['t2', 1],
      ['t3', 0],
    ])
  })
})

describe('filterRows', () => {
  const rows = timelineRows(simple())

  it('returns everything for an empty filter', () => {
    expect(filterRows(rows)).toHaveLength(4)
    expect(filterRows(rows, { query: '  ', kinds: new Set() })).toHaveLength(4)
  })

  it('matches name and target, case-insensitively', () => {
    expect(filterRows(rows, { query: 'bash' }).map((r) => r.node.id)).toEqual(['t1'])
    expect(filterRows(rows, { query: 'API.RS' }).map((r) => r.node.id)).toEqual(['t3'])
  })

  it('filters by kind', () => {
    expect(filterRows(rows, { kinds: new Set(['agent' as const]) }).map((r) => r.node.id)).toEqual([
      'a1',
    ])
  })

  it('keeps a selected thread’s agent header row', () => {
    expect(filterRows(rows, { threadId: 'a1' }).map((r) => r.node.id)).toEqual(['a1', 't2'])
  })

  it('treats a null thread as the main thread, not "no filter"', () => {
    expect(filterRows(rows, { threadId: null }).map((r) => r.node.id)).toEqual(['t1', 'a1', 't3'])
  })

  it('combines filters', () => {
    expect(filterRows(rows, { threadId: 'a1', query: 'store' }).map((r) => r.node.id)).toEqual([
      't2',
    ])
  })

  it('can return nothing', () => {
    expect(filterRows(rows, { query: 'nothing here' })).toEqual([])
  })
})

describe('threadOptions', () => {
  it('lists the main thread first, then subagents in first-appearance order', () => {
    const g = simple()
    g.nodes.push(node('a2', 'agent', { name: 'Plan' }))
    g.edges.push({ from: 'session', to: 'a2' })
    expect(threadOptions(g).map((o) => [o.id, o.label])).toEqual([
      [null, 'Main thread'],
      ['a1', 'Explore'],
      ['a2', 'Plan'],
    ])
  })

  it('counts the tool calls shown, per thread', () => {
    expect(threadOptions(simple()).map((o) => o.calls)).toEqual([2, 1])
  })

  it('reports each thread’s own rollup, never a sum of rows', () => {
    expect(threadOptions(simple()).map((o) => o.tokens)).toEqual([900, 300])
  })

  it('falls back through skill and description, never a blank label', () => {
    const g = graph(
      [
        node('session', 'session'),
        node('a1', 'agent', { name: '  ', skill: 'engineer' }),
        node('a2', 'agent', { name: '', skill: null, description: 'fix the thing' }),
        node('a3', 'agent', { name: '', skill: null, description: null }),
      ],
      [],
    )
    expect(threadOptions(g).map((o) => o.label)).toEqual([
      'Main thread',
      'engineer',
      'fix the thing',
      'Subagent',
    ])
  })
})
