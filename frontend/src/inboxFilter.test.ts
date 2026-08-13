import { describe, expect, it } from 'vitest'
import { filterInbox, inboxFilterFor, INBOX_SUBNAV } from './inboxFilter'
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
  }
}

const unread = item(1, null)
const read = item(2, '2026-01-02 00:00:00')
const archivedUnread = item(3, null, '2026-01-03 00:00:00')
const archivedRead = item(4, '2026-01-02 00:00:00', '2026-01-03 00:00:00')
const all = [unread, read, archivedUnread, archivedRead]

describe('inboxFilterFor', () => {
  it('reads the two named segments', () => {
    expect(inboxFilterFor('read')).toBe('read')
    expect(inboxFilterFor('archived')).toBe('archived')
  })

  it('falls back to the triage queue for a missing or unknown segment', () => {
    expect(inboxFilterFor(undefined)).toBe('new')
    expect(inboxFilterFor('')).toBe('new')
    expect(inboxFilterFor('unread')).toBe('new')
  })

  it('offers the three sub-links, New on the plain inbox URL', () => {
    expect(INBOX_SUBNAV.map((s) => s.filter)).toEqual([
      'new',
      'read',
      'archived',
    ])
    expect(INBOX_SUBNAV[0].hash).toBe('#/inbox')
  })
})

describe('filterInbox', () => {
  it('New is the unread, unarchived queue', () => {
    expect(filterInbox(all, 'new').map((i) => i.id)).toEqual([1])
  })

  it('Read is the read, unarchived items', () => {
    expect(filterInbox(all, 'read').map((i) => i.id)).toEqual([2])
  })

  it('Archived holds every archived item, read or not', () => {
    expect(filterInbox(all, 'archived').map((i) => i.id)).toEqual([3, 4])
  })

  it('keeps the list order it was given', () => {
    expect(filterInbox([read, unread], 'new').map((i) => i.id)).toEqual([1])
    expect(
      filterInbox([archivedRead, archivedUnread], 'archived').map((i) => i.id),
    ).toEqual([4, 3])
  })

  it('is empty for an empty inbox', () => {
    expect(filterInbox([], 'new')).toEqual([])
  })
})
