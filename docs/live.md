# Mesa live (a spoken conversation with an agent)

**Mesa live** is a conversation mode: a person talks to mesa, mesa talks back,
and a dedicated Claude Code session does whatever they ask. Tables
`live_sessions` and `live_turns` (migration index 43), the `mesa live` CLI
group, `/api/live*`, and the header's conversation hub (`LiveHub`).

The two directions are deliberately asymmetric, and the asymmetry is the whole
design:

- **Person → mesa is typed text.** The hub's popup has a plain `<textarea>`, and
  the person's *own* system dictation (macOS Dictation, a phone keyboard's mic
  key, or their fingers) types into it. **mesa ships no speech-to-text,
  captures no microphone, and accepts no audio request body.** See
  [What is deliberately absent](#what-is-deliberately-absent).
- **mesa → person is speech.** A mesa turn is synthesised by `kokoro-rs` and
  streamed back to the browser, through the same `speech::start` and the same
  browser-side player the Inbox's play button uses (`docs/inbox.md`). The audio
  path stays **one-directional, server to browser**, exactly as it was before
  this feature.

## The loop, and why it pulls

A live session is a loop the **agent** runs, not one mesa drives:

1. `mesa live listen` — the agent asks for the next thing the person said. A
   turn, or `null` when nobody spoke for the whole wait (570s by default, and
   long on purpose: see *quiet time is spent inside `listen`* below).
2. It does the work with the ordinary mesa CLI and its own tools.
3. `mesa live say "…"` — the reply, which the browser speaks.
4. `mesa live navigate '#/…' --say "…"` — optionally, it moves the person's
   browser as it answers, and `mesa live sidebars collapse|expand` gives that
   page the whole window, or hands the side panels back.
5. `mesa live status` printing `null` (or an `ended` session) is how it stops.

The agent **pulls**. That is not a style choice: mesa has no way to push at it.
The only channel into a live Claude Code session is keystrokes over the attach
PTY, and the only way to read its replies is to tail a transcript file — which
is exactly why the Agents sidebar's chat composer types into the PTY rather
than calling a send route (`docs/agents.md`). Building a second write path into
a session for this feature would mean owning that PTY, and the whole
conversation would then depend on a terminal nobody is watching. So mesa writes
the utterance to the database and lets the agent come and get it, over the CLI
it already uses for everything else.

The consequence at the other end is the same shape mesa already has everywhere:
**there is no push channel to the browser either**, so the hub polls
`GET /api/live?after=<cursor>` at 2s through the ordinary `useFetch` polling,
like every other view.

The instruction block the agent is spawned with is
`core::live::AGENT_PROMPT` — one constant in `core`, because both spawn sites
(the CLI's `live start` and `POST /api/live`) hand the same text to the same
`agents::spawn_bg` chokepoint. It states the loop, the route vocabulary, the
"this is speech, so write prose" rule (a bulleted reply gets read aloud as
punctuation) and the untrusted-input posture below. `live::agent_prompt(id)`
appends the session id — the only per-call part.

That block is the **default**, not the only possibility: `~/.mesa/config.json`'s
`live.prompt` replaces it whenever the Settings page has one (mesa task 867,
`docs/config.md`). Read on every start, so an edit lands on the next
conversation with no restart; blank means the built-in, and the session line is
the one thing mesa still appends either way. A rewritten prompt is how the
conversation changes character — but the loop `AGENT_PROMPT` describes is what
makes the feature work, and a prompt that never mentions `mesa live listen`
produces an agent that hears nothing.

## Why the queue lives in SQLite

The turn queue is two tables, not a channel in the server's memory, because
**the agent never talks to the server**. Every `mesa` command opens its own
`Store` against the database file directly (CLAUDE.md's "CLI and API share
`core` and never diverge"), so anything held in `mesa serve`'s process is
invisible to `mesa live listen` — the comment at the top of
`frontend/src/useFetch.ts` says the same thing from the other side: agents
write SQLite out of the server's sight, and no push channel is possible.

The database is therefore the meeting point, and it also buys the property an
in-memory queue would have had to invent: `next_user_turn` is **one**
`UPDATE … RETURNING` that both picks the oldest undelivered `user` turn and
stamps `delivered_at`, so two listeners can never be handed the same utterance
and answer it twice.

## One session at a time

`start_live_session` refuses to start a second conversation while one is
`live` — a `conflict` naming the id that is already running. The hub has
one text field and one `<audio>` element; a second conversation would have
nowhere to be heard. That is what lets every other command drop the session
argument entirely: `stop`, `status`, `listen`, `say`, `navigate`, `sidebars`
and `turns` all resolve **the** current session through
`current_live_session`.

Stopping is idempotent *in the store*: `end_live_session` stamps `ended_at` on
the row only while it is still `live`, so a page and an agent stopping at once
echo the ended session rather than one of them failing, and the first ending is
the one recorded — the same rule, for the same reason, as an inbox item's
`read_at`. Stopping when **nothing** is live is a different question and is
`not_found` on both surfaces: the caller asked to end a conversation that isn't
there.

## What a turn may be

Every shape rule lives in `Store::add_live_turn`, the single write path for
turns (schema enforces none of it, per CLAUDE.md):

- The session must exist and still be `live`. A turn on a dead conversation is
  a caller bug, so it is a **`validation`** error rather than a swallowed
  write — and deliberately not `not_found`, because the session is right there,
  it is just over.
- A **`user`** turn carries non-empty text and nothing else: the page dictates,
  it does not drive itself.
- A **`mesa`** turn must say something **or** do something. Empty text is legal
  exactly on a pure action turn, which changes the page and speaks nothing.
- An **`action`** is one of `navigate`, `collapse-sidebars` and
  `expand-sidebars`. `navigate` must carry a `target`; the two sidebar verbs
  must carry none — a route on one is a caller who meant `navigate`, not a
  field to ignore. A `target` with no action is a `validation` error rather
  than a field nothing reads.
- A `target`, and the route the page reports through `set_live_route`, pass the
  **one** route rule (`validate_live_route`): trimmed, non-empty, ≤ 200 chars,
  and starting with `#/`. Both go through it so the agent can never send the
  browser somewhere the session could not have recorded.
- `text` is trimmed and capped at 8192 characters, because it is **spoken**: a
  runaway body would wedge the synthesiser rather than say anything.

`played_at` is the browser's stamp — set the first time a turn is actually
heard, never moved and never cleared, and idempotent so the poll can fire it
without tracking whether it already has. `list_live_turns` takes an exclusive
`after` cursor and clamps `limit` into `1..=500`.

`live_turns.session_id` is **`ON DELETE CASCADE`** — a turn is part of a
conversation, not a record of its own. `live_sessions.project_id` is
**`ON DELETE SET NULL`**, the same call the inbox makes: a conversation
outlives the project row it happened to be about.

## The action vocabulary

Three values, and they are all one idea: **what the person is looking at.**

`navigate`'s target is one of the app's own hash routes — `#/`, `#/live`,
`#/inbox`, `#/cc`, `#/scripts`, `#/settings`, `#/terminal`, `#/projects/<id>`
and that project's `tasks/<id>`, `diagrams`, `git`, `files`, `terminal`,
`dashboard` and `settings`. The list is in `AGENT_PROMPT` so the agent knows
what it may say; the *rule* mesa enforces is only the `#/` shape, since the
route inventory is the frontend's business and pinning a second copy of it in
`Store` would be a copy to go stale.

`collapse-sidebars` and `expand-sidebars` (mesa task 859) fold the app's two
side panels — the left nav and the agents sidebar — away and back. They are the
other half of "show me that": a person talking hands-free asked for a page, and
sometimes what they want is the *room* for it. Both panels move together,
because "the sidebars" is the pair; the two flags already live in `App`
(the phone tab bar writes the same two), so `LiveHub` relays the request rather
than owning any collapse state of its own. They carry **no target** — the verb
is the whole instruction, which is why they are two values rather than one verb
plus a state argument stuffed into a column that otherwise means a route.

There is nothing beyond that. Moving the browser and giving it room are things
a conversation genuinely needs; anything more — click this, fill that — is a
remote-control vocabulary, and the agent already has the whole mesa CLI for
actually changing things.

## CLI

`mesa live` — every command operates on the one current session.

| Command | Args | Prints |
| --- | --- | --- |
| `live start [PROJECT]` | `--project P` (id **or** name), `--no-agent` to skip the spawn | the started `LiveSession` |
| `live stop` | — | the ended `LiveSession` |
| `live status` (alias `get`, `show`) | — | the live `LiveSession`, or `null` |
| `live listen` | `--wait <SECONDS>` (default 570, `0` = poll once) | the next undelivered user `LiveTurn`, or `null` |
| `live say <TEXT>…` | trailing var arg, like `inbox add` — put every flag **before** the message | the `LiveTurn` |
| `live navigate <ROUTE>` | `--say <TEXT>`; without it the turn is a pure action and says nothing | the `LiveTurn` |
| `live sidebars <collapse\|expand>` | `--say <TEXT>`, same rule; takes no route | the `LiveTurn` |
| `live turns` | `--after <ID>`, `--limit <N>` (clamped to 1..=500) | a bare array of turns, oldest first |

`turns` is the **transcript**, not the queue: both roles, including turns
already delivered or spoken, and reading it delivers nothing. Only `listen`
takes an utterance off the queue.

### Put every flag before the message

`live say` takes its message as a **trailing var arg** — everything after `say`
that is not a leading flag is the message, quoting optional, words joined. So:

```bash
mesa live say --quiet "Working on it."     # right: --quiet is a flag
mesa live say "Working on it." --quiet     # WRONG: mesa says "Working on it. --quiet"
```

The second form is not an error and prints no warning; it speaks the flag. This
is exactly `inbox add`'s behaviour (its `--task`/`--author`/`--kind` go before
the text for the same reason) and it stays that way — a message must be able to
contain anything, including something that looks like a flag, and only position
can settle which is which. But it is a sharper trap here, because the spoken
result is what the person **hears**, and because `AGENT_PROMPT` tells the
session to run this command in a loop. `--quiet` is the only flag `say` has, so
the whole rule is: put it first.

`live navigate` is not affected — its route is a plain positional and `--say`
takes exactly one value.

- **`listen` timing out is data, not an error.** It polls the store every
  500 ms and exits **0** printing `null` when `--wait` elapses, so the agent's
  loop is `listen` → maybe reply → `listen` again, with no error handling in
  the middle of it. A quiet minute is not the end of a conversation. It also
  returns `null` **early** when the session ends while it is waiting, so a
  conversation stopped from the web UI is noticed in the same second rather
  than up to a wait later.
- **Quiet time is spent inside `listen`, not in the agent's loop** (mesa task
  871). Both ends of the wait are a wait — but one is free and the other is
  not: blocking inside this process costs a sleeping thread, while every `null`
  the agent sees costs a whole model turn carrying the conversation so far. A
  session left idle at the old 60s default spent ten turns an hour saying
  nothing (and, prompted to check `mesa live status` each time round, more than
  that). So the default wait is **570s** and `AGENT_PROMPT` names no `--wait` at
  all: it tells the agent to give the command ten minutes and to run *nothing
  else* while it is quiet — no status check, no "still quiet" narration. 570
  rather than 600 because a Claude Code session caps one command at ten
  minutes: the wait must end by printing `null`, not by being killed. The
  session's end is still noticed promptly — `listen` returns early on it, and
  every later `live` command reports there is no live session, which is the
  stop signal the routine `status` poll used to be.
- **`start` spawns the agent** through `agents::spawn_bg` with the
  `live-agent` command template (`docs/config.md`), in the project's
  `local_path` when that is a live directory and `$HOME` otherwise — the
  inbox-watcher's fallback, for the same reason: a conversation is not scoped
  to a checkout (its `project_id` is optional and it outlives that project), so
  a missing or stale path is a session with no working folder, not a bad
  request. Both surfaces name the session the same way — `<project>: live <id>`,
  or `mesa live <id>` when the conversation is bound to no project — so one
  conversation reads the same in the Agents sidebar however it was started.
- **A failed spawn ends the session it just opened**, on both surfaces —
  `live start` exits **1** with code **`unavailable`** (the code reserved for
  something outside mesa, here the `claude` binary, not being startable), and
  the store is back where it was. The alternative — leaving a live session with
  a null `agent_id` — is a conversation nothing is listening to and that will
  therefore never answer, and because at most one session may be live it would
  also turn the obvious retry, `mesa live start` again, into a `conflict` until
  someone stopped it by hand. Ending it costs the caller one error and a retry
  instead. (A spawn that *succeeded* but printed no receipt is a different
  case: `agent_id` stays null, the session stays live, and that is not a
  failure.)
- **`stop` stops that agent**, on both surfaces — `claude stop <agent_id>`,
  the short job id the spawn receipt carried. The agent does notice on its own
  (its loop checks `mesa live status`), but noticing only ends its *turn*: the
  background session stays listed, idle, one per conversation, and the person
  who hung up reads that as mesa never letting go. So ending the conversation
  finishes the session it started — the same binary either way
  (`agents::claude_bin`), because `claude stop` takes the id `claude --bg`
  printed, and deliberately **not** a fifth command template: a template
  chooses what starts a session, and mesa must be able to stop exactly the
  session it started.
- **Stopping the agent is best-effort, and never the answer.** The store write
  is what ended the conversation. A session with `agent_id` null (`--no-agent`,
  or a start command that printed no receipt) has nothing to stop; a failing
  `claude stop` is a warning on **stderr** in the CLI and a log line in the
  server, never a nonzero exit and never anything on stdout, which stays the
  ended `LiveSession` and nothing else. The agent's own status check is the
  backstop.
- **`--no-agent`** starts the session without spawning anything, which is how
  the gate script — and a person driving both halves by hand — use it.
- **Every command but `start` and `status` is `not_found` with no session
  live**, and the hint names how to get one. `status` prints `null` and exits
  **0**: "nobody is talking to mesa" is an answer, not a failure, and it is
  what the agent's loop reads as "stop looping".
- **`--quiet`** per CLAUDE.md's contract: accepted on the mutations, on
  `listen` and on `status`, rejected with exit 2 on `turns`. A turn drops
  `text` — the one unbounded field, and the one that is *spoken* rather than
  read by the caller — and keeps its role, action and target. A session has
  nothing unbounded to drop (ids, one of two status words, a 200-char route and
  timestamps), so its quiet output equals its full output; the flag is accepted
  across the group for uniformity.

## API

| Route | Answers | Gate |
| --- | --- | --- |
| `GET /api/live?after=<id>` | one `LiveState` | standard read |
| `POST /api/live` `{project_id?}` | the started session | `require_agent_access` |
| `DELETE /api/live` | the ended session | `require_agent_access` |
| `POST /api/live/utterance` `{text}` | the dictated user turn | standard write |
| `POST /api/live/route` `{route}` | the session, route recorded | standard write |
| `POST /api/live/turns/{id}/played` | the stamped turn | standard write |
| `GET /api/live/turns/{id}/speak` | streaming `audio/wav` | `require_agent_access` **+** `require_same_site_fetch` |

Start and stop sit on `/api/live` as **verbs** rather than on an
`/api/live/{id}` pair: there is only ever one live session, so there is no id
for a caller to name.

`GET /api/live` is the page's whole read — the running session plus the turns
after the cursor it asked from, one request per poll. It answers a **real
type**, `LiveState { session: Option<LiveSession>, turns: Vec<LiveTurn> }` in
`src/core/types.rs`, not an ad-hoc JSON envelope, so the page's shape is
generated into `frontend/src/types/LiveState.ts` by ts-rs like everything else
it reads. `LiveState` is a **view, never stored** — assembled per request out
of the one live session and a slice of its turns, the same way `ProjectAgents`
pairs a folder with the sessions found under it. With nothing running it is
`{"session": null, "turns": []}` and **200**: an idle page is this route's
normal state, not an error, and the button such a page renders is exactly what
fixes it. One poll carries at most 500 turns — the ceiling `Store` clamps to
anyway — so a conversation longer than that is read in cursor-sized pages,
which is what `?after=` is for.

The three ordinary writes resolve the current session themselves, so with none
live each is `not_found` with a hint naming `POST /api/live`, the same shape
the CLI's not-found hints use.

Why each gate is what it is:

- **Start and stop carry the agent gate** because starting a conversation
  *spawns a Claude Code session* — code execution, the same capability
  `POST /api/projects/{id}/agents` exposes, so it gets the same
  mode-dependent stack (`docs/agents.md`). Stop is gated with it as a pair: the
  thing that can start the agent is the thing that can stop it.
- **Utterance, route and played are ordinary writes.** They write rows to the
  mesa store and nothing else — the same class as creating a task — so they get
  the standard `guard`, which under `--lan` is what lets the person hold the
  conversation from their phone.
- **Speak is exactly `speak_inbox`'s pair**, and both halves are load-bearing.
  `require_agent_access` because one request spends unbounded CPU in an
  external binary; `require_same_site_fetch` because every `Origin` check in
  `api.rs` passes a request carrying no Origin, and a no-cors `<audio src>`
  never carries one — so without it any page on the internet could point an
  `<img src>` at a loopback mesa and burn a core per hit. The full reasoning,
  including the `--lan` Host consequence a phone sees as a 403 on play alone,
  is in `docs/inbox.md`.
- The **Content-Type gate** applies to the mutating methods in both serve
  modes, unchanged. Nothing here is special-cased.

`POST /api/live` is two-phase like every other spawn site in `api.rs`: the
store lock is taken to open the session and read the project's `local_path`,
then **dropped** before the blocking `claude --bg` shell-out, which would
otherwise freeze every other API request for its duration. It answers **201**,
invalidating the agents cache on the way out so the Agents sidebar shows the
new session on its next poll rather than after the TTL — a live agent is an
ordinary background session.

The one behaviour the speak route does not share with its inbox twin: speaking
a turn whose `text` is empty — a pure `navigate` — is a **`validation`** error,
not silence. There is nothing to synthesise, and a 200 with no audio would look
to the page exactly like a synthesiser that died mid-render.

## Speech, reused rather than rebuilt

Nothing about how mesa speaks is new here. `GET /api/live/turns/{id}/speak` is
the inbox speak route with the body coming off a turn instead of an item: the
same `config::speech_voice()` read **fresh on every press**, the same
`spawn_blocking(speech::start)`, the same text on the child's **stdin** (not an
argument, so a body opening with `-o` cannot become an option), the same
patched `0x7FFF0000` WAV sizes, the same chunked response with no
`Content-Length`, and the same `503 unavailable` for a missing or failing
`kokoro-rs`. `MESA_KOKORO_BIN` is the same seam the checks drive it through.

