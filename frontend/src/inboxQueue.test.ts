import { describe, expect, it } from 'vitest'
import { nextInQueue, readAllQueue } from './inboxQueue'
import type { InboxItem } from './types/InboxItem'

function item(
  id: number,
  read_at: string | null = null,
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

describe('readAllQueue', () => {
  it('reads oldest first, whatever order the list arrived in', () => {
    // The server lists newest first; the run goes the other way.
    expect(readAllQueue([item(9), item(4), item(7)])).toEqual([4, 7, 9])
  })

  it('takes only what the New view holds', () => {
    expect(
      readAllQueue([
        item(1),
        item(2, '2026-01-02 00:00:00'),
        item(3, null, '2026-01-03 00:00:00'),
        item(4, '2026-01-02 00:00:00', '2026-01-03 00:00:00'),
      ]),
    ).toEqual([1])
  })

  it('is empty for a clear inbox', () => {
    expect(readAllQueue([])).toEqual([])
  })

  it('does not disturb the list it was given', () => {
    const items = [item(9), item(4)]
    readAllQueue(items)
    expect(items.map((it) => it.id)).toEqual([9, 4])
  })
})

describe('nextInQueue', () => {
  it('hands back the item after this one', () => {
    expect(nextInQueue([4, 7, 9], 4)).toBe(7)
    expect(nextInQueue([4, 7, 9], 7)).toBe(9)
  })

  it('ends the run after the last item', () => {
    expect(nextInQueue([4, 7, 9], 9)).toBeNull()
  })

  it('ends the run for an item it never held', () => {
    // A row played on its own ends the run; its end must not restart one.
    expect(nextInQueue([4, 7, 9], 5)).toBeNull()
    expect(nextInQueue([], 4)).toBeNull()
  })
})
