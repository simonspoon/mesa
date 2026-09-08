import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOOK_MATCHER,
  HOOK_MATCHER_MAX,
  displayRegistrations,
  enableError,
  hookBadgeLabel,
  hookIdsFor,
  matcherError,
  matcherText,
  matcherPayload,
  offersHooks,
  registrationLabel,
  unregisterHookQuery,
} from './libraryHooks'
import type { LibraryHookRegistration } from './types/LibraryHookRegistration'
import type { LibraryHookStatus } from './types/LibraryHookStatus'
import type { LibraryItem } from './types/LibraryItem'

const EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
]

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 7,
    name: 'stop-notify',
    kind: 'hook',
    scope: 'user',
    project_id: null,
    body: '#!/bin/sh',
    builtin_id: null,
    builtin: false,
    path: '.claude/hooks/stop-notify.sh',
    synced_body: null,
    synced_at: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

function reg(overrides: Partial<LibraryHookRegistration> = {}): LibraryHookRegistration {
  return {
    event: 'Stop',
    matcher: DEFAULT_HOOK_MATCHER,
    command: 'bash ~/.claude/hooks/stop-notify.sh',
    ...overrides,
  }
}

function status(registrations: LibraryHookRegistration[] = []): LibraryHookStatus {
  return {
    item_id: 7,
    name: 'stop-notify',
    settings_path: '/Users/me/.claude/settings.json',
    command: 'bash ~/.claude/hooks/stop-notify.sh',
    registered: registrations.length > 0,
    registrations,
    events: EVENTS,
  }
}

describe('offersHooks', () => {
  it('offers the panel on a stored hook row', () => {
    expect(offersHooks(item())).toBe(true)
  })

  it('offers nothing on another kind', () => {
    expect(offersHooks(item({ kind: 'agent' }))).toBe(false)
    expect(offersHooks(item({ kind: 'skill' }))).toBe(false)
  })

  // The shipped `stop-notify` is the only hook on a stock install: gating it
  // out hid the control on the one hook most people have. The page forks it on
  // the press and opens the panel against the row that creates.
  it('offers the panel on an unshadowed built-in hook too', () => {
    expect(offersHooks(item({ id: null, builtin: true, builtin_id: 'stop-notify' }))).toBe(true)
  })
})

describe('hookIdsFor', () => {
  it('is empty before the list has loaded', () => {
    expect(hookIdsFor(null)).toEqual([])
  })

  it('keeps the stored hook rows and nothing else', () => {
    expect(
      hookIdsFor([
        item({ id: 1 }),
        item({ id: 2, kind: 'agent' }),
        item({ id: 3, kind: 'skill' }),
        item({ id: 4 }),
      ]),
    ).toEqual([1, 4])
  })

  it('leaves out a built-in hook, which has no id to ask about yet', () => {
    expect(hookIdsFor([item({ id: null, builtin: true, builtin_id: 'stop-notify' })])).toEqual([])
  })
})

describe('registrationLabel', () => {
  it('names the event alone under the default matcher', () => {
    expect(registrationLabel(reg())).toBe('Stop')
  })

  it('names an empty matcher instead of showing empty parentheses', () => {
    expect(registrationLabel(reg({ matcher: '' }))).toBe('Stop (no matcher)')
  })

  it('names a narrowing matcher', () => {
    expect(registrationLabel(reg({ event: 'PreToolUse', matcher: 'Bash' }))).toBe(
      'PreToolUse (Bash)',
    )
  })
})

describe('matcherText', () => {
  it('says nothing for the default matcher', () => {
    expect(matcherText(DEFAULT_HOOK_MATCHER)).toBeNull()
  })

  // mesa never writes one, but a hand-edited settings file may hold it, and it
  // rendered as an empty pair of parentheses.
  it('names an empty matcher rather than rendering blank', () => {
    expect(matcherText('')).toBe('no matcher')
    expect(matcherText('  ')).toBe('no matcher')
  })

  it('is the matcher itself otherwise', () => {
    expect(matcherText('Bash')).toBe('Bash')
  })
})

describe('displayRegistrations', () => {
  it('orders by the server event vocabulary, not alphabetically', () => {
    const rows = displayRegistrations(
      status([reg({ event: 'SessionEnd' }), reg({ event: 'PreToolUse' }), reg({ event: 'Stop' })]),
    )
    expect(rows.map((r) => r.event)).toEqual(['PreToolUse', 'Stop', 'SessionEnd'])
  })

  it('sorts an event the server no longer lists last rather than dropping it', () => {
    const rows = displayRegistrations(status([reg({ event: 'Retired' }), reg({ event: 'Stop' })]))
    expect(rows.map((r) => r.event)).toEqual(['Stop', 'Retired'])
  })

  it('breaks a tie on matcher then command', () => {
    const rows = displayRegistrations(
      status([
        reg({ event: 'PreToolUse', matcher: 'Write', command: 'b' }),
        reg({ event: 'PreToolUse', matcher: 'Bash', command: 'b' }),
        reg({ event: 'PreToolUse', matcher: 'Bash', command: 'a' }),
      ]),
    )
    expect(rows.map((r) => `${r.matcher}/${r.command}`)).toEqual(['Bash/a', 'Bash/b', 'Write/b'])
  })

  it('deduplicates an identical triple a hand-edited file may hold twice', () => {
    expect(displayRegistrations(status([reg(), reg()]))).toEqual([reg()])
  })

  it('keeps two commands in one group as two rows', () => {
    expect(displayRegistrations(status([reg({ command: 'a' }), reg({ command: 'b' })])).length).toBe(
      2,
    )
  })
})

