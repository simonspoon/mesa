import { describe, expect, it } from 'vitest'
import {
  detectIndentUnit,
  editorKeyEdit,
  replacementRange,
  tabEscapeAfter,
} from './editorInput'
import type { EditResult } from './editorInput'

/** Every case here goes through the one dispatcher rather than the helpers
 * behind it, because the dispatcher is what `CodeEditor` calls: a rule that is
 * right in isolation but reached for the wrong key is still a bug. */
function press(
  value: string,
  start: number,
  end: number,
  key: string,
  shiftKey = false,
  unit?: string,
): EditResult | null {
  return editorKeyEdit(value, start, end, key, shiftKey, unit)
}

describe('Tab', () => {
  it('inserts one indent unit at the caret', () => {
    expect(press('ab', 1, 1, 'Tab')).toEqual({
      value: 'a  b',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })

  it('replaces a selection inside one line', () => {
    expect(press('abcd', 1, 3, 'Tab')).toEqual({
      value: 'a  d',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })

  it('indents every line of a multi-line selection and keeps the block selected', () => {
    expect(press('a\nb\nc', 0, 3, 'Tab')).toEqual({
      value: '  a\n  b\nc',
      selectionStart: 0,
      selectionEnd: 7,
    })
  })

  it('indents from the start of the first touched line, not from the caret', () => {
    expect(press('aa\nbb', 1, 4, 'Tab')).toEqual({
      value: '  aa\n  bb',
      selectionStart: 0,
      selectionEnd: 9,
    })
  })

  it('leaves a blank line blank rather than filling it with trailing whitespace', () => {
    expect(press('a\n\nb', 0, 4, 'Tab')?.value).toBe('  a\n\n  b')
  })

  it('excludes a line the selection merely ends at the start of', () => {
    // Dragging through line 1 onto line 2's first column selects one line.
    expect(press('a\nb\nc', 0, 2, 'Tab')).toEqual({
      value: '  a\nb\nc',
      selectionStart: 0,
      selectionEnd: 3,
    })
  })

  it('adds one unit per line, however deep the lines already are', () => {
    expect(press('  a\n    b', 0, 9, 'Tab')?.value).toBe('    a\n      b')
  })
})

describe('Shift+Tab', () => {
  it('dedents the caret line with no selection, pulling the caret back with it', () => {
    expect(press('    ab', 6, 6, 'Tab', true)).toEqual({
      value: '  ab',
      selectionStart: 4,
      selectionEnd: 4,
    })
  })

  it('never pulls the caret past the start of its line', () => {
    expect(press('  ab', 1, 1, 'Tab', true)).toEqual({
      value: 'ab',
      selectionStart: 0,
      selectionEnd: 0,
    })
  })

  it('tolerates partial indentation, removing what is there', () => {
    expect(press(' ab', 3, 3, 'Tab', true)).toEqual({
      value: 'ab',
      selectionStart: 2,
      selectionEnd: 2,
    })
  })

  it('removes one tab where the line is tab-indented', () => {
    expect(press('\t\tab', 4, 4, 'Tab', true)?.value).toBe('\tab')
  })

  it('never eats a non-whitespace character', () => {
    expect(press('ab', 2, 2, 'Tab', true)).toBeNull()
    expect(press('a\nb', 0, 3, 'Tab', true)).toBeNull()
  })

  it('dedents every line of a multi-line selection and keeps the block selected', () => {
    expect(press('  a\n  b', 0, 7, 'Tab', true)).toEqual({
      value: 'a\nb',
      selectionStart: 0,
      selectionEnd: 3,
    })
  })

  it('dedents only the lines that have something to give', () => {
    expect(press('  a\nb\n    c', 0, 11, 'Tab', true)?.value).toBe('a\nb\n  c')
  })

  it('round-trips a block indent', () => {
    const indented = press('a\nb\nc', 0, 5, 'Tab')!
    const back = press(indented.value, indented.selectionStart, indented.selectionEnd, 'Tab', true)!
    expect(back.value).toBe('a\nb\nc')
  })
})

describe('Enter', () => {
  it('leaves an unindented line to the browser', () => {
    expect(press('ab', 2, 2, 'Enter')).toBeNull()
    expect(press('', 0, 0, 'Enter')).toBeNull()
  })

  it('carries the current line’s indentation onto the new line', () => {
    expect(press('  ab', 4, 4, 'Enter')).toEqual({
      value: '  ab\n  ',
      selectionStart: 7,
      selectionEnd: 7,
    })
  })

  it('splits mid-line and still carries the indentation', () => {
    expect(press('  abcd', 4, 4, 'Enter')).toEqual({
      value: '  ab\n  cd',
      selectionStart: 7,
      selectionEnd: 7,
    })
  })

  it('carries only the indentation before the caret when the caret is inside it', () => {
    expect(press('    ab', 2, 2, 'Enter')).toEqual({
      value: '  \n    ab',
      selectionStart: 5,
      selectionEnd: 5,
    })
  })

  it('adds one extra unit after a line ending in an opening bracket', () => {
    expect(press('  if (x) {', 10, 10, 'Enter')).toEqual({
      value: '  if (x) {\n    ',
      selectionStart: 15,
      selectionEnd: 15,
    })
    expect(press('a = [', 5, 5, 'Enter')?.value).toBe('a = [\n  ')
    expect(press('f(', 2, 2, 'Enter')?.value).toBe('f(\n  ')
  })

  it('ignores trailing whitespace when looking for the opening bracket', () => {
    expect(press('{  ', 3, 3, 'Enter')?.value).toBe('{  \n  ')
  })

  it('expands a matching pair into three lines, the closer back at the outer indent', () => {
    expect(press('  f() {}', 7, 7, 'Enter')).toEqual({
      value: '  f() {\n    \n  }',
      selectionStart: 12,
      selectionEnd: 12,
    })
    expect(press('[]', 1, 1, 'Enter')?.value).toBe('[\n  \n]')
    expect(press('()', 1, 1, 'Enter')?.value).toBe('(\n  \n)')
  })

  it('does not expand across a mismatched closer', () => {
    expect(press('{]', 1, 1, 'Enter')?.value).toBe('{\n  ]')
  })

  it('replaces the selection before indenting', () => {
    expect(press('  a XYZ b', 4, 7, 'Enter')).toEqual({
      value: '  a \n   b',
      selectionStart: 7,
      selectionEnd: 7,
    })
  })
})

describe('brackets and quotes', () => {
  it('auto-closes an opener at the end of the text', () => {
    expect(press('f', 1, 1, '(')).toEqual({
      value: 'f()',
      selectionStart: 2,
      selectionEnd: 2,
    })
    expect(press('', 0, 0, '{')?.value).toBe('{}')
    expect(press('', 0, 0, '[')?.value).toBe('[]')
  })

  it('auto-closes before whitespace, a closer or a separator', () => {
    expect(press('( )', 1, 1, '(')?.value).toBe('(() )')
    expect(press('()', 1, 1, '(')?.value).toBe('(())')
    expect(press('f,', 1, 1, '(')?.value).toBe('f(),')
  })

  it('does not orphan a closer in front of a word', () => {
    expect(press('abc', 0, 0, '(')).toBeNull()
    expect(press('abc', 0, 0, '"')).toBeNull()
  })

  it('auto-closes a quote', () => {
    expect(press('x = ', 4, 4, '"')).toEqual({
      value: 'x = ""',
      selectionStart: 5,
      selectionEnd: 5,
    })
    expect(press('', 0, 0, "'")?.value).toBe("''")
    expect(press('', 0, 0, '`')?.value).toBe('``')
  })

  it('leaves an apostrophe inside a word alone', () => {
    expect(press('don', 3, 3, "'")).toBeNull()
  })

  it('types over a closer that is already under the caret', () => {
    expect(press('()', 1, 1, ')')).toEqual({
      value: '()',
      selectionStart: 2,
      selectionEnd: 2,
    })
    expect(press('{}', 1, 1, '}')?.selectionStart).toBe(2)
    expect(press('[]', 1, 1, ']')?.selectionStart).toBe(2)
  })

  it('types over a closing quote', () => {
    expect(press('""', 1, 1, '"')).toEqual({
      value: '""',
      selectionStart: 2,
      selectionEnd: 2,
    })
  })

  it('types over a closer several characters into the pair', () => {
    expect(press('(abc)', 4, 4, ')')?.selectionStart).toBe(5)
    expect(press('f(a, (b))', 7, 7, ')')?.selectionStart).toBe(8)
  })

  it('inserts a literal closer that nothing opened', () => {
    // The whole point of asking whether the closer is spoken for: `foo|)` has
    // no unmatched `(` behind it, so `)` is an ordinary character here and
    // `foo))` has to be typeable.
    expect(press('foo)', 3, 3, ')')).toBeNull()
    expect(press('a]b', 1, 1, ']')).toBeNull()
    // One level deeper than the openers behind it: the inner `)` is spoken for,
    // a second one is not.
    expect(press('(a))', 2, 2, ')')?.selectionStart).toBe(3)
    expect(press('(a))', 3, 3, ')')).toBeNull()
  })

  it('types over a quote from inside the string, not in front of one', () => {
    expect(press("'a'", 2, 2, "'")?.selectionStart).toBe(3)
    // An even number of quotes behind the caret means this one is not the
    // terminator of a run the caret is inside, so stepping into somebody else's
    // string would be wrong. `null`, not a pair: the quote falls through to
    // `bracket`, which refuses to auto-close in front of a `'` (CLOSE_BEFORE),
    // so the browser types one bare quote — which is what a plain textarea
    // always did here, and the assertion this comment exists to keep honest.
    expect(press("x + 'b'", 4, 4, "'")).toBeNull()
    // Line-scoped: a string closed on an earlier line says nothing about this
    // one.
    expect(press("'a'\n'b'", 6, 6, "'")?.selectionStart).toBe(7)
  })

  it('leaves a closer alone when it is not the next character', () => {
    expect(press('(a', 2, 2, ')')).toBeNull()
    expect(press('', 0, 0, ']')).toBeNull()
  })

  it('surrounds a non-empty selection instead of replacing it', () => {
    expect(press('a bcd e', 2, 5, '(')).toEqual({
      value: 'a (bcd) e',
      selectionStart: 3,
      selectionEnd: 6,
    })
    expect(press('abc', 0, 3, '"')).toEqual({
      value: '"abc"',
      selectionStart: 1,
      selectionEnd: 4,
    })
    expect(press('a\nb', 0, 3, '{')?.value).toBe('{a\nb}')
  })

  it('does not surround with a closer', () => {
    expect(press('abc', 0, 3, ')')).toBeNull()
  })

  it('leaves every other character to the browser', () => {
    expect(press('ab', 1, 1, 'x')).toBeNull()
    expect(press('ab', 1, 1, ' ')).toBeNull()
    expect(press('ab', 1, 1, 'ArrowLeft')).toBeNull()
    expect(press('ab', 1, 1, 'Escape')).toBeNull()
  })
})

describe('Backspace', () => {
  it('deletes both halves of an empty pair', () => {
    expect(press('f()', 2, 2, 'Backspace')).toEqual({
      value: 'f',
      selectionStart: 1,
      selectionEnd: 1,
    })
    expect(press('{}', 1, 1, 'Backspace')?.value).toBe('')
    expect(press('""', 1, 1, 'Backspace')?.value).toBe('')
  })

  it('leaves a pair with something in it to the browser', () => {
    expect(press('(x)', 2, 2, 'Backspace')).toBeNull()
  })

  it('leaves mismatched neighbours alone', () => {
    expect(press('(]', 1, 1, 'Backspace')).toBeNull()
    expect(press("'\"", 1, 1, 'Backspace')).toBeNull()
  })

  it('does nothing at the very start, or with a selection', () => {
    expect(press('()', 0, 0, 'Backspace')).toBeNull()
    expect(press('()', 0, 2, 'Backspace')).toBeNull()
  })
})

describe('offsets', () => {
  it('clamps offsets outside the text', () => {
    expect(press('ab', 99, 99, 'Tab')).toEqual({
      value: 'ab  ',
      selectionStart: 4,
      selectionEnd: 4,
    })
    expect(press('ab', -3, -3, 'Tab')?.value).toBe('  ab')
    expect(press('ab', NaN, NaN, 'Tab')?.value).toBe('  ab')
  })

  it('orders a reversed selection', () => {
    expect(press('abcd', 3, 1, 'Tab')).toEqual({
      value: 'a  d',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })
})

describe('replacementRange', () => {
  it('describes an insertion', () => {
    expect(replacementRange('ab', 'a  b')).toEqual({ start: 1, end: 1, text: '  ' })
  })

  it('describes a deletion as an empty replacement', () => {
    expect(replacementRange('  ab', 'ab')).toEqual({ start: 0, end: 2, text: '' })
  })

  it('describes a replacement', () => {
    expect(replacementRange('abcd', 'aXd')).toEqual({ start: 1, end: 3, text: 'X' })
  })

  it('describes no change as an empty range', () => {
    expect(replacementRange('ab', 'ab')).toEqual({ start: 2, end: 2, text: '' })
  })

  it('never overlaps prefix and suffix on repeated characters', () => {
    expect(replacementRange('aa', 'aaa')).toEqual({ start: 2, end: 2, text: 'a' })
    expect(replacementRange('aaa', 'aa')).toEqual({ start: 2, end: 3, text: '' })
  })

  it('reconstructs the result of every edit it is given', () => {
    const cases: Array<[string, number, number, string, boolean]> = [
      ['ab', 1, 1, 'Tab', false],
      ['a\nb\nc', 0, 5, 'Tab', false],
      ['  a\n  b', 0, 7, 'Tab', true],
      ['  ab', 4, 4, 'Enter', false],
      ['  f() {}', 7, 7, 'Enter', false],
      ['f', 1, 1, '(', false],
      ['a bcd e', 2, 5, '(', false],
      ['f()', 2, 2, 'Backspace', false],
    ]
    for (const [value, start, end, key, shift] of cases) {
      const next = editorKeyEdit(value, start, end, key, shift)!
      const range = replacementRange(value, next.value)
      const rebuilt = value.slice(0, range.start) + range.text + value.slice(range.end)
      expect(rebuilt).toBe(next.value)
    }
  })
})

describe('detectIndentUnit', () => {
  it('answers the two-space fallback for a file with nothing to learn from', () => {
    expect(detectIndentUnit('')).toBe('  ')
    expect(detectIndentUnit('one\ntwo\nthree\n')).toBe('  ')
  })

  it('reads a four-space file as four spaces', () => {
    const rust = 'fn main() {\n    let a = 1;\n    if a > 0 {\n        run();\n    }\n}\n'
    expect(detectIndentUnit(rust)).toBe('    ')
  })

  it('reads a two-space file as two spaces', () => {
    const ts = 'function f() {\n  const a = 1\n  if (a) {\n    g()\n  }\n}\n'
    expect(detectIndentUnit(ts)).toBe('  ')
  })

  it('reads a tab-indented file as one tab', () => {
    const sh = 'if true; then\n\techo hi\n\tif x; then\n\t\techo deep\n\tfi\nfi\n'
    expect(detectIndentUnit(sh)).toBe('\t')
  })

  it('is not turned into a space file by one aligned continuation', () => {
    expect(detectIndentUnit('\ta\n\tb\n\tc\n  d\n')).toBe('\t')
  })

  it('ignores blank lines that carry only trailing whitespace', () => {
    expect(detectIndentUnit('a\n    \n    b\n    c\n')).toBe('    ')
  })

  it('never answers wider than an alignment-sized indent', () => {
    expect(detectIndentUnit('a\n            b\n            c\n')).toBe('        ')
  })
})

/** The unit is the file's, not this repo's — the whole point of detecting it is
 * that these keys then write what the file around them is written in. */
describe('the detected unit drives every editing key', () => {
  it('Tab inserts the file’s own unit', () => {
    expect(press('ab', 1, 1, 'Tab', false, '    ')).toEqual({
      value: 'a    b',
      selectionStart: 5,
      selectionEnd: 5,
    })
    expect(press('ab', 1, 1, 'Tab', false, '\t')).toEqual({
      value: 'a\tb',
      selectionStart: 2,
      selectionEnd: 2,
    })
  })

  it('Enter after an opener adds one of that unit, never a mixed indent', () => {
    // The bug this closes: a tab-indented block used to gain the leading tab
    // (carried, correctly) plus two hardcoded spaces — tabs AND spaces on one
    // line, written back to disk.
    expect(press('\tf() {', 6, 6, 'Enter', false, '\t')).toEqual({
      value: '\tf() {\n\t\t',
      selectionStart: 9,
      selectionEnd: 9,
    })
  })

  it('Shift+Tab takes off one of that unit', () => {
    expect(press('    a', 5, 5, 'Tab', true, '    ')).toEqual({
      value: 'a',
      selectionStart: 1,
      selectionEnd: 1,
    })
    // A narrower unit takes only what it is: the rest of the indentation stays.
    expect(press('    a', 5, 5, 'Tab', true, '  ')).toEqual({
      value: '  a',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })

  it('block-indents with that unit', () => {
    expect(press('a\nb', 0, 3, 'Tab', false, '    ')).toEqual({
      value: '    a\n    b',
      selectionStart: 0,
      selectionEnd: 11,
    })
  })

  it('defaults to two spaces when no unit is supplied', () => {
    expect(press('ab', 1, 1, 'Tab')).toEqual({
      value: 'a  b',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })
})

describe('tabEscapeAfter', () => {
  it('is disarmed until Escape is pressed', () => {
    expect(tabEscapeAfter(false, 'a')).toBe(false)
    expect(tabEscapeAfter(false, 'Tab')).toBe(false)
  })

  it('arms on Escape', () => {
    expect(tabEscapeAfter(false, 'Escape')).toBe(true)
    expect(tabEscapeAfter(true, 'Escape')).toBe(true)
  })

  it('disarms on the next typed key, so an unused hatch costs nothing', () => {
    expect(tabEscapeAfter(true, 'a')).toBe(false)
    expect(tabEscapeAfter(true, 'Enter')).toBe(false)
    expect(tabEscapeAfter(true, 'Tab')).toBe(false)
  })

  it('survives a held modifier, so Escape-then-Shift+Tab still escapes', () => {
    expect(tabEscapeAfter(true, 'Shift')).toBe(true)
    expect(tabEscapeAfter(true, 'Meta')).toBe(true)
    expect(tabEscapeAfter(false, 'Shift')).toBe(false)
  })
})
