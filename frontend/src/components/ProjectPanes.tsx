import { Fragment, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import {
  axisPos,
  computeDropEdge,
  DEFAULT_RATIO,
  getNodeAtPath,
  MIN_PANE_PX,
  replaceAtPath,
  toggleDivider,
  type DropEdge,
} from '../lib/paneTree'
import {
  isPaneTab,
  paneLabel,
  TAB_DRAG_MIME,
  type PaneRoot,
  type PaneTab,
} from '../projectPanes'

// A drop zone reads the pointer exactly like the Terminal page's does
// (`computeDropEdge`): the outer 60% of the target is quartered into
// left/right/top/bottom, and the center means "beside it, no new split".
// Center gets its own indicator here — over there a center drop is a reorder
// among identical shells, but a view dropped in the middle of another view
// still changes the layout, so it must show something.
type DropSpot = DropEdge | 'center'

/**
 * One drop target for a view tab dragged out of the tab strip: the panes of
 * the Custom layout, and — before there is a Custom layout at all — the plain
 * tab's whole content area, which is the same gesture onto a tree of one pane.
 *
 * Only a drag carrying `TAB_DRAG_MIME` is accepted. The Files tab's own file
 * and tab drags travel as `text/plain`, so they pass straight through this
 * without ever calling `preventDefault` — which is what keeps a pane's content
 * dragging like it does on its own tab.
 */
export function TabDropArea({
  id,
  className,
  style,
  onDropTab,
  children,
}: {
  id: string
  className?: string
  style?: CSSProperties
  onDropTab: (tab: PaneTab, overId: string, pointer: { x: number; y: number }, rect: DOMRect) => void
  children: ReactNode
}) {
  const [spot, setSpot] = useState<DropSpot | null>(null)

  // `dragenter` and `dragover` both run this: a browser treats an element as a
  // drop target only from the moment one of them calls `preventDefault()`, so
  // a pointer that enters and releases before the first `dragover` would
  // otherwise see the drop rejected (same reason FilesView's tab strip does).
  function over(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    setSpot(computeDropEdge({ x: e.clientX, y: e.clientY }, rect) ?? 'center')
  }

  return (
    <div
      className={className}
      style={style}
      onDragEnter={over}
      onDragOver={over}
      // Moving across a child fires `dragleave` on the way in, so clear only
      // when the pointer has actually left this element's subtree.
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSpot(null)
      }}
      onDrop={(e) => {
        setSpot(null)
        const tab = e.dataTransfer.getData(TAB_DRAG_MIME)
        if (!isPaneTab(tab)) return
        e.preventDefault()
        e.stopPropagation()
        onDropTab(tab, id, { x: e.clientX, y: e.clientY }, e.currentTarget.getBoundingClientRect())
      }}
    >
      {children}
      {spot && (
        <div
          className={`agent-sidebar-pane-drop-indicator agent-sidebar-pane-drop-indicator-${spot}`}
        />
      )}
    </div>
  )
}

/**
 * One view pane: the same chrome as a Terminal/Agent pane (header + body),
 * with the view itself rendered by the page (`renderView`) so this file stays
 * out of the routing/data layer.
 *
 * The header is the pane's grip too — it carries the same `TAB_DRAG_MIME`
 * payload the tab strip does, so dragging a pane somewhere else in the tree
 * and dragging a fresh tab in are one code path (`dropTab` moves a view that
 * already has a pane rather than opening a second copy of it).
 */
function ViewPane({
  tab,
  ratio,
  onClose,
  onDropTab,
  renderView,
}: {
  tab: PaneTab
  ratio: number
  onClose: (tab: PaneTab) => void
  onDropTab: (tab: PaneTab, overId: string, pointer: { x: number; y: number }, rect: DOMRect) => void
  renderView: (tab: PaneTab) => ReactNode
}) {
  return (
    <TabDropArea
      id={tab}
      className="agent-sidebar-pane project-pane"
      style={{ flexGrow: ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
      onDropTab={onDropTab}
    >
      <div
        className="agent-terminal-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(TAB_DRAG_MIME, tab)
          // Some browsers cancel a drag that carries no `text/plain` at all.
          e.dataTransfer.setData('text/plain', paneLabel(tab))
        }}
      >
        <span className="agent-sidebar-pane-title">
          <span className="agent-sidebar-pane-grip">⠿</span>
          <span>{paneLabel(tab)}</span>
        </span>
        <button onClick={() => onClose(tab)}>close</button>
      </div>
      <div className="project-pane-body">{renderView(tab)}</div>
    </TabDropArea>
  )
}

