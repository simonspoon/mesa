import { useState } from 'react'
import { runScript } from '../api'
import {
  draftFrom,
  isRunnable,
  valueError,
  valuesFor,
  type ValueDraft,
} from '../scriptDraft'
import type { Script } from '../types/Script'
import type { ScriptArg } from '../types/ScriptArg'
import type { ScriptRun } from '../types/ScriptRun'

/** One control per declared kind — the whole reason the kinds are a closed
 * set of four. `bool` is a checkbox over the literal strings `"true"`/`"false"`
 * (the run path has exactly one representation for a value, and it is a
 * string); every other kind edits its string directly. */
function ArgField({
  arg,
  value,
  disabled,
  onChange,
}: {
  arg: ScriptArg
  value: string
  disabled: boolean
  onChange: (next: string) => void
}) {
  const error = valueError(arg, value)
  const label = arg.label ?? arg.name
  const control =
    arg.kind === 'bool' ? (
      <input
        type="checkbox"
        checked={value === 'true'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
      />
    ) : arg.kind === 'choice' ? (
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {/* The blank option is how an optional choice is left unsupplied. */}
        <option value="">— none —</option>
        {(arg.choices ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    ) : (
      <input
        // `number` is the control *and* the validation, not a parsed value:
        // the state stays a string so a half-typed `1e` survives (scriptDraft).
        type={arg.kind === 'number' ? 'number' : 'text'}
        value={value}
        disabled={disabled}
        placeholder={arg.default ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )

  return (
    <div className="script-arg">
      <label className="script-arg-label">
        <span>
          {label}
          {arg.required && <span className="script-arg-required"> *</span>}
        </span>
        {control}
      </label>
      <span className="muted script-arg-hint">
        ${'{'}MESA_ARG_{arg.name.toUpperCase().replace(/-/g, '_')}
        {'}'}
        {arg.default !== null && ` · default ${arg.default}`}
      </span>
      {error !== null && <span className="error">{error}</span>}
    </div>
  )
}

/** The captured outcome, rendered as **data**. A script that exits nonzero
 * did its job and said no; that is a red badge and its own stderr, never the
 * page's error state — the same rule `HookRun` established. */
function RunOutput({ run }: { run: ScriptRun }) {
  return (
    <div className="script-run-output">
      <p className="script-run-status">
        <span className={`badge ${run.exit_code === 0 ? 'script-exit-ok' : 'script-exit-fail'}`}>
          exit {run.exit_code}
        </span>
        {run.truncated && <span className="badge script-truncated">truncated at 64 KiB</span>}
      </p>
      <h4>stdout</h4>
      {run.stdout === '' ? (
        <p className="muted">(empty)</p>
      ) : (
        <pre className="script-stream">{run.stdout}</pre>
      )}
      <h4>stderr</h4>
      {run.stderr === '' ? (
        <p className="muted">(empty)</p>
      ) : (
        <pre className="script-stream">{run.stderr}</pre>
      )}
    </div>
  )
}

/**
 * The run form, generated from the script's declared argument list, plus the
 * outcome of the last run below it.
 *
 * Two kinds of "failure" are deliberately kept apart. A run that *happened*
 * and exited nonzero is a `ScriptRun` shown by `RunOutput`; only a request
 * that never produced a run (a validation error, a missing `local_path`, bash
 * failing to spawn) sets `error`. Collapsing the two would make a script that
 * usefully exits 1 look like a broken app.
 *
 * All the form logic lives in `scriptDraft.ts` — this file renders it and
 * nothing more (CLAUDE.md: logic worth testing does not stay inline in a
 * `.tsx`).
 */
export function ScriptRunPanel({
  script,
  onClose,
}: {
  script: Script
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ValueDraft>(() => draftFrom(script))
  const [run, setRun] = useState<ScriptRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setRunning(true)
    setError(null)
    runScript(script.id, valuesFor(script.args, draft)).then(
      (result) => {
        setRunning(false)
        setRun(result)
      },
      (err: unknown) => {
        setRunning(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <>
      <p className="panel-head">
        <button className="panel-close" onClick={onClose}>
          ✕
        </button>
      </p>
      <h2>Run {script.name}</h2>
      {script.description !== null && <p className="muted">{script.description}</p>}
      <form className="panel-form" onSubmit={submit}>
        {script.args.length === 0 ? (
          <p className="muted">This script takes no arguments.</p>
        ) : (
          script.args.map((arg) => (
            <ArgField
              key={arg.name}
              arg={arg}
              value={draft[arg.name] ?? ''}
              disabled={running}
              onChange={(next) => setDraft((d) => ({ ...d, [arg.name]: next }))}
            />
          ))
        )}
        <div className="inline-edit-actions">
          <button type="submit" disabled={running || !isRunnable(script.args, draft)}>
            {running ? 'running…' : 'run'}
          </button>
        </div>
        {error !== null && <span className="error">{error}</span>}
      </form>
      {run !== null && <RunOutput run={run} />}
    </>
  )
}
