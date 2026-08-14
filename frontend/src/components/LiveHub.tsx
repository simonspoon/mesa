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
  AUTO_SEND_IDLE_MS,
  isEditableTarget,
  shouldAutoSend,
  shouldReclaimFocus,
  userTookFocus,
  type ReclaimCause,
} from '../liveCapture'
import {
  isLive,
  liveControls,
  liveStatusLine,
  type LiveButton,
  type LivePending,
} from '../liveSession'
import {
  advanceCursor,
  navigateTarget,
  nextUnplayed,
  sidebarsIntent,
  spokenText,
  transcriptFor,
  turnGroups,
  turnLabel,
} from '../liveTurns'
import { playFailure } from '../speechPlayback'
import { playSpeechStream, type SpeechStream } from '../speechStream'
import type { LiveTurn } from '../types/LiveTurn'
import { useFetch } from '../useFetch'

/**
 * Mesa Live, in the header (mesa tasks 855, 857): the whole conversation lives
 * here now, not on a routed page.
 *
 * The person dictates into the capture box in the popup below — system
 * dictation, the OS's own, since mesa ships no STT and never touches a
 * microphone — and each settled line becomes a `user` turn. An agent spawned
 * by `Go live` pulls those over the CLI and answers with `mesa live say`,
 * which lands here as a `mesa` turn and is spoken through the same `kokoro-rs`
 * route and the same decoding machinery the inbox's play button uses. A turn
 * may also carry `navigate`, which is how the conversation moves the browser.
 *
 * Four things about the shape of this component are load-bearing:
 *
 * - **The press is the gesture.** A browser weighs an autoplay policy against
 *   the click still on the stack, and every later turn is spoken without one —
 *   so `Go live` is where the `<audio>` element and the `AudioContext` are
 *   unlocked, exactly as the inbox's first press unlocks a read-all run. Until
 *   this browser has had that press, nothing is spoken, nothing navigates and
 *   nothing grabs the keyboard: the conversation may be live on another
 *   device, but this browser has not joined it.
 * - **One player for the app**, never re-keyed, so a turn that starts from a
 *   poll rather than a click still reaches an element a gesture already
 *   unlocked. Apple's media stack refuses this route outright (it is chunked
 *   with no `Content-Length`), so a failure falls back to decoding the WAV
 *   here — `speechStream.ts`, the same path the inbox takes.
 * - **The header is mounted for the life of the app**, which is the whole
 *   reason the conversation lives in it (task 857): `navigate` is the point of
 *   the feature, and a routed page would be unmounted by the navigation it
 *   just performed — cutting its own sentence off mid-word. The popup opens
 *   and closes without touching the session; only `End` ends it.
 * - **While joined, the capture box holds the keyboard** (`liveCapture.ts`):
 *   a `navigate` turn is mesa's doing, and the words after it are still meant
 *   for mesa, not for whatever field the opened page focused. A deliberate
 *   click into another field wins the fight and stands capture down; mesa's
 *   next action re-arms it. Dictation never presses Enter, so a draft that
 *   sits untouched for a beat is sent on mesa's own clock.
 *
 * The two page verbs — `navigate` and the sidebar pair (task 859) — are both
 * performed here, in transcript order, when the run *reaches* the turn: the
 * browser moves and the panels fold where the sentence around them said they
 * would. The hub owns neither sidebar's state (App does, for both of them and
 * for the phone tab bar), so collapsing is one call back up.
 */
