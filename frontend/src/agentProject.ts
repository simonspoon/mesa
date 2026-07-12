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

/** A session still under way — excludes ones `claude agents --json` reports
 * with a terminal `state` (finished, failed, or stopped) or whose process has
 * already exited (`pid: null`). Interactive sessions carry no `state` at all
 * and count as running. */
export function isRunningAgent(a: AgentSession): boolean {
  return a.pid !== null && a.state !== 'done' && a.state !== 'failed' && a.state !== 'stopped'
}
