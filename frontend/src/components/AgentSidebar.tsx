import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { listAllAgents, listProjects, spawnProjectAgent } from '../api'
import { projectForCwd } from '../agentProject'
import type { AgentSession } from '../types/AgentSession'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'
import { AgentTerminal } from './AgentTerminal'

const MIN_WIDTH = 280
const DEFAULT_WIDTH = 448 // 28rem, matches the CSS fallback
// No fixed upper cap (unlike the old 720px ceiling) — but `main` still needs
// a floor, or dragging past it squeezes its content (the CC Dashboard's
// cards, etc.) into character-by-character wrapping rather than a clean
// overflow the browser would otherwise catch. Measured live off `main`'s own
// rect each move, not a hardcoded viewport fraction, so it tracks the left
// nav sidebar's actual width (collapsed or expanded) instead of assuming one.
const MIN_MAIN_WIDTH = 320

const MIN_PANE_PX = 80 // floor on a pane's own height during divider drag
const DEFAULT_RATIO = 1

// Stable id for the one leaf whose content is the session list rather than
// an attached terminal — an `agentId` from `claude agents --json` is always
// a short opaque id with no fixed shape, so a `__`-wrapped sentinel can't
// collide with a real one.
const LIST_LEAF_ID = '__agent-list__'

// --- Split tree -------------------------------------------------------
//
// Replaces the old flat `openIds: string[]` + `ratios: Record<string,
// number>` pair. A single tree, rooted at a `SplitNode`, holds every open
// pane plus how the panes sharing a container split their flex space.
// Mixed row/column nesting is what stories 372/373 build on top of this;
// today only the degenerate single-column tree (today's flat stack) is
// ever produced, since nothing yet creates a nested split.
//
// A leaf's content is either an attached agent terminal or the session
// list itself (task 368) — `contentKind` discriminates the two, `id` is
// the leaf's identity either way (an `agentId`, or `LIST_LEAF_ID` for the
// list) so every id-keyed helper below (`findPathToLeaf`, dnd-kit's own
// sortable id, ...) stays a single code path regardless of content.
type LeafNode =
  | { kind: 'leaf'; contentKind: 'agent'; id: string }
  | { kind: 'leaf'; contentKind: 'list'; id: typeof LIST_LEAF_ID }

type SplitNode = {
  kind: 'split'
  // Stable id for nested-split React keys — a leaf already has a natural
  // key (its own id); a split has none, so mint one at creation and carry
  // it through every rebuild/canonicalize instead of regenerating it on
  // render (which would break React's reconciliation on every toggle).
  id: string
  orientation: 'row' | 'column' // row = side-by-side, column = stacked
  children: SplitChild[]
}

type SplitChild = {
  ratio: number // this slot's flex-grow share within its parent split
  node: PaneNode
}

type PaneNode = LeafNode | SplitNode

function emptyRoot(): SplitNode {
  return { kind: 'split', id: crypto.randomUUID(), orientation: 'column', children: [] }
}

/**
 * Collapses a tree bottom-up until none of its 3 rules apply anywhere:
 *  (a) drop an empty split child entirely,
 *  (b) inline a singleton split child (its one grandchild takes over the
 *      wrapper's own ratio slot),
 *  (c) splice a same-orientation split child's children directly into this
 *      level, rescaled to fit inside the child's ratio budget — flex-grow
 *      only competes among true siblings, so a same-orientation wrapper is
 *      pure nesting with no visual effect.
 * Rule (c) is what makes toggling a divider and toggling it back a true
 * round trip instead of an ever-growing nest. Called by `replaceAtPath` on
 * every mutation, so callers never have to remember to call it themselves.
 */
function canonicalize(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  let children: SplitChild[] = node.children.map((c) => ({ ratio: c.ratio, node: canonicalize(c.node) }))
  let changed = true
  while (changed) {
    changed = false
    const next: SplitChild[] = []
    for (const c of children) {
      if (c.node.kind === 'split' && c.node.children.length === 0) {
        changed = true
        continue
      }
      if (c.node.kind === 'split' && c.node.children.length === 1) {
        next.push({ ratio: c.ratio, node: c.node.children[0].node })
        changed = true
        continue
      }
      if (c.node.kind === 'split' && c.node.orientation === node.orientation) {
        const sum = c.node.children.reduce((s, cc) => s + cc.ratio, 0) || 1
        for (const cc of c.node.children) next.push({ ratio: (cc.ratio / sum) * c.ratio, node: cc.node })
        changed = true
        continue
      }
      next.push(c)
    }
    children = next
  }
  return { kind: 'split', id: node.id, orientation: node.orientation, children }
}

