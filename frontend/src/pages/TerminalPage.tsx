import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as ptyPool from '../lib/ptyPool'
import {
  axisPos,
  collectLeafIds,
  computeDropEdge,
  DEFAULT_RATIO,
  emptyRoot,
  getNodeAtPath,
  MIN_PANE_PX,
  newSplitId,
  removeLeaf,
  replaceAtPath,
  resolveDrop,
  toggleDivider,
  type DropEdge,
  type LeafNode as PTLeafNode,
  type SplitNode as PTSplitNode,
} from '../lib/paneTree'
import { PtySlot } from '../components/PtySlot'

// This page's own `contentKind` — every pane is a plain global $HOME shell,
// no other variant (mesa task 395 / .scratch/arch.md §2.3). A local type
// alias over the shared generic pane-tree types (`frontend/src/lib/
// paneTree.ts`), same pattern `AgentSidebar.tsx` uses for its own
// `'agent' | 'list'` union.
type ShellLeafKind = 'shell'
type LeafNode = PTLeafNode<ShellLeafKind>
type SplitNode = PTSplitNode<ShellLeafKind>

// Always appended to root's own children — same default insertion point as
// AgentSidebar's own `insertLeaf`. Unlike an agent pane (opened by picking
// an existing session), a shell pane has nothing to pick — mint a fresh id
// and open it directly. This is the one leaf-creating operation this page
// needs: `splitLeafAt`/`moveLeaf` only ever relocate leaves that already
// exist, so getting from the seeded single pane up to two or three still
// has to go through this, not a drag alone.
function appendShellLeaf(root: SplitNode): SplitNode {
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [
      ...n.children,
      { ratio: DEFAULT_RATIO, node: { kind: 'leaf', contentKind: 'shell', id: newSplitId() } },
    ],
  }))
}

/**
 * One shell pane's chrome: header (drag grip + label + close) over its own
 * `PtySlot` (mesa task 399 / .scratch/arch.md §6.2) — the actual
 * `PtyTerminal` lives in the always-mounted `PtyPool`, keyed by this pane's
 * own leaf id; this just relocates its stable container to this tree
 * position, so a split/move reparent never remounts (or kills) it. Follows
 * `AgentSidebar.tsx`'s `PaneShell`/`AgentPane` shape, simplified — no list
 * pane, no headerExtra badge, every leaf is closable (there's no permanent
 * list-equivalent leaf here).
 */
function ShellPane({
  id,
  ratio,
  onClose,
  dropEdge,
}: {
  id: string
  ratio: number
  onClose: () => void
  dropEdge?: DropEdge | null
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    flexGrow: ratio,
    flexBasis: 0,
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
          <span>shell</span>
        </span>
        <button onClick={onClose}>close</button>
      </div>
      <PtySlot id={id} endpoint="/api/terminal/attach" closedMessage="shell closed" />
      {dropEdge && <div className={`agent-sidebar-pane-drop-indicator agent-sidebar-pane-drop-indicator-${dropEdge}`} />}
    </div>
  )
}

/**
 * Recursively renders one split node's own direct children as a flex
 * container (row or column per `node.orientation`) — the Terminal-page
 * analog of `AgentSidebar.tsx`'s `SplitNodeView`.
 *
 * Declared at module scope, not inside `TerminalPage`, for the identical
 * reason `SplitNodeView` is (`AgentSidebar.tsx`'s own comment on it): each
 * open pane's `PtySlot` (and the `PtyTerminal` it relocates here, mesa task
 * 399) must survive every re-render (a resize drag fires many per second)
 * with no reconnect. A component nested inside a re-rendering parent gets a
 * new identity every render, which would remount — and reconnect — every
 * open pane's shell mid-drag. (A *reparent*, as opposed to a same-identity
 * re-render, is the separate case `ptyPool.ts`/`PtySlot.tsx` handle: the
 * pool container survives that too, but via relocation, not via this
 * component staying module-scope.)
 */
