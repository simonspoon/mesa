# Artifacts (mesa task 974)

An **artifact** is a small, agent-written document attached to a project —
an HTML mockup, an SVG diagram, a markdown report — stored in the db and
rendered back to the person through a route hardened enough to make that
safe. It is not a file on disk (that is the Files tab) and not a chunk of
free text glued to a task; it is a first-class record with its own table,
CLI verb and API surface.

**Prose collision worth naming up front:** `Task.artifact` is an existing,
unrelated field — a bounded pointer string (a SHA, a PR URL, a path) an agent
writes at task close-out. This feature's `Artifact` is a different noun
entirely: a whole document, not a pointer to one. The two share a name and
nothing else.

## Storage

Table `artifacts`, **migration index 50** (a fresh db before this change
reports `user_version` 50, i.e. indices 0..=49 already exist; this migration
is the 51st entry, appended — never inserted — at the end of `MIGRATIONS`):

```sql
CREATE TABLE artifacts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    content_type TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX idx_artifacts_project ON artifacts(project_id);
```

`Store` (`create/get/list/update/delete_artifact`) is the only write path.
`list_artifacts(project_id: Option<i64>)` orders by
`name COLLATE NOCASE, id`, so the CLI, the API and the page can never
disagree about ordering. `delete_artifact` returns the destroyed record —
the recoverable echo that stands in for the confirmation prompt mesa
deliberately does not have. There is no history table: an artifact is
replaced in place by `update`, not versioned.

### Two storage decisions made deliberately, not by default

**(a) The body lives in the db, not on disk, unlike attachments.**
Attachments are arbitrary user binaries up to 25 MiB — putting those in the
db would bloat every `mesa backup` (`VACUUM INTO`) with opaque blobs, so they
live outside it. An artifact is a different species of thing: a small,
agent-written *text* document, the same kind of content a task `description`
or a diagram frame `body` already are, and both of those already live in the
db. Keeping the artifact body there too means one backup story for the whole
feature and no second on-disk tree for `Store` to reconcile against. The
counterweight that keeps this from becoming the attachment case by the back
door is a hard cap: `ARTIFACT_BODY_MAX = 2 * 1024 * 1024` (2 MiB). A body
over the cap is `validation`, naming the limit in bytes.

Note explicitly: the live conversation surface's `LIVE_TEXT_MAX` (8 KiB) does
**not** apply here. That cap exists because a live turn is spoken aloud
through `kokoro-rs` — an artifact is read, never spoken, so nothing about
this feature answers to that limit. `ARTIFACT_BODY_MAX` is its own constant,
sized for "a mockup or report a person reads in a browser," not "a sentence
synthesized into audio."

**(b) `project_id` is `ON DELETE CASCADE`, not `SET NULL` — the opposite of
`scripts` and `inbox_items`.** A script's body is hand-authored work that
outlives the folder it happened to run in, so `scripts.project_id` un-binds
on project delete rather than destroying the script. An artifact is the
opposite kind of thing: it is a page *about* a project, addressed at
`/api/projects/{id}/artifacts/…`, and `project_id` is `NOT NULL` — an
artifact has nowhere to live without its project, so cascading its delete is
the only coherent behaviour. `task_id`, by contrast, is the *optional*
binding (which task prompted this page, if any) and is `ON DELETE SET
NULL`: deleting the task that prompted an artifact must not destroy a
document that may still be useful on its own.

### Validation (in `Store`, not the schema)

