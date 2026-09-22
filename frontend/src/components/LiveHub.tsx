import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { LiveBand } from './LiveBand'
import { LiveBoardPanel } from './LiveBoardPanel'
import { LiveMeter } from './LiveMeter'
import {
  claimLiveSpeaker,
  getLive,
  getLiveConfig,
  listProjects,
  liveSpeakUrl,
  markLiveTurnPlayed,
  reportLiveRoute,
  sendLiveNotice,
  sendLiveUtterance,
  startLive,
  stopLive,
  transcribeAudio,
  transcribeAvailable,
} from '../api'
import {
  capturesAudio,
  dropBefore,
  frameRms,
  isMicRefusal,
  PCM_WORKLET_SOURCE,
  TARGET_SAMPLE_RATE,
  toBase64,
  wavFromFrames,
  type CapturedFrame,
} from '../liveAudio'
import {
  boardPanelFor,
  closedBoardPanel,
  openBoardPanel,
  showsBoardReopen,
  type BoardPanel,
} from '../liveBoard'
import {
  autoSendIdleMs,
  isEditableTarget,
  shouldReclaimFocus,
  userTookFocus,
  type ReclaimCause,
} from '../liveCapture'
import { currentContext, sameContext, subscribeContext } from '../liveContext'
import { mayHold, SegmentChain } from '../liveDrain'
import { isPausePhrase } from '../livePausePhrase'
import { liveClientId, takesToSpeak } from '../liveSpeaker'
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
import { MIN_MAIN_WIDTH } from '../agentSidebarWidth'
import { chordLabel, matchesShortcut } from '../keymap'
import { useKeymap } from '../keymapStore'
import { elapsedLabel, endsInHead, liveHeadTitle } from '../liveHead'
import { headerIndicator } from '../liveIndicator'
import {
  buildVocabulary,
  captureHint,
  correctVocabulary,
  isBlockingError,
  isSilentTranscribe,
  HEARING_HOLD_MS,
  LISTEN_CHORD,
  heldFlush,
  heldWith,
  listenPath,
  MESA_VOCABULARY,
  readResults,
  recognitionCtor,
  recognizesSpeech,
  shouldBargeIn,
  shouldFlushSilence,
  speechHeardAt,
  shouldListen,
  showsHearing,
  statusPill,
  utteranceFrom,
  type ListenPath,
  type SpeechRecognitionLike,
  type Vocabulary,
} from '../liveRecognition'
import {
  isLive,
  liveControls,
  liveStatusLine,
  type LiveButton,
  type LivePending,
} from '../liveSession'
import {
  actsOn,
  advanceCursor,
  navigateTarget,
  pendingTurns,
  releaseForReplay,
  sidebarsIntent,
  spokenText,
  transcriptFor,
  turnGroups,
  turnLabel,
} from '../liveTurns'
import {
  clampLiveSidebarWidth,
  clearLiveSidebarWidth,
  loadLiveSidebarWidth,
  saveLiveSidebarWidth,
} from '../liveSidebarWidth'
import { BARGE_IN_VAD, DEFAULT_VAD, initialVad, PRE_ROLL_MS, vadCut, vadStep } from '../liveVad'
import {
  initialWatchdog,
  noticeInSpan,
  shouldNoticePermission,
  watchdogAfterPoll,
  type Watchdog,
} from '../liveWatchdog'
import { sameBox, windowBox } from '../liveWindow'
import { playFailure } from '../speechPlayback'
import { playSpeechStream, type SpeechStream } from '../speechStream'
import { parseTimestamp } from '../time'
import type { ConfigLive } from '../types/ConfigLive'
import type { LiveContext } from '../types/LiveContext'
import type { LiveNotice } from '../types/LiveNotice'
import type { LiveState } from '../types/LiveState'
import type { LiveTurn } from '../types/LiveTurn'
import type { LiveWindow } from '../types/LiveWindow'
import { useFetch } from '../useFetch'

/**
 * Mesa Live, in the header (mesa tasks 855, 857): the whole conversation lives
 * here now, not on a routed page.
 *
 * The person just talks: joining a live conversation opens the microphone on
 * its own (task 917) through page-side audio capture (`liveAudio.ts`,
 * `liveVad.ts`, task 956) — an `AudioWorkletProcessor` hands this component
 * raw blocks, a voice-activity state machine decides where one utterance ends
 * and the next begins, matching the breath the browser's `SpeechRecognition`
 * used to settle a final result on, and each finished segment is posted as a
 * WAV to `POST /api/live/transcribe`, which hands it to the external `auris`
 * binary and answers with text — **where a machine has it installed**. Task
 * 957 makes that an upgrade rather than a dependency: a probe on mount
 * (`transcribeAvailable`) decides between auris and the browser's own
 * `SpeechRecognition` (task 873's original path, restored rather than
 * replaced) as this page's `ListenPath` (`liveRecognition.ts::listenPath`),
 * and only one of the two capture effects below ever runs at a time. That
 * text enters the **existing** held-
 * recording path (`liveRecognition.ts`, task 873) completely unchanged: it
 * **holds** every settled utterance and sends the whole recording as one
 * `user` turn once the person goes quiet — the wait `live.auto-send-ms`
 * names — with the listen switch (the `live-listen` chord or the panel's
 * button, task
 * 887) as an explicit early send; the same press is also what mutes the
 * microphone and keeps it muted for the rest of that session. The capture box
 * in the conversation panel stays as the fallback — a browser with no way to
 * capture audio, or a refused microphone, is the surface as it was: system
 * dictation types into the box, mesa holds the keyboard for it, and a line is
 * sent by Enter alone (mesa task 977). Either way this is now the **only**
 * place audio leaves the page: each segment travels once, as one bounded WAV, to that one
 * route, decoded locally by `auris` and never retained (`docs/live.md`). An
 * agent spawned by `Go live` pulls those over the CLI and answers with `mesa live say`,
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
 *   the turns pile up in the transcript and Resume performs them in order,
 *   starting with the sentence the pause cut off, from its beginning (mesa
 *   task 1161).
 *   No route, no session state: pausing a conversation is not the same event
 *   as ending one, and only one of the two is recoverable.
 * - **While joined and not recognizing, the capture box holds the keyboard**
 *   (`liveCapture.ts`): a `navigate` turn is mesa's doing, and the words after
 *   it are still meant for mesa, not for whatever field the opened page
 *   focused. A deliberate click into another field wins the fight and stands
 *   capture down; mesa's next action re-arms it. The typed box itself is sent
 *   by Enter alone (mesa task 977) — only a *transcribed* recording is sent
 *   on mesa's own clock. With the microphone open the focus fight does not
 *   apply — a recognized sentence reaches the conversation with the keyboard
 *   anywhere — so that rule stands down and the box is a plain fallback.
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
 * The whiteboard, as a silhouette: a board on an easel. Deliberately not a
 * variant of `LiveMark` — the two sit side by side in the header, so what
 * separates them has to be the outline, not a detail inside it.
 */
function BoardMark() {
  return (
    <svg
      className="live-mark"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="2" width="14" height="9" rx="1" />
      <polygon points="7,11 9,11 11,15 9,15 8,13 7,15 5,15" />
    </svg>
  )
}

/**
 * The head's three presses, as glyphs (mesa task 1069).
 *
 * Pause, End and Close are 44px squares in a strip that also holds a 44px
 * aperture and a title, and three words there would be a paragraph. They are
 * drawn rather than lettered for `LiveMark`'s reason: one stroked path in
 * `currentColor` takes the button's amber/red/muted and its hover for free,
 * and each has a real `aria-label`, so nothing is lost to the reader who
 * cannot see the shape.
 */
function PauseMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 5v14M15 5v14" />
    </svg>
  )
}

function ResumeMark() {
  return (
    <svg
      // Filled rather than stroked: a stroked triangle at 15px reads as an
      // outline nobody recognises.
      className="live-icon-mark live-icon-solid"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 5l11 7-11 7z" />
    </svg>
  )
}

/** Ending is a power symbol rather than a square stop: the conversation is a
 *  thing that was switched on, and the agent behind it is switched off with
 *  it. */
function EndMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v9M6.5 6.5a8 8 0 1 0 11 0" />
    </svg>
  )
}

function CloseMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/** The listen switch's own glyph: a microphone on its stand. */
function MicMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="19"
      height="19"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

/**
 * How long this conversation has been going, ticking once a second.
 *
 * Its own component so that clock is not `LiveHub`'s: the hub is a large tree
 * that re-renders on every poll already, and a second timer driving it would
 * be the most expensive thing on the page for the least reason.
 */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <>{elapsedLabel(parseTimestamp(startedAt).getTime(), now)}</>
}

/**
 * How long a route/context change settles before it is reported. Ambient
 * telemetry, so the wait costs nothing the person can feel; long enough that a
 * caret walking down a file or a tab being flicked through is one report
 * rather than a dozen.
 */
const REPORT_DEBOUNCE_MS = 300

/**
 * How often the conversation is refetched — and, while one is live, how often
 * the window box is sampled. One number for both: a sample is only a read of
 * four properties the browser already has, and pairing it with the poll keeps
 * the hub's ambient cadence a single thing rather than two that drift.
 */
const POLL_MS = 2000

