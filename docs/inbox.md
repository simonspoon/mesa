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
- No event/history table: an item *is* the record. The safety floor is the
  delete echo + `mesa backup`; once converted, the created task is the record.
- `list` returns items newest first; the `--project N`/`?project=` filter still
  exists but, since items are never assigned, only the unfiltered whole-inbox
  listing is meaningful.
- CLI: `mesa inbox {add,list,show,assign,delete}`. `add <text…>` takes the
  free-text message as a trailing positional (quoting optional; words joined),
  always unassigned; `--author` attributes (place it before the text). `assign
  <id> <project>` (project required) converts the item into a backlog task in that
  project and **prints the created task**; assigning to a project id that does
  not exist is `validation` (an unknown project *name* is `not_found`, from the
  shared resolver). `delete` echoes the destroyed item.
- API: `/api/inbox` (GET list, POST create — body `{body, author}`),
  `/api/inbox/{id}` (GET show, PATCH assign, DELETE). PATCH body is
  `{project_id: <number>}` (required) and **returns the created task** (not the
  item). Web UI: the **Inbox** lives above Projects in the sidebar (with an
  unassigned-count badge); `#/inbox` lists items, each with an "Assign to"
  project dropdown that converts the item to a backlog task on selection.
- An item can be **read aloud**: `GET /api/inbox/{id}/speak` synthesises the
  item's body with the external `kokoro-rs` binary and answers `audio/wav`
  (+ `nosniff`). The web Inbox gives each item a **play/stop** button that is
  nothing but an `<audio src>` on that URL — which is why the route is a GET
  (a same-origin media request sends no `Origin`, and no fetch/blob plumbing
  is needed). Nothing is stored or cached: synthesis runs on every press.
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
- Triage can also run itself: `mesa serve --watch-inbox` periodically spawns a
  background `claude` agent per pending item (`/inbox-triage <id>`). Off by
  default. It never mutates an item — everything it does is start the agent
  that will. Because an item has no status column to claim with, its
  re-dispatch guard lives in memory rather than in the db; the reasoning is in
  `docs/inbox-watcher.md`.
