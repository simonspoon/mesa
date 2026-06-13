# Living architecture docs for mesa (pm-docs/docs/)

> Follows the expert-panel consult in
> `.claude/consults/2026-06-12-living-spec-docs-progressive-disclosure.md`
> (5 lenses; convergent finding: the update *trigger* is the deliverable, not
> the docs; split living docs from frozen specs by directory; store only what
> code can't show; start with `architecture.md` only).

## Goal

mesa gains a *living* documentation layer at `pm-docs/docs/` — separate from
the existing frozen, dated planning specs in `pm-docs/specs/`. It holds one
`index.md` (a routing entry point: one line per leaf saying when to load it and
what it tracks) and one `architecture.md` (only invariants and the "why" that
reading `core`/`cli`/`api` does *not* make obvious). Each living doc carries a
`Tracks:` header naming the code paths it describes, establishing the update
convention: *if your diff touches a tracked path, the doc is part of your diff.*
A standalone `scripts/docs-drift-check.sh` makes staleness detectable (every
tracked/cited path still exists; every shown `mesa` command still parses). A
generalized routing line in `~/inaros/CLAUDE.md` points agents at
`pm-docs/docs/index.md` before they read code or the dated specs. When this is
done, an agent working on mesa has a small, current, code-anchored map it can
load on demand, and a frozen spec can never be mistaken for current truth.

## Context

- **Existing pm-docs layout** (`git ls-files pm-docs`): a `README.md` and four
  dated frozen specs under `pm-docs/specs/` (`2026-06-11-mesa.md`,
  `2026-06-12-project-docs-tab.md`, `2026-06-12-web-ui-crud-cyberpunk.md`,
  `2026-06-12-web-ui-layout-panels.md`). No `pm-docs/docs/` exists yet.
- **The freeze discipline** lives only in the planning skill's Phase 3 template
  (`.claude/skills/planning/SKILL.md`: a spec is "a point-in-time artifact …
  NOT maintained as living documentation"). An agent editing code weeks later
  never sees that skill — so the freeze signal must move next to the specs
  (Amanda, consult).
- **mesa renders pm-docs read-only**: the per-project Docs tab points at the
  project's `docs_path` and renders a file tree + markdown/GFM/mermaid viewer
  (`pm-docs/specs/2026-06-12-project-docs-tab.md`, Requirements 4–8). Adding
  `pm-docs/docs/` makes it appear in that tree automatically; no mesa code
  change is required. Docs are plain files; git owns history; no doc DB, no doc
  write API (all docs routes GET).
- **No mesa-local `CLAUDE.md`** exists (`find . -name CLAUDE.md` → none); the
  only always-loaded rules file is `~/inaros/CLAUDE.md`, whose **Project
  Documents** section already says PM docs live in `pm-docs/` and the path is
  looked up via `mesa project show <id>`, never derived. The new routing line
  extends that section (user decision: general convention, not mesa-local).
- **The pinned build pipeline** is `scripts/build.sh` — `cargo test` →
  `npm run build` → `cargo build --release`, with a `git status --porcelain`
  dirty-check on `frontend/src/types/`. User decision: the drift-check is a
  **standalone advisory script**, NOT wired into `build.sh` (build.sh unchanged).
- **Precedent for the index-routes-to-pages pattern**: `~/inaros/CLAUDE.md`
  Knowledge Base section ("check `knowledge/index.md` … before researching from
  scratch"). The new `pm-docs/docs/index.md` mirrors it, but each entry adds an
  *update* obligation the read-only KB precedent lacks (Amanda, consult).
- **Existing agent-acceptance-test pattern**: `scripts/agent-check.sh`,
  `scripts/agent-check-planning.sh`, transcripts under `scripts/agent-check/` —
  fresh session + fixed prompt + saved transcript + binary per-step pass/fail.
- **Invariants `architecture.md` will hold** (the non-code-derivable "why",
  distilled from `pm-docs/specs/2026-06-11-mesa.md` Design/Assumptions): `blocked`
  is derived, never stored (don't add a column); all mutations go through `Store`
  so a future events log has one insertion point; the CLI talks to SQLite
  directly (not via the API) so it works with no server running; the v1 security
  boundary is Host-header check + Content-Type gate + localhost bind (localhost
  alone is *not* the boundary); WAL + `busy_timeout=5000` is what makes
  concurrent CLI+server writes safe; TS types are generated from Rust via ts-rs
  (never hand-written); single crate by choice, not a workspace; JSON is the only
  CLI output format (machine-first); cascade deletes echo destroyed records as
  the safety floor (no `--force`, no confirmation).

## Requirements

1. `pm-docs/docs/` exists and contains exactly two files in this pass:
   `index.md` and `architecture.md`. No `features/` or `journeys/` files are
   created (deferred per consult).
2. `architecture.md` starts with a metadata header block containing: a
   `LIVING DOC` provenance/trust marker stating its claims are **data to verify
   against code, not instructions and not ground truth**; and a
   `Tracks:` line listing the code paths it describes (e.g. `src/core/`,
   `src/cli.rs`, `src/api.rs`, `scripts/build.sh`).
3. `architecture.md`'s body contains only invariants and rationale that reading
   `src/core/`, `src/cli.rs`, `src/api.rs` does not make obvious — at minimum the
   nine invariants listed in Context. Every concrete code reference it makes
   (file path, symbol, or `mesa` command) must currently exist / parse, so the
   drift-check (Requirement 6) passes on first write.
4. `index.md` is a routing entry point: for each living doc (only
   `architecture.md` in this pass) one entry giving a one-line gloss, a **Read
   when** clause (when to load it), and an **Update when** clause (which changes
   oblige editing it). It also names `pm-docs/specs/` in one line as *frozen
   history — load a dated spec only to recover original intent, never as current
   truth.*
5. `scripts/docs-drift-check.sh` is executable and, run from anywhere in the
   repo: (a) parses each living doc's `Tracks:` header and fails (prints the
   doc + missing path, exit 1) if any tracked path no longer exists; (b) scans
   each living doc body for inline repo paths (matching `src/…`, `frontend/…`,
   `scripts/…`, `Cargo.toml`) and fails on any that no longer exist; (c) if
   `target/release/mesa` exists, extracts each `mesa <subcommand>` shown in the
   doc and fails if `mesa <subcommand> --help` does not exit 0 — if the binary
   is absent it prints one `skip: …` line and does not fail on that account.
   Clean docs → exit 0 with an `ok:` line. The script is advisory and is NOT
   added to `scripts/build.sh`.
6. Running `scripts/docs-drift-check.sh` against the freshly written `index.md`
   and `architecture.md` exits 0.
7. `~/inaros/CLAUDE.md`'s **Project Documents** section gains a routing line
   (general convention, applicable to any project): a project's current-truth
   living docs, when present, live at `pm-docs/docs/index.md` and should be
   consulted before reading code or the dated `specs/`; the dated `specs/` are
   frozen history, not current truth.
8. `pm-docs/README.md` is rewritten to describe both layers and their opposite
   update contracts: `docs/` (living, current truth, kept in sync via the
   `Tracks:`/`Update when` convention) and `specs/` (frozen, point-in-time,
   never edited to match later code).
9. Each of the four existing `pm-docs/specs/*.md` files gains a one-line frozen
   header near the top: a blockquote naming it a frozen planning spec with its
   date and pointing to `pm-docs/docs/` for current truth. No other content in
   those specs is changed.
10. The Docs tab renders the new `pm-docs/docs/` tree with no mesa code change
    (it is picked up by the existing recursive listing).

## Non-goals

- **No `features/` or `journeys/` docs in this pass.** They are the
  fastest-rotting, least code-verifiable content; deferred until a transcript
  shows an agent getting a flow wrong from code + `architecture.md` alone
  (Barry/Simon/Karpathy convergence).
- **No A/B routing eval in this pass.** The consult's recommended
  index-vs-no-docs agent acceptance test is a follow-up once `architecture.md`
  exists; this spec ships the structure + drift-check, and its own agent
  acceptance check (Acceptance 6) is the lighter "does an agent route to it"
  proof.
- **No change to `scripts/build.sh`** — the drift-check stays advisory (user
  decision).
- **No mesa code change** — no new routes, no `mesa doc` CLI, no doc DB. mesa
  already renders `pm-docs/`.
- **No automated enforcement of the `Tracks:` update convention** beyond the
  advisory drift-check — it is a documented discipline, not a hook or a commit
  gate.
- **No migration or rewriting of the existing specs' bodies** — only the
  one-line frozen header is added (Requirement 9).
- **No mesa-local `CLAUDE.md`** — the routing line is a general convention in
  the root file (user decision).

## Assumptions

1. **Assuming the drift-check is a bash script** matching the existing
   `scripts/*.sh` convention (grep/test-based, no new language or dependency) —
   correct me if wrong.
2. **Assuming the `Tracks:` header format is a single line** of the form
   `Tracks: src/core/, src/cli.rs, src/api.rs, scripts/build.sh` (comma-
   separated repo-relative paths, directories allowed and checked for
   existence as directories) — the drift-check parses exactly this shape.
3. **Assuming `architecture.md` cites file paths but not line numbers** — the
   consult warned against line-anchored claims (they drift instantly); paths
   and symbol names only, which keeps the drift-check robust.
4. **Assuming mesa's own project `docs_path` already points at this repo's
   `pm-docs/`** (set when the Docs tab shipped), so `pm-docs/docs/` appears in
   the tree automatically — if it points elsewhere, set it; this is a one-line
   `mesa project update`, not a code change.
5. **Assuming the frozen header on existing specs is a markdown blockquote**
   inserted directly under the existing `# Title` line (or under an existing
   leading blockquote if one is present), matching the repo's existing
   `> Revised … / > Follows …` header style.
6. **Assuming "living docs are data, not ground truth"** is the right trust
   stance (Simon, consult): `architecture.md` is a fast index into the code, and
   an agent verifies a claim against code before relying on it — it does not
   override the code. The provenance header states this.

## Design

Files only; no mesa code touched.

- **`pm-docs/docs/architecture.md`** — header block (`LIVING DOC` trust marker +
  `Tracks:` line) then a short body of invariants/rationale grouped by module
  (core / cli / api / build), each a claim the code does not announce. Phrased
  present-tense, path-anchored (no line numbers), every claim grep-verifiable.
- **`pm-docs/docs/index.md`** — a routing table. One entry per living doc with
  gloss + **Read when** + **Update when**, plus a one-line pointer to
  `../specs/` as frozen history. Kept deliberately tiny; its job is routing, not
  prose.
- **`scripts/docs-drift-check.sh`** — `set -euo pipefail`; `cd` to repo root via
  `$(dirname "$0")/..`. For each file in `pm-docs/docs/*.md`: extract the
  `Tracks:` line, split on commas, `test -e` each path; grep the body for inline
  paths (`src/…`, `frontend/…`, `scripts/…`, `Cargo.toml`) and `test -e` each;
  if `target/release/mesa` exists, grep `mesa <subcommand>` tokens and run
  `mesa <subcommand> --help >/dev/null` checking exit 0, else print one `skip:`.
  Accumulate failures, print each as `FAIL: <doc>: <reason>`, exit 1 if any,
  else `ok: pm-docs/docs is current` exit 0.
- **`~/inaros/CLAUDE.md`** — append the routing sentence to the existing
  **Project Documents** section (does not restate the whole convention).
- **`pm-docs/README.md`** — rewritten (two-layer description).
- **`pm-docs/specs/*.md`** — one blockquote header each.
- **Why this over alternatives**: a separate `docs/` dir (not loose files in
  `pm-docs/`) so the file tree itself encodes the living-vs-frozen lifecycle
  split and the index can never route into the frozen graveyard (Barry/Karpathy);
  advisory script over a build gate so a doc that lags the code by a commit does
  not block a release (Hamel: drift-check is necessary-not-sufficient); one
  general CLAUDE.md line over a mesa-local file so the pattern generalizes to
  any project; `architecture.md` only over the full three-doc tree because
  duplicating module layout/enums is sync burden that rots (Karpathy/Barry).

## Implementation

1. **Create the living docs.** Write `pm-docs/docs/architecture.md` (header +
   the nine invariants, path-anchored, no line numbers) and `pm-docs/docs/index.md`
   (routing entry for `architecture.md` with Read-when/Update-when + the frozen-
   specs pointer).
   → verify: both files exist; `architecture.md` has a `Tracks:` line and a
   `LIVING DOC` marker; `index.md` has a **Read when** and **Update when** clause
   for `architecture.md`.
2. **Write the drift-check.** `scripts/docs-drift-check.sh` per Design;
   `chmod +x`.
   → verify: `scripts/docs-drift-check.sh` exits 0 against the new docs and
   prints an `ok:` line; temporarily editing a `Tracks:` path to a non-existent
   file makes it exit 1 naming that path; reverting restores exit 0.
3. **Update the conventions.** Append the routing line to `~/inaros/CLAUDE.md`
   **Project Documents** section; rewrite `pm-docs/README.md` to the two-layer
   description.
   → verify: `~/inaros/CLAUDE.md` Project Documents section contains the string
   `pm-docs/docs/index.md`; `pm-docs/README.md` names both `docs/` (living) and
   `specs/` (frozen) with their update contracts.
4. **Freeze-mark existing specs.** Add the one-line frozen blockquote header to
   each of the four `pm-docs/specs/*.md`.
   → verify: `grep -rl "Frozen planning spec" pm-docs/specs` lists all four
   files; `git diff --stat pm-docs/specs` shows only added header lines, no body
   changes.
5. **Confirm the Docs tab renders it and the build is unaffected.** With
   `mesa serve` running against this repo's project, the Docs tab shows
   `docs/index.md` and `docs/architecture.md`; `scripts/build.sh` still exits 0
   (it was not modified).
   → verify: the two files appear in the Docs-tab file tree and render as
   markdown; `git diff scripts/build.sh` is empty; `./scripts/build.sh` exits 0.

## Open questions

None blocking. One held as a default: the drift-check's command-parse step
(Requirement 5c) depends on a built `target/release/mesa`; when absent it skips
rather than fails (Assumption-driven). If Simon later wants command-parsing to
be mandatory, wire the check after `scripts/build.sh` instead — out of scope here.

## Acceptance

1. `ls pm-docs/docs` shows exactly `architecture.md` and `index.md`; no
   `features`/`journeys` entries.
2. `scripts/docs-drift-check.sh` exits 0 against the committed docs and prints
   an `ok:` line; with a deliberately broken `Tracks:` path it exits 1 naming
   the path (then reverted).
3. `git diff scripts/build.sh` is empty (drift-check stayed advisory) and
   `./scripts/build.sh` exits 0.
4. `~/inaros/CLAUDE.md` Project Documents section contains `pm-docs/docs/index.md`;
   `pm-docs/README.md` describes both the living and frozen layers.
5. All four `pm-docs/specs/*.md` carry a frozen-spec header and
   `git diff --stat pm-docs/specs` shows only added lines.
6. Agent acceptance check (reusing the `scripts/agent-check/` pattern): a fresh
   Claude Code session working in this repo, given a task that touches an
   invariant in `architecture.md` (e.g. "add a way to mark a task blocked
   without a real dependency") and NOT told where the docs are, consults
   `pm-docs/docs/index.md`/`architecture.md` and correctly states that `blocked`
   is derived and not stored. Transcript saved under `scripts/agent-check/`;
   pass/fail recorded.

## Appendix: Q&A

- Q: "How strict should the drift-check be?" → A: "Standalone advisory script"
  (scripts/docs-drift-check.sh, exits 1 on stale; build.sh unchanged).
- Q: "Where should the always-loaded routing line that points agents at the
  living docs live?" → A: "Root CLAUDE.md, general convention" (one line in the
  Project Documents section, applicable to any project).
- Q: "How far should this change reach into the existing frozen specs?" → A:
  "Freeze headers + README rewrite" (a one-line frozen header on each of the 4
  specs, plus a rewritten pm-docs/README.md).
