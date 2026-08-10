import { describe, expect, it } from 'vitest'
import {
  ARG_NAME_MAX,
  argError,
  argFrom,
  argNameError,
  argsError,
  draftFrom,
  emptyArg,
  isDirty,
  isRunnable,
  isSavable,
  parseChoices,
  scriptDraftError,
  scriptDraftFrom,
  scriptPayload,
  valueError,
  valuesFor,
  type ArgDraft,
} from './scriptDraft'
import type { Script } from './types/Script'
import type { ScriptArg } from './types/ScriptArg'
import type { ScriptArgKind } from './types/ScriptArgKind'

function arg(
  name: string,
  kind: ScriptArgKind,
  extra: Partial<ScriptArg> = {},
): ScriptArg {
  return {
    name,
    label: null,
    kind,
    required: false,
    default: null,
    choices: kind === 'choice' ? ['a', 'b'] : null,
    ...extra,
  }
}

function script(extra: Partial<Script> = {}): Script {
  return {
    id: 1,
    project_id: null,
    name: 'deploy',
    description: null,
    body: 'echo "$1"\n',
    args: [arg('target', 'text', { required: true })],
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...extra,
  }
}

function draftArg(name: string, kind: ScriptArgKind, extra: Partial<ArgDraft> = {}): ArgDraft {
  return { ...emptyArg(), name, kind, choices: kind === 'choice' ? 'a, b' : '', ...extra }
}

describe('scriptDraftFrom', () => {
  it('renders a global script as an empty project selection', () => {
    expect(scriptDraftFrom(script()).projectId).toBe('')
    expect(scriptDraftFrom(script({ project_id: 7 })).projectId).toBe('7')
  })

  it('renders absent optional text as empty boxes, not "null"', () => {
    const draft = scriptDraftFrom(script())
    expect(draft.description).toBe('')
    expect(draft.args[0].label).toBe('')
    expect(draft.args[0].default).toBe('')
  })

  it('renders a choice list as comma-separated text a user can retype', () => {
    const draft = scriptDraftFrom(script({ args: [arg('mode', 'choice')] }))
    expect(draft.args[0].choices).toBe('a, b')
  })

  it('starts blank for a new script', () => {
    expect(scriptDraftFrom(null)).toEqual({
      name: '',
      description: '',
      projectId: '',
      body: '',
      args: [],
    })
  })
})

describe('argNameError', () => {
  it('accepts what store.rs::validate_script_args accepts', () => {
    for (const name of ['target', '_leading', 'dry-run', 'A_B', 'a1']) {
      expect(argNameError(name)).toBeNull()
    }
  })

  it('rejects a name that would not survive becoming an env-var suffix', () => {
    // Leading digit, whitespace, and punctuation outside [A-Za-z0-9_-].
    for (const name of ['1st', 'bad name', 'a.b', 'a$b', 'ünïcode']) {
      expect(argNameError(name)).not.toBeNull()
    }
  })

  it('bounds the name at the same 64 characters the store does', () => {
    expect(argNameError('a'.repeat(ARG_NAME_MAX))).toBeNull()
    expect(argNameError('a'.repeat(ARG_NAME_MAX + 1))).not.toBeNull()
  })

  it('names an empty box rather than reporting a charset violation', () => {
    expect(argNameError('')).toBe('an argument needs a name')
  })
})

describe('argError', () => {
  it('requires a non-empty choices list for a choice', () => {
    expect(argError(draftArg('mode', 'choice', { choices: '' }))).toMatch(/non-empty/)
    expect(argError(draftArg('mode', 'choice', { choices: ' , ' }))).toMatch(/non-empty/)
    expect(argError(draftArg('mode', 'choice'))).toBeNull()
  })

  it('refuses choices on every other kind', () => {
    for (const kind of ['text', 'number', 'bool'] as ScriptArgKind[]) {
      expect(argError(draftArg('x', kind, { choices: 'a, b' }))).toMatch(/may not carry choices/)
      expect(argError(draftArg('x', kind))).toBeNull()
    }
  })
})

