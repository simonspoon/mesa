import { useEffect, useState } from 'react'
import {
  createScript,
  deleteScript,
  listProjects,
  listScriptRuns,
  listScripts,
  updateScript,
} from '../api'
import { useLiveContext } from '../liveContext'
import { CodeEditor } from '../components/CodeEditor'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { ScriptRunPane } from '../components/ScriptRunPane'
import {
  ARG_KINDS,
  argError,
  emptyArg,
  isDirty,
  isSavable,
  scriptDraftError,
  scriptDraftFrom,
  scriptPayload,
  type ArgDraft,
  type ScriptDraft,
} from '../scriptDraft'
import { activeRun, formatRunLabel, runState, runsForScript } from '../scriptRun'
import type { Project } from '../types/Project'
import type { Script } from '../types/Script'
import { useFetch } from '../useFetch'

/** How many of a script's runs the list offers to reopen. The server keeps
 * twenty per script; a row shows the handful anyone reaches for. */
const RUNS_SHOWN = 5

/** The hash that *is* a run: a real address, so a reload, a back button and a
 * copied link all land on the same screen (mesa task 1224). */
function runHref(runId: number): string {
  return `#/scripts/runs/${runId}`
}

/** Where a script runs, for display only — the server resolves the real one
 * from the binding and never takes it from here. */
function cwdFor(script: Script, projects: Project[]): string {
  if (script.project_id === null) return '~/.mesa/workspace'
  const project = projects.find((p) => p.id === script.project_id)
  return project?.local_path ?? `project ${script.project_id} (no folder)`
}

/** One row of the declared-argument editor. The name is the load-bearing
 * field — it becomes both a positional (`$1`, `$2`, … in declared order) and
 * an `MESA_ARG_*` variable, which is why its charset is constrained and why
 * reordering rows changes what the body's `$n` mean. */
