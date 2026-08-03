// Tree assembly for the left nav's nested project list (mesa task 668).
//
// The server never sends a tree: `GET /api/projects` is one FLAT array in
// `ORDER BY sort_order, id`, and `parent_id` is just a field on each row. That
// is deliberate — order stays server-side and the CLI, the API and the nav
// cannot disagree — so the shape the sidebar draws has to be derived here.
//
// It lives in a module rather than inline in `Sidebar.tsx` for the reason
// CLAUDE.md gives: these are the predicates that historically ship wrong (a
// child whose parent was filtered out of the array; a malformed cycle looping
// forever; a rolled-up count that double-counts), and they belong somewhere
// vitest can reach.

/** The fields of a project this module needs. */
export interface TreeNode {
  id: number
  parent_id: number | null
}

/** One rendered row: the project, and how deep to indent it. */
export interface TreeRow<T extends TreeNode> {
  project: T
  depth: number
}

/**
 * Flat, server-ordered projects → depth-annotated rows in render order
 * (a parent immediately followed by its subtree, siblings in the order the
 * server gave).
 *
 * Two rules that only look like edge cases until the list is filtered:
 *
 * - **An absent parent means top level.** The sidebar renders the active list
 *   and the archived group from partitions of one fetch, so a live child of an
 *   archived parent arrives with a `parent_id` no row in *this* array has.
 *   It renders at depth 0 rather than disappearing — a project that exists
 *   must always be reachable from the nav.
 * - **A cycle cannot hang.** `parent_id` cycles are rejected by `Store`, but a
 *   hand-edited db or a future bug must not spin the render loop: anything not
 *   reached from a root is appended at top level, so every input row comes out
 *   exactly once.
 */
export function buildTree<T extends TreeNode>(projects: T[]): TreeRow<T>[] {
  const present = new Set(projects.map((p) => p.id))
  const childrenOf = new Map<number | null, T[]>()
  for (const p of projects) {
    // `null` and "parent not in this array" are the same bucket: top level.
    const key = p.parent_id !== null && present.has(p.parent_id) ? p.parent_id : null
    const siblings = childrenOf.get(key)
    if (siblings) siblings.push(p)
    else childrenOf.set(key, [p])
  }
  const rows: TreeRow<T>[] = []
  const emitted = new Set<number>()
  const walk = (parent: number | null, depth: number): void => {
    for (const p of childrenOf.get(parent) ?? []) {
      if (emitted.has(p.id)) continue
      emitted.add(p.id)
      rows.push({ project: p, depth })
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  // Anything left over is in a cycle; show it rather than swallow it.
  for (const p of projects) {
    if (!emitted.has(p.id)) {
      emitted.add(p.id)
      rows.push({ project: p, depth: 0 })
    }
  }
  return rows
}

/**
 * Ids of every project under `id`, at any depth — the project itself
 * excluded. Used both to collapse a subtree and to exclude a project's own
 * descendants from its parent picker (a project may not be nested under its
 * own child). Cycle-safe.
 */
export function descendantIds<T extends TreeNode>(projects: T[], id: number): number[] {
  const childrenOf = new Map<number, T[]>()
  for (const p of projects) {
    if (p.parent_id === null) continue
    const siblings = childrenOf.get(p.parent_id)
    if (siblings) siblings.push(p)
    else childrenOf.set(p.parent_id, [p])
  }
  const out: number[] = []
  const seen = new Set<number>([id])
  const stack = [id]
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child.id)
      stack.push(child.id)
    }
  }
  return out
}

/** Ancestors of `id`, nearest first. Cycle-safe; `[]` at top level. */
export function ancestorIds<T extends TreeNode>(projects: T[], id: number): number[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const out: number[] = []
  const seen = new Set<number>([id])
  let parent = byId.get(id)?.parent_id ?? null
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent)
    out.push(parent)
    parent = byId.get(parent)?.parent_id ?? null
  }
  return out
}

/**
 * The todo count to show on a project's nav badge.
 *
 * Expanded, that is the project's own count — its descendants are on screen
 * carrying their own badges, and summing would show the same task twice.
 * Collapsed, it is the sum over the project and everything hidden under it,
 * so collapsing a subtree can never hide work.
 */
export function todoCountFor<T extends TreeNode>(
  projects: T[],
  counts: Map<number, number>,
  id: number,
  collapsed: boolean,
): number {
  const own = counts.get(id) ?? 0
  if (!collapsed) return own
  return descendantIds(projects, id).reduce((sum, d) => sum + (counts.get(d) ?? 0), own)
}

/**
 * The rows to actually render: `rows` minus everything inside a collapsed
 * subtree. A collapsed project is still shown (it is what you click to
 * expand); its descendants are not.
 */
export function visibleRows<T extends TreeNode>(
  rows: TreeRow<T>[],
  isCollapsed: (id: number) => boolean,
): TreeRow<T>[] {
  // Only an ancestor ALREADY EMITTED above this row can hide it: a row
  // `buildTree` put at top level because its parent isn't in this array (or
  // because it was left over from a cycle) is nobody's child here, whatever
  // its `parent_id` says — and must not vanish when some unrelated project of
  // that id happens to be collapsed.
  const above = new Set<number>()
  const hidden = new Set<number>()
  return rows.filter(({ project }) => {
    const parent = project.parent_id
    const parentHides =
      parent !== null && above.has(parent) && (hidden.has(parent) || isCollapsed(parent))
    above.add(project.id)
    if (parentHides) hidden.add(project.id)
    return !parentHides
  })
}

/**
 * Ids the server would hide from an unscoped read: archived, **or under an
 * archived ancestor** (task 668, the rule `docs/archiving.md` states).
 *
 * The sidebar fetches with `include_archived` and partitions the one array
 * itself, so it has to apply the same rule the server's own `list_projects`
 * does — otherwise a live child of an archived parent would sit in the main
 * list here while `mesa project list` omits it. Cycle-safe.
 */
export function effectivelyArchivedIds<T extends TreeNode & { archived: boolean }>(
  projects: T[],
): Set<number> {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const hidden = new Set<number>()
  for (const p of projects) {
    if (p.archived || ancestorIds(projects, p.id).some((a) => byId.get(a)?.archived)) {
      hidden.add(p.id)
    }
  }
  return hidden
}

/** True when `id` has at least one child — i.e. it gets a collapse caret. */
export function hasChildren<T extends TreeNode>(projects: T[], id: number): boolean {
  return projects.some((p) => p.parent_id === id)
}
