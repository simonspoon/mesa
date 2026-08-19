import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  getLive,
  getLiveConfig,
  liveSpeakUrl,
  markLiveTurnPlayed,
  reportLiveRoute,
  sendLiveUtterance,
  startLive,
  stopLive,
} from '../api'
import {
  autoSendIdleMs,
  isEditableTarget,
  shouldAutoSend,
  shouldReclaimFocus,
  userTookFocus,
  type ReclaimCause,
} from '../liveCapture'
import { currentContext, sameContext, subscribeContext } from '../liveContext'
import {
  audioInputs,
  chosenInput,
  DEFAULT_INPUT,
  inputLabel,
  offersInputChoice,
  readInputChoice,
  sameInputs,
  writeInputChoice,
  type AudioInput,
} from '../liveDevices'
import { headerIndicator, indicatorLabel } from '../liveIndicator'
import {
  captureHint,
  isBlockingError,
  isListenChord,
  LISTEN_CHORD,
  heldFlush,
  heldWith,
  readResults,
  recognitionCtor,
  recognizesSpeech,
  shouldListen,
  utteranceFrom,
  type SpeechRecognitionLike,
} from '../liveRecognition'
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
import type { ConfigLive } from '../types/ConfigLive'
import type { LiveContext } from '../types/LiveContext'
import type { LiveTurn } from '../types/LiveTurn'
import { useFetch } from '../useFetch'

/**
 * Mesa Live, in the header (mesa tasks 855, 857): the whole conversation lives
 * here now, not on a routed page.
 *
 * The person just talks: while the conversation is live and this browser has
 * joined it, the page opens the microphone through the browser's own speech
 * recognition (`liveRecognition.ts`, task 873) and **holds** every settled
 * result, sending the whole recording as one `user` turn when the person
 * stops listening (task 889) — listening being a switch of their own since
 * task 887, muted until the chord (`isListenChord`) or the panel's button
 * turns it on, and the same press is what ends the recording and sends it. The capture box
 * in the conversation panel stays as the fallback — a browser with no recognizer, or a refused
 * microphone, is the surface as it was: system dictation types into the box,
 * mesa holds the keyboard for it, and a settled line goes on a timer. Either
 * way the audio stays in the page: mesa ships no STT and no route takes an
 * audio body. An agent spawned
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
 *   just performed — cutting its own sentence off mid-word. Since task 887
 *   the panel it renders is a right-hand sidebar rather than a popup — a
 *   portal into App's slot, a sibling of the agents sidebar — but the
 *   component itself has not moved, and neither has the reason. The panel
 *   opens and closes without touching the session; only `End` ends it.
 * - **Pause is this browser's own** (task 882). Stepping out stops the run
 *   whole — no speech, no `navigate`, no sidebar fold — and shuts the
 *   microphone, while the session stays `live` and the agent keeps working;
 *   the turns pile up in the transcript and Resume performs them in order.
 *   No route, no session state: pausing a conversation is not the same event
 *   as ending one, and only one of the two is recoverable.
 * - **While joined and not recognizing, the capture box holds the keyboard**
 *   (`liveCapture.ts`): a `navigate` turn is mesa's doing, and the words after
 *   it are still meant for mesa, not for whatever field the opened page
 *   focused. A deliberate click into another field wins the fight and stands
 *   capture down; mesa's next action re-arms it. Dictation never presses
 *   Enter, so a draft that sits untouched for a beat is sent on mesa's own
 *   clock. With the microphone open none of that applies — a recognized
 *   sentence reaches the conversation with the keyboard anywhere — so both
 *   rules stand down and the box is a plain fallback.
 *
 * The two page verbs — `navigate` and the sidebar pair (task 859) — are both
 * performed here, in transcript order, when the run *reaches* the turn: the
 * browser moves and the panels fold where the sentence around them said they
 * would. The hub owns neither sidebar's state (App does, for both of them and
 * for the phone tab bar), so collapsing is one call back up.
 */
/**
 * The Mesa Live mark (mesa task 872), drawn rather than typed: the toggle used
 * to carry a 💬 emoji, which rendered in whatever emoji font the platform
 * picked — its own colour, its own weight, its own size, none of them the
 * button's. This is the same vocabulary as the brand mark and the inbox's
 * transport glyphs: one flat sharp-cornered polygon in `currentColor`, so it
 * takes the toggle's cyan-when-open and its hover state for free.
 *
 * The shape is a speech container built as the brand mark's ziggurat — a
 * narrower tier standing on a wider one — with a sharp tail dropped from the
 * base: a mesa that talks. One step rather than the brand mark's three,
 * because the stepping has to survive as *silhouette* at the ~14px this
 * renders at, and three tiers there stop reading as a plateau and start
 * reading as a lump.
 */
function LiveMark() {
  return (
    <svg
      className="live-mark"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="1,12 1,7 3,7 3,2 13,2 13,7 15,7 15,12 5,12 2,15 2,12" />
    </svg>
  )
}

/**
 * How long a route/context change settles before it is reported. Ambient
 * telemetry, so the wait costs nothing the person can feel; long enough that a
 * caret walking down a file or a tab being flicked through is one report
 * rather than a dozen.
 */
