import { describe, expect, it } from 'vitest'
import {
  changedCommands,
  draftFrom,
  effectiveCommand,
  isDirty,
  isRowChanged,
} from './settingsDraft'
import type { ConfigCommand } from './types/ConfigCommand'

function cmd(action: string, value: string | null): ConfigCommand {
  return {
    action,
    value,
    default: `{bin} --bg -- ${action}`,
    placeholders: ['{bin}'],
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
