import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getLive,
  liveSpeakUrl,
  markLiveTurnPlayed,
  reportLiveRoute,
  sendLiveUtterance,
  startLive,
  stopLive,
} from '../api'
import {
  isLive,
  liveControls,
  liveStatusLine,
  type LiveButton,
  type LivePending,
} from '../liveSession'
import {
  advanceCursor,
  mergeTurns,
  navigateTarget,
  nextUnplayed,
  spokenText,
  turnGroups,
  turnLabel,
} from '../liveTurns'
import { playFailure } from '../speechPlayback'
import { playSpeechStream, type SpeechStream } from '../speechStream'
import type { LiveTurn } from '../types/LiveTurn'
import { useFetch } from '../useFetch'

/**
 * Mesa Live (mesa task 855): the page you talk to.
 *
 * The person dictates into the textarea below — system dictation, the OS's own,
 * since mesa ships no STT and never touches a microphone — and each line
 * becomes a `user` turn. An agent spawned by `Go live` pulls those over the CLI
 * and answers with `mesa live say`, which lands here as a `mesa` turn and is
 * spoken through the same `kokoro-rs` route and the same decoding machinery the
 * inbox's play button uses. A turn may also carry `navigate`, which is how the
 * conversation moves the browser.
 *
 * Three things about the shape of this page are load-bearing:
 *
 * - **The press is the gesture.** A browser weighs an autoplay policy against
 *   the click still on the stack, and every later turn is spoken without one —
 *   so `Go live` is where the `<audio>` element and the `AudioContext` are
 *   unlocked, exactly as the inbox's first press unlocks a read-all run. Until
 *   this page has had that press, nothing is spoken and nothing navigates: the
 *   conversation may be live on another device, but this browser has not joined
 *   it.
 * - **One player for the page**, never re-keyed, so a turn that starts from a
 *   poll rather than a click still reaches an element a gesture already
 *   unlocked. Apple's media stack refuses this route outright (it is chunked
 *   with no `Content-Length`), so a failure falls back to decoding the WAV here
 *   — `speechStream.ts`, the same path the inbox takes.
 * - **The page is mounted for the life of the app** (`App.tsx`, alongside
 *   `TerminalPage`), not by the `#/live` route. `navigate` is the whole point
 *   of the feature, and a page unmounted by the navigation it just performed
 *   would cut its own sentence off mid-word and stop reporting where the person
 *   went.
 */
