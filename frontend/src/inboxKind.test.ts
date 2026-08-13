import { describe, expect, it } from 'vitest'
import { INBOX_KINDS, inboxKindClass, inboxKindLabel } from './inboxKind'

describe('INBOX_KINDS', () => {
  it('words exactly the two kinds', () => {
    expect(INBOX_KINDS.map((k) => k.kind)).toEqual([
      'change-request',
      'task-summary',
    ])
  })
})

describe('inboxKindLabel', () => {
  it('words each kind for the meta line', () => {
    expect(inboxKindLabel('task-summary')).toBe('task summary')
    expect(inboxKindLabel('change-request')).toBe('change request')
  })
})

describe('inboxKindClass', () => {
  it('names one tint class per kind', () => {
    expect(inboxKindClass('task-summary')).toBe('inbox-kind-task-summary')
    expect(inboxKindClass('change-request')).toBe('inbox-kind-change-request')
  })
})