const REPORT_DEBOUNCE_MS = 300

export function LiveHub({
  onSidebars,
  slot,
}: {
  /** Fold both sidebars away (`true`) or bring them back. App owns that state
   *  — the hub only relays what the conversation asked for. */
  onSidebars: (collapsed: boolean) => void
  /** Where the conversation panel is rendered (mesa task 887): the shell's
   *  right-hand sidebar slot, `null` until App's own ref has landed. */
  slot: HTMLElement | null
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

  // The live section of `~/.mesa/config.json`, for the one value this page
  // reads out of it: how long a settled draft waits before it is sent (mesa
  // task 886). Asked once per conversation joined rather than on mount — the
  // hub is mounted for the life of the app, so reading it at start is what
  // makes an edit in Settings land on the next conversation without a reload.
  // `null` until it answers, and left `null` if it never does: the built-in
  // wait applies then (`autoSendIdleMs`), because a settings file must never
  // be what stalls a conversation.
  const [liveConfig, setLiveConfig] = useState<ConfigLive | null>(null)
  useEffect(() => {
    if (!live) return
    let dropped = false
    getLiveConfig().then(
      (config) => {
        if (!dropped) setLiveConfig(config)
      },
      () => {},
    )
    return () => {
      dropped = true
    }
  }, [live])
  const autoSendMs = autoSendIdleMs(liveConfig)

  // The transcript, accumulated: each poll answers only with what is new, so
  // this component holds the conversation and the server holds the tail.
  const [turns, setTurns] = useState<LiveTurn[]>([])
  const [pending, setPending] = useState<LivePending>(null)
  // The last failed call, or a synthesiser that refused — the status line's
  // top rank, since a panel that says "listening" after a failure is lying.
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
  // The conversation panel. Purely visual: closing it calls no route and stops
  // nothing — the session, the audio and the capture box all carry on.
  const [open, setOpen] = useState(false)
  // The person stepped out of the conversation without ending it (mesa task
  // 882): this browser speaks nothing, hears nothing and is driven nowhere
  // until Resume. Deliberately *this browser's* state and nothing more — no
  // route, no column, no effect on the session or the agent, which both carry
  // on. The ref beside it is what `run()`, the recognizer's lifecycle and the
  // auto-send deadline read, since all three run outside the render that
  // changed it; every write goes through `setPausedNow` so the two can never
  // disagree by a render.
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const setPausedNow = useCallback((next: boolean) => {
    pausedRef.current = next
    setPaused(next)
  }, [])
  // The person's own switch on the microphone (mesa task 887). Starts muted,
  // because a page that opens the microphone the moment a conversation starts
  // is listening to the room for the whole of it; asking for it is a keystroke
  // (`isListenChord`) or a press on the button in the conversation panel.
  // Browser-side and this browser's alone, like pause: no route, no session
  // state, and mesa carries on speaking while it is off. The ref is what the
  // recognizer's own handlers read, since they fire long after the render that
  // changed it — the same pairing as `pausedRef`.
  const [muted, setMuted] = useState(true)
  const mutedRef = useRef(true)
  const setMutedNow = useCallback((next: boolean) => {
    mutedRef.current = next
    setMuted(next)
  }, [])
  // The engine still guessing. Shown, and sent only as the tail of a flush
  // (`liveRecognition.ts`). The ref is what the listen switch reads: it flips
  // from a press, outside the render that last set this.
  const [interim, setInterim] = useState('')
  const interimRef = useRef('')
  const setInterimNow = useCallback((next: string) => {
    interimRef.current = next
    setInterim(next)
  }, [])
  // What the microphone has heard since the person turned it on (mesa task
  // 889) — settled sentences only, joined in the order they were said, and
  // held here until the switch goes off. Shown above the box, so a recording
  // is never something happening out of sight. The ref is read from the
  // recognizer's handlers and from the press that ends it, both of which run
  // outside the render that last changed it.
  const [recording, setRecording] = useState('')
  const recordingRef = useRef('')
  const setRecordingNow = useCallback((next: string) => {
    recordingRef.current = next
    setRecording(next)
  }, [])
  // The microphone was refused — by the person or by the browser's policy.
  // Terminal for this page: retrying would reopen the permission prompt for
  // ever, and the typed box is exactly the surface to fall back to.
  const [blocked, setBlocked] = useState(false)
  // Whether this browser has a recognizer at all. Asked once: it cannot change
  // under a loaded page, and every other decision reads the answer.
  const [supported] = useState(
    () => recognitionCtor(window as unknown as Record<string, unknown>) !== null,
  )
  // Which microphone to listen through (mesa task 884, `liveDevices.ts`), and
  // what there is to choose from. The list is the browser's, re-read whenever
  // it changes; the choice is this machine's, remembered across visits.
  const [inputs, setInputs] = useState<AudioInput[]>([])
  const [storedInput, setStoredInput] = useState(readInputChoice)
  // Whether this browser takes a track on `start()`. Assumed until it is
  // disproved by the one call that can disprove it — there is no probe for the
  // argument that does not involve opening a recognizer, and opening one is
  // exactly what asks a person for their microphone.
  const [routes, setRoutes] = useState(true)
  // A device that is here, is chosen, and will not open — another application
  // holding the input is the everyday case, and unlike an unplugged one it
  // never leaves `inputs`, so nothing else would stop mesa asking it again on
  // every turn for the rest of the conversation. Latched per device rather
  // than for the page: picking a different one is a fresh question, and so is
  // picking this one again after quitting whatever was holding it.
  const [refusedInput, setRefusedInput] = useState<string | null>(null)

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
  // see is the one thing the panel must never do. The clip-hidden closed state
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

  // The one capture box, alive whether or not the panel shows: the closed
  // state hides by clipping, never `display: none`, so the box keeps focus —
  // and keeps receiving dictation — with the panel shut.
  const capture = useRef<HTMLTextAreaElement | null>(null)
  // When the last pointer/key gesture landed — the arbiter's only evidence.
  const gestureAt = useRef<number | null>(null)
  // Whether the person deliberately took focus elsewhere. A ref: it is read
  // and written from focus events and never rendered.
  const standingDown = useRef(false)
  // Mid-IME-composition, for the auto-send guard.
  const composing = useRef(false)
  // The steady question — is the person talking to mesa through the microphone
  // — which is what the capture box's two rules and the composer's hint read.
  // Deliberately not `wantsMic` below: that one goes false for the length of
  // every reply, and a focus fight or an auto-send deadline that re-arms
  // itself while mesa speaks is decided by playback timing rather than by any
  // rule.
  const recognizes = recognizesSpeech({
    live,
    joined: unlocked,
    supported,
    blocked,
    paused,
    muted,
  })
  // The same answer for the two that read it outside a render: the focus
  // arbiter runs from blur handlers and the auto-send deadline from a timer.
  const listeningRef = useRef(false)
  useEffect(() => {
    listeningRef.current = recognizes
  }, [recognizes])

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
          listening: listeningRef.current,
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
  // The same, for the recognizer: its handlers are set once per start and post
  // sentences long after the render that installed them.
  const postRef = useRef<(text: string) => Promise<void>>(() => Promise.resolve())
  const draftRef = useRef('')
  const editedAt = useRef(0)
  const refused = useRef<string | null>(null)
  // Bumped when an IME composition commits: that commit changes no draft text
  // (the characters were already displayed), so without it nothing would ever
  // re-arm a timer the composition suppressed.
  const [composeTick, setComposeTick] = useState(0)
  useEffect(() => {
    // Paused, the box is disabled and nothing in it is an utterance the person
    // is still making — a deadline that fired here would send a line dictated
    // before they stepped out.
    if (!live || paused || draft.trim() === '') return
    const timer = window.setTimeout(() => {
      const text = draftRef.current
      if (text.trim() === refused.current) return
      if (
        shouldAutoSend(
          text,
          Date.now() - editedAt.current,
          composing.current,
          listeningRef.current,
          autoSendMs,
        )
      ) {
        sendRef.current()
      }
    }, autoSendMs)
    return () => window.clearTimeout(timer)
    // `recognizes` is a dependency, not just a read inside the timer: a draft
    // left in the box when recognition stops being the way in (the microphone
    // refused, the browser's answer changing) must get its deadline back
    // rather than sit there for ever because the decision was sampled once.
  }, [draft, live, paused, composeTick, recognizes, autoSendMs])

  /** The one write path for the draft: state for the render, refs for the timer. */
  const updateDraft = useCallback((value: string) => {
    draftRef.current = value
    editedAt.current = Date.now()
    setDraft(value)
  }, [])

  // ---- the microphone (liveRecognition.ts, liveDevices.ts) ----

  /**
   * The microphones this machine offers. Asked on mount, again on every
   * `devicechange` (a headset plugged in mid-conversation is the whole point
   * of the control), and again whenever a recognizer starts — a browser
   * redacts every device *label* until microphone permission has been granted,
   * and starting one is what grants it, so that is when the numbered
   * placeholders turn into real names.
   */
  const listInputs = useCallback(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    media
      .enumerateDevices()
      .then((devices) => {
        const next = audioInputs(devices)
        setInputs((prev) => (sameInputs(prev, next) ? prev : next))
      })
      // A browser that will not enumerate offers no choice — which is exactly
      // what an empty list says, and there is nothing else worth reporting:
      // the conversation still listens through the default.
      .catch(() => setInputs([]))
  }, [])

  useEffect(() => {
    if (!supported) return
    listInputs()
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    media.addEventListener('devicechange', listInputs)
    return () => media.removeEventListener('devicechange', listInputs)
  }, [supported, listInputs])

  // Whether the header offers the chooser at all — and, because the two must
  // never disagree, the same answer decides whether a device is routed. A
  // choice still in force under a withdrawn control is one nobody can undo:
  // unplug the second microphone and the dropdown goes, but without this the
  // survivor would still be opened through `getUserMedia` for ever rather than
  // falling back to the untouched call.
  const choosesInput = offersInputChoice({ supported, routes, inputs })
  // The device to listen through: the remembered one while it is still here
  // and still opens, and the browser's own default otherwise.
  const chosen =
    choosesInput && storedInput !== refusedInput
      ? chosenInput(storedInput, inputs)
      : DEFAULT_INPUT

  const wantsMic = shouldListen({
    live,
    joined: unlocked,
    supported,
    blocked,
    paused,
    muted,
    speaking,
  })
  // Whether the conversation still wants the microphone, for the handler that
  // learns the engine stopped: `onend` fires from the browser's own schedule,
  // outside any render, and it is where restarting is decided.
  const wants = useRef(wantsMic)
  useEffect(() => {
    wants.current = wantsMic
  }, [wantsMic])

  /**
   * The person's switch on the microphone (mesa task 887) — one write path,
   * because muting is never only a mute: it changes *how the person talks to
   * mesa*, and the keyboard has to follow.
   *
   * `reclaim` decides on `listeningRef`, which the render's effect only
   * rewrites on the *next* pass — so read from here it still holds the answer
   * from before the press, and a mute would leave the box unfocused at the
   * exact moment typing became the only way in. Answer the question for the
   * page this press makes and write it first; the effect re-affirms the same
   * value a render later. Identical, for the identical reason, to
   * `togglePause`.
   */
  /**
   * Send the recording and let go of it (mesa task 889) — the held sentences
   * plus the one the engine has not settled yet, which is what the person had
   * just finished saying when they reached for the switch.
   *
   * Deliberately **not** gated on `paused`. That gate belongs to a single
   * pending final — the half-sentence a pause cut off — and does not transfer
   * to a recording made before the pause: those words were said to this
   * conversation, and destroying two minutes of them because the person
   * stepped out first is the one outcome nothing here can undo. A pause holds
   * the recording; only this sends it, and only ending the conversation throws
   * it away.
   *
   * Ordered rather than fired together: a split recording is still one thing
   * the person said.
   */
  const flushRecording = useCallback(() => {
    const texts = heldFlush(recordingRef.current, interimRef.current)
    setRecordingNow('')
    setInterimNow('')
    if (!armed.current.live) return
    texts.reduce(
      (queue, text) => queue.then(() => postRef.current(text)),
      Promise.resolve(),
    )
  }, [setInterimNow, setRecordingNow])
  const flushRef = useRef(flushRecording)
  useEffect(() => {
    flushRef.current = flushRecording
  }, [flushRecording])

  const toggleListening = useCallback(
    (next: boolean) => {
      // The switch off is the send; the switch on starts a fresh recording,
      // because a recording belongs to the stretch of listening it was made
      // in. Either way nothing is left held.
      if (next) flushRecording()
      else {
        setRecordingNow('')
        setInterimNow('')
      }
      setMutedNow(next)
      listeningRef.current = recognizesSpeech({
        live,
        joined: unlocked,
        supported,
        blocked,
        paused,
        muted: next,
      })
      // Muted, the typed box is the way in again and takes the keyboard back;
      // unmuted, `reclaim` declines, as it should — a recognized sentence
      // reaches the conversation with the keyboard anywhere.
      reclaim('hub-press', armed.current)
    },
    [
      blocked,
      flushRecording,
      live,
      paused,
      reclaim,
      setRecordingNow,
      setInterimNow,
      setMutedNow,
      supported,
      unlocked,
    ],
  )

  // The chord that opens and shuts the microphone (mesa task 887). A window
  // listener of the hub's own, in the shape of the command palette's, because
  // the capture box holds the keyboard for most of a conversation: the switch
  // has to be reachable from inside a focused text field, which is the whole
  // reason it is a chord rather than a key (`isListenChord`).
  //
  // Always `preventDefault`, like the palette's: whatever the browser does
  // with this chord, the conversation's microphone is the stronger claim
  // while mesa is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isListenChord(e)) return
      e.preventDefault()
      toggleListening(!mutedRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleListening])

  useEffect(() => {
    if (!wantsMic) return
    const Recognizer = recognitionCtor(window as unknown as Record<string, unknown>)
    if (Recognizer === null) return
    // This effect's own run. A recognizer stopped by the cleanup below still
    // fires its `end`, and that echo must not restart the microphone the
    // cleanup just closed.
    let running = true
    let current: SpeechRecognitionLike | null = null
    // The chosen microphone's stream, held for as long as this effect run is:
    // the engine ends and reopens by itself (the ~60s cap, a long silence),
    // and reacquiring the device on each of those would blink the browser's
    // recording indicator through a quiet stretch nothing changed in.
    //
    // It is deliberately NOT held across mesa speaking. `wantsMic` goes false
    // for the length of every reply, so this run ends and the device closes —
    // which is the promise `shouldListen` makes made visible: while mesa
    // talks, the microphone is shut, and an indicator still lit would say the
    // opposite. The cost is one `getUserMedia` per turn on the chosen-device
    // path, against a permission already granted.
    //
    // Null while the default is chosen — that path opens no device of mesa's
    // own at all.
    let stream: MediaStream | null = null

    /**
     * The track to listen through, or `undefined` for the untouched call.
     * Re-acquired when the held one is no longer live: a track can be stopped
     * from outside the page (unplugged, or claimed by another application) and
     * `start()` refuses one that is not live.
     */
    const microphone = async (): Promise<MediaStreamTrack | undefined> => {
      if (chosen === DEFAULT_INPUT) return undefined
      const media = navigator.mediaDevices
      if (!media?.getUserMedia) return undefined
      const held = stream?.getAudioTracks().find((t) => t.readyState === 'live')
      if (held) return held
      stream?.getTracks().forEach((t) => t.stop())
      stream = await media.getUserMedia({ audio: { deviceId: { exact: chosen } } })
      return stream.getAudioTracks()[0]
    }

    /**
     * Start one engine, on the given track or on the browser's default.
     *
     * A `TypeError` from a track is this browser saying it has no such
     * argument (Safari, and Chromium before 135). That is not a failure to
     * report — nothing was opened and nothing was lost — it is the answer to a
     * question mesa could not ask any other way: stop offering the chooser and
     * listen exactly as mesa always did.
     */
    const startWith = (engine: SpeechRecognitionLike, track?: MediaStreamTrack) => {
      try {
        // Two calls rather than one with an optional argument: Chrome's
        // `start(undefined)` is a `TypeError`, not an omitted argument, so
        // forwarding a `track` that happens to be undefined would break the
        // default path — the one path that has to keep working everywhere.
        if (track === undefined) engine.start()
        else engine.start(track)
      } catch (err: unknown) {
        if (track !== undefined) {
          // A `TypeError` is this browser saying it has no such argument; a
          // track that ended between the liveness check and this call is the
          // other way here. Either way the engine did not start and the
          // default still would, so fall back to it rather than leaving the
          // conversation deaf until something else moves.
          if (err instanceof TypeError) setRoutes(false)
          else setRefusedInput(chosen)
          startWith(engine)
          return
        }
        // A refused start fires no `start` and no `end`, so nothing here will
        // reopen it — say so rather than going quiet, and let the next change
        // of the answer (mesa's next reply ending, most likely) try again.
        if (running) setActionError(err instanceof Error ? err.message : String(err))
      }
    }

    const open = () => {
      const engine = new Recognizer()
      current = engine
      // How far this engine's own results list has been consumed. Per engine:
      // a restart is a new list, starting again at zero.
      let settled = 0
      // Continuous so a pause is a sentence rather than the end of listening,
      // interim so the person can see they are being heard.
      engine.continuous = true
      engine.interimResults = true
      engine.onresult = (event) => {
        const heard = readResults(Math.max(event.resultIndex, settled), event.results)
        settled = heard.settledThrough
        if (running) setInterimNow(heard.interim)
        const text = utteranceFrom(heard.final)
        if (text === null) return
        // Not guarded on `running`: `stop()` below delivers whatever was
        // pending as a final, and that is the sentence the person was still
        // finishing as mesa began to speak — heard before the audio started,
        // so it is theirs, not an echo, and it belongs in the recording. Three
        // stops *do* drop it, and for the same reason: it is not part of any
        // recording that will be sent. The conversation ending is one. A
        // **pause** is the other (task 882) — the person pressed a button that
        // means "hear nothing from me", and the pending sentence is exactly
        // what they were saying when they pressed it. `setPausedNow(true)`
        // runs before this effect's cleanup calls `stop()`, so the ref is
        // already true by the time that final arrives. A **mute** is the third,
        // and all but never a loss: the press already flushed the recording
        // with this very sentence's preview on the end of it (`heldFlush`), so
        // taking the late final too would say it twice. The exception is a
        // mute landing in the gap between mesa starting to speak — which
        // clears the preview on its way past — and the stop that gap caused
        // delivering the final. That sentence goes; it is the same sentence the
        // pre-889 page dropped on a mute, and closing it would mean holding a
        // preview mesa is already talking over.
        if (running) {
          // The preview is cleared here rather than waiting for the next
          // event: the words it showed have just been recorded, and leaving
          // them under the box would read as a second sentence still coming.
          setInterimNow('')
        }
        if (armed.current.live && !pausedRef.current && !mutedRef.current) {
          // Held, not posted (task 889): the recording is one turn, and the
          // person's own switch is what ends it. `flush` is only the cap.
          const grown = heldWith(recordingRef.current, text)
          setRecordingNow(grown.held)
          if (grown.flush !== null) void postRef.current(grown.flush)
        }
      }
      engine.onerror = (event) => {
        if (!running) return
        if (!isBlockingError(event.error)) return
        // Not an error the conversation recovers from: say so once, in the
        // status line, and leave the typed box as the way in.
        setBlocked(true)
        setActionError(`the microphone is unavailable (${event.error})`)
        // And send what it did hear (task 889). A refusal withdraws the listen
        // button — `blocked` is one of its four conditions — so the recording
        // would otherwise sit on screen with no control left to deliver it.
        // The microphone dying mid-sentence is the everyday case: another
        // application takes the device, or the permission is revoked from the
        // omnibox.
        flushRef.current()
      }
      engine.onend = () => {
        if (!running) return
        setInterimNow('')
        // The browser ends recognition by itself — after about a minute, and
        // on a long enough silence — and reports it as an ordinary end. So the
        // question is asked again rather than retried: as long as the
        // conversation still wants the microphone, open a new one.
        if (wants.current) open()
      }
      // Real names for the devices: permission is granted by the time an
      // engine starts, so this is when the numbered placeholders resolve.
      engine.onstart = listInputs
      microphone()
        .then((track) => {
          if (running) {
            startWith(engine, track)
            return
          }
          // The conversation stopped while the device was still opening. The
          // cleanup below already ran, at a moment when there was no stream to
          // close, so closing it is this branch's job — a track nothing will
          // ever listen to leaves the browser's recording indicator lit with
          // nobody on the other end of it.
          stream?.getTracks().forEach((t) => t.stop())
          stream = null
        })
        .catch((err: unknown) => {
          if (!running) return
          // The named device is gone, or the permission behind it was refused.
          // Listen through the default rather than not at all — a conversation
          // that hears nothing is worse than one that hears the wrong
          // microphone — and say which it is, because the chooser above will
          // still be showing the device that is not being used.
          setActionError(
            `that microphone is unavailable (${
              err instanceof Error ? err.message : String(err)
            }) — listening through the default`,
          )
          // Asked once. A device that is gone drops out of `inputs` on its own
          // and needs nothing; one that is still listed and still refuses —
          // another application has it — would otherwise be asked again at
          // every reply, for ever, with the same failure and the same line.
          setRefusedInput(chosen)
          startWith(engine)
        })
    }
    open()

    return () => {
      running = false
      // The preview goes; the recording does not. This cleanup runs every time
      // mesa starts speaking, and a recording that emptied itself for the
      // length of each of her replies would keep almost nothing (task 889).
      setInterimNow('')
      current?.stop()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [wantsMic, chosen, listInputs, setInterimNow, setRecordingNow])

  // The run: the oldest mesa turn nobody has played, one at a time. A turn that
  // navigates moves the browser when it is *reached*, whether or not it also
  // speaks — the order of the conversation is the order of the turns.
  function run() {
    const ctx = clock.current
    // Paused: the whole run stops, not just the audio. A turn that navigated
    // or folded the sidebars while the person had stepped out would be the
    // conversation driving a browser nobody is listening to — and the turns
    // are still there, so Resume performs them in order rather than losing
    // them.
    if (pausedRef.current) return
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
    if (wasLive.current && !live) {
      silence()
      // Pause is about a conversation that is still running, so it does not
      // outlive one: the next `Go live` starts talking rather than starting
      // paused with no control on screen to say why.
      setPausedNow(false)
      // Nor does a recording (task 889): it was said to a conversation that no
      // longer exists, and nothing will ever send it.
      setRecordingNow('')
      setInterimNow('')
    }
    wasLive.current = live
  }, [live, silence, setPausedNow, setRecordingNow, setInterimNow])

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

  // The agent reads this to know what the person is looking at, in two halves:
  // which page (the route) and what is in focus on it (the context, published
  // up from the page through `liveContext.ts` — the hub is mounted in the
  // header for the life of the app and the pages are deep under it, so a page
  // cannot report for itself). Ambient, like the inbox's read mark: a failure —
  // no live session, most often — is forgotten rather than shown.
  //
  // One shared *trailing* debounce over the combined report, deliberately.
  // Context changes far faster than the route does — a selection moving, a
  // file tab switching, a caret crossing a line — and this is telemetry the
  // agent reads when it is asked a question, not a command anything is waiting
  // on. A route change rides in the same window rather than jumping the queue
  // because the two are *one* report: reporting them separately would mean two
  // writes that can disagree about which page a focus is on, and a page that
  // lands a fifth of a second late is still there long before the person has
  // finished saying the sentence that follows it.
  const reportTimer = useRef<number | null>(null)
  const reported = useRef<{ route: string; context: LiveContext | null } | null>(null)
  const reportRoute = useCallback(() => {
    if (reportTimer.current !== null) window.clearTimeout(reportTimer.current)
    reportTimer.current = window.setTimeout(() => {
      reportTimer.current = null
      const route = window.location.hash || '#/'
      // `#/live` is a verb, not a place (see the intercept below) — reporting
      // that hash would record a page that no longer exists.
      if (route === '#/live') return
      if (!route.startsWith('#/') || route.length > 200) return
      // Read the focus *now* rather than closing over what it was when the
      // report was scheduled: the whole point of waiting is to send the
      // settled value, not the one that started the flurry.
      const context = currentContext()
      const last = reported.current
      if (last !== null && last.route === route && sameContext(last.context, context)) {
        return
      }
      // Remembered only once it landed, so a failed report is retried by the
      // next trigger rather than being treated as already told.
      reportLiveRoute(route, context)
        .then(() => {
          reported.current = { route, context }
        })
        .catch(() => {})
    }, REPORT_DEBOUNCE_MS)
  }, [])
  useEffect(() => {
    reportRoute()
    window.addEventListener('hashchange', reportRoute)
    // A change of focus on the page already open is the fourth trigger: same
    // route, different answer to "what is this?".
    const offContext = subscribeContext(reportRoute)
    return () => {
      window.removeEventListener('hashchange', reportRoute)
      offContext()
      if (reportTimer.current !== null) window.clearTimeout(reportTimer.current)
    }
  }, [reportRoute])
  // Going live is the other moment this matters: the session that just started
  // has no idea where its person already is.
  useEffect(() => {
    if (live) reportRoute()
  }, [live, reportRoute])

  // `#/live` was the conversation's page (task 855); it is a verb now: the
  // agent's `navigate '#/live'` and the command palette both still land here,
  // and it opens the panel rather than a route — the hash is put back to
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

  const controls = liveControls(session, pending, unlocked, paused)

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
    // lives in the panel's status line, and the panel opens to show it.
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

  /**
   * Stepping out of the conversation, and back in (mesa task 882).
   *
   * Deliberately not part of `act`: this calls no route, spends no gesture and
   * touches neither `unlocked` nor the session. Pausing silences whatever was
   * sounding — the same `silence()` ending a conversation uses, so the turn it
   * cut off stays in `handled` and is not said again on Resume; it is still
   * there to read in the transcript. Resuming just starts the run, which
   * catches up on everything that landed in the meantime, in order.
   */
  function togglePause(button: LiveButton) {
    if (button.action === 'pause') {
      silence()
      setPausedNow(true)
      return
    }
    setPausedNow(false)
    // `reclaim` decides on `listeningRef`, which the render's effect only
    // rewrites on the *next* pass — so read from here it still holds the
    // paused answer (`false`), and capture would grab the keyboard even where
    // the microphone is the way in. Answer the question for the resumed page
    // and write it first; the effect re-affirms the same value a render later.
    listeningRef.current = recognizesSpeech({
      live,
      joined: unlocked,
      supported,
      blocked,
      paused: false,
      muted: mutedRef.current,
    })
    // A press on mesa's own controls hands the keyboard back — which is what
    // this does wherever the typed box is the way in. With the microphone
    // open `reclaim` now declines, as it should: a recognized sentence reaches
    // the conversation with the keyboard anywhere.
    reclaim('hub-press', armed.current)
    pump.current()
  }

  function send() {
    // Read through the ref, not the render's draft: an auto-send deadline
    // racing an explicit Enter finds the box already emptied and posts
    // nothing, instead of the same utterance twice.
    const text = draftRef.current.trim()
    if (text === '' || !live) return
    updateDraft('')
    post(text)
  }

  /**
   * The one way an utterance leaves this page — typed, or heard. Returns the
   * request so a flush of more than one turn can send them **in order**: a
   * recording that had to be split is still one thing the person said, and
   * two overlapping writes could land the halves the wrong way round.
   */
  function post(text: string) {
    return sendLiveUtterance(text).then(
      () => {
        refused.current = null
        refetch()
      },
      (err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        // The failure is only visible inside the panel, so a closed one opens.
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
    postRef.current = post
  })

  // What the header band says about the conversation (`liveIndicator.ts`):
  // mesa speaking, the person being heard, or the microphone simply open.
  const indicator = headerIndicator({
    live,
    joined: unlocked,
    speaking,
    recognizes,
    // The recording counts as being heard (task 889): between two settled
    // sentences the guess is empty for a beat, and bars that drop back to
    // "listening" there would say mesa had taken what was said and moved on
    // — when in fact it is still held, waiting for the switch.
    interim: interim !== '' ? interim : recording,
    draft,
    paused,
  })

  const groups = turnGroups(turns)
  // Pulled out of the object so its narrowing survives into the handler below.
  const secondary = controls.secondary
  const pauseButton = controls.pause

  return (
    <div className="live-hub">
      {/* The conversation indicator, centered in the header band (the header is
          the positioning context) — with the panel closed it is the only sign
          of either side talking. One element in three states, so the band
          never shows two things at once (`liveIndicator.ts`). */}
      {indicator !== null && (
        <div
          className={`live-talk live-talk-${indicator}`}
          aria-label={indicatorLabel(indicator)}
          role="status"
        >
          <span /><span /><span /><span /><span />
        </div>
      )}

      {controls.panel && (
        <button
          type="button"
          className={`live-toggle live-panel-toggle${open ? ' live-open' : ''}`}
          aria-label="show the conversation"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o)
            // A press on mesa's own controls hands the keyboard back to mesa.
            reclaim('hub-press', armed.current)
          }}
        >
          <LiveMark />
        </button>
      )}
      {/* Stepping out without ending it (mesa task 882) — offered only while
          the conversation is live and this browser is in it. Sits before the
          primary control so the press that destroys the conversation stays
          where it has always been: last. */}
      {pauseButton && (
        <button
          type="button"
          className={`live-toggle${paused ? ' live-paused' : ''}`}
          disabled={pauseButton.disabled}
          onClick={() => togglePause(pauseButton)}
        >
          {pauseButton.label}
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

      {/* The conversation itself, portalled into the shell's flex row as a
          right-hand sidebar (mesa task 887) — a sibling of the agents one, so
          both can be open at once, either alone, or neither; the popup this
          replaces covered the page it was talking about. The *component*
          stays in the header, because everything that makes it work is
          anchored there (see the module note), so only the rendered panel
          moves — into the slot App keeps in the shell's flex row, which is
          the one place a sidebar can take width from `main` instead of
          floating over it. The slot arrives as a prop rather than being
          looked up here: App renders it in the same commit as this component,
          so there is nothing to find until afterwards.

          It is always mounted and never `display: none`, closed or open, for
          the reason it always was: the capture box inside keeps its focus,
          and the dictation flowing into it, across a close. No `aria-hidden`
          while closed either — the box deliberately keeps real focus, which
          aria-hidden forbids. Closing is CSS width: no route, no stop. */}
      {slot !== null &&
        createPortal(
          <aside
            className={`live-sidebar${open ? '' : ' collapsed'}`}
            aria-label="the live conversation"
          >
            <div className="live-sidebar-body">
              <div className="live-sidebar-head">
                <span className={actionError !== null ? 'error' : 'muted'}>
                  {liveStatusLine(session, speaking, actionError, paused)}
                </span>
                <button
                  type="button"
                  className="live-sidebar-close"
                  aria-label="hide the conversation"
                  // Out of the tab order while clipped: an invisible button a Tab
                  // can land on is a trap. The textarea stays tabbable — it is the
                  // one element meant to hold focus while the panel is shut.
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
                {/* How mesa hears this room: the switch, and the microphone
                    it listens through (mesa tasks 887 and 884). Both belong
                    here rather than in the header cluster beside the presses
                    — they are settings on the conversation's input, read at
                    the moment the person is deciding whether to talk or to
                    type, and the header is where the press that destroys the
                    conversation lives. */}
                <div className="live-listen-row">
                  {/* Offered on the same terms as Pause: there is a live
                      conversation, this browser is in it, and the microphone
                      could actually open — a browser with no recognizer, or
                      one whose microphone was refused, has nothing for this
                      switch to do, and the hint below says which of the two
                      it is. A button reading "listening" before the
                      conversation has started would claim something that is
                      not happening. */}
                  {live && unlocked && supported && !blocked && (
                    <button
                      type="button"
                      className={`live-listen${muted ? '' : ' live-on'}`}
                      aria-pressed={!muted}
                      // Out of the tab order while the panel is clipped, for
                      // the same reason the close button is: `pointer-events`
                      // stops the mouse, not a Tab, and an invisible control
                      // that toggles the microphone on Enter is worse than a
                      // button nobody can reach.
                      tabIndex={open ? undefined : -1}
                      title={`${
                        muted ? 'Listen through this browser' : 'Stop listening'
                      } (${LISTEN_CHORD})`}
                      onClick={() => toggleListening(!muted)}
                    >
                      {muted ? 'listen' : 'listening'}
                    </button>
                  )}
                  {/* Offered only where there is more than one microphone and
                      the browser takes a track (`liveDevices.ts`) — a control
                      that cannot change what mesa hears is worse than no
                      control. */}
                  {choosesInput && (
                    <select
                      className="live-input-choice"
                      aria-label="microphone"
                      tabIndex={open ? undefined : -1}
                      value={chosen}
                      onChange={(event) => {
                        const next = event.target.value
                        writeInputChoice(next)
                        setStoredInput(next)
                        // Choosing is asking again: a device that refused
                        // before may be free now, and the person picking it is
                        // who decides to retry.
                        setRefusedInput(null)
                        reclaim('hub-press', armed.current)
                      }}
                    >
                      <option value={DEFAULT_INPUT}>Default mic</option>
                      {inputs.map((input, index) => (
                        <option key={input.deviceId} value={input.deviceId}>
                          {inputLabel(input, index)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <textarea
                  ref={capture}
                  className="live-input"
                  rows={2}
                  value={draft}
                  // Paused is the same answer as not-live for the box: nothing typed
                  // here would be heard until Resume, and a field that accepts words
                  // nobody will read is worse than one that says it is shut.
                  disabled={!live || paused}
                  placeholder={
                    !live
                      ? 'go live to start the conversation'
                      : paused
                        ? 'paused — press Resume to talk to mesa'
                        : recognizes
                          ? 'listening — or type here'
                          : 'dictate or type here…'
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
                {/* The recording (task 889): every settled sentence since the
                    switch went on, with whatever the engine is still guessing
                    at on the end of it. Shown together because they are one
                    thing to the person — what mesa will be told when they stop
                    listening — and shown at all because a microphone recording
                    out of sight is the thing this must never be. */}
                {(recording !== '' || interim !== '') && (
                  <div className="live-interim">
                    {recording}
                    {recording !== '' && interim !== '' ? ' ' : ''}
                    {/* The live region is the *guess*, not the recording it is
                        joined onto: announcing the whole thing again on every
                        interim update would read the last two minutes back to
                        a screen reader once a second. Each sentence is
                        announced while it is still being guessed at, which is
                        when it is news. */}
                    {interim !== '' && (
                      <span className="live-guessing" aria-live="polite">
                        {interim}
                      </span>
                    )}
                  </div>
                )}
                <div className="live-hint muted">
                  {captureHint({
                    live,
                    joined: unlocked,
                    supported,
                    blocked,
                    listening: recognizes,
                    paused,
                    muted,
                  })}{' '}
                  {!paused && 'Enter sends at once.'}
                </div>
              </form>
            </div>
          </aside>,
          slot,
        )}

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
