import { describe, expect, it } from 'vitest'
import {
  caretPosition,
  gutterDigits,
  gutterText,
  lineAtScroll,
  lineCount,
  normalizeNewlines,
  offsetForLine,
  viewerLineCount,
} from './editorStatus'

describe('caretPosition', () => {
  it('reports 1,1 at the start of an empty document', () => {
    expect(caretPosition('', 0)).toEqual({ line: 1, col: 1 })
  })

  it('counts columns from 1 on the first line', () => {
    expect(caretPosition('hello', 0)).toEqual({ line: 1, col: 1 })
    expect(caretPosition('hello', 3)).toEqual({ line: 1, col: 4 })
    expect(caretPosition('hello', 5)).toEqual({ line: 1, col: 6 })
  })

  it('moves to the next line at the character after a newline', () => {
    // Offset 2 is the newline itself — still the end of line 1; offset 3 is the
    // first character of line 2.
    expect(caretPosition('ab\ncd', 2)).toEqual({ line: 1, col: 3 })
    expect(caretPosition('ab\ncd', 3)).toEqual({ line: 2, col: 1 })
    expect(caretPosition('ab\ncd', 5)).toEqual({ line: 2, col: 3 })
  })

  it('lands on the empty line a trailing newline opens', () => {
    expect(caretPosition('ab\n', 3)).toEqual({ line: 2, col: 1 })
  })

  it('treats CRLF as one break, not two', () => {
    expect(caretPosition('ab\r\ncd', 4)).toEqual({ line: 2, col: 1 })
    expect(caretPosition('a\r\nb\r\nc', 6)).toEqual({ line: 3, col: 1 })
  })

  it('treats a lone CR as a break', () => {
    expect(caretPosition('ab\rcd', 3)).toEqual({ line: 2, col: 1 })
  })

  it('clamps an offset outside the text instead of going negative', () => {
    expect(caretPosition('abc', 99)).toEqual({ line: 1, col: 4 })
    expect(caretPosition('abc', -5)).toEqual({ line: 1, col: 1 })
    expect(caretPosition('abc', NaN)).toEqual({ line: 1, col: 1 })
    expect(caretPosition('abc', 1.9)).toEqual({ line: 1, col: 2 })
  })

  it('counts blank lines as lines', () => {
    expect(caretPosition('\n\n\n', 3)).toEqual({ line: 4, col: 1 })
  })
})

describe('lineCount', () => {
  it('calls an empty document one line', () => {
    expect(lineCount('')).toBe(1)
  })

  it('counts one more line than there are breaks', () => {
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('a\nb\nc')).toBe(3)
  })

  it('counts the empty line a trailing newline opens', () => {
    expect(lineCount('a\n')).toBe(2)
    expect(lineCount('a\n\n')).toBe(3)
  })

  it('counts CRLF once', () => {
    expect(lineCount('a\r\nb\r\nc')).toBe(3)
    expect(lineCount('a\r\n')).toBe(2)
  })

  it('counts a lone CR', () => {
    expect(lineCount('a\rb')).toBe(2)
  })
})

describe('viewerLineCount', () => {
  it('matches lineCount when there is no trailing newline', () => {
    for (const value of ['', 'a', 'a\nb', 'a\n\nb']) {
      expect(viewerLineCount(value)).toBe(lineCount(value))
    }
  })

  it('drops the trailing empty line a <pre> swallows', () => {
    expect(viewerLineCount('a\n')).toBe(1)
    expect(viewerLineCount('a\r\n')).toBe(1)
    expect(viewerLineCount('a\nb\n')).toBe(2)
  })

  it('drops only ONE trailing newline, like the <pre> does', () => {
    expect(viewerLineCount('a\n\n')).toBe(2)
  })

  it('never reports zero lines', () => {
    expect(viewerLineCount('\n')).toBe(1)
    expect(viewerLineCount('')).toBe(1)
  })
})

