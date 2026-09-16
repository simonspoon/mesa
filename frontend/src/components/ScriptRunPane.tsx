import { useEffect, useRef, useState } from 'react'
import { runScriptStream } from '../api'
import {
  draftFrom,
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
  logText,
  type LogLine,
} from '../scriptRun'
import type { Script } from '../types/Script'
import type { ScriptArg } from '../types/ScriptArg'

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

/** How a run ended, for the summary line and the log header. */
interface Finished {
  at: number
  code: number | null
  durationMs: number
  truncated: boolean
  /** Why there is no exit code: the run was stopped, or failed mid-stream. */
  note: string | null
}

type Phase = 'idle' | 'running' | 'finished'

/**
 * The run pane for one script (mesa task 1196), in the page rather than a
 * modal: the generated argument form, RUN and the last run's summary on top;
 * a drag handle that resizes the split and can fold the form away; and one
 * log below that streams the run as it happens — stdout and stderr in arrival
 * order, each line timestamped, stderr tagged.
 *
 * Two kinds of "failure" are deliberately kept apart. A run that *happened*
 * and exited nonzero is data — a red exit code in the summary and its own
 * stderr in the log; only a request that never produced a run (a validation
 * error, a missing `local_path`, bash failing to spawn) sets `error`.
 *
 * Stop aborts the fetch, and the server kills the script when the response
 * is dropped. Leaving the pane does **not** stop a run — closing the old
 * modal never did, and a navigation should not kill a release halfway — the
 * run finishes server-side with nobody reading it.
 *
 * All the logic worth testing lives in `scriptDraft.ts` and `scriptRun.ts`;
 * this file renders it (CLAUDE.md: logic does not stay inline in a `.tsx`).
 */
export function ScriptRunPane({
  script,
  cwd,
  onClose,
}: {
  script: Script
  /** Where the run happens, for display only — the server resolves it. */
  cwd: string
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ValueDraft>(() => draftFrom(script))
  const [phase, setPhase] = useState<Phase>('idle')
  const [lines, setLines] = useState<LogLine[]>([])
  const [startedAt, setStartedAt] = useState(0)
  const [command, setCommand] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [finished, setFinished] = useState<Finished | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  const [formPx, setFormPx] = useState(DEFAULT_FORM_PX)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const stoppedRef = useRef(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The elapsed clock, only while a run is on.
  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [phase])

  // Follow: every new line pins the log to its end, unless the reader
  // scrolled away (onScroll turns follow off) or switched it off.
  useEffect(() => {
    const el = logRef.current
    if (follow && el !== null) el.scrollTop = el.scrollHeight
  }, [lines, follow, wrap])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (phase === 'running') return
    const values = valuesFor(script.args, draft)
    const controller = new AbortController()
    const began = Date.now()
    abortRef.current = controller
    stoppedRef.current = false
    setPhase('running')
    setError(null)
    setLines([])
    setStartedAt(began)
    setNow(began)
    setCommand(commandLine(script.name, values))
    setFollow(true)
    setCopied(false)

    let ended: Finished | null = null
    let sawLine = false
    runScriptStream(
      script.id,
      values,
      (event) => {
        if (!mountedRef.current) return
        if (event.type === 'line') {
          const { stream, t, text } = event
          sawLine = true
          setLines((prev) => [...prev, { stream, t, text }])
        } else if (event.type === 'exit') {
          ended = {
            at: began,
            code: event.code,
            durationMs: event.duration_ms,
            truncated: event.truncated,
            note: null,
          }
        } else {
          ended = {
            at: began,
            code: null,
            durationMs: Date.now() - began,
            truncated: false,
            note: event.message,
          }
        }
      },
      controller.signal,
    ).then(
      () => {
        if (!mountedRef.current) return
        setPhase('finished')
        setFinished(
          ended ?? {
            at: began,
            code: null,
            durationMs: Date.now() - began,
            truncated: false,
            note: 'the stream ended without an exit status',
          },
        )
      },
      (err: unknown) => {
        if (!mountedRef.current) return
        if (stoppedRef.current) {
          setPhase('finished')
          setFinished({
            at: began,
            code: null,
            durationMs: Date.now() - began,
            truncated: false,
            note: 'stopped',
          })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        // Refused before it started: no run happened, so the last run's
        // summary stays what it was.
        if (ended === null && !sawLine) {
          setPhase(finished === null ? 'idle' : 'finished')
          setError(message)
          return
        }
        setPhase('finished')
        setFinished({
          at: began,
          code: null,
          durationMs: Date.now() - began,
          truncated: false,
          note: message,
        })
      },
    )
  }

  function stop() {
    stoppedRef.current = true
    abortRef.current?.abort()
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

  const running = phase === 'running'
  const elapsed = running ? now - startedAt : (finished?.durationMs ?? 0)
  const state = running
    ? 'running'
    : finished === null
      ? 'idle'
      : finished.note === 'stopped'
        ? 'stopped'
        : finished.code === null
          ? 'failed'
          : 'finished'

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
              <LastRun finished={finished} cwd={cwd} />
              <button
                type="submit"
                className="script-run-button"
                disabled={running || !isRunnable(script.args, draft)}
              >
                {running ? 'running…' : 'RUN ▶'}
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
            <button type="button" onClick={stop} disabled={!running}>
              stop
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
              {running ? 'waiting for output…' : phase === 'idle' ? 'No run yet.' : '(no output)'}
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

/** The compact summary of the last run: when, how it ended, how long, where. */
function LastRun({ finished, cwd }: { finished: Finished | null; cwd: string }) {
  return (
    <div className="script-run-summary muted">
      {finished === null ? (
        <div>no run yet</div>
      ) : (
        <div>
          last run <span className="script-run-at">{formatClock(finished.at)}</span>
          {' · '}
          {finished.code === null ? (
            <span className="script-exit-fail">{finished.note}</span>
          ) : (
            <span className={finished.code === 0 ? 'script-exit-ok' : 'script-exit-fail'}>
              exit {finished.code}
            </span>
          )}
          {` · ${formatDuration(finished.durationMs)}`}
          {finished.truncated && (
            <span className="script-truncated"> · truncated at 64 KiB</span>
          )}
        </div>
      )}
      <div className="script-run-cwd">cwd {cwd}</div>
    </div>
  )
}
