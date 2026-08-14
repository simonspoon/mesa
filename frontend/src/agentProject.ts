import type { AgentSession } from './types/AgentSession'
import type { Project } from './types/Project'

/** The project whose `local_path` is `cwd` or a parent of it — the same
 * prefix relationship `claude agents --cwd` itself matches on. Ties (nested
 * project folders) favor the longest/most-specific `local_path`. */
export function projectForCwd(cwd: string, projects: Project[]): Project | undefined {
  return projects
    .filter(
      (p) =>
        p.local_path !== null &&
        (cwd === p.local_path || cwd.startsWith(p.local_path + '/')),
    )
    .sort((a, b) => b.local_path!.length - a.local_path!.length)[0]
}

/** A session still under way. **Being listed at all is the liveness signal**
 * (mesa task 858): `claude agents --json` lists live processes, so a session
 * mesa can see in that list is still active, whatever its `state` says. The
 * only exclusion left is upstream reporting the session with no process
 * (`pid: null`) — that is upstream's own field, not an inference mesa draws.
 *
 * This replaces every `state`-derived verdict mesa used to layer on top:
 * - a terminal `state` never meant the process was gone — every session
 *   reported `done` was still running (measured, mesa task 571 — 33 of 33),
 *   and the work its turn started (a Bash call, a subagent) routinely
 *   outlives the `done` report (mesa task 802);
 * - upstream computes `state` live (it is persisted nowhere), and it sticks:
 *   a background session that ended its turn can sit at `idle` + `working`
 *   for 90+ minutes with no self-heal (mesa task 571).
 *
 * Both of those were mesa second-guessing a field it does not own, in
 * opposite directions. Presence in the list needs neither.
 *
 * Lives here rather than beside a caller because the Agent sidebar's
 * bucketing, the board's live-agent count and the nav's "an agent is running
 * here" dot are the same question asked by three surfaces. */
export function isRunningAgent(a: AgentSession): boolean {
  return a.pid !== null
}

/** The Agent sidebar's badge for the work a session holds in flight *right
 * now* — e.g. `2 shells`, `1 subagent`, `2 shells · 1 subagent`. Both counts
 * are mesa-derived (see `AgentSession`), not upstream `state`. Informational
 * only: since task 858 liveness is list presence, so this says what a session
 * is doing rather than whether it is running. `null` when
 * there is nothing live to report, so the caller renders no badge. */
export function liveWorkLabel(a: AgentSession): string | null {
  const parts: string[] = []
  const shells = a.liveShells ?? 0
  const subagents = a.liveSubagents ?? 0
  if (shells > 0) parts.push(`${shells} shell${shells === 1 ? '' : 's'}`)
  if (subagents > 0) parts.push(`${subagents} subagent${subagents === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
