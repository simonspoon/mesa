import { describe, expect, it } from 'vitest'
import {
  NODE_H,
  NODE_W,
  childrenByParent,
  formatTokens,
  layoutSessionGraph,
  shortModel,
} from './sessionGraph'
import type { CcGraphNode } from './types/CcGraphNode'
import type { CcSessionGraph } from './types/CcSessionGraph'

// Mirrors the module's own gaps, so a change to either surfaces as a failing
// coordinate rather than a silently reflowed canvas.
const GAP_X = 80
const GAP_Y = 14
const ROW = NODE_H + GAP_Y
const COL = NODE_W + GAP_X

const ZERO = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }

const node = (
  id: string,
  kind: CcGraphNode['kind'],
  extra: Partial<CcGraphNode> = {},
): CcGraphNode => ({
  id,
  kind,
  name: id,
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

const graph = (
  nodes: CcGraphNode[],
  edges: { from: string; to: string }[],
): CcSessionGraph => ({
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
})

describe('childrenByParent', () => {
  it('orders siblings by timestamp, nulls last', () => {
    const g = graph(
      [
        node('session', 'session'),
        node('a', 'tool', { ts: '2026-07-26T10:00:02Z' }),
        node('b', 'tool', { ts: '2026-07-26T10:00:01Z' }),
        node('c', 'tool', { ts: null }),
      ],
      [
        { from: 'session', to: 'a' },
        { from: 'session', to: 'b' },
        { from: 'session', to: 'c' },
      ],
    )
    expect(childrenByParent(g).get('session')).toEqual(['b', 'a', 'c'])
  })

  it('ignores an edge naming a node that is not in the payload', () => {
    const g = graph([node('session', 'session')], [{ from: 'session', to: 'ghost' }])
    expect(childrenByParent(g).get('session')).toBeUndefined()
  })
})

describe('layoutSessionGraph', () => {
  it('handles an empty graph', () => {
    const { nodes, edges } = layoutSessionGraph(graph([], []))
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })

  it('puts a lone root at the origin', () => {
    const { nodes } = layoutSessionGraph(graph([node('session', 'session')], []))
    expect(nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it('stacks leaves on the cross axis and steps depth on the flow axis', () => {
    const g = graph(
      [node('session', 'session'), node('t1', 'tool'), node('t2', 'tool')],
      [
        { from: 'session', to: 't1' },
        { from: 'session', to: 't2' },
      ],
    )
    const at = byId(layoutSessionGraph(g).nodes)
    expect(at('t1')).toEqual({ x: COL, y: 0 })
    expect(at('t2')).toEqual({ x: COL, y: ROW })
  })

  it('aligns a parent with its first child, not the midpoint', () => {
    const g = graph(
      [node('session', 'session'), node('t1', 'tool'), node('t2', 'tool')],
      [
        { from: 'session', to: 't1' },
        { from: 'session', to: 't2' },
      ],
    )
    const at = byId(layoutSessionGraph(g).nodes)
    // Not `ROW / 2`: a main thread of hundreds of calls would leave the root
    // stranded halfway down a column thousands of pixels tall.
    expect(at('session')).toEqual({ x: 0, y: 0 })
    expect(at('t1')!.y).toBe(0)
  })

  it('gives a nested subagent its own depth column', () => {
    // session -> Task call -> subagent -> the subagent's own tool call
    const g = graph(
      [
        node('session', 'session'),
        node('tool:task', 'tool', { name: 'Task' }),
        node('agent:a', 'agent'),
        node('tool:read', 'tool', { name: 'Read' }),
      ],
      [
        { from: 'session', to: 'tool:task' },
        { from: 'tool:task', to: 'agent:a' },
        { from: 'agent:a', to: 'tool:read' },
      ],
    )
    const at = byId(layoutSessionGraph(g).nodes)
    expect(at('tool:task')!.x).toBe(COL)
    expect(at('agent:a')!.x).toBe(2 * COL)
    expect(at('tool:read')!.x).toBe(3 * COL)
    // A single chain: every node lines up on one row.
    expect(new Set([at('session')!.y, at('agent:a')!.y, at('tool:read')!.y]).size).toBe(1)
  })

  it('positions a node the root cannot reach instead of dropping it', () => {
    // Only reachable if the server's tree guarantee breaks; the page must
    // still render every node it was sent.
    const g = graph([node('session', 'session'), node('orphan', 'tool')], [])
    const { nodes } = layoutSessionGraph(g)
    expect(nodes).toHaveLength(2)
    expect(byId(nodes)('orphan')).toBeDefined()
  })

  it('terminates and drops the repeat visit when an edge set forms a cycle', () => {
    const g = graph(
      [node('session', 'session'), node('a', 'tool'), node('b', 'tool')],
      [
        { from: 'session', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }, // back edge
      ],
    )
    const { nodes } = layoutSessionGraph(g)
    expect(nodes).toHaveLength(3)
  })

  it('emits one edge per payload edge, keyed from->to', () => {
    const g = graph(
      [node('session', 'session'), node('t1', 'tool')],
      [{ from: 'session', to: 't1' }],
    )
    expect(layoutSessionGraph(g).edges).toEqual([
      { id: 'session->t1', source: 'session', target: 't1' },
    ])
  })
})

describe('formatTokens', () => {
  it('leaves small counts alone', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(231)).toBe('231')
    expect(formatTokens(999)).toBe('999')
  })

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(44_741)).toBe('44.7k')
    expect(formatTokens(2_053_315)).toBe('2.05M')
  })

  it('does not render a negative or non-finite count', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('shortModel', () => {
  it('strips the vendor prefix and a date suffix', () => {
    expect(shortModel('claude-opus-5')).toBe('opus-5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  })

  it('keeps a bracketed context marker, which is not a date suffix', () => {
    expect(shortModel('claude-opus-5[1m]')).toBe('opus-5[1m]')
  })

  it('passes through an unknown model and null', () => {
    expect(shortModel('<synthetic>')).toBe('<synthetic>')
    expect(shortModel(null)).toBeNull()
  })
})

function byId(nodes: { id: string; position: { x: number; y: number } }[]) {
  const m = new Map(nodes.map((n) => [n.id, n.position]))
  return (id: string) => m.get(id)
}
