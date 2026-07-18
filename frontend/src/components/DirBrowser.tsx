import { useState } from 'react'
import { listFsDirs } from '../api'
import { useFetch } from '../useFetch'

// Sentinel `useFetch` key for the initial ($HOME) listing, where there is no
// concrete path yet to key on.
const HOME_KEY = '$HOME'

/**
 * Server-side directory browser for the new-project folder picker
 * (`CreateProjectPanel`). Opens at the server's `$HOME` (no `path` arg),
 * lets the user navigate into subdirectories or up one level via `parent`,
 * and hands the current path back on "use this folder". Directories only —
 * matches `GET /api/fs/dirs`'s contract (mesa task 405).
 */
export function DirBrowser({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void
  onCancel: () => void
}) {
  // undefined = still at the default $HOME listing; once the user navigates,
  // this holds the absolute path being browsed.
  const [path, setPath] = useState<string | undefined>(undefined)
  const { data: listing, error } = useFetch(
    () => listFsDirs(path),
    path ?? HOME_KEY,
  )

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
          disabled={!listing}
          onClick={() => listing && onSelect(listing.path)}
        >
          use this folder
        </button>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
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