describe('hookBadgeLabel', () => {
  it('says so when nothing is registered', () => {
    expect(hookBadgeLabel(status())).toBe('not registered')
  })

  it('names the one event it fires on', () => {
    expect(hookBadgeLabel(status([reg()]))).toBe('registered: Stop')
  })

  it('names several events in the vocabulary order', () => {
    expect(hookBadgeLabel(status([reg({ event: 'SessionEnd' }), reg()]))).toBe(
      'registered: Stop, SessionEnd',
    )
  })

  it('reads sensibly when one event carries two matchers', () => {
    expect(
      hookBadgeLabel(status([reg({ event: 'SessionStart', matcher: '' }), reg({ event: 'SessionStart' })])),
    ).toBe('registered: SessionStart (no matcher), SessionStart')
  })

  it('shows a narrowing matcher and hides the default one', () => {
    expect(
      hookBadgeLabel(status([reg({ event: 'PreToolUse', matcher: 'Bash' }), reg()])),
    ).toBe('registered: PreToolUse (Bash), Stop')
  })

  it('counts two commands in one group as one place', () => {
    expect(hookBadgeLabel(status([reg({ command: 'a' }), reg({ command: 'b' })]))).toBe(
      'registered: Stop',
    )
  })
})

describe('matcherError', () => {
  it('accepts a blank matcher — the server applies its own default', () => {
    expect(matcherError('')).toBeNull()
    expect(matcherError('   ')).toBeNull()
  })

  it('accepts an ordinary tool pattern', () => {
    expect(matcherError('Bash')).toBeNull()
    expect(matcherError('x'.repeat(HOOK_MATCHER_MAX))).toBeNull()
  })

  it('refuses one byte past the limit, exactly as the server does', () => {
    expect(matcherError('x'.repeat(HOOK_MATCHER_MAX + 1))).toBe(
      `matcher is ${HOOK_MATCHER_MAX + 1} bytes; the limit is ${HOOK_MATCHER_MAX}`,
    )
  })

  // The server measures `str::len()` — UTF-8 bytes — so a matcher inside the
  // limit by JavaScript's own count can be past it by the server's.
  it('measures bytes, not code units, so a multi-byte matcher is refused', () => {
    const multibyte = 'é'.repeat(150)
    expect(multibyte.length).toBeLessThanOrEqual(HOOK_MATCHER_MAX)
    expect(matcherError(multibyte)).toBe(`matcher is 300 bytes; the limit is ${HOOK_MATCHER_MAX}`)
  })

  it('accepts a multi-byte matcher that fits in bytes', () => {
    expect(matcherError('é'.repeat(100))).toBeNull()
  })

  it('judges the length of the trimmed value, which is what gets sent', () => {
    expect(matcherError(` ${'x'.repeat(HOOK_MATCHER_MAX)} `)).toBeNull()
  })

  it('refuses an interior newline or carriage return', () => {
    expect(matcherError('Bash\nWrite')).toBe('matcher may not contain a newline')
    expect(matcherError('Bash\rWrite')).toBe('matcher may not contain a newline')
  })

  it('trims a surrounding newline rather than refusing it', () => {
    expect(matcherError('\nBash\n')).toBeNull()
  })
})

describe('enableError', () => {
  it('requires an event to be chosen', () => {
    expect(enableError('', 'Bash')).toBe('choose an event')
  })

  it('reports the matcher rule once an event is chosen', () => {
    expect(enableError('Stop', 'a\nb')).toBe('matcher may not contain a newline')
  })

  it('passes a chosen event with a blank matcher', () => {
    expect(enableError('Stop', '')).toBeNull()
  })
})

describe('matcherPayload', () => {
  it('omits a blank matcher so the server applies the default', () => {
    expect(matcherPayload('')).toBeUndefined()
    expect(matcherPayload('  ')).toBeUndefined()
  })

  it('sends the trimmed value', () => {
    expect(matcherPayload('  Bash ')).toBe('Bash')
  })
})

describe('unregisterHookQuery', () => {
  it('is empty when nothing narrows it — the remove-everything call', () => {
    expect(unregisterHookQuery()).toBe('')
  })

  it('carries an event alone', () => {
    expect(unregisterHookQuery('Stop')).toBe('?event=Stop')
  })

  it('carries both and percent-encodes them', () => {
    expect(unregisterHookQuery('PreToolUse', 'Bash|Write')).toBe(
      '?event=PreToolUse&matcher=Bash%7CWrite',
    )
  })

  it('carries a matcher alone (encodeURIComponent leaves the default one as-is)', () => {
    expect(unregisterHookQuery(undefined, '*')).toBe('?matcher=*')
  })
})
