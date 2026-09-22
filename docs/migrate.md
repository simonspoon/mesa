# Moving to a new computer (mesa task 1206)

`mesa migrate` carries everything mesa-related from one machine to another in
one archive: the Naru database, `~/.mesa/config.json`, and the parts of the
Claude Code home directory (`~/.claude`) a person built by hand — agents,
hooks, skills, commands, the global `CLAUDE.md`, settings and the
per-project memories. It is **CLI only**: there is no HTTP route, because it
reads and writes the home directory, which `serve --lan` must never offer
the network. Logic in `src/core/migrate.rs`, the CLI layer in `src/cli.rs`
(`run_migrate`), the gate `scripts/migrate-check.sh`.

```bash
mesa migrate check                          # dry run on this machine
mesa migrate export ~/move.tar.gz           # old machine
mesa migrate import ~/move.tar.gz           # new machine
```

Everything keys off `$HOME` (`~/.mesa/config.json`, `~/.claude/...`) and the
db is `MESA_DB` if set, else the default path — so a throwaway `HOME` and
`MESA_DB` isolate every command completely, which is how the gate runs.

## What is bundled

| Item | Notes |
| --- | --- |
| `mesa.db` | A `VACUUM INTO` snapshot (`Store::backup`, the path `mesa backup` uses) — safe while `serve` runs |
| `.mesa/config.json` | |
| `.claude/CLAUDE.md`, `settings.json`, `settings.local.json`, `keybindings.json`, `statusline-command.sh` | |
| `.claude/agents/`, `hooks/`, `commands/`, `skills/`, `output-styles/` | whole trees; symlinks archived as symlinks |
| `.claude/plugins/installed_plugins.json`, `known_marketplaces.json` | the lists only — plugin caches are re-downloaded |
| `.claude/projects/*/memory/` | per-project memories only |
| `.claude/projects/` (all) + `.claude/history.jsonl` | only with `--with-sessions` — session transcripts are most of the size |

A missing item is skipped and listed under `skipped` in export's output,
never an error. Binaries (`mesa`, `qorvex`, `khora`, `loki`) and project
repos are **not** bundled: they are built and cloned on the new machine.

The archive is a tar.gz written and read by the system `tar` (argv, never a
shell string; no new crate): `manifest.json`, `mesa.db`, and every file at its
path relative to `$HOME`. The manifest records `format_version` (1),
`created_at`, `mesa_version`, `source_home`, `username`, `repo_root`,
`projects` (`id`, `name`, `local_path`), `files` and `with_sessions`. An
archive naming any other `format_version` is refused (`validation`). Export
refuses an archive path that already exists (`conflict`); a failing `tar` is
`unavailable`.

`repo_root` is the longest common ancestor directory (component-wise) of every
project's `local_path` — `null` when no project has one or they share only
`/`.

## How paths are moved

Import builds a list of prefix **mappings**:

- the **home map**: `--home-map OLD=NEW`, defaulting to the manifest's
  `source_home` onto the current `$HOME` (both halves must be absolute; bad
  syntax is `validation`);
- with `--repo-root DIR`, the manifest's `repo_root` onto `DIR` (absolute;
  `validation` when the archive has no `repo_root`);
- without `--repo-root`, a **detected** repo root (below).

### Detecting a relocated repo root (mesa task 1210)

A move that keeps the username but puts the repos somewhere else
(`~/m/inaros/projects/...` → `~/m/projects/...`) has an identity home map, so
without `--repo-root` nothing would move. So when `--repo-root` is not given
and the manifest's `repo_root`, after the home map, does not exist here,
import looks for the repos by the `root_commit` each project in the db
snapshot already carries (older archives work too): it scans the new `$HOME`
for git repos — at most 6 levels deep, skipping dot-dirs, `node_modules`,
`target` and `Library`, never descending into a repo or following a symlink
— and computes each one's root commit the way `project create` does. Each
project under the old `repo_root` whose repo was found at a path ending with
its path relative to that root votes for the path minus that suffix; the
root most projects agree on is pushed as a mapping exactly as `--repo-root`
would be (so the text files, settings.json included, are rewritten through
it). A tie, or no vote, maps nothing. Then, per project, a `local_path` the
mappings still leave missing falls back to the one repo found with its root
commit (the suffix match if exactly one, else the only match). With
`--repo-root` there is no scan.

