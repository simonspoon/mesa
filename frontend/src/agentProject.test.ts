import { describe, expect, it } from 'vitest'
import { isRunningAgent, liveWorkLabel, projectForCwd } from './agentProject'
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

  // mesa task 858: being on the list IS the liveness signal, so no `state`
  // demotes a session any more — not a terminal one (task 571 measured every
  // `done` session still running), and not the sticky idle+working pair.
  it.each(['done', 'failed', 'stopped'])('keeps a listed %s session', (state) => {
    expect(isRunningAgent(session({ status: 'idle', state }))).toBe(true)
  })

  it('keeps a session sitting at idle + working', () => {
    expect(isRunningAgent(session({ status: 'idle', state: 'working' }))).toBe(
      true,
    )
  })

  it('keeps a listed done session with no live work of its own', () => {
    expect(
      isRunningAgent(
        session({ status: 'idle', state: 'done', liveShells: 0, liveSubagents: 0 }),
      ),
    ).toBe(true)
  })

  it('keeps a listed done session whose counts are absent entirely', () => {
    expect(
      isRunningAgent(sessionWithoutCounts({ status: 'idle', state: 'done' })),
    ).toBe(true)
  })

  it('drops a session whose process has exited', () => {
    // The one exclusion left, and it is upstream's own field rather than an
    // inference of mesa's.
    expect(
      isRunningAgent(session({ pid: null, status: 'busy', state: 'working' })),
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