/** `[]` is root itself; `[2]` is `root.children[2].node`; `[2, 0]` is that node's own `children[0].node`, etc. */
function getNodeAtPath(root: SplitNode, path: number[]): PaneNode {
  let node: PaneNode = root
  for (const i of path) {
    if (node.kind !== 'split') throw new Error('getNodeAtPath: path runs through a leaf')
    node = node.children[i].node
  }
  return node
}

/**
 * Rebuilds only the spine from `root` down to the split node at `path`,
 * applying `fn` there, and canonicalizes the whole result before returning
 * — the single choke point every tree mutation goes through.
 */
function replaceAtPath(root: SplitNode, path: number[], fn: (n: SplitNode) => SplitNode): SplitNode {
  function rebuild(node: SplitNode, rest: number[]): SplitNode {
    if (rest.length === 0) return fn(node)
    const [i, ...tail] = rest
    const childNode = node.children[i].node
    if (childNode.kind !== 'split') throw new Error('replaceAtPath: path runs through a leaf')
    const children = node.children.map((c, idx) =>
      idx === i ? { ratio: c.ratio, node: rebuild(childNode, tail) } : c,
    )
    return { ...node, children }
  }
  return canonicalize(rebuild(root, path)) as SplitNode
}

function findPathToLeaf(root: SplitNode, id: string): number[] | null {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i].node
    if (child.kind === 'leaf') {
      if (child.id === id) return [i]
    } else {
      const sub = findPathToLeaf(child, id)
      if (sub) return [i, ...sub]
    }
  }
  return null
}

function collectLeafIds(node: PaneNode): string[] {
  if (node.kind === 'leaf') return [node.id]
  return node.children.flatMap((c) => collectLeafIds(c.node))
}

function childKey(node: PaneNode): string {
  return node.id
}

// Always appended to root's own children, regardless of how deep/mixed the
// tree is elsewhere — the spec's stated default insertion point.
function insertLeaf(root: SplitNode, agentId: string): SplitNode {
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [
      ...n.children,
      { ratio: DEFAULT_RATIO, node: { kind: 'leaf', contentKind: 'agent', id: agentId } },
    ],
  }))
}

// Seeds the one permanent session-list leaf if the tree doesn't already
// have one — called once at init and is otherwise a no-op, since nothing
// in the UI ever closes the list leaf (task 368: it's a pane like any
// other agent pane, just not a closable one — closing it would strand the
// sidebar with no way left to open an agent pane).
function ensureListLeaf(root: SplitNode): SplitNode {
  if (findPathToLeaf(root, LIST_LEAF_ID)) return root
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [
      { ratio: DEFAULT_RATIO, node: { kind: 'leaf', contentKind: 'list', id: LIST_LEAF_ID } },
      ...n.children,
    ],
  }))
}

function removeLeaf(root: SplitNode, agentId: string): SplitNode {
  const path = findPathToLeaf(root, agentId)
  if (!path) return root
  const parentPath = path.slice(0, -1)
  const i = path[path.length - 1]
  return replaceAtPath(root, parentPath, (n) => ({
    ...n,
    children: n.children.filter((_, idx) => idx !== i),
  }))
}

/**
 * Toggles the orientation of the divider between `children[i]`/`children[i+1]`
 * of the split node at `path`: extracts that pair, wraps it in a NEW split
 * node with the OPPOSITE orientation (ratio = the pair's combined ratio), and
 * splices that single node back into the same slot. The familiar "flip a
 * 2-child split in place" case is not a separate code path — it's what
 * `canonicalize`'s singleton-inline rule (via `replaceAtPath`) collapses this
 * same general operation down to automatically when `n.children.length === 2`.
 */
function toggleDivider(root: SplitNode, path: number[], i: number): SplitNode {
  return replaceAtPath(root, path, (n) => {
    const a = n.children[i]
    const b = n.children[i + 1]
    const wrapper: SplitNode = {
      kind: 'split',
      id: crypto.randomUUID(),
      orientation: n.orientation === 'row' ? 'column' : 'row',
      children: [a, b],
    }
    const children = [
      ...n.children.slice(0, i),
      { ratio: a.ratio + b.ratio, node: wrapper },
      ...n.children.slice(i + 2),
    ]
    return { ...n, children }
  })
}

/**
 * Moves the leaf at `fromPath` out of its current split and inserts it at
 * `toIndex` in the DIFFERENT split at `toPath`, then canonicalizes once.
 * The moved leaf's own ratio is dropped — the destination slot always gets
 * `DEFAULT_RATIO`, matching how a reopened pane gets no special ratio
 * treatment (arch.md §3).
 *
 * Deliberately a single top-down rebuild over the ORIGINAL tree's indices,
 * not two sequential `replaceAtPath` calls (each of which canonicalizes).
 * Canonicalizing right after the removal alone could prune/inline the
 * source's now-empty-or-singleton parent split, shifting a LATER sibling's
 * index — which would silently invalidate a `toPath`/`toIndex` computed
 * against the pre-removal tree if that sibling happens to sit on (or past)
 * the destination's branch. Applying both the removal and the insertion in
 * one pass, each still keyed off the untouched original indices, then
 * canonicalizing exactly once at the end avoids that class of bug entirely.
 */
