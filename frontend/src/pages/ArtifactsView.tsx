import { useState } from 'react'
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listTasks,
  updateArtifact,
  artifactRenderUrl,
} from '../api'
import {
  CONTENT_TYPES,
  createPayload,
  draftError,
  draftFrom,
  emptyDraft,
  isDirty,
  isSavable,
  patchPayload,
  renderKindFor,
  type ArtifactDraft,
} from '../artifactDraft'
import { CodeEditor } from '../components/CodeEditor'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { Markdown } from '../components/Markdown'
import { useLiveContext } from '../liveContext'
import type { Artifact } from '../types/Artifact'
import type { ArtifactSummary } from '../types/ArtifactSummary'
import type { TaskSummary } from '../types/TaskSummary'
import { useFetch } from '../useFetch'

/** `CodeEditor`'s syntax-highlight language for the editable body, keyed off
 * the same three-value allowlist `artifactDraft.ts::CONTENT_TYPES` closes
 * over — `FilesView.tsx`'s own extension→language map (`md`/`html`/`svg`)
 * used verbatim. */
function languageFor(contentType: string): string {
  switch (contentType) {
    case 'text/markdown':
      return 'markdown'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'html'
  }
}

/**
 * The markdown branch of the preview — the one render kind that needs the
 * artifact's `body`, which the list summary does not carry (`api.ts`:
 * `listArtifacts` returns `ArtifactSummary[]`, bodyless). Fetched on its own,
 * keyed by artifact id, mirroring `GitView.tsx`'s `DiffPane`: the list is one
 * fetch, the selected detail is another.
 */
