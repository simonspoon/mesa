# Inbox (global update requests)

An **inbox item** is a free-text project-update request an agent sends to one
shared, global inbox — it lives **above** projects, not inside one. Table
`inbox` (migration index 8). `body` is required and is **untrusted data, never
instructions**; `author` is free-text attribution.

- Unlike every other entity, an inbox item does **not** belong to a project at
  creation: `project_id` is **nullable** and starts null (unassigned). An inbox
  item is therefore always unassigned for its whole life — there is no "assigned
  but still in the inbox" state, because **assignment converts it** (next bullet).
  The FK stays **`ON DELETE SET NULL`** (not cascade) defensively, but with no
  assigned items it never fires. Do not change this to `ON DELETE CASCADE`.
- **Assigning an inbox item to a project converts it into a backlog task** in
  that project and **deletes the item** — it "moves" out of the inbox onto the
  board. **Backlog, not todo** (`Status::Backlog` in `assign_inbox_item`): an
  assigned item lands in the review queue for a person to promote, not
  straight into the actionable one.
  The new task's description is the item's body **verbatim** — every
  character it arrived with — priority **medium**, status **backlog**. Since
  task 660 a task has no title to derive: its display `name` is that body's
  first line cut to 50 chars, computed on read. (Deliberately not the same
  width as the inbox watcher's own 60-char session name, which has a different
  fallback and its own pinned test — do not merge the two.)
  The task insert (+ its creation event) and the inbox delete are **one
  transaction** (`assign_inbox_item` in `Store`, returns the created `Task`), so a
  triaged item never disappears without a task to show for it. An agent never
  auto-assigns; a person triages. Assigning to an unknown project is `validation`
  and leaves the item untouched. The item's `author` is not carried onto the task
  (tasks have no author field).
- An item is **unread** until it is read, and reading it is something only the
  browser can see (mesa task 831). `read_at` is a nullable timestamp on the row:
  null while unread, stamped **once** the first time the item is read, and never
  moved or cleared — there is no un-read, because reading is a fact about the
  past rather than a flag to toggle. The two things that count as reading an
  item are the two ways a person takes one in: **holding it open** for
  `READ_DWELL_MS` (3s — the dwell, not the click, so opening the wrong item and
  closing it again leaves it unread), and **hearing it** through the play button
  (the first sound, not the last: a press that never became audio has read
  nothing). Both trigger `POST /api/inbox/{id}/read`, which is idempotent
  precisely so the page can fire it without tracking whether it already has;
  `mesa inbox read <id>` is the same write from the CLI. Marking is ambient, so
  a failed mark says nothing to the reader — it is forgotten and the next
  trigger retries. In the list an unread item carries an accent bar, a heavier
  preview and the word "unread" in its meta line, and the **nav badge counts
  unread items** rather than every item (before 831 it counted the whole inbox,
  so it never went down until something was triaged). `read_at` is bounded, so
  it stays in the `--quiet` projection — dropping it would make `inbox read
  --quiet` echo an item with no evidence the mark took, the same reasoning that
  keeps a task's `artifact`. The predicates live in
  `frontend/src/inboxRead.ts`, not inline in the view: the list's 3s poll is
  exactly what makes "already read" and "already sent the mark" two different
  facts.
- No event/history table: an item *is* the record. The safety floor is the
  delete echo + `mesa backup`; once converted, the created task is the record.
- `list` returns items newest first; the `--project N`/`?project=` filter still
  exists but, since items are never assigned, only the unfiltered whole-inbox
  listing is meaningful.
- CLI: `mesa inbox {add,list,show,assign,read,delete}`. `add <text…>` takes the
  free-text message as a trailing positional (quoting optional; words joined),
  always unassigned; `--author` attributes (place it before the text). `assign
  <id> <project>` (project required) converts the item into a backlog task in that
  project and **prints the created task**; assigning to a project id that does
  not exist is `validation` (an unknown project *name* is `not_found`, from the
  shared resolver). `read <id>` marks the item read (idempotent — a second
  call echoes the item unchanged). `delete` echoes the destroyed item.