function moveLeaf(root: SplitNode, fromPath: number[], toPath: number[], toIndex: number): SplitNode {
  const leaf = getNodeAtPath(root, fromPath)
  if (leaf.kind !== 'leaf') return root
  const fromParentPath = fromPath.slice(0, -1)
  const fromIndex = fromPath[fromPath.length - 1]

  function rebuild(node: SplitNode, path: number[]): SplitNode {
    const atFromParent =
      path.length === fromParentPath.length && path.every((v, k) => v === fromParentPath[k])
    const atToParent = path.length === toPath.length && path.every((v, k) => v === toPath[k])

    let children = node.children.map((c, i) => {
      const onFromBranch = fromParentPath.length > path.length && fromParentPath[path.length] === i
      const onToBranch = toPath.length > path.length && toPath[path.length] === i
      if ((onFromBranch || onToBranch) && c.node.kind === 'split') {
        return { ratio: c.ratio, node: rebuild(c.node, [...path, i]) }
      }
      return c
    })

    if (atFromParent) children = children.filter((_, idx) => idx !== fromIndex)
    if (atToParent) {
      children = [...children]
      children.splice(toIndex, 0, { ratio: DEFAULT_RATIO, node: leaf })
    }
    return { ...node, children }
  }

  return canonicalize(rebuild(root, [])) as SplitNode
}

// One function every hardcoded `e.clientY`/`e.clientX` read goes through:
// a row split's divider drags along X, a column split's along Y. Typed
// structurally (not `MouseEvent`) so it accepts both a React synthetic
// mousedown event and a native `document`-level mousemove event.
function axisPos(e: { clientX: number; clientY: number }, orientation: 'row' | 'column'): number {
  return orientation === 'row' ? e.clientX : e.clientY
}

function agentLabel(a: AgentSession): string {
  return a.name ?? a.id ?? a.sessionId.slice(0, 8)
}

// Only projects with a linked folder can host a new session (`local_path`
// is where `claude --bg` runs) — filtered here so the picker never offers a
// choice the spawn call would just reject as `validation`.
function startableProjects(projects: Project[] | null | undefined): Project[] {
  return (projects ?? []).filter((p) => p.local_path !== null)
}

// The picker's initial selection: the in-focus project if it's startable,
// else the first startable project, else none (an empty picker with no
// linked project anywhere).
function defaultStartProjectId(projects: Project[] | null | undefined, activeProjectId: number | null): number | '' {
  const startable = startableProjects(projects)
  if (activeProjectId !== null && startable.some((p) => p.id === activeProjectId)) return activeProjectId
  return startable[0]?.id ?? ''
}

function startedAgo(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

type Bucket = 'BLOCKED' | 'ACTIVE' | 'DONE'

// `AgentSession` carries no completion timestamp (only `startedAt`, the
// session's start time) — `claude agents --json` doesn't report one. DONE is
// sorted by `startedAt` desc as the closest available proxy for "most
// recently completed"; the bucketing itself is exact, driven by `state`.
function bucketOf(a: AgentSession): Bucket {
  if (a.state === 'blocked') return 'BLOCKED'
  if (a.state === 'done' || a.state === 'failed' || a.state === 'stopped') return 'DONE'
  return 'ACTIVE' // 'working', or no state at all (interactive sessions)
}

const BUCKETS: Bucket[] = ['BLOCKED', 'ACTIVE', 'DONE']

/**
 * One pane's chrome inside the split view: a header (drag handle + label +
 * optional extra badge + optional close) over arbitrary content. `ratio` is
 * this pane's share of the stack's flex space (see `AgentSidebar`'s
 * divider-drag comment) — sortable via dnd-kit via `dragId`, so every pane
 * (an attached agent terminal or the session list) is rearrangeable by
 * dragging the header's grip the same way.
 *
 * `onClose` is optional: the session-list pane has none (task 368 — it's a
 * permanent leaf, since closing it would strand the sidebar with no way
 * left to open an agent pane), every agent pane has one.
 */
function PaneShell({
  dragId,
  label,
  headerExtra,
  ratio,
  onClose,
  children,
}: {
  dragId: string
  label: string
  headerExtra?: ReactNode
  ratio: number
  onClose?: () => void
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dragId,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    flexGrow: ratio,
    flexBasis: 0,
    // Whichever axis flexbox distributes (main axis) is the one that needs
    // flooring to 0, and that axis flips with the parent split's
    // orientation (row vs column) — zeroing both defensively is cheaper
    // than branching on orientation and has no downside.
    minWidth: 0,
    minHeight: 0,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`agent-sidebar-pane${isDragging ? ' dragging' : ''}`}
    >
      <div className="agent-terminal-header">
        <span className="agent-sidebar-pane-title">
          <span className="agent-sidebar-pane-grip" {...listeners} {...attributes}>
            ⠿
          </span>
          <span>{label}</span>
          {headerExtra}
        </span>
        {onClose && <button onClick={onClose}>close</button>}
      </div>
      {children}
    </div>
  )
}

