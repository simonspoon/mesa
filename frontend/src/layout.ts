// Auto-layout: a small hand-rolled layered (Sugiyama-style) graph layout for
// the diagram canvas. Diagram edges may form cycles (a drawing, not a
// dependency graph — see FrameEdge.ts), so layering first breaks cycles by
// discarding DFS back-edges, then longest-path-ranks the remaining DAG into
// layers, then positions each layer along the chosen flow direction.
//
// An edge that spans more than one layer gets a **dummy** placed in each layer
// it crosses (mesa task 892) — the step this layout was missing. A dummy takes
// no room of its own but is ordered like any other member of its layer, so the
// gaps on either side of it open a clear channel from the edge's source to its
// target. Without one, a connector spanning four layers was drawn straight
// across whatever happened to sit between its ends, and in QA it ran right
// through an unrelated node's card. Dummies also join the crossing-reduction
// pass, which is what keeps that channel roughly straight rather than making
// the connector zigzag through it. They are dropped before the result is
// returned: the caller only ever sees positions for real frames.

export type LayoutFrame = { id: number; w: number; h: number }
export type LayoutEdge = { from_frame: number; to_frame: number }
export type LayoutDirection = 'vertical' | 'horizontal'

const GAP_LAYER = 80 // gap between layers, along the flow (primary) axis
const GAP_NODE = 40 // gap between frames within a layer (cross axis)
const ORIGIN = 48 // matches addFrame's starting offset

/** Longest-path rank per frame id, after discarding cycle-forming (DFS back)
 *  edges so every remaining forward edge goes from a lower to a higher rank. */
function rankFrames(
  ids: number[],
  edges: LayoutEdge[],
): Map<number, number> {
  const known = new Set(ids)
  const adjAll = new Map<number, number[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (e.from_frame === e.to_frame) continue
    if (!known.has(e.from_frame) || !known.has(e.to_frame)) continue
    adjAll.get(e.from_frame)!.push(e.to_frame)
  }

  const forward = new Map<number, number[]>(ids.map((id) => [id, []]))
  const color = new Map<number, 0 | 1 | 2>(ids.map((id) => [id, 0]))
  function dfs(u: number) {
    color.set(u, 1)
    for (const v of adjAll.get(u)!) {
      if (color.get(v) === 1) continue // back edge: breaks a cycle, drop it
      forward.get(u)!.push(v)
      if (color.get(v) === 0) dfs(v)
    }
    color.set(u, 2)
  }
  for (const id of ids) if (color.get(id) === 0) dfs(id)

  const indegree = new Map<number, number>(ids.map((id) => [id, 0]))
  for (const id of ids)
    for (const v of forward.get(id)!) indegree.set(v, indegree.get(v)! + 1)
  const rank = new Map<number, number>(ids.map((id) => [id, 0]))
  const queue = ids.filter((id) => indegree.get(id) === 0)
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]
    for (const v of forward.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1))
      indegree.set(v, indegree.get(v)! - 1)
      if (indegree.get(v) === 0) queue.push(v)
    }
  }
  return rank
}

/** Frame positions (top-left corner) that lay `frames` out in ranked layers
 *  flowing in `direction`: 'vertical' stacks layers top-to-bottom, 'horizontal'
 *  stacks them left-to-right. Order within a layer follows a barycenter of
 *  each frame's immediate predecessors' order in the previous layer, falling
 *  back to the input order — a standard crossing-reduction heuristic. */
