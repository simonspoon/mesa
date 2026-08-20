# Mesa live (a spoken conversation with an agent)

**Mesa live** is a conversation mode: a person talks to mesa, mesa talks back,
and a dedicated Claude Code session does whatever they ask. Tables
`live_sessions` and `live_turns` (migration index 43, plus the session's
`context` column at index **44**, its `working_since` at **45** and its
`window_box` at **46**, so a fresh db is `user_version` 47), the
`mesa live` CLI group, `/api/live*`, and the header's conversation hub
(`LiveHub`).

The two directions are deliberately asymmetric, and the asymmetry is the whole
design:

- **Person → mesa is text, recognised in the browser.** While a session is live,
  this browser has joined it and the person has **asked** it to listen (task
  887 — the microphone starts off), the page opens the microphone through the
  browser's **own** speech recognition (`SpeechRecognition` /
  `webkitSpeechRecognition`), **holds** every *final* result, and posts the
  whole recording as one `user` turn when the person stops listening (tasks
  873, 889). The conversation panel also has a plain `<textarea>`, which is
  the way in whenever the microphone is not: it is muted, or recognition is not
  on offer at all — a browser without it (Firefox
  today), or a refused microphone. There the person's *own* system dictation
  (macOS Dictation, a phone keyboard's mic key, or their fingers) types into it,
  exactly as before. Either way, **mesa ships no speech-to-text of its own,
  never sees the audio, and accepts no audio request body** — the recognition
  is the browser's and stays in the page. See
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
3. `mesa live look` — optionally, it photographs the person's browser window
   and opens the PNG, for the questions no report answers: what actually
   rendered.
4. `mesa live say "…"` — the reply, which the browser speaks.
5. `mesa live navigate '#/…' --say "…"` — optionally, it moves the person's
   browser as it answers, and `mesa live sidebars collapse|expand` gives that
   page the whole window, or hands the side panels back.
6. `mesa live status` printing `null` (or an `ended` session) is how it stops.

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
step that tells the agent to run **`mesa live status`** to find out what the
person is looking at — the page as `route` and what is open on it as `context`,
*"read it instead of asking them where they are"* (task 888) — the step that
tells it to run **`mesa live look`** when the answer depends on what actually
rendered rather than on which page is open (task 895) — the "this is
speech, so write prose" rule (a bulleted reply gets read aloud as punctuation)
and the untrusted-input posture below. `live::agent_prompt(id)`
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

## Whether the agent is working (`working_since`, task 894)

Between taking an utterance and speaking again the agent may be thinking,
reading files, running commands or waiting on a subagent — and until this
column existed the page looked exactly the same as one that never heard the
person at all. "She is working on it" and "you were not heard" are the two
readings the header band now tells apart.

The signal is one nullable timestamp on `live_sessions`, and the whole of its
logic is inside `Store::next_user_turn`:

- handing a turn over **stamps** it — that call *is* the agent starting work;
- a poll that finds nothing **clears** it — the agent's loop is
  `listen` → work → `say`, so sitting in the wait with nothing to hand out is
  the one shape "waiting on the person" has;
- `end_live_session` clears it too, and the stamp is itself scoped to a live
  session: an ended conversation is nobody's turn, so a delivery racing the end
  cannot reopen a span nothing is left to close.

Both edges live in that one method rather than in the `listen` command, so the
column cannot drift from the loop it describes and any future caller keeps it
honest for free. The clear is guarded on the column (`AND working_since IS NOT
NULL`), so the twice-a-second poll of a quiet conversation is a no-op rather
than a write, and `updated_at` is deliberately left alone — that field records
the session being bound, re-routed or ended, and a conversation that moved
through fifty utterances did none of those.

Two consequences worth stating:

- **Speaking does not end the span.** An agent that says "one moment, let me
  look" and then does the job is working for the whole of it — which is exactly
  the stretch a spinner tied to a request in flight goes dark for.
- **A session nobody has listened on reads as not working.** `--no-agent` is
  the case that makes this the right default, and it is why the column is a
  stamp cleared by the waiter rather than a flag set by the starter.

It rides on `LiveSession`, so it reaches the page on the existing 2s
`GET /api/live` poll and the agent on `mesa live status` — no new route, no new
state, and nothing pushed.

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
- The **context** the page reports alongside that route (mesa task 888) is a
  fixed four-field shape — `kind`, `id`, `label`, `detail` — and passes
  `validate_live_context`: each of the three free-text fields is trimmed,
  bounded at 200 characters (`LIVE_CONTEXT_FIELD_MAX`, the route's number for
  the route's reason — a `label` is **spoken**), and a blank one folds to
  **absent** rather than `""`, so "nothing selected" is genuinely nothing and
  the agent never has to treat an empty string as a name. `kind` needs no rule
  in `Store` at all: it is a closed enum, so serde is the gate and a page mesa
  does not have is refused before the handler ever runs. Both halves are
  validated **before either is written**, so a refused context leaves the
  stored route *and* the stored context exactly as they were rather than
  half-applying the report.
- **The context is a fixed vocabulary rather than a free-form blob**, and that
  is the decision the whole shape turns on. The agent has to be able to *say
  something useful* about what is on screen without parsing anything — "you
  have store.rs open on the Files tab" comes straight out of `kind` and
  `label` — and a free-form payload would let every page invent its own shape,
  so the agent would be reading a different schema per page and mesa would have
  no bound on any of it. Four fields, one of them a closed word, is what makes
  the report readable by something that has never seen the page that wrote it.
- **It is read back leniently.** The column is validated JSON on the way in and
  `serde_json::from_str(..).ok()` on the way out — the `waypoints` precedent
  rather than the `tags` one. A value mesa itself could not have written (a
  hand-edited row, or a column left by a newer build that knows a page this one
  does not) reads as *nothing selected*, because nothing mesa does depends on
  it and panicking a whole conversation over a decoration is the wrong trade.
- **The window box** the page reports in that same body (mesa task 895) is
  four integers and one more thing that is bounded rather than free: extents
  `1..=20000`, origins `±20000` (`validate_live_window`) — absurd bounds on
  purpose, there to refuse a garbled or hand-written report rather than to have
  an opinion about anyone's monitors, and a **negative origin is legal**,
  because a display to the left of the primary one is where a great many people
  keep their browser. It is validated before anything is written and read back
  with the context's leniency, for the context's reason: it decorates, and
  [`mesa live look`](#seeing-the-screen-mesa-live-look-task-895) already knows
  how to say "no browser has told me where it is".
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

`LiveContextKind` (task 888) **does** pin a page vocabulary in Rust, and that
is not the paragraph above being quietly broken — the two are different things.
A route is a *string the frontend owns*: it carries ids, it is built by the
router, it changes shape whenever a page gains a tab, and mesa's only interest
in one is that it can be handed back to `window.location.hash`. A context
`kind` is a *word the agent reads*, and the whole value of it is that the same
word means the same page everywhere — an enum is what makes `"files"` something
the agent can say out loud, key a sentence on, and rely on mesa having refused
if the page got it wrong. So the route stays a shape rule and the kind stays a
closed list, and the cost of the list is exactly the one the doc-comment on the
type names: a new page means adding a value, deliberately, in the same commit.
Ten values today — the eight `ProjectTab` values in `frontend/src/lastView.ts`
plus the two global pages that have something in focus (the inbox and the
scripts page).

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

## Seeing the screen (`mesa live look`, task 895)

Everything above tells the agent *where the person is*. None of it tells it
what they can see. The route is which page, the context is what is open on it,
and neither is what actually **rendered** — so every question of the form "does
this look right?", "is the diagram overlapping?", "what does that error say?"
had exactly one answer available: ask the person to describe their own screen,
in a conversation whose whole point is that they are not at the keyboard.
`mesa live look` answers it directly. It photographs the browser window the
conversation is being held in, writes a PNG and prints where it landed:

```json
{"path":"/var/folders/…/mesa-live-12-1755702312.png","window_id":40041,"width":1600,"height":1000}
```

The agent opens that path with its own image tool. Nothing else in mesa reads
it, which is why `LiveShot` is the one type on this surface that is **not**
ts-exported: it has no HTTP route and therefore no TypeScript consumer, and a
generated `.ts` nobody imports is rot `build.sh`'s dirty check would then hold
everyone to.

### Which window is the whole problem

A screenshot tool needs to be told which window to shoot, and the obvious
answer — the one titled `mesa` — is wrong on exactly the machine this feature
is developed on. khora launches **headless** Chromes to drive the web UI, and a
headless Chrome running mesa reports a window titled `mesa` like any other; on
the machine where this was written there was one sitting there while the work
was being done. A title match photographs whichever of them the window server
lists first, which is to say: something the person did not ask to be seen.

So the identity is the **box** — `screenX`, `screenY`, `outerWidth`,
`outerHeight`, rounded to whole pixels — and the page reports its own. That is
the same rectangle the desktop tooling reports as the window's `frame`, in the
same screen coordinates, so the two can simply be compared: page 22,22
1600×1000; loki frame `x:22 y:22 w:1600 h:1000`. Rounding is what makes those
one statement rather than two — the page reports integers and the window server
reports a float `CGRect` — and it is why `windowBox()` rounds on the way out
rather than mesa forgiving a half-pixel on the way in.

Two properties come free with that choice, and both are the reason it is the
right one:

- **Only a browser with mesa open ever reports a box**, so the window is
  never *guessed* at — it is named, by the one page that knows. Nothing else on
  the desktop can be picked: not the person's mail client, not a headless
  Chrome sitting on some other page, not any of the windows a title match would
  have had to choose between. The lookalike problem is not solved by a better
  heuristic; it is solved by asking the browser where it is.

  The honest edge of that: a khora-driven browser that is *itself* showing mesa
  posts a report like any other page, and the last report wins — which is
  already true of `route` and `context` (task 888) and is why the second
  property below matters more than this one. What it cannot do is hand back the
  wrong picture: a headless window has no backing store, so the window server
  refuses to capture it and `look` comes back `unavailable`. The failure mode
  is "no shot", never "someone else's screen".
- **The window mesa photographs is the window that reported the page the agent
  was told about.** The box rides in the *existing* route report as a third
  member beside `route` and `context`, under the one-complete-statement rule
  those two already live by, so all three are written by one poster in one
  request and cannot disagree. And several mesa **tabs** share one window box,
  so two tabs of the same browser are not two answers.

That is also why there is no separate write path for it. A window box is not a
different kind of news from a route; it moves for the same reason a route
does — the person did something — and the page that knows one knows the other.
A `POST /api/live/window` would be a second poster that could be a debounce
interval out of step with the first.

The one thing the box does *not* inherit from the route is its triggers. A
route changes on `hashchange` and a focus changes on the page; a window that
has been **dragged across the desktop** announces itself to nobody, there being
no DOM event for it (a resize at least fires `resize`). So while a session is
live the hub samples the box on its own poll cadence — the same `POLL_MS` the
conversation is fetched on, one number for both rather than two that drift —
and the report's existing dedupe (`sameBox`, the field-by-field twin of
`sameContext`) swallows every tick where nothing moved. A window nobody touches
posts nothing at all for the whole conversation.

### An exact match, or an error

`match_window` filters loki's window list to the ones whose rounded frame
equals all four reported numbers, and then:

- **one** — that is the window; take the shot.
- **none** — `unavailable`. The browser has moved or closed since it last
  reported, so this moment is wrong rather than the conversation being wrong;
  the message says so and says to bring the window back.
- **two or more** — `conflict`, naming every candidate window id.

It is deliberately **not** a nearest match, and the two-candidate case is
deliberately not a coin toss. Guessing wrong here does not produce a slightly
worse answer, it photographs a screen the person did not offer, so "I am not
sure which" has to be an error. Two browser windows genuinely stacked at one
box is also something the person can fix in a second once they are told, which
a silently-picked wrong window never gives them the chance to do.

A session with **no** reported box — one started `--no-agent`, one driven
entirely from the CLI, a page that has not joined — is `unavailable` too, and
it is caught in `cli.rs` before loki is ever run, so the message names the real
situation ("open mesa in a browser and press Listen") rather than letting the
match fail against a box of zeroes.

### loki is optional, and macOS-only

`loki` is the external desktop-automation binary (CLAUDE.md's verification
tools), invoked exactly as every other shell-out in `core` is — as **argv**,
never through a shell — and `MESA_LOKI_BIN` overrides the path, the same test
seam as `MESA_CLAUDE_BIN` and `MESA_KOKORO_BIN`. Nothing on this path is built
out of mesa data anyway: a window id mesa just parsed and a path mesa itself
chose.

It is not a dependency in the sense that `sqlite` is. A machine with no loki
installed holds perfectly ordinary conversations, one command short: a missing
binary, a failing one, and output mesa cannot parse are all **`unavailable`**,
the code reserved for something outside mesa not being arranged for this — and
`AGENT_PROMPT` tells the agent that in as many words, *"if it says it is
unavailable, carry on without it"*. loki drives macOS's own window server, so a
non-Mac is `unavailable` **before** the binary is looked for, with a message
saying loki is a Mac tool: "not installed" would send someone off to install
something that could never have worked. mesa also confirms the file exists
after a successful `screenshot`, because loki can exit 0 having written nothing
(a window that vanished between the two calls) and a path the agent then fails
to open is a worse answer than saying so here.

### There is no HTTP route, and there will not be one

`live look` is **CLI-only**, and that is a security decision rather than an
omission. This captures the person's screen. `serve --lan` offers the API to
every device on the network with **no auth at all** — an opt-in posture that is
defensible for reading tasks and dictating an utterance, and is not defensible
for photographing the owner's desktop. No gate in this codebase is strong
enough to make that route acceptable, so there is no route: the capability is
reachable only by something already running as the person, which is exactly
what the agent driving the conversation is.

The file lands in a temp file named for the conversation and the second —
`mesa-live-<session id>-<unix seconds>.png` in `std::env::temp_dir()` — so two
looks at one conversation do not land on one path and an `ls` reads in order.
`--output <PATH>` puts it wherever the caller wants instead. `live look` takes
no `--quiet`: it prints a four-key bounded object with nothing to drop, so the
flag is an unknown argument, exit 2, exactly as on `turns`.

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
| `live look` | `--output <PATH>` (default: a temp file named for the session) | the `LiveShot`: `path`, `window_id`, `width`, `height` |

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
  `listen` and on `status`, rejected with exit 2 on `turns` and on `look`
  (neither is a record with an unbounded field to drop). A turn drops
  `text` — the one unbounded field, and the one that is *spoken* rather than
  read by the caller — and keeps its role, action and target. A session has
  nothing unbounded to drop (ids, one of two status words, a 200-char route, a
  four-field context whose free-text fields `Store` caps at 200 chars each, a
  four-integer window box, and
  timestamps), so its quiet output equals its full output; the flag is accepted
  across the group for uniformity. The context being *bounded* is what keeps
  that true — it is a report, not a body, and the key-parity test on
  `LiveSession` is what forces the next field to answer the same question.

## API

| Route | Answers | Gate |
| --- | --- | --- |
| `GET /api/live?after=<id>` | one `LiveState` | standard read |
| `POST /api/live` `{project_id?}` | the started session | `require_agent_access` |
| `DELETE /api/live` | the ended session | `require_agent_access` |
| `POST /api/live/utterance` `{text}` | the dictated user turn | standard write |
| `POST /api/live/route` `{route, context?, window?}` | the session, route, context **and window box** recorded | standard write |
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

`POST /api/live/route`'s `context` and `window` are optional and **omitting
either clears the stored one** — the report is a complete statement of where
the person is, not a
patch, because one poster in the page sends every part of it together on every
move.
A page that has opened nothing must be able to say so, and this is how it says
it; the same goes for a caller that is not a browser and has no window to
report, which is exactly the session `mesa live look` refuses to guess at. An
unknown `kind` is a **422 `validation`**, refused by serde before the
handler runs (`JsonRejection` maps to mesa's validation body), which is the
same code an over-long field gets from `Store` — an unknown page is a client
bug either way. The gate is unchanged: an ordinary write.

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
row and no routed page. The *panel* it opens is a right-hand sidebar (task 887,
below), but the component stays in the header — everything that makes it work
is anchored there. `#/live` survives only as a **verb** — the hub
intercepts it, opens the conversation panel and puts the hash back to wherever
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
- **A five-bar indicator sits centered in the header band, in one of five
  states** (`liveIndicator.ts`, tasks 874, 882 and 894) — the only sign of the
  conversation while the panel is closed, so it answers for *both* sides of it
  rather than only for mesa:
  - **mesa speaking** (cyan) — the loudest of the four, and deliberately not
    one wave: each bar runs its own keyframes at its own awkward duration, so
    the five never fall into the shared ripple that reads as a spinner.
  - **paused** (amber, and the only one that does not move) — the person
    stepped out (task 882). Everything else in the band is something
    happening; paused is the absence of all three, so the honest drawing of it
    is bars that sit still, lower and dimmer than listening — the state it is
    most easily confused with.
  - **being heard** (green) — words are arriving, by either route in: an
    interim result from the recognizer, or a draft sitting in the capture box.
    One travelling wave, quieter than mesa's, because it reflects input rather
    than performing.
  - **the agent working** (violet) — she has taken what was said and has not
    gone back to waiting (task 894). Violet because violet is already what this
    app means by *an agent* (the sidebar pane header, task 819), so the colour
    alone separates her doing something from her saying something. One wave,
    low, slow and unglowing: it is the one state neither side is talking in,
    and it can be lit for minutes on a page somebody is reading.
  - **listening** (muted) — the microphone is open and the room is quiet. Shown
    only where recognition really is the way in (`recognizesSpeech`); a browser
    that types into the fallback box gets no resting indicator, since a
    permanent glyph meaning "a text box exists" is noise.

  The order is the decision: **speaking outranks everything** (while she talks
  the microphone is shut, so a band claiming to hear the person would be
  describing a microphone that is not open), **paused outranks both of the
  states under it** (the microphone is shut and the box is disabled, so a
  draft left over from before the pause must not read as the person still
  talking), **being heard outranks working** (words arriving from the person
  are the stronger news, and the agent carries on working either way), and
  **working outranks listening** (listening is the resting state, and work is
  not rest). Whitespace is not speech. All five freeze under
  `prefers-reduced-motion` — the same rule as `.live-dot`'s pulse — to steady
  bars whose heights keep the ranking the motion carried.

  Working is the one state shown to a browser that types into the fallback box
  as well: unlike listening it is not "a text box exists" — someone is doing
  work, which is exactly the thing that surface could not otherwise tell from
  silence. Its input is the session's own `working_since` (below), which
  arrives on the poll the page already makes.
- **The conversation is a right-hand sidebar** (task 887), a sibling of the
  agents one in `.shell-body`'s flex row, so the two are independent: both open
  at once, either alone, or neither — and the page the conversation is *about*
  sits beside it rather than under it, which a popup hanging off the header
  could not do. Only the rendered panel moves; the hub itself stays in the
  header, because everything that makes it work is anchored there (mounted for
  the life of the app, one `<audio>`, a capture box that must never unmount).
  So the panel is **portalled** into a `.live-slot` div App renders just before
  `<AgentSidebar>`, and the slot reaches the hub as a `slot` prop written by a
  ref callback rather than being looked up: App renders it in the same commit
  as the hub, so there is nothing to find until the ref lands. The slot is
  `display: contents`, so an empty one takes no width. On the phone tier the
  panel is a fixed right-edge drawer, mirroring `.agent-sidebar`'s — the same
  rectangle as it, so one of them has to be on top and it is this one
  (`z-index: 1201`, one above the agents drawer): the conversation is holding
  the keyboard and sending what is typed into it, and a drawer doing that
  invisibly underneath another is the one genuinely wrong outcome. Its close
  button rides on top with it, so the agents drawer is one press away.

  Being a sibling on that row is also the **agents panel's** business, since
  the room it may claim is now shared. Its width clamp subtracts
  `liveSidebarWidth()` — the conversation's box, or **0** when that box's
  computed `position` is `fixed`, because the phone-tier drawer takes no room
  on the row at all and the clamp is only-shrink, so a width wrongly given
  away is never given back. The clamp's `ResizeObserver` answers both the open
  and the close with one subscription, and it depends on a `liveSlot` prop App
  passes down rather than a query of the document: the panel is portalled in,
  so it does not exist on the first commit, and an effect that looked for it
  then would silently never observe anything.
- **The panel opens and closes without touching the session.** A speech-bubble
  toggle sits beside the live button whenever there is a session at all —
  running, or ended with a transcript still worth reading
  (`liveControls().panel`) — and the panel holds the status line, the
  transcript, the listen row and the capture box. Closing it calls no route;
  only `End` ends the conversation. The closed state is a **zero-width clip**
  on the aside, never `display: none` or `visibility: hidden` — the same
  decision the popup's `clip-path` was, for the same reason: the capture box
  inside keeps its focus, and the dictation flowing into it, while the panel
  is shut.
- **While joined and unmuted, the browser listens** (`liveRecognition.ts`, the
  tested module for all of this — task 873). Two questions, deliberately not
  one:
  - `recognizesSpeech` — is the microphone the way in *at all*: the session is
    live, *this* browser has had its press (`unlocked` — the gesture that
    unlocks audio is the one that may open a microphone), the browser has a
    recognizer, the microphone was not refused, the person has not
    **paused** (task 882 — a pause does not end on its own, so unlike a reply
    it belongs to this question rather than to the one below), and they have
    not **muted** it (task 887 — likewise something only they undo).
  - `shouldListen` — that, **and mesa is not speaking**. The microphone would
    otherwise hear her own reply out of the speakers and answer it, so speech
    gates the engine's lifecycle from below rather than sitting beside the
    person's own switch above it, and the microphone reopens when she stops.

  Everything *about the person's input method* reads the first — the capture
  box's two rules, the composer's hint — and only the recognizer's own
  lifecycle reads the second. Keying the former on the latter is the bug that
  looks like a shortcut: mesa speaks for most of the conversation's wall time,
  so a focus fight or an auto-send deadline that re-arms itself while she
  talks is decided by playback timing rather than by any rule.
  - **Listening is the person's own switch, and it starts off** (task 887).
    `muted` is an input to `recognizesSpeech` for the same reason `paused` is:
    a muted page is one where the microphone is not the way in, so the capture
    box takes the keyboard back and the hint says to type. It starts muted
    because a page that opens the microphone the moment a conversation starts
    is listening to the room for the whole of it, and asking for that has to be
    the person's own act. It is toggled by **⌘/Ctrl+Shift+L** (`isListenChord`,
    named once as `LISTEN_CHORD` wherever the page writes it) or by the
    `listen`/`listening` button in the panel's listen row — which is offered
    on the same terms as Pause (live, this browser joined, a recognizer, the
    microphone not refused), because a button reading "listening" before the
    conversation has started claims something that is not happening, and a
    browser that cannot open a microphone at all has nothing for the switch to
    do (the hint below says which of the two it is). Like the close button, it
    and the microphone `<select>` beside it carry `tabIndex={open ? undefined
    : -1}`: the shut panel is a zero-width clip, and `pointer-events: none`
    stops the mouse but not a Tab, so an invisible control that toggles the
    microphone on Enter is worse than one nobody can reach. A **chord**, not a
    key, for the reason `keyboardScope.ts` gives: the capture box holds the
    keyboard for most of a conversation, so a single-key shortcut would be
    typed into the box instead of pressed — which is also why it cannot consult
    `shouldIgnoreShortcut` (whose first rule is that a modifier chord belongs
    to its existing owner) and why it is the hub's own window listener, in the
    shape of the command palette's, always `preventDefault`.

    Like pause, it is **browser-side and this browser's alone**: no route, no
    column, no CLI verb, and the agent is never told. Unlike pause, the
    conversation carries on — mesa keeps speaking, `navigate` still moves the
    page, the typed box still works — because muting stops mesa hearing *this
    room*, where pausing stops this page's whole part in the run. Since task
    889 the same press is also what **sends** the recording (below), so it is
    the one control that both ends listening and delivers what was heard.

    **Muting hands the keyboard back**, so both presses go through one
    `toggleListening(next)` in the hub. It writes `listeningRef.current` for
    the page the press *makes* before calling `reclaim('hub-press')` — the
    effect that keeps that ref current only runs a render later, so read from
    the handler it still holds the answer from before the press, and a mute
    would leave the capture box unfocused at the exact moment typing became
    the only way in. Identical, and for the identical reason, to
    `togglePause`. Unmuting calls the same `reclaim`, which declines, as it
    should: a recognized sentence reaches the conversation with the keyboard
    anywhere.
  - **Only a final result is recorded.** An interim result is the engine
    thinking out loud — shown as a preview under the capture box, in italics,
    and never recorded. `readResults` splits one event into the two and answers
    how far the list is now consumed (`settledThrough`); the hub floors the next
    read at that mark rather than trusting the event's `resultIndex`, because
    an engine that reports an index it already settled (Chromium on Android
    has) would otherwise re-record every sentence before it. `utteranceFrom`
    drops a settled result with no words in it (a cough, a door), which the
    engine produces routinely.
  - **Listening is a recording, not a stream of utterances** (task 889). Each
    settled sentence is joined onto a held recording (`heldWith`), shown above
    the capture box, and **nothing is sent** until the person turns listening
    off; that press posts the whole thing as **one** `user` turn (`heldFlush`).
    A conversation is not one sentence at a time: the engine settles wherever
    the speaker drew breath, so posting each final made the agent answer a
    half-thought and then answer the rest of it, and the person had to talk to
    the pauses the engine chose rather than to mesa. The switch they already
    have is the boundary they meant — which is why this needs no control of its
    own, and why the listen button is the whole of the gesture.

    Three consequences follow, and each is a decision:
    - **The flush includes the interim tail.** Everywhere else the preview is
      never a turn; here it is, because the person finished speaking and *then*
      reached for the switch, so the sentence the engine has not settled yet is
      the last thing they said. The engine does deliver it as a final when it
      stops — but on the browser's own schedule, after the switch has flipped
      and the mute rule has already discarded it. The engine's best guess now
      beats the settled version never.
    - **The cap is the server's** (`LIVE_TEXT_MAX`, 8192). A recording that
      would cross it is posted as it stands and the new sentence starts a fresh
      one, so a nine-minute monologue arrives as several turns rather than
      being refused. The split is on a sentence boundary — the engine's, not a
      character count. The flush runs the interim tail through that **same**
      rule (`heldFlush` is `heldWith` plus a trim), so a recording already at
      the cap becomes two ordered turns rather than one the server rejects;
      only a single settled sentence longer than the whole cap is cut, there
      being no boundary inside it to split on.
    - **A pause keeps the recording; ending discards it.** Pausing stops the
      microphone, so nothing is added while it lasts, but nothing is lost
      either and Resume carries on the same recording — there is no send
      involved, so there is nothing to drop. The switch still sends while
      paused: those words were said to this conversation, and the `paused`
      guard belongs to a single cut-off final, not to a recording made before
      the press. Ending the conversation clears it: it was said to a session
      that no longer exists and nothing will ever send it.
    - **A microphone that dies mid-recording still delivers.** A refusal
      (`not-allowed`/`service-not-allowed`) sets `blocked`, which withdraws the
      listen button — so the same handler flushes, or the recording would sit
      on screen with no control left to send it. Another application taking the
      device, or the permission being revoked from the omnibox, is the everyday
      way this happens.
  - **The last sentence before she speaks is not dropped.** Stopping the
    engine *delivers* what was pending as a final, and that sentence was heard
    before the audio started, so it is the person's and it joins the recording.
    Three stops discard it instead, each for the same reason — it is not part
    of any recording that will be sent. The conversation **ending** is one. A
    **pause** is another (task 882) — the pending words are exactly what the
    person was saying as they pressed a button meaning "hear nothing from me".
    A **mute** is the third, and all but never a loss: the press already
    flushed the recording with this very sentence's preview on the end of it,
    so taking the late final too would say it twice. The one gap is a mute
    landing between mesa starting to speak — which clears the preview on its
    way past — and the stop that caused delivering the final; that sentence
    goes, exactly as it did before task 889.
  - **Recognition restarts itself.** Chrome ends it after about a minute and on
    a long enough silence, and reports that as an ordinary end, not an error.
    So `onend` asks `shouldListen` again and opens a new recognizer if the
    answer is still yes — a re-answer, not a retry loop. A recognizer stopped
    by the hub's own cleanup still fires its end; that echo is guarded, or
    ending a conversation would reopen the microphone it just closed.
  - **Which microphone is a browser-local choice, not a recognizer state**
    (`liveDevices.ts`, mesa task 884). It sits in the panel's listen row beside
    the listen button — task 887 moved it out of the header cluster and changed
    nothing else about it, because which microphone and whether to use one at
    all are two settings on the same thing, read at the moment the person is
    deciding whether to talk or to type, and the header is where the press that
    destroys the conversation lives. `SpeechRecognition.start()` grew an
    optional `MediaStreamTrack` argument — passing one is how a specific device
    is chosen, and passing none, which is what mesa always did, is still what
    every browser that has ever supported speech recognition understands. So
    the chooser is offered only where three things are all true: this browser
    accepts the argument (proved, not probed — a `start(track)` that throws
    `TypeError` is a browser answering "no", latched into `routes` and never
    asked again for the life of the page), there is more than one
    microphone to choose from, and mesa can enumerate them. Verified present in
    Chrome 151, absent in Safari and Firefox. Choosing a device opens
    `getUserMedia({audio:{deviceId:{exact:id}}})` and hands the resulting track
    to `start()`; choosing "Default mic" passes nothing and opens no stream of
    mesa's own — the untouched call, byte-for-byte what shipped before this
    task. The stream is held for as long as the microphone is wanted: the
    engine ending itself (the ~60s cap, a long silence) reuses it, and it is
    re-acquired only once its track stops being `live`. It is deliberately
    **not** held across mesa speaking — `shouldListen` goes false for the
    length of every reply, so the device closes and reopens once a turn, which
    is the promise "mesa stops listening while she speaks" made visible. An
    indicator still lit through a reply would say the opposite, and that is
    worth one `getUserMedia` per turn against a permission already granted.
    Both the recognizer and the held stream close in the same cleanup —
    including a stream that arrives *after* the conversation stopped, which
    would otherwise leave a microphone open with nobody on the other end.
    A device that is listed and still refuses to open — another application is
    holding it, the everyday case — is **asked once**: the refusal is latched
    against that device id, so it is not retried at every reply for the rest
    of the conversation, and picking it again in the dropdown is what asks
    again. The device *list* is re-read on mount, on
    `devicechange`, and on every recognizer start, because a browser withholds
    every device **label** until permission is granted and starting a
    recognizer is what grants it — before that, entries read as `Microphone 1`,
    `Microphone 2`. A remembered id that has since vanished (unplugged, or
    storage cleared and ids rotated) falls back to the default rather than to
    silence, and a `getUserMedia` failure — the device just went away, or
    permission was refused — reports itself in the status line and falls back
    the same way — as does a choice whose control has been withdrawn: unplug
    the second microphone and the dropdown goes, and the survivor goes back to
    the untouched call rather than staying routed through a `getUserMedia`
    nobody can now undo. The choice lives in `localStorage` (`mesa.live.input`),
    machine-local like a pane width, and the default is remembered as
    **nothing at all**, not as an empty string, so a fresh browser and an
    explicitly-reset one read the same. None of it moves the audio boundary:
    the chosen track never leaves the page, it is handed straight to the
    browser's own recognizer, and mesa still ships no speech-to-text, still
    sees no audio, and still accepts no audio body.
  - **A refusal is terminal for the page** (`isBlockingError`): `not-allowed`
    and `service-not-allowed` set `blocked`, name themselves in the status
    line, and leave the typed box as the way in. Everything else the engine
    reports — `no-speech`, `aborted`, `network`, `audio-capture` — arrives in
    normal use and is followed by an end that `shouldListen` answers on its own
    merits. Treating those as fatal would silence recognition on the first
    quiet stretch; treating a refusal as transient would reopen the permission
    prompt for ever. A `start()` that throws outright fires neither event, so
    nothing would reopen it: it names itself in the status line instead of
    going quiet, and the next change of the answer (mesa's next reply ending,
    most likely) tries again.
  - **The composer always says which state it is in** (`captureHint`, over
    `recognizesSpeech`), in this order: the person paused it, this browser
    cannot listen, the microphone was refused, the conversation has not
    started, this browser has not joined it (*"Press Listen to join the
    conversation on this browser"* — those two presses have to come first,
    since the switch is not even offered until both are done), the person
    muted it, or it is listening — and the fall-through, joined and unmuted
    and still not the way in, is the box saying it is the way in. There is
    always a line because "is it hearing me" is the only question a hands-free
    surface has to answer without being asked. That she pauses while she speaks is said *in* the
    listening line, rather than by the line flipping to "go live" on every
    reply. The paused line outranks every other and has to: the box is
    disabled while paused, so every other line would be inviting the person to
    type into a field that will not take it. The **muted** line ranks under
    refused and above listening (task 887): a microphone the browser will not
    give mesa is not one the person can un-mute, so saying that first is the
    only line naming something they can act on — and the muted line names both
    ways back, the chord and the button. It ranks **under `live`** and under
    joined too, and has to: the switch starts muted, so without that input the muted line is
    what every cold page says, telling the reader to un-mute a conversation
    that has not started, under a placeholder telling them to go live. The
    offer to start is the older, truer line, and it stays the one a cold page
    shows.
- **While joined *and not listening*, the capture box holds the keyboard**
  (`liveCapture.ts`, the tested module for all of this). With the microphone
  open, none of the rule below applies: the fight was always about *where the
  words land*, and a recognized sentence lands in the conversation with the
  keyboard anywhere. So `shouldReclaimFocus` answers `false` outright while
  `listening`, and the box becomes a plain fallback the person may click into
  and type. The rest holds unchanged wherever recognition is not running.
  The person does not aim their dictation;
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
- **A settled line is sent on mesa's clock** (`shouldAutoSend`) — while the
  browser is not listening for itself, where the microphone's recording is
  what gets sent and a timer firing on top of it would post the same words
  twice, from two surfaces. Otherwise: dictation
  never presses Enter, so a non-blank draft untouched for the auto-send wait
  is sent as the utterance — hands-free end to end. That wait is
  **configurable** (mesa task 886): `live.auto-send-ms` in
  `~/.mesa/config.json`, edited on the **Settings** page in the same *Live
  conversation* section as the agent prompt — 250..=60000 ms, absent/blank
  meaning the 2000 ms mesa ships (`AUTO_SEND_IDLE_MS`), because how long a
  pause means "finished" is the person's own cadence. `LiveHub` reads the
  section once per conversation it joins, so an edit lands on the next
  conversation with no restart, and a read that fails is the built-in wait
  rather than a stall; `autoSendIdleMs` clamps what the file says, since the
  editor is not the only way into it. It governs this box only — with the
  microphone open the recording is what gets sent, on the person's own switch,
  and the timer never fires. Enter still sends at
  once, Shift+Enter still opens a line, and the IME guard holds it while
  composing (an IME commit re-arms the timer, since committing changes no
  draft text). The firing timer reads the draft, the measured idle time and
  the IME state through refs, never its own render's closure — which is what
  makes a deadline racing an explicit Enter post nothing instead of the same
  utterance twice. A line the server **refused** is put back in the box but
  marked, and is not auto-retried until edited — Enter is the deliberate way
  to try the same text again. A failed press (`Go live` on a machine with no
  `claude`, most likely) **opens the panel**, because the error is the status
  line's to report and a failed start leaves no session for the header to
  hint with.
- **The controls are a three-state toggle, not one button.** Nothing live:
  **Go live** (`POST /api/live`). Live in a browser that has had a press:
  **End** (`DELETE /api/live`). Live in a browser that has **not** had one:
  **Listen**, with **End** beside it. A press in flight replaces the label
  (`Going live…`, `Ending…`) and disables it, so a slow spawn cannot be clicked
  twice.
- **Pause is a fourth control, and it is this browser's own** (task 882).
  **Pause** / **Resume** sits beside the toggle whenever the conversation is
  live and *this* browser has joined it — and nowhere else: a browser that
  never pressed is already silent, so there would be nothing for a pause to
  stop, and mid-press there is nothing yet to step out of.

  It **calls no route and touches no session state**. There is no `paused`
  column, no CLI verb and no server change of any kind: the session stays
  `live`, the agent keeps working, `mesa live listen` keeps being answered and
  the turns keep arriving. What stops is *this page's part in the
  conversation* — the run halts **whole**, so nothing is spoken, nothing
  `navigate`s and no sidebar folds, and the microphone is shut
  (`recognizesSpeech`) with the capture box disabled beside it. The transcript
  keeps accumulating and stays readable in the panel, which is the point:
  pausing is how a person reads what was said instead of being talked at.

  Pausing silences the player through the same `silence()` that ending a
  conversation uses, so **the sentence a pause interrupts is not repeated** —
  it is already in the hub's `handled` set, exactly as `End` leaves it, and it
  is still there to *read*. Everything that lands while paused is caught up on
  Resume, in transcript order, navigates included; Resume needs no new gesture,
  since `unlocked` was never given up. A conversation ending clears the pause,
  so the next `Go live` starts talking rather than starting silently with the
  control gone.

  Deliberately a separate control rather than a state of the primary toggle:
  that button answers "is this conversation running", which pause does not
  change, and folding the two together would put "quiet for a minute" and
  "destroy the conversation" one mis-click apart.
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
- **The status line at the top of the panel says what is actually happening**,
  and the last failure outranks everything: a line reading "listening" while
  the last call failed is the one way it can lie. It also calls out a live
  session with **no agent bound**, which would otherwise listen for ever and
  never answer.
- The **capture textarea** carries a visible hint saying which listening
  state it is in, and that this is where the fallback typing (or
  system dictation) goes, wherever the app has navigated. Enter sends, Shift+Enter
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
- **The hub reports where the person is, in three parts.** One `POST` to
  `/api/live/route` carries the **route** (which page), the **context**
  (what is in focus on it) and the **window box** (which desktop window all of
  that is showing in, task 895), so the agent can answer "what am I looking at"
  without guessing — and, since task 888, without asking — and can
  [photograph it](#seeing-the-screen-mesa-live-look-task-895). There are
  **five**
  triggers: on arrival, on every `hashchange`, the moment the session goes live
  (a session that just started has no idea where its person already was), a
  change of focus on the page *already* open (same route, different answer to
  "what is this?") — and, while the session is live, the poll's own 2s tick,
  because a window dragged across the desktop fires no event for anything to
  hear. It stays **ambient**, like the inbox's
  read mark: a failure — no live session, most often — is forgotten rather than
  shown, and the dedupe below means the tick posts nothing at all unless
  something moved.

  Route, context and window box go in **one body because they are one
  statement**, and
  omitting the context is how a page with nothing open says so — a report is
  not a patch. Sending them separately would mean two writes that can disagree
  about which page a focus is on, or a box that names a window some other
  report's page was never in.

  The report is **debounced** (one shared trailing 300 ms timer,
  `REPORT_DEBOUNCE_MS`), which the route alone never needed. Context changes far
  faster than a route does — a selection moving, a file tab flicking past, a
  caret crossing a line — and this is telemetry the agent reads when it is
  *asked* a question, not a command anything is waiting on. A route change rides
  in the same window rather than jumping the queue, for the one-statement reason
  above; a page that lands a fifth of a second late is still recorded long
  before the person has finished saying the sentence that follows it. The timer
  reads the focus **when it fires**, not when it was scheduled — waiting is for
  the settled value, not the one that started the flurry — dedupes against the
  last *successful* report (so a failed one is retried by the next trigger
  rather than treated as already told), and is cancelled on unmount.
- **The pages publish, the hub reports: one poster, one report**
  (`frontend/src/liveContext.ts`). The hub is mounted in `<header>` for the life
  of the app and the pages are deep in the routed tree beneath it, so a page
  cannot report for itself and there is no shared ancestor but `App`. Threading
  a setter down through every page, tab and pane to reach one telemetry field
  would run a wire through the whole tree for a value nothing in the tree reads.
  So the channel is a plain module-level value plus a subscriber list, and the
  hub stays the **only** thing that talks to `/api/live/route` — the same rule
  as everywhere else on this surface: mesa does not open a second write path.
  The page clamps each field to 200 characters rather than letting `Store`
  refuse it, because a deeply nested file path is a perfectly ordinary focus and
  a 422'd report tells the agent *nothing*, where a truncated one still names
  the page and most of the path (`…` marks the cut, as `task_name` does).
- **A publisher stands down only if what is standing is still its own.**
  `useLiveContext`'s cleanup calls `clearIfStanding(published)`, not a blind
  clear, and that guard is what keeps two ordinary races from lying to the
  agent. The cleanup runs on **every** change of the value, not only on
  unmount — so an unconditional clear would publish a transient "nothing
  selected" between every two focuses, and because the hub debounces, a timer
  that happened to fire inside that gap would tell the agent nothing is open at
  the exact moment the person changed what they are looking at. And across a
  route swap React runs the *arriving* page's effect before the *departing*
  page's cleanup, so an unconditional clear is the old page wiping the new
  page's context. A publisher whose value has already been superseded simply
  stops talking; only the one still on the air turns it off.
- **A page that is mounted but not visible must not publish**, and a page that
  delegates must not publish over the child it delegated to. Both are the same
  rule — *the publisher is mounted with the thing on screen* — and both are why
  `LiveFocus` exists: rendering a publisher is a choice a component can make
  conditionally, where calling the hook with `null` is not (hooks are
  unconditional, and a `null` is itself a report). `TerminalPage` is the case
  that proves it: `App` mounts the global one as a **permanent sibling** so
  shells survive navigation, so it is mounted the whole time the person is
  somewhere else — an unconditional publisher there pinned the context to
  `terminal` for the life of the app, and being the later sibling it won every
  time. It takes an `active` prop and mounts its publisher only while it is the
  visible pane. `ProjectTasksPage` is the delegating half: it reports only for
  the Board, the one view it renders itself, and leaves every tab to the
  component that actually knows what is open in it. Effects run child-first, so
  a parent publishing "the tab" would land *on top of* the child publishing the
  file — the shallower answer would win, which is exactly backwards.
- **Pure logic is in tested modules, not the `.tsx`** (CLAUDE.md's
  frontend-test rule): `frontend/src/liveTurns.ts` (cursor advance, merging a
  poll's turns into the transcript, next-unplayed selection, what a turn
  speaks, whether it navigates, whether it moves the sidebars, grouping and
  labelling) and
  `frontend/src/liveSession.ts` (the is-live predicate, `liveControls` — the
  four presses above, since "no session", "an ended session", "a session still
  starting" and "a session running in a browser with no gesture" are four
  different buttons and the label has to be right in each — plus the pause
  control and where it is *not* offered, the panel toggle's `panel` flag,
  and the status line, where paused ranks under the two not-live states and
  above everything the running conversation would otherwise say) and
  `frontend/src/liveCapture.ts` (the focus referee and the auto-send rule, and
  when both stand aside) and
  `frontend/src/liveRecognition.ts` (the two listening questions and why they
  are two — and why a pause and a mute belong to the first and a reply to the
  second —
  which errors end listening, whether a keystroke is the listen chord and how
  the chord is written, a result event's final text, its preview
  and its high-water mark, what a settled result is worth sending, and the
  composer's hint) and
  `frontend/src/liveDevices.ts` (which microphones there are, whether two
  readings of that list say the same thing, what to call one before its label
  is known, which one is actually chosen, and whether the chooser is offered at
  all) and
  `frontend/src/liveWindow.ts` (the browser window's own box: the four
  properties rounded to whole pixels, and whether two readings of them are the
  same window in the same place — the `sameContext` twin, since the hub builds
  a fresh object on every sample and identity would report a move every tick)
  and
  `frontend/src/liveContext.ts` (what a reported field is worth on the wire —
  trimmed, blank folded to absent, cut to 200 with `…` — whether two contexts
  say the same thing, and the page-to-hub channel itself: publish, read what is
  standing, subscribe, and the conditional stand-down that keeps a departing
  page from clearing an arriving one's focus; plus the one React binding,
  `useLiveContext`, which is the whole of what a page has to call), each with a
  sibling vitest file.

## Config

The spawn is the fourth configurable command: **`live-agent`**, defaulting to
`{bin} --bg --agent {agent} --name {name} -- {prompt}` — the union of the two
existing shapes, since a live session is a mesa record (so it has an `{id}` and
a `{name}`) *and* carries a prompt mesa supplies. That prompt is
`live::agent_prompt`, so the feature works with **no user configuration** — and
the prompt itself is the file's fifth section, `live.prompt`, which **replaces**
the built-in block when it is set (an empty one is never stored; blank is the
reset). That section holds one other key, `live.auto-send-ms` — the capture
box's wait above, read by the page rather than by the spawn. Everything else
about the template — argv vs script mode, tokenize-then-substitute, the
`MESA_*` environment handoff, a `{placeholder}` refused inside
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

- **Speech-to-text of mesa's own.** mesa does not ship or shell out to an STT
  engine, no route accepts an audio body, and no audio ever reaches the server:
  recognition is the **browser's**, running in the page, and mesa receives only
  the text it produced (task 873). The recognition quality, the language and
  the privacy question are therefore the browser's — which, for Chrome and
  Safari, means the speech may be sent to *their* service, a thing worth
  knowing and not something mesa can answer for. Where there is no recognizer
  at all, the person's own system dictation types into the text field, exactly
  as it always did. The mesa audio path stays **one-directional, server to
  browser**.
  - A **fully local pipeline** — mic capture and VAD in the page, audio chunks
    to a mesa route, a local whisper — is the follow-up that would take the
    privacy question and the non-Chromium browsers off this list. It is not
    here yet, and it is the only reason a route would ever accept audio.
- **An HTTP route for `mesa live look`** (task 895). Capturing the person's
  screen is a CLI-only capability on purpose: `--lan` serves the API to the
  whole network with no auth, and no gate here makes "photograph the owner's
  desktop" an acceptable thing to answer over a socket. mesa also never
  *stores* a shot, never puts one in a turn, and never shows one in the web UI:
  the PNG is a file on the person's own disk that the agent reads and nothing
  else ever sees.
- **A second live session.** One conversation, one page, one player.
- **A liveness bound on `working_since`.** The stamp is cleared by the next
  waiter, so an agent killed mid-work leaves the band lit until the
  conversation is ended — which is the harmless direction, and the one that
  needs no clock: an agent that dies while *waiting* leaves the span closed,
  and ending the conversation clears it either way. mesa does not poll the
  agent to ask whether it is still alive.
- **A server-side pause.** Pausing is one browser stepping out (task 882), not
  a state of the conversation: there is no `paused` column, no route and no CLI
  verb, and the agent is never told. Two pages on one conversation therefore
  pause independently, which is the honest answer — the person at the paused
  one is not listening, and the other one still is.
- **A server-side mute.** Listening is one browser's own switch (task 887),
  like pause and for the same reason: no column, no route, no CLI verb, and the
  agent is never told. Two pages on one conversation therefore listen
  independently — which is honest, since only one of them is in the room with
  the person talking.
- **A per-session voice.** The voice is `speech.voice` in
  `~/.mesa/config.json`, read on every press, shared with the inbox.
- **A per-session or server-side microphone.** Which device to listen through
  is `liveDevices.ts`'s `localStorage` choice, this browser's own — like
  pause, there is no column, no route and no CLI verb, and the agent is never
  told which microphone was in use. Two pages on one conversation may listen
  through two different microphones, and that is the honest answer: each page
  hears its own room.
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
the `working_since` span it opens and closes (set when the utterance is handed
over, still set after a reply, cleared by the next wait that finds nothing),
the `--quiet` key sets, and the API twin including the audio contract and both
halves of the security boundary in default **and** `--lan` mode.

The route write is checked with its **context** riding in the same body (task
888): both halves recorded, `mesa live status` reading back over its own
`Store` exactly what the page reported over HTTP (the two surfaces share
`core`, so they must not disagree about what the person is looking at),
omitting or nulling the context clearing it, blank fields folding to `null`
rather than `""`, the 200-char field bound inclusive on both sides, an unknown
`kind` as 422 `validation`, a refused report leaving the stored route *and*
context untouched — and every one of the ten `kind` values accepted in a loop,
because a vocabulary the gate does not exercise is a vocabulary that rots.

`mesa live look` has a section of its own (task 895), driven through a **stub**
`MESA_LOKI_BIN` — a gate cannot have a screen, a browser or a window server,
and the half that is mesa's needs none of the three. The stub answers
`-f json windows` from a file the section rewrites per case and writes a PNG at
whatever `--output` names, so what is under test is which window the reported
box picks: the **khora lookalike** (a second window titled `mesa` at a
different size, which the shot must not land on), a box no window is at
(`unavailable`), two windows at one box (`conflict` naming both ids), a session
that has reported no box at all (`unavailable`, and nothing spawned), the
window box round-tripping from the page's HTTP report to `mesa live status`
over its own `Store`, an out-of-range box as 422 writing nothing, the default
temp path and an explicit `--output` both landing a real file on disk, and
`--quiet` refused with exit 2. On a machine that is not a Mac the section
asserts the one thing that is true there instead: `unavailable`, saying loki is
a macOS tool.
