import type { Register } from 'claude-code'

const NAME = 'codesearch'
const TIMEOUT_MS = 60_000

type Op = 'symbols' | 'deps' | 'flow' | 'summary' | 'files' | 'diff' | 'status'

/** Every argument the tool takes beyond `operation`, and the helios flag it becomes. */
const FLAGS = {
  target: { flag: '', kind: 'positional' },
  path: { flag: '', kind: 'positional' },
  grep: { flag: '--grep', kind: 'value' },
  kind: { flag: '--kind', kind: 'value' },
  file: { flag: '--file', kind: 'value' },
  scope: { flag: '--scope', kind: 'value' },
  visibility: { flag: '--visibility', kind: 'value' },
  param: { flag: '--param', kind: 'value' },
  returns: { flag: '--returns', kind: 'value' },
  body: { flag: '--body', kind: 'bool' },
  limit: { flag: '--limit', kind: 'value' },
  offset: { flag: '--offset', kind: 'value' },
  depth: { flag: '--depth', kind: 'value' },
  reads: { flag: '--reads', kind: 'bool' },
  writes: { flag: '--writes', kind: 'bool' },
  to: { flag: '--to', kind: 'value' },
  follow_impls: { flag: '--follow-impls', kind: 'bool' },
  line: { flag: '--line', kind: 'value' },
  mermaid: { flag: '--mermaid', kind: 'bool' },
  impact: { flag: '--impact', kind: 'bool' },
  language: { flag: '--language', kind: 'value' },
} as const

type ArgName = keyof typeof FLAGS

/** What each operation accepts: its positional (if any), then its flags. */
const OPS: Record<Op, { positional?: ArgName; required?: true; args: readonly ArgName[] }> = {
  symbols: {
    args: ['grep', 'kind', 'file', 'scope', 'visibility', 'param', 'returns', 'body', 'limit', 'offset'],
  },
  deps: {
    positional: 'target',
    required: true,
    args: ['scope', 'file', 'depth', 'reads', 'writes', 'to', 'follow_impls'],
  },
  flow: { positional: 'target', required: true, args: ['scope', 'file', 'line', 'mermaid'] },
  summary: { positional: 'path', args: [] },
  files: { args: ['language'] },
  diff: { args: ['impact'] },
  status: { args: [] },
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: {
    operation: {
      type: 'string',
      enum: Object.keys(OPS),
      description:
        'symbols: find definitions. deps: what a symbol/file depends on AND who references it. ' +
        'flow: control-flow graph of one function body (Rust and C# only). summary: directory overview. ' +
        'files: indexed files per language. diff: symbols changed since the last index. status: index freshness.',
    },
    target: {
      type: 'string',
      description:
        'deps/flow: the symbol or file. A bare name, `Class.Method`, or `path/to/file.rs:name`.',
    },
    path: { type: 'string', description: 'summary: directory to summarize. Defaults to the project root.' },
    grep: { type: 'string', description: 'symbols: regex over the symbol name.' },
    kind: {
      type: 'string',
      description: 'symbols: fn, struct, trait, enum, class, interface, type, const, mod.',
    },
    file: { type: 'string', description: 'Restrict to files matching this path.' },
    scope: { type: 'string', description: 'Restrict to definitions in this impl block or class.' },
    visibility: { type: 'string', enum: ['pub', 'private'], description: 'symbols: filter by visibility.' },
    param: { type: 'string', description: 'symbols: only symbols with a parameter spelled like this.' },
    returns: { type: 'string', description: 'symbols: only symbols whose return type contains this.' },
    body: { type: 'boolean', description: 'symbols: include each symbol’s source. Use with a narrow filter.' },
    limit: { type: 'integer', description: 'symbols: maximum rows.' },
    offset: { type: 'integer', description: 'symbols: rows to skip.' },
    depth: { type: 'integer', description: 'deps: transitive depth (1 by default, 10 for a `to` query).' },
    reads: { type: 'boolean', description: 'deps: only references that read the target.' },
    writes: { type: 'boolean', description: 'deps: only references that write it (C# only).' },
    to: { type: 'string', description: 'deps: find a call path from target to this symbol.' },
    follow_impls: { type: 'boolean', description: 'deps: also traverse implementors/overrides (dynamic dispatch).' },
    line: { type: 'integer', description: 'flow: pick the definition declared on this line (tells overloads apart).' },
    mermaid: { type: 'boolean', description: 'flow: emit a mermaid flowchart instead of an indented tree.' },
    impact: { type: 'boolean', description: 'diff: also report who depends on the changed symbols.' },
    language: { type: 'string', description: 'files: filter by language (rust, typescript, ...).' },
    json: { type: 'boolean', description: 'Return compact JSON instead of the human-readable listing.' },
  },
} as const

