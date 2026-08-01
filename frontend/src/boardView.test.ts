import { beforeEach, describe, expect, it } from 'vitest'
import {
  capColumn,
  liveAgentCount,
  loadBoardView,
  saveBoardView,
  DONE_INITIAL,
  DONE_PAGE,
} from './boardView'
import type { AgentSession } from './types/AgentSession'

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

describe('capColumn', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('leaves a done column shorter than the cap alone, with no button', () => {
    const { visible, hidden } = capColumn('done', rows(7), DONE_INITIAL)
    expect(visible).toHaveLength(7)
    expect(hidden).toBe(0)
  })

  it('leaves a done column of exactly the cap alone, with no button', () => {
    const { visible, hidden } = capColumn('done', rows(DONE_INITIAL), DONE_INITIAL)
    expect(visible).toHaveLength(DONE_INITIAL)
    expect(hidden).toBe(0)
  })

  it('keeps the first `shown` rows and reports the rest as hidden', () => {
    const { visible, hidden } = capColumn('done', rows(266), DONE_INITIAL)
    expect(visible).toEqual(rows(DONE_INITIAL))
    expect(hidden).toBe(246)
  })

  it('reports a partial final page', () => {
    // 266 done, expanded four times: 20 → 70 → 120 → 170 → 220.
    const { visible, hidden } = capColumn('done', rows(266), DONE_INITIAL + 4 * DONE_PAGE)
    expect(visible).toHaveLength(220)
    expect(hidden).toBe(46)
  })

  it('shows everything once `shown` passes the total', () => {
    const { visible, hidden } = capColumn('done', rows(266), 300)
    expect(visible).toHaveLength(266)
    expect(hidden).toBe(0)
  })

  it('returns every other column uncapped', () => {
    for (const status of ['backlog', 'refine', 'todo', 'in_progress']) {
      const { visible, hidden } = capColumn(status, rows(266), DONE_INITIAL)
      expect(visible).toHaveLength(266)
      expect(hidden).toBe(0)
    }
  })
})

describe('liveAgentCount', () => {
  const task = { name: 'Animate a task card' }

  it('matches a running session named "<project>: <task>"', () => {
    expect(
      liveAgentCount(task, 'mesa', [session({ name: 'mesa: Animate a task card' })]),
    ).toBe(1)
  })

  it('counts every matching running session', () => {
    expect(
      liveAgentCount(task, 'mesa', [
        session({ name: 'mesa: Animate a task card' }),
        session({ name: 'mesa: Animate a task card', pid: 99 }),
        session({ name: 'mesa: something else' }),
      ]),
    ).toBe(2)
  })

  it('ignores an unnamed session (add-agent spawns carry no --name)', () => {
    expect(liveAgentCount(task, 'mesa', [session({ name: null })])).toBe(0)
  })

  it('ignores a session in another project with the same task name', () => {
    expect(
      liveAgentCount(task, 'mesa', [session({ name: 'other: Animate a task card' })]),
    ).toBe(0)
  })

  it('requires an exact match, not a prefix or a differently-cased name', () => {
    expect(
      liveAgentCount(task, 'mesa', [
        session({ name: 'mesa: Animate a task card extra' }),
        session({ name: 'MESA: Animate a task card' }),
        session({ name: 'mesa:Animate a task card' }),
      ]),
    ).toBe(0)
  })

  it('excludes non-running sessions via isRunningAgent', () => {
    const named = { name: 'mesa: Animate a task card' }
    for (const over of [
      { state: 'done' },
      { state: 'failed' },
      { state: 'stopped' },
      { pid: null },
      // The stale `idle` + `working` background session from task 571.
      { status: 'idle', state: 'working' },
    ]) {
      expect(liveAgentCount(task, 'mesa', [session({ ...named, ...over })])).toBe(0)
    }
  })

  it('counts an interactive session (no state) started with a matching name', () => {
    expect(
      liveAgentCount(task, 'mesa', [
        session({ name: 'mesa: Animate a task card', kind: 'interactive', state: null }),
      ]),
    ).toBe(1)
  })

  it('is 0 for an empty list, and for the unloaded/failed feed', () => {
    expect(liveAgentCount(task, 'mesa', [])).toBe(0)
    expect(liveAgentCount(task, 'mesa', null)).toBe(0)
    expect(liveAgentCount(task, null, [session({ name: 'mesa: Animate a task card' })])).toBe(
      0,
    )
  })
})

describe('boardView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored for the board', () => {
    expect(loadBoardView(7)).toBeNull()
  })

  it('round-trips a saved view unchanged', () => {
    const view = { tx: -120.5, ty: 40, scale: 1.25 }
    saveBoardView(7, view)
    expect(loadBoardView(7)).toEqual(view)
  })

  it('keys storage per board', () => {
    saveBoardView(7, { tx: 1, ty: 2, scale: 3 })
    expect(loadBoardView(8)).toBeNull()
  })

  it('falls back to null on unparseable JSON', () => {
    localStorage.setItem('mesa-board-view-7', 'not json{')
    expect(loadBoardView(7)).toBeNull()
  })

  it.each([
    ['a missing key', '{"tx":1,"ty":2}'],
    ['a non-numeric member', '{"tx":1,"ty":2,"scale":"1.5"}'],
    ['a non-object', '42'],
    ['null', 'null'],
  ])('falls back to null on %s', (_label, raw) => {
    localStorage.setItem('mesa-board-view-7', raw)
    expect(loadBoardView(7)).toBeNull()
  })
})
