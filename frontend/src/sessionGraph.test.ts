import { describe, expect, it } from 'vitest'
import {
  PROMPT_COLOR,
  RESPONSE_COLOR,
  formatTokens,
  shortModel,
  shortTarget,
  toolColor,
} from './sessionGraph'
describe('formatTokens', () => {
  it('leaves small counts alone', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(231)).toBe('231')
    expect(formatTokens(999)).toBe('999')
  })

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(44_741)).toBe('44.7k')
    expect(formatTokens(2_053_315)).toBe('2.05M')
  })

  it('does not render a negative or non-finite count', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })
})

describe('shortModel', () => {
  it('strips the vendor prefix and a date suffix', () => {
    expect(shortModel('claude-opus-5')).toBe('opus-5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  })

  it('keeps a bracketed context marker, which is not a date suffix', () => {
    expect(shortModel('claude-opus-5[1m]')).toBe('opus-5[1m]')
  })

  it('passes through an unknown model and null', () => {
    expect(shortModel('<synthetic>')).toBe('<synthetic>')
    expect(shortModel(null)).toBeNull()
  })
})

describe('shortTarget', () => {
  const t = (name: string, target: string | null) => shortTarget({ kind: 'tool', name, target })

  it('shows a file tool its file name, not the path to it', () => {
    expect(t('Read', '/Users/me/inaros/projects/tools/mesa/src/core/cc.rs')).toBe('cc.rs')
    expect(t('Edit', '/a/b/App.css')).toBe('App.css')
    expect(t('Write', 'relative/dir/notes.md')).toBe('notes.md')
  })

  it('leaves a command whole, including one that opens with a path', () => {
    expect(t('Bash', 'git status --short')).toBe('git status --short')
    // The flags are the informative half — basenaming this to `foo` would
    // throw away everything the reader is scanning for.
    expect(t('Bash', '/usr/local/bin/foo --flag')).toBe('/usr/local/bin/foo --flag')
    expect(t('WebFetch', 'https://example.dev/a/b')).toBe('https://example.dev/a/b')
  })

  it('basenames an unrecognised tool only when the value looks like a bare path', () => {
    expect(t('SomeNewFileTool', '/a/b/c.txt')).toBe('c.txt')
    expect(t('SomeNewFileTool', './rel/c.txt')).toBe('c.txt')
    expect(t('SomeNewFileTool', '~/notes/c.txt')).toBe('c.txt')
    // Spaces mean it is a command line, not a path.
    expect(t('SomeNewTool', '/a/b/c.txt --flag')).toBe('/a/b/c.txt --flag')
    // No leading path marker, so it is a query/name and stays whole.
    expect(t('SomeNewTool', 'src/core/cc.rs')).toBe('src/core/cc.rs')
  })

  it('passes a response preview through untouched', () => {
    const r = (target: string) => shortTarget({ kind: 'response', name: 'Response', target })
    // Prose, not a target: the path heuristic would basename a slash-command
    // reply into `clear` and a bare sentence-free reply into its last segment.
    expect(r('/clear')).toBe('/clear')
    expect(r('~/notes/c.txt')).toBe('~/notes/c.txt')
    expect(r('Done — the migration is applied.')).toBe('Done — the migration is applied.')
  })

  it('degrades instead of returning an empty label', () => {
    expect(t('Read', null)).toBeNull()
    expect(t('Bash', null)).toBeNull()
    // A trailing slash yields the directory, never ''.
    expect(t('Read', '/a/b/')).toBe('b')
    expect(t('Read', '/')).toBe('/')
  })
})

describe('toolColor', () => {
  it('is total — every name gets a real colour, including ones we have never seen', () => {
    for (const name of ['Bash', 'mcp__ccd_session__mark_chapter', 'SomeToolShippedNextMonth', '']) {
      expect(toolColor(name)).toMatch(/^hsl\(/)
    }
  })

  it('is stable for a given name', () => {
    // The point of the feature: the same tool is the same colour on every
    // reload and in every session, so a reader can learn the mapping.
    expect(toolColor('Grep')).toBe(toolColor('Grep'))
    expect(toolColor('mcp__x__y')).toBe(toolColor('mcp__x__y'))
  })

  it('never gives two high-volume tools the same colour', () => {
    // These are ~95% of the calls in a real transcript, so a collision here
    // would flatten most of the column back to one stripe. Ordered by observed
    // volume in the cc_tool_calls table.
    const hot = [
      'Bash',
      'Read',
      'Edit',
      'WebFetch',
      'Write',
      'StructuredOutput',
      'Agent',
      'WebSearch',
      'ToolSearch',
      'AskUserQuestion',
      'Glob',
      'Skill',
      'EnterWorktree',
      'TaskUpdate',
    ]
    const colors = hot.map(toolColor)
    expect(new Set(colors).size).toBe(hot.length)
  })

  it('never lets an unknown tool land on a high-volume tool colour', () => {
    // The hash draws from a reserved tail of the palette, so a name nobody has
    // seen can share with another rare tool but can never impersonate `Bash`.
    // Regression: `advisor` used to hash exactly onto `Write`.
    const hot = new Set(['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'Skill'].map(toolColor))
    for (const name of ['advisor', 'mcp__ccd_session__mark_chapter', 'Xyzzy', 'ReportFindings']) {
      expect(hot.has(toolColor(name))).toBe(false)
    }
  })

  it('gives one act one colour under all its spellings', () => {
    // Deliberate sharing, not a collision: colouring these apart would invent
    // a distinction a reader scanning the column does not have.
    expect(toolColor('Task')).toBe(toolColor('Agent'))
    expect(toolColor('Grep')).toBe(toolColor('Glob'))
    expect(toolColor('EnterWorktree')).toBe(toolColor('ExitWorktree'))
    expect(toolColor('TaskCreate')).toBe(toolColor('TaskStop'))
    expect(toolColor('SendMessage')).toBe(toolColor('SendUserFile'))
  })
})

describe('RESPONSE_COLOR', () => {
  it('is reserved — no tool can reach it, by table or by hash', () => {
    // One name per fixed slot (0-17), so the whole table is covered, plus a
    // spread of unknown names to exercise every hashed fallback slot. A
    // response node is not a tool and has no name to key on, so if `toolColor`
    // could ever return this hue the kind would stop being distinguishable.
    const named = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'WebFetch',
      'WebSearch',
      'Skill',
      'Agent',
      'Glob',
      'ToolSearch',
      'StructuredOutput',
      'AskUserQuestion',
      'EnterWorktree',
      'TaskCreate',
      'Monitor',
      'Workflow',
      'SendMessage',
      'ScheduleWakeup',
    ]
    const hashed = Array.from({ length: 300 }, (_, i) => `mcp__unknown__tool_${i}`)
    for (const name of [...named, ...hashed]) {
      expect(toolColor(name)).not.toBe(RESPONSE_COLOR)
    }
  })

  it('is distinct from the three structural kind colours', () => {
    // Mirrored from App.css's `.cc-tl-row.kind-*` left borders (session /
    // agent / skill).
    expect(['#00e5ff', '#ff2bd6', '#7c5cff']).not.toContain(RESPONSE_COLOR)
  })
})

describe('PROMPT_COLOR', () => {
  it('is reserved — no tool can reach it, by table or by hash', () => {
    // Same coverage as the RESPONSE_COLOR block: one name per fixed slot
    // (0-17) plus a spread of unknown names to exercise every hashed fallback
    // slot. A prompt node is not a tool and has no name to key on, so if
    // `toolColor` could ever return this hue the kind would stop being
    // distinguishable.
    const named = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'WebFetch',
      'WebSearch',
      'Skill',
      'Agent',
      'Glob',
      'ToolSearch',
      'StructuredOutput',
      'AskUserQuestion',
      'EnterWorktree',
      'TaskCreate',
      'Monitor',
      'Workflow',
      'SendMessage',
      'ScheduleWakeup',
    ]
    const hashed = Array.from({ length: 300 }, (_, i) => `mcp__unknown__tool_${i}`)
    for (const name of [...named, ...hashed]) {
      expect(toolColor(name)).not.toBe(PROMPT_COLOR)
    }
  })

  it('is distinct from the structural kinds, and from a response', () => {
    // The response pairing matters most of all: prompt and response are the
    // two prose kinds, sitting adjacent down the whole column.
    expect(['#00e5ff', '#ff2bd6', '#7c5cff']).not.toContain(PROMPT_COLOR)
    expect(PROMPT_COLOR).not.toBe(RESPONSE_COLOR)
  })
})

describe('shortTarget on a prompt', () => {
  it('passes a prompt preview through untouched, path-like or not', () => {
    // A bare slash command is the common case, and is exactly what the
    // "looks like a path" heuristic would mangle: `/clear` into `clear`.
    const prompt = (target: string) => shortTarget({ kind: 'prompt', name: 'Prompt', target })
    expect(prompt('/clear')).toBe('/clear')
    expect(prompt('/execute-todo 774')).toBe('/execute-todo 774')
    expect(prompt('~/src/store.rs')).toBe('~/src/store.rs')
    expect(prompt('rewrite the ingest predicate')).toBe('rewrite the ingest predicate')
  })
})
