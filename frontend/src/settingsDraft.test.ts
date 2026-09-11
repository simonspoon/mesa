import { describe, expect, it } from 'vitest'
import {
  changedCommands,
  draftFrom,
  effectiveCommand,
  isDirty,
  isRowChanged,
  placeholderError,
} from './settingsDraft'
import type { ConfigCommand } from './types/ConfigCommand'

function cmd(action: string, value: string | null): ConfigCommand {
  return {
    action,
    value,
    default: `claude --bg -- ${action}`,
    placeholders: action === 'agent-spawn' ? ['{prompt}'] : ['{id}', '{name}'],
  }
}

const COMMANDS = [cmd('todo-watcher', 'mytool {id}'), cmd('agent-spawn', null)]

describe('draftFrom', () => {
  it('renders an unconfigured command as an empty textarea', () => {
    expect(draftFrom(COMMANDS)).toEqual({
      'todo-watcher': 'mytool {id}',
      'agent-spawn': '',
    })
  })
})

describe('effectiveCommand', () => {
  it('falls back to the built-in default while the box is blank', () => {
    const draft = draftFrom(COMMANDS)
    expect(effectiveCommand(COMMANDS[1], draft)).toBe('claude --bg -- agent-spawn')
    expect(effectiveCommand(COMMANDS[0], draft)).toBe('mytool {id}')
    // Whitespace-only is blank, the same way the server trims before storing.
    expect(effectiveCommand(COMMANDS[0], { 'todo-watcher': '   ' })).toBe(
      'claude --bg -- todo-watcher',
    )
  })
})

describe('isRowChanged / isDirty', () => {
  it('treats a blank box and a null value as the same state', () => {
    const draft = draftFrom(COMMANDS)
    expect(isRowChanged(COMMANDS[1], draft)).toBe(false)
    expect(isDirty(COMMANDS, draft)).toBe(false)
    // Whitespace typed into an unconfigured row is still "unconfigured".
    expect(isRowChanged(COMMANDS[1], { 'agent-spawn': '  ' })).toBe(false)
  })

  it('sees a cleared box as a change back to the default', () => {
    expect(isRowChanged(COMMANDS[0], { 'todo-watcher': '' })).toBe(true)
    expect(isDirty(COMMANDS, { 'todo-watcher': '', 'agent-spawn': '' })).toBe(true)
  })

  it('ignores surrounding whitespace on an otherwise unchanged row', () => {
    expect(isRowChanged(COMMANDS[0], { 'todo-watcher': ' mytool {id} ' })).toBe(
      false,
    )
  })
})

describe('placeholderError', () => {
  it('accepts a supported placeholder, on one line or many', () => {
    expect(placeholderError(COMMANDS[0], draftFrom(COMMANDS))).toBeNull()
    expect(
      placeholderError(COMMANDS[0], {
        'todo-watcher': 'cd /repo\nclaude --name {name} -- "task {id}"',
      }),
    ).toBeNull()
  })

  it('leaves a script’s own ${VAR} and bash braces alone', () => {
    expect(
      placeholderError(COMMANDS[0], {
        'todo-watcher':
          'cd /repo\nexec "$CLAUDE_BIN" --name "${HOME}"\ncp a{,.bak}\n{ echo x; }\necho \'{id: 1}\'',
      }),
    ).toBeNull()
  })

  it('never questions a library prompt — every action offers those', () => {
    expect(
      placeholderError(COMMANDS[0], {
        'todo-watcher': 'claude -- {prompt:nightly-brief} {prompt:my.brief}',
      }),
    ).toBeNull()
  })

  it('reports a placeholder this action never offered as out of scope', () => {
    const error = placeholderError(COMMANDS[0], {
      'todo-watcher': 'cd /repo\nclaude -- {prompt}',
    })
    expect(error).toContain('{prompt} is not offered to todo-watcher')
    // A name mesa does not know is shaped like a placeholder and is a typo,
    // not bash text — the server refuses it, so the page says so first.
    expect(placeholderError(COMMANDS[1], { 'agent-spawn': 'claude {tsak}' })).toContain(
      '{tsak}',
    )
  })
})

describe('changedCommands', () => {
  it('sends only the rows that moved, trimmed', () => {
    const draft = { 'todo-watcher': '  other {id}  ', 'agent-spawn': '' }
    expect(changedCommands(COMMANDS, draft)).toEqual({
      'todo-watcher': 'other {id}',
    })
  })

  it('sends a cleared row as the empty string (the reset-to-default signal)', () => {
    expect(changedCommands(COMMANDS, { 'todo-watcher': '', 'agent-spawn': '' })).toEqual(
      { 'todo-watcher': '' },
    )
  })

  it('sends nothing when nothing changed', () => {
    expect(changedCommands(COMMANDS, draftFrom(COMMANDS))).toEqual({})
  })
})
