# inaros-codesearch

Registers one tool, `codesearch` (`mcp__inaros-codesearch__codesearch`), that
drives the `helios` CLI over the current repo's index so structural questions
go to an AST index instead of grep.

| operation | helios | arguments |
| --- | --- | --- |
| `symbols` | `helios symbols` | grep, kind, file, scope, visibility, param, returns, body, limit, offset |
| `deps` | `helios deps <target>` | target (required), scope, file, depth, reads, writes, to, follow_impls |
| `flow` | `helios flow <target>` | target (required), scope, file, line, mermaid — Rust and C# only |
| `summary` | `helios summary [path]` | path |
| `files` | `helios files` | language |
| `diff` | `helios diff` | impact |
| `status` | `helios status` | — |

`json: true` adds `--json --compact`. There is no `callers` operation: `deps`
already reports both directions (dependencies *and* references).

An argument an operation does not take is refused rather than dropped, so a
mistaken call says so instead of silently answering a different question.

## Running it

    claude --plugin-dir <mesa>/plugins/inaros-codesearch

Requires `helios` on PATH and an index in the repo (`helios init` once).

**If the tool never appears**, MCP policy is refusing it: a plugin-registered
tool is served over a loopback MCP server named after the plugin, so every MCP
gate applies to it — an account-level policy, `allowedMcpServers`, or
`allowManagedMcpServersOnly`. Blocked, it registers, never connects, and the
session simply has no such tool. A `-p` run only reports `not yet in the
session's tools after 8000ms`; the cause is named in an **interactive**
session's `--debug-file` log, as `MCP servers blocked by managed policy at
connect time`.

## Developing

Types in `.claude/types` are written by `/plugin-types`; regenerate after a
Claude Code update rather than editing. `tsc -p tsconfig.json` typechecks the
module; `claude plugin validate .` shows what the engine reads from it.

## Installed copy

`claude plugin marketplace add <mesa>` + `claude plugin install
inaros-codesearch@mesa` makes it always-on at user scope. Install
copies the tree into `~/.claude/plugins/cache/mesa/inaros-codesearch/<version>`,
keyed by that version, so **edits here do not reach an installed session**: bump
`version` in the manifest and re-run `claude plugin update inaros-codesearch`,
or develop against `--plugin-dir`, which reads this folder live and reloads on
save.

## Developing locally

Symlinking this folder into `~/.claude/skills/` loads it as
`inaros-codesearch@skills-dir` straight from the working tree, so an edit to
`hooks/codesearch.ts` reaches the next session with no `version` bump and no
`--plugin-dir` flag — unlike the installed copy above. An installed plugin of
the same name takes precedence and keeps the symlinked copy unloaded, so
uninstall it first.

    ln -s <mesa>/plugins/inaros-codesearch ~/.claude/skills/inaros-codesearch