export function LiveHub({
  onSidebars,
}: {
  /** Fold both sidebars away (`true`) or bring them back. App owns that state
   *  — the hub only relays what the conversation asked for. */
  onSidebars: (collapsed: boolean) => void
}) {
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
  // this component holds the conversation and the server holds the tail.
  const [turns, setTurns] = useState<LiveTurn[]>([])
  const [pending, setPending] = useState<LivePending>(null)
  // The last failed call, or a synthesiser that refused — the status line's
  // top rank, since a popup that says "listening" after a failure is lying.
  const [actionError, setActionError] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  // Whether this component must decode the audio itself rather than hand the
  // URL to an <audio> element — the same latch, for the same reason, as the
  // inbox's: set only once decoded audio has actually sounded, because a media
  // `error` carries no reason and a missing synthesiser looks identical to a
  // media stack that cannot play the stream.
  const [decodes, setDecodes] = useState(false)
  const [draft, setDraft] = useState('')
  // Whether a press on this browser has unlocked audio. Not the same question
  // as "is the conversation live": a session started from `mesa live start`,
  // or a page reloaded mid-conversation, is live with no gesture behind it —
  // which is what the `Listen` control exists for (`liveSession.ts`). State
  // rather than a read of `clock.current`, because it decides what is rendered.
  const [unlocked, setUnlocked] = useState(false)
  // The conversation popup. Purely visual: closing it calls no route and stops
  // nothing — the session, the audio and the capture box all carry on.
  const [open, setOpen] = useState(false)

  // Which session the held transcript belongs to. A new conversation is a new
  // transcript — going live again is a fresh session with its own turns, and
  // the old ones must not be merged in above them.
  const shown = useRef<number | null>(null)
  // Turns this component has already taken in hand. `played_at` only comes
  // back on the next poll, so without this the two seconds after a turn starts
  // would start it again; a turn that failed to speak stays here too, which is
  // what keeps one bad turn from wedging the run on itself.
  const handled = useRef<Set<number>>(new Set())
  // The latest transcript for the run, which advances from a media event long
  // after the render that scheduled it.
  const held = useRef<LiveTurn[]>(turns)

  useEffect(() => {
    if (!data) return
    const arriving = data.session?.id ?? null
    // Decided here and not inside a `setTurns` updater: an updater runs at the
    // next render, by which point `shown.current` below has already been moved
    // on — so the comparison inside one is always true and the transcript is
    // never dropped. That was the replay of task 862: ending a conversation
    // cleared `handled` (checked here, synchronously) while keeping every turn
    // it applied to, and the run said the whole thing over again.
    const { turns: next, fresh } = transcriptFor(
      held.current,
      shown.current,
      arriving,
      data.turns,
    )
    setTurns(next)
    if (fresh) {
      shown.current = arriving
      handled.current = new Set()
    }
    cursor.current = advanceCursor(cursor.current, data.turns)
  }, [data])

  useEffect(() => {
    held.current = turns
  }, [turns])

  // The transcript follows the conversation: a spoken reply the reader cannot
  // see is the one thing the popup must never do. The clip-hidden closed state
  // still lays out, so this works whether or not it is open.
  const scroller = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, open])

  // ---- playback ----

  // One element and one clock for the life of the app (see the module note):
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
      // element would go on to load and fail, which is an `error` this
      // component would have to tell from a real one.
      el.removeAttribute('src')
      el.load()
    }
  }, [])

  // Stamping a turn spoken is ambient: the route is idempotent and the
  // component's own `handled` set is what stops a repeat, so a failed stamp is
  // forgotten rather than reported.
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
          // component's own doing and has nobody left to tell.
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

  /** Silence — what ending the conversation does to the audio. */
  const silence = useCallback(() => {
    releasePlayer()
    setSpeaking(false)
  }, [releasePlayer])

  // ---- the keyboard (liveCapture.ts) ----

  // The one capture box, alive whether or not the popup shows: the closed
  // state hides by clipping, never `display: none`, so the box keeps focus —
  // and keeps receiving dictation — with the popup shut.
  const capture = useRef<HTMLTextAreaElement | null>(null)
  // When the last pointer/key gesture landed — the arbiter's only evidence.
  const gestureAt = useRef<number | null>(null)
  // Whether the person deliberately took focus elsewhere. A ref: it is read
  // and written from focus events and never rendered.
  const standingDown = useRef(false)
  // Mid-IME-composition, for the auto-send guard.
  const composing = useRef(false)

  useEffect(() => {
    // Capture phase, so the stamp lands before any focus change the gesture
    // causes is observed by the box's own blur handler.
    const stamp = () => {
      gestureAt.current = Date.now()
    }
    window.addEventListener('pointerdown', stamp, true)
    window.addEventListener('keydown', stamp, true)
    return () => {
      window.removeEventListener('pointerdown', stamp, true)
      window.removeEventListener('keydown', stamp, true)
    }
  }, [])

  const reclaim = useCallback(
    (cause: ReclaimCause, armed: { live: boolean; unlocked: boolean }) => {
      if (
        !shouldReclaimFocus({
          live: armed.live,
          unlocked: armed.unlocked,
          standingDown: standingDown.current,
          cause,
        })
      ) {
        return
      }
      // mesa acting is what re-arms a stood-down capture — and it also spends
      // whatever gesture is on the clock: a navigate's autofocus-then-blur
      // lands *between* this call and the deferred focus below, and a
      // keystroke that happened to precede the navigate must not let that
      // blur read as the person deliberately leaving.
      standingDown.current = false
      gestureAt.current = null
      // The focus itself is deferred a tick: called mid-blur or
      // mid-navigation, a synchronous focus() can be overridden by the very
      // move it is answering.
      window.setTimeout(() => {
        if (!standingDown.current) capture.current?.focus({ preventScroll: true })
      }, 0)
    },
    [],
  )
  // The handlers below run from media events and the run itself, long after
  // the render whose `live`/`unlocked` they must judge by — so the current
  // pair rides in a ref, the same pattern as `pump`.
  const armed = useRef({ live, unlocked })
  useEffect(() => {
    armed.current = { live, unlocked }
  }, [live, unlocked])

  // Joining is when capture starts: the same press that unlocks audio hands
  // mesa the keyboard. Edge-triggered on the pair going true together.
  useEffect(() => {
    if (live && unlocked) reclaim('went-live', { live, unlocked })
  }, [live, unlocked, reclaim])

  // A settled draft is sent on mesa's clock (dictation never presses Enter).
  // Everything the firing timer reads comes through refs, not the closure:
  // `draftRef` so a deadline racing an Enter send replays nothing (the send
  // already emptied it), `editedAt` so the idle threshold is measured rather
  // than assumed, and `refused` so a line the server rejected is not retried
  // every two seconds for ever — it waits to be edited (or sent by hand).
  const sendRef = useRef<() => void>(() => {})
  const draftRef = useRef('')
  const editedAt = useRef(0)
  const refused = useRef<string | null>(null)
  // Bumped when an IME composition commits: that commit changes no draft text
  // (the characters were already displayed), so without it nothing would ever
  // re-arm a timer the composition suppressed.
  const [composeTick, setComposeTick] = useState(0)
  useEffect(() => {
    if (!live || draft.trim() === '') return
    const timer = window.setTimeout(() => {
      const text = draftRef.current
      if (text.trim() === refused.current) return
      if (shouldAutoSend(text, Date.now() - editedAt.current, composing.current)) {
        sendRef.current()
      }
    }, AUTO_SEND_IDLE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, live, composeTick])

  /** The one write path for the draft: state for the render, refs for the timer. */
  const updateDraft = useCallback((value: string) => {
    draftRef.current = value
    editedAt.current = Date.now()
    setDraft(value)
  }, [])

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
        // mesa moved the browser, so the words that follow are still mesa's to
        // take — even if the person had deliberately clicked elsewhere before.
        reclaim('navigated', armed.current)
      }
      const sidebars = sidebarsIntent(turn)
      // Idempotent by construction: App holds the flags, so asking twice for
      // the state they are already in changes nothing.
      if (sidebars !== null) onSidebars(sidebars === 'collapse')
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

  // The header never unmounts, but strict-mode remounts in dev do pass here:
  // drop the body still arriving and hand the clock back.
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
    // `#/live` is a verb, not a place (see the intercept below), and this
    // listener runs before the intercept's — reporting the transient hash
    // would record a page that no longer exists.
    if (route === '#/live') return
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

  // `#/live` was the conversation's page (task 855); it is a verb now: the
  // agent's `navigate '#/live'` and the command palette both still land here,
  // and it opens the popup rather than a route — the hash is put back to
  // wherever the person last was, so the router underneath never shows an
  // empty page for it.
  const before = useRef('#/')
  useEffect(() => {
    const intercept = () => {
      const hash = window.location.hash
      if (hash === '#/live') {
        setOpen(true)
        // `replace`, not an assignment: the put-back must overwrite the
        // `#/live` history entry, or Back lands on it, the intercept fires
        // again and the person is trapped bouncing forward for ever.
        window.location.replace(before.current)
        return
      }
      if (hash !== '') before.current = hash
    }
    intercept()
    window.addEventListener('hashchange', intercept)
    return () => window.removeEventListener('hashchange', intercept)
  }, [])

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
      // start on whatever the conversation has already said. It is also the
      // moment capture takes the keyboard (the went-live effect above fires on
      // `unlocked` landing).
      pump.current()
      return
    }
    // A failed start leaves no session behind (the server ends the one it
    // opened), so nothing in the header would say what went wrong — the error
    // lives in the popup's status line, and the popup opens to show it.
    const failed = (err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err))
      setOpen(true)
    }
    if (button.action === 'start') {
      setPending('start')
      startLive().then(() => refetch(), failed).finally(() => setPending(null))
      return
    }
    setPending('stop')
    silence()
    stopLive().then(() => refetch(), failed).finally(() => setPending(null))
  }

  function send() {
    // Read through the ref, not the render's draft: an auto-send deadline
    // racing an explicit Enter finds the box already emptied and posts
    // nothing, instead of the same utterance twice.
    const text = draftRef.current.trim()
    if (text === '' || !live) return
    updateDraft('')
    sendLiveUtterance(text).then(
      () => {
        refused.current = null
        refetch()
      },
      (err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        // The failure is only visible inside the popup, so a closed one opens.
        setOpen(true)
        // The line was never recorded, so it belongs back in the box rather
        // than lost — re-dictating it is the one thing a person cannot redo.
        // Marked refused so the auto-send timer does not retry it unedited;
        // Enter remains the deliberate way to try the same text again.
        refused.current = text
        if (draftRef.current === '') updateDraft(text)
      },
    )
  }
  useEffect(() => {
    sendRef.current = send
  })

  const groups = turnGroups(turns)
  // Pulled out of the object so its narrowing survives into the handler below.
  const secondary = controls.secondary

  return (
    <div className="live-hub">
      {/* The talking indicator, centered in the header band (the header is the
          positioning context) — the visible sign she is speaking when the
          popup is closed. */}
      {speaking && (
        <div className="live-talk" aria-label="mesa is speaking" role="status">
          <span /><span /><span /><span /><span />
        </div>
      )}

      {controls.overlay && (
        <button
          type="button"
          className={`live-toggle live-overlay-toggle${open ? ' live-open' : ''}`}
          aria-label="show the conversation"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o)
            // A press on mesa's own controls hands the keyboard back to mesa.
            reclaim('hub-press', armed.current)
          }}
        >
          💬
        </button>
      )}
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

      {/* The popup — always mounted, hidden by clipping when closed, so the
          capture box inside keeps its focus (and the dictation flowing into
          it) across open/close. Closing is CSS only: no route, no stop. No
          `aria-hidden` while closed: the capture box inside deliberately
          keeps real focus, which aria-hidden forbids (browsers block it and
          screen readers lose the focus point) — the box IS the feature. */}
      <div className={`live-overlay${open ? '' : ' live-closed'}`}>
        <div className="live-overlay-head">
          <span className={actionError !== null ? 'error' : 'muted'}>
            {liveStatusLine(session, speaking, actionError)}
          </span>
          <button
            type="button"
            className="live-overlay-close"
            aria-label="hide the conversation"
            // Out of the tab order while clipped: an invisible button a Tab
            // can land on is a trap. The textarea stays tabbable — it is the
            // one element meant to hold focus while the popup is shut.
            tabIndex={open ? undefined : -1}
            onClick={() => {
              setOpen(false)
              reclaim('hub-press', armed.current)
            }}
          >
            ×
          </button>
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
                    {/* Plain text, never markdown: a mesa turn is prose meant
                        to be *spoken*, and a user turn is untrusted
                        dictation. */}
                    {turn.text !== '' && (
                      <div className="live-text">{turn.text}</div>
                    )}
                    {navigateTarget(turn) !== null && (
                      <div className="live-navigated">
                        went to {navigateTarget(turn)}
                      </div>
                    )}
                    {sidebarsIntent(turn) !== null && (
                      <div className="live-navigated">
                        {sidebarsIntent(turn) === 'collapse'
                          ? 'collapsed the sidebars'
                          : 'opened the sidebars'}
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
            ref={capture}
            className="live-input"
            rows={2}
            value={draft}
            disabled={!live}
            placeholder={
              live ? 'dictate here…' : 'go live to start the conversation'
            }
            aria-label="say something to mesa"
            onChange={(e) => updateDraft(e.target.value)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
              // Committing changes no text (it was already displayed), so
              // this tick is the only thing that re-arms a timer the open
              // composition suppressed.
              setComposeTick((t) => t + 1)
            }}
            onBlur={(e) => {
              // The arbiter: focus lost to somewhere a person types, on the
              // heels of a gesture, is them deliberately going elsewhere —
              // concede. Everything else — a page's autofocus after a
              // `navigate`, a click on a button or on nothing — is taken
              // back: none of it means "stop listening".
              const to = e.relatedTarget as HTMLElement | null
              if (
                to !== null &&
                isEditableTarget(to.tagName, to.isContentEditable) &&
                userTookFocus(gestureAt.current, Date.now())
              ) {
                standingDown.current = true
                return
              }
              reclaim('focus-lost-no-gesture', armed.current)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return
              // The Enter that commits an IME candidate is not a send: it
              // arrives as a plain `Enter` keydown with `isComposing` set, and
              // acting on it would ship half-converted text. The same guard,
              // for the same reason, as the agent chat composer's.
              if (e.nativeEvent.isComposing) return
              e.preventDefault()
              send()
            }}
          />
          <div className="live-hint muted">
            This is where system dictation types — while you are live, your
            words land here wherever the app has navigated, and a settled line
            is sent on its own. Enter sends at once; click into another field
            to type there instead. mesa captures no microphone of its own.
          </div>
        </form>
      </div>

      {/* One player for the whole app, mounted for its whole life: a press
          reaches it directly rather than mounting a new element, and its
          source is set imperatively. */}
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
