import { useCallback, useEffect, useRef, useState } from 'react'
import {
  assignInboxItem,
  createInboxItem,
  deleteInboxItem,
  fetchInboxSpeech,
  inboxSpeakUrl,
  listInbox,
  listProjects,
} from '../api'
import { getAuthor, setAuthor } from '../author'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { Markdown } from '../components/Markdown'
import {
  playFailure,
  REWIND_STEP_SECONDS,
  rewindTarget,
} from '../speechPlayback'
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
  // states the button has to distinguish. One item at a time — there is one
  // <audio> element for the page, so picking another item stops the first.
  const [speakingId, setSpeakingId] = useState<number | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // The failure belongs to the item whose button was pressed, so it carries the
  // id — and its message, because the reason is often specific enough to act on
  // (a synthesiser that isn't installed, an address the route refuses).
  const [speakError, setSpeakError] = useState<{
    id: number
    message: string
  } | null>(null)
  // Whether this page must fetch the audio whole rather than stream it (mesa
  // task 829): Apple's media stack refuses an HTTP source with no byte-range
  // support, which is exactly what the speak route is, so later presses skip
  // the attempt that cannot work. Set only once a fetched blob has actually
  // **played** — a media `error` carries no reason, so a stream that failed
  // because the synthesiser is missing or the route refused the address looks
  // identical to one this browser cannot play, and latching on the failure
  // would cost a browser that streams fine every later press. Page state,
  // deliberately not remembered: a wrong guess costs a streaming start.
  const [buffered, setBuffered] = useState(false)
  // Whether playback is held. The element's own events are the source of truth
  // (pausing is what the browser's own media keys do too), so this only mirrors
  // them — it never decides.
  const [paused, setPaused] = useState(false)
  // The live player, so pause/resume and rewind can reach it. One element for
  // the life of the page, never re-keyed: a press must be able to call `play()`
  // on an element that already exists, because that call is what a browser's
  // autoplay policy weighs against the gesture that is still on the stack (an
  // element mounted by a later render is played too late for iOS to count it).
  const player = useRef<HTMLAudioElement | null>(null)
  // The blob a buffered play is playing from, so it can be handed back.
  const objectUrl = useRef<string | null>(null)
  // The in-flight buffered fetch, so stop can drop it.
  const fetching = useRef<AbortController | null>(null)
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

  // Everything one press holds: the element itself, a fetch that may still be
  // collecting audio, and the blob a buffered play was reading from. Clearing
  // the source is what closes the connection — the synthesis already running on
  // the server finishes and its bytes are discarded, as ever. `removeAttribute`
  // rather than `src = ''`: the empty string is a URL the element would go on
  // to load and fail, which is an `error` this page would have to tell from a
  // real one.
  const releasePlayer = useCallback(() => {
    fetching.current?.abort()
    fetching.current = null
    const el = player.current
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = null
    }
  }, [])

  // The fallback path: ask for the whole audio, then play that. A blob has a
  // length and is seekable, which is what the streamed response cannot be and
  // what Apple's media stack requires — at the cost of the first sound waiting
  // for the last sentence. `play()` here is outside the press that asked for
  // it, which is allowed because the element was already started from one (the
  // streamed attempt that failed is what put this page in buffered mode).
  const playBuffered = useCallback(
    async (id: number, el: HTMLAudioElement) => {
      const attempt = new AbortController()
      fetching.current = attempt
      try {
        const audio = await fetchInboxSpeech(id, attempt.signal)
        if (attempt.signal.aborted) return
        const url = URL.createObjectURL(audio)
        objectUrl.current = url
        el.src = url
        await el.play()
        // Playing is the only evidence that this browser needed the blob; a
        // fallback that failed too says nothing about the media stack.
        setBuffered(true)
      } catch (err) {
        if (attempt.signal.aborted) return
        setSpeakError({
          id,
          message: err instanceof Error ? err.message : String(err),
        })
        setSpeakingId((current) => (current === id ? null : current))
      } finally {
        if (fetching.current === attempt) fetching.current = null
      }
    },
    [],
  )

  // Stops if this item is already the one playing, starts it otherwise.
  // Starting happens here, inside the press, rather than as a side effect of
  // the render it schedules — see `player`.
  function toggleSpeak(id: number) {
    const stopping = speakingId === id
    releasePlayer()
    setSpeakError(null)
    setSpeaking(false)
    setPaused(false)
    setSpeakingId(stopping ? null : id)
    const el = player.current
    if (stopping || !el) return
    if (buffered) {
      void playBuffered(id, el)
      return
    }
    el.src = inboxSpeakUrl(id)
    // A source that will not load arrives as the element's own `error` event,
    // which is where the fallback lives; the only rejection to report from here
    // is the browser refusing to start at all.
    el.play().catch((err: DOMException) => {
      if (err.name !== 'NotAllowedError') return
      setSpeakError({ id, message: 'this browser would not start playback' })
      setSpeakingId((current) => (current === id ? null : current))
    })
  }

  // A player that failed either has a second thing to try or has run out of
  // them — and an element whose source was just cleared has failed at nothing.
  function playerFailed() {
    const el = player.current
    if (el === null || speakingId === null) return
    switch (playFailure(el.src, inboxSpeakUrl(speakingId), buffered)) {
      case 'ignore':
        return
      case 'buffer':
        void playBuffered(speakingId, el)
        return
      case 'report':
        releasePlayer()
        setSpeakError({ id: speakingId, message: 'could not play this item' })
        setSpeakingId(null)
    }
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

  // The item being read can be assigned or deleted underneath us — by this
  // person on another device, or by an agent. Playback follows the list: an
  // item that is no longer there has no button left to stop it with, so the
  // audio must not outlive its row. Only the element is touched here; the
  // state describing it is read by that row alone, which is already gone.
  const listed =
    speakingId === null || !items || items.some((it) => it.id === speakingId)
  useEffect(() => {
    if (!listed) releasePlayer()
  }, [listed, releasePlayer])

  // Leaving the page drops any fetch still collecting audio and hands back the
  // blob. Removing the element from the document is what stops the sound —
  // React has already detached the ref by the time this runs, so it is not
  // this cleanup that pauses it.
  useEffect(() => releasePlayer, [releasePlayer])

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
                  {speakError?.id === item.id && (
                    <span className="error">{speakError.message}</span>
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

      {/* One player for the whole page, mounted for its whole life: a press
          reaches it directly rather than mounting a new element, and its source
          is set imperatively. Nothing here re-renders it, so the list's 3s poll
          can no longer touch playback at all. Stopping is clearing that source
          — the already-running synthesis on the server finishes and its bytes
          are discarded, the same no-timeout posture as hooks and scripts. */}
      <audio
        ref={player}
        onPlaying={() => setSpeaking(true)}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => {
          releasePlayer()
          setSpeakingId(null)
          setSpeaking(false)
        }}
        onError={playerFailed}
      />
    </div>
  )
}
