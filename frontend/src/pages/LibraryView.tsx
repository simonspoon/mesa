import { useRef, useState } from 'react'
import {
  applyLibrarySync,
  createLibraryItem,
  deleteLibraryItem,
  exportLibrary,
  forkLibraryItem,
  getLibrarySync,
  importLibrary,
  listLibrary,
  listLibraryVersions,
  listProjects,
  updateLibraryItem,
} from '../api'
import { CodeEditor } from '../components/CodeEditor'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { bundleFilename, parseBundle, summarizeImport } from '../libraryBundle'
import {
  LIBRARY_KINDS,
  LIBRARY_SCOPES,
  draftError,
  draftFrom,
  emptyDraft,
  isDirty,
  isSavable,
  kindLabel,
  payloadFor,
  scopeLabel,
  type LibraryDraft,
} from '../libraryDraft'
import {
  changeDatesLabel,
  defaultChoice,
  diffLineClass,
  diffMark,
  hasDiff,
  needsAttention,
  resolutionsFor,
  resultLabel,
  rowKey,
  statusExplains,
  statusLabel,
  summarize,
} from '../librarySync'
import type { LibraryItem } from '../types/LibraryItem'
import type { LibrarySyncResult } from '../types/LibrarySyncResult'
import type { LibrarySyncRow } from '../types/LibrarySyncRow'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'

/** Identifies one row in the list regardless of whether it is a stored item
 * or an unshadowed built-in (`id: null`) — the key the editing/versions
 * state is keyed by, since a plain numeric id cannot name a built-in. */
function itemKey(item: LibraryItem): string {
  return item.id !== null ? `id:${item.id}` : `builtin:${item.builtin_id}`
}

/** Prism grammar for the body editor: a hook is shell, everything else on
 * this surface — agent/skill/command/prompt bodies and a CLAUDE.md — is
 * markdown. */
function bodyLanguage(kind: LibraryItem['kind']): string {
  return kind === 'hook' ? 'sh' : 'md'
}

/** The create/edit form. Mounted fresh per item (a `key` on the caller), so
 * the draft state is seeded once and never has to re-sync mid-edit. */
