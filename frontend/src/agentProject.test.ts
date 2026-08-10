import { describe, expect, it } from 'vitest'
import {
  hasLiveWork,
  isRunningAgent,
  isStaleWorking,
  liveWorkLabel,
  projectForCwd,
} from './agentProject'
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
    sort_order: id,
    parent_id: null,
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
    liveShells: 0,
    liveSubagents: 0,
    ...over,
  }
}

/** A session with the two mesa-derived liveness counts missing entirely —
 *  what an older payload (or a hand-built mock) looks like. */
function sessionWithoutCounts(over: Partial<AgentSession> = {}): AgentSession {
  const s: Record<string, unknown> = { ...session(over) }
  delete s.liveShells
  delete s.liveSubagents
  return s as unknown as AgentSession
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

  // mesa task 802: observed live work outranks upstream's `state`.
  it('keeps a done session that still holds a running shell', () => {
    expect(
      isRunningAgent(session({ status: 'idle', state: 'done', liveShells: 2 })),
    ).toBe(true)
  })

  it('keeps a stale-working session that still holds a subagent', () => {
    expect(
      isRunningAgent(
        session({ status: 'idle', state: 'working', liveSubagents: 1 }),
      ),
    ).toBe(true)
  })

  it('drops a done session once both counts are zero', () => {
    expect(
      isRunningAgent(
        session({ status: 'idle', state: 'done', liveShells: 0, liveSubagents: 0 }),
      ),
    ).toBe(false)
  })

  it('drops a done session when the counts are absent entirely', () => {
    expect(
      isRunningAgent(sessionWithoutCounts({ status: 'idle', state: 'done' })),
    ).toBe(false)
  })

  it('still drops an exited process however much work it appears to hold', () => {
    expect(
      isRunningAgent(
        session({ pid: null, state: 'done', liveShells: 3, liveSubagents: 2 }),
      ),
    ).toBe(false)
  })
})

describe('hasLiveWork', () => {
  it('is false with both counts at zero', () => {
    expect(hasLiveWork(session())).toBe(false)
  })

  it('is true on either count alone', () => {
    expect(hasLiveWork(session({ liveShells: 1 }))).toBe(true)
    expect(hasLiveWork(session({ liveSubagents: 1 }))).toBe(true)
  })

  it('treats absent counts as zero', () => {
    expect(hasLiveWork(sessionWithoutCounts())).toBe(false)
  })
})

describe('liveWorkLabel', () => {
  it('is null with nothing live', () => {
    expect(liveWorkLabel(session())).toBeNull()
  })

  it('singularizes a count of one', () => {
    expect(liveWorkLabel(session({ liveShells: 1 }))).toBe('1 shell')
    expect(liveWorkLabel(session({ liveSubagents: 1 }))).toBe('1 subagent')
  })

  it('pluralizes above one', () => {
    expect(liveWorkLabel(session({ liveShells: 2 }))).toBe('2 shells')
    expect(liveWorkLabel(session({ liveSubagents: 3 }))).toBe('3 subagents')
  })

  it('joins both when both are live', () => {
    expect(liveWorkLabel(session({ liveShells: 2, liveSubagents: 1 }))).toBe(
      '2 shells · 1 subagent',
    )
  })
})
