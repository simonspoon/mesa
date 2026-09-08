import { describe, expect, it } from 'vitest'
import { delimiterFor, parseDelimited } from './fileCsv'

describe('delimiterFor', () => {
  it('maps the two tabular tags and nothing else', () => {
    expect(delimiterFor('csv')).toBe(',')
    expect(delimiterFor('tsv')).toBe('\t')
    expect(delimiterFor('markdown')).toBeNull()
    expect(delimiterFor(null)).toBeNull()
  })
})

describe('parseDelimited', () => {
  it('splits plain records into a header and rows', () => {
    const t = parseDelimited('a,b\n1,2\n3,4\n', ',', 1000)
    expect(t).toEqual({
      header: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
      total: 2,
      truncated: false,
    })
  })

  it('keeps a delimiter inside a quoted field in one cell', () => {
    const t = parseDelimited('a,b\n"x,y",2\n', ',', 1000)
    expect(t?.rows).toEqual([['x,y', '2']])
  })

  it('keeps a newline inside a quoted field in one cell', () => {
    const t = parseDelimited('a,b\n"line1\nline2",2\n', ',', 1000)
    expect(t?.rows).toEqual([['line1\nline2', '2']])
    expect(t?.total).toBe(1)
  })

  it('reads a doubled quote as one literal quote', () => {
    const t = parseDelimited('a,b\n"say ""hi""",2\n', ',', 1000)
    expect(t?.rows).toEqual([['say "hi"', '2']])
  })

  it('ends a record on CRLF as well as LF', () => {
    const t = parseDelimited('a,b\r\n1,2\r\n', ',', 1000)
    expect(t?.header).toEqual(['a', 'b'])
    expect(t?.rows).toEqual([['1', '2']])
  })

  it('does not turn a trailing newline into a phantom empty row', () => {
    expect(parseDelimited('a,b\n1,2\n', ',', 1000)?.total).toBe(1)
    expect(parseDelimited('a,b\n1,2', ',', 1000)?.total).toBe(1)
  })

  it('keeps ragged rows exactly as parsed', () => {
    const t = parseDelimited('a,b,c\n1\n1,2,3,4\n', ',', 1000)
    expect(t?.rows).toEqual([['1'], ['1', '2', '3', '4']])
  })

  it('treats a quote that is not at the start of a field as a literal', () => {
    // One stray inch mark must not swallow the rest of the file into one cell.
    const t = parseDelimited('a,b\nhe said "hi\nbob,2\n', ',', 1000)
    expect(t?.rows).toEqual([['he said "hi'], ['bob', '2']])
    expect(t?.total).toBe(2)
  })

  it('keeps literal quotes inside an unquoted field', () => {
    const t = parseDelimited('a,b\nHe said "hi" today,2\n', ',', 1000)
    expect(t?.rows).toEqual([['He said "hi" today', '2']])
  })

  it('ends a quoted field left open at EOF with what it had', () => {
    const t = parseDelimited('a,b\n"x,y', ',', 1000)
    expect(t?.rows).toEqual([['x,y']])
    expect(t?.total).toBe(1)
  })

  it('is null for empty input', () => {
    expect(parseDelimited('', ',', 1000)).toBeNull()
  })

  it('is null when the first record is a single empty field', () => {
    // A leading blank line would otherwise make the real header a data row and
    // clip every row to one column.
    expect(parseDelimited('\na,b\n1,2\n', ',', 1000)).toBeNull()
    expect(parseDelimited('\n', ',', 1000)).toBeNull()
  })

  it('is a table with no body rows for a header-only file', () => {
    const t = parseDelimited('a,b,c\n', ',', 1000)
    expect(t).toEqual({
      header: ['a', 'b', 'c'],
      rows: [],
      total: 0,
      truncated: false,
    })
  })

  it('caps rendered rows at maxRows while counting the whole file', () => {
    const text = 'a\n' + Array.from({ length: 50 }, (_, i) => `${i}\n`).join('')
    const t = parseDelimited(text, ',', 10)
    expect(t?.rows).toHaveLength(10)
    expect(t?.rows[9]).toEqual(['9'])
    expect(t?.total).toBe(50)
    expect(t?.truncated).toBe(true)
  })

  it('parses tab-delimited text', () => {
    const t = parseDelimited('a\tb\n1\t2\n', '\t', 1000)
    expect(t?.header).toEqual(['a', 'b'])
    expect(t?.rows).toEqual([['1', '2']])
  })
})