function LibraryForm({
  item,
  projects,
  onClose,
  onSaved,
}: {
  item: LibraryItem | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<LibraryDraft>(() => (item === null ? emptyDraft() : draftFrom(item)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Kind/scope/project are fixed at creation (the PATCH contract only ever
  // carries name/body) — editing an *existing* row, stored or built-in, never
  // offers to change them.
  const locked = item !== null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload = payloadFor(draft)
    const write =
      item === null
        ? createLibraryItem(payload)
        : item.builtin
          ? forkLibraryItem(item.builtin_id!, payload.body)
          : updateLibraryItem(item.id!, { name: payload.name, body: payload.body })
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

  const invalid = draftError(draft)

  return (
    <form className="panel-form library-form" onSubmit={submit}>
      <h2>
        {item === null ? 'New library item' : `Edit ${item.name}`}
        {item?.builtin && <span className="library-badge">built-in</span>}
      </h2>
      {item?.builtin && (
        <p className="muted">
          Editing a built-in forks it into your own copy — mesa never touches
          this row again, even if a future built-in body changes.
        </p>
      )}

      <div className="library-form-row">
        <label>
          Kind{' '}
          <select
            value={draft.kind}
            disabled={locked}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as LibraryDraft['kind'] })
            }
          >
            {LIBRARY_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope{' '}
          <select
            value={draft.scope}
            disabled={locked}
            onChange={(e) =>
              setDraft({
                ...draft,
                scope: e.target.value as LibraryDraft['scope'],
                projectId: e.target.value === 'user' ? '' : draft.projectId,
              })
            }
          >
            {LIBRARY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {scopeLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {draft.scope === 'project' && (
          <label>
            Project{' '}
            <select
              value={draft.projectId}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
            >
              <option value="">choose a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <input
        type="text"
        value={draft.name}
        placeholder="name — half the file's path"
        required
        disabled={item?.builtin}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />

      <div className="library-body-editor">
        <CodeEditor
          value={draft.body}
          language={bodyLanguage(draft.kind)}
          autoFocus={false}
          // Every body on this surface is prose in markdown — an agent
          // definition, a skill, a CLAUDE.md — written in paragraph-long
          // lines, so scrolling sideways to read one is the wrong default
          // here even though it is the right one for a script. Fixed rather
          // than a toggle: the Files tab offers the choice because it browses
          // arbitrary repos, and this box only ever holds the one shape.
          wrap
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </div>

      <div className="inline-edit-actions">
        <button
          type="submit"
          disabled={saving || !isSavable(draft) || !isDirty(item, draft)}
        >
          {saving ? 'saving…' : item === null ? 'create' : item.builtin ? 'fork' : 'save'}
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

/** The version-history reveal for one stored item. Built-ins have no history
 * (there is no row until a fork creates one), so the caller never mounts
 * this for one. */
function LibraryVersions({ itemId }: { itemId: number }) {
  const { data: versions, error } = useFetch(
    () => listLibraryVersions(itemId),
    `library-versions-${itemId}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!versions) return <p className="muted">Loading…</p>
  if (versions.length === 0) return <p className="muted">No history yet.</p>
  return (
    <ul className="library-versions">
      {versions.map((v) => (
        <li key={v.id} className="library-version-row">
          <span className="muted">
            {v.created_at} · {v.source}
          </span>
          <pre className="library-version-body">{v.body}</pre>
        </li>
      ))}
    </ul>
  )
}

/** One resolvable row inside the Sync modal: the status badge, an explainer
 * sentence, when the two sides last changed, the diff (or the whole bodies,
 * for a one-sided row), and the mesa/disk/skip picker. */
function LibrarySyncRowView({
  rowKey: key,
  row,
  choice,
  onChoose,
}: {
  // A composite, not `row.path`: the backend scan is not guaranteed to keep
  // paths unique across rows (mesa task 919's QA), and a bare path here would
  // let two same-path rows' radios interfere with each other (native HTML
  // radio grouping is keyed by `name` alone).
  rowKey: string
  row: LibrarySyncRow
  choice: 'mesa' | 'disk' | 'skip'
  onChoose: (choice: 'mesa' | 'disk' | 'skip') => void
}) {
  // The diff is the default view for a row that has one; the whole bodies
  // stay one click away, since a diff hides the lines both sides agree on and
  // sometimes the agreement is what needs reading.
  const [showBodies, setShowBodies] = useState(false)
  const dates = changeDatesLabel(row)
  const diff = hasDiff(row) ? row.diff : null
  return (
    <li className="library-sync-row">
      <div className="library-sync-row-head">
        <span className="library-sync-path">{row.path}</span>
        <span className={`library-sync-status library-sync-status-${row.status}`}>
          {statusLabel(row.status)}
        </span>
      </div>
      <p className="muted">{statusExplains(row.status)}</p>
      {dates !== null && <p className="library-sync-dates muted">{dates}</p>}
      {diff !== null && (
        <button
          type="button"
          className="library-sync-view-toggle"
          onClick={() => setShowBodies((v) => !v)}
        >
          {showBodies ? 'show diff' : 'show both bodies'}
        </button>
      )}
      {diff !== null && !showBodies ? (
        <pre className="library-sync-difflines">
          {diff.map((line, i) => (
            <div key={i} className={diffLineClass(line)}>
              <span className="library-diff-mark">{diffMark(line)}</span>
              {line.text}
            </div>
          ))}
        </pre>
      ) : (
        <div className="library-sync-diff">
          <div className="library-sync-side">
            <h4>mesa</h4>
            <pre>{row.mesa_body ?? '(not in mesa)'}</pre>
          </div>
          <div className="library-sync-side">
            <h4>disk</h4>
            <pre>{row.disk_body ?? '(no file)'}</pre>
          </div>
        </div>
      )}
      <div className="library-sync-choice">
        {(['mesa', 'disk', 'skip'] as const).map((c) => (
          <label key={c}>
            <input
              type="radio"
              name={`sync-${key}`}
              checked={choice === c}
              onChange={() => onChoose(c)}
            />
            {c}
          </label>
        ))}
      </div>
    </li>
  )
}

/** The Sync modal: a per-project scope picker, the scan, and the batch
 * apply. No automatic merging anywhere — every row that needs one gets an
 * explicit mesa/disk/skip pick before Apply is enabled. */
function LibrarySyncModal({
  projects,
  onClose,
  onApplied,
}: {
  projects: Project[]
  onClose: () => void
  onApplied: () => void
}) {
  const [projectId, setProjectId] = useState('')
  const {
    data: rows,
    error,
    refetch,
  } = useFetch(
    () => getLibrarySync(projectId === '' ? undefined : Number(projectId)),
    `library-sync-${projectId}`,
  )
  const [choices, setChoices] = useState<Record<string, 'mesa' | 'disk' | 'skip'>>({})
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<LibrarySyncResult[] | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)

  const attention = (rows ?? []).filter(needsAttention)
  const counts = summarize(rows ?? [])

  function apply() {
    if (rows === null) return
    setApplying(true)
    setApplyError(null)
    applyLibrarySync(projectId === '' ? null : Number(projectId), resolutionsFor(rows, choices))
      .then((res) => {
        setApplying(false)
        setResults(res)
        setChoices({})
        refetch()
        onApplied()
      })
      .catch((err: unknown) => {
        setApplying(false)
        setApplyError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <div className="create-task-backdrop" onClick={onClose}>
      <div
        className="create-task-modal library-sync-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>Sync library</h2>
          <button type="button" onClick={onClose}>
            close
          </button>
        </div>

        <label className="library-sync-project-picker">
          Project{' '}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">user-scoped only</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {error ? (
          <p className="error">{error}</p>
        ) : !rows ? (
          <p className="muted">Scanning…</p>
        ) : attention.length === 0 ? (
          <p className="muted">Everything is in sync ({counts['in-sync']} file(s)).</p>
        ) : (
          <>
            <p className="muted">
              {attention.length} file(s) need a decision, {counts['in-sync']} already in sync.
            </p>
            <ul className="library-sync-list">
              {attention.map((row, i) => (
                <LibrarySyncRowView
                  key={rowKey(row, i)}
                  rowKey={rowKey(row, i)}
                  row={row}
                  choice={choices[row.path] ?? defaultChoice(row)}
                  onChoose={(choice) => setChoices({ ...choices, [row.path]: choice })}
                />
              ))}
            </ul>
            <div className="inline-edit-actions">
              <button type="button" disabled={applying} onClick={apply}>
                {applying ? 'applying…' : 'apply'}
              </button>
            </div>
          </>
        )}
        {applyError !== null && <span className="error">{applyError}</span>}
        {results !== null && (
          <ul className="library-sync-results">
            {results.map((r, i) => (
              <li key={`${r.path}-${i}`} className={r.error !== null ? 'error' : ''}>
                {r.path}: {r.choice} — {resultLabel(r)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * The Library page: agents, skills, hooks, commands, prompts and CLAUDE.md
 * files, stored in mesa and synced against `.claude` file by file (mesa task
 * 919). Global like Scripts — a project-scoped item binds a project, but the
 * page itself lives above projects.
 */
export function LibraryView() {
  const { data: items, error, refetch } = useFetch(() => listLibrary(), 'library')
  const { data: projects } = useFetch(() => listProjects(), 'library-projects')

  // `null` = no form open; `'new'` = the create form; a string = editing that
  // item (`itemKey`, since a built-in has no numeric id).
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [showingVersions, setShowingVersions] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  // Export/import (mesa task 963). The page itself is unscoped (there is no
  // page-level project picker — `listLibrary()` above already reads only
  // user-scope rows plus built-ins), so export follows suit and never sends
  // `?project=`.
  const [onConflict, setOnConflict] = useState<'skip' | 'replace'>('skip')
  const [importing, setImporting] = useState(false)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  function handleExport() {
    setBundleError(null)
    exportLibrary().then(
      (bundle) => {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = bundleFilename(new Date())
        a.click()
        URL.revokeObjectURL(url)
      },
      (err: unknown) => setBundleError(err instanceof Error ? err.message : String(err)),
    )
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (file === null) return
    setBundleError(null)
    setImportSummary(null)
    setImporting(true)
    file.text().then((text) => {
      const parsed = parseBundle(text)
      if ('error' in parsed) {
        setImporting(false)
        setBundleError(parsed.error)
        return
      }
      importLibrary(parsed.bundle, onConflict).then(
        (results) => {
          setImporting(false)
          setImportSummary(summarizeImport(results))
          refetch()
        },
        (err: unknown) => {
          setImporting(false)
          setBundleError(err instanceof Error ? err.message : String(err))
        },
      )
    })
  }

  const grouped = LIBRARY_KINDS.map((kind) => ({
    kind,
    items: (items ?? []).filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="library-page">
      <h1>Library</h1>
      <p className="muted">
        Agents, skills, hooks, commands, prompts and CLAUDE.md files, stored
        here and synced against your <code>.claude</code> directory file by
        file. mesa never merges automatically — a sync always shows both
        sides and asks you to pick.
      </p>

      <div className="task-actions">
        <button type="button" onClick={() => setEditing('new')}>
          + new item
        </button>
        <button type="button" onClick={() => setSyncing(true)}>
          sync
        </button>
        <button type="button" onClick={handleExport}>
          export
        </button>
        <select
          value={onConflict}
          onChange={(e) => setOnConflict(e.target.value as 'skip' | 'replace')}
        >
          <option value="skip">on conflict: skip</option>
          <option value="replace">on conflict: replace</option>
        </select>
        <button
          type="button"
          disabled={importing}
          onClick={() => importInputRef.current?.click()}
        >
          {importing ? 'importing…' : 'import'}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          hidden
          onChange={handleImportFile}
        />
      </div>

      {bundleError !== null && <p className="error">{bundleError}</p>}
      {importSummary !== null && <p className="muted">{importSummary}</p>}

      {editing === 'new' && (
        <LibraryForm
          item={null}
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
      ) : !items ? (
        <p className="muted">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="muted">No library items yet.</p>
      ) : (
        grouped.map((g) => (
          <section key={g.kind} className="library-group">
            <h2 className="library-group-title">{kindLabel(g.kind)}</h2>
            <ul className="card-list library-list">
              {g.items.map((item) => {
                const key = itemKey(item)
                return (
                  <li key={key} className="library-item">
                    <div className="library-item-head">
                      <span className="library-name">{item.name}</span>
                      <span className="muted library-meta">
                        {scopeLabel(item.scope)}
                        {item.scope === 'project' &&
                          item.project_id !== null &&
                          ` · ${projects?.find((p) => p.id === item.project_id)?.name ?? `project ${item.project_id}`}`}
                        {item.path !== null && ` · ${item.path}`}
                      </span>
                      {item.builtin && <span className="library-badge">built-in</span>}
                    </div>
                    <div className="library-actions">
                      <button
                        type="button"
                        onClick={() => setEditing(editing === key ? null : key)}
                      >
                        {editing === key ? 'close' : 'edit'}
                      </button>
                      {item.id !== null && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setShowingVersions(showingVersions === key ? null : key)
                            }
                          >
                            {showingVersions === key ? 'hide history' : 'history'}
                          </button>
                          <ConfirmDelete
                            label="delete"
                            message={
                              item.builtin_id !== null
                                ? 'Delete this fork? The built-in reappears unshadowed.'
                                : 'Delete this library item?'
                            }
                            onDelete={() => deleteLibraryItem(item.id!).then(refetch)}
                          />
                        </>
                      )}
                    </div>
                    {editing === key && (
                      <LibraryForm
                        key={item.updated_at ?? 'builtin'}
                        item={item}
                        projects={projects ?? []}
                        onClose={() => setEditing(null)}
                        onSaved={() => {
                          setEditing(null)
                          refetch()
                        }}
                      />
                    )}
                    {showingVersions === key && item.id !== null && (
                      <LibraryVersions itemId={item.id} />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}

      {syncing && (
        <LibrarySyncModal
          projects={projects ?? []}
          onClose={() => setSyncing(false)}
          onApplied={refetch}
        />
      )}
    </div>
  )
}