const description = `Structural code search over the helios index of the current repo. Prefer this over Grep/Glob/Read for any question about code structure: where a symbol is defined, what it depends on, who calls it, what lives in a directory, or what changed.

Pick an \`operation\` and pass only the arguments that operation takes:
  symbols  find definitions            grep, kind, file, scope, visibility, param, returns, body, limit, offset
  deps     dependencies AND references target (required), scope, file, depth, reads, writes, to, follow_impls
  flow     control-flow graph          target (required), scope, file, line, mermaid   [Rust and C# only]
  summary  directory overview          path
  files    indexed files               language
  diff     symbols changed since index impact
  status   index freshness             —

Use Grep instead for literal strings, comments, config values and other text an AST index does not model.`

export const register: Register = (on) => {
  const tool = { name: NAME, description, inputSchema: inputSchema as Record<string, unknown> }

  on('session.start', ($, e, next) => $.tool.register(tool).then(() => next(e)))

  on('tool.call', { tool: 'mcp__codesearch__codesearch' }, async ($, e) => {
    const input = e as Record<string, unknown>
    const operation = input.operation as Op
    const spec = OPS[operation]
    if (!spec) return { deny: `codesearch: unknown operation "${String(input.operation)}". One of: ${Object.keys(OPS).join(', ')}.` }

    const argv = ['helios', operation]
    const given = new Set(
      Object.keys(input).filter((k) => k !== 'operation' && k !== 'json' && k !== 'tool' && k !== 'tool_use_id' && input[k] !== undefined && input[k] !== null),
    )

    if (spec.positional) {
      const value = input[spec.positional]
      if (value === undefined || value === null || value === '') {
        if (spec.required) return { deny: `codesearch: operation "${operation}" needs \`${spec.positional}\`.` }
      } else {
        argv.push(String(value))
        given.delete(spec.positional)
      }
    }

    for (const name of spec.args) {
      const value = input[name]
      if (value === undefined || value === null) continue
      given.delete(name)
      const { flag, kind } = FLAGS[name]
      if (kind === 'bool') {
        if (value) argv.push(flag)
      } else {
        argv.push(flag, String(value))
      }
    }

    const extra = [...given]
    if (extra.length > 0) {
      return {
        deny: `codesearch: operation "${operation}" does not take ${extra.join(', ')}. It takes: ${[spec.positional, ...spec.args].filter(Boolean).join(', ') || 'no arguments'}.`,
      }
    }

    if (input.json) argv.push('--json', '--compact')

    let run
    try {
      run = await $.process.run(argv, { timeoutMs: TIMEOUT_MS })
    } catch (error) {
      return { deny: `codesearch: could not run helios (${String(error)}). Is it installed and on PATH?` }
    }

    // helios exits 2 for both "no index" and a usage error; only its own words tell them apart.
    if (run.exitCode === 2) {
      const said = `${run.stderr}${run.stdout}`.trim()
      return {
        deny: said.includes('No index found')
          ? 'codesearch: no helios index for this repo. Run `helios init` once here, then retry.'
          : `codesearch: helios rejected these arguments. ${said}`,
      }
    }
    if (run.exitCode !== 0) {
      return { deny: `codesearch: helios ${operation} failed (exit ${run.exitCode}). ${run.stderr.trim() || run.stdout.trim()}` }
    }

    const text = run.stdout.trim()
    return { result: text === '' ? `helios ${operation}: no matches.` : text }
  })
}