function TerminalSplitView({
  node,
  path,
  onClose,
  onDividerMouseDown,
  onDividerToggle,
  dropZone,
}: {
  node: SplitNode
  path: number[]
  onClose: (id: string) => void
  onDividerMouseDown: (
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) => void
  onDividerToggle: (path: number[], i: number) => void
  dropZone: { id: string; edge: DropEdge } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const leafIds = node.children.filter((c) => c.node.kind === 'leaf').map((c) => (c.node as LeafNode).id)
  const strategy = node.orientation === 'row' ? horizontalListSortingStrategy : verticalListSortingStrategy

  return (
    <SortableContext items={leafIds} strategy={strategy}>
      <div ref={containerRef} className={`agent-sidebar-panes agent-sidebar-panes-${node.orientation}`}>
        {node.children.map((child, i) => (
          <Fragment key={child.node.id}>
            {child.node.kind === 'leaf' ? (
              <ShellPane
                id={child.node.id}
                ratio={child.ratio}
                onClose={() => onClose(child.node.id)}
                dropEdge={dropZone && dropZone.id === child.node.id ? dropZone.edge : null}
              />
            ) : (
              <div
                className="agent-sidebar-split-wrapper"
                style={{ display: 'flex', flexGrow: child.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
              >
                <TerminalSplitView
                  node={child.node}
                  path={[...path, i]}
                  onClose={onClose}
                  onDividerMouseDown={onDividerMouseDown}
                  onDividerToggle={onDividerToggle}
                  dropZone={dropZone}
                />
              </div>
            )}
            {i < node.children.length - 1 && (
              <div
                className={`agent-sidebar-pane-divider agent-sidebar-pane-divider-${node.orientation}`}
                onMouseDown={(e) => {
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
 * Global pane-tree page of live `$HOME` shells (mesa task 395), each a real
 * `portable-pty` process bridged over `/api/terminal/attach` (mesa task
 * 394) and rendered via a `PtySlot`/`PtyPool` (mesa task 399), never a
 * `PtyTerminal` mounted directly at the tree position. Resize/split/
 * rearrange reuse the exact tree engine `AgentSidebar.tsx` uses
 * (`frontend/src/lib/paneTree.ts`), so the interaction model matches it
 * exactly.
 *
 * Mounted once, permanently, in `App.tsx` (mesa task 396) as a sibling of
 * `main`'s router outlet — never conditionally rendered — with visibility
 * toggled by the active `#/terminal` route. This is what lets an open
 * pane's shell process and websocket survive navigating away and back: this
 * component is never unmounted by navigation, only hidden.
 *
 * Splitting or moving an already-running pane (`splitLeafAt`/`moveLeaf`
 * reparenting a leaf) used to remount — and therefore permanently kill,
 * for this surface — both panes' shells; the `PtySlot`/`PtyPool` mechanism
 * (mesa task 399) fixes that by keeping each leaf's `PtyTerminal` alive in
 * a stable, pool-owned container that's relocated (not recreated) across
 * tree positions.
 */
export function TerminalPage() {
  const [root, setRoot] = useState<SplitNode>(() => appendShellLeaf(emptyRoot<ShellLeafKind>()))

  const [paneDrag, setPaneDrag] = useState<null | {
    path: number[]
    i: number
    orientation: 'row' | 'column'
    startPos: number
    startA: number
    startB: number
    containerSize: number
  }>(null)
  const [dropZone, setDropZone] = useState<null | { id: string; edge: DropEdge }>(null)
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Divider drag: identical math to AgentSidebar's own effect — converts a
  // pixel delta into a ratio delta relative to the two adjacent children's
  // combined ratio, scoped to the split node at `paneDrag.path`.
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

  function closePane(id: string) {
    ptyPool.remove(id)
    setRoot((r) => removeLeaf(r, id))
  }

  function addPane() {
    setRoot((r) => appendShellLeaf(r))
  }

  function handlePaneDragStart(event: DragStartEvent) {
    const ae = event.activatorEvent as MouseEvent
    dragOriginRef.current = { x: ae.clientX, y: ae.clientY }
  }

  function livePointer(event: DragMoveEvent): { x: number; y: number } | null {
    const origin = dragOriginRef.current
    if (!origin) return null
    return { x: origin.x + event.delta.x, y: origin.y + event.delta.y }
  }

  function handlePaneDragMove(event: DragMoveEvent) {
    const { over } = event
    const pointer = livePointer(event)
    if (!over || !pointer) {
      setDropZone(null)
      return
    }
    const edge = computeDropEdge(pointer, over.rect)
    setDropZone(edge ? { id: String(over.id), edge } : null)
  }

  function handlePaneDragCancel() {
    setDropZone(null)
    dragOriginRef.current = null
  }

  function handlePaneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const pointer = livePointer(event)
    setDropZone(null)
    dragOriginRef.current = null
    if (!over) return
    setRoot((r) => resolveDrop(r, String(active.id), String(over.id), pointer, over.rect) ?? r)
  }

  function toggleDividerAt(path: number[], i: number) {
    setRoot((r) => toggleDivider(r, path, i))
  }

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

  const paneCount = collectLeafIds(root).length

  return (
    <div className="terminal-page">
      <div className="terminal-page-header">
        <h2>Terminal</h2>
        <span className="muted">
          {paneCount} pane{paneCount === 1 ? '' : 's'}
        </span>
        <button type="button" onClick={addPane}>
          + new shell
        </button>
      </div>
      <div className="terminal-page-body">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handlePaneDragStart}
          onDragMove={handlePaneDragMove}
          onDragEnd={handlePaneDragEnd}
          onDragCancel={handlePaneDragCancel}
        >
          <TerminalSplitView
            node={root}
            path={[]}
            onClose={closePane}
            onDividerMouseDown={startDivider}
            onDividerToggle={toggleDividerAt}
            dropZone={dropZone}
          />
        </DndContext>
      </div>
    </div>
  )
}