describe('argsError', () => {
  it('rejects two names that would become the same env var', () => {
    // `-`→`_` and upper-casing collapse these onto MESA_ARG_A_B.
    expect(argsError([draftArg('a-b', 'text'), draftArg('A_B', 'text')])).toMatch(/duplicate/)
  })

  it('allows distinct names', () => {
    expect(argsError([draftArg('a', 'text'), draftArg('b', 'number')])).toBeNull()
  })

  it('reports the first bad row rather than the last', () => {
    expect(argsError([draftArg('1st', 'text'), draftArg('also bad', 'text')])).toMatch(/1st/)
  })
})

describe('parseChoices', () => {
  it('drops the blanks a half-typed list leaves behind', () => {
    expect(parseChoices('a, b,')).toEqual(['a', 'b'])
    expect(parseChoices(' fast , slow ')).toEqual(['fast', 'slow'])
    expect(parseChoices('')).toEqual([])
  })
})

describe('scriptDraftError / isSavable', () => {
  it('requires a name and a body, mirroring the store validators', () => {
    const base = scriptDraftFrom(script())
    expect(isSavable(base)).toBe(true)
    expect(scriptDraftError({ ...base, name: '  ' })).toBe('a script needs a name')
    expect(scriptDraftError({ ...base, body: '\n \n' })).toBe('a script needs a body')
  })

  it('fails on a bad argument even when the script itself is fine', () => {
    const base = scriptDraftFrom(script())
    expect(isSavable({ ...base, args: [draftArg('1st', 'text')] })).toBe(false)
  })
})

describe('argFrom / scriptPayload', () => {
  it('sends empty optional text as null, never as an empty string', () => {
    expect(argFrom(draftArg('target', 'text'))).toEqual({
      name: 'target',
      label: null,
      kind: 'text',
      required: false,
      default: null,
      choices: null,
    })
  })

  it('carries choices only for a choice', () => {
    expect(argFrom(draftArg('mode', 'choice')).choices).toEqual(['a', 'b'])
    expect(argFrom(draftArg('mode', 'text', { choices: 'a, b' })).choices).toBeNull()
  })

  it('trims the name but never the body — the body is the program', () => {
    const payload = scriptPayload({
      ...scriptDraftFrom(null),
      name: '  deploy  ',
      body: '  echo hi\n',
    })
    expect(payload.name).toBe('deploy')
    expect(payload.body).toBe('  echo hi\n')
  })

  it('sends a global script as a null project_id', () => {
    expect(scriptPayload(scriptDraftFrom(script())).project_id).toBeNull()
    expect(scriptPayload(scriptDraftFrom(script({ project_id: 7 }))).project_id).toBe(7)
  })
})

describe('isDirty', () => {
  it('reads a freshly loaded script as pristine', () => {
    const s = script({ description: 'ship it', project_id: 3, args: [arg('mode', 'choice')] })
    expect(isDirty(s, scriptDraftFrom(s))).toBe(false)
  })

  it('ignores whitespace the payload would strip anyway', () => {
    const s = script()
    expect(isDirty(s, { ...scriptDraftFrom(s), name: ' deploy ' })).toBe(false)
  })

  it('sees an edited body, project, or argument list', () => {
    const s = script()
    expect(isDirty(s, { ...scriptDraftFrom(s), body: 'echo bye' })).toBe(true)
    expect(isDirty(s, { ...scriptDraftFrom(s), projectId: '2' })).toBe(true)
    expect(isDirty(s, { ...scriptDraftFrom(s), args: [] })).toBe(true)
  })

  it('treats an untouched new form as nothing to save', () => {
    expect(isDirty(null, scriptDraftFrom(null))).toBe(false)
    expect(isDirty(null, { ...scriptDraftFrom(null), name: 'x' })).toBe(true)
  })
})

