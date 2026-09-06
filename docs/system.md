# System monitor

A live reading of the **host the mesa server is running on** — memory, CPU,
disk, GPU, uptime — read on every request and never stored. mesa is often
served from a machine nobody is sitting at, so this is the one place that
machine describes itself.

## The one rule

**Every value a platform may decline to report is `Option`, and "could not
determine" is `null`.** Never a sentinel, never a zero, never an error — the
`get_project_version` posture (`{"version":null,…}`). `core::system::snapshot`
is therefore **infallible**: it returns a `SystemInfo` in every circumstance,
including a host that answers almost nothing.

A `null` and a reading of `0` are different facts and must stay
distinguishable end to end: `frontend/src/systemMeter.ts` carries the unknown
case through as `null` rather than defaulting it, and the Settings section
draws **no track at all** for a `null`, printing "not reported" instead. A bar
at 0% would claim the machine has none of that.

## What is read, and what it costs

`sysinfo` (a new dependency, `system` + `disk` features only) supplies
everything except the GPU. Two costs are handled deliberately:

- **CPU utilisation needs two samples.** A percentage is the difference
  between two refreshes of the *same* `System`, so `snapshot()` refreshes,
  sleeps `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`, and refreshes again — making
  it a **~200 ms blocking call**. The `System` lives in a process-global
  `OnceLock<Mutex<…>>` so consecutive calls also see a real delta. The API
  handler runs it on `spawn_blocking` (like `get_git_status`); the CLI, one
  shot per process, calls it directly.
- **The GPU is a subprocess** — `system_profiler SPDisplaysDataType -json`,
  **macOS only** — and a slow one, so it is asked **once for the life of the
  process** and cached in a `OnceLock`: the hardware does not change under a
  running server. `MESA_SYSTEM_PROFILER_BIN` is the test seam
  (`listen::auris_bin`'s precedent). Not a Mac, a missing binary, a non-zero
  exit, oversized or unparseable output are all `gpu: null`.

Two smaller judgements worth knowing:

- The GPU's name comes from `sppci_model`, **not** `_name` — `_name` is a
  localization key on real hardware (`kHW_IntelUHDGraphics630Item`), so it is
  only the last resort. VRAM is a human string ("1536 MB", "8 GB") under one
  of three keys, and is simply absent on Apple silicon, where the GPU shares
  system memory: `vram_bytes: null` there.
- `gpu.usage_pct` is **always `null`** today. Real utilisation on macOS needs
  privileged `powermetrics`; mesa reports nothing rather than a number it
  cannot stand behind.
- `disk_*` is the volume holding **mesa's own database** (`default_db_path()`),
  not the whole machine's storage — that is the one disk a mesa user can fill.
  The `sysinfo::Disks` entry chosen is the mount point that is the **longest**
  prefix of that path, since `/` is a prefix of everything.
- `load_average` is `None` on Windows, which has no such idea; `sysinfo`
  answers three zeroes there, which would read as an idle machine.

## Route

`GET /api/system` → `SystemInfo`. Behind the **standard guard only** — no
`require_agent_access` — the posture `GET /api/version` and
`GET /api/git-status` already take for a plain informational read: it names no
project, task or file, and a `--lan` page needs it for the same reason a local
one does. The global Host allowlist and Content-Type gate still apply.

Always `200`. There is no error path, no cache in `AppState` (the GPU's cache
is inside `core::system`), and nothing is written anywhere.

## CLI

`mesa system` prints the same object, byte-comparable with the route's body.
It is a **flat leaf with no `--quiet`** — there is no unbounded free-text
field to drop, so clap rejects the flag as an unknown argument, exit 2 (the
`backup`/`turns` contract).

## Frontend

`getSystemInfo()` (`frontend/src/api.ts`) feeds a **read-only** `SystemSection`
at the bottom of `#/settings`, polled at 3 s through the shared `useFetch`
hook (which drops an unchanged poll and pauses on a hidden tab). Read-only is
the point: unlike every other section on that page it has no draft, no `PUT`
and no save button, because the machine is not a setting. It is on Settings
because that page is already about *this installation* rather than a project.

The arithmetic lives in `frontend/src/systemMeter.ts` (`usedPct`, `clampPct`,
`systemSeverity`, `formatBytes`, `formatUptime`) with `systemMeter.test.ts`
covering it, per CLAUDE.md's rule that logic worth testing belongs in a pure
module rather than inline in a `.tsx`. The severity bands are `usageMeter.ts`'s
own — warn from 70 %, crit from 90 % — so a meter never means one thing here
and another on the CC dashboard.

## No end-to-end check script

Deliberately none. A single ungated read with a CLI mirror and no store
writes is exactly what `version` and `git-status` already do without one; the
Rust tests in `src/core/system.rs` and `src/api.rs` cover the contract.
