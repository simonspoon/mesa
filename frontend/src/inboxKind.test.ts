import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPOSE_KIND,
  INBOX_KINDS,
  inboxKindClass,
  inboxKindLabel,
} from './inboxKind'

describe('INBOX_KINDS', () => {
  it('offers exactly the two kinds, change request first', () => {
    expect(INBOX_KINDS.map((k) => k.kind)).toEqual([
      'change-request',
      'task-summary',
    ])
  })

  it('starts the compose form on a kind it actually offers', () => {
    expect(INBOX_KINDS.some((k) => k.kind === DEFAULT_COMPOSE_KIND)).toBe(true)
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
