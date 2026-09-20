# Scripts (user-authored shell, run from a generated form)

A **script** is a piece of shell the user writes and keeps in mesa, together
with an explicitly declared list of arguments. Table `scripts` (migration index
32): `project_id`, `name`, `description`, `body`, `args`, timestamps. The FK is
**`ON DELETE SET NULL`** (as the inbox's is, deliberately not cascade): a
project binding is where a script *runs*, not what a script *is*, so deleting a
project must un-bind the user's scripts rather than destroy work they authored
by hand and cannot get back. `args` is stored as a JSON array and decoded inside
`Store` — the column is an implementation detail, the `Script` struct exposes a
typed `Vec<ScriptArg>`. **Whether a run is persisted is a fact about the
route, not about scripts.** The two original run routes persist nothing — a
`ScriptRun` is a request/response record, the `HookRun` twin, and a streamed
run's `ScriptRunEvent`s exist only on the wire — while a **detached** run
(mesa task 1196's successor, mesa task 1224, below) is a row in `script_runs`
that outlives the connection that started it. Three shapes, one executor.

- **Arguments are declared, never parsed out of the body.** Nothing reads the
  shell source looking for `$1` or `${FOO}` — that is a guessing game, and a
  wrong guess makes the generated form silently wrong. The declared list is the
  single source of truth: it is what the web form renders, what a run validates
  against, and the order values reach the body in. Exactly four kinds —
  `text | number | bool | choice` — because each is one control in the form and
  one validation rule on the run path; a fifth kind is a change to both
  surfaces, never a free addition to the enum.
- **An argument name is constrained because it becomes an environment-variable
  suffix**: `^[A-Za-z_][A-Za-z0-9_-]*$`, ≤64 chars, unique within the script
  case-insensitively (upper-casing and `-`→`_` make `a-b` and `A_B` the same
  variable, so both cannot coexist). `choice` requires a non-empty `choices`
  list and every other kind must leave it unset. A `bool` value is by
  convention the literal string `"true"`/`"false"` — every value crossing into
  the shell is a string, so `number`/`bool` describe the control and the check,
  never a parsed Rust type.
- **`name` is required, non-empty and unique** (case-insensitively): it is a
  CLI selector, so two scripts differing only in case would be unresolvable —
  a duplicate is `conflict`. `body` is required and non-empty, and is stored
  **verbatim** (leading indentation and trailing newline included); trimming is
  only how emptiness is judged, never what gets saved. An unknown `project_id`
  is `validation`, not `not_found` — it arrives as a field of the record being
  written, mirroring `assign_inbox_item`.
- `Store` (`create/get/find_by_name/list/update/delete_script`) is the only
  write path; `update_script` re-enforces every rule `create_script` does,
  because an update is the other way a bad record could get in. `list_scripts`
  orders by name (`COLLATE NOCASE`, `id` breaking ties) so the CLI, the API and
  the page can never disagree. `delete_script` returns the destroyed record —
  the recoverable echo that stands in for the confirmation prompt mesa
  deliberately does not have. There is no history table.
- **Execution lives in `src/core/scripts.rs`, not in `Store`** — running a
  process is not storage. Two functions: `validate_values` (pure; the CLI and
  the API both call it, so they cannot diverge on what a valid call is) and
  the executor, in two shapes over **one** private `command()` builder — the
  body, the positional and `MESA_ARG_*` values, the env sweep and the cwd are
  built in exactly one place: `run` (capture-and-return, the `hooks.rs`
  executor shape, used by the CLI and `POST …/run`) and `start` +
  `Streaming::stream` (line by line, used by `POST …/run/stream`, below).
- **No value is ever interpolated into a string a shell parses.** This is the
  repo-wide rule (CLAUDE.md, "Untrusted input") and the reason the module
  exists. The body goes to `bash -c` as **one verbatim argument**; the values
  reach it two ways bash *sets* rather than parses — positionally in declared
  order (`bash -c <body> <name> <v1> <v2> …`, so the body reads `"$1"`, `"$2"`,
  …, and `$0` is the script's name) and as `MESA_ARG_<NAME>` in the environment
  (upper-cased, `-`→`_`). A value of `; rm -rf / #` is therefore a string the
  script may read and never syntax. Nothing here may become string
  concatenation.
- **"Not supplied" must be genuinely unset, not empty.** `run` `env_remove`s
  every variable the script's arg list could ever produce, *then* sets only the
  ones this call resolved — copied from `agents.rs::spawn_script`. That sweep is
  what lets a body under `set -u` fail loudly instead of reading a stale value
  inherited from mesa's own environment, and what makes
  `${MESA_ARG_X-UNSET}` a meaningful test. (Positions cannot express absence
  without shifting every later `$n`, so an unsupplied argument still occupies
  its position as an empty string; the environment is where absence lives.)
- **A nonzero exit is data, not a failure** — the hooks posture exactly. All
  three stdio are piped and stdin is closed from a **separate thread** while
  `wait_with_output` drains stdout/stderr, so a script that fills its output
  pipe cannot deadlock the writer. Each stream is capped at 64 KiB, cut on a
  char boundary with a trailing `[truncated]` marker and a `truncated` flag.
  There is deliberately **no timeout** (matching hooks and agents): a run that
  should outlive the request must background itself. The only `Err` is "bash
  could not be spawned".
- **The streamed run** (mesa task 1196) is what the web page uses. `start`
  validates and spawns before any byte is sent — so a bad value or an
  unusable cwd is still 422 and a bash that will not start still 502 — in a
  **process group of its own**. `Streaming::stream` then reads each pipe on its
  own thread into one channel, so the events come out in **arrival order**:
  `{"type":"line","stream":"stdout"|"stderr","t":<ms since start>,"text":…}`
  per line (newline, and a `\r` before it, stripped; lossy UTF-8), then
  exactly one `{"type":"exit","code","duration_ms","truncated"}` — or one
  `{"type":"error","message"}` if the exit status cannot be collected after
  the response has started. The order is what the two pipes delivered, which
  is only as fine as the script's own buffering (a program that block-buffers
  a pipe arrives in blocks). The **same 64 KiB cap** applies per stream,
  counted in bytes read: past it, that stream's further output is read and
  **dropped** (never blocking the script on a full pipe), a line the cap cuts
  is emitted up to the cap, and the exit event says `truncated: true`; there is
  no `[truncated]` marker line. **This route stores nothing** — the full log is
  not kept anywhere, deliberately, so a stream has exactly the captured run's
  bounds. (A *detached* run is where a log is kept; that is a different route
  with different ownership, below, and this one is unchanged by it.)
  **Stop is the client going away**: the loop kills the process group
  (`kill -KILL -- -<pgid>`, then reaps bash) as soon as the channel to the
  response body is closed, which it asks on every line *and* at least every
  100ms while the script is silent. A descendant that left the group
  (`setsid`) is out of reach, as it would be for a terminal's Ctrl-C.
- **A detached run is owned by the server, not by a connection** (mesa task
  1224). `POST /api/scripts/{id}/run/detach` runs the *same* executor —
  `scripts::start` + `Streaming::stream`, unchanged; the new capability is a
  second caller, not a second executor — but hands the two closures differently:
  `emit` returns `true` unconditionally (no reader owns the run, so a reader
  going away means nothing) and `cancelled` reads a stop flag instead of the
  response channel. **That is the whole inversion.** On `/run/stream` hanging
  up *is* the stop; here `POST /api/script-runs/{id}/stop` is the only stop, and
  a run survives the tab, the navigation and the reload that started it.
  - The row is `script_runs` (migration index 64): the `values` the run was
    given, the server-resolved `cwd`, `status`
    (`running | finished | stopped | failed`), `exit_code`, a `note` saying why
    there is no exit code, `truncated`, the `owner_pid` of the `serve` that
    owns it, and `events` — the run's log as the **byte-identical NDJSON that
    went over the wire**, so replaying a finished run is "send this column",
    never a reconstruction. Two columns of `stdout`/`stderr` could not preserve
    arrival order or per-line `t`, and a reopened run would show a different
    screen from the one that was launched. The 64 KiB-per-stream cap already
    bounds it; nothing new enforces anything. The FK **cascades**, unlike
    `scripts.project_id`'s `SET NULL`: a run is a record *of* a script and is
    meaningless without it. `SCRIPT_RUN_KEEP = 20` newest per script, pruned in
    `create_script_run`'s own transaction (the `live_boards` rule).
  - `ScriptRunRecord` deliberately carries **no `events` field**. The log stays
    a wire-only concept reached only through the stream route, which is what
    lets `list` and `show` return one type: twenty runs × 64 KiB in a list
    would be unusable, and a "summary" projection is the hand-written second
    projection this repo does not write.
  - The registry is `src/core/script_runs.rs` — not inside `scripts.rs`, whose
    boundary is that execution is not storage, and the pump performs the two db
    writes. It holds, per run, the replay buffer, the attached senders and the
    stop flag, in `AppState` beside the other in-memory process bookkeeping.
    **`finish_script_run` is written before the entry is removed**, so an
    attach can never see "no entry *and* a row still saying `running`" — the
    one state that would hang a page on a run that had already ended — and
    `finish_script_run` is a no-op on a row that is not `running`, so a stop
    landing at the same instant as a natural exit cannot double-write.
  - **Attaching is snapshot-then-subscribe under one acquisition of the
    entry's locks**, so nothing is missed at the seam and nothing arrives
    twice; a run with no entry replays its stored NDJSON instead and, if that
    log never got a terminal event of its own, one synthesized from the row.
    **One client code path serves a live run and a long-finished one.**
  - The registry is memory-only, so no `running` row can belong to a freshly
    started process: `serve` calls `reconcile_script_runs` **before binding**
    and flips a `running` row to `failed` with a note naming the restart —
    but only when its `owner_pid` is dead or is our own (pid reuse, and we own
    nothing yet), because two `serve`s on one db is a real configuration and a
    blanket flip would have one declare the other's live runs dead. The honest
    limit, which the note states: the script is in its own process group and
    survives the server, mesa holds no handle across the restart and does not
    pretend to. `failed` is true; `running` would not be.
  - Five routes, all on `require_agent_access` like the rest of this surface:
    `POST /api/scripts/{id}/run/detach` (201, the record, same 404/422/502
    pre-flight as the other two and **writing no row** when it fails, since the
    spawn happens before the row does), `GET /api/script-runs?script=&limit=`
    (bare array, newest first), `GET /api/script-runs/{id}`,
    `GET /api/script-runs/{id}/stream` (chunked `application/x-ndjson`;
    **dropping it does not stop the run**) and
    `POST /api/script-runs/{id}/stop` (200, idempotent — stopping a finished
    run is a no-op returning the record, the `read_at` posture; only an unknown
    run is 404). A top-level `/api/script-runs` collection rather than
    `/api/scripts/runs`, which would silently reserve the script id `runs`.
  - **No CLI surface, deliberately.** `--detach` is incoherent from the CLI —
    a detached run is owned by a `serve` process, and `mesa script run` opens
    its own `Store` and exits, so a row with nobody's `owner_pid` on it is
    exactly the state lie the reconciliation exists to prevent — and a stop
    cannot be delivered, the flag living in the owning server's registry, with
    no second write path (the `mesa live` rule). An agent already has the right
    shape in `mesa script run`: capture and return.
- **The working directory is resolved from the script's own project binding,
  never from the caller.** A bound script runs in that project's `local_path`,
  via the standard ladder the terminal and agents use: no `local_path`, or a
  path that is not a directory on this machine, is `validation` (422). An
  unbound script runs in `~/.mesa/workspace` (`config::workspace_dir()`,
  created on demand — Claude Code never persists folder trust for the home
  directory, so mesa owns one folder instead).
- CLI: `mesa script {create,list,show,get,update,delete,run}`. A script
  argument takes an **id or a name** everywhere, and every project argument
  resolves by id or name as usual. `create <NAME> <BODY>` takes both
  positionally or as `--name`/`--body`, with `--body-file <PATH>` (`-` = stdin)
  as the third way so a multi-line script can arrive from a heredoc; `--arg
  NAME:KIND[:required|:optional][=DEFAULT]` declares arguments and `--arg-json`
  declares them in full (the only way to give a `choice` its choices) — the two
  forms conflict. `update` requires at least one field flag (`ArgGroup`, so no
  flags is `usage`, exit 2); `--description ""` clears, `--project ""` un-binds,
  and `--name`/`--body` are replace-only, so an empty value there is
  `validation`, not an erasure. `--arg`/`--arg-json` **replace** the whole
  declared list — neither flag given means "leave it alone", so `--arg-json '[]'`
  is how an update says *no arguments at all*.
  `run <SCRIPT> [--set NAME=VALUE]…` prints the `ScriptRun` and
  **exits 0 even when the script exits nonzero** — the exit code is in the
  payload, exactly like `task execute`; exit 1 is reserved for mesa-side
  failure (unknown script, invalid values, an unusable working directory, bash
  not starting).
- `--quiet` is accepted on `create`/`update`/`delete`/`show`/`get` and drops
  exactly `body` and `description` (`QUIET_DROP_SCRIPT`, fed through the shared
  key-removal `quiet()` helper — never a hand-written second projection). It is
  rejected as an unknown argument on `list` and `run`, exit 2. On `update` it
  sits **outside** the field `ArgGroup`, so `--quiet` alone is still the "no
  field given" usage error rather than a legal call that does nothing.
- API — all seven routes under the global `guard` middleware (Host allowlist +
  Content-Type), no carve-outs:

  | Route | Success | Gate |
  | --- | --- | --- |
  | `GET /api/scripts` (`?project=<id>`) | 200, bare array | `require_agent_access` |
  | `POST /api/scripts` | **201** | `require_agent_access` |
  | `GET /api/scripts/{id}` | 200 | `require_agent_access` |
  | `PATCH /api/scripts/{id}` | 200 | `require_agent_access` |
  | `DELETE /api/scripts/{id}` | 200, destroyed record | `require_agent_access` |
  | `POST /api/scripts/{id}/run` (`{"values": {…}}`) | 200 | `require_agent_access` |
  | `POST /api/scripts/{id}/run/stream` (same body) | 200, chunked `application/x-ndjson` | `require_agent_access` |

  **All seven routes share one gate** (mesa task 1022, the reversal tasks 1004
  and 1021 already made for the library and Settings). Authoring a script is
  *choosing a program mesa will execute* and running one is *triggering*
  execution of something already stored — both are the agents' capability
  class, so both take `require_agent_access`. In **default** mode that is
  strictly stronger than the loopback-only check the three mutations used to
  carry: loopback peer **plus** local Host **plus** local Origin, the
  per-route `require_local_origin` being new. Under **`--lan`** it *relaxes
  rather than refuses* — a page this server handed a phone may author a
  script, while both confused-deputy defenses stay shut
  (`require_lan_agent_host` for DNS rebinding, `require_origin_matches_host`
  for a cross-site fetch). `--lan` is already the opt-in "trust every device
  on this network" posture that hands that network a terminal and the ability
  to run any stored script, so refusing it the editor while granting it the
  shell was a distinction with no security content. A same-machine `curl`
  cannot prove the peer-address half of that (its peer is always loopback,
  which makes the relaxed and strict gates identical under `--lan`), so it is
  a Rust test with a forged non-loopback `SocketAddr`
  (`lan_page_may_author_a_script_but_not_from_a_rebound_page`).
  A malformed body is 422 (every handler takes `Result<Json<T>, JsonRejection>`,
  never bare `Json`); values that fail `validate_values` are 422 `validation`;
  a bash that will not start is 502 `unavailable` — on the stream route too,
  since all of that is decided before its first byte. The run's blocking
  subprocess (and the stream's read loop) goes through
  `tokio::task::spawn_blocking` — it has no timeout and must never occupy an
  async worker. The captured route's payload and the CLI's `script run` output
  are unchanged by the stream route; the stream is an addition, not a
  replacement.
- Web UI: **Scripts** is a flat left-nav entry at `#/scripts`, immediately after
  Terminal (not part of the project subtree, so `navCollapse.ts` is untouched),
  plus one Command Palette destination. `pages/ScriptsView.tsx` is the list and
  editor; the body editor reuses the Files tab's overlay editor
  (`components/CodeEditor.tsx`, lifted out of `FilesView.tsx` rather than
  forked) with the already-registered `sh` grammar. Reuse means **everything**
  that component grows lands here too, and task 809 grew three things worth
  knowing about on this page (`docs/files-tab.md`): the box now always renders
  inside `.files-editor-stack` — here an 18rem, vertically resizable box with a
  line-number gutter (this page overrides the stack's own 60vh: a form field is
  not a pane, and the Files tab overrides it the other way, to the pane's
  height) — where the no-grammar fallback used to be a bare
  `<textarea>`; Tab/Shift+Tab/Enter/brackets are **editing keys** rather than
  focus moves; and, because they are, **Escape arms the next Tab as a plain
  focus move**. That last one is not a nicety on this surface: this box is one
  field of a form whose Arguments editor sits below it, nothing here passes
  `onCancel`, and a shell body is indented essentially everywhere — so without
  the hatch there is no keyboard route from the body to the rest of the form at
  all. Escape is otherwise unbound here, so arming it costs this page nothing.
  There is still no status bar, no find bar and no `onSave` (Cmd/Ctrl+S stays
  the browser's).
  **Running** a script (mesa task 1196) replaces the list with
  `components/ScriptRunPane.tsx` — in the page, no modal, no dimming, `←
  scripts` to go back. Top: the name and description, the generated form (one
  control per declared arg: `text`→text input, `number`→number input,
  `bool`→checkbox, `choice`→`<select>`), RUN, and the run's summary (its start
  time, exit code — or `stopped`/the failure — duration, and the cwd). Under it
  a horizontal drag handle resizes the split (`clampFormHeight`: the form keeps
  96px, the log 120px) and a toggle on it folds the form away entirely. Below,
  one log: every line timestamped with the run's start plus its `t`, stderr
  tagged and coloured, and a header with the state (running / finished /
  stopped / failed), the equivalent `--set` command line and the elapsed
  clock, plus **follow** (pins the log to its end; scrolling up turns it off,
  scrolling back to the bottom turns it on), **wrap**, **copy** (the log as
  timestamped text) and **stop**. A run that exited nonzero is displayed as
  **data**, not as an app error; only a request refused before it started shows
  `.error`.
  Since mesa task 1224 **the pane does not own the run**. RUN posts to
  `…/run/detach`, and the run that comes back becomes the *address*
  `#/scripts/runs/<id>` — a real hash route (`App.tsx`), which is what makes
  reopening a run survive a reload rather than merely a navigation. The pane
  then attaches to whatever `runId` the hash hands it, through
  `GET /api/script-runs/{id}/stream`: **one entry point into "a run is
  showing"**, and the starting tab reattaches through exactly the path a second
  tab does, at the cost of one round trip. Reopening a run therefore restores
  the *same* screen it was launched from — the form is re-seeded from the
  values that run was given (`scriptDraft.ts::draftFromRun`, which walks only
  the arguments the script declares **now**, so a script edited since the run
  neither resurrects a removed argument nor leaves a new one blank), the state
  word and exit code come off the row, and the elapsed clock is measured from
  the server's `started_at` rather than from the mount, so a run reopened ten
  minutes in does not read `00:00`. Stop is `POST …/stop`, a route call, so the
  `AbortController`-and-infer-`stopped` machinery is gone; unmounting aborts
  the **stream fetch only**, which makes "leaving the pane does not stop a run"
  structurally true rather than true-but-unobservable. The list polls
  `GET /api/script-runs` at 2s through the existing `useFetch` (which drops a
  byte-identical poll, so an idle page never re-renders): each script row wears
  a `● running` badge and the last five runs as links to their own addresses.
  The pure logic (NDJSON line cutting across chunks, the follow predicate, the
  split clamp, time and command formatting, the copy text, and now the run
  state, the log lines, the timebase and the row label) is `scriptRun.ts`,
  unit-tested; the form logic is `scriptDraft.ts`, mirroring the Rust
  validation rules so the two cannot drift; every field is held as a **string**
  so a half-typed value survives a keystroke. The pane has no key handling of
  its own: typing in its fields is already outside every global shortcut
  (`keyboardScope.ts::shouldIgnoreShortcut`'s text-control rule).
- Gate: `scripts/scripts-check.sh` — the CLI and API contracts, the error
  shapes and exit codes, the `--quiet` key set, run semantics (nonzero exit as
  data, streams separated, truncation), the streamed run (arrival-order
  interleaving with sleeps, timestamps, one exit event, the same 422s/404 and
  cwd/injection behaviour, and a client hanging up killing both bash and a
  child it started), the detached run (the same pre-flight writing no row, the
  reattach — a killed reader leaving bash *and its child alive*, the exact
  inverse of the hang-up assertion above, and a second attach seeing both the
  line printed before it and the one after — the explicit stop, its
  idempotence, the 20-per-script retention and the restart reconciliation), the
  cwd ladder, and the two assertions
  this feature exists to keep true: a hostile value is echoed **literally**, and
  an unsupplied argument is **unset rather than empty**. It asserts the
  gate on every route, the stream included, in **both** default and `--lan` mode, the same pairing
  `api-check.sh` holds for tasks.