function ArgRow({
  arg,
  onChange,
  onRemove,
}: {
  arg: ArgDraft
  onChange: (next: ArgDraft) => void
  onRemove: () => void
}) {
  const error = argError(arg)
  return (
    <li className="script-arg-row">
      <div className="script-arg-fields">
        <input
          type="text"
          value={arg.name}
          placeholder="name"
          onChange={(e) => onChange({ ...arg, name: e.target.value })}
        />
        <select
          value={arg.kind}
          onChange={(e) =>
            onChange({ ...arg, kind: e.target.value as ArgDraft['kind'] })
          }
        >
          {ARG_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={arg.label}
          placeholder="label (optional)"
          onChange={(e) => onChange({ ...arg, label: e.target.value })}
        />
        <input
          type="text"
          value={arg.default}
          placeholder="default (optional)"
          onChange={(e) => onChange({ ...arg, default: e.target.value })}
        />
        {arg.kind === 'choice' && (
          <input
            type="text"
            value={arg.choices}
            placeholder="choices, comma-separated"
            onChange={(e) => onChange({ ...arg, choices: e.target.value })}
          />
        )}
        <label className="script-arg-required-box">
          <input
            type="checkbox"
            checked={arg.required}
            onChange={(e) => onChange({ ...arg, required: e.target.checked })}
          />
          required
        </label>
        <button type="button" onClick={onRemove}>
          remove
        </button>
      </div>
      {error !== null && <span className="error">{error}</span>}
    </li>
  )
}

/** The create/edit form. Mounted fresh per script (a `key` on the caller), so
 * the draft state is seeded once from the record and never has to re-sync. */
function ScriptForm({
  script,
  projects,
  onClose,
  onSaved,
}: {
  script: Script | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<ScriptDraft>(() => scriptDraftFrom(script))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload = scriptPayload(draft)
    const write =
      script === null ? createScript(payload) : updateScript(script.id, payload)
    write.then(
      () => {
        setSaving(false)
        onSaved()
      },
      (err: unknown) => {
        setSaving(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const invalid = scriptDraftError(draft)

  return (
    <form className="panel-form script-form" onSubmit={submit}>
      <h2>{script === null ? 'New script' : `Edit ${script.name}`}</h2>
      <input
        type="text"
        value={draft.name}
        placeholder="name — unique, and how the CLI resolves it"
        required
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        type="text"
        value={draft.description}
        placeholder="what it does (optional)"
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <label className="script-project-picker">
        Runs in{' '}
        <select
          value={draft.projectId}
          onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
        >
          {/* No project = no folder to run in, so the run's cwd is the
              workspace folder mesa owns (see docs/scripts.md). */}
          <option value="">~/.mesa/workspace (no project)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <div className="script-body-editor">
        <p className="muted">
          Shell source, handed to <code>bash -c</code> verbatim. Arguments arrive
          as <code>&quot;$1&quot;</code>, <code>&quot;$2&quot;</code>, … in the order declared below,
          and as <code>&quot;$MESA_ARG_NAME&quot;</code>. Values are never spliced into
          this text.
        </p>
        <CodeEditor
          value={draft.body}
          language="sh"
          autoFocus={false}
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </div>

      <div className="script-args-editor">
        <h3>Arguments</h3>
        {draft.args.length === 0 ? (
          <p className="muted">
            No arguments — the run form will just be a run button.
          </p>
        ) : (
          <ul className="card-list">
            {draft.args.map((arg, i) => (
              <ArgRow
                key={i}
                arg={arg}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    args: draft.args.map((a, j) => (j === i ? next : a)),
                  })
                }
                onRemove={() =>
                  setDraft({ ...draft, args: draft.args.filter((_, j) => j !== i) })
                }
              />
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setDraft({ ...draft, args: [...draft.args, emptyArg()] })}
        >
          + argument
        </button>
      </div>

      <div className="inline-edit-actions">
        <button
          type="submit"
          disabled={saving || !isSavable(draft) || !isDirty(script, draft)}
        >
          {saving ? 'saving…' : script === null ? 'create' : 'save'}
        </button>
        <button type="button" onClick={onClose}>
          cancel
        </button>
      </div>
      {invalid !== null && <span className="error">{invalid}</span>}
      {error !== null && <span className="error">{error}</span>}
    </form>
  )
}

/**
 * The Scripts page: the user's stored shell scripts, each with the typed
 * argument list its run form is generated from.
 *
 * Global like the Inbox — a script may bind a project (that project's
 * `local_path` becomes the run's working directory) but does not have to, so
 * the page lives above projects rather than as a project tab.
 *
 * Authoring carries the server's `require_agent_access` gate, the same one the
 * reads and the run carry (mesa task 1022): a script body is a program mesa
 * will execute, and `--lan` already hands the network the shell. A 403 from a
 * save is that gate refusing a rebound or cross-site page, not a bug
 * (docs/scripts.md).
 */
export function ScriptsView({ runId }: { runId: number | null }) {
  const { data: scripts, error, refetch } = useFetch(() => listScripts(), 'scripts')
  // For the project picker: the run cwd comes from the chosen project's
  // `local_path`, resolved server-side and never sent from here.
  const { data: projects } = useFetch(() => listProjects(), 'scripts-projects')
  // The stored runs (mesa task 1224), polled so a run started in another tab
  // — or one that has just ended — shows up without a refocus. Polled
  // unconditionally: gating the interval on "is anything running" would need
  // the answer before the fetch that provides it. `useFetch` drops a poll
  // whose result is byte-identical, so an idle page never re-renders.
  const { data: runs, refetch: refetchRuns } = useFetch(
    () => listScriptRuns(),
    'script-runs',
    { pollMs: 2000 },
  )

  // `null` = no form open; `'new'` = the create form; a number = editing that
  // script. One at a time, which is why this is one field and not a set.
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  // The script whose run *form* is open with no run started yet. The run
  // itself is the hash's (`runId`); this is only the step before there is one
  // to address.
  const [opening, setOpening] = useState<Script | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const allRuns = runs ?? []
  const anyRunning = allRuns.some((r) => r.status === 'running')
  // The live clocks on the run buttons, and only while one is live.
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  // The run the hash names, and the script whose pane is therefore the page.
  // A run row names its own script, so the address carries only the run — but
  // the run *just* started is not in the polled list yet, and the script it
  // was started from is the same answer, so `opening` is the fallback rather
  // than a frame of "no such run".
  const openRun = runId === null ? null : (allRuns.find((r) => r.id === runId) ?? null)
  const openScript =
    openRun !== null
      ? (scripts?.find((s) => s.id === openRun.script_id) ?? null)
      : opening

  // What the person is looking at (mesa task 888). A run wins over an open
  // edit form: its pane replaces the list, and it is the one the conversation
  // is about while it is up. The create form has no script to name yet, so it
  // reports the form itself.
  const focused =
    openScript ??
    (typeof editing === 'number'
      ? (scripts?.find((s) => s.id === editing) ?? null)
      : null)
  useLiveContext({
    kind: 'scripts',
    id: focused === null ? null : String(focused.id),
    label: focused !== null ? focused.name : editing === 'new' ? 'new script' : null,
    detail: runId !== null ? `run ${runId}` : openScript !== null ? 'run form' : null,
  })

  function closeRun() {
    setOpening(null)
    if (runId !== null) window.location.hash = '#/scripts'
  }

  if (openScript !== null) {
    // The run pane is the page while it is open (mesa task 1196): no modal,
    // no dimming. The cwd is shown, never sent — the server resolves it, and
    // a run that already happened reports the one it used.
    return (
      <div className="scripts-page">
        <ScriptRunPane
          // Keyed on the script, not the run: starting a run re-attaches the
          // pane rather than remounting it, so the split the person dragged
          // and the form they folded away survive the press.
          key={openScript.id}
          script={openScript}
          cwd={cwdFor(openScript, projects ?? [])}
          runId={runId}
          onRunStarted={(id) => {
            window.location.hash = runHref(id)
            refetchRuns()
          }}
          onClose={closeRun}
        />
      </div>
    )
  }

  if (runId !== null && runs !== null && scripts !== null) {
    // The hash names a run nothing knows about: pruned by the 20-per-script
    // retention, or a hand-typed id. Say so rather than showing a blank page.
    return (
      <div className="scripts-page">
        <p className="error">No run {runId}.</p>
        <button type="button" onClick={closeRun}>
          ← scripts
        </button>
      </div>
    )
  }

  if (runId !== null) return <p className="muted">Loading…</p>

  return (
    <div className="scripts-page">
      <h1>Scripts</h1>
      <p className="muted">
        Shell scripts you author here and run from a generated form. Each
        declares its own arguments; a script bound to a project runs in that
        project&apos;s folder, an unbound one in <code>~/.mesa/workspace</code>.
      </p>

      <div className="task-actions">
        <button type="button" onClick={() => setEditing('new')}>
          + new script
        </button>
      </div>

      {editing === 'new' && (
        <ScriptForm
          script={null}
          projects={projects ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refetch()
          }}
        />
      )}

      {error ? (
        <p className="error">{error}</p>
      ) : !scripts ? (
        <p className="muted">Loading…</p>
      ) : scripts.length === 0 ? (
        <p className="muted">No scripts yet.</p>
      ) : (
        <ul className="card-list script-list">
          {scripts.map((s) => (
            <li key={s.id} className="script-item">
              <div className="script-item-head">
                <span className="script-name">{s.name}</span>
                {activeRun(allRuns, s.id) !== null && (
                  <span className="script-run-state script-run-state-running">
                    ● running
                  </span>
                )}
                <span className="muted script-meta">
                  {s.project_id === null
                    ? 'workspace'
                    : (projects?.find((p) => p.id === s.project_id)?.name ??
                      `project ${s.project_id}`)}
                  {s.args.length > 0 && ` · ${s.args.length} arg(s)`}
                </span>
              </div>
              {s.description !== null && (
                <p className="script-description">{s.description}</p>
              )}
              <div className="script-actions">
                <button type="button" onClick={() => setOpening(s)}>
                  run
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(editing === s.id ? null : s.id)}
                >
                  {editing === s.id ? 'close' : 'edit'}
                </button>
                <ConfirmDelete
                  label="delete"
                  message="Delete this script?"
                  onDelete={() =>
                    deleteScript(s.id)
                      .then(refetch)
                      // A script's runs go with it (the FK cascades), so the
                      // list they were showing in has to be re-read too.
                      .then(refetchRuns)
                  }
                />
              </div>
              {runsForScript(allRuns, s.id, RUNS_SHOWN).length > 0 && (
                <ul className="script-run-history">
                  {runsForScript(allRuns, s.id, RUNS_SHOWN).map((r) => (
                    <li key={r.id}>
                      {/* A link, not a button: a run is an address, so it
                          opens in a new tab and copies like any other. */}
                      <a
                        className={`script-run-chip script-run-state-${runState(r)}`}
                        href={runHref(r.id)}
                      >
                        {formatRunLabel(r, now)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {editing === s.id && (
                <ScriptForm
                  key={s.updated_at}
                  script={s}
                  projects={projects ?? []}
                  onClose={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null)
                    refetch()
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