The browser side is reused unchanged too, including the fallback that matters
on Apple's media stack: an `<audio>` that refuses a range-less stream fires
`error`, the page re-fetches the same URL and **decodes the WAV itself** onto a
Web Audio clock the press unlocked, and remembers that mode for the page once
decoded audio has actually sounded (`docs/inbox.md`). The hub reaches
that machinery through one small hoist made for this feature:
`playSpeechStream` now takes a **URL** rather than an inbox item id
(`speechStream.ts`, with `fetchSpeech(url, signal)` in `api.ts`), so the inbox
passes `inboxSpeakUrl(id)` and Live passes `liveSpeakUrl(id)`. That is the only
change to the inbox's speech path.

The hub's consequences follow from the same rules the inbox lives under:
there is **one `<audio>` element for the page**, and a press on the primary
control — **Go live**, or **Listen** when the conversation is already
running — is the gesture that unlocks audio. The `AudioContext` is created and
`resume()`d inside that one handler, on every press, whether or not this press
turns out to need it: a gesture is what a phone weighs, and the element failure
that says decoding is needed arrives long after the gesture is gone. Every mesa turn after that
reuses the element and the clock that press unlocked, spoken **oldest first,
one at a time**, each stamped `played` when it finishes. `played_at` only comes
back on the *next* poll, so the page also holds the turns it has taken in
hand — otherwise the two seconds after a turn starts would start it again — and
a turn that failed to speak stays in that set, which is what keeps one bad turn
from wedging the run on itself. A turn carrying `action: 'navigate'` sets
`window.location.hash` to its target when the run reaches it — in transcript
order, so the browser moves where the sentence around it said it would; a
sidebar turn folds or re-opens both panels at the same point in the run, for
the same reason.

