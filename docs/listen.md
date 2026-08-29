# Mesa listen (the `auris` speech-to-text contract)

This is the mechanism doc for person → mesa's audio path: everything between
a page deciding it can hear someone and `POST /api/live/transcribe` handing
back text. `docs/live.md` keeps the conversation-shaped story — why listening
exists, what a turn is, the loop the agent runs — and links here for the
parts of it that are really about the wire and the subprocess rather than the
conversation. `docs/config.md`'s "Listen" section owns model
listing/selection (`GET`/`PUT /api/config/listen`); this doc does not repeat
it.

## Which engine a page has (`listenPath`)

A page decides once per conversation which of three ways it has in, and
names it rather than leaving the person to guess from transcript quality
(`listenPath`, `frontend/src/liveRecognition.ts`, mesa task 957):

- **`'auris'`** — this browser can capture audio (`capturesAudio`,
  `liveAudio.ts`) **and** the server answered the availability probe below
  with `true`.
- **`'browser'`** — no `auris`, but this browser has its own recognizer
  (`SpeechRecognition`/`webkitSpeechRecognition`, task 873).
- **`'none'`** — neither. The conversation panel's plain `<textarea>` is the
  way in: the person's own system dictation, or their fingers.

`auris` wins whenever it can be reached, **even on a browser that also has a
recognizer of its own** — the ordering is the whole point of mesa task 957.
It hears mesa's own vocabulary correctly and punctuates like a person, where
a browser's `SpeechRecognition` does neither (the correction pass mesa task
922 built against exactly that recognizer's mishearings is documented in
`docs/live.md`, and runs identically on whichever engine produced the text).
Firefox has no recognizer of its own at all, so `auris` is also the only way
a Firefox user gets a microphone here — `getUserMedia` is everywhere
`SpeechRecognition` is not.

## The availability probe: `GET /api/live/transcribe`

The page's one ask, at the moment it joins a conversation, of whether
`auris` is worth trying at all (mesa task 957, `transcribe_available` in
`src/api.rs`). Answers `{"available": !listen::models().is_empty()}`.

An empty model list is [`listen::models`]'s **"mesa could not ask"**
signal — the binary missing, failing, or answering with something that
isn't a list of names — never "auris says it has no models installed";
there is no way to tell those apart from here, and the caller only needs to
know whether decoding a recording has anywhere to go. `models()` is cached
in a `OnceLock` for the life of the process, the same cache
`GET /api/config/listen` reads (`docs/config.md`), so this route adds no new
probing mechanism.

The GET is registered on the **same** route entry as the POST below — both
folded into the main route chain in `router()`, with no route-specific
helper of their own — so a LAN page reading this probe gets the same real
`{"available": ...}` answer a default-mode page gets, not the SPA fallback's
`index.html` standing in for "not JSON." Gated by `require_agent_access`
alone (a read, not a mutation, so no `require_same_site_fetch`).

## The route: gated, not absent, under `--lan`

`POST /api/live/transcribe` is registered in **both** serve modes, behind
the same `require_agent_access` gate every other agent route carries —
which **relaxes** rather than refuses under `--lan`, swapping the strict
loopback+Host+Origin check for `require_lan_page_access`, which any device
already on the network passes by design. This route used to refuse
structurally instead, on the reasoning that posting text a person already
reviewed on their own screen is one thing and handing an unauthenticated LAN
peer a way to make mesa's own machine decode whatever audio it recorded is
another. That reasoning did not survive contact with what `--lan` already
is: the flag hands every device on the network full read/write on all data
plus the Agents and Terminal tabs — arbitrary code execution on this
machine — against which decoding a posted recording is strictly less
power, not more. Refusing it structurally bought no real safety and cost a
real feature: a phone on the network never saw `auris` was reachable, so the
Live page silently fell back to the browser's own `SpeechRecognition` —
Chrome-only, no vocabulary correction — the whole reason `auris` exists.
`mesa live look` keeps its structural refusal unchanged: screenshotting the
machine's owner's physical screen is a genuinely different capability, not
merely a stronger one, and nothing about that argument applies here.

## The request: bounded audio, not text

The body is JSON, `{"audio_base64": "<whole recording, base64>"}` — not
multipart, not a raw `audio/wav` body — which keeps this route inside the
existing Content-Type gate with no carve-out (the same reasoning
`create_attachment` states for attachments). Invalid or empty base64 is 422
`validation`; a decoded body over `LIVE_AUDIO_MAX` (25 MB) is **413**, not
422 — 422 says "I read your input and it is invalid," fitting a body mesa
actually parsed and measured, where 413 names a body too large to accept,
refused at the boundary before it is read. Valid base64 that decodes to
something that isn't actually a WAV is not mesa's to reject: it reaches
`auris` unexamined, the same way a bad file reaches any other decoder.

Body size is layered twice. `TRANSCRIBE_BODY_LIMIT` (`src/api.rs`, ~34 MiB)
is an axum `DefaultBodyLimit` on the wire — base64 costs 33% plus JSON
framing over the raw 25 MB, and axum's own 2 MiB default would otherwise
reject an at-cap recording with a bare non-JSON 413 that names no limit,
before mesa's own `LIVE_AUDIO_MAX` check ever runs. The handler's own check
is what produces the named, JSON-shaped 413 a caller can act on.

