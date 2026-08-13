import { useCallback, useEffect, useRef, useState } from 'react'
import {
  assignInboxItem,
  createInboxItem,
  deleteInboxItem,
  inboxSpeakUrl,
  listInbox,
  listProjects,
  markInboxItemRead,
} from '../api'
import { getAuthor, setAuthor } from '../author'
import { ConfirmDelete } from '../components/ConfirmDelete'
import { Markdown } from '../components/Markdown'
import { needsMarkRead, READ_DWELL_MS } from '../inboxRead'
import {
  playFailure,
  REWIND_STEP_SECONDS,
  rewindTarget,
} from '../speechPlayback'
import { playSpeechStream, type SpeechStream } from '../speechStream'
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
  // Whether this page must decode the audio itself rather than hand the URL to
  // an <audio> element (mesa tasks 829, 830): Apple's media stack refuses an
  // HTTP source with no byte-range support, which is exactly what the speak
  // route is, so later presses skip the attempt that cannot work. Set only
  // once decoded audio has actually **sounded** — a media `error` carries no
  // reason, so a stream that failed because the synthesiser is missing or the
  // route refused the address looks identical to one this browser cannot play,
  // and latching on the failure would cost a browser that plays the element
  // fine every later press. Page state, deliberately not remembered: a wrong
  // guess costs nothing but one attempt, and remembering a wrong one costs
  // every press.
  const [decodes, setDecodes] = useState(false)
  // Whether playback is held. On the element's path its own events are the
  // source of truth (pausing is what the browser's media keys do too) and this
  // only mirrors them; on the decoded path there are no such events, so the
  // press that holds the audio sets it.
  const [paused, setPaused] = useState(false)
  // The live player, so pause/resume and rewind can reach it. One element for
  // the life of the page, never re-keyed: a press must be able to call `play()`
  // on an element that already exists, because that call is what a browser's
  // autoplay policy weighs against the gesture that is still on the stack (an
  // element mounted by a later render is played too late for iOS to count it).
  const player = useRef<HTMLAudioElement | null>(null)
  // The Web Audio clock the decoded path plays on. Created — and resumed — by
  // a press, because a gesture is what unlocks audio and the element failure
  // that sends a press down that path arrives long after the gesture is gone.
  // One for the life of the page: a context is a device, not a play.
  const clock = useRef<AudioContext | null>(null)
  // The decoded item being read, so the transport can reach it.
  const decoded = useRef<SpeechStream | null>(null)
  // The request that item is arriving on, so a stop can drop it. It is held
  // here rather than inside the stream because the route answers only once the
  // synthesiser has audio: until then there is no transport to stop, and the
  // press may already have been abandoned.
  const fetching = useRef<AbortController | null>(null)
  // Which press is current. A decoded play is awaited, so the item it belongs
  // to can be stopped — or swapped for another — before it ever sounds.
  const press = useRef(0)
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

  // The latest list, for the read marks below (mesa task 831): a dwell timer
  // fires long after the render that started it, and the poll has replaced the
  // array by then.
  const latest = useRef(items)
  useEffect(() => {
    latest.current = items
  }, [items])
  // Items this page has already sent the mark for. `read_at` only changes when
  // the next fetch lands, so without this the second trigger — or any render
  // in between — would send the same no-op write again.
  const marked = useRef<Set<number>>(new Set())

  // Reading an item is something only the browser can see, so the page is what
  // stamps it: the route is idempotent and the mark is ambient, so a failure
  // is not reported — it is simply forgotten, and the next trigger retries.
  const markRead = useCallback(
    (id: number) => {
      if (!needsMarkRead(latest.current, id, marked.current)) return
      marked.current.add(id)
      markInboxItemRead(id).then(
        () => refetch(),
        () => marked.current.delete(id),
      )
    },
    [refetch],
  )

  // Holding an item open is one of the two ways to read it. The dwell, not the
  // click: opening the wrong item and closing it again leaves it unread. One
  // timer per open item, kept across renders — the effect depends on
  // `expanded` alone, so the list's 3s poll can never restart a dwell that is
  // nearly due (at these two intervals, that would mean never marking at all).
  const dwelling = useRef<Map<number, number>>(new Map())
  useEffect(() => {
    const timers = dwelling.current
    for (const id of expanded) {
      if (timers.has(id)) continue
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id)
          markRead(id)
        }, READ_DWELL_MS),
      )
    }
    // Closing an item before its dwell is up abandons it, unread.
    for (const [id, timer] of timers) {
      if (expanded.has(id)) continue
      clearTimeout(timer)
      timers.delete(id)
    }
  }, [expanded, markRead])

  // Leaving the page drops every dwell still counting.
  useEffect(() => {
    const timers = dwelling.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // Everything one press holds: the element, and the decoded item with the
  // body still arriving for it. Either way the connection closes — the
  // synthesis already running on the server finishes and its bytes are
  // discarded, as ever. `removeAttribute` rather than `src = ''`: the empty
  // string is a URL the element would go on to load and fail, which is an
  // `error` this page would have to tell from a real one.
  const releasePlayer = useCallback(() => {
    press.current += 1
    fetching.current?.abort()
    fetching.current = null
    decoded.current?.stop()
    decoded.current = null
    const el = player.current
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [])

  // The fallback path (mesa task 830): fetch the same URL and decode the WAV
  // as it arrives, scheduling each piece on the Web Audio clock. No range
  // request is involved, which is the whole reason Apple's media stack refused
  // the element — and the audio still starts on the first sentence rather than
  // on the last, which is what fetching it whole cost.
  const playDecoded = useCallback(
    async (id: number, ctx: AudioContext) => {
      const attempt = press.current
      // Whatever went wrong, the row is the only place it can be said: a press
      // that answers with nothing looks exactly like one still synthesising.
      const failed = (err: unknown) => {
        if (press.current !== attempt) return
        setSpeakError({
          id,
          message: err instanceof Error ? err.message : String(err),
        })
        setSpeakingId((current) => (current === id ? null : current))
      }
      const request = new AbortController()
      fetching.current = request
      try {
        const stream = await playSpeechStream(
          id,
          ctx,
          {
            onPlaying: () => {
              if (press.current !== attempt) return
              setSpeaking(true)
              // Hearing an item is the other way to read it, and the sound is
              // what says so — a press that never became audio has read
              // nothing.
              markRead(id)
              // Sounding is the only evidence that this browser needed
              // decoding; a fallback that failed too says nothing about its
              // media stack.
              setDecodes(true)
            },
            onEnded: () => {
              if (press.current !== attempt) return
              releasePlayer()
              setSpeakingId(null)
              setSpeaking(false)
            },
            onError: failed,
          },
          request.signal,
        )
        // Stopped, or another item pressed, while the first bytes were on their
        // way: the audio this belongs to is already gone.
        if (press.current !== attempt) {
          stream.stop()
          return
        }
        decoded.current = stream
      } catch (err) {
        // An abandoned press aborts its own request; that rejection is the
        // page's own doing and has nobody left to tell.
        if (request.signal.aborted) return
        failed(err)
      }
    },
    [markRead, releasePlayer],
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
    // Unlock the Web Audio clock from inside the gesture whether or not this
    // press turns out to need it: the failure that says it does arrives from
    // the element afterwards, by which time a resume would be refused.
    clock.current ??= new AudioContext()
    void clock.current.resume()
    if (decodes) {
      void playDecoded(id, clock.current)
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

  // An element that failed has a second thing to try — and one whose source
  // was just cleared has failed at nothing. There is no third answer: from
  // here on this page decodes the audio itself, and a decoded play that fails
  // reports its own reason rather than arriving as a reasonless `error`.
  function playerFailed() {
    const el = player.current
    const ctx = clock.current
    if (el === null || ctx === null || speakingId === null) return
    if (playFailure(el.src, inboxSpeakUrl(speakingId)) === 'ignore') return
    // The element is done with for this press; clearing its source keeps its
    // dead connection from being confused for the decoded one.
    el.removeAttribute('src')
    el.load()
    void playDecoded(speakingId, ctx)
  }

  function togglePause() {
    const stream = decoded.current
    if (stream) {
      // Nothing here fires events of its own, so the press that holds the
      // audio is also what says so. A clock the page has already handed back
      // refuses both; there is no row left to tell by then.
      void (paused ? stream.resume() : stream.pause()).catch(() => {})
      setPaused(!paused)
      return
    }
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

  // Leaving the page drops the body still arriving and silences what is
  // scheduled. Removing the element from the document is what stops its own
  // sound — React has already detached the ref by the time this runs, so it is
  // not this cleanup that pauses it. The Web Audio clock is a device rather
  // than a play, so it is handed back here and nowhere else: a stop keeps it,
  // because the next press needs one that a gesture has already unlocked.
  useEffect(
    () => () => {
      releasePlayer()
      void clock.current?.close()
      clock.current = null
    },
    [releasePlayer],
  )

  // Back one step, but only inside what the stream still holds: the response is
  // chunked with no `Content-Length`, so `seekable` — not `0` — is the floor.
  // The decoded path keeps every sample it was sent, so there the floor is the
  // start of the item; the same arithmetic answers both.
  function rewind() {
    const stream = decoded.current
    if (stream) {
      stream.rewind()
      return
    }
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
            <li
              key={item.id}
              className={`inbox-item${item.read_at === null ? ' unread' : ''}`}
            >
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
                    {/* The accent bar says it at a glance; the word is what a
                        reader who cannot see the bar gets (mesa task 831). */}
                    {item.read_at === null && (
                      <span className="inbox-unread"> · unread</span>
                    )}
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
        onPlaying={() => {
          setSpeaking(true)
          // Same rule as the decoded path: sounding is what reads the item.
          if (speakingId !== null) markRead(speakingId)
        }}
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
