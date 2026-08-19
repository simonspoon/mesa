import { useState } from 'react'
import {
  createScript,
  deleteScript,
  listProjects,
  listScripts,
  updateScript,
} from '../api'
import { useLiveContext } from '../liveContext'
import { CodeEditor } from '../components/CodeEditor'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { ScriptRunModal } from '../components/ScriptRunModal'
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
import type { Project } from '../types/Project'
import type { Script } from '../types/Script'
import { useFetch } from '../useFetch'

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
          {/* No project = no folder to run in, so the run's cwd is $HOME. */}
          <option value="">$HOME (no project)</option>
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
 * Authoring is loopback-only server-side in both serve modes: a script body is
 * a program mesa will execute, so a LAN peer may *run* one but never choose
 * what runs. A 403 from a save is that gate, not a bug (docs/scripts.md).
 */
export function ScriptsView() {
  const { data: scripts, error, refetch } = useFetch(() => listScripts(), 'scripts')
  // For the project picker: the run cwd comes from the chosen project's
  // `local_path`, resolved server-side and never sent from here.
  const { data: projects } = useFetch(() => listProjects(), 'scripts-projects')

  // `null` = no form open; `'new'` = the create form; a number = editing that
  // script. One at a time, which is why this is one field and not a set.
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [running, setRunning] = useState<Script | null>(null)

  // What the person is looking at (mesa task 888). A run wins over an open
  // edit form: it is the modal on top, and it is the one the conversation is
  // about while it is up. The create form has no script to name yet, so it
  // reports the form itself.
  const focused =
    running ??
    (typeof editing === 'number'
      ? (scripts?.find((s) => s.id === editing) ?? null)
      : null)
  useLiveContext({
    kind: 'scripts',
    id: focused === null ? null : String(focused.id),
    label: focused !== null ? focused.name : editing === 'new' ? 'new script' : null,
    detail: running !== null ? 'running' : null,
  })

  return (
    <div className="scripts-page">
      <h1>Scripts</h1>
      <p className="muted">
        Shell scripts you author here and run from a generated form. Each
        declares its own arguments; a script bound to a project runs in that
        project&apos;s folder, an unbound one in your home directory.
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
                <span className="muted script-meta">
                  {s.project_id === null
                    ? '$HOME'
                    : (projects?.find((p) => p.id === s.project_id)?.name ??
                      `project ${s.project_id}`)}
                  {s.args.length > 0 && ` · ${s.args.length} arg(s)`}
                </span>
              </div>
              {s.description !== null && (
                <p className="script-description">{s.description}</p>
              )}
              <div className="script-actions">
                <button type="button" onClick={() => setRunning(s)}>
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
                  onDelete={() => deleteScript(s.id).then(refetch)}
                />
              </div>
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

      {running !== null && (
        <ScriptRunModal script={running} onClose={() => setRunning(null)} />
      )}
    </div>
  )
}