The **longest prefix wins**, so a repo root under the old home is moved by its
own mapping rather than the home's, and a replacement is never re-scanned (two
mappings cannot chain). A match must sit on a **path boundary** on both sides:
not preceded by a path character (so `/x/Users/old` is not `/Users/old`), and
followed by the end, `/`, or anything that cannot continue a file name — so
`/Users/sim` never matches inside `/Users/simon`, `/Users/sim_x` or
`/Users/sim.bak`, while a sentence's closing `.` still ends the path.

The mappings are applied to:

1. every project's `local_path`, through `Store::update_project` (no raw SQL);
2. the **text** of the restored `.mesa/config.json`, `.claude/settings*.json`,
   `CLAUDE.md`, `statusline-command.sh`, everything under `agents/`, `hooks/`,
   `commands/`, `skills/`, `output-styles/`, and `plugins/*.json` — files
   that are not UTF-8 are restored byte-identical; memories and transcripts
   are never rewritten;
3. the names of `~/.claude/projects/<encoded>` directories. Claude Code names
   each after the absolute path with **every character that is not an ASCII
   letter or digit replaced by `-`** (`/Users/me/.claude` →
   `-Users-me--claude`). That encoding is lossy, so the match is made on the
   encoded form: a name equal to the encoded `from`, or continuing with `-`,
   is renamed to the encoded `to` plus the rest; a name continuing with
   anything else is left alone.

   **The encoding cannot tell `-` from `/`.** A sibling of the home whose name
   carries a literal hyphen — `/Users/sim-two` — encodes to `-Users-sim-two`,
   exactly what `/Users/sim/two` encodes to, so it reads as *under*
   `/Users/sim` and is renamed along with the home
   (`-Users-new-two`). Naru cannot know which it was; nothing short of Claude
   Code's own records could tell them apart, so this is documented rather
   than guessed at. Such a dir is rare (a path outside your home), and a
   rename it did not need is visible in import's `renamed` list.

File mode bits are preserved (hooks stay executable); a symlink's target is
rewritten like any other path.

## Refusal

The database is prepared **before** anything is written: the snapshot is
opened in the scratch dir (migrating an older schema), proved with `PRAGMA
quick_check` (`Store::quick_check`), and has its `local_path`s moved there.
A snapshot that fails any of that is `validation` — even under `--force` —
with the existing db untouched. Only then is it copied to a temp file beside
the target and renamed into place (the old `-wal`/`-shm` removed right after,
so they are never replayed onto it). Empty directories in the archive (an
empty memory dir) are recreated, renamed like any other path.

Import plans every write before making any. Two archive entries landing on
one target — two encoded dirs renamed onto the same name — are `conflict`
naming both, and `--force` does not override it, since either write would
silently lose the other. If the target db exists, or any
file it would restore already exists with **different** content, it refuses
with `conflict` (exit 1) listing every such path and writes nothing. A file
already holding exactly the restored content counts as `unchanged` and is no
conflict. `--force` overwrites: the db (and its `-wal`/`-shm`) is replaced and
differing files are rewritten.

## Output

- `check`: `{home, db, items[{path, present, bytes, files}], hardcoded[{file,
  line, match}], projects, repo_root}` — `hardcoded` is every absolute path
  under `$HOME` in the files import would rewrite. Read-only: it opens the db
  only when one exists.
- `export`: `{archive, bytes, files, file_bytes, projects, repo_root,
  with_sessions, skipped}`.
- `import`: `{archive, source_home, home, db, mappings, restored, unchanged,
  overwritten, projects[{id, name, from, to}], rewritten, renamed[{from, to}],
  repo_root, unresolved, todo}` — `todo` is the hand checklist: clone each
  project to its mapped `local_path`, install the mesa/qorvex/khora/loki
  binaries, re-authenticate Claude Code, re-enable plugins. `repo_root` is how
  the repo root was moved — `{from, to, source}` with `source` `"flag"` or
  `"detected"`, or `null`. `unresolved` lists what still points nowhere on
  this machine: `{kind: "project", id, name, path}` for each project whose
  final `local_path` does not exist, and `{kind: "file", file, path}` for each
  absolute path in a restored `settings.json`/`settings.local.json` string
  value — a whitespace/quote-delimited token starting with `/`, `~/` or
  `$HOME/` (the latter two expanded onto the new home), at least two
  components — that does not exist.

None of the three accepts `--quiet` (exit 2).
