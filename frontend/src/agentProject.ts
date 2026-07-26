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

/** A background session upstream still calls `working` that has in fact
 * finished. `claude agents --json` computes `state` live (it is persisted
 * nowhere — `~/.claude/sessions/<pid>.json` has no `state` key) and it can
 * stick at `working` indefinitely once a background session ends its turn
 * and goes idle: measured on claude 2.1.220, sessions sat this way for 90+
 * minutes with no self-heal, while others with byte-identical transcript
 * tails reported `done` (mesa task 571).
 *
 * Reading the pair as finished is safe because `idle` + `working` has no
 * legitimate meaning — a never-prompted session is `idle` + **`blocked`**, a
 * running one is `busy` + `working`, and a finished one is `idle` + `done`.
 * Callers must still test `blocked` first so an idle session that is
 * genuinely *waiting* is not swept up.
 *
 * Lives here rather than beside either caller because both the Agent
 * sidebar's bucketing and `isRunningAgent` below must agree on it — they are
 * the same question asked by two surfaces. */
export function isStaleWorking(a: AgentSession): boolean {
  return a.kind === 'background' && a.status === 'idle' && a.state === 'working'
}

/** A session still under way — excludes ones `claude agents --json` reports
 * with a terminal `state` (finished, failed, or stopped), ones stuck at a
 * stale `working` (above), and ones whose process has already exited
 * (`pid: null`). Interactive sessions carry no `state` at all and count as
 * running.
 *
 * Note a terminal `state` does NOT imply the process is gone: `claude agents
 * --json` lists live processes, and every session it reports as `done` is
 * still running (measured, mesa task 571 — 33 of 33). The `pid` test is for
 * the separate case where upstream reports the field as null. */
export function isRunningAgent(a: AgentSession): boolean {
  return (
    a.pid !== null &&
    a.state !== 'done' &&
    a.state !== 'failed' &&
    a.state !== 'stopped' &&
    !isStaleWorking(a)
  )
}
