import { useState } from 'react'
import {
  assignInboxItem,
  createInboxItem,
  deleteInboxItem,
  listInbox,
  listProjects,
} from '../api'
import { getAuthor, setAuthor } from '../author'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { Markdown } from '../components/Markdown'
import { useFetch } from '../useFetch'

/**
 * The global inbox: free-text update requests agents send without a project. It
 * lives above projects in the nav — a person triages each item by assigning it
 * to the project it belongs to (or deleting it). Assignment is the only routing
 * for now; nothing is inferred from the text. Live-syncs, since agents write the
 * DB underneath us (the CLI's `inbox add`).
 */
export function InboxView() {
  const { data: items, error, refetch } = useFetch(() => listInbox(), 'inbox', {
    pollMs: 3000,
  })
  // Projects for the assignment dropdown; refreshed less often than the inbox.
  const { data: projects } = useFetch(() => listProjects(), 'inbox-projects', {
    pollMs: 10000,
  })

  const [body, setBody] = useState('')
  const [author, setAuthorState] = useState(getAuthor())
  const [createError, setCreateError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setAuthor(author)
    createInboxItem({ body, author: author === '' ? undefined : author }).then(
      () => {
        setBody('')
        setCreateError(null)
        refetch()
      },
      (err: unknown) =>
        setCreateError(err instanceof Error ? err.message : String(err)),
    )
  }

  // Assigning converts the item into a todo task in the chosen project and
  // removes it from the inbox, so we just refetch (the item drops off the list).
  function assign(id: number, value: string) {
    if (value === '') return
    assignInboxItem(id, Number(value)).then(refetch)
  }

  return (
    <div className="inbox-page">
      <h1>Inbox</h1>
      <p className="muted">
        Update requests agents send to the shared inbox. Assign each to a project
        to turn it into a todo task there.
      </p>

      <form className="create-form" onSubmit={submit}>
        <textarea
          value={body}
          placeholder="add an update request…"
          required
          rows={2}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="inbox-create-meta">
          <input
            type="text"
            value={author}
            placeholder="you"
            title="your name — stamped on what you send"
            onChange={(e) => setAuthorState(e.target.value)}
          />
          <button type="submit">add</button>
        </div>
        {createError && <span className="error">{createError}</span>}
      </form>

      {error ? (
        <p className="error">{error}</p>
      ) : !items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">Inbox is empty.</p>
      ) : (
        <ul className="card-list inbox-list">
          {items.map((item) => (
            <li key={item.id} className="inbox-item">
              <div className="inbox-body">
                <Markdown text={item.body} />
              </div>
              <div className="muted storyboard-meta">
                {item.author && <span>from {item.author} · </span>}
                <span>sent {item.created_at}</span>
              </div>
              <div className="inbox-actions">
                <label>
                  Assign to{' '}
                  <select
                    value=""
                    onChange={(e) => assign(item.id, e.target.value)}
                  >
                    <option value="">— pick a project —</option>
                    {projects?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <ConfirmDelete
                  label="delete"
                  message="Delete this item?"
                  onDelete={() => deleteInboxItem(item.id).then(refetch)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