- `name`: required, non-empty after trim, ≤ 200 chars. **Unique within a
  project, case-insensitively** — it is a selector (the CLI resolves an
  artifact by id only, but the constraint keeps the field usable as a human
  label the way a script's name is), so a duplicate is `conflict`, mirroring
  `create_script`'s duplicate-name handling. Stored verbatim — trimming only
  judges emptiness, never what gets saved.
- `content_type`: an allowlist of **exactly three** values —
  `text/html`, `image/svg+xml`, `text/markdown` — mirroring
  `files::image_mime`'s posture of "an explicit allowlist, not a sniff."
  Anything else is `validation`. A fourth value is a change to the render
  route and the web renderer both, never a free addition to the enum.
- `body`: required, non-empty, stored verbatim, capped at
  `ARTIFACT_BODY_MAX`.
- An unknown `project_id` or `task_id` is `validation`, not `not_found` — it
  arrives as a field of the record being written, mirroring
  `assign_inbox_item` and `create_script`'s own unknown-project handling.
- `project_id` is **immutable after creation** — a task's project already is,
  for the same reason: the id is baked into the record's own URL
  (`/api/projects/{id}/artifacts/{aid}`), so letting it move would leave
  stale links pointing at the wrong project.
- `update_artifact` re-enforces every rule `create_artifact` does, because an
  update is the other way a bad record could get in.

## Type (`src/core/types.rs`)

`Artifact`, ts-rs-exported to `../frontend/src/types/` exactly like `Script`.
Field order: `id, project_id, task_id, name, content_type, body, created_at,
updated_at`.

## CLI (`src/cli.rs`)

`mesa artifact {create,list,show,get,update,delete}` — `get` is an alias for
`show`, the standard posture.

- `create <PROJECT> <NAME>` — each positional has an equivalent flag
  (`--project`/`--name`); clap enforces exactly one of each pair. The body
  arrives one of two ways: `--body <TEXT>` or `--body-file <PATH>` (`-` means
  stdin), modelled directly on `script create`'s `--body`/`--body-file` pair
  so a multi-line HTML mockup can arrive from a heredoc or a real file.
  **Naming deviation from the task sketch:** the original sketch wrote
  `--file`; this doc and the implementation use `--body-file` instead, for
  consistency with `script create --body-file` and `task create
  --description-file` — CLAUDE.md's Consistency rule (match the existing
  codebase over inventing a new name) makes `--body-file` the right call, so
  the flag exists under that name and `--file` does not exist at all.
  `--content-type <MIME>` defaults to `text/html`, and `POST
  /api/projects/{id}/artifacts` shares the identical default when the JSON
  body omits the field — the default lives once, as
  `DEFAULT_ARTIFACT_CONTENT_TYPE` inside `Store::create_artifact` itself
  (which takes `content_type: Option<&str>`), so the CLI and the API cannot
  diverge on it, matching CLAUDE.md's "CLI and API share `core` and never
  diverge." `--task <ID>` is optional. Every project argument resolves an id
  or a name via `Store::find_project_by_name`, the standard helper every
  other command uses.
- `list [PROJECT]` — positional-or-`--project`, neither means unscoped.
  Prints a **bare array of compact objects with no `body`** — the same
  posture `task list` takes toward `description`. **Unlike `/api/scripts`
  and `/api/diagrams`, there is no flat `/api/artifacts?project=` sibling** —
  the API's only collection route is the nested
  `/api/projects/{id}/artifacts`. This is a deliberate asymmetry, not a gap:
  `project_id` is `NOT NULL`, so an artifact is never meaningfully unscoped,
  and the web UI only ever asks for one project's list at a time — a flat
  route would just be a second way to spell the same read with no caller.
  The CLI's unscoped `list` (`Store::list_artifacts(None)`) is a
  cross-project convenience for an agent scanning several projects at once,
  with deliberately no API equivalent.
- `show|get <ID>` — the full record.
- `update <ID>` — at least one of `--name`, `--body`, `--body-file`,
  `--content-type`, `--task` is required (an `ArgGroup`, so no flags at all
  is a usage error, exit 2). There is deliberately no `--project`: the
  binding is immutable, so there is nothing for a flag to change. `--task
  ""` un-binds the task. `--name` and `--body` are **replace-only** — an
  empty value is `validation`, not an erasure, exactly like a task's
  `description`.
- `delete <ID>` — echoes the full destroyed record.

`--quiet`: `QUIET_DROP_ARTIFACT = &["body"]`, fed through the shared
key-removal `quiet()` helper — never a hand-written second projection.
Accepted on `create`/`update`/`delete`/`show`/`get`; **rejected as an unknown
argument on `list`** (exit 2), because `list` already omits `body` by
default and offering `--quiet` there would drop nothing new. On `update` it
sits **outside** the field `ArgGroup`, so `--quiet` alone (no field flag) is
still the "no field given" usage error rather than a legal no-op call. A
key-parity `#[test]` (`sorted_owned(value_keys(&quiet(&sample_artifact(),
QUIET_DROP_ARTIFACT)))` against `minus(&full, QUIET_DROP_ARTIFACT)`) sits
alongside the existing ones for `Task`/`Script`/etc., so a new field added to
`Artifact` later forces a decision about whether `--quiet` should drop it
too.

