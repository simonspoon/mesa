import { useState } from 'react'
import { createFsDir, listFsDirs } from '../api'
import { clearLastFolder, getLastFolder, setLastFolder } from '../lastFolder'
import { useFetch } from '../useFetch'

// Sentinel `useFetch` key for the initial ($HOME) listing, where there is no
// concrete path yet to key on.
const HOME_KEY = '$HOME'

/**
 * Server-side directory browser for the new-project folder picker
 * (`CreateProjectPanel`). Opens at the folder last confirmed here, falling
 * back to the server's `$HOME` on a first visit (no `path` arg); lets the
 * user navigate into subdirectories or up one level via `parent`, create a
 * folder inside the directory currently shown, and hands the current path
 * back on "use this folder". Directories only — matches `/api/fs/dirs`'s
 * contract (mesa tasks 405, 489).
 */
export function DirBrowser({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void
  onCancel: () => void
}) {
  // undefined = the default $HOME listing; once the user navigates (or a
  // remembered folder is restored) this holds the absolute path being browsed.
  const [path, setPath] = useState<string | undefined>(getLastFolder)
  // null = the new-folder field is closed; a string is the name being typed
  // (empty included, which is why this isn't just `''`).
  const [newName, setNewName] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // A remembered folder that has since been moved or deleted 404s. Fall back
  // to $HOME and forget it, here in the loader rather than in an effect off
  // `error` (setting state in an effect body is a lint error, and the retry
  // is genuinely part of loading). `setPath` matters as much as the retry:
  // without it `path` stays stale, so the next focus refetch asks for the
  // gone folder again — and by then the key is cleared, so the guard below
  // no longer matches and the error the user never saw the first time
  // surfaces on the second.
  const { data: listing, error } = useFetch(
    () =>
      listFsDirs(path).catch((err: unknown) => {
        if (path === undefined || path !== getLastFolder()) throw err
        clearLastFolder()
        setPath(undefined)
        return listFsDirs(undefined)
      }),
    path ?? HOME_KEY,
  )

  function create() {
    if (!listing || newName === null || newName.trim() === '') return
    setCreating(true)
    setCreateError(null)
    createFsDir(listing.path, newName).then(
      (entry) => {
        setCreating(false)
        setNewName(null)
        // Navigate into the folder just made — it's almost always the one
        // being picked, and its empty listing is the confirmation.
        setPath(entry.path)
      },
      (err: unknown) => {
        setCreating(false)
        setCreateError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  function closeNewFolder() {
    setNewName(null)
    setCreateError(null)
  }

  return (
    <div className="dir-browser">
      <p className="dir-browser-path">{listing?.path ?? '…'}</p>
      <div className="dir-browser-actions">
        <button
          type="button"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setPath(listing.parent)}
        >
          ↑ up
        </button>
        <button
          type="button"
          disabled={!listing || newName !== null}
          onClick={() => {
            setCreateError(null)
            setNewName('')
          }}
        >
          new folder
        </button>
        <button
          type="button"
          disabled={!listing}
          onClick={() => {
            if (!listing) return
            setLastFolder(listing.path)
            onSelect(listing.path)
          }}
        >
          use this folder
        </button>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
      {newName !== null && (
        // Deliberately not a nested <form>: this browser renders inside
        // CreateProjectPanel's own form, and nesting forms is invalid HTML.
        // So Enter is wired by hand (and must preventDefault, or it submits
        // the project form instead) and every button stays type="button".
        <div className="dir-browser-new">
          <input
            type="text"
            value={newName}
            placeholder="folder name"
            autoFocus
            disabled={creating}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                create()
              }
              if (e.key === 'Escape') {
                // Stop here so it doesn't also reach CreateProjectModal's own
                // window-level Escape listener, which would unmount the whole
                // modal and throw away the title/description already typed —
                // same layering rule CommandPalette follows. Escape backs out
                // of the innermost thing, the name field.
                e.preventDefault()
                e.stopPropagation()
                closeNewFolder()
              }
            }}
          />
          <button
            type="button"
            disabled={creating || newName.trim() === ''}
            onClick={create}
          >
            create
          </button>
          <button type="button" disabled={creating} onClick={closeNewFolder}>
            cancel
          </button>
        </div>
      )}
      {createError && <span className="error">{createError}</span>}
      {error && <span className="error">{error}</span>}
      {!listing ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="card-list dir-browser-list">
          {listing.entries.length === 0 && (
            <li className="muted">No subfolders.</li>
          )}
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="dir-browser-entry"
                onClick={() => setPath(entry.path)}
              >
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
