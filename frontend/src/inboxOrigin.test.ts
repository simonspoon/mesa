import { describe, expect, it } from 'vitest'
import { inboxOriginLabel } from './inboxOrigin'
import type { InboxItem } from './types/InboxItem'

function item(fields: Partial<InboxItem>): InboxItem {
  return {
    id: 1,
    project_id: null,
    author: 'agent-7',
    body: 'deploy v2 to staging',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    read_at: null,
    archived_at: null,
    kind: 'task-summary',
    task_id: 42,
    task_name: 'Improve Inbox: require "from-task-id"',
    project_name: 'mesa',
    ...fields,
  }
}

describe('inboxOriginLabel', () => {
  it('names the project and the task the item came from', () => {
    expect(inboxOriginLabel(item({}))).toBe(
      'mesa · Improve Inbox: require "from-task-id"',
    )
  })

  it('is null for an item with no origin task (pre-847, or a deleted task)', () => {
    expect(
      inboxOriginLabel(
        item({ task_id: null, task_name: null, project_name: null }),
      ),
    ).toBe(null)
  })

  it('shows the half it has rather than a dangling separator', () => {
    expect(inboxOriginLabel(item({ project_name: null }))).toBe(
      'Improve Inbox: require "from-task-id"',
    )
    expect(inboxOriginLabel(item({ task_name: null }))).toBe('mesa')
    expect(inboxOriginLabel(item({ project_name: '', task_name: '' }))).toBe(
      null,
    )
  })
})