export function LiveView() {
  // The exclusive id cursor the poll asks from. A ref, not state: it is read
  // inside `load` on every tick and rendered nowhere, so advancing it must not
  // cost a render.
  const cursor = useRef<number | null>(null)
  const { data, error, refetch } = useFetch(
    () => getLive(cursor.current ?? undefined),
    'live',
    { pollMs: 2000 },
  )
  const session = data?.session ?? null
  const live = isLive(session)

  // The transcript, accumulated: each poll answers only with what is new, so
  // the page holds the conversation and the server holds the tail.
  const [turns, setTurns] = useState<LiveTurn[]>([])
  const [pending, setPending] = useState<LivePending>(null)
  // The last failed call, or a synthesiser that refused — the status line's
  // top rank, since a page that says "listening" after a failure is lying.
  const [actionError, setActionError] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // Whether this page must decode the audio itself rather than hand the URL to
  // an <audio> element — the same latch, for the same reason, as the inbox's:
  // set only once decoded audio has actually sounded, because a media `error`
  // carries no reason and a missing synthesiser looks identical to a media
  // stack that cannot play the stream.
  const [decodes, setDecodes] = useState(false)
  const [draft, setDraft] = useState('')
  // Whether a press on THIS page has unlocked audio. Not the same question as
  // "is the conversation live": a session started from `mesa live start`, or a
  // page reloaded mid-conversation, is live with no gesture behind it — which
  // is what the `Listen` control exists for (`liveSession.ts`). State rather
  // than a read of `clock.current`, because it decides what is rendered.
  const [unlocked, setUnlocked] = useState(false)

  // Which session the held transcript belongs to. A new conversation is a new
  // transcript — going live again is a fresh session with its own turns, and
  // the old ones must not be merged in above them.
  const shown = useRef<number | null>(null)
  // Turns this page has already taken in hand. `played_at` only comes back on
  // the next poll, so without this the two seconds after a turn starts would
  // start it again; a turn that failed to speak stays here too, which is what
  // keeps one bad turn from wedging the run on itself.
  const handled = useRef<Set<number>>(new Set())
  // The latest transcript for the run, which advances from a media event long
  // after the render that scheduled it.
  const held = useRef<LiveTurn[]>(turns)

  useEffect(() => {
    if (!data) return
    const arriving = data.session?.id ?? null
    setTurns((current) =>
      mergeTurns(arriving === shown.current ? current : [], data.turns),
    )
    if (arriving !== shown.current) {
      shown.current = arriving
      handled.current = new Set()
    }
    cursor.current = advanceCursor(cursor.current, data.turns)
  }, [data])

  useEffect(() => {
    held.current = turns
  }, [turns])

  // The transcript follows the conversation: a spoken reply the reader cannot
  // see is the one thing this page must never do.
  const scroller = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // ---- playback ----

  // One element and one clock for the life of the page (see the module note):
  // a press reaches them directly, and every later turn reuses what that press
  // unlocked.
  const player = useRef<HTMLAudioElement | null>(null)
  const clock = useRef<AudioContext | null>(null)
  const decoded = useRef<SpeechStream | null>(null)
  // The request the audio is arriving on. Held outside the stream because the
  // route answers only once the synthesiser has audio: until then there is no
  // transport to stop.
  const fetching = useRef<AbortController | null>(null)
  // Which press is current, so a turn abandoned before it sounded can tell.
  const press = useRef(0)
  // The turn the player is actually on — ahead of anything a render knows,
  // since the run advances from a media event.
  const sounding = useRef<number | null>(null)
  // The run's own advance, wired through a ref: a decoded turn's callbacks are
  // set inside its own press, before the turn that follows it exists.
  const pump = useRef<() => void>(() => {})
  const ended = useRef<(id: number) => void>(() => {})

  const releasePlayer = useCallback(() => {
    press.current += 1
    sounding.current = null
    fetching.current?.abort()
    fetching.current = null
    decoded.current?.stop()
    decoded.current = null
    const el = player.current
    if (el) {
      el.pause()
      // `removeAttribute` rather than `src = ''`: the empty string is a URL the
      // element would go on to load and fail, which is an `error` this page
      // would have to tell from a real one.
      el.removeAttribute('src')
      el.load()
    }
  }, [])

  // Stamping a turn spoken is ambient: the route is idempotent and this page's
  // own `handled` set is what stops a repeat, so a failed stamp is forgotten
  // rather than reported.
  const markPlayed = useCallback((id: number) => {
    markLiveTurnPlayed(id).catch(() => {})
  }, [])

  // The decode-it-yourself path: fetch the same URL and schedule each piece on
  // the Web Audio clock as it lands. No range request is involved, which is
  // the whole reason Apple's media stack refused the element.
  const playDecoded = useCallback(
    (id: number, ctx: AudioContext) => {
      const attempt = press.current
      const failed = (err: unknown) => {
        if (press.current !== attempt) return
        setActionError(err instanceof Error ? err.message : String(err))
        setSpeaking(false)
        sounding.current = null
        // A turn that never sounded is a turn that ended: the conversation
        // moves on rather than stopping on it.
        pump.current()
      }
      const request = new AbortController()
      fetching.current = request
      void playSpeechStream(
        liveSpeakUrl(id),
        ctx,
        {
          onPlaying: () => {
            if (press.current !== attempt) return
            setSpeaking(true)
            // Sounding is the only evidence this browser needed decoding; a
            // fallback that failed too says nothing about its media stack.
            setDecodes(true)
          },
          onEnded: () => {
            if (press.current !== attempt) return
            ended.current(id)
          },
          onError: failed,
        },
        request.signal,
      ).then(
        (stream) => {
          // Stopped, or another turn started, while the first bytes were on
          // their way: the audio this belongs to is already gone.
          if (press.current !== attempt) {
            stream.stop()
            return
          }
          decoded.current = stream
        },
        (err: unknown) => {
          // An abandoned press aborts its own request; that rejection is the
          // page's own doing and has nobody left to tell.
          if (request.signal.aborted) return
          failed(err)
        },
      )
    },
    [],
  )

  // Speaks one turn, whatever was sounding before. Called from the run rather
  // than from a click — the element and the clock `Go live` unlocked are what
  // make that legal.
  function speak(id: number, ctx: AudioContext) {
    releasePlayer()
    const attempt = press.current
    sounding.current = id
    setSpeaking(false)
    const el = player.current
    if (!el) return
    if (decodes) {
      playDecoded(id, ctx)
      return
    }
    el.src = liveSpeakUrl(id)
    // A source that will not load arrives as the element's own `error` event,
    // which is where the fallback lives; the only rejection to report from here
    // is the browser refusing to start at all.
    el.play().catch((err: DOMException) => {
      if (err.name !== 'NotAllowedError' || press.current !== attempt) return
      setActionError('this browser would not start playback')
      sounding.current = null
      ended.current(id)
    })
  }

  /** Silence — what ending the conversation, or leaving, does to the audio. */
  const silence = useCallback(() => {
    releasePlayer()
    setSpeaking(false)
  }, [releasePlayer])

  // The run: the oldest mesa turn nobody has played, one at a time. A turn that
  // navigates moves the browser when it is *reached*, whether or not it also
  // speaks — the order of the conversation is the order of the turns.
  function run() {
    const ctx = clock.current
    // No press on this browser yet: the conversation may be live elsewhere, but
    // nothing here may sound or navigate without a gesture behind it.
    if (ctx === null || sounding.current !== null) return
    for (;;) {
      const turn = nextUnplayed(held.current, handled.current)
      if (turn === null) return
      handled.current.add(turn.id)
      const target = navigateTarget(turn)
      if (target !== null && window.location.hash !== target) {
        window.location.hash = target
      }
      const text = spokenText(turn)
      if (text === null) {
        // A pure navigate turn: it has already done its work.
        markPlayed(turn.id)
        continue
      }
      speak(turn.id, ctx)
      return
    }
  }

  // The end of a turn: stamp it, then whatever is next. An end for a turn the
  // player has already left is an echo — a media event and the watcher below
  // can both arrive for the same turn, and advancing twice would cut the turn
  // after it short.
  function turnEnded(id: number) {
    if (sounding.current !== id) return
    sounding.current = null
    setSpeaking(false)
    markPlayed(id)
    run()
  }

  useEffect(() => {
    pump.current = run
    ended.current = turnEnded
  })

  // New turns are spoken as they land, and a turn whose row has gone — the
  // transcript reset under a new session — counts as one that ended, so the
  // run moves on rather than wedging on it.
  useEffect(() => {
    const id = sounding.current
    if (id !== null && !turns.some((t) => t.id === id)) ended.current(id)
    pump.current()
  }, [turns])

  // A conversation that has ended stops speaking. Edge-triggered on the status,
  // not derived: a stop touches the element and the stream, which is not
  // something to do while rendering.
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) silence()
    wasLive.current = live
  }, [live, silence])

  // Leaving drops the body still arriving and silences what is scheduled. The
  // clock is a device rather than a play, so it is handed back only here.
  useEffect(
    () => () => {
      releasePlayer()
      void clock.current?.close()
      clock.current = null
    },
    [releasePlayer],
  )

  // ---- where the person is ----

  // The agent reads the route to know what the person is looking at. Ambient,
  // like the inbox's read mark: sent on arrival and on every hash change, and a
  // failure — no live session, most often — is forgotten rather than shown.
  const reportRoute = useCallback(() => {
    const route = window.location.hash || '#/'
    if (!route.startsWith('#/') || route.length > 200) return
    reportLiveRoute(route).catch(() => {})
  }, [])
  useEffect(() => {
    reportRoute()
    window.addEventListener('hashchange', reportRoute)
    return () => window.removeEventListener('hashchange', reportRoute)
  }, [reportRoute])
  // Going live is the other moment the route matters: the session that just
  // started has no idea where its person already is.
  useEffect(() => {
    if (live) reportRoute()
  }, [live, reportRoute])

  // ---- the press ----

  const controls = liveControls(session, pending, unlocked)

  function act(button: LiveButton) {
    if (button.disabled) return
    // Unlock the element and the clock from inside the gesture whether or not
    // this press turns out to need them: every turn after this one is spoken
    // without a click behind it, and the failure that says the clock is needed
    // arrives from the element long afterwards.
    clock.current ??= new AudioContext()
    void clock.current.resume()
    void player.current?.load()
    setUnlocked(true)
    setActionError(null)
    if (button.action === 'listen') {
      // Joining calls nothing: the press *was* the whole point, and the run can
      // start on whatever the conversation has already said.
      pump.current()
      return
    }
    if (button.action === 'start') {
      setPending('start')
      startLive().then(
        () => refetch(),
        (err: unknown) => setActionError(err instanceof Error ? err.message : String(err)),
      ).finally(() => setPending(null))
      return
    }
    setPending('stop')
    silence()
    stopLive().then(
      () => refetch(),
      (err: unknown) => setActionError(err instanceof Error ? err.message : String(err)),
    ).finally(() => setPending(null))
  }

  function send() {
    const text = draft.trim()
    if (text === '' || !live) return
    setDraft('')
    sendLiveUtterance(text).then(
      () => refetch(),
      (err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        // The line was never recorded, so it belongs back in the box rather
        // than lost — re-dictating it is the one thing a person cannot redo.
        setDraft((current) => (current === '' ? text : current))
      },
    )
  }

  const groups = turnGroups(turns)
  // Pulled out of the object so its narrowing survives into the handler below.
  const secondary = controls.secondary

  return (
    <div className="live-page">
      <h1>Live</h1>
      <p className="muted">
        Talk to mesa. Your dictation goes in the box below; mesa answers out
        loud and can move this browser to what it is talking about.
      </p>

      <div className="live-controls">
        <button
          type="button"
          className={`live-toggle${controls.primary.action === 'stop' ? ' live-on' : ''}`}
          disabled={controls.primary.disabled}
          onClick={() => act(controls.primary)}
        >
          {controls.primary.label}
        </button>
        {/* Present only while there are two things worth doing at once — the
            conversation is running and this browser has not joined it yet. */}
        {secondary && (
          <button
            type="button"
            className="live-toggle live-on"
            disabled={secondary.disabled}
            onClick={() => act(secondary)}
          >
            {secondary.label}
          </button>
        )}
        <span className={actionError !== null ? 'error' : 'muted'}>
          {liveStatusLine(session, speaking, actionError)}
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="live-transcript" ref={scroller}>
        {groups.length === 0 ? (
          <p className="muted">
            Nothing said yet. Press {controls.primary.label} to begin.
          </p>
        ) : (
          groups.map((group) => (
            <div
              key={group.turns[0].id}
              className={`live-group live-${group.role}`}
            >
              <div className="live-who">{turnLabel(group.role)}</div>
              {group.turns.map((turn) => (
                <div key={turn.id} className="live-turn">
                  {/* Plain text, never markdown: a mesa turn is prose meant to
                      be *spoken*, and a user turn is untrusted dictation. */}
                  {turn.text !== '' && (
                    <div className="live-text">{turn.text}</div>
                  )}
                  {navigateTarget(turn) !== null && (
                    <div className="live-navigated">
                      went to {navigateTarget(turn)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <form
        className="live-composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          className="live-input"
          rows={2}
          value={draft}
          disabled={!live}
          placeholder={
            live ? 'dictate here…' : 'go live to start the conversation'
          }
          aria-label="say something to mesa"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // The Enter that commits an IME candidate is not a send: it arrives
            // as a plain `Enter` keydown with `isComposing` set, and acting on
            // it would ship half-converted text. The same guard, for the same
            // reason, as the agent chat composer's.
            if (e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
        />
        <div className="live-hint muted">
          This is where system dictation types — start your OS's dictation (on
          macOS, press the dictation key) with the cursor in this box. Enter
          sends, Shift+Enter starts a line. mesa captures no microphone of its
          own.
        </div>
      </form>

      {/* One player for the whole page, mounted for its whole life: a press
          reaches it directly rather than mounting a new element, and its source
          is set imperatively. */}
      <audio
        ref={player}
        onPlaying={() => setSpeaking(true)}
        onEnded={() => {
          if (sounding.current !== null) ended.current(sounding.current)
        }}
        onError={() => {
          const el = player.current
          const ctx = clock.current
          const id = sounding.current
          if (el === null || ctx === null || id === null) return
          // An element whose source was just cleared has failed at nothing.
          if (playFailure(el.src, liveSpeakUrl(id)) === 'ignore') return
          el.removeAttribute('src')
          el.load()
          playDecoded(id, ctx)
        }}
      />
    </div>
  )
}
