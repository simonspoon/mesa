import { describe, expect, it } from 'vitest'
import {
  changedCommands,
  draftFrom,
  effectiveCommand,
  effectiveMode,
  isDirty,
  isRowChanged,
  isScript,
  scriptPlaceholderError,
} from './settingsDraft'
import type { ConfigCommand } from './types/ConfigCommand'

function cmd(action: string, value: string | null): ConfigCommand {
  return {
    action,
    value,
    default: `{bin} --bg -- ${action}`,
    placeholders: ['{bin}'],
    env_vars:
      action === 'agent-spawn'
        ? ['MESA_BIN', 'MESA_AGENT', 'MESA_PROMPT']
        : ['MESA_BIN', 'MESA_AGENT', 'MESA_ID', 'MESA_NAME'],
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
    expect(effectiveCommand(COMMANDS[1], draft)).toBe('{bin} --bg -- agent-spawn')
    expect(effectiveCommand(COMMANDS[0], draft)).toBe('mytool {id}')
    // Whitespace-only is blank, the same way the server trims before storing.
    expect(effectiveCommand(COMMANDS[0], { 'todo-watcher': '   ' })).toBe(
      '{bin} --bg -- todo-watcher',
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

describe('isScript / effectiveMode', () => {
  it('switches mode on a newline, not on whitespace (config::is_script)', () => {
    expect(isScript('mytool {id}')).toBe(false)
    expect(isScript('\n\n  mytool {id}  \n\n')).toBe(false)
    expect(isScript('cd /repo\nmytool')).toBe(true)
  })

  it('reads the mode off whatever will actually run, default included', () => {
    // A blank box falls back to the default, and every default is one line.
    expect(effectiveMode(COMMANDS[1], draftFrom(COMMANDS))).toBe('argv')
    expect(effectiveMode(COMMANDS[0], draftFrom(COMMANDS))).toBe('argv')
    expect(
      effectiveMode(COMMANDS[0], { 'todo-watcher': 'cd /repo\nexec claude' }),
    ).toBe('script')
  })
})

describe('scriptPlaceholderError', () => {
  it('says nothing about `{}` while the row is still an argv template', () => {
    expect(scriptPlaceholderError(COMMANDS[0], draftFrom(COMMANDS))).toBeNull()
  })

  it('names the variable a script should read instead', () => {
    const error = scriptPlaceholderError(COMMANDS[0], {
      'todo-watcher': 'cd /repo\nclaude --name {name}',
    })
    expect(error).toContain('{name}')
    expect(error).toContain('$MESA_NAME')
  })

  it('leaves a script’s own ${VAR} alone', () => {
    expect(
      scriptPlaceholderError(COMMANDS[0], {
        'todo-watcher': 'cd /repo\nexec "$MESA_BIN" --name "${MESA_NAME}"',
      }),
    ).toBeNull()
  })

  it('reports a placeholder this action never offered as out of scope', () => {
    const error = scriptPlaceholderError(COMMANDS[0], {
      'todo-watcher': 'cd /repo\nclaude -- {prompt}',
    })
    expect(error).toContain('not offered')
    expect(error).not.toContain('$MESA_PROMPT')
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
