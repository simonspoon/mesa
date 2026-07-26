import { useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
  type Node as RFNode,
} from '@xyflow/react'
import { getCcSessionGraph } from '../api'
import { usePhoneTier } from '../phoneTier'
import { formatTokens, layoutSessionGraph, shortModel, shortTarget } from '../sessionGraph'
import type { CcGraphNode } from '../types/CcGraphNode'
import { useFetch } from '../useFetch'

// One session's call tree, reached by clicking a row in the CC Dashboard's
// Sessions table (`#/cc/sessions/:id`). A node per tool call and per subagent
// run; a subagent hangs off the `Task` call that spawned it, so the picture is
// the session's actual control flow rather than a flat list.
//
// Read-only: no dragging, no connecting, no deleting. That is also what keeps
// it clear of React Flow's touch traps — the handles below exist only so edges
// have somewhere to attach, and are `pointer-events: none` rather than
// hover-revealed (see docs/mobile.md).

type CcFlowNode = RFNode<CcGraphNode, 'cc'>

// The minimap draws raw fills, not the CSS-variable border of the real node,
// so the kind colours are repeated here as literals, copied from index.css's
// --cyan / --magenta / --border to match `.cc-graph-node`'s left border.
const MINIMAP_COLOR: Record<CcGraphNode['kind'], string> = {
  session: '#00e5ff',
  agent: '#ff2bd6',
  skill: '#7c5cff',
  tool: '#16384a',
}

export function CCSessionGraphView({ sessionId }: { sessionId: string }) {
  const { data, error } = useFetch(() => getCcSessionGraph(sessionId), `cc-graph:${sessionId}`)
  const phone = usePhoneTier()

  const laid = useMemo(() => (data ? layoutSessionGraph(data) : null), [data])
  const nodeTypes = useMemo(() => ({ cc: GraphNode }), [])

  return (
    <div className="cc-graph-page">
      <header className="cc-graph-head">
        <a className="cc-graph-back" href="#/cc/sessions">
          ← Sessions
        </a>
        <h1>Session {sessionId.split('-')[0]}</h1>
        {data && (
          <div className="cc-graph-meta">
            {data.project && <span className="cc-badge">{data.project}</span>}
            {data.git_branch && <span className="cc-graph-branch">{data.git_branch}</span>}
            {data.start && <span>{data.start.replace('T', ' ').slice(0, 16)}</span>}
            <span>
              <em>{formatTokens(data.total_tokens)}</em> tokens
            </span>
            <span>
              <em>${data.est_cost_usd.toFixed(2)}</em> est.
            </span>
          </div>
        )}
      </header>

      {data?.truncated && (
        <p className="cc-graph-note">
          Showing the first {data.nodes.filter((n) => n.kind === 'tool').length} tool calls —{' '}
          {data.omitted_tool_calls.toLocaleString()} omitted. Every subagent is shown.
        </p>
      )}

      {error ? (
        <p className="error">{error}</p>
      ) : !laid ? (
        <p className="muted">Loading…</p>
      ) : laid.nodes.length <= 1 ? (
        <p className="muted">This session recorded no tool calls or subagent runs.</p>
      ) : (
        <div className="cc-graph-canvas">
          <ReactFlow
            colorMode="dark"
            nodes={laid.nodes}
            edges={laid.edges}
            nodeTypes={nodeTypes}
            fitView
            // A session is mostly a long *sequence* — a few hundred main-thread
            // calls stack into one tall column, so an unclamped `fitView`
            // squeezes 17,000px of tree into the canvas and every node label
            // becomes a smudge. Clamping keeps text readable and leaves the
            // long axis to panning; `maxZoom` stops a two-node graph from
            // filling the screen with one enormous card.
            fitViewOptions={{ minZoom: 0.55, maxZoom: 1, padding: 0.12 }}
            minZoom={0.15}
            // Read-only surface: every mutation gesture React Flow offers is
            // off, so the canvas only ever pans and zooms.
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            {/* 200x150 of a phone canvas is a sixth of the viewport, parked
                over a corner where it also blocks panning. */}
            {!phone && (
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => MINIMAP_COLOR[(n.data as CcGraphNode).kind]}
                maskColor="rgba(6, 10, 16, 0.72)"
              />
            )}
          </ReactFlow>
        </div>
      )}
    </div>
  )
}

function GraphNode({ data }: NodeProps<CcFlowNode>) {
  const model = shortModel(data.model)
  // A tool node's tokens are the issuing assistant message's, shared with any
  // sibling calls in that message — never this call's own. Say so rather than
  // printing a number that looks additive but is not.
  const tokenTitle = data.tokens_are_rollup
    ? 'Total tokens for this thread'
    : 'Tokens of the assistant message that issued this call (shared with sibling calls)'
  // What the call acted on. Shortened to fit the box; the untruncated value
  // is the hover title, which is also the only place a long Bash command or a
  // full file path can be read.
  const target = shortTarget(data)
  // A subagent's spawn description and a tool's target both want the node's
  // one title slot, and no node ever has both (`description` is agent-only).
  const title = data.description ?? data.target ?? undefined
  return (
    <div className={`cc-graph-node kind-${data.kind}`} title={title}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="cc-graph-node-name">{data.name}</div>
      {/* Untrusted: `target` is verbatim model-authored input (a command, a
          path). It is rendered as a text child — never as HTML, a URL, or an
          attribute that could act on it. */}
      {target && <div className="cc-graph-node-target">{target}</div>}
      <div className="cc-graph-node-row">
        {model && <span className="cc-graph-model">{model}</span>}
        <span className="cc-graph-tokens" title={tokenTitle}>
          {data.tokens_are_rollup ? '' : '≈'}
          {formatTokens(data.total_tokens)}
        </span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}