export function layoutFrames(
  frames: LayoutFrame[],
  edges: LayoutEdge[],
  direction: LayoutDirection,
): Map<number, { x: number; y: number }> {
  const ids = frames.map((f) => f.id)
  const byId = new Map(frames.map((f) => [f.id, f]))
  const rank = rankFrames(ids, edges)

  const maxRank = ids.length ? Math.max(...ids.map((id) => rank.get(id)!)) : -1
  const layers: number[][] = Array.from({ length: maxRank + 1 }, () => [])
  const inputOrder = new Map(ids.map((id, i) => [id, i]))
  for (const id of ids) layers[rank.get(id)!].push(id)

  // Ordering runs over frames *and* dummies, so both the predecessor lists and
  // the sizes are keyed on a combined id space: a real frame keeps its own id,
  // a dummy takes a negative one.
  const predecessors = new Map<number, number[]>(ids.map((id) => [id, []]))
  const predsOf = (id: number) => {
    let list = predecessors.get(id)
    if (!list) {
      list = []
      predecessors.set(id, list)
    }
    return list
  }
  let nextDummy = -1
  for (const e of edges) {
    if (e.from_frame === e.to_frame) continue
    const ru = rank.get(e.from_frame)
    const rv = rank.get(e.to_frame)
    // A back edge (the cycle-breaking pass already discarded it) and a
    // same-layer edge both have nothing to reserve and nothing to order by.
    if (ru === undefined || rv === undefined || rv <= ru) continue
    let prev = e.from_frame
    for (let r = ru + 1; r < rv; r++) {
      const dummy = nextDummy--
      layers[r].push(dummy)
      // Past every real frame's slot, so a barycenter tie with a frame
      // resolves in the frame's favour: the channel opens beside the node
      // rather than shoving the whole layer sideways. The barycenter is still
      // what actually places it — this only breaks ties.
      inputOrder.set(dummy, ids.length - nextDummy)
      predsOf(dummy).push(prev)
      prev = dummy
    }
    predsOf(e.to_frame).push(prev)
  }

  /** A dummy is a point: it consumes no cross-axis size of its own, so the
   *  `GAP_NODE` on either side of it is the whole channel. */
  const sizeOf = (id: number) => byId.get(id) ?? { id, w: 0, h: 0 }

  let prevOrder = new Map<number, number>()
  for (const layer of layers) {
    const order = new Map<number, number>()
    const withKeys = layer.map((id) => {
      const preds = predecessors.get(id) ?? []
      const key = preds.length
        ? preds.reduce((sum, p) => sum + (prevOrder.get(p) ?? 0), 0) /
          preds.length
        : inputOrder.get(id)!
      return { id, key }
    })
    withKeys.sort(
      (a, b) => a.key - b.key || inputOrder.get(a.id)! - inputOrder.get(b.id)!,
    )
    withKeys.forEach(({ id }, i) => {
      layer[i] = id
      order.set(id, i)
    })
    prevOrder = order
  }

  const isVertical = direction === 'vertical'
  let primaryOffset = ORIGIN
  const layerPrimary: number[] = []
  for (const layer of layers) {
    layerPrimary.push(primaryOffset)
    const maxSize = Math.max(
      0,
      ...layer.map((id) => (isVertical ? sizeOf(id).h : sizeOf(id).w)),
    )
    primaryOffset += maxSize + GAP_LAYER
  }

  // Each layer's own extent along the cross axis, so the layers can be centred
  // on each other rather than all packed against ORIGIN (mesa task 892).
  // Left-aligned, a one-frame layer sat at the top edge of a three-frame one,
  // so a branch and the trunk it rejoins were never on the same line and every
  // connector between them arrived at a slant — the "hard to follow" the
  // report named. Centring costs nothing and puts a straight chain on one
  // straight line.
  const crossExtent = (layer: number[]) =>
    layer.reduce(
      (sum, id, i) =>
        sum +
        (isVertical ? sizeOf(id).w : sizeOf(id).h) +
        (i > 0 ? GAP_NODE : 0),
      0,
    )
  const widest = Math.max(0, ...layers.map(crossExtent))

  const positions = new Map<number, { x: number; y: number }>()
  layers.forEach((layer, li) => {
    let crossOffset = ORIGIN + Math.round((widest - crossExtent(layer)) / 2)
    for (const id of layer) {
      const f = sizeOf(id)
      const size = isVertical ? f.w : f.h
      // A dummy only reserves the channel; it is not a frame and never lands
      // in the result.
      if (id >= 0) {
        positions.set(
          id,
          isVertical
            ? { x: crossOffset, y: layerPrimary[li] }
            : { x: layerPrimary[li], y: crossOffset },
        )
      }
      crossOffset += size + GAP_NODE
    }
  })
  return positions
}
