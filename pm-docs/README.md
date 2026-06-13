# pm-docs

PM documents for the mesa project, per the Project Documents convention in the
root `CLAUDE.md`. There are **two kinds of document here, with opposite update
contracts** — don't confuse them:

- **`docs/` — living docs (current truth).** Architecture and invariants kept in
  sync with the code. Start at [`docs/index.md`](docs/index.md), which routes you
  to the right doc and says when to read it. Each living doc carries a `Tracks:`
  header naming the code paths it describes; the update rule is: **if your diff
  touches a tracked path, that doc is part of your diff.** `scripts/docs-drift-check.sh`
  flags a living doc whose cited paths or commands have gone stale.

- **`specs/` — frozen planning specs (history).** Dated, point-in-time specs
  written before a feature was built and **frozen at sign-off**. Read one only to
  recover the original intent behind a feature; never read it as a description of
  how the code works now, and never edit it to match later changes. New specs are
  written here by the planning skill as `specs/YYYY-MM-DD-<slug>.md`.

Documents written before this convention stay where they are (`/specs` and
`/.claude/consults` at the repo root).