export function LiveHub({
  onSidebars,
  slot,
  boardSlot,
}: {
  /** Fold both sidebars away (`true`) or bring them back. App owns that state
   *  — the hub only relays what the conversation asked for. */
  onSidebars: (collapsed: boolean) => void
  /** Where the conversation panel is rendered (mesa task 887): the shell's
   *  right-hand sidebar slot, `null` until App's own ref has landed. */
  slot: HTMLElement | null
  /** Where the whiteboard is rendered (mesa task 1071): its own slot, just
   *  before the conversation's, so a pushed picture sits beside the page it
   *  is about rather than over it. Its own slot rather than the one above
   *  because the two panels open and close independently — a board arrives
   *  while the conversation is shut as often as not. */
  boardSlot: HTMLElement | null
}) {
  // What the listen switch is bound to (mesa task 1079). The keymap is the
  // page-wide one; the label is what the button's title and the capture hint
  // say, so a rebound chord is named wherever the shipped one used to be.
  const keymap = useKeymap()
  const listenChordLabel = chordLabel(keymap['live-listen'][0] ?? LISTEN_CHORD)

  // The exclusive id cursor the poll asks from. A ref, not state: it is read
  // inside `load` on every tick and rendered nowhere, so advancing it must not
  // cost a render.
  const cursor = useRef<number | null>(null)
  const { data, error, refetch } = useFetch(
    () => getLive(cursor.current ?? undefined),
    'live',
    { pollMs: POLL_MS },
  )
  const session = data?.session ?? null
  const live = isLive(session)

  // The live section of `~/.mesa/config.json`, for the one value this page
  // reads out of it: how long the person may fall silent before a
  // transcribed recording is sent (mesa task 886; the typed box itself sends
  // on Enter alone as of mesa task 977). Asked once per conversation joined
  // rather than on mount — the hub is mounted for the life of the app, so
  // reading it at start is what makes an edit in Settings land on the next
  // conversation without a reload.
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

  // The correction table for mishearings of mesa's own vocabulary (mesa task
  // 922) — built once per conversation, keyed on the session id the same way
  // `micOpenedFor` below is, rather than rebuilt on every recognised result:
  // the set of names worth correcting *to* does not change mid-conversation.
  // Held in a ref, not state, since it is read from inside `onresult`
  // (a media-event handler set up once per recognizer, long after the render
  // that built it) rather than rendered. Seeded with mesa's own names so a
  // conversation is never briefly running with none; `listProjects` folds in
  // whatever this install's projects are named. A failed fetch is a nicety
  // lost, not a conversation broken — the ref just keeps the built-in set.
  const vocabRef = useRef<Vocabulary>(buildVocabulary(MESA_VOCABULARY))
  const vocabBuiltFor = useRef<number | null>(null)
  // What the conversation is *about*, for the head's chip (mesa task 1069) —
  // the name behind the session's `project_id`, off the fetch above rather
  // than a second one. Null while it is unknown, and the chip simply does not
  // render then: a conversation is routinely unscoped, and "Project · —" is a
  // worse answer than no chip at all.
  const [projectName, setProjectName] = useState<string | null>(null)
  useEffect(() => {
    const id = session?.id ?? null
    if (id === null || vocabBuiltFor.current === id) return
    vocabBuiltFor.current = id
    const scope = session?.project_id ?? null
    listProjects()
      .then((projects) => {
        vocabRef.current = buildVocabulary([
          ...MESA_VOCABULARY,
          ...projects.map((p) => p.name),
        ])
        setProjectName(projects.find((p) => p.id === scope)?.name ?? null)
      })
      .catch(() => {
        vocabRef.current = buildVocabulary(MESA_VOCABULARY)
        setProjectName(null)
      })
  }, [session?.id, session?.project_id])

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
  // This browser's own id, and the claim on the conversation's voice it backs
  // (mesa task 1267 — `liveSpeaker.ts` for why there is a claim at all).
  // Generated once and kept in `localStorage`, so a page reloaded
  // mid-conversation goes on being the speaker rather than starting an echo
  // with itself. It goes nowhere but the claim and the route report.
  const client = useMemo(() => liveClientId(), [])
  // Claiming is ambient, exactly as the route report is: the press it rides on
  // has already done its own work, and a failure — no live session yet, most
  // often — costs this browser the voice rather than the press.
  const claimVoice = useCallback(() => {
    claimLiveSpeaker(client).catch(() => {})
  }, [client])
  // The conversation panel. Purely visual: closing it calls no route and stops
  // nothing — the session, the audio and the capture box all carry on.
  const [open, setOpen] = useState(false)
  // How wide the panel is (mesa task 1144), this browser's own business
  // exactly as `open` is. `null` is "no opinion": the aside then sets no
  // inline `--live-sidebar-width` at all and App.css's `min(26rem, 40vw)`
  // stands — see `liveSidebarWidth.ts` for why the default cannot be a number.
  // Desktop tiers only: the phone tier's drawer sets its width directly.
  const [width, setWidth] = useState<number | null>(() => loadLiveSidebarWidth())
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement | null>(null)
  // The width the drag has reached, so `mouseup` can store it without the
  // effect having to re-subscribe on every frame of the drag.
  const widthRef = useRef(width)
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
  // The person's own switch on the microphone (mesa task 887). Still
  // *initialises* muted — a page with no conversation joined is not listening
  // to the room — but joining one opens it on its own (`micOpenedFor` below,
  // mesa task 917): a hands-free surface that waits for a press before it can
  // hear is not hands-free. A press — the keystroke (`live-listen`) or the
  // button in the conversation panel — is what turns it back off, and keeps
  // it off for the rest of that session. Browser-side and this browser's
  // alone, like pause: no route, no session state, and mesa carries on
  // speaking while it is off. The ref is what the recognizer's own handlers
  // read, since they fire long after the render that changed it — the same
  // pairing as `pausedRef`.
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
  // When the person was last heard — interim results included (mesa task
  // 917): the silence timer below has to restart on a mid-sentence pause the
  // person fills back in, not only on a settled sentence. A ref because the
  // timer reads it long after the render that bumped it; the tick is what
  // gets the effect that owns the timer to re-run and restart the wait.
  // `at` is for the auris path (mesa task 1189), which learns the person was
  // talking only when a segment comes back as words and backdates the stamp
  // to that segment's last loud frame; the browser path stamps "now".
  const heardAt = useRef(0)
  const [heardTick, setHeardTick] = useState(0)
  const markHeard = useCallback((at: number = Date.now()) => {
    heardAt.current = at
    setHeardTick((t) => t + 1)
  }, [])
  // Whether the VAD has an utterance open right now (mesa task 1189) — the
  // auris path's other "not yet known" beside `hearing`: the silence clock no
  // longer moves on audible frames, so while a segment is still being spoken
  // it may read as stale, and the flush waits for the segment instead.
  // Written only on the open/close edges, never per frame. The ref is what
  // the silence timer reads when it fires; the state is the settle edge.
  const [segmentOpen, setSegmentOpen] = useState(false)
  const segmentOpenRef = useRef(false)
  const setSegmentOpenNow = useCallback((next: boolean) => {
    segmentOpenRef.current = next
    setSegmentOpen(next)
  }, [])
  // The microphone was refused — by the person or by the browser's policy.
  // Terminal for this page: retrying would reopen the permission prompt for
  // ever, and the typed box is exactly the surface to fall back to.
  const [blocked, setBlocked] = useState(false)
  // Three capabilities feed one `ListenPath` (mesa task 957,
  // `liveRecognition.ts::listenPath`): whether this browser can open
  // page-side capture at all (`capturesAudio`, mesa task 956), whether it has
  // a `SpeechRecognition` of its own, and whether the server has an `auris`
  // that answered. The first two are properties of the browser and never
  // change under a loaded page, so each is asked once; the third is a network
  // round trip and starts `null` — "mesa has not asked yet" — rather than a
  // guess, because guessing wrong in either direction is a real cost: assuming
  // auris and finding out otherwise would open no microphone at all for the
  // seconds the guess was wrong, and assuming no auris would start the
  // browser recognizer (opening the wrong microphone) only to tear it down a
  // beat later once the real answer landed. `transcribes` therefore gates
  // both capture effects below directly, never just `path`.
  const [captures] = useState(
    () => capturesAudio(window as unknown as Record<string, unknown>),
  )
  const [hasRecognizer] = useState(
    () => recognitionCtor(window as unknown as Record<string, unknown>) !== null,
  )
  const [transcribes, setTranscribes] = useState<boolean | null>(null)
  useEffect(() => {
    let dropped = false
    transcribeAvailable().then((available) => {
      if (!dropped) setTranscribes(available)
    })
    return () => {
      dropped = true
    }
  }, [])
  // Whether this browser can be the way in at all, and through which engine.
  // `recognizesSpeech`, `captureHint` and `offersInputChoice` all still read
  // `supported` for exactly the question it has always answered — "is the
  // microphone the way in on this browser" — regardless of which path
  // answers yes; only `captureHint` and the two capture effects need to know
  // *which*.
  //
  // `path` is deliberately computed from what is *known* — `transcribes ===
  // true` — rather than from `transcribes` itself, so a probe still in flight
  // reads exactly like "asked, and there is no auris" rather than like
  // "neither way in exists". Those are not the same claim, but until the
  // probe answers mesa cannot tell them apart, and `captureHint`'s ladder
  // puts `'none'` *above* `!live` — so treating the gap as `'none'` would
  // paint "Neither auris nor this browser can listen here" on every cold
  // load, in every browser, before self-correcting a moment later. That is
  // exactly the failure this module's own `captureHint` doc warns against: a
  // line that answers the question wrong on a several-second cycle. Reading
  // the gap as `false` instead means a browser with no recognizer of its own
  // just answers `'none'` truthfully throughout (this machine's permanent
  // state, whether or not auris later turns out to be there), a browser with
  // a recognizer paints `'browser'` immediately and only flips to `'auris'`
  // once the probe confirms it — a label change on the *listening* line,
  // which needs live + joined + a press, none of which fits inside the probe
  // window — and only Firefox-with-auris (no recognizer, so nothing to fall
  // back to until the probe lands) sees a residual flash, on the rarest
  // combination and the one where "neither can listen" was true a moment
  // before.
  //
  // The two capture effects below do NOT get to make this approximation:
  // they gate on `transcribes !== null` — the probe having actually
  // *answered* — because opening the wrong engine for the probe's one fetch
  // and tearing it down a beat later is a real cost (a flashed permission
  // prompt, a microphone opened and closed) that a render label is not.
  const path: ListenPath = listenPath({
    transcribes: transcribes === true,
    captures,
    recognizes: hasRecognizer,
  })
  const supported = path !== 'none'
  // Whether this browser's `SpeechRecognition` accepts a `MediaStreamTrack`
  // argument to `start()` — discoverable only by trying it (Safari, and
  // Chromium before 135, throw a `TypeError`). Irrelevant to the auris path,
  // which opens `getUserMedia` itself and understands a `deviceId` constraint
  // universally; read only where `path === 'browser'` chooses to route a
  // device through the engine instead.
  const [routes, setRoutes] = useState(true)
  // Which microphone to listen through (mesa task 884, `liveDevices.ts`), and
  // what there is to choose from. The list is the browser's, re-read whenever
  // it changes; the choice is this machine's, remembered across visits.
  const [inputs, setInputs] = useState<AudioInput[]>([])
  const [storedInput, setStoredInput] = useState(readInputChoice)
  // A device that is here, is chosen, and will not open — another application
  // holding the input is the everyday case, and unlike an unplugged one it
  // never leaves `inputs`, so nothing else would stop mesa asking it again on
  // every turn for the rest of the conversation. Latched per device rather
  // than for the page: picking a different one is a fresh question, and so is
  // picking this one again after quitting whatever was holding it.
  const [refusedInput, setRefusedInput] = useState<string | null>(null)
  // The current input level, 0..1, for the meter beside the listen switch —
  // what replaced `interimResults` as the sign the microphone is doing
  // anything at all. A microphone with no visible response looks broken, and
  // a level is the cheap honest answer where a partial transcript would need
  // a streaming decoder mesa does not have (mesa task 956).
  const [level, setLevel] = useState(0)
  // How many segments are queued for or in flight to the transcribe route
  // right now — almost always 0 or 1, since segments are posted in order, but
  // never assumed to be: it is a count, not a flag, so a slow request does not
  // read as "stopped hearing" for the length of it. Written by `chainRef`
  // below (mesa task 1154), so it is exactly the chain's own count and stays
  // above zero for the whole of a mic-off drain.
  const [hearing, setHearing] = useState(0)
  // When the person was last audibly talking, or `null` while the microphone
  // is shut. Written from the same place `level` is, and read only through
  // `showsHearing` — the hold it feeds is what keeps the status pill and the
  // header aperture steady across a sentence instead of blinking once per
  // segment (mesa task 1073).
  const [voicedAt, setVoicedAt] = useState<number | null>(null)
  // What actually drops the pill when the person goes quiet. `showsHearing`
  // is still the rule — this only guarantees a render at the moment its hold
  // clause goes false, because nothing else will: `setLevel` bails out on an
  // unchanged value, so a stream of digital silence (muted hardware, or a
  // synthetic all-zero buffer) renders nothing at all and the pill would
  // stay latched open, the same bug we are fixing turned the other way
  // round. It re-arms on every newer stamp, which is cheap now the stamp
  // rides the meter's throttle, and the `at === voicedAt` guard means a
  // stamp that landed after this timer was set is never the one it clears.
  useEffect(() => {
    if (voicedAt === null) return
    const timer = setTimeout(
      () => setVoicedAt((at) => (at === voicedAt ? null : at)),
      HEARING_HOLD_MS,
    )
    return () => clearTimeout(timer)
  }, [voicedAt])

  // ---- the watchdog (mesa task 1157) ----

  // What the page remembers of the agent between polls (`liveWatchdog.ts`),
  // and the notices this page has already posted this span — keyed on kind
  // and span start, so a post whose turn has not yet come back on the poll is
  // not posted again two seconds later. The server dedupes anyway; this keeps
  // the page from asking. Both refs: read and written off the poll, rendered
  // nowhere.
  const watchdog = useRef<Watchdog | null>(null)
  const noticed = useRef<Set<string>>(new Set())
  // The decision, run on every poll (from the transcript effect below, with
  // that poll's turns). The permission notice is edge-triggered on `blocked`,
  // which only a poll can change, so nothing needs judging between polls.
  function judgeWatchdog(state: LiveState, turns: readonly LiveTurn[]) {
    const current = state.session
    // Only a browser that is in the conversation authors a notice — the same
    // condition under which it speaks turns — so a page that merely has mesa
    // open on another machine never reports on a conversation it is not in.
    if (current === null || !isLive(current) || !unlocked) return
    if (watchdog.current?.sessionId !== current.id) {
      watchdog.current = initialWatchdog(current.id)
      noticed.current = new Set()
    }
    const before = watchdog.current
    watchdog.current = watchdogAfterPoll(before, { blocked: state.blocked ?? null })
    // The span the server dedupes by: the working span, or the whole session
    // while nobody is working.
    const spanStart = current.working_since ?? current.started_at
    const post = (kind: LiveNotice) => {
      const key = `${kind}@${spanStart}`
      if (noticed.current.has(key)) return
      noticed.current.add(key)
      // Ambient like the played stamp: the turn arrives on the next poll
      // either way, and a failure is retried by the next span, not reported.
      sendLiveNotice(kind).then(
        () => refetch(),
        () => {},
      )
    }
    // Rising edge only: `blocked` is a 5s server-side cache, so the answered
    // prompt's new span still reads as blocked for a few polls, and a level
    // rule would report it a second time there.
    if (
      shouldNoticePermission({
        blocked: watchdog.current.blocked,
        wasBlocked: before.blocked,
        alreadyNoticed: noticeInSpan(turns, 'permission', spanStart),
      })
    ) {
      post('permission')
    }
  }
  // Pointed at the current render's closure below, beside `pump` and
  // `ended`, so the poll effect calls the latest one.
  const judge = useRef<typeof judgeWatchdog | null>(null)

  // Which session the held transcript belongs to. A new conversation is a new
  // transcript — going live again is a fresh session with its own turns, and
  // the old ones must not be merged in above them.
  const shown = useRef<number | null>(null)
  // Turns this component has already taken in hand. `played_at` only comes
  // back on the next poll, so without this the two seconds after a turn starts
  // would start it again; a turn that failed to speak stays here too, which is
  // what keeps one bad turn from wedging the run on itself.
  const handled = useRef<Set<number>>(new Set())
  // Turns whose *action* this browser has already performed (mesa task 1267).
  // A second set rather than a second use of `handled`, because the two
  // answer different questions — see `liveTurns.ts::actsOn`. Every browser
  // showing the conversation follows a `navigate` and a sidebar fold, exactly
  // once each; only the speaker says the words, and a page that skips the
  // words must leave the turn re-considerable for whoever gets the voice.
  const performed = useRef<Set<number>>(new Set())
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
      performed.current = new Set()
    }
    cursor.current = advanceCursor(cursor.current, data.turns)
    // The watchdog judges this poll against *this poll's* transcript, never
    // the `turns` state (set above, seen next render), so a notice this poll
    // carries back is already seen by the span check.
    judge.current?.(data, next)
  }, [data])

  useEffect(() => {
    held.current = turns
  }, [turns])

  // ---- the whiteboard (mesa task 1071) ----

  // The boards this conversation has pushed, off the poll above rather than a
  // second one: `LiveState.boards` is bodiless and capped at twenty, so the
  // whole history rides on the two-second read the hub already makes.
  // Memoised so the panel's own view is not recomputed on every render of
  // this component — only when a poll actually changed the history.
  const boards = useMemo(() => data?.boards ?? [], [data])
  // Whether the panel is showing, and the newest board this component has
  // taken in hand — `handled`'s claim-once discipline in the shape a picture
  // needs (`liveBoard.ts::boardPanelFor`): a board the person has not been
  // shown opens the panel, because the agent pushed it *instead of* saying
  // something and a board nobody sees is the same as no board, while every
  // later poll carrying that same board must not re-open one they have since
  // put away. Closing is this browser's own act, no route, exactly like the
  // conversation panel's own close.
  //
  // Applied during render rather than in an effect, `useFetch.ts`'s pattern:
  // the answer is a pure function of the poll, and `boardPanelFor` hands back
  // the state it was given — by identity — on every tick where nothing moved,
  // so this settles in one pass.
  const [boardPanel, setBoardPanel] = useState<BoardPanel>(closedBoardPanel)
  const nextBoardPanel = boardPanelFor(boardPanel, boards)
  if (nextBoardPanel !== boardPanel) setBoardPanel(nextBoardPanel)

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

  /**
   * The pause branch of `togglePause` (task 882), factored out because a
   * spoken pause phrase (mesa task 1160, `livePausePhrase.ts`) performs the
   * same press from inside a capture effect. The turn sounding at the press is
   * handed back to the run first (`releaseForReplay`, mesa task 1161), so
   * Resume says it again from its start rather than skipping it — `End` does
   * no such thing, since its transcript resets anyway. Idempotent: a second
   * "hold on" while already paused finds nothing sounding, silences a player
   * that is already silent and writes a `true` that is already there. The ref
   * beside it is what the capture handlers call, since they fire long after
   * the render that made it.
   */
  const pauseNow = useCallback(() => {
    releaseForReplay(handled.current, sounding.current)
    silence()
    setPausedNow(true)
  }, [silence, setPausedNow])
  const pauseNowRef = useRef(pauseNow)
  useEffect(() => {
    pauseNowRef.current = pauseNow
  }, [pauseNow])

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

  // Joining opens the microphone (mesa task 917): a conversation this browser
  // has joined should be hands-free from the first word, not only after a
  // press on the switch. `micOpenedFor` is the session this browser has
  // already opened the microphone for, keyed on the session id rather than a
  // boolean so a fresh conversation opens it again while a mute made *during*
  // this one stays put — the only write to this ref is here, which is what
  // makes it sticky rather than something this effect re-opens on its own
  // next run. A `null` id (no session) never counts as opened, so ending a
  // conversation leaves the next one free to trigger.
  const micOpenedFor = useRef<number | null>(null)
  useEffect(() => {
    const id = session?.id ?? null
    if (id === null || !unlocked || micOpenedFor.current === id) return
    micOpenedFor.current = id
    setMutedNow(false)
    // Mirrors the reasoning already written on `togglePause`/`toggleListening`:
    // the went-live reclaim effect just below reads `listeningRef` to decide
    // whether the capture box may grab the keyboard, and that effect runs in
    // the same commit as this one — a render behind, if this only set state.
    // Writing the ref here, synchronously, is what keeps that effect from
    // reclaiming focus for a microphone that is, by the time it checks, opening.
    listeningRef.current = recognizesSpeech({
      live,
      joined: unlocked,
      supported,
      blocked,
      paused,
      muted: false,
    })
  }, [session?.id, unlocked, setMutedNow, live, supported, blocked, paused])

  // Joining is when capture starts: the same press that unlocks audio hands
  // mesa the keyboard. Edge-triggered on the pair going true together.
  useEffect(() => {
    if (live && unlocked) reclaim('went-live', { live, unlocked })
  }, [live, unlocked, reclaim])

  // The recognizer's handlers are set once per start and post sentences long
  // after the render that installed them, so they read through a ref rather
  // than a closure over a stale `post`.
  const postRef = useRef<(text: string) => Promise<void>>(() => Promise.resolve())
  const draftRef = useRef('')

  /** The one write path for the draft: state for the render, a ref for `send`. */
  const updateDraft = useCallback((value: string) => {
    draftRef.current = value
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
  //
  // `routes` only matters on the `'browser'` path (mesa task 957): the auris
  // path opens a stream through `getUserMedia` directly, and a `deviceId`
  // constraint on that call is understood by every browser that has
  // `getUserMedia` at all, so there is nothing to probe there — hence `true`
  // rather than the state below whenever `path !== 'browser'`.
  const choosesInput = offersInputChoice({
    supported,
    routes: path === 'browser' ? routes : true,
    inputs,
  })
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
  // The complement (mesa task 1160): the microphone is the way in *and* mesa
  // is speaking. Gates the barge-in capture effect below, which hears the
  // room for one thing only — a spoken pause phrase.
  const wantsBargeIn = shouldBargeIn({
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
  // The one ordered chain every heard segment settles through (mesa task
  // 1154, `liveDrain.ts`). Component-level rather than a capture run's own,
  // because the listen switch tears the run down with segments still on their
  // way back from `auris`: the press `close()`s the chain, and when anything
  // is outstanding the flush becomes the step after the last of it — so the
  // next run's segments, enqueued behind that step, can never overtake what
  // the previous run heard. `hearing` is the chain's count, told to it here.
  const chainRef = useRef<SegmentChain | null>(null)
  if (chainRef.current === null) {
    chainRef.current = new SegmentChain({
      flush: () => flushRef.current(),
      onOutstanding: setHearing,
    })
  }
  // The running capture effect's way of windowing the utterance still open
  // onto the chain, for the press to call *before* it closes the chain: the
  // effect's own cleanup runs a render later, and a cut chained there would
  // land behind the flush instead of in front of it. `null` while no capture
  // is running (the browser path, mesa speaking, a pause).
  const cutRef = useRef<(() => void) | null>(null)

  // The recording's other boundary (mesa task 917): silence, not just the
  // switch. A timeout re-armed on every dependency change, reading the live
  // answer through refs rather than the closure, because the person may have
  // gone silent well before this effect's own render. An open VAD segment or
  // a segment still on the chain withholds it (mesa task 1189): the clock
  // moves only on transcribed speech, so sound not yet judged may leave it
  // stale, and the held text must wait. Both are read through the ref and
  // the chain at fire time, deliberately *not* as dependencies: re-arming a
  // full wait on every segment edge would let a noisy room push the timer
  // for ever — the very bug — where the settle effect below asks once.
  const silenceVerdict = useCallback(
    () =>
      shouldFlushSilence({
        listening: wants.current,
        recording: recordingRef.current,
        interim: interimRef.current,
        idleMs: Date.now() - heardAt.current,
        idleThresholdMs: autoSendMs,
        segmentOpen: segmentOpenRef.current,
        outstanding: chainRef.current?.outstanding ?? 0,
      }),
    [autoSendMs],
  )
  useEffect(() => {
    if (!wantsMic || (recording.trim() === '' && interim.trim() === '')) return
    const timer = window.setTimeout(() => {
      if (silenceVerdict()) flushRef.current()
    }, autoSendMs)
    return () => window.clearTimeout(timer)
  }, [heardTick, wantsMic, recording, interim, autoSendMs, silenceVerdict])
  // The settle (mesa task 1189): a timer the effect above withheld is not
  // re-armed by anything once the segment it waited on resolves to nothing —
  // a noise-only segment moves no clock and grows no recording — so the same
  // verdict is asked again the moment nothing is open or in flight, and a
  // wait that had already elapsed flushes now rather than never. Only the
  // settle edge is a dependency, so mesa finishing a reply (`wantsMic`
  // rising) still starts the wait fresh as it always has.
  useEffect(() => {
    if (segmentOpen || hearing > 0) return
    if (silenceVerdict()) flushRef.current()
  }, [segmentOpen, hearing, silenceVerdict])

  const toggleListening = useCallback(
    (next: boolean) => {
      // The ref first, before the cut and the close below: a segment that
      // settles from here on must read this press, and `setMutedNow` a few
      // lines down would only be re-affirming it. The same reason
      // `listeningRef` is written here rather than left to its effect.
      mutedRef.current = next
      // Opening the microphone is a press that says "talk to me here", so it
      // claims the voice (mesa task 1267). Closing it gives nothing up: a
      // muted page still hears mesa, and moving the voice to another tab
      // because this one stopped talking would be a second surprise.
      if (!next) claimVoice()
      if (next) {
        // The switch off is the send (mesa task 1154): the utterance still
        // open is cut onto the chain first, then the chain is closed — which
        // flushes at once when nothing is outstanding, and otherwise makes
        // the flush the step after the last segment already heard, so what
        // was still being transcribed at the press is sent with the rest
        // rather than dropped behind a recording already gone.
        cutRef.current?.()
        chainRef.current?.close()
      } else if (!chainRef.current?.draining) {
        // The switch on starts a fresh recording, because a recording belongs
        // to the stretch of listening it was made in — unless the last
        // stretch is still draining, in which case what it holds is that
        // stretch's, waiting on the flush queued behind its segments, and the
        // new run's own segments are queued behind that flush.
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
      claimVoice,
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
  // reason it is a chord rather than a key — the `live-listen` action in
  // `keymap.ts`, rebindable from Settings since mesa task 1079.
  //
  // Always `preventDefault`, like the palette's: whatever the browser does
  // with this chord, the conversation's microphone is the stronger claim
  // while mesa is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut('live-listen', e, keymap)) return
      e.preventDefault()
      toggleListening(!mutedRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleListening, keymap])

  // Capture opens a stream and a worklet rather than a recognizer (mesa task
  // 956) — this is the auris half of the pair task 957 added, guarded on
  // `path === 'auris'` so it and the recognizer effect below are mutually
  // exclusive: nothing downstream of `flushRecording`/`markHeard` may learn
  // which of the two actually ran. It keeps the run-guard shape the
  // recognizer effect always had — `running`, flipped false by the cleanup —
  // for exactly the same reason: work still in flight when the conversation
  // stops wanting the microphone (mesa speaking, the person muting, the
  // conversation ending) must not write state into a component that has
  // moved on, or open a device nothing will ever listen to.
  //
  // `transcribes === null` is checked separately from `path`, and on both
  // capture effects: `path` above reads a pending probe as "no auris" so a
  // cold render never claims "neither can listen" for the moment before the
  // probe answers, but that approximation is only safe for what a render
  // *shows*, not for what an effect *starts*. This effect never reads
  // `'auris'` from a guessed `path` (a guess is always `'none'` or
  // `'browser'`), so the guard here changes nothing in practice — it is
  // written for symmetry with the recognizer effect below, where the same
  // guess *would* otherwise open a real microphone a beat before tearing it
  // down once the probe corrected it.
  useEffect(() => {
    if (!wantsMic || transcribes === null || path !== 'auris') return
    let running = true
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let node: AudioWorkletNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let blobUrl: string | null = null
    // The rolling buffer of recent audio: bounded by `dropBefore` below to the
    // current utterance's pre-roll, since a page listening for an hour must
    // not hold an hour of it.
    let frames: CapturedFrame[] = []
    let vad = initialVad()
    // Mirrors `vad.startedAt !== null` into `segmentOpen`, written only when
    // it changes so the hub is not re-rendered per frame.
    let segmentWasOpen = false
    const trackSegment = () => {
      const open = vad.startedAt !== null
      if (open !== segmentWasOpen) {
        segmentWasOpen = open
        setSegmentOpenNow(open)
      }
    }
    // The level meter is throttled here rather than in `setLevel` itself: a
    // 128-sample block at 16 kHz is on the order of 125 blocks a second, and
    // re-rendering the hub that often for a bar nobody can watch move that
    // fast would cost far more than the meter is worth. A block only updates
    // the state once its level has moved by more than 0.03 or ~100ms have
    // passed since the last write.
    let lastLevelAt = 0
    let lastLevelValue = 0
    // Segments are transcribed **in order**: two overlapping posts could land
    // the halves of one thought the wrong way round, the same reasoning
    // `post()` already carries in this file for a split recording. Every
    // segment's `send` is enqueued on the component's chain rather than fired
    // directly — the chain, not a run-local promise, since mesa task 1154:
    // see `chainRef`.
    const chain = chainRef.current!

    /**
     * One finished utterance, windowed out of the rolling buffer, downsampled
     * and posted to `POST /api/live/transcribe`. What comes back is handed to
     * the **existing** held-recording path exactly as the old `onresult`
     * final branch did — same order, same guards — because everything
     * downstream (`heldWith`, `shouldFlushSilence`, `heldFlush`) is built
     * assuming a final arrives this way.
     *
     * `outlives` (mesa task 961) is for a segment windowed by `cutOpen`
     * rather than from `onFrame` — the sentence the person was still
     * finishing when mesa began to speak, or when they pressed the listen
     * switch, cut by `vadCut` because the effect is torn down before the VAD
     * would ever have reported it `ended` on its own. That send necessarily
     * starts after `running` has gone false, so the two `!running` early-outs
     * below are skipped for it — the same "not guarded on `running`"
     * carve-out the browser-recognizer path takes in its `onresult`, and for
     * the same reason: this text was heard before the teardown, so it is the
     * person's, not an echo, and belongs in the recording. The delivery-time
     * predicate (`mayHold`, `liveDrain.ts`) is still what decides whether it
     * actually lands, and does all the discriminating: a pause, or the
     * conversation having ended by the time this resolves, fail it; a mute
     * fails it too — *unless* the chain is still draining the press that
     * muted (mesa task 1154), in which case this segment was heard before
     * that press and is folded in for the flush queued behind it. So "mesa
     * started speaking and nothing else happened" and "the person switched
     * the microphone off" both reach the recording; a pause and an end do not.
     *
     * `lastLoudAt` is the segment's last loud frame (`endedAt` from `vadStep`
     * or `vadCut`): where the silence clock moves to if this segment turns
     * out to be speech (mesa task 1189, `speechHeardAt`).
     */
    const send = async (wav: Uint8Array, lastLoudAt: number, outlives = false) => {
      try {
        const { text: raw } = await transcribeAudio(toBase64(wav))
        if (!running && !outlives) return
        // A segment that came back is proof this page is still in touch, so
        // whatever the last failure was, it is over.
        setActionError(null)
        // The silence clock (mesa task 1189): restarted by sound that turned
        // out to be speech, backdated to when that speech ended — not by
        // every audible frame, which read a noisy room as the person still
        // talking and postponed the auto-send for as long as the noise ran.
        // A segment auris heard nothing in leaves the clock where it was.
        const heard = speechHeardAt(raw, lastLoudAt)
        if (heard !== null) markHeard(heard)
        const text = utteranceFrom(correctVocabulary(raw, vocabRef.current))
        if (text === null) return
        // The preview is cleared here rather than waiting for the next
        // segment: the words it showed have just been recorded, and leaving
        // them under the box would read as a second sentence still coming.
        setInterimNow('')
        // A spoken "hold on" is the Pause button, not a sentence for the
        // agent (mesa task 1160): it is never held and never sent. Judged
        // before `mayHold`, so a phrase is a no-op rather than a recording
        // while already paused — and gated on the conversation still being
        // live *at delivery*, the same refs `mayHold` reads, because this
        // transcript may resolve after End (an `outlives` cut, most likely)
        // and a pause written then would outlive the falling edge that
        // clears it and start the next Go live silently paused.
        if (isPausePhrase(text)) {
          if (armed.current.live && !pausedRef.current) pauseNowRef.current()
          return
        }
        if (
          mayHold({
            live: armed.current.live,
            paused: pausedRef.current,
            muted: mutedRef.current,
            draining: chain.draining,
          })
        ) {
          // Held, not posted (task 889): the recording is one turn, and the
          // person's own switch is what ends it. `flush` is only the cap.
          const grown = heldWith(recordingRef.current, text)
          setRecordingNow(grown.held)
          if (grown.flush !== null) void postRef.current(grown.flush)
        }
      } catch (err: unknown) {
        if (!running && !outlives) return
        // This effect only runs at all once the mount probe found auris
        // available (`path === 'auris'`), so a failure here is auris crashing
        // on this one clip, not the missing-binary case `listenPath` already
        // routed around (mesa task 957) — the two look identical from a 503,
        // and there is nothing this page can do with the difference. Say so,
        // and try the next utterance rather than ending listening outright or
        // switching paths mid-conversation over one bad segment.
        //
        // Except when auris merely heard nothing (mesa task 1072): a breath or
        // a quiet room is a normal outcome of listening, and auris plainly
        // ran, so the error is cleared and nothing is said — a banner for it
        // latched the panel into `Reconnecting` for the rest of the
        // conversation while turns kept flowing.
        const message = err instanceof Error ? err.message : String(err)
        setActionError(isSilentTranscribe(message) ? null : message)
      }
    }

    /**
     * Window the utterance still open, if any, onto the chain, and reset the
     * VAD so the same audio is never windowed twice. Called from the listen
     * switch's press through `cutRef` (mesa task 1154) and from the cleanup
     * below; the second call after a press finds a fresh VAD and cuts
     * nothing. The reasoning for cutting at all is the cleanup's, below.
     */
    const cutOpen = () => {
      const cut = vadCut(vad)
      if (cut !== null && ctx !== null) {
        const wav = wavFromFrames(frames, cut.startedAt - PRE_ROLL_MS, cut.endedAt, ctx.sampleRate)
        if (wav.length > 44) chain.enqueue(() => send(wav, cut.endedAt, true))
      }
      vad = initialVad()
      trackSegment()
    }
    cutRef.current = cutOpen

    const onFrame = (samples: Float32Array) => {
      const at = Date.now()
      frames.push({ at, samples })
      const rms = frameRms(samples)
      if (Math.abs(rms - lastLevelValue) > 0.03 || at - lastLevelAt > 100) {
        lastLevelValue = rms
        lastLevelAt = at
        setLevel(rms)
        // The last moment the person was audible (mesa task 1073), stamped
        // here because this is the only place a raw audio frame is in hand —
        // and only here, so the browser path (mesa task 957) leaves it `null`
        // and falls through to its own real `interim`, exactly as `level` and
        // `hearing` already do.
        //
        // Deliberately **inside** the throttle. `at` is a fresh number on
        // every frame, so a stamp outside it would re-render the hub at the
        // full ~125 blocks a second for the length of every sentence — the
        // exact cost the throttle above exists to avoid, and worse than the
        // meter's, since nothing bails out on an unchanged value. Under it
        // the stamp is up to ~100ms stale, which is free against a 1000ms
        // hold.
        if (rms >= DEFAULT_VAD.onsetRms) setVoicedAt(at)
      }
      const step = vadStep(vad, { rms, at })
      vad = step.state
      // The silence clock is *not* touched here (mesa task 1189). It used to
      // restart on every loud frame, on the reasoning that audible sound was
      // a truer "still talking" than a recognizer's guess at words — but a
      // fan, a keyboard or traffic is loud and is not the person, and in a
      // room that never falls quiet the auto-send never came. Now `send`
      // moves it once the segment comes back as words, backdated to the
      // segment's last loud frame, and `segmentOpen` tells the flush effect
      // to wait while an utterance is still being spoken.
      trackSegment()
      // Windowed **synchronously**, and before the buffer is bounded below.
      // `send` runs a microtask later at the earliest, and the VAD resets on
      // the very frame that ends an utterance — so by the time a deferred
      // window ran, `dropBefore` would already have let go of every frame the
      // sentence was made of, and the recording posted to auris would be the
      // trailing pre-roll instead of what the person said. Encoding here is
      // the one place the frames the segment names are all still in hand.
      if (step.ended !== null && ctx !== null) {
        const { startedAt, endedAt } = step.ended
        const wav = wavFromFrames(frames, startedAt - PRE_ROLL_MS, endedAt, ctx.sampleRate)
        // A header-only WAV is a window with nothing in it — nothing anybody
        // said, so nothing worth waking a decoder for.
        if (wav.length > 44) chain.enqueue(() => send(wav, endedAt))
      }
      frames = dropBefore(frames, (vad.startedAt ?? at) - PRE_ROLL_MS)
    }

    /** Opens the stream, the context and the worklet, in that order — each
     *  awaited step bails if the conversation stopped wanting the microphone
     *  while it was opening, closing whatever this call already has. */
    const open = async (constraint: MediaTrackConstraints | boolean) => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraint })
      if (!running) {
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      } catch {
        // A browser that refuses the rate still works: `wavFromFrames` is
        // handed `ctx.sampleRate` and downsamples in the page instead.
        ctx = new AudioContext()
      }
      // The press that joined the conversation is the gesture that permits
      // this — the same one `act()` already spends on the player and the
      // clock.
      await ctx.resume()
      if (!running) {
        void ctx.close()
        ctx = null
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(blobUrl)
      if (!running) return
      node = new AudioWorkletNode(ctx, 'mesa-pcm')
      source = ctx.createMediaStreamSource(stream)
      // Deliberately not connected onward to `ctx.destination` — that would
      // play the person's own microphone back at them.
      source.connect(node)
      node.port.onmessage = (e) => onFrame(e.data as Float32Array)
      // Real names for the devices: a browser redacts every device *label*
      // until microphone permission has been granted, and opening the stream
      // above is what grants it — this is the capture-era version of what
      // `engine.onstart` used to trigger this from.
      listInputs()
    }

    void (async () => {
      try {
        // `DEFAULT_INPUT` no longer means "no stream of mesa's own" the way it
        // did under `SpeechRecognition.start()` — capture always opens a
        // stream now. What the default choice means is "whatever device the
        // browser would pick": mesa needs its own microphone permission on
        // every path, not only the chosen-device one.
        await open(chosen === DEFAULT_INPUT ? true : { deviceId: { exact: chosen } })
      } catch (err: unknown) {
        if (!running) return
        const name = err instanceof DOMException ? err.name : ''
        if (isMicRefusal(name)) {
          // Not an error the conversation recovers from: say so once, in the
          // status line, and leave the typed box as the way in.
          setBlocked(true)
          setActionError(`the microphone is unavailable (${name})`)
          // And send what it did hear (task 889). A refusal withdraws the
          // listen button — `blocked` is one of its four conditions — so the
          // recording would otherwise sit on screen with no control left to
          // deliver it.
          flushRef.current()
          return
        }
        if (chosen !== DEFAULT_INPUT) {
          // The named device is gone, or the permission behind it was
          // refused. Listen through the default rather than not at all — a
          // conversation that hears nothing is worse than one that hears the
          // wrong microphone — and say which it is, because the chooser above
          // will still be showing the device that is not being used.
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
          try {
            await open(true)
          } catch (err2: unknown) {
            if (running) setActionError(err2 instanceof Error ? err2.message : String(err2))
          }
          return
        }
        setActionError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      running = false
      cutRef.current = null
      setInterimNow('')
      // The meter goes quiet with the microphone. It is driven from frames
      // that have stopped arriving, so without this it would freeze at
      // whatever the last block happened to read — a bar still showing sound
      // through mesa's whole reply, which is the opposite of what shutting
      // the microphone while she speaks is meant to show.
      setLevel(0)
      // And so does the hold (mesa task 1073). The effect below drops a stale
      // stamp on its own clock, but a torn-down capture — mesa speaking, a
      // pause, a mute, the conversation ending — is not a hold running out,
      // it is the microphone closing, and the pill goes with it immediately
      // rather than a second later.
      setVoicedAt(null)
      node?.port.close?.()
      node?.disconnect()
      source?.disconnect()
      // mesa task 961: `wantsMic` can go false with an utterance still open —
      // most often because mesa started speaking, which shuts the microphone
      // for the length of her reply. `vadStep` never gets to report that
      // utterance `ended`, because nothing feeds it another frame once this
      // cleanup runs, so `vadCut` reads the same "worth transcribing" verdict
      // off whatever state the VAD was actually left in. This has to happen
      // here, before `ctx?.close()`/the stream teardown just below: windowing
      // needs `ctx.sampleRate` to downsample by and `frames` to draw from, and
      // both are gone the moment those run. The send is enqueued on the chain
      // like every other segment, never fired directly — so it can't overtake
      // a segment already in flight — and marked `outlives` so the two
      // `!running` guards inside `send` don't discard it now that `running`
      // is already false; see `send`'s comment for why the delivery-time
      // predicate alone is still enough to keep a pause and an end from also
      // sending whatever they cut off. The listen switch is no longer one of
      // those (mesa task 1154): its press already called `cutOpen` through
      // `cutRef` and closed the chain behind the cut, so by the time this
      // cleanup runs for a mute the VAD is fresh and there is nothing left to
      // cut. `vad = initialVad()` after windowing, mirroring the reset
      // `vadStep` performs on an ordinary `ended`, is what stops this same
      // audio being windowed twice — this cleanup runs exactly once per effect
      // run, but leaving `vad` as it was would say otherwise to anything
      // reading it afterwards.
      cutOpen()
      void ctx?.close()
      stream?.getTracks().forEach((t) => t.stop())
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [
    wantsMic,
    transcribes,
    path,
    chosen,
    listInputs,
    markHeard,
    setInterimNow,
    setRecordingNow,
    setSegmentOpenNow,
  ])

  // Barge-in (mesa task 1160): the microphone while mesa is speaking. The
  // effect above closes it for the length of every reply so she never hears
  // herself, which also means nothing the person says over her can be heard
  // — and "hold on" is exactly what a person says over her. This is a
  // second, contained capture effect gated on `wantsBargeIn`, the exact
  // complement of `wantsMic` (`shouldBargeIn` in `liveRecognition.ts`), so
  // the two never run at once and each opens the moment the other closes.
  //
  // Everything about it is narrower than the effect above, on purpose:
  //
  // - It opens its **own** stream, with `echoCancellation`,
  //   `noiseSuppression` and `autoGainControl` all set explicitly, because
  //   the room contains mesa's own voice out of the speakers. The main
  //   stream's constraints are untouched.
  // - Its VAD is `BARGE_IN_VAD` — a shorter hangover and a 3s cap — so a
  //   phrase is transcribed a beat after its last word, and a segment that
  //   runs into the cap (a long sentence, or mesa's own reply leaking
  //   through) is dropped **untranscribed** rather than cut and continued.
  // - It does **one** thing with a transcript: `isPausePhrase` →
  //   `pauseNow()`. Anything else is dropped — never held, never sent,
  //   never `markHeard`, never the level meter, never the silence clock —
  //   because nothing heard while mesa is speaking is a recording, and the
  //   whole-short-utterance rule in `livePausePhrase.ts` is what keeps a
  //   fragment of her sentence from ever matching.
  // - Its segments transcribe in order on a run-local promise, not the
  //   component's `SegmentChain`: that chain orders the *recording*, and
  //   these segments never reach it.
  // - A microphone failure here is silent. A refusal will be reported by the
  //   main effect the moment she stops speaking, and a chosen device that
  //   will not open falls back to the default once, exactly as it does there,
  //   but with nothing to say about it.
  //
  // `pauseNow` itself is what ends this effect: `silence()` clears
  // `speaking`, so `wantsBargeIn` goes false and the cleanup below runs, and
  // `paused` keeps the main effect from reopening the microphone in its
  // place.
  useEffect(() => {
    if (!wantsBargeIn || transcribes === null || path !== 'auris') return
    let running = true
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let node: AudioWorkletNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let blobUrl: string | null = null
    let frames: CapturedFrame[] = []
    let vad = initialVad()
    let queue: Promise<void> = Promise.resolve()

    const send = async (wav: Uint8Array) => {
      try {
        const { text: raw } = await transcribeAudio(toBase64(wav))
        if (!running) return
        const text = utteranceFrom(correctVocabulary(raw, vocabRef.current))
        if (text !== null && isPausePhrase(text)) pauseNowRef.current()
      } catch {
        // Nothing to report: a segment that did not transcribe is a phrase
        // that was not heard, and the button is still there.
      }
    }

    const onFrame = (samples: Float32Array) => {
      const at = Date.now()
      frames.push({ at, samples })
      const step = vadStep(vad, { rms: frameRms(samples), at }, BARGE_IN_VAD)
      vad = step.state
      if (step.ended !== null && ctx !== null) {
        const { startedAt, endedAt } = step.ended
        // Ran into the cap: not a pause phrase, whatever it was.
        if (endedAt - startedAt < BARGE_IN_VAD.maxSegmentMs) {
          const wav = wavFromFrames(frames, startedAt - PRE_ROLL_MS, endedAt, ctx.sampleRate)
          if (wav.length > 44) queue = queue.then(() => send(wav))
        }
      }
      frames = dropBefore(frames, (vad.startedAt ?? at) - PRE_ROLL_MS)
    }

    const open = async (deviceId: string) => {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId === DEFAULT_INPUT ? {} : { deviceId: { exact: deviceId } }),
        },
      })
      if (!running) {
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      } catch {
        ctx = new AudioContext()
      }
      await ctx.resume()
      if (!running) {
        void ctx.close()
        ctx = null
        stream.getTracks().forEach((t) => t.stop())
        stream = null
        return
      }
      blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(blobUrl)
      if (!running) return
      node = new AudioWorkletNode(ctx, 'mesa-pcm')
      source = ctx.createMediaStreamSource(stream)
      source.connect(node)
      node.port.onmessage = (e) => onFrame(e.data as Float32Array)
    }

    void (async () => {
      try {
        await open(chosen)
      } catch {
        if (!running || chosen === DEFAULT_INPUT) return
        try {
          await open(DEFAULT_INPUT)
        } catch {
          // Silent, see above.
        }
      }
    })()

    return () => {
      running = false
      // No `vadCut` here: an utterance still open when mesa stops speaking
      // was not a short phrase that ended, and the main effect is opening
      // its own microphone in this one's place.
      node?.port.close?.()
      node?.disconnect()
      source?.disconnect()
      void ctx?.close()
      stream?.getTracks().forEach((t) => t.stop())
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [wantsBargeIn, transcribes, path, chosen])

  // The browser's own ears — this module's original path (mesa task 873),
  // restored rather than deleted by mesa task 956 and now the fallback for a
  // machine with no `auris` (mesa task 957): guarded on `path === 'browser'`
  // so this and the capture effect above are mutually exclusive, and built to
  // feed the exact same downstream (`heldWith`, `flushRecording`, the two send
  // boundaries) so nothing past this effect can tell which one ran. The two
  // differences that *do* show, on purpose: this path has a real interim
  // guess (`setInterimNow`, non-empty) where capture only ever has
  // "transcribing…", and `markHeard` fires on every `onresult`, interim
  // included, rather than on an audible frame — the same question, "is the
  // person still talking", answered by whatever signal this engine actually
  // gives.
  //
  // `transcribes === null` is the effect this pending-probe split exists to
  // guard: `path` above reads an unanswered probe as `'browser'` whenever
  // this browser has a recognizer, purely so the render never claims
  // "neither can listen" for that gap — but starting the recognizer on that
  // guess would open a real microphone only to tear it down a beat later
  // once the probe confirms auris is the actual answer. So this effect (and
  // the capture effect above, symmetrically) waits for `transcribes !== null`
  // on top of `path`, even though `path` alone would already have been
  // `'browser'`.
  useEffect(() => {
    if (!wantsMic || transcribes === null || path !== 'browser') return
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
        // Every result restarts the silence wait, interim or settled alike —
        // a pause the person fills back in mid-sentence must not be read as
        // them having finished (mesa task 917).
        markHeard()
        const heard = readResults(Math.max(event.resultIndex, settled), event.results)
        settled = heard.settledThrough
        // Corrected before either half is used anywhere else (mesa task 922):
        // the interim matters too, since `heldFlush` can send it as the tail
        // of a turn, and a preview showing the mishearing would be corrected
        // out from under the person the moment they stopped talking.
        const final = correctVocabulary(heard.final, vocabRef.current)
        const interim = correctVocabulary(heard.interim, vocabRef.current)
        if (running) setInterimNow(interim)
        const text = utteranceFrom(final)
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
        // preview mesa is already talking over. (Mesa task 1154's drain is the
        // auris path's: this engine never enqueues on the chain, so `mayHold`
        // reads `draining` as false here and the verdict is unchanged.)
        if (running) {
          // The preview is cleared here rather than waiting for the next
          // event: the words it showed have just been recorded, and leaving
          // them under the box would read as a second sentence still coming.
          setInterimNow('')
        }
        // A spoken "hold on" is the Pause button, not a sentence for the
        // agent (mesa task 1160) — the auris path's rule, applied to this
        // engine's finals, with the same delivery-time gate: `stop()` can
        // deliver this final after End, and a pause written then would start
        // the next conversation paused. Only while listening: this engine is
        // torn down for the length of every reply, so there is no barge-in
        // here.
        if (isPausePhrase(text)) {
          if (armed.current.live && !pausedRef.current) pauseNowRef.current()
          return
        }
        if (
          mayHold({
            live: armed.current.live,
            paused: pausedRef.current,
            muted: mutedRef.current,
            draining: false,
          })
        ) {
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
  }, [wantsMic, transcribes, path, chosen, listInputs, markHeard, setInterimNow, setRecordingNow])

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
    // The whole pending list, not just its head: a page that may not speak
    // still walks past the turns it cannot say, to perform what they do to
    // the browser (mesa task 1267).
    for (const turn of pendingTurns(held.current, handled.current)) {
      // What the turn does to the page — once per browser, speaker or not,
      // and remembered in its own set so a page that skips the words neither
      // re-navigates on the next poll nor loses the right to say them later.
      if (actsOn(turn, performed.current)) {
        performed.current.add(turn.id)
        const target = navigateTarget(turn)
        if (target !== null && window.location.hash !== target) {
          window.location.hash = target
          // mesa moved the browser, so the words that follow are still mesa's
          // to take — even if the person had deliberately clicked elsewhere
          // before.
          reclaim('navigated', armed.current)
        }
        const sidebars = sidebarsIntent(turn)
        // Idempotent by construction: App holds the flags, so asking twice for
        // the state they are already in changes nothing.
        if (sidebars !== null) onSidebars(sidebars === 'collapse')
      }
      if (spokenText(turn) === null) {
        // A pure navigate turn: it has already done its work. Taken in hand
        // and stamped by every browser that reaches it, exactly as before —
        // the stamp is idempotent server-side.
        handled.current.add(turn.id)
        markPlayed(turn.id)
        continue
      }
      if (!takesToSpeak(turn, session?.speaker ?? null, client)) {
        // Another browser holds the voice. This page takes the turn in hand
        // for *nothing* — it stays on the pending list, so the speaker says
        // it, and if that browser is closed mid-sentence and its claim goes
        // stale, this page can still pick the turn up rather than the
        // conversation going quiet.
        continue
      }
      handled.current.add(turn.id)
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
    judge.current = judgeWatchdog
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
  // finished saying the sentence that follows it. The window box (task 895)
  // is the third member on exactly that argument: it says which desktop
  // window the route and the focus are showing in, so the agent can take a
  // picture of the page it is being told about.
  const reportTimer = useRef<number | null>(null)
  const reported = useRef<{
    route: string
    context: LiveContext | null
    window: LiveWindow | null
  } | null>(null)
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
      const box = windowBox(window)
      const last = reported.current
      if (
        last !== null &&
        last.route === route &&
        sameContext(last.context, context) &&
        sameBox(last.window, box)
      ) {
        return
      }
      // Remembered only once it landed, so a failed report is retried by the
      // next trigger rather than being treated as already told.
      reportLiveRoute(route, context, box, client)
        .then(() => {
          reported.current = { route, context, window: box }
        })
        .catch(() => {})
    }, REPORT_DEBOUNCE_MS)
  }, [client])
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
  //
  // And while it is live, a slow sample on the poll's own cadence — because a
  // window that has **moved** announces itself to nobody. A resize fires
  // `resize`; dragging a window across the desktop fires no DOM event at all,
  // there being none to fire, so the only way to notice it is to look. Looking
  // costs nothing: the sample is four properties the browser already has, and
  // the dedupe above swallows every tick where the box is where it was, so a
  // window nobody touched posts exactly nothing for the whole conversation.
  useEffect(() => {
    if (!live) return
    reportRoute()
    const timer = window.setInterval(reportRoute, POLL_MS)
    return () => window.clearInterval(timer)
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

  // Drag-resize (mesa task 1144): the handle is on the panel's left edge and
  // the panel sits at the right of `.shell-body`'s row — with the agents
  // sidebar possibly to its right, since App renders the live slot just
  // before `<AgentSidebar>` — so the new width is the distance from the
  // pointer to the panel's *own* right edge, never the viewport's. The
  // ceiling is what is left of the row between `main`'s left edge and that
  // same right edge once `main` keeps its floor, which also subtracts the
  // agents panel's width for free. Listeners live on `document`, not the
  // handle, so the drag keeps tracking when the pointer outruns it
  // (`AgentSidebar`'s own splitter, and its reason).
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const aside = asideRef.current
      if (aside === null) return
      const right = aside.getBoundingClientRect().right
      const mainLeft = document.querySelector('main')?.getBoundingClientRect().left ?? 0
      const next = clampLiveSidebarWidth(right - e.clientX, right - mainLeft - MIN_MAIN_WIDTH)
      widthRef.current = next
      setWidth(next)
    }
    const onUp = () => {
      setResizing(false)
      // Stored on release rather than per frame: a drag is one decision, and
      // localStorage is synchronous.
      if (widthRef.current !== null) saveLiveSidebarWidth(widthRef.current)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('live-sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('live-sidebar-resizing')
    }
  }, [resizing])

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
      // Joining used to call nothing at all: the press *was* the whole point,
      // and the run can start on whatever the conversation has already said.
      // As of mesa task 1267 it makes exactly one call — the claim on the
      // voice, since "listen here" is precisely what this press means. It is
      // also the moment capture takes the keyboard (the went-live effect
      // above fires on `unlocked` landing).
      claimVoice()
      pump.current()
      setOpen(true)
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
      // Going live is what the panel is for, so the press that starts a
      // conversation surfaces it (mesa task 1144) rather than leaving it a
      // second click away behind the toggle. Joining, above, does the same.
      setOpen(true)
      startLive()
        .then(() => {
          // There is a session to claim only now, and the press that starts a
          // conversation is also the one that says it should be heard here.
          claimVoice()
          return refetch()
        }, failed)
        .finally(() => setPending(null))
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
   * sounding — the same `silence()` ending a conversation uses — after handing
   * the turn it cut off back to the run (mesa task 1161). Resuming just starts
   * the run, which says that sentence again from its start and then catches up
   * on everything that landed in the meantime, in order.
   */
  function togglePause(button: LiveButton) {
    if (button.action === 'pause') {
      pauseNow()
      return
    }
    setPausedNow(false)
    // Stepping back in is a press like Listen, and means the same thing:
    // speak here again (mesa task 1267). A pause gives the claim up only by
    // letting it go stale, which is what frees a browser that never comes
    // back.
    claimVoice()
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
    // `draftRef` is the draft's authoritative value — `updateDraft` writes it
    // alongside the render state — so it is what `post` and this function's
    // own clearing below both read.
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
        refetch()
      },
      (err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err))
        // The failure is only visible inside the panel, so a closed one opens.
        setOpen(true)
        // The line was never recorded, so it belongs back in the box rather
        // than lost — re-dictating it is the one thing a person cannot redo.
        // It goes back in unmarked: Enter is simply how it is retried.
        if (draftRef.current === '') updateDraft(text)
      },
    )
  }
  useEffect(() => {
    postRef.current = post
  })

  // Whether the person is being heard right now — the recording so far, a
  // segment still on its way back from `auris`, or a frame audible recently
  // enough to still count (mesa task 1073). One predicate, `showsHearing`,
  // for both this and the status pill above the composer, because they are
  // the same question asked twice.
  //
  // The hold is what this used to be missing. `level >= onsetRms` is a single
  // audio frame, so it chattered between syllables, and the two signals it
  // was or-ed with are edge-triggered and do not overlap — so the sign of
  // being heard blinked its way through every sentence. `voicedAt` held for
  // `HEARING_HOLD_MS` bridges the VAD's own hangover into the in-flight
  // segment, and the effect beside its state is what renders the moment it
  // runs out. Still auris-path-only, exactly as before: `voicedAt` and
  // `level` are written only inside the capture effect and `hearing` only by
  // the chain that effect enqueues on, so on the browser path (mesa task 957)
  // this falls through to that path's real `interim` guess instead.
  const voiced = showsHearing({
    recording: '',
    interim: '',
    hearing,
    voicedAt,
    now: Date.now(),
    holdMs: HEARING_HOLD_MS,
  })

  // What the header band says about the conversation (`liveIndicator.ts`):
  // mesa speaking, the person being heard, the agent at work, or the
  // microphone simply open.
  const indicator = headerIndicator({
    live,
    joined: unlocked,
    speaking,
    recognizes,
    // The recording counts as being heard (task 889): between two settled
    // sentences the guess is empty for a beat, and bars that drop back to
    // "listening" there would say mesa had taken what was said and moved on
    // — when in fact it is still held, waiting for the switch. `voiced` folds
    // in the same idea one level lower: `liveIndicator.ts` only ever checks
    // whether this string is empty, never what it says, so `'hearing'` is a
    // placeholder in exactly the sense `recording`/`interim` themselves were.
    interim: voiced ? 'hearing' : interim !== '' ? interim : recording,
    draft,
    paused,
    // The agent's own half of the band (mesa task 894), and the only part of
    // it the server knows: `working_since` is stamped when the agent takes an
    // utterance and cleared when it goes back to waiting, so it arrives on the
    // 2s poll the page already makes and needs no state of its own here.
    working: session?.working_since != null,
    // Resting at a handoff while the dream pass runs (mesa task 1155): the
    // same poll, the same shape, and it outranks the span the outgoing
    // agent may have left on the row.
    resting: session?.resting_since != null,
  })

  const groups = turnGroups(turns)
  // Pulled out of the object so its narrowing survives into the handler below.
  const secondary = controls.secondary
  const pauseButton = controls.pause
  // The press that ends the conversation, wherever `liveControls` put it
  // (mesa task 1069): the primary while this browser has joined, the secondary
  // while it has not and `Listen` leads instead. At most one of the two is
  // ever a real End, and the panel head is where it now lives.
  const endButton = endsInHead(controls.primary)
    ? controls.primary
    : endsInHead(secondary)
      ? secondary
      : null
  // What the head says about the conversation, in one word (`liveHead.ts`) —
  // the same ranking the aperture beside it draws.
  const headTitle = liveHeadTitle({
    live,
    speaking,
    paused,
    interim: interim !== '' ? interim : recording,
    draft,
    error: actionError,
  })
  // Whether mesa is saying something *right now*, for the status pill above
  // the composer. `sounding` is a ref because the run advances from a media
  // event, ahead of any render — but `speaking` is state, set from the
  // element's own `playing` and cleared everywhere the ref is, so a render
  // that sees `speaking` sees a ref that has already been written.
  const speakingTurn = speaking
    ? (turns.find((turn) => turn.id === sounding.current) ?? null)
    : null
  const speakingText = speakingTurn === null ? null : spokenText(speakingTurn)
  // The one line above the composer (mesa task 1153, replacing task 1069's
  // preview panel — which showed the words in flight, but at a fixed height
  // that hid the end of them). `showsHearing` is the same visibility rule the
  // panel had, hold included (mesa task 1073): none of the three raw signals
  // covers the person's *first* sentence, which is heard for at least the
  // VAD's hangover before a segment exists to be in flight, so a pill on the
  // raw signals would appear only once a segment was posted and vanish again
  // at every boundary. The hold off the last audible frame is what makes it
  // steady, and it still drops when they go quiet: the timer beside
  // `voicedAt`'s state clears the stamp exactly when the hold runs out, and
  // the capture effect's cleanup clears it the moment the microphone closes.
  const pill = statusPill({
    speaking: speakingText !== null,
    // The report about the agent (mesa task 1157): its job blocked on a
    // prompt, straight off the poll.
    blocked: (data?.blocked ?? null) !== null,
    heard: showsHearing({
      recording,
      interim,
      hearing,
      voicedAt,
      now: Date.now(),
      holdMs: HEARING_HOLD_MS,
    }),
    // One-shot transcription has no partial result to show mid-segment
    // (mesa task 957), so the note while a segment is on its way back from
    // `auris` is the sign anything is happening; the browser path's own
    // interim guess is the same sign, and reads as plain hearing.
    transcribing: interim === '' && hearing > 0,
  })

  return (
    <div className="live-hub">
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
      {/* Bringing the whiteboard back (mesa task 1113). `boardPanelFor` only
          ever *opens* on a board newer than `seen`, so hiding the panel used
          to be one-way: short of the agent re-pushing identical content there
          was nothing that showed it again (session 83). */}
      {showsBoardReopen(nextBoardPanel, boards) && (
        <button
          type="button"
          className="live-toggle live-panel-toggle"
          aria-label="show the whiteboard"
          onClick={() => {
            setBoardPanel(openBoardPanel)
            // A press on mesa's own controls hands the keyboard back to mesa.
            reclaim('hub-press', armed.current)
          }}
        >
          <BoardMark />
        </button>
      )}
      {/* The header keeps only the presses that *begin* a conversation —
          `Go live`, and the `Listen` that joins one already running (mesa
          task 1069). Ending it moved into the panel head, beside Pause and
          the transcript it is about, so the one press that destroys the
          conversation is no longer a neighbour of the one that opens the
          panel. `Going live…` is the exception `endsInHead` names: it is
          labelled `stop` while the spawn runs, and it stays here, where the
          person pressed and is still looking. */}
      {!endsInHead(controls.primary) && (
        <button
          type="button"
          className={`live-toggle${controls.primary.action === 'stop' ? ' live-on' : ''}`}
          disabled={controls.primary.disabled}
          onClick={() => act(controls.primary)}
        >
          {controls.primary.label}
        </button>
      )}
      {/* Present only while there are two things worth doing at once — the
          conversation is running and this browser has not joined it yet. In
          that pair the secondary is the End, which the head takes. */}
      {secondary && !endsInHead(secondary) && (
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
            ref={asideRef}
            className={`live-sidebar${open ? '' : ' collapsed'}${resizing ? ' resizing' : ''}`}
            // Nothing stored and nothing dragged means no inline property at
            // all — the stylesheet's `min(26rem, 40vw)` is the default, not a
            // number. The phone tier's drawer sets `width` directly, so this
            // property does not reach it.
            style={
              width === null
                ? undefined
                : ({ '--live-sidebar-width': `${width}px` } as CSSProperties)
            }
            aria-label="the live conversation"
          >
            {/* Only while open: the pointer cannot reach a clipped edge, and
                a handle on a zero-width aside would straddle the page's own
                right margin. Hidden on the phone tier by App.css. */}
            {open && (
              <div
                className="live-sidebar-resize-handle"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setResizing(true)
                }}
                onDoubleClick={() => {
                  widthRef.current = null
                  clearLiveSidebarWidth()
                  setWidth(null)
                }}
              />
            )}
            <div className="live-sidebar-body">
              {/* The head (mesa task 1069): the aperture, one word for what
                  is happening, how loud the room has been, and the two
                  presses that belong to a running conversation. It is the
                  panel's own instrument cluster — everything here used to be
                  either in the page header, where it had to answer for a
                  conversation whose panel was usually shut, or nowhere. */}
              <div className="live-sidebar-head">
                <div className="live-head-row">
                  {/* Fixed box whether or not there is a state to draw, so the
                      row does not jump 44px sideways the moment the aperture
                      has something to say. */}
                  <div className="live-head-aperture">
                    {indicator !== null && <LiveBand state={indicator} level={level} />}
                  </div>
                  <div className="live-head-say">
                    <div className="live-head-title">{headTitle}</div>
                    {/* The level meter (mesa task 956, moved here by 1069):
                        shown on the auris path alone, since a browser-path
                        page reports itself through the interim guess instead
                        and a meter nothing feeds would read as broken rather
                        than as "this path uses something else". */}
                    {path === 'auris' && recognizes && <LiveMeter level={level} />}
                  </div>
                  <div className="live-head-actions">
                    {/* Stepping out without ending it (mesa task 882) — offered
                        only while the conversation is live and this browser is
                        in it. Sits before End so the press that destroys the
                        conversation stays last. */}
                    {pauseButton && (
                      <button
                        type="button"
                        className="live-icon live-icon-pause"
                        aria-label={
                          paused ? 'resume the conversation' : 'pause the conversation'
                        }
                        title={pauseButton.label}
                        // Out of the tab order while the panel is clipped, for
                        // the reason the close button is: `pointer-events`
                        // stops the mouse, not a Tab.
                        tabIndex={open ? undefined : -1}
                        disabled={pauseButton.disabled}
                        onClick={() => togglePause(pauseButton)}
                      >
                        {paused ? <ResumeMark /> : <PauseMark />}
                      </button>
                    )}
                    {endButton && (
                      <button
                        type="button"
                        className="live-icon live-icon-end"
                        aria-label="end the conversation"
                        title={endButton.label}
                        tabIndex={open ? undefined : -1}
                        disabled={endButton.disabled}
                        onClick={() => act(endButton)}
                      >
                        <EndMark />
                      </button>
                    )}
                    <button
                      type="button"
                      className="live-icon live-sidebar-close"
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
                      <CloseMark />
                    </button>
                  </div>
                </div>

                {/* How long, and what this conversation is about. Both are
                    shown only where they are actually known: a session that
                    has not started has no clock, and an unscoped one has no
                    project — a fabricated chip is worse than a missing one. */}
                <div className="live-head-meta">
                  <span className="live-head-clock">
                    {session !== null && (
                      <>
                        <LiveElapsed startedAt={session.started_at} /> ·{' '}
                      </>
                    )}
                    Naru
                  </span>
                  <span className="live-head-chips">
                    {recognizes && (
                      <span className="live-chip live-chip-mic">Mic ready</span>
                    )}
                    {projectName !== null && (
                      <span className="live-chip">Project · {projectName}</span>
                    )}
                  </span>
                </div>

                {/* The sentence under the instruments: what the conversation
                    is doing in the words a person would use, and the one place
                    a failed press is reported. The title above says the state
                    in a word; this says why — "no agent is attached", "press
                    Go live" — which a one-word title cannot. */}
                <span
                  className={`live-head-status ${actionError !== null ? 'error' : 'muted'}`}
                >
                  {liveStatusLine(session, speaking, actionError, paused)}
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
                      <div className="live-who">{turnLabel(group.role, group.notice)}</div>
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

              {/* What is happening right now, in one word or two (mesa task
                  1153) — one pill between the settled transcript and the box,
                  since at any moment there is at most one thing in flight.
                  `statusPill` ranks mesa's own line above the person being
                  heard for `liveIndicator.ts`'s reason: while she speaks the
                  microphone is shut. The row is always rendered, at a fixed
                  height, with the text hidden rather than the element gone:
                  the composer must not jump as the pill comes and goes, and a
                  live region that is *mounted* when its text changes is
                  announced where a freshly mounted one often is not. */}
              <div
                className={`live-status-pill${
                  pill === 'Naru speaking'
                    ? ' live-status-mesa'
                    : pill !== null
                      ? ' live-status-hearing'
                      : ''
                }`}
                aria-live="polite"
              >
                {pill ?? ''}
              </div>

              <form
                className="live-composer"
                onSubmit={(e) => {
                  e.preventDefault()
                  send()
                }}
              >
                {/* The box and the switch, on one line (mesa task 1069):
                    the microphone is a square beside the field rather than a
                    word above it, since it is the other way of saying the
                    same thing the box is for. Both stay in the panel rather
                    than the header cluster (mesa task 887) — they are
                    settings on the conversation's input, read at the moment
                    the person is deciding whether to talk or to type. */}
                <div className="live-input-row">
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
                          ? 'paused — press Resume to talk to Naru'
                          : recognizes
                            ? 'listening — or type here'
                            : 'dictate or type here…'
                    }
                    aria-label="say something to Naru"
                    onChange={(e) => updateDraft(e.target.value)}
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
                  {/* Offered on the same terms as Pause: there is a live
                    conversation, this browser is in it, and the microphone
                    could actually open — a browser with no recognizer, or one
                    whose microphone was refused, has nothing for this switch
                    to do, and the caption below says which of the two it is.
                    A switch reading "listening" before the conversation has
                    started would claim something that is not happening.

                    A press, not a hold (mesa task 1069 kept this deliberately):
                    it is the same toggle the ⌘/Ctrl+Shift+L chord drives, and
                    the two must not mean different things. */}
                  {live && unlocked && supported && !blocked && (
                    <button
                      type="button"
                      className={`live-icon live-mic${muted ? '' : ' live-on'}`}
                      aria-pressed={!muted}
                      aria-label={
                        muted ? 'listen through this browser' : 'stop listening'
                      }
                      // Out of the tab order while the panel is clipped, for
                      // the same reason the close button is: `pointer-events`
                      // stops the mouse, not a Tab, and an invisible control
                      // that toggles the microphone on Enter is worse than a
                      // button nobody can reach.
                      tabIndex={open ? undefined : -1}
                      title={`${
                        muted ? 'Listen through this browser' : 'Stop listening'
                      } (${listenChordLabel})`}
                      onClick={() => toggleListening(!muted)}
                    >
                      <MicMark />
                    </button>
                  )}
                </div>
                {/* The caption under the box: which microphone, and what the
                    page is doing with it. The chooser moved down here from
                    the row above (mesa task 1069) — it is a machine-local
                    setting read once, not a control the person reaches for
                    mid-sentence, and the box and the switch own that line
                    now. */}
                <div className="live-caption">
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
                  <span className="live-hint muted">
                    {captureHint({
                      live,
                      joined: unlocked,
                      path,
                      blocked,
                      listening: recognizes,
                      paused,
                      muted,
                      chord: listenChordLabel,
                    })}{' '}
                    {!paused && 'Enter sends.'}
                  </span>
                </div>
              </form>
            </div>
          </aside>,
          slot,
        )}

      {/* The whiteboard (mesa task 1071), portalled into its own slot beside
          the conversation's. A second portal rather than a second component
          higher up: the hub already holds the one poll this reads, and the
          panel opens on a board arriving — which only the code watching that
          poll can know. It renders nothing but the render route's URL; there
          is no board write route at all, and the close button below only
          closes. */}
      {boardSlot !== null &&
        createPortal(
          <LiveBoardPanel
            boards={boards}
            open={nextBoardPanel.open}
            onClose={() => setBoardPanel((panel) => ({ ...panel, open: false }))}
          />,
          boardSlot,
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