## API (`src/api.rs`)

All six routes sit under the global `guard` middleware (Host allowlist +
Content-Type) and nothing stronger:

| Route | Success | Gate |
| --- | --- | --- |
| `GET /api/projects/{id}/artifacts` | 200, bare array | plain `guard` |
| `POST /api/projects/{id}/artifacts` | **201** | plain `guard` |
| `GET /api/artifacts/{aid}` | 200 | plain `guard` |
| `PATCH /api/artifacts/{aid}` | 200, fresh record | plain `guard` |
| `DELETE /api/artifacts/{aid}` | 200, destroyed record | plain `guard` |
| `GET /api/projects/{id}/artifacts/{aid}/render` | 200, raw body | plain `guard` |

Every handler takes `Result<Json<T>, JsonRejection>`, never bare `Json`, so a
malformed body is 422 rather than a 500. `validation` maps to 422,
`not_found` to 404, `conflict` to 409. On the render route, an artifact whose
`project_id` does not match the path's `{id}` is **404, not 403** — a
mismatched pair is simply "not found," the same posture every other
project-scoped read on this API already takes toward a wrong parent.

### Why plain `guard`, and why that answer doesn't change under `--lan`

This is the decision the whole feature turns on, so it is worth stating the
reasoning rather than just the rule:

- An artifact's body is project content, not an execution input. It sits in
  the same trust class as a task's `description` — which `/api/tasks`
  already serves unauthenticated in both serve modes — not in the class a
  script body or a `local_path` occupies. Neither `require_agent_access` nor
  `require_local_path_write` is the matching capability here; reaching for
  either would be gating a document read as if it were a program choice.
- More importantly: **the sandbox is the whole defense, and a defense that is
  the whole defense must be unconditional.** The task's own brief warns that
  the framing rules must not differ between `serve` and `serve --lan` by
  accident. The strongest way to honour that warning is for this route's
  behaviour to not depend on the mode at all — one header set, one gate,
  byte-identical whether the server was started with `--lan` or without it.
  A mode-dependent gate here would recreate exactly the drift the warning is
  about, and it would buy nothing: a LAN peer who can already `POST` a task
  description (unauthenticated, in both modes, today) can already put
  arbitrary text in front of the person using mesa. This route adds a
  render path for text that was already reachable, not a new way to inject
  it.

**The obvious objection, and why it doesn't apply here.** `scripts` and
`library` both gate reads loopback-only in *both* serve modes — library goes
further and gates all eleven of its routes that way, reads included, on the
reasoning that "a row's `body` IS the agent definition, hook script or
CLAUDE.md." An artifact is also a `body` column served over a route. Why is
this one different?

Because the two bodies sit in different **capability classes**, and it is
*who executes them* that decides which class a body is in, not the fact that
both happen to be called `body`. A library row's body is executed **by
Claude or by the shell** — mesa hands those exact bytes to a spawned agent,
or writes them to `.claude/` where a hook will later run them; a script's
body is executed **by `bash -c`** on this machine, directly. Handing either
of those out to anyone who can reach the LAN port is handing out code that
runs with this machine's privileges. An artifact's body, by contrast, is
executed **by nobody**: it is rendered into a frame the CSP has stripped of
its origin, so nothing inside it can reach mesa's API, read mesa's storage,
or call out to the network at all. It sits in the *content* class — the same
class a task `description` or a diagram frame `body` already occupy, and
every serve mode already hands both of those out unauthenticated.

Put another way: the library and scripts gates exist because their bytes are
dangerous **to the machine**. The artifact sandbox exists because its bytes
are potentially dangerous **to the browser rendering them**, and the sandbox
neutralises that danger at the point of rendering rather than at the point
of access. Gating access on top of a rendering-time defense that already
works would protect nothing — the bytes are just as harmless to hand out as
a task description is — while making the render route's behaviour
mode-dependent for no gain, which is the exact drift bullet two above warns
against. So: `library` and `scripts` are the two surfaces this feature is
deliberately **not** copying, and the reason is the capability class of the
body, not the name of the column it lives in.

