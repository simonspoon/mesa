import { describe, expect, it } from 'vitest'
import {
  childElapsed,
  childForPane,
  childLabel,
  childPaneHeading,
  childPaneId,
  childPaneName,
  childPromptLabel,
  isChildPaneId,
  orderedChildren,
  parseChildPaneId,
} from './agentChild'
import type { AgentChild } from './types/AgentChild'

function child(over: Partial<AgentChild> = {}): AgentChild {
  return {
    id: null,
    kind: 'subagent',
    name: 'implementer',
    detail: null,
    startedAt: null,
    contextTokens: null,
    model: null,
    state: 'running',
    ...over,
  }
}

describe('childLabel', () => {
  it('leads with the agent type for a subagent and the command for a shell', () => {
    expect(childLabel(child())).toBe('implementer')
    expect(childLabel(child({ kind: 'shell', name: '/bin/zsh -c cargo test' }))).toBe(
      '/bin/zsh -c cargo test',
    )
  })

  it('collapses a multi-line command onto one line', () => {
    expect(childLabel(child({ kind: 'shell', name: 'set -e\n\ncargo   test' }))).toBe(
      'set -e cargo test',
    )
  })

  it('falls back to the kind rather than rendering a blank card', () => {
    expect(childLabel(child({ name: '   ' }))).toBe('subagent')
    expect(childLabel(child({ kind: 'shell', name: '' }))).toBe('shell')
  })
})

describe('childElapsed', () => {
  // The server's own timestamp text: UTC, no `T`, no zone marker.
  const start = '2026-09-21 13:00:00'
  const at = (ms: number) => childElapsed(start, Date.parse('2026-09-21T13:00:00Z') + ms)

  it('counts up in the compact unit a card has room for', () => {
    expect(at(0)).toBe('0s')
    expect(at(7_400)).toBe('7s')
    expect(at(59_999)).toBe('59s')
    expect(at(60_000)).toBe('1m')
    expect(at(59 * 60_000)).toBe('59m')
    expect(at(60 * 60_000)).toBe('1h')
    expect(at(23 * 3_600_000)).toBe('23h')
    expect(at(49 * 3_600_000)).toBe('2d')
  })

  it('never claims more time than has passed, and never goes negative', () => {
    expect(at(119_000)).toBe('1m')
    expect(at(-5_000)).toBe('0s')
  })

  it('says nothing when the server could not say when it started', () => {
    // Not "0s": an absent start time must not read as one that began now.
    expect(childElapsed(null, Date.now())).toBeNull()
    expect(childElapsed('not a timestamp', Date.now())).toBeNull()
  })
})

describe('orderedChildren', () => {
  it('puts running before finished, and subagents before shells within each', () => {
    const rows = [
      child({ name: 'done-sub', state: 'finished' }),
      child({ kind: 'shell', name: 'sh-a' }),
      child({ name: 'sub-a' }),
      child({ kind: 'shell', name: 'sh-b' }),
      child({ name: 'sub-b' }),
    ]
    expect(orderedChildren(rows).map((c) => c.name)).toEqual([
      'sub-a',
      'sub-b',
      'sh-a',
      'sh-b',
      'done-sub',
    ])
  })

  it('is stable within a group, so a card does not hop between polls', () => {
    const rows = [child({ name: 'first' }), child({ name: 'second' }), child({ name: 'third' })]
    expect(orderedChildren(rows).map((c) => c.name)).toEqual(['first', 'second', 'third'])
    expect(orderedChildren([])).toEqual([])
  })

  it('leaves the caller\'s array untouched', () => {
    const rows = [child({ name: 'b', state: 'finished' }), child({ name: 'a' })]
    orderedChildren(rows)
    expect(rows.map((c) => c.name)).toEqual(['b', 'a'])
  })
})

// --- the read-only child pane (mesa task 1278) -------------------------

const sub = child({ id: 'agent-implementer-9f', name: 'implementer' })
const shell = child({ kind: 'shell', name: "/bin/zsh -c 'cargo test'" })

