import { describe, expect, it } from 'vitest'
import { isRunningAgent, isStaleWorking, projectForCwd } from './agentProject'
import type { AgentSession } from './types/AgentSession'
import type { Project } from './types/Project'

function project(id: number, local_path: string | null): Project {
  return {
    id,
    name: `p${id}`,
    description: null,
    root_commit: null,
    local_path,
    archived: false,
  }
}

/** A session with the fields these predicates read; everything else is
 *  filler, so a test names only what it is about. */
function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1234,
    id: 'abcd1234',
    cwd: '/repo',
    kind: 'background',
    startedAt: 0,
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    name: null,
    status: 'busy',
    state: 'working',
    waitingFor: null,
    ...over,
  }
}

describe('projectForCwd', () => {
  const projects = [project(1, '/a'), project(2, '/a/b'), project(3, null)]

  it('matches a local_path exactly', () => {
    expect(projectForCwd('/a', projects)?.id).toBe(1)
  })

  it('matches a cwd below a local_path', () => {
    expect(projectForCwd('/a/x/y', projects)?.id).toBe(1)
  })

  it('prefers the longest local_path when several are prefixes', () => {
    expect(projectForCwd('/a/b/c', projects)?.id).toBe(2)
  })

  it('does not match a sibling folder sharing a name prefix', () => {
    // '/a/bc'.startsWith('/a/b') is true as a *string*; only the separator
    // test keeps project 2 out of it.
    expect(projectForCwd('/a/bc', [project(2, '/a/b')])).toBeUndefined()
  })

  it('ignores projects with no local_path', () => {
    expect(projectForCwd('/elsewhere', [project(3, null)])).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(projectForCwd('/other', projects)).toBeUndefined()
  })
})

describe('isStaleWorking', () => {
  it('is true for a background session idle at working', () => {
    expect(isStaleWorking(session({ status: 'idle', state: 'working' }))).toBe(
      true,
    )
  })

  it('is false for an interactive session, whose state is upstream-owned', () => {
    expect(
      isStaleWorking(
        session({ kind: 'interactive', status: 'idle', state: 'working' }),
      ),
    ).toBe(false)
  })

  it('is false while the session is still busy', () => {
    expect(isStaleWorking(session({ status: 'busy', state: 'working' }))).toBe(
      false,
    )
  })

  it('is false once the state itself is terminal', () => {
    expect(isStaleWorking(session({ status: 'idle', state: 'done' }))).toBe(
      false,
    )
  })
})

describe('isRunningAgent', () => {
  it('counts a busy working session', () => {
    expect(isRunningAgent(session({ status: 'busy', state: 'working' }))).toBe(
      true,
    )
  })

  it('counts an interactive session, which carries no state at all', () => {
    expect(
      isRunningAgent(session({ kind: 'interactive', status: null, state: null })),
    ).toBe(true)
  })

  it('counts an idle session that is blocked and genuinely waiting', () => {
    // The one idle case that must survive: a session waiting on a permission
    // prompt is not finished, and isStaleWorking's state test is what keeps
    // it here.
    expect(
      isRunningAgent(
        session({
          status: 'idle',
          state: 'blocked',
          waitingFor: 'permission prompt',
        }),
      ),
    ).toBe(true)
  })

  it.each(['done', 'failed', 'stopped'])('drops a %s session', (state) => {
    expect(isRunningAgent(session({ status: 'idle', state }))).toBe(false)
  })

  it('drops a session stuck at a stale working', () => {
    expect(isRunningAgent(session({ status: 'idle', state: 'working' }))).toBe(
      false,
    )
  })

  it('drops a session whose process has exited', () => {
    expect(
      isRunningAgent(session({ pid: null, status: 'busy', state: 'working' })),
    ).toBe(false)
  })
})