describe('draftFrom', () => {
  it('pre-fills each box with its declared default', () => {
    const s = script({
      args: [arg('target', 'text', { default: 'prod' }), arg('n', 'number')],
    })
    expect(draftFrom(s)).toEqual({ target: 'prod', n: '' })
  })

  it('starts an undefaulted bool at "false" — a checkbox has no absent state', () => {
    expect(draftFrom(script({ args: [arg('dry', 'bool')] }))).toEqual({ dry: 'false' })
    expect(
      draftFrom(script({ args: [arg('dry', 'bool', { default: 'true' })] })),
    ).toEqual({ dry: 'true' })
  })
})

describe('valueError', () => {
  it('accepts every f64 literal Rust accepts, and rejects what it does not', () => {
    const n = arg('n', 'number')
    for (const raw of ['1', '-2.5', '+0.5', '.5', '1e9', '2E-3', 'inf', '-Infinity', 'NaN']) {
      expect(valueError(n, raw)).toBeNull()
    }
    // Number() would take these; f64::from_str does not.
    for (const raw of ['0x10', '1_000', 'abc', '1,5', '1 2']) {
      expect(valueError(n, raw)).toMatch(/must be a number/)
    }
  })

  it('holds a choice to its declared list', () => {
    const mode = arg('mode', 'choice')
    expect(valueError(mode, 'a')).toBeNull()
    expect(valueError(mode, 'c')).toMatch(/must be one of a, b/)
  })

  it('errors on a blank box only for a required argument with no default', () => {
    expect(valueError(arg('t', 'text', { required: true }), '')).toMatch(/is required/)
    expect(
      valueError(arg('t', 'text', { required: true, default: 'prod' }), ''),
    ).toBeNull()
    expect(valueError(arg('t', 'text'), '')).toBeNull()
  })

  it('leaves a bool unchecked, matching the Rust arm', () => {
    expect(valueError(arg('dry', 'bool'), 'anything')).toBeNull()
  })

  it('does not reject a blank number — a blank is "not supplied"', () => {
    expect(valueError(arg('n', 'number'), '')).toBeNull()
  })
})

describe('isRunnable', () => {
  it('blocks the run while a required argument is empty', () => {
    const args = [arg('target', 'text', { required: true })]
    expect(isRunnable(args, { target: '' })).toBe(false)
    expect(isRunnable(args, { target: 'prod' })).toBe(true)
  })

  it('blocks the run on a malformed number', () => {
    expect(isRunnable([arg('n', 'number')], { n: '1e' })).toBe(false)
  })

  it('treats a missing draft key the same as an empty box', () => {
    expect(isRunnable([arg('t', 'text', { required: true })], {})).toBe(false)
    expect(isRunnable([arg('t', 'text')], {})).toBe(true)
  })
})

describe('valuesFor', () => {
  it('omits blanks so defaults fill in and the rest stays genuinely unset', () => {
    const args = [arg('a', 'text', { default: 'x' }), arg('b', 'text')]
    expect(valuesFor(args, { a: '', b: '' })).toEqual({})
    expect(valuesFor(args, { a: 'given', b: '' })).toEqual({ a: 'given' })
  })

  it('never sends a key the script does not declare', () => {
    // validate_values rejects an undeclared key, so a stale draft entry must
    // not ride along into the request.
    expect(valuesFor([arg('a', 'text')], { a: '1', gone: '2' })).toEqual({ a: '1' })
  })

  it('sends a false checkbox as "false", not as an omission', () => {
    expect(valuesFor([arg('dry', 'bool')], { dry: 'false' })).toEqual({ dry: 'false' })
  })

  it('passes a shell-looking value straight through as data', () => {
    // The run path never lets a value reach a string bash parses; nothing here
    // may quote, escape or otherwise rewrite it.
    const raw = "; rm -rf /tmp/pwned #"
    expect(valuesFor([arg('target', 'text')], { target: raw })).toEqual({ target: raw })
  })
})
