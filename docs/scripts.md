# Scripts (user-authored shell, run from a generated form)

A **script** is a piece of shell the user writes and keeps in mesa, together
with an explicitly declared list of arguments. Table `scripts` (migration index
32): `project_id`, `name`, `description`, `body`, `args`, timestamps. The FK is
**`ON DELETE SET NULL`** (as the inbox's is, deliberately not cascade): a
project binding is where a script *runs*, not what a script *is*, so deleting a
project must un-bind the user's scripts rather than destroy work they authored
by hand and cannot get back. `args` is stored as a JSON array and decoded inside
`Store` — the column is an implementation detail, the `Script` struct exposes a
typed `Vec<ScriptArg>`. Runs are **not** persisted: a `ScriptRun` is a
request/response record, the `HookRun` twin.

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
  `run` (the `hooks.rs` executor shape).
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
- **The working directory is resolved from the script's own project binding,
  never from the caller.** A bound script runs in that project's `local_path`,
  via the standard ladder the terminal and agents use: no `local_path`, or a
  path that is not a directory on this machine, is `validation` (422). An
  unbound script runs in `$HOME`.
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
- API — all six routes under the global `guard` middleware (Host allowlist +
  Content-Type), no carve-outs:

  | Route | Success | Gate |
  | --- | --- | --- |
  | `GET /api/scripts` (`?project=<id>`) | 200, bare array | `require_agent_access` |
  | `POST /api/scripts` | **201** | `require_local_path_write` |
  | `GET /api/scripts/{id}` | 200 | `require_agent_access` |
  | `PATCH /api/scripts/{id}` | 200 | `require_local_path_write` |
  | `DELETE /api/scripts/{id}` | 200, destroyed record | `require_local_path_write` |
  | `POST /api/scripts/{id}/run` (`{"values": {…}}`) | 200 | `require_agent_access` |

  **The read/write asymmetry is the point.** Authoring a script is *choosing a
  program mesa will execute*, so the three mutations take the `/api/config`
  posture — **loopback-only in both serve modes**, one notch stronger than the
  agent routes that `--lan` does open. Running one is *triggering* execution of
  something already stored, which is the agents' capability class, so it shares
  their gate. A LAN peer may trigger a run; it must never choose the program.
  Do not weaken either half, and do not let them drift together.
  A malformed body is 422 (every handler takes `Result<Json<T>, JsonRejection>`,
  never bare `Json`); values that fail `validate_values` are 422 `validation`;
  a bash that will not start is 502 `unavailable`. The run's blocking
  subprocess goes through `tokio::task::spawn_blocking` — it has no timeout and
  must never occupy an async worker.
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
  `components/ScriptRunModal.tsx` wraps `components/ScriptRunPanel.tsx`,
  reusing the `.create-task-backdrop`/`.create-task-modal` classes so
  `keyboardScope.ts::shouldIgnoreShortcut` keeps working unchanged. The panel
  generates one control per declared arg (`text`→text input, `number`→number
  input, `bool`→checkbox, `choice`→`<select>`) and renders the returned run as
  an exit-code badge plus separate stdout/stderr blocks — a failing run is
  displayed as **data**, not as an app error. All form logic is pure and
  unit-tested in `scriptDraft.ts`, mirroring the Rust validation rules so the
  two cannot drift; every field is held as a **string** so a half-typed value
  survives a keystroke.
- Gate: `scripts/scripts-check.sh` — the CLI and API contracts, the error
  shapes and exit codes, the `--quiet` key set, run semantics (nonzero exit as
  data, streams separated, truncation), the cwd ladder, and the two assertions
  this feature exists to keep true: a hostile value is echoed **literally**, and
  an unsupplied argument is **unset rather than empty**. It asserts the
  read/write gate pairing in **both** default and `--lan` mode, the same pairing
  `api-check.sh` holds for tasks.
