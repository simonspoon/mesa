import { describe, expect, it } from 'vitest'
import {
  chatClock,
  chatGroups,
  chatToolLabel,
  chatToolSummary,
  chatToolTarget,
  isNearBottom,
} from './agentChat'
import type { CcChatTurn } from './types/CcChatTurn'

function turn(over: Partial<CcChatTurn> & { id: string; kind: CcChatTurn['kind'] }): CcChatTurn {
  return { ts: null, model: null, name: null, text: '', ...over }
}

describe('chatGroups', () => {
  it('merges a run of consecutive tool calls into one block', () => {
    const groups = chatGroups([
      turn({ id: 'p1', kind: 'prompt', text: 'go' }),
      turn({ id: 'r1', kind: 'response', text: 'on it' }),
      turn({ id: 't1', kind: 'tool', name: 'Bash' }),
      turn({ id: 't2', kind: 'tool', name: 'Read' }),
      turn({ id: 't3', kind: 'tool', name: 'Bash' }),
      turn({ id: 'r2', kind: 'response', text: 'done' }),
    ])
    expect(groups.map((g) => g.kind)).toEqual(['prompt', 'response', 'tools', 'response'])
    expect(groups[2].turns.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    // The block is keyed on its first turn, which is stable across polls.
    expect(groups[2].id).toBe('t1')
  })

  it('starts a new tool block after anything else interrupts the run', () => {
    const groups = chatGroups([
      turn({ id: 't1', kind: 'tool', name: 'Bash' }),
      turn({ id: 'r1', kind: 'response', text: 'hm' }),
      turn({ id: 't2', kind: 'tool', name: 'Bash' }),
    ])
    expect(groups.map((g) => g.id)).toEqual(['t1', 'r1', 't2'])
  })

  it('shows an unknown kind without attributing it to the agent', () => {
    const odd = { id: 'x1', kind: 'thinking', ts: null, model: null, name: null, text: 'hm' }
    const groups = chatGroups([odd as unknown as CcChatTurn])
    expect(groups).toHaveLength(1)
    // Shown, because silently omitting turns is worse than an unstyled row —
    // but `other`, never `response`: labelling an unknown turn "agent" is the
    // same mis-attribution the server refuses to make for an injected line.
    expect(groups[0].kind).toBe('other')
  })

  it('is empty for an empty payload', () => {
    expect(chatGroups([])).toEqual([])
  })
})

describe('chatToolLabel', () => {
  it('appends the target only when the call has one', () => {
    expect(chatToolLabel(turn({ id: 't', kind: 'tool', name: 'Bash', text: 'cargo test' }))).toBe(
      'Bash · cargo test',
    )
    expect(chatToolLabel(turn({ id: 't', kind: 'tool', name: 'advisor', text: '' }))).toBe('advisor')
  })

  it('falls back to a generic name rather than rendering null', () => {
    expect(chatToolLabel(turn({ id: 't', kind: 'tool', text: 'x' }))).toBe('tool · x')
  })
})

describe('chatToolTarget', () => {
  it('elides a bare path from the FRONT, so the basename survives', () => {
    // CSS truncates from the end, which would cut the only part of these two
    // rows that differs.
    expect(chatToolTarget('/Users/me/inaros/projects/tools/mesa/src/core/cc.rs')).toBe(
      '…/src/core/cc.rs',
    )
    expect(chatToolTarget('~/inaros/projects/tools/mesa/frontend/src/App.css')).toBe(
      '…/frontend/src/App.css',
    )
  })

  it('leaves a short path alone', () => {
    expect(chatToolTarget('/etc/hosts')).toBe('/etc/hosts')
    expect(chatToolTarget('/a/b/c')).toBe('/a/b/c')
  })

  it('leaves a command alone even when it contains a path', () => {
    // End-truncation is correct here: `cargo test …` is the useful prefix.
    expect(chatToolTarget('cargo test --all -- /Users/me/x')).toBe('cargo test --all -- /Users/me/x')
    expect(chatToolTarget('grep -rn foo /Users/me/src')).toBe('grep -rn foo /Users/me/src')
    expect(chatToolTarget('')).toBe('')
  })
})

describe('chatToolSummary', () => {
  it('counts repeats and keeps first-use order', () => {
    expect(
      chatToolSummary([
        turn({ id: '1', kind: 'tool', name: 'Bash' }),
        turn({ id: '2', kind: 'tool', name: 'Read' }),
        turn({ id: '3', kind: 'tool', name: 'Bash' }),
        turn({ id: '4', kind: 'tool', name: 'Bash' }),
      ]),
    ).toBe('Bash ×3 · Read')
  })

  it('caps the name list so one run cannot outgrow its header', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F']
    const summary = chatToolSummary(names.map((n, i) => turn({ id: `${i}`, kind: 'tool', name: n })))
    expect(summary).toBe('A · B · C · D · +2')
  })
})

describe('chatClock', () => {
  it('renders hours and minutes, zero-padded', () => {
    // vitest runs under TZ=America/Panama (UTC-5), pinned in vite.config.ts.
    expect(chatClock('2026-08-01T14:07:00.000Z')).toBe('09:07')
  })

  it('renders nothing for a missing or unparseable timestamp', () => {
    expect(chatClock(null)).toBe('')
    expect(chatClock('not a date')).toBe('')
  })
})

describe('isNearBottom', () => {
  it('follows at the end, and through rounding slack', () => {
    expect(isNearBottom(2000, 3000, 1000)).toBe(true)
    expect(isNearBottom(1990, 3000, 1000)).toBe(true)
  })

  it('stops following once the reader has scrolled up to read', () => {
    expect(isNearBottom(1500, 3000, 1000)).toBe(false)
  })

  it('follows when there is nothing to scroll', () => {
    expect(isNearBottom(0, 100, 100)).toBe(true)
  })

  it('caps the slack at 80px, so a large pane is unchanged', () => {
    // 1000px pane: a quarter would be 250px, which would keep "following" a
    // reader who deliberately scrolled up 200px and yank them back on the
    // next poll. The cap is what stops the fix for small panes becoming the
    // same bug for large ones.
    expect(isNearBottom(1940, 3000, 1000)).toBe(true)
    expect(isNearBottom(1800, 3000, 1000)).toBe(false)
  })

  it('shrinks the slack on a short tiled pane, which is the case it exists for', () => {
    // 200px pane (a 2x2 auto-tile): slack is 50px, not 80 — a reader who
    // nudged up 60px to re-read a line has genuinely stopped following, and a
    // flat 80px would have snapped them back to the tail.
    expect(isNearBottom(2760, 3000, 200)).toBe(true)
    expect(isNearBottom(2740, 3000, 200)).toBe(false)
  })
})
