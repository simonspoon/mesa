import { describe, expect, it } from 'vitest'
import {
  chatClock,
  chatGroups,
  chatToolLabel,
  chatToolSummary,
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

  it('keeps order and drops nothing, including an unknown kind', () => {
    const odd = { id: 'x1', kind: 'thinking', ts: null, model: null, name: null, text: 'hm' }
    const groups = chatGroups([odd as unknown as CcChatTurn])
    expect(groups).toHaveLength(1)
    // Unknown kinds fall to the response side rather than vanishing — a chat
    // that silently omits turns is worse than one with an unstyled row.
    expect(groups[0].kind).toBe('response')
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
  it('follows while at or near the end', () => {
    expect(isNearBottom(900, 1000, 100)).toBe(true)
    // Slack absorbs the sub-pixel rounding a fractional-DPI viewport gives,
    // which would otherwise freeze the follow on an apparently bottomed box.
    expect(isNearBottom(820, 1000, 100)).toBe(true)
  })

  it('stops following once the reader has scrolled up to read', () => {
    expect(isNearBottom(400, 1000, 100)).toBe(false)
  })

  it('follows when there is nothing to scroll', () => {
    expect(isNearBottom(0, 100, 100)).toBe(true)
  })
})
