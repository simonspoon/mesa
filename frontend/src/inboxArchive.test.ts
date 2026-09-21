import { describe, expect, it } from 'vitest'
import { inboxArchiveLine } from './inboxArchive'
import type { InboxItem } from './types/InboxItem'

function item(fields: Partial<InboxItem>): InboxItem {
  return {
    id: 1,
    project_id: null,
    author: 'agent-7',
    body: 'please tint the rows',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    read_at: null,
    archived_at: null,
    archive_reason: null,
    archive_outcome: null,
    converted_task_id: null,
    kind: 'change-request',
    task_id: 42,
    task_name: 'the origin task',
    project_name: 'mesa',
    ...fields,
  }
}

describe('inboxArchiveLine', () => {
  it('answers null for an item with nothing to say', () => {
    expect(inboxArchiveLine(item({}))).toBeNull()
    // Archived, but with no verdict of any kind: still nothing to render.
    expect(
      inboxArchiveLine(item({ archived_at: '2026-01-02 00:00:00' })),
    ).toBeNull()
  })

  it('carries the outcome and the reason together', () => {
    expect(
      inboxArchiveLine(
        item({
          archived_at: '2026-01-02 00:00:00',
          archive_outcome: 'duplicate',
          archive_reason: 'duplicate of task 12',
        }),
      ),
    ).toEqual({
      outcome: 'duplicate',
      reason: 'duplicate of task 12',
      convertedTaskId: null,
    })
  })

  it('carries either half on its own', () => {
    expect(inboxArchiveLine(item({ archive_outcome: 'report' }))).toEqual({
      outcome: 'report',
      reason: null,
      convertedTaskId: null,
    })
    expect(inboxArchiveLine(item({ archive_reason: 'shipped' }))).toEqual({
      outcome: null,
      reason: 'shipped',
      convertedTaskId: null,
    })
  })

  it('carries the task a converted item became (mesa task 1269)', () => {
    // Assign writes the outcome and the pointer, never a prose verdict.
    expect(
      inboxArchiveLine(
        item({
          archived_at: '2026-01-02 00:00:00',
          archive_outcome: 'converted-to-task',
          converted_task_id: 77,
        }),
      ),
    ).toEqual({
      outcome: 'converted-to-task',
      reason: null,
      convertedTaskId: 77,
    })
  })

  it('renders a line for a pointer whose task outlived its outcome', () => {
    // `archive_outcome` is cleared by an un-archive while
    // `converted_task_id` is not, so the pointer alone is a real state.
    expect(inboxArchiveLine(item({ converted_task_id: 77 }))).toEqual({
      outcome: null,
      reason: null,
      convertedTaskId: 77,
    })
  })
})
