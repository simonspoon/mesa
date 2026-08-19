import { useLiveContext } from '../liveContext'
import type { LiveContext } from '../types/LiveContext'

/**
 * One page's focus, published from a component of its own (mesa task 888).
 *
 * `useLiveContext` must be called unconditionally, and calling it with `null`
 * publishes "nothing is in focus" — which is exactly wrong for a view that
 * *delegates* to a child that knows better: the parent's effect runs after the
 * child's, so its `null` would land on top of the child's report and stand
 * there (the child has nothing new to say, so it never republishes). Rendering
 * this instead makes the choice a matter of *mounting* a publisher rather than
 * publishing an absence, and unmounting it stands the value down the same way
 * leaving the page does.
 *
 * Used only where a view has such a branch (`ProjectTasksPage` delegating to a
 * tab, `GitView` handing History to its own pane). A page that always knows its
 * own focus calls the hook directly.
 */
export function LiveFocus({ ctx }: { ctx: LiveContext }) {
  useLiveContext(ctx)
  return null
}
