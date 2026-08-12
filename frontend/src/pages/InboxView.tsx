import { useCallback, useRef, useState } from 'react'
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
import { REWIND_STEP_SECONDS, rewindTarget } from '../speechPlayback'
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
  // Whether playback is held. The element's own events are the source of truth
  // (pausing is what the browser's own media keys do too), so this only mirrors
  // them — it never decides.
  const [paused, setPaused] = useState(false)
  // The live player, so pause/resume and rewind can reach it. Held rather than
  // re-found by query, since the element is mounted by this component.
  const player = useRef<HTMLAudioElement | null>(null)
  // Which items are opened out to their full body. Collapsed is the default:
  // the list is a triage queue, so every item shows a few lines and the one
  // being read is opened on purpose. Playback is deliberately *not* gated on
  // this — an item can be played from its collapsed row (mesa task 828).
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  function toggleExpanded(id: number) {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  // Stops if this item is already the one playing, starts it otherwise.
  function toggleSpeak(id: number) {
    setSpeakError(null)
    setSpeaking(false)
    setPaused(false)
    setSpeakingId((current) => (current === id ? null : id))
  }

  function togglePause() {
    const el = player.current
    if (!el) return
    // Resuming can be refused the same way the first play can; treat it the
    // same way, so the buttons never describe a state the element isn't in.
    if (el.paused) {
      el.play().catch(() => setPaused(true))
    } else {
      el.pause()
    }
  }

  // Attaching the player is what starts it — done here rather than with
  // `autoPlay` so a refused play is visible: a browser that blocks autoplay
  // rejects the promise and fires no `error` event, which would otherwise leave
  // the button reading "synthesising…" forever. `AbortError` is not a refusal —
  // it is this element being unmounted by stop, or by a switch to another item,
  // so it must not report a failure or cancel whatever is playing by then.
  //
  // The callback must stay stable across re-renders: React re-runs a *new*
  // function ref on every commit, and this list re-renders every 3s from its
  // own poll — an inline one would call `play()` again each time and silently
  // undo a pause. Keyed to `speakingId`, it runs once per player instead, which
  // is also exactly when the element itself is replaced (same key).
  const attachPlayer = useCallback(
    (el: HTMLAudioElement | null) => {
      player.current = el
      const id = speakingId
      el?.play().catch((err: DOMException) => {
        if (err.name === 'AbortError') return
        setSpeakError(id)
        setSpeakingId((current) => (current === id ? null : current))
      })
    },
    [speakingId],
  )

  // Back one step, but only inside what the stream still holds: the response is
  // chunked with no `Content-Length`, so `seekable` — not `0` — is the floor.
  function rewind() {
    const el = player.current
    if (!el) return
    const start = el.seekable.length > 0 ? el.seekable.start(0) : null
    const target = rewindTarget(el.currentTime, start)
    if (target !== null) el.currentTime = target
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
              <div className="inbox-item-row">
                <button
                  type="button"
                  className="inbox-disclosure"
                  aria-expanded={expanded.has(item.id)}
                  // A glyph is a button's whole content, and content outranks
                  // `title` in the accessible name — so every symbol button
                  // here carries the same wording twice, once for the pointer
                  // and once for assistive tech.
                  aria-label={
                    expanded.has(item.id)
                      ? 'collapse this item'
                      : 'open this item'
                  }
                  title={
                    expanded.has(item.id)
                      ? 'collapse this item'
                      : 'open this item'
                  }
                  onClick={() => toggleExpanded(item.id)}
                >
                  {expanded.has(item.id) ? '▾' : '▸'}
                </button>
                <div className="inbox-item-main">
                  {expanded.has(item.id) ? (
                    <div className="inbox-body">
                      <Markdown text={item.body} />
                    </div>
                  ) : (
                    // Collapsed: the raw first lines, clamped by CSS rather
                    // than cut here, so the preview follows the column width.
                    // Plain text, not markdown — an inert block is safe to
                    // make the click target that opens the item.
                    <div
                      className="inbox-preview"
                      onClick={() => toggleExpanded(item.id)}
                    >
                      {item.body}
                    </div>
                  )}
                  <div className="muted storyboard-meta">
                    {item.author && <span>from {item.author} · </span>}
                    <span>sent {item.created_at}</span>
                  </div>
                  {speakError === item.id && (
                    <span className="error">could not play this item</span>
                  )}
                </div>
                {/* Playback rides on the row itself, open or not: hearing an
                    item is how you triage it without reading it. */}
                <div className="inbox-playback">
                  {/* The label says what the press does, in all three states —
                      pressing while it is still synthesising stops it too. The
                      glyph is what carries "not sounding yet". */}
                  <button
                    type="button"
                    aria-label={
                      speakingId === item.id
                        ? 'stop reading this item'
                        : 'read this item aloud'
                    }
                    title={
                      speakingId === item.id
                        ? 'stop reading this item'
                        : 'read this item aloud'
                    }
                    onClick={() => toggleSpeak(item.id)}
                  >
                    {speakingId !== item.id ? '▶' : speaking ? '■' : '…'}
                  </button>
                  {/* Transport for the item being read, and only once it is
                      actually sounding: before that there is no playhead to
                      move and nothing to hold. */}
                  {speakingId === item.id && speaking && (
                    <>
                      <button
                        type="button"
                        aria-label={`go back ${REWIND_STEP_SECONDS} seconds`}
                        title={`go back ${REWIND_STEP_SECONDS} seconds`}
                        onClick={rewind}
                      >
                        ⏪
                      </button>
                      <button
                        type="button"
                        aria-label={paused ? 'resume reading' : 'pause reading'}
                        title={paused ? 'resume reading' : 'pause reading'}
                        onClick={togglePause}
                      >
                        {paused ? '▶' : '⏸'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* Triage controls belong to the opened item — the collapsed row
                  is a preview plus playback, nothing that changes the db. */}
              {expanded.has(item.id) && (
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
              )}
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
          // Attaching is what starts it, and holds the element for the
          // transport buttons — see `attachPlayer`.
          ref={attachPlayer}
          onPlaying={() => setSpeaking(true)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
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