/** One open agent's pane: `PaneShell` over its own independent `AgentTerminal`. */
function AgentPane({
  agentId,
  label,
  ratio,
  onClose,
}: {
  agentId: string
  label: string
  ratio: number
  onClose: () => void
}) {
  return (
    <PaneShell dragId={agentId} label={label} ratio={ratio} onClose={onClose}>
      {/* key remounts terminal + socket only if agentId itself changes */}
      <AgentTerminal key={agentId} agentId={agentId} />
    </PaneShell>
  )
}

/** Props the session-list pane needs from `AgentSidebar`'s own state/data —
 * bundled into one object so `SplitNodeView` (module-scope, see its own
 * comment) can thread it down without widening its per-callback prop list. */
type ListPaneProps = {
  agents: AgentSession[]
  sessionsLoaded: boolean
  error: string | null
  projects: Project[] | null | undefined
  openIds: string[]
  collapsedSections: Record<Bucket, boolean>
  onToggleSection: (bucket: Bucket) => void
  onTogglePane: (agentId: string) => void
}

/** The session list itself, as a pane (task 368) — same `PaneShell` chrome
 * as an agent pane, just not closable and with the bucketed session list as
 * its body instead of a terminal. */
function AgentListPane({ ratio, list }: { ratio: number; list: ListPaneProps }) {
  const { agents, sessionsLoaded, error, projects, openIds, collapsedSections, onToggleSection, onTogglePane } =
    list
  return (
    <PaneShell
      dragId={LIST_LEAF_ID}
      label="Agents"
      headerExtra={agents.length > 0 ? <span className="agent-sidebar-count">{agents.length}</span> : null}
      ratio={ratio}
    >
      <div className="agent-sidebar-list">
        {error && !sessionsLoaded ? (
          <p className="error">{error}</p>
        ) : !sessionsLoaded ? (
          <p className="muted">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="muted">No agents running.</p>
        ) : (
          BUCKETS.map((bucket) => {
            const bucketAgents = agents.filter((a) => bucketOf(a) === bucket)
            if (bucketAgents.length === 0) return null
            const sectionCollapsed = collapsedSections[bucket]
            return (
              <div key={bucket} className="agent-sidebar-section">
                <button
                  type="button"
                  className="agent-sidebar-section-head"
                  aria-expanded={!sectionCollapsed}
                  onClick={() => onToggleSection(bucket)}
                >
                  <span className="agent-sidebar-section-caret">{sectionCollapsed ? '▸' : '▾'}</span>
                  {bucket}
                  <span className="agent-sidebar-count">{bucketAgents.length}</span>
                </button>
                {!sectionCollapsed && (
                  <ul className="card-list agent-list">
                    {bucketAgents.map((a) => {
                      const proj = projectForCwd(a.cwd, projects ?? [])
                      return (
                        <li
                          key={a.sessionId}
                          className={
                            (a.id !== null ? 'attachable' : '') +
                            (a.id !== null && openIds.includes(a.id) ? ' selected' : '')
                          }
                          onClick={() => {
                            if (a.id !== null) onTogglePane(a.id)
                          }}
                        >
                          <span className="agent-name">{agentLabel(a)}</span>
                          <span className={`badge agent-kind-${a.kind}`}>{a.kind}</span>
                          {a.status && <span className={`badge agent-status-${a.status}`}>{a.status}</span>}
                          {a.state && a.state !== a.status && (
                            <span className={`badge agent-state-${a.state}`}>{a.state}</span>
                          )}
                          {a.waitingFor && <span className="badge blocked">{a.waitingFor}</span>}
                          <div className="muted agent-meta">
                            {proj ? proj.name : a.cwd} · started {startedAgo(a.startedAt)}
                            {a.id === null && ' · external terminal — not attachable'}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>
    </PaneShell>
  )
}

/**
 * Recursively renders one split node's own direct children as a flex
 * container (row or column per `node.orientation`) — nesting happens
 * *across* `SplitNodeView` instances (a nested split renders inside a
 * ratio-bearing wrapper div that is itself one flex item of the parent),
 * never within one instance's children, because flex-grow ratios only
 * compete among true flex siblings.
 *
 * Declared at module scope (not inside `AgentSidebar`) deliberately: an
 * open pane's `AgentTerminal` owns a live WebSocket that must survive
 * every re-render (poll tick, resize drag, collapse/expand) with no
 * reconnect. A component nested inside `AgentSidebar`'s body would get a
 * new identity — and remount every `AgentTerminal` beneath it — on every
 * one of those re-renders.
 */
function SplitNodeView({
  node,
  path,
  agents,
  listProps,
  onClose,
  onDividerMouseDown,
  onDividerToggle,
}: {
  node: SplitNode
  path: number[]
  agents: AgentSession[]
  listProps: ListPaneProps
  onClose: (agentId: string) => void
  onDividerMouseDown: (
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) => void
  onDividerToggle: (path: number[], i: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const leafIds = node.children.filter((c) => c.node.kind === 'leaf').map((c) => (c.node as LeafNode).id)
  const strategy = node.orientation === 'row' ? horizontalListSortingStrategy : verticalListSortingStrategy

  return (
    <SortableContext items={leafIds} strategy={strategy}>
      <div ref={containerRef} className={`agent-sidebar-panes agent-sidebar-panes-${node.orientation}`}>
        {node.children.map((child, i) => (
          <Fragment key={childKey(child.node)}>
            {child.node.kind === 'leaf' ? (
              child.node.contentKind === 'list' ? (
                <AgentListPane ratio={child.ratio} list={listProps} />
              ) : (
                <AgentPane
                  agentId={child.node.id}
                  label={(() => {
                    // Reassigned to a local (with the narrower type spelled
                    // out) so the arrow function below — a separate closure
                    // — keeps the 'agent' narrowing: TS doesn't carry a
                    // discriminant check across a closure boundary on a
                    // value read from the outer scope.
                    const leaf = child.node as Extract<LeafNode, { contentKind: 'agent' }>
                    const session = agents.find((a) => a.id === leaf.id)
                    return session ? agentLabel(session) : leaf.id
                  })()}
                  ratio={child.ratio}
                  onClose={() => onClose(child.node.id)}
                />
              )
            ) : (
              <div
                className="agent-sidebar-split-wrapper"
                style={{ display: 'flex', flexGrow: child.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
              >
                <SplitNodeView
                  node={child.node}
                  path={[...path, i]}
                  agents={agents}
                  listProps={listProps}
                  onClose={onClose}
                  onDividerMouseDown={onDividerMouseDown}
                  onDividerToggle={onDividerToggle}
                />
              </div>
            )}
            {i < node.children.length - 1 && (
              <div
                className={`agent-sidebar-pane-divider agent-sidebar-pane-divider-${node.orientation}`}
                onMouseDown={(e) => {
                  // Belt-and-suspenders with the toggle button's own
                  // stopPropagation: mousedown fires before click, so if the
                  // toggle button is the target, don't also start a resize
                  // drag on the same gesture.
                  if ((e.target as HTMLElement).closest('.agent-sidebar-divider-toggle')) return
                  e.preventDefault()
                  const container = containerRef.current
                  if (!container) return
                  onDividerMouseDown(path, i, node.orientation, axisPos(e, node.orientation), container)
                }}
              >
                <button
                  type="button"
                  className="agent-sidebar-divider-toggle"
                  aria-label={
                    node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'
                  }
                  title={
                    node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'
                  }
                  onClick={(e) => {
                    // Stop this click from also reaching anything that
                    // treats the divider as a resize-drag surface — the
                    // toggle and the resize-drag share the same element by
                    // design (arch doc §6), so this is the one thing that
                    // keeps them from double-firing on the same gesture.
                    e.stopPropagation()
                    onDividerToggle(path, i)
                  }}
                >
                  {node.orientation === 'row' ? '⬍' : '⬌'}
                </button>
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </SortableContext>
  )
}

/**
 * Global, persistent right-hand sidebar: every live Claude Code session
 * across every project, with room to attach one pane per selected session.
 * Rendered once in `App.tsx`, outside the router — it never unmounts on
 * navigation, so collapsing it only changes CSS (width), never the React
 * tree. That is load-bearing: each open pane's `AgentTerminal` owns a
 * WebSocket, and it must survive a collapse/expand cycle with no reconnect,
 * exactly like leaving the tab and coming back — now true for every open
 * pane, not just one.
 */
export function AgentSidebar({ activeProjectId }: { activeProjectId: number | null }) {
  const [collapsed, setCollapsed] = useState(true)
  // Split tree holding every open pane + how each split's children share its
  // flex space. Root is always a SplitNode, never a bare leaf/null; the
  // session-list leaf is seeded in once up front (task 368 — it's a pane
  // like any other, just permanent) so with no other toggle or divider
  // ever used it stays a single-child column: one flex container, column
  // direction, the list pane alone. A session toggles its own leaf in/out
  // of the tree by clicking it inside the list pane; dragging a pane's
  // grip (including the list pane's own) reorders it among its split
  // siblings (dnd-kit sortable).
  const [root, setRoot] = useState<SplitNode>(() => ensureListLeaf(emptyRoot()))
  // DONE starts collapsed (stale sessions aren't the thing you want to see
  // first); BLOCKED/ACTIVE start open. `state` from the API is a live status
  // (working/blocked/done/…), not the `collapsed` UI concept below.
  const [collapsedSections, setCollapsedSections] = useState<Record<Bucket, boolean>>({
    BLOCKED: false,
    ACTIVE: false,
    DONE: true,
  })
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  // Maximized: the panel grows to fill the whole main content area (in place
  // of the fixed drag-resized width), matching the storyboard canvas's own
  // takeover-view expand toggle. Distinct from `collapsed` — maximized only
  // has an effect while the panel isn't collapsed.
  const [maximized, setMaximized] = useState(false)

  // "Add Agent" form: a transient overlay row above the pane tree, not part
  // of it — it starts a session, it isn't one. `open` is a plain boolean
  // rather than the presence of a project id, so cancel/collapse can reset
  // it without losing the distinction between "closed" and "closed with
  // nothing chosen yet".
  const [addOpen, setAddOpen] = useState(false)
  const [addProjectId, setAddProjectId] = useState<number | ''>('')
  const [addPrompt, setAddPrompt] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // Bumped by closeAddAgent and every new submit — a submit's `.then`/`.catch`
  // only applies its result if this still matches the id it captured, so
  // canceling (or reopening the form for a different project) before a spawn
  // resolves can't have the stale response clobber whatever the form shows
  // by the time it lands. Mirrors `AgentsView`'s own `projectIdRef` guard
  // against the analogous stale-async-write problem.
  const addRequestId = useRef(0)

  // Set while dragging a divider between two adjacent children of the split
  // node at `path`; `i` is the index of the upper/left one (the divider sits
  // between `children[i]` and `children[i+1]`). Captured once at mousedown
  // so the drag reads as a delta from a stable baseline rather than
  // accumulating rounding error. `startPos`/`containerSize` are axis-generic
  // (clientX/width for a row split, clientY/height for a column split) —
  // `axisPos` and `startDivider` below read/measure whichever axis
  // `orientation` says to, at any depth in the tree.
  const [paneDrag, setPaneDrag] = useState<null | {
    path: number[]
    i: number
    orientation: 'row' | 'column'
    startPos: number
    startA: number
    startB: number
    containerSize: number
  }>(null)

  const sensors = useSensors(
    // distance: 4 lets plain clicks on the grip still register as clicks,
    // matching KanbanBoard's card-drag threshold.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  )

  // Escape leaves maximized mode — the usual way out of a takeover view,
  // same convention as the storyboard canvas. Only bound while maximized so
  // it never swallows Escape elsewhere.
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  // Drag-resize: the handle sits on the sidebar's left edge, so the new
  // width is just the distance from the pointer to the right edge of the
  // viewport. Listeners live on `document`, not the handle, so the drag
  // keeps tracking even when the pointer outruns the handle mid-drag.
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX
      const mainLeft = document.querySelector('main')?.getBoundingClientRect().left ?? 0
      const max = window.innerWidth - mainLeft - MIN_MAIN_WIDTH
      setWidth(Math.min(max, Math.max(MIN_WIDTH, next)))
    }
    const onUp = () => setResizing(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('agent-sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('agent-sidebar-resizing')
    }
  }, [resizing])

  // Divider drag: converts a pixel delta into a ratio delta relative to the
  // two adjacent children's combined ratio, so the same drag distance feels
  // consistent regardless of how many siblings that split has or their
  // current split. Scoped to the split node at `paneDrag.path` — resizing
  // one split's divider never touches any other split's ratios.
  useEffect(() => {
    if (!paneDrag) return
    const onMove = (e: MouseEvent) => {
      if (paneDrag.containerSize <= 0) return
      const pos = axisPos(e, paneDrag.orientation)
      const sum = paneDrag.startA + paneDrag.startB
      const deltaRatio = ((pos - paneDrag.startPos) / paneDrag.containerSize) * sum
      const minRatio = (MIN_PANE_PX / paneDrag.containerSize) * sum
      const nextA = Math.min(sum - minRatio, Math.max(minRatio, paneDrag.startA + deltaRatio))
      setRoot((r) =>
        replaceAtPath(r, paneDrag.path, (n) => ({
          ...n,
          children: n.children.map((c, idx) => {
            if (idx === paneDrag.i) return { ...c, ratio: nextA }
            if (idx === paneDrag.i + 1) return { ...c, ratio: sum - nextA }
            return c
          }),
        })),
      )
    }
    const onUp = () => setPaneDrag(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('agent-sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('agent-sidebar-resizing')
    }
  }, [paneDrag])

  // Only poll while expanded — collapsed, nobody can see the list, and each
  // poll costs a `claude agents` subprocess. The one-off fetch on expand (via
  // the pollMs change below) keeps it fresh the moment it's opened again.
  const { data: sessions, error, refetch } = useFetch(
    () => listAllAgents(),
    'agents-sidebar',
    { pollMs: collapsed ? undefined : 3000 },
  )
  const { data: projects } = useFetch(() => listProjects(), 'agents-sidebar-projects')

  // Relative "started Xm ago" labels are derived from the clock at render
  // time, but useFetch drops byte-identical polls, so an idle list would
  // never re-render and the labels would freeze (mirrors AgentsView).
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const agents = [...(sessions ?? [])].sort((a, b) => b.startedAt - a.startedAt)
  const openIds = collectLeafIds(root)
  // Computed once per render and reused by both the add-form's option list
  // and its empty-state check below, rather than each re-filtering `projects`
  // independently.
  const startableAddProjects = startableProjects(projects)
  // `addProjectId` only holds a value once the user has explicitly picked
  // one (or it's no longer a startable choice) — the default is re-derived
  // from `startableAddProjects` on every render instead of being written
  // into state by an effect, so it stays correct the moment `projects`
  // finishes loading even if the form was opened before that fetch resolved
  // (no effect needed, and nothing to re-sync).
  const selectedAddProjectId =
    addProjectId !== '' && startableAddProjects.some((p) => p.id === addProjectId)
      ? addProjectId
      : defaultStartProjectId(projects, activeProjectId)

  const listProps: ListPaneProps = {
    agents,
    sessionsLoaded: sessions !== null,
    error,
    projects,
    openIds,
    collapsedSections,
    onToggleSection: (bucket) => setCollapsedSections((s) => ({ ...s, [bucket]: !s[bucket] })),
    onTogglePane: togglePane,
  }

  function togglePane(id: string) {
    setRoot((r) => (findPathToLeaf(r, id) ? removeLeaf(r, id) : insertLeaf(r, id)))
    refetch()
  }

  function closePane(id: string) {
    setRoot((r) => removeLeaf(r, id))
  }

  function openAddAgent() {
    setAddError(null)
    setAddPrompt('')
    // No explicit selection yet — `selectedAddProjectId` derives the
    // in-focus/first-startable default at render time, including once
    // `projects` finishes loading if it hasn't yet.
    setAddProjectId('')
    setAddOpen(true)
  }

  function closeAddAgent() {
    setAddOpen(false)
    setAddError(null)
    // Any spawn still in flight from this form is now stale — its own
    // `.then`/`.catch` checks this id before touching state, so canceling
    // (or the sidebar collapsing) can't have a late response reopen/clobber
    // whatever the form shows next. The spawn call itself isn't aborted —
    // mesa's `request()` has no AbortController plumbed through it — so the
    // agent it was starting still starts; this only stops that response
    // from corrupting UI state that's since moved on.
    addRequestId.current += 1
  }

  function submitAddAgent(e: React.FormEvent) {
    e.preventDefault()
    if (selectedAddProjectId === '') return
    setAdding(true)
    setAddError(null)
    const requestId = ++addRequestId.current
    const body = addPrompt.trim() === '' ? {} : { prompt: addPrompt.trim() }
    spawnProjectAgent(selectedAddProjectId, body).then(
      (spawned) => {
        // The newly started agent is real either way, so always insert its
        // pane — but only touch the form's own state if this is still the
        // request that owns it.
        setRoot((r) => insertLeaf(r, spawned.id))
        refetch()
        if (addRequestId.current !== requestId) return
        setAdding(false)
        setAddOpen(false)
        setAddPrompt('')
      },
      (err: unknown) => {
        if (addRequestId.current !== requestId) return
        setAdding(false)
        setAddError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  // If the dragged pane and its drop target share the same parent split,
  // it's a plain reorder among siblings. Otherwise it's a cross-split move
  // (story 375): the drop target is another leaf's position within a
  // DIFFERENT split — reusing 374's existing per-leaf sortable drop targets
  // (arch.md §7's option (a): simplest shape, no new `useDroppable`
  // container surface needed) — so `over` is always another leaf's id, in
  // whichever split it lives in, and `moveLeaf` slots the dragged leaf in at
  // that leaf's own index.
  function handlePaneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setRoot((r) => {
      const fromPath = findPathToLeaf(r, String(active.id))
      const toPath = findPathToLeaf(r, String(over.id))
      if (!fromPath || !toPath) return r
      const fromParent = fromPath.slice(0, -1)
      const toParent = toPath.slice(0, -1)
      const samePath =
        fromParent.length === toParent.length && fromParent.every((v, k) => v === toParent[k])
      const from = fromPath[fromPath.length - 1]
      const to = toPath[toPath.length - 1]
      if (samePath) {
        return replaceAtPath(r, fromParent, (n) => ({ ...n, children: arrayMove(n.children, from, to) }))
      }
      return moveLeaf(r, fromPath, toParent, to)
    })
  }

  function toggleDividerAt(path: number[], i: number) {
    setRoot((r) => toggleDivider(r, path, i))
  }

  // Divider mousedown → resize-start. `containerSize` is measured off THAT
  // divider's own split node's container — not a single sidebar-wide ref —
  // because a nested split's drag math must be relative to its own box.
  // Width for a row split (dragging moves along X), height for a column
  // split (dragging moves along Y); MIN_PANE_PX floors against this same
  // per-node size in the drag effect above, so the floor is naturally
  // scoped to just this split's own two adjacent children at any depth.
  function startDivider(
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) {
    const node = getNodeAtPath(root, path)
    if (node.kind !== 'split') return
    const rect = container.getBoundingClientRect()
    setPaneDrag({
      path,
      i,
      orientation,
      startPos,
      startA: node.children[i]?.ratio ?? DEFAULT_RATIO,
      startB: node.children[i + 1]?.ratio ?? DEFAULT_RATIO,
      containerSize: orientation === 'row' ? rect.width : rect.height,
    })
  }

  return (
    <aside
      className={`agent-sidebar${collapsed ? ' collapsed' : ''}${resizing ? ' resizing' : ''}${maximized ? ' maximized' : ''}`}
      style={{ '--agent-sidebar-width': `${width}px` } as CSSProperties}
    >
      {!collapsed && !maximized && (
        <div
          className="agent-sidebar-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault()
            setResizing(true)
          }}
        />
      )}
      <div className="agent-sidebar-header-actions">
        <button
          type="button"
          className="sidebar-toggle agent-sidebar-toggle"
          aria-label={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
          title={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
          onClick={() => {
            setCollapsed((c) => !c)
            setMaximized(false)
            closeAddAgent()
          }}
        >
          {collapsed ? '«' : '»'}
        </button>
        {!collapsed && (
          <button
            type="button"
            className={`agent-sidebar-maximize${maximized ? ' active' : ''}`}
            aria-label={
              maximized
                ? 'Restore agents sidebar width'
                : 'Expand agents sidebar to fill the main content area'
            }
            title={
              maximized
                ? 'Restore panel width (Esc)'
                : 'Expand panel to fill the main content area'
            }
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? 'restore' : 'maximize'}
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className={`agent-sidebar-add${addOpen ? ' active' : ''}`}
            aria-label={addOpen ? 'Cancel starting an agent' : 'Start a new agent'}
            title={addOpen ? 'Cancel starting an agent' : 'Start a new agent'}
            onClick={() => (addOpen ? closeAddAgent() : openAddAgent())}
          >
            + agent
          </button>
        )}
      </div>

      {/* A transient overlay above the pane tree, not a pane itself — it
          starts a session, it isn't one (unlike an attached agent or the
          permanent list pane, both members of `root`). */}
      {!collapsed && addOpen && (
        <form className="agent-sidebar-add-form" onSubmit={submitAddAgent}>
          <select
            value={selectedAddProjectId}
            onChange={(e) => setAddProjectId(e.target.value ? Number(e.target.value) : '')}
            required
          >
            <option value="" disabled>
              select project…
            </option>
            {startableAddProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={addPrompt}
            placeholder="optional first prompt — blank starts idle"
            onChange={(e) => setAddPrompt(e.target.value)}
          />
          <div className="agent-sidebar-add-form-actions">
            <button type="submit" disabled={adding || selectedAddProjectId === ''}>
              {adding ? 'starting…' : 'start agent'}
            </button>
            <button type="button" onClick={closeAddAgent}>
              cancel
            </button>
          </div>
          {addError && <span className="error">{addError}</span>}
          {/* `projects === null` is "still loading" (the initial `useFetch`
              value), not "confirmed zero" — showing this message during that
              window would claim no project is linked when one might be about
              to load. */}
          {projects !== null && startableAddProjects.length === 0 && (
            <span className="muted">
              No project has a linked folder yet — run{' '}
              <code>mesa project resolve</code> inside a repo to link one.
            </span>
          )}
        </form>
      )}

      <div className="agent-sidebar-body">
        <DndContext sensors={sensors} onDragEnd={handlePaneDragEnd}>
          <SplitNodeView
            node={root}
            path={[]}
            agents={agents}
            listProps={listProps}
            onClose={closePane}
            onDividerMouseDown={startDivider}
            onDividerToggle={toggleDividerAt}
          />
        </DndContext>
      </div>
    </aside>
  )
}