describe('gutterText', () => {
  it('numbers from 1, newline-joined, with no trailing newline', () => {
    expect(gutterText(3)).toBe('1\n2\n3')
    expect(gutterText(1)).toBe('1')
  })

  it('has exactly as many rows as lines asked for', () => {
    expect(gutterText(120).split('\n')).toHaveLength(120)
  })

  it('renders at least one number for a degenerate count', () => {
    expect(gutterText(0)).toBe('1')
    expect(gutterText(-4)).toBe('1')
    expect(gutterText(NaN)).toBe('1')
    expect(gutterText(2.7)).toBe('1\n2')
  })

  it('lines up row-for-row with the count it was built from', () => {
    // The pairing the alignment depends on: the gutter for a file is built
    // from that file's own count, so the last number IS the last line.
    const content = 'one\ntwo\nthree\n'
    const rows = gutterText(viewerLineCount(content)).split('\n')
    expect(rows).toEqual(['1', '2', '3'])
    const draftRows = gutterText(lineCount(content)).split('\n')
    expect(draftRows).toEqual(['1', '2', '3', '4'])
  })
})

describe('gutterDigits', () => {
  it('is the width of the widest number the gutter will hold', () => {
    expect(gutterDigits(9)).toBe(2)
    expect(gutterDigits(99)).toBe(2)
    expect(gutterDigits(100)).toBe(3)
    expect(gutterDigits(99999)).toBe(5)
    expect(gutterDigits(131072)).toBe(6)
  })

  it('never asks for a rail too narrow to read', () => {
    expect(gutterDigits(1)).toBe(2)
    expect(gutterDigits(0)).toBe(2)
    expect(gutterDigits(-4)).toBe(2)
    expect(gutterDigits(NaN)).toBe(2)
  })

  it('fits every row of the text built from the same count', () => {
    // The pairing the width depends on: the two are always called with one
    // count, so no number the <pre> paints can be wider than the column.
    for (const lines of [1, 7, 42, 1000, 131072]) {
      const widest = Math.max(
        ...gutterText(Math.min(lines, 200)).split('\n').map((n) => n.length),
        String(lines).length,
      )
      expect(gutterDigits(lines)).toBeGreaterThanOrEqual(widest)
    }
  })
})

describe('normalizeNewlines', () => {
  it('leaves an LF document alone', () => {
    expect(normalizeNewlines('a\nb\n')).toBe('a\nb\n')
    expect(normalizeNewlines('')).toBe('')
  })

  it('folds CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\r\n')).toBe('a\nb\n')
    expect(normalizeNewlines('a\rb')).toBe('a\nb')
  })

  it('makes offsets agree with what a textarea would report', () => {
    // The failure this closes: find ran over the CRLF draft, so every offset
    // past the first line was one char per line ahead of the same position in
    // the textarea's own LF-normalised value.
    const crlf = 'one\r\ntwo\r\nthree'
    const normalized = normalizeNewlines(crlf)
    expect(crlf.indexOf('three')).toBe(10)
    expect(normalized.indexOf('three')).toBe(8)
    expect(normalized).toBe(crlf.split('\r\n').join('\n'))
  })
})

describe('offsetForLine', () => {
  it('answers 0 for the first line, whatever is asked below it', () => {
    expect(offsetForLine('a\nb\nc', 1)).toBe(0)
    expect(offsetForLine('a\nb\nc', 0)).toBe(0)
    expect(offsetForLine('', 3)).toBe(0)
  })

  it('answers the offset just past the preceding break', () => {
    expect(offsetForLine('a\nb\nc', 2)).toBe(2)
    expect(offsetForLine('a\nb\nc', 3)).toBe(4)
  })

  it('counts a lone CR as a break, like every other line count here', () => {
    expect(offsetForLine('a\rb', 2)).toBe(2)
  })

  it('clamps past the end rather than answering -1', () => {
    expect(offsetForLine('a\nb', 9)).toBe(3)
  })
})

describe('lineAtScroll', () => {
  it('is line 1 at the top', () => {
    expect(lineAtScroll(0, 18)).toBe(1)
    expect(lineAtScroll(-40, 18)).toBe(1)
  })

  it('counts whole lines scrolled past', () => {
    expect(lineAtScroll(18, 18)).toBe(2)
    expect(lineAtScroll(179, 18)).toBe(10)
  })

  it('answers line 1 when it cannot measure', () => {
    expect(lineAtScroll(180, NaN)).toBe(1)
    expect(lineAtScroll(180, 0)).toBe(1)
    expect(lineAtScroll(NaN, 18)).toBe(1)
  })
})