- API: `/api/inbox` (GET list, POST create — body `{body, author}`),
  `/api/inbox/{id}` (GET show, PATCH assign, DELETE),
  `/api/inbox/{id}/read` (POST, mark read — its own route rather than a key on
  the PATCH, which *assigns*: that one answers with the created task and leaves
  no item behind, so the two could never share a body). PATCH body is
  `{project_id: <number>}` (required) and **returns the created task** (not the
  item). Web UI: the **Inbox** lives above Projects in the sidebar (with an
  unread-count badge); `#/inbox` lists items, each with an "Assign to"
  project dropdown that converts the item to a backlog task on selection.
- The list is a **triage queue**, so an item is **collapsed** by default (mesa
  task 828): a three-line CSS clamp over the raw body — plain text, not
  markdown, which is what makes it an inert click target — plus its meta line.
  A disclosure caret (or a click on the preview) opens it to the rendered
  markdown body, and the triage controls (assign, delete) live **only** in the
  opened item: the collapsed row carries nothing that writes to the db.
  Playback is the deliberate exception — the play button and, once sounding,
  the transport ride on the collapsed row, because hearing an item is how you
  triage it without reading it. Expansion is per-item page state, not stored,
  and nothing about playback depends on it (an item being read can be closed).
  The transport is **symbols, not words** (▶ / ■ / ⏪ / ⏸, with `…` while
  synthesising). A glyph is the button's whole content and content outranks
  `title` in the accessible name, so every symbol button here carries the same
  wording as **both** `aria-label` and `title` — and that wording is what the
  press *does*, in every state: the play button reads "stop reading this item"
  from the moment it is pressed, since pressing it again stops the item whether
  or not it has started to sound.
