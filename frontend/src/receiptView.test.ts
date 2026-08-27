import { describe, expect, it } from 'vitest'
import { receiptIsEmpty, summarizeStat, transcriptLabel } from './receiptView'
import type { TaskReceipt } from './types/TaskReceipt'

const BASE_RECEIPT: TaskReceipt = {
  task_id: 1,
  generated_at: '2026-07-26 05:30:32',
  owner: 'session_abc',
  claimed_at: '2026-07-26 04:00:00',
  closed_at: '2026-07-26 05:30:32',
  branch: 'main',
  repo_path: '/repo',
  commits: [],
  stat: { files_changed: 0, insertions: 0, deletions: 0 },
  session_id: null,
  transcript_path: null,
  edited: false,
  note: null,
}

const COMMIT = {
  hash: 'a'.repeat(40),
  short_hash: 'aaaaaaa',
  author: 'Simon',
  date: '2026-07-26T05:00:00+00:00',
  subject: 'do the thing',
}

describe('summarizeStat', () => {
  it('renders the zero case as "no file changes", not "0 files"', () => {
    expect(summarizeStat({ files_changed: 0, insertions: 0, deletions: 0 })).toBe(
      'no file changes',
    )
  })

  it('singularizes exactly one file', () => {
    expect(summarizeStat({ files_changed: 1, insertions: 5, deletions: 2 })).toBe(
      '1 file · +5 −2',
    )
  })

  it('pluralizes more than one file', () => {
    expect(summarizeStat({ files_changed: 3, insertions: 42, deletions: 7 })).toBe(
      '3 files · +42 −7',
    )
  })
})

describe('receiptIsEmpty', () => {
  it('is true for a receipt with no commits', () => {
    expect(receiptIsEmpty(BASE_RECEIPT)).toBe(true)
  })

  it('is false once the receipt records a commit', () => {
    expect(receiptIsEmpty({ ...BASE_RECEIPT, commits: [COMMIT] })).toBe(false)
  })
})

describe('transcriptLabel', () => {
  it('is null when there is no resolved transcript path', () => {
    expect(transcriptLabel(BASE_RECEIPT)).toBeNull()
  })

  it('prefers the session id when a transcript path resolved', () => {
    expect(
      transcriptLabel({
        ...BASE_RECEIPT,
        session_id: 'sess-uuid',
        transcript_path: '/path/to/transcript.jsonl',
      }),
    ).toBe('sess-uuid')
  })

  it('falls back to the transcript path when no session id resolved', () => {
    // Not really reachable given the backend's own invariant (session_id is
    // set whenever transcript_path is), but the helper stays honest either way.
    expect(
      transcriptLabel({
        ...BASE_RECEIPT,
        session_id: null,
        transcript_path: '/path/to/transcript.jsonl',
      }),
    ).toBe('/path/to/transcript.jsonl')
  })
})
