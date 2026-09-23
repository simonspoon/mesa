import { useEffect, useRef, useState } from 'react'
import { getScriptRun, startScriptRun, stopScriptRun, streamScriptRun } from '../api'
import {
  draftFrom,
  draftFromRun,
  isRunnable,
  valueError,
  valuesFor,
  type ValueDraft,
} from '../scriptDraft'
import {
  DEFAULT_FORM_PX,
  clampFormHeight,
  commandLine,
  formatClock,
  formatDuration,
  formatElapsed,
  isAtBottom,
  logLinesFrom,
  logText,
  runElapsedMs,
  runStartedMs,
  runState,
  type LogLine,
} from '../scriptRun'
import type { Script } from '../types/Script'
import type { ScriptArg } from '../types/ScriptArg'
import type { ScriptRunRecord } from '../types/ScriptRunRecord'

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
        ${'{'}NARU_ARG_{arg.name.toUpperCase().replace(/-/g, '_')}
        {'}'}
        {arg.default !== null && ` · default ${arg.default}`}
      </span>
      {error !== null && <span className="error">{error}</span>}
    </div>
  )
}

/**
 * The run pane for one script (mesa task 1196), in the page rather than a
 * modal: the generated argument form, RUN and the run's summary on top; a
 * drag handle that resizes the split and can fold the form away; and one log
 * below — stdout and stderr in arrival order, each line timestamped, stderr
 * tagged.
 *
 * Since mesa task 1224 the pane **does not own the run**. `runId` names a row
 * the server owns, and the pane attaches to it through
 * `GET /api/script-runs/{id}/stream`, which replays what the run has already
 * printed and then follows it. One code path therefore serves a run that
 * started a second ago and one that finished yesterday, and reopening either
 * restores the same screen: the form is seeded from the values *that run* was
 * given (`draftFromRun`), the state word and the exit code come off the row
 * rather than from local bookkeeping, and the elapsed clock counts from the
 * server's `started_at`, so a run reopened ten minutes in does not read
 * `00:00`.
 *
 * Two kinds of "failure" are deliberately kept apart. A run that *happened*
 * and exited nonzero is data — a red exit code in the summary and its own
 * stderr in the log; only a request that never produced a run (a validation
 * error, a missing `local_path`, bash failing to spawn) sets `error`.
 *
 * Leaving the pane no longer merely *fails* to stop the run — it structurally
 * cannot. Unmounting aborts the stream fetch and nothing else;
 * `POST /api/script-runs/{id}/stop` is the only stop, which is the exact
 * inverse of the older `/run/stream` route, where hanging up is the stop.
 *
 * All the logic worth testing lives in `scriptDraft.ts` and `scriptRun.ts`;
 * this file renders it (CLAUDE.md: logic does not stay inline in a `.tsx`).
 */