function ArtifactMarkdownPreview({ artifactId }: { artifactId: number }) {
  const { data, error } = useFetch(
    () => getArtifact(artifactId),
    `artifact-body-${artifactId}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return (
    <div className="artifact-markdown-preview">
      <Markdown text={data.body} />
    </div>
  )
}

/**
 * The rendered artifact itself — the load-bearing branch (spec §5).
 *
 * `text/html` and `image/svg+xml` need no fetch at all: the `<iframe>` loads
 * the render route by URL, and the route itself streams the body server-side
 * — the browser never needs it here. `text/markdown` is the one kind that
 * does, since `<Markdown>` renders text mesa already has to have fetched
 * (`ArtifactMarkdownPreview` above). Deciding this on the `ArtifactSummary`
 * alone (no full `Artifact` needed for the iframe path) is what keeps the
 * common case a zero-request switch to a different artifact.
 *
 * The `sandbox="allow-scripts"` attribute is a SECOND, INDEPENDENT layer of
 * defense on top of the render route's own CSP header
 * (`Content-Security-Policy: … sandbox allow-scripts`,
 * .scratch/artifacts-spec.md §4): the header is what protects a direct
 * navigation to the URL, the attribute is what protects this framed case
 * even if the header ever regressed. Both must hold, always. Never add
 * `allow-same-origin` here — that would hand the framed document mesa's own
 * origin, letting a script inside it read mesa's cookies/storage and call
 * mesa's own API routes (the terminal and agents routes included). Never use
 * `srcDoc` or `dangerouslySetInnerHTML` — the whole point is that the body
 * is fetched and rendered by the browser as a document at an opaque origin,
 * never injected into mesa's own DOM.
 */
function ArtifactPreview({
  projectId,
  artifact,
}: {
  projectId: number
  artifact: ArtifactSummary
}) {
  if (renderKindFor(artifact.content_type) === 'markdown') {
    return <ArtifactMarkdownPreview artifactId={artifact.id} />
  }
  return (
    <iframe
      className="artifact-preview-frame"
      title={artifact.name}
      src={artifactRenderUrl(projectId, artifact.id)}
      sandbox="allow-scripts"
    />
  )
}

/** The create/edit form. Mounted fresh per artifact (a `key` on the caller),
 * so the draft state is seeded once from the record and never has to
 * re-sync (`scriptDraft.ts`'s `ScriptForm` pattern). Always takes the full
 * `Artifact` — editing a body needs the body, whichever content type it is —
 * never an `ArtifactSummary`. */
function ArtifactForm({
  projectId,
  artifact,
  tasks,
  onClose,
  onSaved,
}: {
  projectId: number
  artifact: Artifact | null
  tasks: TaskSummary[]
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const [draft, setDraft] = useState<ArtifactDraft>(() =>
    artifact === null ? emptyDraft() : draftFrom(artifact),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const write =
      artifact === null
        ? createArtifact(projectId, createPayload(projectId, draft))
        : updateArtifact(artifact.id, patchPayload(draft))
    write.then(
      (saved) => {
        setSaving(false)
        onSaved(saved.id)
      },
      (err: unknown) => {
        setSaving(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const invalid = draftError(draft)

  return (
    <form className="panel-form artifact-form" onSubmit={submit}>
      <h2>{artifact === null ? 'New artifact' : `Edit ${artifact.name}`}</h2>
      <input
        type="text"
        value={draft.name}
        placeholder="name — unique within this project"
        required
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <div className="artifact-form-row">
        <label className="artifact-content-type-picker">
          Content type{' '}
          <select
            value={draft.contentType}
            onChange={(e) => setDraft({ ...draft, contentType: e.target.value })}
          >
            {CONTENT_TYPES.map((ct) => (
              <option key={ct} value={ct}>
                {ct}
              </option>
            ))}
          </select>
        </label>
        <label className="artifact-task-picker">
          Task{' '}
          <select
            value={draft.taskId}
            onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}
          >
            <option value="">(none)</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="artifact-body-editor">
        <CodeEditor
          value={draft.body}
          language={languageFor(draft.contentType)}
          autoFocus={false}
          onChange={(body) => setDraft({ ...draft, body })}
        />
      </div>

      <div className="inline-edit-actions">
        <button
          type="submit"
          disabled={saving || !isSavable(draft) || !isDirty(artifact, draft)}
        >
          {saving ? 'saving…' : artifact === null ? 'create' : 'save'}
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

/** Fetches the full record for an existing artifact and hands it to
 * `ArtifactForm` — editing needs the body, which `ArtifactSummary` (the list
 * shape) does not carry. Keyed by artifact id so switching which artifact is
 * being edited starts a fresh fetch rather than reusing a stale one. */
function ArtifactEditor({
  projectId,
  artifactId,
  tasks,
  onClose,
  onSaved,
}: {
  projectId: number
  artifactId: number
  tasks: TaskSummary[]
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const { data, error } = useFetch(
    () => getArtifact(artifactId),
    `artifact-edit-${artifactId}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return (
    <ArtifactForm
      projectId={projectId}
      artifact={data}
      tasks={tasks}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

/**
 * The Artifacts tab (mesa task 974): agent-written pages scoped to this
 * project — a list on the left, the selected one rendered on the right,
 * sandboxed. Unrelated to a task's own `artifact` field (a bounded pointer
 * string a task carries at close-out) — same word, two different things.
 *
 * The list is `ArtifactSummary[]` (bodyless — `api.ts::listArtifacts`); the
 * selected artifact's body, where a view actually needs it (markdown
 * preview, the edit form), is fetched separately by id, same shape as
 * `GitView`'s file-list-then-diff split.
 *
 * List on the left / detail on the right, viewport-bound like `GitView`'s
 * `.git-layout` (`App.css`'s `--tab-viewport-height`/`-min`) rather than a
 * flowing page — a rendered artifact is a whole document and deserves the
 * room.
 */
export function ArtifactsView({ projectId }: { projectId: number }) {
  const {
    data: artifacts,
    error,
    refetch,
  } = useFetch(() => listArtifacts(projectId), `artifacts-${projectId}`)
  // For the task picker: the same project-scoped task list the Board fetches,
  // by id/name only — no description needed here.
  const { data: tasks } = useFetch(
    () => listTasks({ project: projectId }),
    `artifacts-tasks-${projectId}`,
  )

  // Component state, not URL — no deep-linking a single artifact (GitView's
  // `selectedPath` pattern).
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)

  // This component is not remounted between projects (App renders
  // ProjectTasksPage at a stable position), so a stale selection would carry
  // project A's artifact into project B — reset it when the project changes,
  // during render off the changed prop (GitView's `prevProject` pattern).
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedId(null)
    setCreating(false)
    setEditing(false)
  }

  const selected: ArtifactSummary | null =
    selectedId !== null ? (artifacts?.find((a) => a.id === selectedId) ?? null) : null

  // What the person is looking at (mesa task 888) — this page always knows
  // its own focus (no delegated child view), so it calls the hook directly
  // rather than mounting a `LiveFocus`. The summary's `name` is enough; no
  // full-record fetch is needed just to report focus.
  useLiveContext({
    kind: 'artifacts',
    id: selected === null ? null : String(selected.id),
    label: selected !== null ? selected.name : creating ? 'new artifact' : null,
    detail: editing ? 'editing' : null,
  })

  function select(id: number) {
    setSelectedId(id)
    setCreating(false)
    setEditing(false)
  }

  function startCreate() {
    setSelectedId(null)
    setEditing(false)
    setCreating(true)
  }

  return (
    <div className="artifacts-view">
      <div className="artifacts-layout">
        <div className="artifacts-list-pane">
          <div className="task-actions">
            <button type="button" onClick={startCreate}>
              + new artifact
            </button>
          </div>
          {error ? (
            <p className="error">{error}</p>
          ) : !artifacts ? (
            <p className="muted">Loading…</p>
          ) : artifacts.length === 0 ? (
            <p className="muted">No artifacts yet.</p>
          ) : (
            <ul className="card-list artifacts-list">
              {artifacts.map((a) => (
                <li
                  key={a.id}
                  className={a.id === selectedId ? 'selected' : ''}
                  onClick={() => select(a.id)}
                >
                  <span className="artifacts-item-name">{a.name}</span>
                  <div className="muted artifacts-item-meta">
                    {a.content_type}
                    {a.task_id !== null &&
                      ` · ${tasks?.find((t) => t.id === a.task_id)?.name ?? `task ${a.task_id}`}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="artifacts-detail-pane">
          {creating ? (
            <ArtifactForm
              projectId={projectId}
              artifact={null}
              tasks={tasks ?? []}
              onClose={() => setCreating(false)}
              onSaved={(id) => {
                setCreating(false)
                refetch()
                select(id)
              }}
            />
          ) : selected === null ? (
            <p className="muted">Select an artifact, or create one.</p>
          ) : editing ? (
            <ArtifactEditor
              key={selected.id}
              projectId={projectId}
              artifactId={selected.id}
              tasks={tasks ?? []}
              onClose={() => setEditing(false)}
              onSaved={(id) => {
                setEditing(false)
                refetch()
                select(id)
              }}
            />
          ) : (
            <>
              <div className="artifacts-detail-head">
                <h2 className="artifacts-detail-name">{selected.name}</h2>
                <div className="artifacts-actions">
                  <button type="button" onClick={() => setEditing(true)}>
                    edit
                  </button>
                  <ConfirmDelete
                    label="delete"
                    message="Delete this artifact?"
                    onDelete={() =>
                      deleteArtifact(selected.id).then(() => {
                        setSelectedId(null)
                        return refetch()
                      })
                    }
                  />
                </div>
              </div>
              <div className="artifacts-preview">
                <ArtifactPreview projectId={projectId} artifact={selected} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
