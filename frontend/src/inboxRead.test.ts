import { describe, expect, it } from 'vitest'
import { needsMarkRead, READ_DWELL_MS, unreadCount } from './inboxRead'
import type { InboxItem } from './types/InboxItem'

function item(
  id: number,
  read_at: string | null,
  archived_at: string | null = null,
): InboxItem {
  return {
    id,
    project_id: null,
    author: 'agent-7',
    body: 'deploy v2 to staging',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    read_at,
    archived_at,
    kind: 'task-summary',
    task_id: 42,
    task_name: 'ship the auth fix',
    project_name: 'mesa',
  }
}

describe('unreadCount', () => {
  it('counts only the items with no read stamp', () => {
    expect(
      unreadCount([item(1, null), item(2, '2026-01-02 00:00:00'), item(3, null)]),
    ).toBe(2)
  })

  it('ignores archived items, unread or not (mesa task 845)', () => {
    expect(
      unreadCount([item(1, null), item(2, null, '2026-01-03 00:00:00')]),
    ).toBe(1)
  })

  it('is zero before anything is fetched, and for an all-read inbox', () => {
    expect(unreadCount(null)).toBe(0)
    expect(unreadCount([])).toBe(0)
    expect(unreadCount([item(1, '2026-01-02 00:00:00')])).toBe(0)
  })
})

describe('needsMarkRead', () => {
  const items = [item(1, null), item(2, '2026-01-02 00:00:00')]

  it('marks an unread item that is still listed', () => {
    expect(needsMarkRead(items, 1, new Set())).toBe(true)
  })

  it('leaves an already-read item alone', () => {
    expect(needsMarkRead(items, 2, new Set())).toBe(false)
  })

  it('sends the mark once per page, not once per trigger', () => {
    // Dwell and playback can both come due for the same item, and the poll
    // re-renders in between — `read_at` is still null until the refetch lands.
    expect(needsMarkRead(items, 1, new Set([1]))).toBe(false)
  })

  it('does not mark an item that has left the inbox', () => {
    // Assigned or deleted underneath the page: a dwell timer may still be
    // holding its id.
    expect(needsMarkRead(items, 9, new Set())).toBe(false)
    expect(needsMarkRead(null, 1, new Set())).toBe(false)
  })
})

describe('READ_DWELL_MS', () => {
  it('is a few seconds — long enough to be a read, short enough to be one', () => {
    expect(READ_DWELL_MS).toBeGreaterThanOrEqual(2000)
    expect(READ_DWELL_MS).toBeLessThanOrEqual(5000)
  })
})