export function ScriptRunPane({
  script,
  cwd,
  runId,
  onRunStarted,
  onClose,
}: {
  script: Script
  /** Where a *new* run would happen, for display only — the server resolves
   * it. A run that already happened reports its own, which is the one that
   * was used and may since have changed. */
  cwd: string
  /** The run on screen, or `null` for the form with no run open yet. */
  runId: number | null
  /** A run has started: the page makes `#/scripts/runs/{id}` the address,
   * which comes back as `runId` and is what attaches the stream. */
  onRunStarted: (id: number) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ValueDraft>(() => draftFrom(script))
  const [run, setRun] = useState<ScriptRunRecord | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [command, setCommand] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  const [formPx, setFormPx] = useState(DEFAULT_FORM_PX)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)

  const splitRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  // The attach effect reads the script through a ref rather than depending on
  // it: a refetched list hands down a new object for an unchanged script, and
  // that must not tear down a live stream and blank the log (`useFetch`'s own
  // `loadRef` idiom).
  const scriptRef = useRef(script)
  useEffect(() => {
    scriptRef.current = script
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // A different run is on screen: clear what belonged to the last one now,
  // during render off the changed prop rather than in the effect below, so
  // there is no frame showing the old log under the new run (`useFetch.ts`
  // adjusts its own state the same way, and for the same reason).
  const [shownRunId, setShownRunId] = useState(runId)
  if (runId !== shownRunId) {
    setShownRunId(runId)
    setLines([])
    setError(null)
    setFollow(true)
    setCopied(false)
    // The row goes too, not just the log: the previous run's exit code beside
    // the new run's empty log would be a lie for the one round trip it takes
    // to read the new row. `idle` for that frame is merely uninformative.
    setRun(null)
    setCommand('')
    // The press that started this run is what got us here, so it is over.
    setStarting(false)
  }

  // Attach to the run on screen: read its row, then replay-and-follow its
  // log. Identical whether it is still going or long over.
  useEffect(() => {
    if (runId === null) return
    const controller = new AbortController()
    let live = true
    const attach = async () => {
      const record = await getScriptRun(runId)
      if (!live) return
      setRun(record)
      setDraft(draftFromRun(scriptRef.current, record.values))
      setCommand(commandLine(scriptRef.current.name, record.values))
      setNow(Date.now())
      await streamScriptRun(
        runId,
        (event) => {
          // `logLinesFrom` is the one place an event becomes a log line —
          // the terminal ones are not lines and are dropped there, not here.
          if (live) setLines((prev) => [...prev, ...logLinesFrom([event])])
        },
        controller.signal,
      )
      // The body ends when the run does, and the server writes the row before
      // it closes the stream — so this read is the run's settled outcome, and
      // the pane never has to infer a status from the events it saw.
      if (live && record.status === 'running') {
        const done = await getScriptRun(runId)
        if (live) setRun(done)
      }
    }
    attach().catch((err: unknown) => {
      if (!live) return
      setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [runId])

  // The elapsed clock, only while a run is on.
  useEffect(() => {
    if (run?.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [run?.status])

  // Follow: every new line pins the log to its end, unless the reader
  // scrolled away (onScroll turns follow off) or switched it off.
  useEffect(() => {
    const el = logRef.current
    if (follow && el !== null) el.scrollTop = el.scrollHeight
  }, [lines, follow, wrap])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setStarting(true)
    setError(null)
    startScriptRun(script.id, valuesFor(script.args, draft)).then(
      (record) => {
        // The hash is what actually opens the run — the pane attaches to
        // whatever `runId` comes back down, so there is one entry point into
        // "a run is showing" and a reload lands on the same screen. `starting`
        // is cleared by that arrival rather than here, so RUN stays disabled
        // across the gap and a second press cannot start a second run.
        onRunStarted(record.id)
      },
      (err: unknown) => {
        if (!mountedRef.current) return
        setStarting(false)
        // Refused before it started: no run happened, so what the pane is
        // showing stays exactly what it was.
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  function stop() {
    if (runId === null) return
    setStopping(true)
    stopScriptRun(runId).then(
      () => {
        if (mountedRef.current) setStopping(false)
      },
      (err: unknown) => {
        if (!mountedRef.current) return
        setStopping(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  function onLogScroll() {
    const el = logRef.current
    if (el === null) return
    const bottom = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    if (bottom !== follow) setFollow(bottom)
  }

  function copy() {
    void navigator.clipboard?.writeText(logText(lines, startedAt)).then(() => {
      if (mountedRef.current) setCopied(true)
    })
  }

  function onHandleDown(e: React.PointerEvent<HTMLDivElement>) {
    if (collapsed || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  function onHandleMove(e: React.PointerEvent<HTMLDivElement>) {
    const box = splitRef.current
    if (!dragging || box === null) return
    const rect = box.getBoundingClientRect()
    setFormPx(clampFormHeight(e.clientY - rect.top, rect.height))
  }

  function onHandleUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  const state = runState(run)
  const running = state === 'running'
  // Everything time-related is measured off the server's own stamps, so a run
  // reopened long after it started reads its real age rather than its age in
  // this tab.
  const startedAt = run === null ? 0 : (runStartedMs(run) ?? 0)
  const elapsed = run === null ? 0 : (runElapsedMs(run, now) ?? 0)
  // RUN is busy while a start is in flight and while a run is going; the form
  // is only frozen by the latter, since a start that is refused leaves the
  // values the person has to correct.
  const busy = running || starting
  // A run that already happened reports the directory it actually used.
  const runCwd = run?.cwd ?? cwd

  return (
    <div className={`script-run-pane${dragging ? ' resizing' : ''}`} ref={splitRef}>
      <div className="script-run-head">
        <button type="button" className="script-run-back" onClick={onClose}>
          ← scripts
        </button>
        <span className="script-name">{script.name}</span>
        {script.args.length > 0 && (
          <span className="muted script-meta">{script.args.length} arg(s)</span>
        )}
      </div>

      {!collapsed && (
        <div className="script-run-form-pane" style={{ height: formPx }}>
          {script.description !== null && (
            <p className="script-description muted">{script.description}</p>
          )}
          <form className="script-run-form" onSubmit={submit}>
            <div className="script-run-args">
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
              {error !== null && <span className="error">{error}</span>}
            </div>
            <div className="script-run-side">
              <LastRun run={run} elapsed={elapsed} cwd={runCwd} />
              <button
                type="submit"
                className="script-run-button"
                disabled={busy || !isRunnable(script.args, draft)}
              >
                {running ? 'running…' : starting ? 'starting…' : 'RUN ▶'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div
        className={`script-run-handle${collapsed ? ' collapsed' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        title={collapsed ? undefined : 'drag to resize'}
        onPointerDown={onHandleDown}
        // A pointerdown's preventDefault does not stop the mouse's own text
        // selection, which a drag past the pane would otherwise start.
        onMouseDown={(e) => e.preventDefault()}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      >
        <span className="script-run-handle-rule" />
        <button
          type="button"
          className="script-run-collapse"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '▸ show form' : '▾ collapse form'}
        </button>
        <span className="script-run-handle-rule" />
      </div>

      <div className="script-run-log-pane">
        <div className="script-run-log-head">
          <span>
            <span className={`script-run-state script-run-state-${state}`}>● {state}</span>
            {command !== '' && (
              <>
                {' · '}
                <code className="script-run-command">{command}</code>
              </>
            )}
            {state !== 'idle' && ` · ${formatElapsed(elapsed)}`}
          </span>
          <span className="script-run-controls">
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />{' '}
              follow
            </label>
            <label>
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />{' '}
              wrap
            </label>
            <button type="button" onClick={copy} disabled={lines.length === 0}>
              {copied ? 'copied' : 'copy'}
            </button>
            <button type="button" onClick={stop} disabled={!running || stopping}>
              {stopping ? 'stopping…' : 'stop'}
            </button>
          </span>
        </div>
        <div
          className={`script-run-log${wrap ? ' wrap' : ''}`}
          ref={logRef}
          onScroll={onLogScroll}
        >
          {lines.length === 0 ? (
            <p className="muted">
              {running ? 'waiting for output…' : run === null ? 'No run yet.' : '(no output)'}
            </p>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={`script-log-line script-log-${l.stream}`}>
                <span className="script-log-time">{formatClock(startedAt + l.t)}</span>
                {l.stream === 'stderr' && <span className="script-log-tag">stderr</span>}
                <span className="script-log-text">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** The compact summary of the run on screen: when, how it ended, how long,
 * where. Every field is the row's own — a reopened run says what it did, not
 * what this tab watched it do. */
function LastRun({
  run,
  elapsed,
  cwd,
}: {
  run: ScriptRunRecord | null
  elapsed: number
  cwd: string
}) {
  const state = runState(run)
  return (
    <div className="script-run-summary muted">
      {run === null ? (
        <div>no run yet</div>
      ) : (
        <div>
          {state === 'running' ? 'started' : 'last run'}{' '}
          <span className="script-run-at">{formatClock(runStartedMs(run) ?? 0)}</span>
          {' · '}
          {state === 'running' ? (
            <span>running</span>
          ) : state === 'finished' ? (
            <span className={run.exit_code === 0 ? 'script-exit-ok' : 'script-exit-fail'}>
              exit {run.exit_code}
            </span>
          ) : (
            // Stopped, or ended with no exit status: the row's `note` says
            // which — the stop, the collection failure, the server restart.
            <span className="script-exit-fail">{run.note ?? state}</span>
          )}
          {` · ${state === 'running' ? formatElapsed(elapsed) : formatDuration(elapsed)}`}
          {run.truncated && <span className="script-truncated"> · truncated at 64 KiB</span>}
        </div>
      )}
      <div className="script-run-cwd">cwd {cwd}</div>
    </div>
  )
}