describe('childPaneId', () => {
  it('keys a subagent by its transcript id and a shell by its command line', () => {
    expect(childPaneId('bg7', sub)).toBe('child:bg7:sub:agent-implementer-9f')
    expect(childPaneId('bg7', shell)).toBe("child:bg7:cmd:/bin/zsh -c 'cargo test'")
  })

  it('never collides with the plain job id of an agent pane', () => {
    expect(isChildPaneId(childPaneId('bg7', sub))).toBe(true)
    expect(isChildPaneId('bg7')).toBe(false)
    expect(childPaneId('bg7', sub)).not.toBe('bg7')
  })

  it('is stable across a poll that moves the card', () => {
    // Everything but the id and the command line changes on a poll; neither
    // of those may move an open pane.
    const later = { ...sub, detail: 'Edit', contextTokens: 91_000, state: 'finished' as const }
    expect(childPaneId('bg7', later)).toBe(childPaneId('bg7', sub))
  })
})

describe('parseChildPaneId', () => {
  it('round-trips both kinds', () => {
    expect(parseChildPaneId(childPaneId('bg7', sub))).toEqual({
      parentId: 'bg7',
      agentId: 'agent-implementer-9f',
      name: null,
    })
    expect(parseChildPaneId(childPaneId('bg7', shell))).toEqual({
      parentId: 'bg7',
      agentId: null,
      name: "/bin/zsh -c 'cargo test'",
    })
  })

  it('keeps a command line holding its own colons whole', () => {
    const noisy = child({ kind: 'shell', name: 'ssh host:22 -- echo sub:cmd:x' })
    expect(parseChildPaneId(childPaneId('bg7', noisy))?.name).toBe('ssh host:22 -- echo sub:cmd:x')
  })

  it('answers null for anything that is not a child pane id', () => {
    expect(parseChildPaneId('bg7')).toBeNull()
    expect(parseChildPaneId('child:')).toBeNull()
    expect(parseChildPaneId('child:bg7')).toBeNull()
    expect(parseChildPaneId('child::sub:x')).toBeNull()
    expect(parseChildPaneId('child:bg7:other:x')).toBeNull()
  })
})

describe('childForPane', () => {
  const ref = (c: typeof sub) => parseChildPaneId(childPaneId('bg7', c))!

  it('finds the child a pane was opened on', () => {
    expect(childForPane(ref(sub), [shell, sub])).toBe(sub)
    expect(childForPane(ref(shell), [shell, sub])).toBe(shell)
  })

  it('answers null once the child has left its parent, rather than a near miss', () => {
    // A subagent stays listed only while its transcript is fresh, and a shell
    // leaves the process table the instant its call returns — both are normal.
    expect(childForPane(ref(sub), [shell])).toBeNull()
    expect(childForPane(ref(shell), [sub])).toBeNull()
    expect(childForPane(ref(sub), [])).toBeNull()
  })

  it('never matches a shell against a subagent that happens to share its name', () => {
    const twin = child({ id: 'agent-x', name: "/bin/zsh -c 'cargo test'" })
    expect(childForPane(ref(shell), [twin])).toBeNull()
  })
})

describe('childPaneName and childPaneHeading', () => {
  const subRef = parseChildPaneId(childPaneId('bg7', sub))!
  const shellRef = parseChildPaneId(childPaneId('bg7', shell))!

  it('names the pane after the live row while there is one', () => {
    expect(childPaneName(subRef, sub)).toBe('implementer')
    expect(childPaneName(shellRef, shell)).toBe("/bin/zsh -c 'cargo test'")
  })

  it('falls back to the id the pane was opened under', () => {
    expect(childPaneName(subRef, null)).toBe('agent-implementer-9f')
    expect(childPaneName(shellRef, null)).toBe("/bin/zsh -c 'cargo test'")
  })

  it('says what the pane is showing and whose it is', () => {
    expect(childPaneHeading(subRef, sub, 'supervisor')).toBe(
      'implementer · subagent of supervisor',
    )
    expect(childPaneHeading(shellRef, shell, 'supervisor')).toBe(
      "/bin/zsh -c 'cargo test' · shell of supervisor",
    )
  })

  it('keeps calling it what it is after it leaves the list', () => {
    // The kind comes from the pane id, so the header cannot change its mind
    // about what it is showing when the live row goes away.
    expect(childPaneHeading(subRef, null, 'supervisor')).toBe(
      'agent-implementer-9f · subagent of supervisor',
    )
  })
})

describe('childPromptLabel', () => {
  it('attributes the opening turn to the parent, never to the reader', () => {
    expect(childPromptLabel('supervisor', 'implementer')).toBe('supervisor → implementer')
  })
})