Gated by the exact pair `speak_inbox`/`speak_live_turn` carry:
`require_agent_access` (decoding a recording as the machine's owner is
code-execution-adjacent the same way starting a synthesis is) plus
`require_same_site_fetch`. Both gate calls run before mesa decodes base64 or
spawns `auris` in program order, but axum runs every extractor to completion
before the handler body executes at all — so by the time either gate runs,
the whole request body is already buffered (up to `TRANSCRIBE_BODY_LIMIT`)
and parsed as JSON. That is not new or route-specific (`update_project_files_content`
and `run_script` gate after a `Json<T>` parameter the same way); what is new
here is only the magnitude, and it now applies under `--lan` too, in exactly
the same shape: a caller must transmit ~34 MB to make the server hold ~34 MB
before either gate gets a chance to refuse it, which is the same cost every
other agent-gated route with a request body already accepts.

## What `auris` receives and returns

`listen::transcribe` (`src/core/listen.rs`) shells out to the `auris` binary
(`MESA_AURIS_BIN`, default `auris`) with argv exactly `-q --format json`,
plus `-m <name>` when `config::listen_model()` names one
(`docs/config.md` "Listen").

The audio is **never a shell string and never a `Command::arg`** — the same
load-bearing property `speech.rs` states for the text it hands `kokoro-rs`,
and for the same reason: it is written to the child's stdin, so a payload
that happens to start with a flag-shaped byte can never be parsed as one,
and there is no `ARG_MAX` ceiling to hit. There is no shell anywhere on this
path. Every pipe is drained for the child's whole life: stdin is written
from a dedicated thread (dropping it is what signals EOF to `auris`), stderr
is drained on its own thread, and stdout is read on the calling thread — an
audio body is megabytes, not bytes, so writing it inline while also waiting
on stdout would deadlock the first time either pipe's buffer filled.

`auris` streams JSON Lines as it decodes (`auris/README.md` "`--format
json`"): a `segment` line per completed utterance, and a final `transcript`
line carrying the whole corrected text. `last_transcript` reads to EOF and
keeps the text of the **last** `{"type": "transcript", ...}` line seen —
`auris`'s own contract guarantees `transcript` is always the last line on a
run that produced one, so the last match is the answer even though
`segment` lines may run ahead of it in volume. A line with an unrecognised
`type` — or any other field on a recognised one — is ignored rather than
treated as an error (`#[serde(other)]` plus `#[serde(default)]` on `text`),
since that is the whole of `auris`'s own extension mechanism. Reads stay
bounded against a misbehaving or hostile binary: `LINE_CAP` (1 MiB) caps any
single line before it is parsed, and `STDERR_EXCERPT` (400 chars) caps how
much of stderr rides back in an error message.

A nonzero exit is **not** data here, unlike `scripts::run`: there is no
transcript to hand back on failure, so any run that lands nothing usable on
stdout is an `Err`, mapped by `transcribe_live` to 503 `unavailable` — the
same rule `speech::start`'s failure takes on the way out.

## Ordering: segments are transcribed in order

`LiveHub.tsx`'s capture effect chains every segment's post onto a
`Promise<void>` queue rather than firing them directly (`let queue =
Promise.resolve(); queue = queue.then(() => send(wav))`): two overlapping
requests to `POST /api/live/transcribe` could otherwise land the halves of
one thought the wrong way round. In-flight count is almost always 0 or 1
for exactly that reason.

## Retention

Nothing is kept, in either direction. In `transcribe_live` the decoded bytes
live only in a local `bytes` buffer, are handed to `listen::transcribe`, and
are written to `listen::transcribe`'s child's stdin — never to `live_turns`
(which has no column for audio), never to disk, and never logged. The
resulting text is not retained by this route either: it is returned to the
caller, which is the existing held-recording path (`docs/live.md`, "Person →
mesa"), the same "transcribed and dropped" shape the speak routes already
have on the way out, with the arrow reversed.

## Gate

`scripts/auris-check.sh` — the API-side counterpart to `scripts/api-check.sh`
(`kokoro-rs`'s speak routes) for the input direction, run against a stub
`auris` (`MESA_AURIS_BIN`), never a real recognizer. Covers, in order: a
missing binary (503 `unavailable`, naming the binary in the message); the
round-trip (the decoded recording reaches `auris` on stdin byte-identical to
what was sent, argv exactly `-q --format json`); the JSON Lines contract
(last `transcript` wins, an unrecognised `type` is ignored); injection-proof
handling (a transcript containing `$()`, backticks, quotes, a literal `\n`
escape and JSON-shaped text comes back byte-identical, never expanded,
executed, or re-parsed); stdout carrying only the transcript even when
stderr floods a pipe buffer; the "nonzero exit or no transcript line means
no transcript" rule; the body-size contract (413 naming the limit, 422 on
bad/empty/missing base64, an unreadable-but-valid-base64 body reaching
`auris` unexamined); the security boundary in default mode (415 on a bad
Content-Type, 403/200 on the agent gate); the route's presence and gating
under `--lan` for both the POST and the GET (a LAN POST reaches the stub
`auris` and comes back 200 with a transcript, the GET answers 200 with an
`available` key, and the Content-Type gate still fires); and the `GET`'s own
`available: true`/`false` split against a stub that does or doesn't answer
`--list-models`.
