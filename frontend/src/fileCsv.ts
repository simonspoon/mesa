/** Delimited-text parsing for the Files tab's table view.
 *
 * The delimiter is a SERVER-derived fact, not a sniff: `core::files::language_of`
 * in the Rust crate tags `.csv` as `csv` and `.tsv` as `tsv` (the same
 * relationship `fileImage.ts` has to `image_mime`), and `delimiterFor` maps that
 * tag onto the character that separates the fields. A change to either side is a
 * change to both — a tag the server stops emitting renders as plain text again,
 * one it emits without an entry here is never tabulated.
 *
 * The parser is RFC4180-ish: a `"` **at the start of a field** quotes it, `""`
 * inside a quoted field is a literal quote, and a quoted field may hold the
 * delimiter, a CR or an LF. A `"` anywhere else is an ordinary character — an
 * inch mark or an unescaped quote mid-sentence must not swallow the rest of the
 * file into one cell, which is what "any quote opens quoting" does. It is one
 * pass over the string — never a regex split, which cannot see quoting. */

/** The field separator for a language tag, or `null` when the tag is not one
 * this view renders as a table. */
export function delimiterFor(language: string | null): string | null {
  if (language === 'csv') return ','
  if (language === 'tsv') return '\t'
  return null
}

export type DelimitedTable = {
  /** The first record of the file — rendered as the table's header row. */
  header: string[]
  /** Up to `maxRows` data records, in file order. */
  rows: string[][]
  /** How many data records the WHOLE file holds, counted past `maxRows`. */
  total: number
  /** Whether `rows` is short of `total`. */
  truncated: boolean
}

/** Parses `text` as delimited records, or `null` when there is no table in it.
 *
 * `null` — the degenerate cases — is what makes the caller fall back to the
 * ordinary text render: no records at all, or a first record that is a single
 * empty field, which is what a file whose first line is blank looks like.
 * Refusing that one is not fussiness: its real header would otherwise be read
 * as a data row and every row clipped to one column. A header-only file is NOT
 * degenerate; it is a table with no body rows.
 *
 * Ragged records are kept exactly as parsed — padding or clipping a row to the
 * header's width is a rendering decision, and this module does not make it. */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number,
): DelimitedTable | null {
  const header: string[] = []
  let haveHeader = false
  const rows: string[][] = []
  let total = 0

  let field = ''
  let record: string[] = []
  let quoted = false
  // Whether this field has been contributed to at all — by a character, or by
  // the quotes around an empty one. It is what makes a `"` a quote only where a
  // field begins; `""` then a third quote is a literal, not a re-open.
  let fieldTouched = false
  // Whether anything at all has been seen since the last record boundary — what
  // tells a trailing newline (no phantom final row) from a genuine empty line.
  let started = false

  const endField = () => {
    record.push(field)
    field = ''
    fieldTouched = false
  }
  const endRecord = () => {
    endField()
    if (!haveHeader) {
      header.push(...record)
      haveHeader = true
    } else {
      total += 1
      if (rows.length < maxRows) rows.push(record)
    }
    record = []
    started = false
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && !fieldTouched) {
      quoted = true
      fieldTouched = true
      started = true
    } else if (ch === delimiter) {
      endField()
      started = true
    } else if (ch === '\n') {
      endRecord()
    } else if (ch === '\r') {
      // CRLF and a bare CR both end a record; a CR inside a quoted field never
      // reaches here.
      if (text[i + 1] === '\n') i += 1
      endRecord()
    } else {
      field += ch
      fieldTouched = true
      started = true
    }
  }
  // Whatever is left over is a final record only if the file did not end on a
  // record boundary — otherwise the trailing newline already closed it. A
  // quoted field left open at EOF ends here too, with what it had.
  if (started) endRecord()

  if (!haveHeader) return null
  if (header.length === 1 && header[0] === '') return null
  return { header, rows, total, truncated: total > rows.length }
}