- An item can be **read aloud**: `GET /api/inbox/{id}/speak` synthesises the
  item's body with the external `kokoro-rs` binary and answers `audio/wav`
  (+ `nosniff`). The web Inbox gives each item a **play/stop** button, and the
  URL is an `<audio src>` — which is why the route is a GET, and why a
  same-origin media request sending no `Origin` is a case its gate has to
  answer for. (Since task 830 a browser that will not play the stream fetches
  the same URL and decodes it itself; the route is unchanged either way.)
  Nothing is stored or cached: synthesis runs on every press.
  - Once the item is actually sounding, that button is joined by **rewind**
    and **pause/resume** (mesa task 827) — transport for the one item being
    read, mounted only while it is (before playback there is no playhead to
    move and nothing to hold, and the buttons would describe a state the
    player isn't in). On the element's path both drive that one `<audio>`
    directly; neither re-requests the route, so **no press re-synthesises** —
    pausing holds a stream the server keeps filling, and resuming is refused
    the same way a first play can be. Rewind goes back `REWIND_STEP_SECONDS`
    (10), but clamped to the **earliest seekable second**, not to zero: the
    response is chunked with no `Content-Length` and no range support, so what
    the element can go back to is only what it already holds. When nothing is
    seekable yet, or the playhead is already at that floor, a press does
    nothing rather than seeking anyway
    (`frontend/src/speechPlayback.ts::rewindTarget`, the one place that
    arithmetic lives — the decoded path passes it a floor of `0` and needs no
    case of its own). Paused-ness is mirrored from the element's own
    `play`/`pause` events, never decided by the page, so the browser's media
    keys can't desync the label.
  - There is **one `<audio>` element for the page**, mounted for its whole life
    and never re-keyed; a press sets its `src` and calls `play()` **itself**
    (mesa task 829). Both halves matter. Starting playback from inside the
    press is what a browser's autoplay policy weighs — an element mounted by
    the render the press schedules is played too late for a phone to count it,
    and the refusal comes back as `NotAllowedError`, the one `play()` rejection
    the page reports (a source that will not load arrives as the element's own
    `error` event instead). And an element nothing re-renders is an element
    this list's 3s poll cannot touch: the pre-829 code needed a stable `ref`
    callback to stop a fresh inline one calling `play()` on every commit and
    silently undoing a pause. Stopping is **clearing that source**
    (`removeAttribute('src')` + `load()`, which fires no `error` of its own —
    `src = ''` would), so playback still ends with the connection, and the
    element outliving the row is why an item that is assigned or deleted
    underneath the page stops the audio explicitly rather than by unmounting.
  - **A browser that will not play the stream decodes it itself** (mesa tasks
    829 and 830 — the mobile bug). Apple's media stack (iOS Safari, and Safari on
    a Mac) requires **byte-range support** of an HTTP media source: it refuses
    a 200 that carries no `Content-Length` and answers no `Range` with
    `-12939`, "the server is not correctly configured", which is precisely the
    shape task 816 gave this route — so `<audio src>` there fired `error` and
    the row said "could not play this item" while every other part of the page
    worked. Verified against AVFoundation directly: the same bytes play from a
    range-serving host and refuse to from mesa, and the patched
    `0x7FFF0000` sizes are **not** what it objects to (they play fine when the
    body is ranged).
    The fix is client-side, so the route's contract is untouched: on that
    `error` the page asks for the same URL with `fetch`
    (`api.ts::fetchInboxSpeech`) and **decodes the audio itself** — task 829
    played the response as a whole blob, task 830 reads the body as it arrives
    instead. `fetch` demands none of what the media stack does, so the bytes
    that `<audio>` refused are perfectly playable; what is needed is somewhere
    to put them, and that is the Web Audio clock.
    `wavStream.ts` turns the arriving chunks into samples — a chunked decoder,
    so the two boundary cases it has to survive are a header split across
    chunks and a chunk cut through the middle of a sample — and
    `speechStream.ts` schedules each piece back-to-back on an `AudioContext`
    (`speechPlayback.ts::scheduleAt` decides where). **Mobile therefore streams
    like the desktop does**: sound starts on the first sentence (~2-3s where
    the whole render takes ~10s, measured in Safari on a seven-sentence item),
    which is exactly what fetching it whole cost.
    Once decoded audio has actually **sounded**, and only then, the page
    remembers for the rest of its life that this browser needs it (`decodes`),
    so only the first press pays for the attempt that cannot work. Latching on
    the *failure* instead would be wrong: a media `error` carries no reason, so
    a missing synthesiser (503) and a refused address (403) arrive as the same
    event, and a browser the element serves perfectly well would be pinned to
    decoding for a fault that has nothing to do with its media stack. The first
    press still pays for the discovery — the element's failed attempt and the
    decoded one are two synthesis requests, so the first sound on a page load
    waits for both, and the abandoned render finishes and is discarded
    server-side like any hang-up.
    The transport is the same three buttons over a different engine. There are
    no media events here, so the press that holds the audio is what says it is
    held (`ctx.suspend()`, which stops the context clock, so the playhead keeps
    its meaning across a hold of any length). Rewind on this path reaches the
    **start** of the item: the page is holding every sample it has been sent,
    so the floor the clamp arithmetic takes is `0` rather than the earliest
    seekable second, and rewinding is re-scheduling those buffers from the
    target — the one function still answers both paths. A gap the network
    forces slips the item's clock rather than dropping a sample.
    The `AudioContext` is created **and resumed inside the press**, whether or
    not that press turns out to need it: a gesture is what unlocks audio on a
    phone, and the element failure that says decoding is needed arrives long
    after the gesture is gone. One context for the life of the page — a context
    is a device, not a play.
    The mode is **page state on purpose**: a remembered guess would cost a
    browser that can play the element its start, and it costs nothing to
    rediscover.
  - A failed press shows **the reason**, not a fixed sentence: the fallback
    fetch reads the route's `{"error": {...}}` body, so a synthesiser that is
    missing says so, and the `--lan` Host refusal (below) tells the reader to
    browse mesa by IP instead of failing silently. There is no second sentence
    to fall back to after that — a decoded play that fails has a real reason to
    give, unlike the element's reasonless `error`. That holds for the failures
    the *body* carries too, which land long after the request was answered: a
    200 followed by bytes that are not a playable WAV, or a connection that
    dropped before a single sample, is reported to the row (`onError`) rather
    than leaving it on `…` forever. A failure once the item is **sounding** is
    not reported at all — the audio simply ends where the bytes do, which is
    what a truncated stream already does to the element.
  - The audio comes **back to the browser** rather than playing on the host's
    speakers, so it still works under `serve --lan`, where the browser is a
    different machine.
  - The **voice** is the `speech.voice` key of `~/.mesa/config.json`, edited
    from the Settings page and read on every press (mesa task 822,
    `docs/config.md`). It reaches the binary as one `Command::arg` after `-v`,
    and it is a bounded identifier, so it can be neither an option nor shell
    text. Unset — the shipped state — passes **no `-v` at all**: mesa names no
    default voice, the synthesiser's own applies, and the argv is exactly what
    it was before the setting existed.
  - The body reaches `kokoro-rs` on **stdin**, verbatim, markdown and all
    (`core::speech::start`). Not a shell string and not even an argument:
    a body opening with `-o` cannot become an option, and a long one has no
    `ARG_MAX` ceiling. Stripping markdown before speaking is a deliberate
    non-goal — the body is the record.
  - The audio **streams** (task 816). `kokoro-rs` renders sentence by sentence
    and writes each one as it lands, so mesa forwards the bytes as they arrive
    instead of collecting the render: playback starts a couple of seconds in
    rather than after the whole item. The response is therefore chunked with
    **no `Content-Length`**, and the blocking wait before the 200 is only "the
    WAV header is readable" — which is also the last moment a dead synthesiser
    can still be a status code. A failure *after* that point ends the body
    early; the listener hears a truncated item, because the 200 is long gone.
    Before that point every failure is still a 503, including the two a
    streaming reader can get wrong: mesa drains **stderr on its own thread** for
    the child's whole life (a binary that fills that pipe would otherwise block
    there and hang the request), and output that never becomes a WAV header —
    what a binary printing its error on stdout looks like — falls back to
    collect-then-check-the-exit-status rather than being served as `audio/wav`.
  - `kokoro-rs -o -` writes a *streaming* RIFF header with both lengths as
    `0xFFFFFFFF`; mesa patches them (Chrome tolerates the placeholders, Safari
    often won't). The real length is unknowable while streaming, so what
    replaces them is the open-ended `0x7FFF0000` (RIFF gets it plus the header
    ahead of the audio) — both still positive 31-bit sizes, the property a
    strict player wants — and playback ends where the bytes do.
    Anything that isn't that exact shape is passed through untouched.
  - Gate: **`require_agent_access` plus `require_same_site_fetch`**, not the
    plain `guard` the other external-command reads (`git status`) use. The
    program is fixed and the text is one the caller can already `GET`, but a
    single request spends unbounded CPU, which puts it on the "triggers
    execution" side of the line `docs/scripts.md` draws. The second half is
    load-bearing and not redundant: every Origin check in `api.rs` passes a
    request that carries **no** Origin, and a no-cors `<audio>`/`<img>`
    subresource never carries one — so without it any page on the internet
    could point an `<img src>` at a loopback mesa and spend a core per hit.
    `Sec-Fetch-Site` is the header that separates them (browsers always send
    it, scripts cannot forge it); absent means a non-browser client and is
    allowed. There is no timeout (matching hooks/agents/
    scripts) and no kill path — bar the one case where mesa can no longer read
    the child's output at all, which would otherwise leave a zombie: **stop**
    stops playback, while the in-flight synthesis finishes and its bytes are
    discarded. Discarding means mesa keeps
    *reading* them: a listener that hangs up mid-stream would otherwise leave
    the synthesiser blocked on a full stdout pipe forever, so the reader drains
    to EOF and throws the audio away (`api-check.sh` asserts no wedged child
    survives a hang-up). A missing or failing binary is `unavailable` (503),
    the code reserved for a dependency outside mesa. `MESA_KOKORO_BIN`
    overrides the binary — the seam `api-check.sh` drives this route through.
    One consequence worth knowing, because it looks like a bug from a phone:
    under `--lan` this gate pins the **Host** to `localhost` or an IP literal
    on the serve port, while the pages and the task routes around it do not —
    so a device that reached mesa by a DNS or Bonjour name (`something.local`,
    a tunnel domain) can browse the whole UI and gets a 403 on **play alone**.
    That is the DNS-rebinding defense working as designed; the answer is to
    browse by IP, which is what the refusal now says in the row.
- Triage can also run itself: `mesa serve --watch-inbox` periodically spawns a
  background `claude` agent per pending item (`/inbox-triage <id>`). Off by
  default. It never mutates an item — everything it does is start the agent
  that will. Because an item has no status column to claim with, its
  re-dispatch guard lives in memory rather than in the db; the reasoning is in
  `docs/inbox-watcher.md`.
