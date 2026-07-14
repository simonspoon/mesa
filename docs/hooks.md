# Hooks (user-configured shell commands on events)

A **hook** is a shell command the user binds to a named hook point in
`hooks.json` beside the database (`MESA_HOOKS_FILE` overrides it for tests,
like `MESA_DB`) — a flat JSON map `{"<hook>": "<command>"}`. The framework
lives in `src/core/hooks.rs`, shared by CLI and API so the contract never
diverges. The command comes from the user's own local config, never from a
request; firing it is still **code execution**, so the API trigger route
shares the agents' mode-dependent access gate (`require_agent_access`).

- One hook point so far: **`task-execute`** — fired by `mesa task execute <id>`
  or `POST /api/tasks/{id}/execute` (the web UI's **Execute** button in the
  task panel). The command runs under `sh -c` with the full task JSON on
  stdin, `MESA_HOOK`/`MESA_TASK_ID`/`MESA_TASK_TITLE`/`MESA_PROJECT_ID`/
  `MESA_DB` in the environment, and the project's `local_path` as cwd when
  that folder exists.
- The result is a `HookRun` object: `{hook, command, exit_code, stdout,
  stderr}` (output capped at 64 KiB). A **nonzero hook exit is data**, not a
  failure — CLI exits 0, API returns 200, `exit_code` carries it. No hook
  configured (or a malformed hooks file) is `validation`; a shell that cannot
  spawn is `unavailable`. There is deliberately **no timeout** (matching the
  agents/usage shell-outs): a hook that should outlive the request must
  background itself (`… >/dev/null 2>&1 &`).
- Gate: `scripts/hooks-check.sh` (CLI + API contract, access gate, error
  shapes).
