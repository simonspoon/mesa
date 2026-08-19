import { useState } from 'react'
import type { Project } from '../types/Project'
import { archiveProject, listProjects, unarchiveProject, updateProject } from '../api'
import { DirBrowser } from '../components/DirBrowser'
import { useLiveContext } from '../liveContext'
import { descendantIds } from '../projectTree'
import { useFetch } from '../useFetch'

/**
 * The project page's Settings tab (mesa task 682): the three whole-project
 * controls that used to render as a footer under *every* tab, plus the
 * project folder, which previously had no web UI at all.
 *
 * URL-driven like Git/Files/Terminal (#/projects/:id/settings), and takes the
 * already-loaded `project` from `ProjectTasksPage` rather than re-fetching it
 * — one `getProject` drives both the page header and this view.
 *
 * Each section owns its own in-flight flag and its own error slot: both the
 * `local_path` PATCH and the `/api/fs/dirs` listing behind `DirBrowser` are
 * loopback-gated in *both* serve modes, so over `--lan` they 403 with
 * "local_path is an agent execution anchor; …". That message is shown as-is;
 * there is deliberately no client-side pre-check for it.
 */
export function ProjectSettingsView({
  projectId,
  project,
  refetchProject,
  onProjectsChanged,
}: {
  projectId: number
  project: Project
  refetchProject: () => void
  onProjectsChanged: () => void
}) {
  // Folder (local_path) — the anchor the Files/Git/Terminal/Agents surfaces
  // resolve against.
  const [browsing, setBrowsing] = useState(false)
  const [savingPath, setSavingPath] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
  // Reparenting (task 668) — an ordinary edit, its own in-flight/error pair.
  const [reparenting, setReparenting] = useState(false)
  const [parentError, setParentError] = useState<string | null>(null)
  // Archiving (task 509). One flag / one error slot covers both directions:
  // this section only ever offers whichever of archive/unarchive the project
  // isn't already in.
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  // What the person is looking at (mesa task 888): this project's own settings,
  // named by the project rather than by which section is open — the sections
  // are all one subject.
  useLiveContext({
    kind: 'settings',
    id: String(projectId),
    label: project.name,
    detail: null,
  })

  // Every project, for the parent picker. Archived ones included: nesting
  // under an archived project is legal (it just inherits being hidden), and
  // omitting them would silently drop the CURRENT parent out of the list.
  const { data: allProjects, refetch: refetchAllProjects } = useFetch(
    () => listProjects(true),
    'projects-picker',
  )

  // `null`, never `''`: ProjectUpdate.local_path is a double_option in
  // src/api.rs, so null clears the field and '' would store an empty string.
  function savePath(value: string | null) {
    setSavingPath(true)
    setPathError(null)
    updateProject(projectId, { local_path: value })
      .then(() => {
        setSavingPath(false)
        refetchProject()
        // The sidebar decorates each row with git status keyed off
        // local_path, so it has to redraw.
        onProjectsChanged()
      })
      .catch((err: unknown) => {
        setSavingPath(false)
        setPathError(err instanceof Error ? err.message : String(err))
      })
  }

  function handleArchive() {
    setArchiving(true)
    setArchiveError(null)
    archiveProject(projectId)
      .then(() => {
        onProjectsChanged()
        // The project just vanished from the default list/sidebar; land
        // somewhere still valid instead of leaving the user on a page for
        // a now-hidden project.
        window.location.hash = '#/'
      })
      .catch((e: unknown) => {
        setArchiving(false)
        setArchiveError(e instanceof Error ? e.message : String(e))
      })
  }

  // Restoring keeps the user where they are (the page was already valid while
  // archived — `show` is a scoped read, unaffected by the flag), so unlike
  // `handleArchive` there is no navigation and the in-flight flag has to be
  // cleared here. Refetching the project is what flips this section back to
  // "archive project" and drops the header badge.
  function handleUnarchive() {
    setArchiving(true)
    setArchiveError(null)
    unarchiveProject(projectId)
      .then(() => {
        setArchiving(false)
        refetchProject()
        onProjectsChanged()
      })
      .catch((e: unknown) => {
        setArchiving(false)
        setArchiveError(e instanceof Error ? e.message : String(e))
      })
  }

  return (
    <div className="project-settings">
      <section>
        <h2>Project folder</h2>
        <p className="muted settings-hint">
          The working folder the Files, Git, Terminal and Agents surfaces open
          in.
        </p>
        {browsing ? (
          <DirBrowser
            onSelect={(path) => {
              setBrowsing(false)
              savePath(path)
            }}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
          <div className="dir-picker-field">
            <span className="dir-picker-value">
              {project.local_path ?? (
                <span className="muted">no folder linked</span>
              )}
            </span>
            <button
              type="button"
              disabled={savingPath}
              onClick={() => setBrowsing(true)}
            >
              choose folder…
            </button>
            {project.local_path !== null && (
              <button
                type="button"
                disabled={savingPath}
                onClick={() => savePath(null)}
              >
                clear
              </button>
            )}
          </div>
        )}
        {pathError && <span className="error">{pathError}</span>}
      </section>

      {/* Parent project (task 668): the UI half of a field that would
          otherwise be CLI-only. Eligible parents exclude this project and
          everything under it — `Store` would answer a cycle with a 409, but
          an option that can only fail is not a choice worth offering.
          Task 669 gave the nav a drag that reparents too (drop into the
          middle of a row); this picker stays as the explicit, list-shaped
          way to do the same thing — the two write the same field. */}
      <section>
        <h2>Parent project</h2>
        {allProjects && (
          <p className="project-parent">
            <label>
              parent project{' '}
              <select
                value={project.parent_id ?? ''}
                disabled={reparenting}
                onChange={(e) => {
                  const value = e.target.value === '' ? null : Number(e.target.value)
                  setReparenting(true)
                  setParentError(null)
                  updateProject(projectId, { parent_id: value })
                    .then(() => {
                      setReparenting(false)
                      refetchProject()
                      refetchAllProjects()
                      // The nav is a tree of this field; it has to redraw.
                      onProjectsChanged()
                    })
                    .catch((err: unknown) => {
                      setReparenting(false)
                      setParentError(err instanceof Error ? err.message : String(err))
                    })
                }}
              >
                <option value="">— top level —</option>
                {allProjects
                  .filter(
                    (p) =>
                      p.id !== projectId &&
                      !descendantIds(allProjects, projectId).includes(p.id),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            {parentError && <span className="error">{parentError}</span>}
          </p>
        )}
      </section>

      {/* Retirement action, de-emphasized (spec S8): rarely used, kept
          reachable. Archiving is reversible (this same control, or the
          sidebar's archived group, restores it), so this is a plain button
          with no confirm step and no destructive copy — spec 509's Won't
          list explicitly rules out a confirmation prompt here. Deleting a
          project is still possible; it's just not offered here (CLI/API
          unchanged). */}
      <section>
        <h2>Archive</h2>
        <p className="project-danger">
          {project.archived ? (
            <button onClick={handleUnarchive} disabled={archiving}>
              unarchive project
            </button>
          ) : (
            <button onClick={handleArchive} disabled={archiving}>
              archive project
            </button>
          )}
          {archiveError && <span className="error">{archiveError}</span>}
        </p>
      </section>
    </div>
  )
}
