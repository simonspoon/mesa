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

/** A session still under way: **on the list and not reporting `done`**
 * (mesa task 861). Two exclusions, both upstream's own fields rather than an
 * inference mesa draws:
 * - `pid: null` — upstream listing a session with no process;
 * - `state === 'done'` — the session says its work is finished.
 *
 * Being listed is the rest of the signal (mesa task 858): `claude agents
 * --json` lists live processes, so a session mesa can see there is still
 * under way whatever *else* `state` says. In particular the sticky
 * `idle` + `working` pair mesa used to reclassify (a background session can
 * sit there for 90+ minutes after its turn, mesa task 571) is running, and so
 * is a `failed`/`stopped` one — mesa no longer second-guesses those.
 *
 * Note `done` does not mean the process has exited (task 571 measured 33 of
 * 33 `done` sessions still alive) and work the turn started can outlive the
 * report (task 802, `liveWorkLabel`). It means upstream considers the session
 * finished, which is what "active" is asking about.
 *
 * Lives here rather than beside a caller because the Agent sidebar's
 * bucketing, the board's live-agent count and the nav's "an agent is running
 * here" dot are the same question asked by three surfaces. */
export function isRunningAgent(a: AgentSession): boolean {
  return a.pid !== null && a.state !== 'done'
}

/** The Agent sidebar's badge for the work a session holds in flight *right
 * now* — e.g. `2 shells`, `1 subagent`, `2 shells · 1 subagent`. Both counts
 * are mesa-derived (see `AgentSession`), not upstream `state`. Informational
 * only: liveness is `isRunningAgent` above, so this says what a session is
 * doing rather than whether it is running — which is why a `done` session can
 * still carry the badge (task 802: the work outlives the turn). `null` when
 * there is nothing live to report, so the caller renders no badge. */
export function liveWorkLabel(a: AgentSession): string | null {
  const parts: string[] = []
  const shells = a.liveShells ?? 0
  const subagents = a.liveSubagents ?? 0
  if (shells > 0) parts.push(`${shells} shell${shells === 1 ? '' : 's'}`)
  if (subagents > 0) parts.push(`${subagents} subagent${subagents === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
