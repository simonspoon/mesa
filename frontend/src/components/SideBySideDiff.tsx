import { Fragment } from 'react'

/** One side of one rendered row: the line's number in that version of the
 * file, and its text with the unified-diff marker already stripped. */
type Side = { no: number; text: string }

/** A row of the side-by-side rendering. `hunk`/`meta` span the full width
 * (a `@@ … @@` header, or a line the parser can't place — e.g. the
 * `[diff truncated]` notice the server appends past DIFF_CAP); the rest
 * carry an old-side and/or new-side cell. */
type DiffRow =
  // `hunk` and `meta` are separate members rather than one with a two-literal
  // `kind`, so TypeScript can subtract them one at a time and narrow the
  // remaining member in the `else` branch of the render below.
  | { kind: 'hunk'; text: string }
  | { kind: 'meta'; text: string }
  | {
      kind: 'ctx' | 'chg' | 'del' | 'add'
      left: Side | null
      right: Side | null
    }

/**
 * Parses a unified diff into aligned old|new rows.
 *
 * Runs of `-` and `+` lines inside a hunk are buffered and flushed together
 * so the i-th deletion sits opposite the i-th addition (`chg`), with the
 * longer run's leftover lines rendered against an empty cell (`del`/`add`) —
 * the standard split-diff pairing. Line numbers come from each hunk's
 * `@@ -a,b +c,d @@` header and advance per side, so they stay the file's
 * real numbers rather than row indices.
 *
 * Everything before the first hunk header (`diff --git`, `index`, `---`,
 * `+++`, mode/rename lines) is dropped: the pane already names the file, and
 * those lines would otherwise be misread as content by the `-`/`+` prefix
 * checks. A diff with no hunk at all therefore parses to `[]`, which the
 * component below renders as the raw text instead — that's the shape a
 * binary file's "Binary files … differ" notice arrives in.
 */
function parseSideBySide(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  const lines = diff.split('\n')
  // `split('\n')` on text ending in a newline yields a trailing '' that is
  // not a line of the diff.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let leftNo = 0
  let rightNo = 0
  let started = false
  let dels: string[] = []
  let adds: string[] = []

  function flush() {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? { no: leftNo++, text: dels[i] } : null
      const right = i < adds.length ? { no: rightNo++, text: adds[i] } : null
      rows.push({
        kind: left && right ? 'chg' : left ? 'del' : 'add',
        left,
        right,
      })
    }
    dels = []
    adds = []
  }

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush()
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        leftNo = Number(m[1])
        rightNo = Number(m[2])
      }
      rows.push({ kind: 'hunk', text: line })
      started = true
      continue
    }
    if (!started) continue
    // "\ No newline at end of file" annotates the preceding line; it is not
    // a line of either version.
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      adds.push(line.slice(1))
      continue
    }
    if (line.startsWith('-')) {
      dels.push(line.slice(1))
      continue
    }
    if (line.startsWith(' ') || line === '') {
      flush()
      const text = line.slice(1)
      rows.push({
        kind: 'ctx',
        left: { no: leftNo++, text },
        right: { no: rightNo++, text },
      })
      continue
    }
    // Anything else inside a hunk isn't diff content — the truncation
    // notice, or the header of a second file in a multi-file diff.
    flush()
    rows.push({ kind: 'meta', text: line })
  }
  flush()
  return rows
}

/**
 * A unified diff rendered as two columns: the file before the change on the
 * left, after it on the right.
 *
 * Diff text is untrusted data — every line is emitted as a plain text node
 * inside a cell, classified by prefix for CSS only and never interpreted as
 * markup, exactly like GitView's unified `DiffText`. A diff with no hunks
 * (binary files, an empty diff) falls back to rendering the server's text
 * verbatim rather than an empty grid.
 */
export function SideBySideDiff({ diff }: { diff: string }) {
  if (diff === '') return <p className="muted">No diff.</p>
  const rows = parseSideBySide(diff)
  if (rows.length === 0) {
    return <pre className="git-diff-text">{diff}</pre>
  }
  // Cells are emitted straight into one 4-column grid (no per-row wrapper),
  // so both halves of a row share the grid's column tracks and stay aligned
  // however a long line wraps. Tint is per side, not per row: a `chg` row is
  // deletion-tinted on the left and addition-tinted on the right.
  return (
    <div className="diff-split">
      {rows.map((row, i) => {
        if (row.kind === 'hunk' || row.kind === 'meta') {
          return (
            <span key={i} className={`diff-split-full diff-split-${row.kind}`}>
              {row.text}
            </span>
          )
        }
        const leftTint =
          row.kind === 'ctx' ? 'ctx' : row.left !== null ? 'del' : 'empty'
        const rightTint =
          row.kind === 'ctx' ? 'ctx' : row.right !== null ? 'add' : 'empty'
        return (
          <Fragment key={i}>
            <span className={`diff-split-no diff-split-${leftTint}`}>
              {row.left?.no ?? ''}
            </span>
            <span className={`diff-split-text diff-split-${leftTint}`}>
              {row.left?.text ?? ''}
            </span>
            <span className={`diff-split-no diff-split-${rightTint}`}>
              {row.right?.no ?? ''}
            </span>
            <span className={`diff-split-text diff-split-${rightTint}`}>
              {row.right?.text ?? ''}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
