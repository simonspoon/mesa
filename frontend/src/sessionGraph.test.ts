import { describe, expect, it } from 'vitest'
import {
  NODE_H,
  NODE_W,
  RESPONSE_COLOR,
  childrenByParent,
  formatTokens,
  layoutSessionGraph,
  minimapStrokeWidth,
  shortModel,
  shortTarget,
  toolColor,
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
  omitted_responses: 0,
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

  // A message's prose and the calls it issued carry the SAME `ts` — the server
  // (mesa 608) breaks that tie by emitting the response node first, and this is
  // the frontend half of that contract: equal `ts` falls back to server order,
  // so the reply reads before the calls it introduces. Sorting by `ts` alone
  // would leave the order at the mercy of the edge list.
  it('keeps a response ahead of the tool calls it shares a timestamp with', () => {
    const TS = '2026-07-26T10:00:03Z'
    const g = graph(
      [
        node('session', 'session'),
        node('msg:m1', 'response', { name: 'Response', target: 'Reading the file now.', ts: TS }),
        node('tool:t1', 'tool', { name: 'Read', ts: TS }),
        node('tool:t2', 'tool', { name: 'Grep', ts: TS }),
      ],
      [
        // Edge order deliberately does NOT match node order: the tie-break must
        // come from `nodes`, not from however the edges happen to arrive.
        { from: 'session', to: 'tool:t1' },
        { from: 'session', to: 'tool:t2' },
        { from: 'session', to: 'msg:m1' },
      ],
    )
    expect(childrenByParent(g).get('session')).toEqual(['msg:m1', 'tool:t1', 'tool:t2'])
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

  // Load-bearing for <MiniMap>, not cosmetic: with a static `nodes` array and
  // no `onNodesChange`, React Flow never writes `measured` back, so a node
  // carrying no explicit size is skipped by the minimap entirely (mesa 589).
  it('gives every node an explicit size', () => {
    const g = graph(
      [
        node('session', 'session'),
        node('t1', 'tool'),
        node('a1', 'agent'),
        node('msg:m1', 'response', { name: 'Response', target: 'hello' }),
      ],
      [
        { from: 'session', to: 't1' },
        { from: 't1', to: 'a1' },
        { from: 'session', to: 'msg:m1' },
      ],
    )
    const { nodes } = layoutSessionGraph(g)
    expect(nodes).toHaveLength(4)
    for (const n of nodes) {
      expect(n.width).toBe(NODE_W)
      expect(n.height).toBe(NODE_H)
    }
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

describe('minimapStrokeWidth', () => {
  const col = (n: number) =>
    layoutSessionGraph(
      graph(
        [node('session', 'session'), ...Array.from({ length: n }, (_, i) => node(`t${i}`, 'tool'))],
        Array.from({ length: n }, (_, i) => ({ from: 'session', to: `t${i}` })),
      ),
    ).nodes

  it('is zero for an empty graph', () => {
    expect(minimapStrokeWidth([])).toBe(0)
  })

  it('leaves a short graph alone, where nodes already render big enough', () => {
    // 3 rows ≈ 268 flow units: at 150px tall an 80-unit node is already ~45px.
    expect(minimapStrokeWidth(col(3))).toBe(0)
  })

  it('pads a tall graph until a node clears the 3px floor', () => {
    const nodes = col(600)
    const stroke = minimapStrokeWidth(nodes)
    expect(stroke).toBeGreaterThan(0)
    const top = Math.min(...nodes.map((n) => n.position.y))
    const bottom = Math.max(...nodes.map((n) => n.position.y + n.height))
    // The whole point: the padded mark is at least 3 minimap pixels tall.
    expect(((NODE_H + stroke) * 150) / (bottom - top)).toBeGreaterThanOrEqual(3)
  })

  it('grows with the graph', () => {
    expect(minimapStrokeWidth(col(600))).toBeGreaterThan(minimapStrokeWidth(col(200)))
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

describe('shortTarget', () => {
  const t = (name: string, target: string | null) => shortTarget({ kind: 'tool', name, target })

  it('shows a file tool its file name, not the path to it', () => {
    expect(t('Read', '/Users/me/inaros/projects/tools/mesa/src/core/cc.rs')).toBe('cc.rs')
    expect(t('Edit', '/a/b/App.css')).toBe('App.css')
    expect(t('Write', 'relative/dir/notes.md')).toBe('notes.md')
  })

  it('leaves a command whole, including one that opens with a path', () => {
    expect(t('Bash', 'git status --short')).toBe('git status --short')
    // The flags are the informative half — basenaming this to `foo` would
    // throw away everything the reader is scanning for.
    expect(t('Bash', '/usr/local/bin/foo --flag')).toBe('/usr/local/bin/foo --flag')
    expect(t('WebFetch', 'https://example.dev/a/b')).toBe('https://example.dev/a/b')
  })

  it('basenames an unrecognised tool only when the value looks like a bare path', () => {
    expect(t('SomeNewFileTool', '/a/b/c.txt')).toBe('c.txt')
    expect(t('SomeNewFileTool', './rel/c.txt')).toBe('c.txt')
    expect(t('SomeNewFileTool', '~/notes/c.txt')).toBe('c.txt')
    // Spaces mean it is a command line, not a path.
    expect(t('SomeNewTool', '/a/b/c.txt --flag')).toBe('/a/b/c.txt --flag')
    // No leading path marker, so it is a query/name and stays whole.
    expect(t('SomeNewTool', 'src/core/cc.rs')).toBe('src/core/cc.rs')
  })

  it('passes a response preview through untouched', () => {
    const r = (target: string) => shortTarget({ kind: 'response', name: 'Response', target })
    // Prose, not a target: the path heuristic would basename a slash-command
    // reply into `clear` and a bare sentence-free reply into its last segment.
    expect(r('/clear')).toBe('/clear')
    expect(r('~/notes/c.txt')).toBe('~/notes/c.txt')
    expect(r('Done — the migration is applied.')).toBe('Done — the migration is applied.')
  })

  it('degrades instead of returning an empty label', () => {
    expect(t('Read', null)).toBeNull()
    expect(t('Bash', null)).toBeNull()
    // A trailing slash yields the directory, never ''.
    expect(t('Read', '/a/b/')).toBe('b')
    expect(t('Read', '/')).toBe('/')
  })
})

describe('toolColor', () => {
  it('is total — every name gets a real colour, including ones we have never seen', () => {
    for (const name of ['Bash', 'mcp__ccd_session__mark_chapter', 'SomeToolShippedNextMonth', '']) {
      expect(toolColor(name)).toMatch(/^hsl\(/)
    }
  })

  it('is stable for a given name', () => {
    // The point of the feature: the same tool is the same colour on every
    // reload and in every session, so a reader can learn the mapping.
    expect(toolColor('Grep')).toBe(toolColor('Grep'))
    expect(toolColor('mcp__x__y')).toBe(toolColor('mcp__x__y'))
  })

  it('never gives two high-volume tools the same colour', () => {
    // These are ~95% of the calls in a real transcript, so a collision here
    // would flatten most of the column back to one stripe. Ordered by observed
    // volume in the cc_tool_calls table.
    const hot = [
      'Bash',
      'Read',
      'Edit',
      'WebFetch',
      'Write',
      'StructuredOutput',
      'Agent',
      'WebSearch',
      'ToolSearch',
      'AskUserQuestion',
      'Glob',
      'Skill',
      'EnterWorktree',
      'TaskUpdate',
    ]
    const colors = hot.map(toolColor)
    expect(new Set(colors).size).toBe(hot.length)
  })

  it('never lets an unknown tool land on a high-volume tool colour', () => {
    // The hash draws from a reserved tail of the palette, so a name nobody has
    // seen can share with another rare tool but can never impersonate `Bash`.
    // Regression: `advisor` used to hash exactly onto `Write`.
    const hot = new Set(['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'Skill'].map(toolColor))
    for (const name of ['advisor', 'mcp__ccd_session__mark_chapter', 'Xyzzy', 'ReportFindings']) {
      expect(hot.has(toolColor(name))).toBe(false)
    }
  })

  it('gives one act one colour under all its spellings', () => {
    // Deliberate sharing, not a collision: colouring these apart would invent
    // a distinction a reader scanning the column does not have.
    expect(toolColor('Task')).toBe(toolColor('Agent'))
    expect(toolColor('Grep')).toBe(toolColor('Glob'))
    expect(toolColor('EnterWorktree')).toBe(toolColor('ExitWorktree'))
    expect(toolColor('TaskCreate')).toBe(toolColor('TaskStop'))
    expect(toolColor('SendMessage')).toBe(toolColor('SendUserFile'))
  })
})

describe('RESPONSE_COLOR', () => {
  it('is reserved — no tool can reach it, by table or by hash', () => {
    // One name per fixed slot (0-17), so the whole table is covered, plus a
    // spread of unknown names to exercise every hashed fallback slot. A
    // response node is not a tool and has no name to key on, so if `toolColor`
    // could ever return this hue the kind would stop being distinguishable.
    const named = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'WebFetch',
      'WebSearch',
      'Skill',
      'Agent',
      'Glob',
      'ToolSearch',
      'StructuredOutput',
      'AskUserQuestion',
      'EnterWorktree',
      'TaskCreate',
      'Monitor',
      'Workflow',
      'SendMessage',
      'ScheduleWakeup',
    ]
    const hashed = Array.from({ length: 300 }, (_, i) => `mcp__unknown__tool_${i}`)
    for (const name of [...named, ...hashed]) {
      expect(toolColor(name)).not.toBe(RESPONSE_COLOR)
    }
  })

  it('is distinct from the three structural kind colours', () => {
    // Mirrored from MINIMAP_KIND_COLOR in CCSessionGraphView (session / agent /
    // skill), which is itself the minimap's copy of App.css's left borders.
    expect(['#00e5ff', '#ff2bd6', '#7c5cff']).not.toContain(RESPONSE_COLOR)
  })
})

function byId(nodes: { id: string; position: { x: number; y: number } }[]) {
  const m = new Map(nodes.map((n) => [n.id, n.position]))
  return (id: string) => m.get(id)
}