## The header hub (`LiveHub`, task 857)

The conversation lives in the **header**, not on a page: a control cluster on
the right, beside the plan-limit chips, on every route. There is no left-nav
row and no routed page. `#/live` survives only as a **verb** — the hub
intercepts it, opens the conversation popup and puts the hash back to wherever
the person last was (via `location.replace`, so the `#/live` entry never
lands in history and Back is never trapped on it; the route report also skips
the transient `#/live` hash) — which is what keeps the agent's existing
`navigate '#/live'` vocabulary and the command-palette entry ("Live
conversation") working with no backend change.

- **The header is mounted for the life of the app**, which is the whole reason
  the conversation lives in it. `navigate` is the whole point of the feature,
  and a routed page would be torn down by the very navigation it just
  performed — cutting its own sentence off mid-word and stopping the route
  reports below.
- **While she speaks, a five-bar indicator animates centered in the header
  band** — the visible sign of speech while the popup is closed. It freezes to
  steady half-height bars under `prefers-reduced-motion`, the same rule as
  `.live-dot`'s pulse.
- **The popup opens and closes without touching the session.** A speech-bubble
  toggle sits beside the live button whenever there is a session at all —
  running, or ended with a transcript still worth reading
  (`liveControls().overlay`) — and holds the status line, the transcript and
  the capture box. Closing it calls no route; only `End` ends the
  conversation. The closed state hides by **clipping**, never `display: none`
  or `visibility: hidden`, so the capture box inside keeps its focus — and the
  dictation flowing into it — while the popup is shut.
- **While joined, the capture box holds the keyboard** (`liveCapture.ts`, the
  tested module for all of this). The person does not aim their dictation;
  mesa does: while a session is live *and* this browser has had its press,
  the box takes focus — so when a `navigate` turn opens a page with a text
  field, the words that follow still land in the conversation, not in the
  field, and the person can ask mesa to create something there without their
  speech typing into it. The referee (`userTookFocus`, `shouldReclaimFocus`):
  a focus loss to an element a person types into (`isEditableTarget`), on
  the heels of a pointer/key gesture, is the person deliberately clicking
  into a form — capture **stands down** and the form wins; every other loss
  (a page's autofocus after a navigate, a press on a button, a click on
  nothing) is taken back, because none of it means "stop listening". While
  stood down, only mesa acting again — going live, a `navigate` turn, a press
  on the hub's own controls (`hub-press`) — re-arms capture, and mesa acting
  also spends the gesture on the clock, so a keystroke that happened to
  precede a navigate cannot make its autofocus read as deliberate.
  Nothing grabs the keyboard before the press: an un-joined browser has no
  business stealing focus.
- **A settled line is sent on mesa's clock** (`shouldAutoSend`): dictation
  never presses Enter, so a non-blank draft untouched for `AUTO_SEND_IDLE_MS`
  (2s) is sent as the utterance — hands-free end to end. Enter still sends at
  once, Shift+Enter still opens a line, and the IME guard holds it while
  composing (an IME commit re-arms the timer, since committing changes no
  draft text). The firing timer reads the draft, the measured idle time and
  the IME state through refs, never its own render's closure — which is what
  makes a deadline racing an explicit Enter post nothing instead of the same
  utterance twice. A line the server **refused** is put back in the box but
  marked, and is not auto-retried until edited — Enter is the deliberate way
  to try the same text again. A failed press (`Go live` on a machine with no
  `claude`, most likely) **opens the popup**, because the error is the status
  line's to report and a failed start leaves no session for the header to
  hint with.
- **The controls are a three-state toggle, not one button.** Nothing live:
  **Go live** (`POST /api/live`). Live in a browser that has had a press:
  **End** (`DELETE /api/live`). Live in a browser that has **not** had one:
  **Listen**, with **End** beside it. A press in flight replaces the label
  (`Going live…`, `Ending…`) and disables it, so a slow spawn cannot be clicked
  twice.
- **`Listen` calls no route at all** — it exists purely to *be a gesture*, the
  thing a browser weighs its autoplay policy against, and it starts the run on
  whatever the conversation has already said. Two ordinary situations produce a
  live session with no gesture behind it: one started from `mesa live start`,
  and a page reloaded mid-conversation. Before this button the only control on
  offer there was `End`, so mesa talked and nobody heard a word, and the one
  press available destroyed the conversation. `End` moves aside to make room
  for `Listen` rather than being taken away.
- **Joining does not replay from the top.** Turns already heard carry the
  server's `played_at`, and `nextUnplayed` skips them, so a browser that joins
  late picks up where the conversation is rather than reciting it.
- **Whether *this* browser has audio is a different question from whether the
  conversation is running**, and the hub tracks it separately (`unlocked`).
  Until a press here, nothing is spoken, nothing navigates and nothing grabs
  the keyboard — the conversation may well be live on another device.
- **The status line at the top of the popup says what is actually happening**,
  and the last failure outranks everything: a line reading "listening" while
  the last call failed is the one way it can lie. It also calls out a live
  session with **no agent bound**, which would otherwise listen for ever and
  never answer.
- The **capture textarea** carries a visible hint that this is where system
  dictation types, wherever the app has navigated. Enter sends, Shift+Enter
  opens a line, and an `isComposing` guard keeps an IME's Enter out of it —
  the same composer contract as the Agent sidebar's chat box.
- The **transcript is accumulated by the hub**: each poll answers only with
  what is new (the cursor is a ref, not state — it is read inside the fetch and
  rendered nowhere), so the hub holds the conversation and the server holds
  the tail. A poll that reports a *different* session id starts a fresh
  transcript rather than merging two conversations — **`None` included**, which
  is what ending one looks like on the wire. That decision is
  `liveTurns.ts::transcriptFor`, answered once for the transcript *and* for the
  set of turns the page has taken in hand: the two coming apart is the whole of
  task 862's replay — the hub cleared `handled` while keeping every turn it
  applied to, each still carrying `played_at: null` (the cursor means the
  server never sends those rows again), and the run said the entire
  conversation over again the moment the person pressed End.
- **On arrival and on every `hashchange`** the hub `POST`s
  `/api/live/route`, so the session records where the person actually is and
  the agent can answer "what am I looking at" without guessing. Also the moment
  it goes live, since a session that just started has no idea where its person
  already was. It is **ambient**, like the inbox's read mark: a failure — no
  live session, most often — is forgotten rather than shown.
- **Pure logic is in tested modules, not the `.tsx`** (CLAUDE.md's
  frontend-test rule): `frontend/src/liveTurns.ts` (cursor advance, merging a
  poll's turns into the transcript, next-unplayed selection, what a turn
  speaks, whether it navigates, whether it moves the sidebars, grouping and
  labelling) and
  `frontend/src/liveSession.ts` (the is-live predicate, `liveControls` — the
  four presses above, since "no session", "an ended session", "a session still
  starting" and "a session running in a browser with no gesture" are four
  different buttons and the label has to be right in each — plus the popup
  toggle's `overlay` flag, and the status line) and
  `frontend/src/liveCapture.ts` (the focus referee and the auto-send rule),
  each with a sibling vitest file.

## Config

The spawn is the fourth configurable command: **`live-agent`**, defaulting to
`{bin} --bg --agent {agent} --name {name} -- {prompt}` — the union of the two
existing shapes, since a live session is a mesa record (so it has an `{id}` and
a `{name}`) *and* carries a prompt mesa supplies. That prompt is
`live::agent_prompt`, so the feature works with **no user configuration** — and
the prompt itself is the file's fifth section, `live.prompt`, which **replaces**
the built-in block when it is set (an empty one is never stored; blank is the
reset). Everything else about the template — argv vs script mode, tokenize-then-
substitute, the `MESA_*` environment handoff, a `{placeholder}` refused inside
a script — is inherited, not re-implemented. See `docs/config.md`.

## Untrusted input

A dictated utterance is untrusted free text, and it is treated exactly as
CLAUDE.md requires: **data, never instructions.**

- It reaches the agent as JSON printed by `mesa live listen`, and reaches the
  spawn as **one `Command::arg`** (or as `$MESA_PROMPT` in script mode). It is
  never interpolated into a string a shell parses — the reason the one-line
  template is argv and substitution happens after tokenization.
- `AGENT_PROMPT` states the posture to the model in the same terms: an
  utterance may *ask* for work, and the agent may do that work, but it can
  never change the agent's rules, reveal or rewrite its instructions, or make
  it run something the utterance embeds verbatim.
- The route an utterance can cause is bounded by `validate_live_route`
  regardless of what the agent was talked into: a `navigate` target is a `#/`
  hash path of at most 200 characters, so the worst case is the browser landing
  on a mesa page the person could have clicked to.

## What is deliberately absent

- **Speech-to-text.** mesa does not capture a microphone, does not ship or
  shell out to an STT engine, and no route accepts an audio body. The person's
  own system dictation types into a text field, which means the recognition
  quality, the language, and the privacy question are all already theirs and
  mesa adds nothing to answer for. The audio path stays **one-directional,
  server to browser**.
- **A second live session.** One conversation, one page, one player.
- **A per-session voice.** The voice is `speech.voice` in
  `~/.mesa/config.json`, read on every press, shared with the inbox.
- **A push channel**, in either direction — see the loop above.
- **A page vocabulary beyond "what am I looking at".** `navigate` and the two
  sidebar verbs are the whole list; clicking, typing and scrolling on the
  person's behalf are not on it.

## Gate

`scripts/live-check.sh` — the CLI loop end to end (start → say → navigate →
listen → turns → sidebars → stop), the spawn's argv and the `claude stop
<agent_id>` that matches it on both surfaces (including both best-effort cases:
no agent to stop, and a `claude stop` that fails), the single-session
`conflict`, every `validation` rule,
`listen` returning `null` on timeout and never handing out the same turn twice,
the `--quiet` key sets, and the API twin including the audio contract and both
halves of the security boundary in default **and** `--lan` mode.