Rust `#[test]`s assert the exact header set on the render route below, and a
separate test asserts that set is byte-identical with `state.lan` true and
false — the pairing this feature depends on, pinned the same way
`api-check.sh` pins the task-route pairing elsewhere.

## The render route's response headers

Copied verbatim, in this order of importance:

```
Content-Type:              <the stored allowlisted mime>; charset=utf-8
Content-Disposition:       inline; filename="<name>"      (via the existing disposition() helper)
X-Content-Type-Options:    nosniff
Content-Security-Policy:   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts
```

**The load-bearing directive is `sandbox allow-scripts` with no
`allow-same-origin`.** The `sandbox` CSP directive, given no keywords at all,
would already forbid scripts and forms and give the document an opaque
origin; naming `allow-scripts` re-opens exactly one of those restrictions —
scripts may run — while leaving the opaque-origin restriction in force,
because `allow-same-origin` is never named. An **opaque origin** is the whole
point: even when this URL is navigated to directly, in a top-level tab, with
no `<iframe>` involved at all, a script running inside the document cannot
read mesa's cookies or `localStorage`, and any request it tries to make is
treated as cross-origin by the browser rather than same-origin to mesa. That
is what makes it safe for a script inside an artifact to exist at all: the
document mesa just rendered has no identity in common with the app that
rendered it.

The rest of the policy closes what an opaque origin alone would still leave
open. `default-src 'none'` with no `connect-src` entry blocks `fetch`, `XHR`
and `WebSocket` outright — the opaque origin already stops those requests
from reading mesa's data, but banning them outright also stops the document
from reaching a *third-party* endpoint, which an opaque origin does nothing
about. `img-src data:`, `font-src data:` and `media-src data:` are the
concession that lets a self-contained mockup embed its own images and fonts
as data URIs without needing network access for them.
`script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` are allowed on
purpose — an agent-written mockup is one self-contained file, and forbidding
inline script/style would make that impossible without a second storage path
for assets this feature does not have. `form-action 'none'` and `base-uri
'none'` close the two navigation-shaped exfiltration paths a script-free
document could still use — a submitted form or a rewritten `<base>` could
otherwise carry data out through an ordinary top-level navigation, which the
`connect-src`/opaque-origin defenses above don't touch. No **external**
origin is permitted anywhere in the policy, for anything — an artifact is
meant to be self-contained, and any capability that requires reaching another
host is out of scope by design, not by oversight.

### Why this route is allowed to return `text/html` at all

`docs/files-tab.md`'s `/files/raw` section, and the doc comment on
`raw_project_file` in `src/api.rs`, both state a rule this project otherwise
holds firmly: **no route may ever return `text/html`.** That rule exists
because `/files/raw` serves arbitrary **repo files** — bytes a browser would
treat as an ordinary same-origin document the instant it saw that content
type, with mesa's own origin, cookies and API reachable from inside it. There
is no way to make that safe for arbitrary file content, so the route simply
never emits the type.

This route is the one deliberate exception, and the reason it is sound here
and would still be wrong there is the same distinction in one sentence: the
render route serves a **record mesa itself created and validated**, not
arbitrary repo bytes, and the response is stamped with a CSP that strips the
document's origin before a browser ever executes anything in it. The
exception is the CSP, not the content type. If `/files/raw` ever grew this
same CSP for `.html` files, it would still be the wrong move there — a repo's
`.html` file is not a record mesa wrote, its content is arbitrary and
unbounded (25 MiB via `/files/download`, not a 2 MiB validated `body`), and
serving it same-origin-but-sandboxed would still hand a hostile page in a
git checkout a route to render itself through mesa. The two routes will
never converge: one refuses `text/html` categorically, the other only ever
serves it stripped of everything that would make it dangerous.

### Residual risk: top-level self-navigation

Verified against a real headless Chrome with an adversarial artifact body
that tried each of the following, both **framed** in the Artifacts tab
(`<iframe sandbox="allow-scripts">`) and, separately, **navigated to
directly** at the top level with no iframe at all — i.e. the CSP header
alone, nothing else in play:

- `origin` → `null` (opaque origin, confirmed rather than assumed)
- `document.cookie` → throws `SecurityError`
- `localStorage` → throws `SecurityError`
- `fetch('/api/projects')` → throws `TypeError`
- `fetch('/api/terminal', {method: 'POST'})` → throws `TypeError`
- `top.location = 'https://example.com'` → throws `SecurityError` **when
  framed** — but **succeeds** when the render URL is the top-level document
  itself, and Chrome left mesa for the redirect target.

The first five hold in both configurations: the opaque origin, and the
inability to read cookies/storage or reach any mesa API, do not depend on
whether the document is framed. The sixth is the one place the two
configurations diverge, and it is a real, accepted residual rather than an
oversight: CSP's `sandbox` directive restricts top-level navigation *out of
a frame*, but says nothing about a top-level document navigating itself —
that is ordinary, unrestricted web behaviour, and no CSP directive forbids
it.

**In the product surface this does not matter.** The Artifacts tab always
frames the body; a person only ever reaches the bare render URL by opening
it directly (copying it, or `mesa live navigate` pointing a browser at it
outside the app shell), which is a narrower and more deliberate act than
ordinary use of the tab.

**The severity of what's left is a phishing-style redirect, not an origin
escape.** An artifact opened directly can send the browser to an arbitrary
site; it still cannot read mesa's cookies, storage, or any API route in
either serve mode — every capability the sandbox exists to deny stays
denied. What leaks is exactly one bit: "the browser is now looking at a page
this artifact chose," nothing more.

**This is accepted, not fixed, because the fixes available would defeat the
feature.** Serving the render route as `Content-Disposition: attachment`
would stop a direct navigation from rendering at all — but the render route
exists specifically so `mesa live navigate` can put a hosted page in front
of the person as a page, not a download. Refusing direct top-level
navigation outright would require distinguishing "framed by mesa" from
"navigated to directly," which a response header cannot do (a request looks
identical either way) without adding origin-checking machinery this route
has otherwise had no reason to grow. Either mitigation closes a narrow
redirect risk by breaking the capability the whole route was built for, so
neither is worth it — the residual is smaller than what fixing it would
cost.

## Web UI

New project tab **Artifacts** at `#/projects/<id>/artifacts`: a list on the
left, the selected artifact rendered on the right.

- `text/html` and `image/svg+xml` render in
  `<iframe sandbox="allow-scripts" src="/api/projects/{id}/artifacts/{aid}/render">`.
  The `sandbox` **attribute**, also with no `allow-same-origin`, is a second,
  independent layer on top of the response header: the *header* is what
  protects a direct navigation to the render URL (someone opening it in a new
  tab, or curling it), the *attribute* is what protects the framed case even
  if the header were ever accidentally weakened or dropped. Both are kept,
  always, and neither is treated as making the other redundant. The frame's
  `src` is the render route — never `srcDoc` and never
  `dangerouslySetInnerHTML` — so the document a browser actually parses is
  always the one carrying the CSP header, not a string handed to the DOM
  directly.
- `text/markdown` renders through the existing `components/Markdown.tsx`
  instead of an iframe at all — that component already guarantees no raw
  HTML passthrough (task 813's rule for diagram frame bodies), so a markdown
  artifact gets the app's own typography with no sandboxing apparatus needed:
  there is no script to sandbox against once HTML can't reach the DOM in the
  first place.

Pure logic lives in `frontend/src/artifactDraft.ts` with a matching
`artifactDraft.test.ts`, mirroring `scriptDraft.ts`/`scriptDraft.test.ts`
exactly — the same "predicates that historically shipped wrong" module
posture CLAUDE.md's frontend list describes.

## Gate

`scripts/artifacts-check.sh` exercises the CLI CRUD contract, the `--quiet`
key set (checked with `jq`, never byte comparison), `list` omitting `body`
and rejecting `--quiet`, the delete echo, the Content-Type allowlist
rejection, case-insensitive name-uniqueness `conflict`, the `ARTIFACT_BODY_MAX`
cap, project-delete CASCADE versus task-delete SET NULL, and — over a live
`serve` — the render route serving the stored body byte-identically with its
exact header set, a 404 for an artifact/project mismatch, and that header set
being identical under `serve` and `serve --lan`.