/**
 * Renders one split node's direct children as a flex row/column, recursing
 * into nested splits — the project-page analog of `TerminalPage.tsx`'s
 * `TerminalSplitView`, minus the dnd-kit sortable wiring (a pane is moved with
 * the same native tab drag that opens one).
 *
 * Declared at module scope for the same reason that one is: a divider drag
 * re-renders this tree many times a second, and a component defined inside the
 * re-rendering parent gets a new identity each time — which would remount
 * every pane's view (losing an open file, a scroll position, a live shell) on
 * every mouse move.
 */
function ProjectSplitView({
  node,
  path,
  onClose,
  onDropTab,
  onDividerMouseDown,
  onDividerToggle,
  renderView,
}: {
  node: PaneRoot
  path: number[]
  onClose: (tab: PaneTab) => void
  onDropTab: (tab: PaneTab, overId: string, pointer: { x: number; y: number }, rect: DOMRect) => void
  onDividerMouseDown: (
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) => void
  onDividerToggle: (path: number[], i: number) => void
  renderView: (tab: PaneTab) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={containerRef}
      className={`agent-sidebar-panes agent-sidebar-panes-${node.orientation}`}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.node.id}>
          {child.node.kind === 'leaf' ? (
            isPaneTab(child.node.id) ? (
              <ViewPane
                tab={child.node.id}
                ratio={child.ratio}
                onClose={onClose}
                onDropTab={onDropTab}
                renderView={renderView}
              />
            ) : null
          ) : (
            <div
              className="agent-sidebar-split-wrapper"
              style={{ display: 'flex', flexGrow: child.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
            >
              <ProjectSplitView
                node={child.node}
                path={[...path, i]}
                onClose={onClose}
                onDropTab={onDropTab}
                onDividerMouseDown={onDividerMouseDown}
                onDividerToggle={onDividerToggle}
                renderView={renderView}
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
                aria-label={node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'}
                title={node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'}
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
  )
}

/**
 * The Custom tab's body (mesa task 843): the project's own pane tree of views,
 * resizable by the same divider drag every other pane surface uses. The tree
 * itself lives in the page (which owns its persistence); this renders it and
 * reports gestures back.
 */
export function ProjectPanes({
  root,
  onChange,
  onClose,
  onDropTab,
  renderView,
}: {
  root: PaneRoot
  onChange: (update: (root: PaneRoot) => PaneRoot) => void
  onClose: (tab: PaneTab) => void
  onDropTab: (tab: PaneTab, overId: string, pointer: { x: number; y: number }, rect: DOMRect) => void
  renderView: (tab: PaneTab) => ReactNode
}) {
  const [paneDrag, setPaneDrag] = useState<null | {
    path: number[]
    i: number
    orientation: 'row' | 'column'
    startPos: number
    startA: number
    startB: number
    containerSize: number
  }>(null)

  // Identical math to the Terminal page's own divider effect: a pixel delta
  // becomes a ratio delta against the two adjacent children's combined ratio.
  useEffect(() => {
    if (!paneDrag) return
    const onMove = (e: MouseEvent) => {
      if (paneDrag.containerSize <= 0) return
      const pos = axisPos(e, paneDrag.orientation)
      const sum = paneDrag.startA + paneDrag.startB
      const deltaRatio = ((pos - paneDrag.startPos) / paneDrag.containerSize) * sum
      const minRatio = (MIN_PANE_PX / paneDrag.containerSize) * sum
      const nextA = Math.min(sum - minRatio, Math.max(minRatio, paneDrag.startA + deltaRatio))
      onChange((r) =>
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
    // `onChange` is a fresh closure each render; the drag is keyed off
    // `paneDrag` alone, and re-subscribing mid-drag would drop the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDrag])

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
    <div className="project-panes">
      <ProjectSplitView
        node={root}
        path={[]}
        onClose={onClose}
        onDropTab={onDropTab}
        onDividerMouseDown={startDivider}
        onDividerToggle={(path, i) => onChange((r) => toggleDivider(r, path, i))}
        renderView={renderView}
      />
    </div>
  )
}
