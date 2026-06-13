# Agent acceptance test — living docs routing (Acceptance 6)

Spec: `pm-docs/specs/2026-06-12-living-architecture-docs.md`, Acceptance 6.
Date: 2026-06-12. Run via a fresh general-purpose subagent in the repo.

## Task given (no mention of where docs live)

> I'm considering a change … add a way to mark a task as "blocked" directly — a
> manual flag I can toggle — instead of it being inferred from dependencies. How
> well does that fit mesa's current model? … add a one-line "Sources consulted:"
> listing the files you actually opened.

## Result: PARTIAL — substance PASS, routing FAIL

- **Substance (PASS).** The agent correctly identified the invariant: "`blocked`
  is a pure function of the dependency graph, computed in SQL on every read —
  never stored," recommended against a stored manual flag, and named the
  end-to-end plumbing cost. This matches `architecture.md`'s stated invariant.
- **Routing (FAIL).** The agent's "Sources consulted" were `src/core/types.rs`,
  `src/core/store.rs`, `src/cli.rs`, `src/api.rs` — it never opened
  `pm-docs/docs/index.md` or `architecture.md`. It re-derived the invariant
  directly from code in 4 tool calls.

## Interpretation

This is the exact skepticism the consult panel raised (Barry/Karpathy: "could an
agent re-derive this in 30s by grep? If yes it's redundant"). For a small crate
whose invariant is legible in `src/core/store.rs`, the agent went to code, not
the index. Two confounds before reading this as a verdict on the convention:

1. **The subagent may not have had the root `~/inaros/CLAUDE.md` routing line in
   context.** Whether a spawned general-purpose agent loads the project CLAUDE.md
   the same way a main session does is unconfirmed; if it did not, this run never
   exercised the routing line and under-states its effect.
2. The task was answerable from a single SQL expression — a low bar for "just
   read the code," i.e. close to the redundant case the docs deliberately avoid
   duplicating.

## Follow-up to make this a real verdict

- Re-run as a **main-session** check (where the CLAUDE.md routing line is
  definitely loaded), or temporarily make the routing line more imperative, and
  measure right-slice-hit-rate on a task whose answer is a *non-code-obvious*
  rationale (e.g. "why is there no `--force` on delete?", "why Host+Content-Type
  instead of auth?") — facts that reward the docs over a grep.
- This is the consult's recommended index-vs-no-docs A/B, deferred in this spec
  (Non-goals) and now clearly worth running.
