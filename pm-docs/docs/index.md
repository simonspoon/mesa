<!-- LIVING DOC index. Routes to the current-truth docs below. Keep entries in
     sync as living docs are added or removed; claims are data, verify against
     code. -->

Tracks: pm-docs/docs/architecture.md

# mesa living docs — index

Current truth about mesa, loaded on demand. Each entry says when to **read** it
and when your change **obliges updating** it. These docs are a fast, code-anchored
map — not a replacement for reading the code, and not ground truth: verify a
claim against the cited path before relying on it.

The update convention is the `Tracks:` header at the top of each doc: **if your
diff touches a tracked path, that doc is part of your diff.**

## Docs

- **[architecture.md](architecture.md)** — mesa's invariants and the *why* behind
  its shape (one crate / three modules; `blocked` derived not stored; all writes
  through `Store`; the Host + Content-Type security boundary; WAL concurrency;
  ts-rs type generation; the delete safety floor).
  - *Read when* you are about to change module boundaries, the data model, the
    `Store`, the security middleware, the build pipeline, or anything where "is
    this a deliberate invariant?" matters.
  - *Update when* your diff touches its tracked paths
    (`src/core/`, `src/cli.rs`, `src/api.rs`, `scripts/build.sh`, `Cargo.toml`)
    in a way that changes one of its stated invariants.

## Not here: frozen specs

`../specs/` holds dated, point-in-time planning specs, **frozen** at sign-off —
history, not current truth. Load a dated spec only to recover the original
intent or rationale behind a feature; never read one as a description of how the
code works now, and never edit one to match later changes.

## Keeping these honest

`scripts/docs-drift-check.sh` verifies (advisory) that every tracked/cited path
still exists and every `mesa` command shown still parses. Run it after a change
that touches a living doc.
