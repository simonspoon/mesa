import { useState } from 'react'
import {
  assignInboxItem,
  createInboxItem,
  deleteInboxItem,
  inboxSpeakUrl,
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
  // Which item is being read aloud, and whether its audio has started yet:
  // synthesis takes seconds, so "asked for it" and "hearing it" are different
  // states the button has to distinguish. One item at a time — a single
  // <audio> element, keyed by the id, so picking another stops the first.
  const [speakingId, setSpeakingId] = useState<number | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // The failure belongs to the item whose button was pressed, so it carries the
  // id — the <audio> is gone by the time the message renders.
  const [speakError, setSpeakError] = useState<number | null>(null)

  // Stops if this item is already the one playing, starts it otherwise.
  function toggleSpeak(id: number) {
    setSpeakError(null)
    setSpeaking(false)
    setSpeakingId((current) => (current === id ? null : id))
  }

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

  // Assigning converts the item into a backlog task in the chosen project and
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
        to turn it into a backlog task there.
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
                <button
                  type="button"
                  title={
                    speakingId === item.id
                      ? 'stop reading this item'
                      : 'read this item aloud'
                  }
                  onClick={() => toggleSpeak(item.id)}
                >
                  {speakingId !== item.id
                    ? 'play'
                    : speaking
                      ? 'stop'
                      : 'synthesising…'}
                </button>
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
                {speakError === item.id && (
                  <span className="error">could not play this item</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* One player for the whole page. `key` restarts it when the selection
          changes, and unmounting it (stop, ended, error) is what stops the
          sound — the already-running synthesis on the server finishes and its
          bytes are discarded, the same no-timeout posture as hooks and
          scripts. It renders only while its item is still listed, so deleting
          or assigning the item being read stops it too: otherwise the audio
          would outlive the only button that can stop it. */}
      {items?.some((item) => item.id === speakingId) && speakingId !== null && (
        <audio
          key={speakingId}
          src={inboxSpeakUrl(speakingId)}
          // Started here rather than with `autoPlay` so a refused play is
          // visible: a browser that blocks autoplay rejects the promise and
          // fires no `error` event, which would otherwise leave the button
          // reading "synthesising…" forever. `AbortError` is not a refusal —
          // it is this element being unmounted by stop, or by a switch to
          // another item, so it must not report a failure or cancel whatever
          // is playing by then.
          ref={(el) => {
            const id = speakingId
            el?.play().catch((err: DOMException) => {
              if (err.name === 'AbortError') return
              setSpeakError(id)
              setSpeakingId((current) => (current === id ? null : current))
            })
          }}
          onPlaying={() => setSpeaking(true)}
          onEnded={() => setSpeakingId(null)}
          onError={() => {
            setSpeakError(speakingId)
            setSpeakingId(null)
          }}
        />
      )}
    </div>
  )
}
