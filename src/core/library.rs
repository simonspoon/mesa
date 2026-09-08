//! The library's built-ins, disk layout and sync decision table (mesa task
//! 919), plus the portable import/export bundle (mesa task 963).
//!
//! A library row is an agent definition, a skill, a hook script, a slash
//! command, the live-conversation prompt, or a CLAUDE.md — stored in
//! `library_items` (`Store`) and, for every kind but `prompt`, mirrored onto a
//! file under `.claude/` (or a repo's root `CLAUDE.md`). This module holds
//! everything that does not touch the database: the built-in catalogue
//! (`BUILTINS`), the pure mapping from a row to its path (`relative_path`),
//! the traversal chokepoint that keeps a resolved path under its scope base
//! (`resolve`, the `files.rs::safe_path()` line held a second time), the sync
//! decision table (`classify`), and the disk-side scan a sync compares
//! against (`scan_disk`) — and, alongside those, [`export`]/[`import`], which
//! turn a library's contents into a portable [`crate::core::types::LibraryBundle`]
//! and back, for moving them to another mesa instance.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::core::store::{Error, LibraryPatch, Result as StoreResult, Store};
use crate::core::types::{
    LibraryBundle, LibraryBundleItem, LibraryDiffKind, LibraryDiffLine, LibraryHookRegistration,
    LibraryHookStatus, LibraryImportResult, LibraryItem, LibraryKind, LibraryScope,
    LibrarySyncResult, LibrarySyncRow, LibrarySyncStatus,
};

/// One built-in library entry — code, not a db row. `core::library::BUILTINS`
/// is reported by `list` as `id: null, builtin: true` until a user edits it,
/// at which point the edit *forks* it into a real row carrying `builtin_id`
/// (`Store::create_library_item`); mesa never updates a fork, so an upgrade
/// to a built-in's body only ever reaches the unshadowed ones.
pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: LibraryKind,
    pub scope: LibraryScope,
    pub body: &'static str,
}

/// The starter set — deliberately tiny. `mesa-live` is the agent definition
/// the live conversation runs as (mesa task 1068, replacing the old
/// `live-agent-prompt` *prompt*): its body is `core::live::AGENT_DEFINITION`,
/// frontmatter plus the loop `core::live::AGENT_PROMPT` states, and because it
/// is an [`LibraryKind::Agent`] it has a real path — `.claude/agents/mesa-live.md`
/// — so the sync flow carries it like any other agent definition, and
/// `core::live::ensure_agent_definition` seeds it there on the first spawn.
/// `supervisor` is the same shape one step up (mesa task 1075): the agent
/// definition an `/execute-todo` run is *supervised* as, body
/// `core::supervisor::SUPERVISOR_DEFINITION`, at
/// `.claude/agents/supervisor.md`, seeded by
/// `core::supervisor::ensure_agent_definition` on the first dispatch.
/// `live-summary-prompt` is still a `prompt` (mesa task 921): the instructions
/// for the short-lived agent that writes a live conversation's memory once it
/// ends, body `core::live::SUMMARY_PROMPT`, spawned as a plain prompt rather
/// than by name.
pub const BUILTINS: &[Builtin] = &[
    Builtin {
        id: crate::core::live::LIVE_AGENT_BUILTIN,
        name: crate::core::live::LIVE_AGENT_BUILTIN,
        kind: LibraryKind::Agent,
        scope: LibraryScope::User,
        body: crate::core::live::AGENT_DEFINITION,
    },
    Builtin {
        id: crate::core::supervisor::SUPERVISOR_AGENT_BUILTIN,
        name: crate::core::supervisor::SUPERVISOR_AGENT_BUILTIN,
        kind: LibraryKind::Agent,
        scope: LibraryScope::User,
        body: crate::core::supervisor::SUPERVISOR_DEFINITION,
    },
    Builtin {
        id: "live-summary-prompt",
        name: "live-summary-prompt",
        kind: LibraryKind::Prompt,
        scope: LibraryScope::User,
        body: crate::core::live::SUMMARY_PROMPT,
    },
    Builtin {
        id: "starter-claude-md",
        name: "starter-claude-md",
        kind: LibraryKind::ClaudeMd,
        scope: LibraryScope::User,
        body: "\
# CLAUDE.md

Project-specific instructions for Claude Code go here. This file is read at \
the start of every session in this repo — keep it short and say only what a \
new contributor (human or agent) would not otherwise know: how to build and \
test, invariants the code does not enforce itself, and conventions worth \
following on purpose.
",
    },
    Builtin {
        id: "stop-notify",
        name: "stop-notify.sh",
        kind: LibraryKind::Hook,
        scope: LibraryScope::User,
        body: "\
#!/bin/sh
# Runs when Claude Code stops responding. Replace with a real notifier
# (terminal-notifier, osascript, a curl to your own webhook, ...).
echo \"Claude Code stopped in $(pwd)\"
",
    },
];

/// Looks up one built-in by id.
pub fn builtin(id: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|b| b.id == id)
}

/// Where a `(kind, scope, name)` lives on disk, relative to that scope's
/// base (the home dir for `user`, a project's `local_path` for `project`).
/// `Prompt` has no path — the live-conversation prompt is mesa-internal, not
/// a file Claude Code reads, which is the whole reason `prompt` and `command`
/// are separate kinds.
///
/// A [`LibraryKind::Hook`] appends nothing: a hook is any script the user
/// cares to drop in — `.sh`, `.py`, or no extension at all — so its *name*
/// carries the whole filename and the extension travels with the item
/// (mesa task 1114). Every other kind owns its extension.
pub fn relative_path(kind: LibraryKind, scope: LibraryScope, name: &str) -> Option<PathBuf> {
    match kind {
        LibraryKind::Agent => Some(PathBuf::from(format!(".claude/agents/{name}.md"))),
        LibraryKind::Skill => Some(PathBuf::from(format!(".claude/skills/{name}/SKILL.md"))),
        LibraryKind::Hook => Some(PathBuf::from(format!(".claude/hooks/{name}"))),
        LibraryKind::Command => Some(PathBuf::from(format!(".claude/commands/{name}.md"))),
        LibraryKind::ClaudeMd => Some(match scope {
            LibraryScope::User => PathBuf::from(".claude/CLAUDE.md"),
            LibraryScope::Project => PathBuf::from("CLAUDE.md"),
        }),
        LibraryKind::Prompt => None,
    }
}

/// The directory a scope's paths are resolved against: `$HOME` for `user`,
/// the project's `local_path` for `project` (absent when the project has none
/// recorded — `Store` learns it the same way the Agents/Files surfaces do).
pub fn scope_base(scope: LibraryScope, project_local_path: Option<&Path>) -> Option<PathBuf> {
    match scope {
        LibraryScope::User => std::env::var("HOME").ok().map(PathBuf::from),
        LibraryScope::Project => project_local_path.map(Path::to_path_buf),
    }
}

/// Joins `rel` onto `base` and asserts the result stays under it —
/// `files.rs::safe_path()`'s line, held a second time here because a library
/// row writes an agent definition, a hook script or a CLAUDE.md onto disk,
/// which is code execution just as a Files-tab write is. `rel` is always
/// built from a `Store`-validated name (never `/`, `\`, or `..`), so this is
/// belt-and-braces rather than the only guard — but it is the one that
/// actually stops a write leaving `base`.
///
/// Canonicalising a target that does not exist yet fails outright, so this
/// walks up to the deepest existing ancestor, canonicalises *that*, and
/// rejoins the remainder — the same trick a create-file path needs.
pub fn resolve(base: &Path, rel: &Path) -> Result<PathBuf, String> {
    use std::path::Component;

    let base_canon =
        fs::canonicalize(base).map_err(|e| format!("cannot resolve {}: {e}", base.display()))?;

    // Normalize `rel` onto `base_canon`'s components *lexically*, before ever
    // touching the filesystem: a `Component::ParentDir` pops the stack, and
    // popping past `base_canon` itself is refused outright. This is the part
    // the naive "canonicalize the deepest existing ancestor" approach gets
    // wrong — `Path::file_name()` returns `None` for a trailing `..`
    // component, so a walk that only reads `file_name()` silently drops a
    // `../../..` instead of climbing past `base`, which is exactly the
    // traversal this function exists to catch.
    let mut components: Vec<Component> = base_canon.components().collect();
    let base_depth = components.len();
    for component in rel.components() {
        match component {
            Component::Normal(part) => components.push(Component::Normal(part)),
            Component::CurDir => {}
            Component::ParentDir => {
                if components.len() <= base_depth {
                    return Err(format!(
                        "{} escapes {}",
                        rel.display(),
                        base_canon.display()
                    ));
                }
                components.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("{} must be a relative path", rel.display()));
            }
        }
    }
    let candidate: PathBuf = components.iter().collect();

    // Canonicalise whatever prefix of `candidate` already exists — closing
    // the symlink-escape hole the same way `files.rs::safe_path()` does —
    // then confirm the canonical result still starts with `base_canon`.
    let mut existing = candidate.as_path();
    let mut missing_tail: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            break;
        };
        missing_tail.push(name);
        let Some(parent) = existing.parent() else {
            break;
        };
        existing = parent;
    }
    let existing_canon = fs::canonicalize(existing)
        .map_err(|e| format!("cannot resolve {}: {e}", existing.display()))?;
    let mut resolved = existing_canon;
    for name in missing_tail.into_iter().rev() {
        resolved.push(name);
    }

    if resolved == base_canon || resolved.starts_with(&base_canon) {
        Ok(resolved)
    } else {
        Err(format!(
            "{} escapes {}",
            resolved.display(),
            base_canon.display()
        ))
    }
}

/// Writes a built-in **agent definition** to its user-scope path if it is not
/// there already, and answers where it went. Both named-agent features seed
/// their definition this way before spawning — `mesa-live`
/// ([`crate::core::live::ensure_agent_definition`]) and `supervisor`
/// ([`crate::core::supervisor::ensure_agent_definition`]) — because
/// `claude --agent <name>` errors on an agent Claude Code has never seen and
/// nothing else puts the file there: the library sync is a thing the user
/// runs, not something a spawn may depend on.
///
/// The body is the effective row for `builtin_id`: its library fork if one
/// exists, `fallback` otherwise. The target goes through this module's own
/// path machinery ([`relative_path`], [`scope_base`] and the [`resolve`]
/// traversal chokepoint), so `$HOME` is honoured and the containment check
/// holds here exactly as it does on the sync path.
///
/// It **never overwrites**. After the first seed the file belongs to the sync
/// flow, where a difference between disk and mesa is a row the user resolves —
/// silently rewriting it on every spawn would make one side of that decision
/// impossible to keep.
pub fn ensure_agent_file(
    store: &Store,
    builtin_id: &str,
    fallback: &str,
) -> Result<PathBuf, String> {
    let body = store
        .find_library_fork(builtin_id)
        .ok()
        .flatten()
        .map(|item| item.body)
        .unwrap_or_else(|| fallback.to_string());
    let rel = relative_path(LibraryKind::Agent, LibraryScope::User, builtin_id)
        .ok_or_else(|| format!("{builtin_id} has no path"))?;
    let base = scope_base(LibraryScope::User, None)
        .ok_or_else(|| format!("cannot seed the {builtin_id} agent definition: no HOME"))?;
    let full = resolve(&base, &rel)?;
    if full.exists() {
        return Ok(full);
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&full, body).map_err(|e| format!("cannot write {}: {e}", full.display()))?;
    Ok(full)
}

/// The sync decision table (`docs` in the design), a total function over the
/// mesa body (M), the file on disk (D, `None` when no file exists) and the
/// last-agreed baseline (B, `None` before the first sync).
pub fn classify(mesa: &str, disk: Option<&str>, baseline: Option<&str>) -> LibrarySyncStatus {
    match (disk, baseline) {
        (Some(d), _) if d == mesa => LibrarySyncStatus::InSync,
        (None, None) => LibrarySyncStatus::MesaNew,
        (None, Some(b)) if b == mesa => LibrarySyncStatus::DiskDeleted,
        (Some(_), None) => LibrarySyncStatus::BothChanged,
        (Some(d), Some(b)) => {
            let mesa_moved = mesa != b;
            let disk_moved = d != b;
            match (mesa_moved, disk_moved) {
                (true, false) => LibrarySyncStatus::MesaChanged,
                (false, true) => LibrarySyncStatus::DiskChanged,
                // (false, false) is unreachable here: b == d would have hit
                // the `d == mesa` arm above, since mesa == b in that case.
                _ => LibrarySyncStatus::BothChanged,
            }
        }
        (None, Some(_)) => LibrarySyncStatus::BothChanged,
    }
}

/// A file over this size is skipped by [`scan_disk`] — the same "don't read
/// the whole world" bound `Store::create_library_item` enforces on a body.
const SCAN_MAX_BYTES: u64 = 1024 * 1024;

/// Walks `<base>/.claude/{agents,skills,commands,hooks}` and both possible
/// CLAUDE.md locations (`.claude/CLAUDE.md`, the `user`-scope convention, and
/// `CLAUDE.md` at `base`'s root, the `project`-scope one —
/// [`relative_path`]'s two answers for [`LibraryKind::ClaudeMd`]), returning
/// `(kind, name, body, mtime)` for every file found — the mtime read off the
/// same metadata the body was, so a `disk-new` row reports its date without a
/// second stat. The caller already knows which
/// scope `base` is for and so which of the two CLAUDE.md hits is the real
/// one; scanning both costs nothing since at most one is ever present in
/// practice. Bounded on purpose: it skips anything over [`SCAN_MAX_BYTES`],
/// skips non-UTF-8 files, and does not recurse arbitrarily — agents and
/// commands are one level of `.md` files, hooks one level of files of *any*
/// extension (each named after its whole filename), skills is exactly
/// one level of `<name>/SKILL.md`.
///
/// Every directory this walks — `.claude` itself, each leaf under it, and
/// `.claude/skills` — is resolved through [`resolve`] before it is ever
/// handed to `fs::read_dir`, the same containment check the write path uses.
/// That is deliberate: `fs::read_dir`/`fs::metadata` follow a symlinked
/// *directory* transparently (only `DirEntry::file_type()` and
/// `symlink_metadata`, used below for entries and leaf files, refuse a
/// symlinked *entry*), so a `.claude/agents` — or a bare `.claude` — that is
/// itself a symlink out of `base` would otherwise be walked straight through
/// it, and whatever it points at would come back as ordinary `disk-new`
/// rows. Routing every directory through `resolve` closes that: a symlinked
/// directory canonicalizes to somewhere outside `base_canon`, `resolve`
/// refuses it, and the scan silently skips it exactly as it already does for
/// a directory that does not exist.
pub fn scan_disk(base: &Path) -> Vec<(LibraryKind, String, String, Option<String>)> {
    let mut found = Vec::new();

    let safe_dir = |rel: &str| -> Option<PathBuf> { resolve(base, Path::new(rel)).ok() };

    // `ext` is `Some` for the kinds whose file mesa names itself — agents and
    // commands are `.md`, and the item is named after the stem — and `None`
    // for hooks, which are whatever script the user dropped in, named after
    // the whole filename so the extension travels with the item
    // (mesa task 1114).
    let leaf_dir = |sub: &str, kind: LibraryKind, ext: Option<&str>, found: &mut Vec<_>| {
        let Some(dir) = safe_dir(&format!(".claude/{sub}")) else {
            return;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let name = match ext {
                Some(ext) => {
                    if path.extension().and_then(|e| e.to_str()) != Some(ext) {
                        continue;
                    }
                    path.file_stem().and_then(|s| s.to_str())
                }
                // A file mesa cannot *name* is one it could not round-trip
                // back onto disk, so it is skipped silently rather than
                // failing the scan — which also drops the dotfiles an editor
                // and the OS leave behind, since the charset rule requires an
                // alphanumeric first character.
                None => path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .filter(|n| crate::core::store::library_name_is_valid(n)),
            };
            let Some(name) = name else {
                continue;
            };
            if let Some((body, mtime)) = read_bounded_with_mtime(&path) {
                found.push((kind, name.to_string(), body, mtime));
            }
        }
    };

    leaf_dir("agents", LibraryKind::Agent, Some("md"), &mut found);
    leaf_dir("commands", LibraryKind::Command, Some("md"), &mut found);
    leaf_dir("hooks", LibraryKind::Hook, None, &mut found);

    if let Some(skills_dir) = safe_dir(".claude/skills")
        && let Ok(entries) = fs::read_dir(&skills_dir)
    {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            if let Some((body, mtime)) = read_bounded_with_mtime(&skill_md) {
                found.push((LibraryKind::Skill, name, body, mtime));
            }
        }
    }

    // CLAUDE.md's "name" is fixed — there is exactly one per scope, matching
    // `Builtin::name` for `starter-claude-md`.
    for rel in [".claude/CLAUDE.md", "CLAUDE.md"] {
        let Some(path) = safe_dir(rel) else {
            continue;
        };
        if let Some((body, mtime)) = read_bounded_with_mtime(&path) {
            found.push((LibraryKind::ClaudeMd, "CLAUDE".to_string(), body, mtime));
        }
    }

    found
}

/// Reads a file's contents and its mtime, refusing anything over
/// [`SCAN_MAX_BYTES`], a symlink, or non-UTF-8 bytes rather than failing the
/// whole scan. The mtime comes off the metadata this call already reads, so
/// no caller stats the file twice, and it is its own `Option`: a filesystem
/// that does not report one costs the caller a date, never the body.
fn read_bounded_with_mtime(path: &Path) -> Option<(String, Option<String>)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    if meta.len() > SCAN_MAX_BYTES {
        return None;
    }
    let mtime = meta.modified().ok().and_then(utc_text);
    Some((fs::read_to_string(path).ok()?, mtime))
}

/// A [`SystemTime`] in the same UTC text every mesa timestamp uses. A time
/// before the epoch (a clock nobody should have) is `None` rather than a
/// wrong date.
fn utc_text(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(crate::core::cc::fmt_store_ts(secs as i64))
}

/// Every item the library offers: the db rows (`Store::list_library_items`),
/// plus each [`BUILTINS`] entry not shadowed by a db row carrying its
/// `builtin_id`. Ordering is stable and deterministic — by `kind`, then
/// `name` case-insensitively — because both the CLI's `library list` and the
/// UI's grouped page read this order directly.
pub fn effective_items(store: &Store, project: Option<i64>) -> StoreResult<Vec<LibraryItem>> {
    let mut items = store.list_library_items(project)?;
    let shadowed: HashSet<String> = items.iter().filter_map(|i| i.builtin_id.clone()).collect();
    for b in BUILTINS {
        if shadowed.contains(b.id) {
            continue;
        }
        let path = relative_path(b.kind, b.scope, b.name).map(|p| p.to_string_lossy().into_owned());
        items.push(LibraryItem {
            id: None,
            name: b.name.to_string(),
            kind: b.kind,
            scope: b.scope,
            project_id: None,
            body: b.body.to_string(),
            builtin_id: Some(b.id.to_string()),
            builtin: true,
            path,
            synced_body: None,
            synced_at: None,
            created_at: None,
            updated_at: None,
        });
    }
    items.sort_by(|a, b| {
        a.kind
            .as_str()
            .cmp(b.kind.as_str())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

/// A file over this size, when read for a sync comparison, is treated as
/// absent — the same bound [`scan_disk`] applies when it walks a directory.
fn read_sync_side(path: &Path) -> Option<(String, Option<String>)> {
    read_bounded_with_mtime(path)
}

/// Resolves the scope base for a given scope/project, returning `None` when
/// there is nothing usable to sync against (a `project` scope with no
/// `local_path`, or a `local_path`/home that does not exist on disk).
fn usable_base(scope: LibraryScope, project_local_path: Option<&Path>) -> Option<PathBuf> {
    let base = scope_base(scope, project_local_path)?;
    if base.is_dir() { Some(base) } else { None }
}

/// One row per path, on both sides, classified against
/// [`classify`] — the disk-side counterpart of `effective_items`.
pub fn sync_status(store: &Store, project: Option<i64>) -> StoreResult<Vec<LibrarySyncRow>> {
    let items = effective_items(store, project)?;
    let project_local_path = match project {
        Some(id) => store.get_project(id)?.local_path,
        None => None,
    };
    let project_local_path = project_local_path.map(PathBuf::from);

    // One query for the whole scan rather than one per row: mesa's own
    // last-changed date is the newest version's `created_at`, because an
    // item's `updated_at` moves on a rename too.
    let version_dates = store.library_version_dates()?;

    let user_base = usable_base(LibraryScope::User, None);
    let project_base =
        project.and_then(|_| usable_base(LibraryScope::Project, project_local_path.as_deref()));

    let mut rows: Vec<LibrarySyncRow> = Vec::new();
    // Keyed by `(scope, path)` — the resolved *path* is the thing that is
    // actually unique per row, not `(kind, name)`. `claude-md`'s path does
    // not depend on its name at all (`.claude/CLAUDE.md` for `user`,
    // `CLAUDE.md` at the repo root for `project` — see `relative_path`), so a
    // name-keyed set could never recognise that an item already claims that
    // path and would let `scan_disk` synthesize a phantom `disk-new` row for
    // the same file a real item already reports. Two rows sharing one path
    // is exactly the bug that must be impossible: it lets a caller submit
    // two resolutions for the same file in one `sync_apply` batch.
    // Keyed on `.as_str()` rather than the enum itself: `LibraryScope`
    // doesn't derive `Hash` (it lives in `types.rs`, out of this module's
    // scope), and its wire string is just as unique a key.
    let mut claimed: HashSet<(&'static str, String)> = HashSet::new();

    // Two *items* can resolve to one path too, which `claimed` did not used to
    // catch (mesa task 1116): `effective_items` folds a built-in away only when
    // some db row carries its `builtin_id` — a fork — so a db row that merely
    // collides with a built-in on `(kind, scope, name)` leaves both in the
    // list, and `relative_path` gives them the same file. `claude-md` can do it
    // between two db rows as well, its path not depending on its name at all.
    // Whichever pair it is, the second row is unreachable: `sync_apply`
    // resolves a submitted path with the *first* row carrying it, so every
    // resolution lands on that one and the other re-appears, unchanged, on the
    // next scan forever. Rank decides which row survives — a stored row
    // outranks a virtual built-in, since the db row is the one a user edited —
    // so the two ranks are walked in order rather than trusting whatever order
    // `effective_items` happened to sort them into.
    let (stored, builtins): (Vec<&LibraryItem>, Vec<&LibraryItem>) =
        items.iter().partition(|i| i.id.is_some());

    for item in stored.into_iter().chain(builtins) {
        if item.kind == LibraryKind::Prompt {
            continue;
        }
        let Some(rel) = item.path.as_ref().map(PathBuf::from) else {
            continue;
        };
        if !claimed.insert((item.scope.as_str(), rel.to_string_lossy().into_owned())) {
            continue;
        }

        let base = match item.scope {
            LibraryScope::User => user_base.clone(),
            LibraryScope::Project => project_base.clone(),
        };
        let Some(base) = base else {
            continue;
        };
        let Ok(full) = resolve(&base, &rel) else {
            continue;
        };
        let (disk_body, disk_mtime) = match read_sync_side(&full) {
            Some((body, mtime)) => (Some(body), mtime),
            None => (None, None),
        };
        let baseline = item.synced_body.clone();
        let status = classify(&item.body, disk_body.as_deref(), baseline.as_deref());
        // Two-sided rows only: a one-sided row has nothing to diff against,
        // and an `in-sync` row's two sides are the same text.
        let diff = disk_body
            .as_deref()
            .filter(|d| *d != item.body)
            .map(|d| diff_lines(&item.body, d));
        let mesa_updated_at = item
            .id
            .and_then(|id| version_dates.get(&id).cloned())
            .or_else(|| item.updated_at.clone());
        rows.push(LibrarySyncRow {
            item_id: item.id,
            builtin_id: item.builtin_id.clone(),
            name: item.name.clone(),
            kind: item.kind,
            scope: item.scope,
            project_id: item.project_id,
            path: rel.to_string_lossy().into_owned(),
            status,
            mesa_body: Some(item.body.clone()),
            disk_body,
            baseline,
            disk_mtime,
            mesa_updated_at,
            diff,
        });
    }

    for (scope, base) in [
        (LibraryScope::User, user_base.clone()),
        (LibraryScope::Project, project_base.clone()),
    ] {
        let Some(base) = base else { continue };
        let mut seen: HashSet<String> = HashSet::new();
        for (kind, name, body, disk_mtime) in scan_disk(&base) {
            let Some(path) = relative_path(kind, scope, &name) else {
                continue;
            };
            let path_key = path.to_string_lossy().into_owned();
            // `scan_disk` itself can produce more than one hit for the same
            // path (its two CLAUDE.md candidates both land on `name ==
            // "CLAUDE"`, and only one is ever the real path for a given
            // scope), so this is a second, path-keyed dedup on top of the
            // claimed-by-an-item check below — not a duplicate of it.
            if !seen.insert(path_key.clone()) {
                continue;
            }
            if claimed.contains(&(scope.as_str(), path_key.clone())) {
                continue;
            }
            let project_id = match scope {
                LibraryScope::User => None,
                LibraryScope::Project => project,
            };
            rows.push(LibrarySyncRow {
                item_id: None,
                builtin_id: None,
                name,
                kind,
                scope,
                project_id,
                path: path_key,
                status: LibrarySyncStatus::DiskNew,
                mesa_body: None,
                disk_body: Some(body),
                baseline: None,
                disk_mtime,
                mesa_updated_at: None,
                diff: None,
            });
        }
    }

    rows.sort_by(|a, b| {
        a.kind
            .as_str()
            .cmp(b.kind.as_str())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(rows)
}

/// The most lines one sync row's diff carries. A body is already bounded by
/// [`SCAN_MAX_BYTES`], but a megabyte of one-character lines is still a
/// response nobody can read, so the diff stops here and says so.
pub const DIFF_MAX_LINES: usize = 2000;

/// The largest LCS table [`diff_lines`] will build. Two 4000-line bodies is
/// already past what the modal can show; beyond it the quadratic table costs
/// more than the answer is worth, and the diff degrades to a marker instead.
const DIFF_MAX_CELLS: usize = 16_000_000;

/// The line-level mesa-vs-disk diff one [`LibrarySyncRow`] carries: a
/// hand-rolled LCS over lines, no crate and no three-way merge attribution —
/// `baseline` rides on the row separately, and a resolution picks a *side*.
///
/// Both bodies are split with `str::lines`, so a trailing newline is not a
/// line of its own (it is not a difference a person resolves either). Line
/// numbers are 1-based and only ever set on the side a line exists in. The
/// result is bounded twice: a table over [`DIFF_MAX_CELLS`] is not built at
/// all, and a result past [`DIFF_MAX_LINES`] is cut. Both degrade to a
/// *marker* line — kind `Context`, both line numbers `None` — rather than an
/// error or an unbounded response.
pub fn diff_lines(mesa: &str, disk: &str) -> Vec<LibraryDiffLine> {
    let a: Vec<&str> = mesa.lines().collect();
    let b: Vec<&str> = disk.lines().collect();
    if (a.len() + 1).saturating_mul(b.len() + 1) > DIFF_MAX_CELLS {
        return vec![marker(format!(
            "… diff not computed: {} lines in mesa, {} on disk …",
            a.len(),
            b.len()
        ))];
    }

    // `lcs[i][j]` = the length of the longest common subsequence of `a[i..]`
    // and `b[j..]`, filled from the end so the walk below can read it
    // forwards. One flat row-major buffer, width `b.len() + 1`.
    let w = b.len() + 1;
    let mut lcs = vec![0u32; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i * w + j] = if a[i] == b[j] {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }

    let mut out: Vec<LibraryDiffLine> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            out.push(line(LibraryDiffKind::Context, Some(i), Some(j), a[i]));
            i += 1;
            j += 1;
        } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
            out.push(line(LibraryDiffKind::MesaOnly, Some(i), None, a[i]));
            i += 1;
        } else {
            out.push(line(LibraryDiffKind::DiskOnly, None, Some(j), b[j]));
            j += 1;
        }
    }
    while i < a.len() {
        out.push(line(LibraryDiffKind::MesaOnly, Some(i), None, a[i]));
        i += 1;
    }
    while j < b.len() {
        out.push(line(LibraryDiffKind::DiskOnly, None, Some(j), b[j]));
        j += 1;
    }

    if out.len() > DIFF_MAX_LINES {
        let dropped = out.len() - DIFF_MAX_LINES;
        out.truncate(DIFF_MAX_LINES);
        out.push(marker(format!("… {dropped} more diff lines not shown …")));
    }
    out
}

/// One diff line, taking the 0-based indices the walk holds and reporting the
/// 1-based numbers the row carries.
fn line(
    kind: LibraryDiffKind,
    mesa: Option<usize>,
    disk: Option<usize>,
    text: &str,
) -> LibraryDiffLine {
    LibraryDiffLine {
        kind,
        mesa_line: mesa.map(|i| i as u32 + 1),
        disk_line: disk.map(|j| j as u32 + 1),
        text: text.to_string(),
    }
}

/// A line that is not content from either side — how [`diff_lines`] reports
/// that it stopped rather than silently answering short.
fn marker(text: String) -> LibraryDiffLine {
    LibraryDiffLine {
        kind: LibraryDiffKind::Context,
        mesa_line: None,
        disk_line: None,
        text,
    }
}

/// Applies the caller's per-path choices from a `sync_status` scan.
/// `choice` is `"mesa" | "disk" | "skip"`. Per-row isolation: a failing row
/// is reported in its own result and the rest still apply — never an
/// all-or-nothing batch.
pub fn sync_apply(
    store: &mut Store,
    project: Option<i64>,
    resolutions: &[(String, String)],
) -> StoreResult<Vec<LibrarySyncResult>> {
    let status = sync_status(store, project)?;
    let mut results = Vec::with_capacity(resolutions.len());
    // `status` is a snapshot taken once, up front — applying a second
    // resolution for a path already handled in this same batch would run
    // against that stale snapshot rather than what the first resolution just
    // wrote, silently reverting it (a last-write-loses-to-a-stale-read bug,
    // not even a clean last-write-wins). Refuse a repeat outright instead:
    // deterministic (first occurrence wins) and reported (every later one
    // comes back as its own failed result), rather than a second write no
    // caller asked for.
    let mut seen_paths: HashSet<&str> = HashSet::new();
    for (path, choice) in resolutions {
        if !seen_paths.insert(path.as_str()) {
            results.push(LibrarySyncResult {
                path: path.clone(),
                choice: choice.clone(),
                applied: false,
                error: Some(format!(
                    "{path:?} was submitted more than once in this batch; only the first \
                     resolution for a path is applied"
                )),
            });
            continue;
        }
        let Some(row) = status.iter().find(|r| &r.path == path) else {
            results.push(LibrarySyncResult {
                path: path.clone(),
                choice: choice.clone(),
                applied: false,
                error: Some(format!("{path:?} is not part of the current sync status")),
            });
            continue;
        };
        match choice.as_str() {
            "skip" => results.push(LibrarySyncResult {
                path: path.clone(),
                choice: choice.clone(),
                applied: false,
                error: None,
            }),
            "mesa" => match apply_mesa(store, project, row) {
                Ok(()) => results.push(LibrarySyncResult {
                    path: path.clone(),
                    choice: choice.clone(),
                    applied: true,
                    error: None,
                }),
                Err(e) => results.push(LibrarySyncResult {
                    path: path.clone(),
                    choice: choice.clone(),
                    applied: false,
                    error: Some(e.to_string()),
                }),
            },
            "disk" => match apply_disk(store, row) {
                Ok(()) => results.push(LibrarySyncResult {
                    path: path.clone(),
                    choice: choice.clone(),
                    applied: true,
                    error: None,
                }),
                Err(e) => results.push(LibrarySyncResult {
                    path: path.clone(),
                    choice: choice.clone(),
                    applied: false,
                    error: Some(e.to_string()),
                }),
            },
            other => results.push(LibrarySyncResult {
                path: path.clone(),
                choice: choice.clone(),
                applied: false,
                error: Some(format!("{other:?} is not a valid sync choice")),
            }),
        }
    }
    Ok(results)
}

/// `mesa` wins: write the mesa body to disk, creating parent directories, and
/// stamp the baseline. A built-in (no db row) is re-derivable, so it is
/// written to disk with no baseline stamp.
fn apply_mesa(store: &mut Store, project: Option<i64>, row: &LibrarySyncRow) -> StoreResult<()> {
    let body = row
        .mesa_body
        .as_ref()
        .ok_or_else(|| Error::Validation(format!("{} has no mesa body to write", row.path)))?;
    let project_local_path = match project {
        Some(id) => store.get_project(id)?.local_path,
        None => None,
    };
    let project_local_path = project_local_path.map(PathBuf::from);
    let base = scope_base(row.scope, project_local_path.as_deref()).ok_or_else(|| {
        Error::Validation(format!("{} has no usable base to write into", row.path))
    })?;
    let full = resolve(&base, Path::new(&row.path)).map_err(Error::Validation)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&full, body)?;
    if let Some(id) = row.item_id {
        store.set_library_synced(id, body)?;
    }
    Ok(())
}

/// `disk` wins: pull the disk body into mesa, or destroy the row on a
/// `disk-deleted` row. A built-in has no row to stamp — pulling into one
/// forks it first (`Store::create_library_item` carrying `builtin_id`),
/// exactly as editing a built-in in mesa does.
fn apply_disk(store: &mut Store, row: &LibrarySyncRow) -> StoreResult<()> {
    match row.status {
        LibrarySyncStatus::DiskDeleted => match row.item_id {
            Some(id) => {
                store.delete_library_item(id)?;
                Ok(())
            }
            None => Err(Error::Validation(format!(
                "{} is a built-in and cannot be deleted",
                row.path
            ))),
        },
        LibrarySyncStatus::DiskNew => {
            let body = row.disk_body.as_ref().ok_or_else(|| {
                Error::Validation(format!("{} has no disk body to adopt", row.path))
            })?;
            let created = store.create_library_item(
                row.kind,
                row.scope,
                row.project_id,
                &row.name,
                body,
                None,
            )?;
            let id = created.id.expect("a created item always has an id");
            store.set_library_synced(id, body)?;
            Ok(())
        }
        _ => {
            let body = row.disk_body.as_ref().ok_or_else(|| {
                Error::Validation(format!("{} has no disk body to pull", row.path))
            })?;
            let id = match row.item_id {
                Some(id) => id,
                None => {
                    let builtin_id = row.builtin_id.as_deref().ok_or_else(|| {
                        Error::Validation(format!("{} has no item to pull into", row.path))
                    })?;
                    let created = store.create_library_item(
                        row.kind,
                        row.scope,
                        row.project_id,
                        &row.name,
                        body,
                        Some(builtin_id),
                    )?;
                    created.id.expect("a created item always has an id")
                }
            };
            store.pull_library_body(id, body)?;
            Ok(())
        }
    }
}

/// `LibraryBundle::version` this build understands. A bundle carrying any
/// other value is refused whole by [`import`] before anything is written —
/// the one all-or-nothing check the format makes.
pub const BUNDLE_VERSION: u32 = 1;

/// Snapshots a library's contents into a portable [`LibraryBundle`]
/// (`Store::list_library_items` — db rows only). An unshadowed built-in is
/// never included: it is code, not a row, and identical on the receiving
/// instance by construction, so exporting it would be noise that imports as
/// a pointless fork. A *forked* built-in IS included, carrying its
/// `builtin_id` so it lands as a fork on the far side too. Scope follows the
/// same visibility rule `list` uses: no project -> `user`-scope rows only;
/// with a project -> that project's rows plus every `user`-scope row.
pub fn export(store: &Store, project: Option<i64>) -> StoreResult<LibraryBundle> {
    let rows = store.list_library_items(project)?;
    // Every `project`-scope row `list_library_items` returns is bound to
    // exactly this one project (its own WHERE clause guarantees it), so its
    // name is resolved once rather than per row.
    let project_name = match project {
        Some(id) => Some(store.get_project(id)?.name),
        None => None,
    };
    let items = rows
        .into_iter()
        .map(|item| LibraryBundleItem {
            name: item.name,
            kind: item.kind,
            scope: item.scope,
            project: match item.scope {
                LibraryScope::Project => project_name.clone(),
                LibraryScope::User => None,
            },
            body: item.body,
            builtin_id: item.builtin_id,
        })
        .collect();
    Ok(LibraryBundle {
        version: BUNDLE_VERSION,
        exported_at: store.now()?,
        items,
    })
}

/// Applies a [`LibraryBundle`] against this instance. `on_conflict` is
/// `"skip"` (leave an existing row untouched) or `"replace"` (update its
/// body); any other value is a caller mistake, not a per-item outcome, so it
/// fails the whole call (`Error::Validation`). A bundle whose `version` this
/// mesa does not know is likewise refused whole, before a single item is
/// touched. Every other failure is per item: a bad project name or a
/// `Store` rejection (the name rule, the body cap, ...) fails only that
/// item and the rest of the batch still applies — the same posture
/// `sync_apply` already takes toward its own batch.
pub fn import(
    store: &mut Store,
    bundle: &LibraryBundle,
    on_conflict: &str,
) -> StoreResult<Vec<LibraryImportResult>> {
    if on_conflict != "skip" && on_conflict != "replace" {
        return Err(Error::Validation(format!(
            "{on_conflict:?} is not a valid on_conflict value; use \"skip\" or \"replace\""
        )));
    }
    if bundle.version != BUNDLE_VERSION {
        return Err(Error::Validation(format!(
            "bundle version {} is not supported; this mesa understands version {BUNDLE_VERSION}",
            bundle.version
        )));
    }

    Ok(bundle
        .items
        .iter()
        .map(|item| import_one(store, item, on_conflict))
        .collect())
}

/// Imports one bundle item, never propagating an error — every outcome,
/// including a failure, is reported in the returned [`LibraryImportResult`]
/// so the caller's batch loop stays a plain `map`.
fn import_one(
    store: &mut Store,
    item: &LibraryBundleItem,
    on_conflict: &str,
) -> LibraryImportResult {
    let fail = |error: String| LibraryImportResult {
        name: item.name.clone(),
        kind: item.kind,
        scope: item.scope,
        status: "failed".to_string(),
        item_id: None,
        error: Some(error),
    };

    let project_id = match (item.scope, &item.project) {
        (LibraryScope::User, Some(_)) => {
            return fail("a user-scoped item may not carry a project name".to_string());
        }
        (LibraryScope::Project, None) => {
            return fail("a project-scoped item must carry a project name".to_string());
        }
        (LibraryScope::User, None) => None,
        (LibraryScope::Project, Some(name)) => match store.find_project_by_name(name) {
            Ok(project) => Some(project.id),
            Err(e) => return fail(e.to_string()),
        },
    };

    let existing = match store.find_library_item(item.kind, item.scope, project_id, &item.name) {
        Ok(existing) => existing,
        Err(e) => return fail(e.to_string()),
    };

    let existing = match existing {
        Some(existing) => Some(existing),
        // No row claims this exact (kind, scope, project, name) — but if the
        // item's builtin_id already has a fork somewhere, creating a second
        // row for the same builtin_id would be `conflict`. Resolve against
        // that existing fork instead, per the spec's conflict case.
        None => match &item.builtin_id {
            Some(builtin_id) => match store.find_library_fork(builtin_id) {
                Ok(fork) => fork,
                Err(e) => return fail(e.to_string()),
            },
            None => None,
        },
    };

    match existing {
        None => match store.create_library_item(
            item.kind,
            item.scope,
            project_id,
            &item.name,
            &item.body,
            item.builtin_id.as_deref(),
        ) {
            Ok(created) => LibraryImportResult {
                name: item.name.clone(),
                kind: item.kind,
                scope: item.scope,
                status: "created".to_string(),
                item_id: created.id,
                error: None,
            },
            Err(e) => fail(e.to_string()),
        },
        Some(existing) if on_conflict == "skip" => LibraryImportResult {
            name: item.name.clone(),
            kind: item.kind,
            scope: item.scope,
            status: "skipped".to_string(),
            item_id: existing.id,
            error: None,
        },
        Some(existing) => match store.update_library_item(
            existing.id.expect("a matched row always has an id"),
            LibraryPatch {
                body: Some(item.body.clone()),
                ..Default::default()
            },
        ) {
            Ok(updated) => LibraryImportResult {
                name: item.name.clone(),
                kind: item.kind,
                scope: item.scope,
                status: "replaced".to_string(),
                item_id: updated.id,
                error: None,
            },
            Err(e) => fail(e.to_string()),
        },
    }
}

// ---- hook registration in `.claude/settings.json` (mesa task 1115) ----
//
// A hook file on disk does nothing until Claude Code is told to run it. That
// wiring lives in `.claude/settings.json`, under an event name, as a group
// carrying a `matcher` and a list of commands:
//
// ```json
// {"hooks": {"Stop": [{"matcher": "*",
//                      "hooks": [{"type": "command", "command": "…"}]}]}}
// ```
//
// mesa owns none of that file — the user's own settings live beside the
// `hooks` key — so every write here is a *targeted splice* of the `hooks`
// value's byte span and nothing else, and a file mesa cannot parse is
// refused rather than rewritten. See `docs/library.md`.

/// The events a hook may be registered under — Claude Code's own vocabulary,
/// pinned here because an unknown event silently never fires, which looks
/// exactly like a broken hook. An event outside this list is `validation`.
pub const HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "SessionStart",
    "SessionEnd",
];

/// The matcher applied when the caller names none: every tool / every source.
pub const DEFAULT_HOOK_MATCHER: &str = "*";

/// A matcher is a tool-name pattern, not a document. Bounded because it is
/// written verbatim into the user's settings file.
pub const HOOK_MATCHER_MAX: usize = 200;

/// Where a hook item's registration lives, and what it is registered *as*.
struct HookTarget {
    /// The `.claude/settings.json` this item's scope registers into.
    settings: PathBuf,
    /// `.claude/hooks/<name>` — the relative path the matching rule keys on.
    rel: String,
    /// The command mesa writes for this hook: `$CLAUDE_PROJECT_DIR`-relative
    /// at `project` scope, absolute at `user` scope.
    command: String,
    /// The absolute path on this machine, which a hand-written command may
    /// name instead.
    absolute: String,
}

/// Resolves a library item to its settings file and command string.
///
/// Only a [`LibraryKind::Hook`] has a registration at all: every other kind
/// is read by Claude Code because of *where it sits*, so there is nothing to
/// wire up and asking is `validation` rather than an empty answer.
fn hook_target(store: &Store, item: &LibraryItem) -> StoreResult<HookTarget> {
    if item.kind != LibraryKind::Hook {
        return Err(Error::Validation(format!(
            "{:?} is an {} item; only a hook is registered in settings.json",
            item.name,
            item.kind.as_str()
        )));
    }
    let rel = relative_path(LibraryKind::Hook, item.scope, &item.name)
        .ok_or_else(|| Error::Validation(format!("{:?} has no path", item.name)))?;
    let project_local_path = match item.project_id {
        Some(id) => store.get_project(id)?.local_path,
        None => None,
    };
    let project_local_path = project_local_path.map(PathBuf::from);
    let base = scope_base(item.scope, project_local_path.as_deref()).ok_or_else(|| {
        Error::Validation(format!(
            "{:?} is a project-scope hook and its project has no local path recorded; \
             there is no settings.json to register it in",
            item.name
        ))
    })?;
    let absolute = resolve(&base, &rel).map_err(Error::Validation)?;
    let settings = resolve(&base, Path::new(".claude/settings.json")).map_err(Error::Validation)?;
    let rel = rel.to_string_lossy().into_owned();
    // `$CLAUDE_PROJECT_DIR` is Claude Code's own variable for the repo it is
    // running in, so a project-scope registration stays portable across
    // clones and worktrees; a user-scope hook has no such anchor and is
    // named absolutely.
    let command = match item.scope {
        LibraryScope::Project => format!("$CLAUDE_PROJECT_DIR/{rel}"),
        LibraryScope::User => absolute.to_string_lossy().into_owned(),
    };
    Ok(HookTarget {
        settings,
        rel,
        command,
        absolute: absolute.to_string_lossy().into_owned(),
    })
}

/// Whether one settings.json command string runs *this* hook.
///
/// A command is arbitrary shell — `bash …/stop-notify.sh --quiet`,
/// `$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh`, an absolute path — so
/// the test is deliberately a substring one: the command is this hook's iff
/// it is exactly the absolute path, or it *contains* `.claude/hooks/<name>`
/// at a **path boundary** on both sides. The boundary is what keeps
/// `.claude/hooks/foo.sh` from being read as the hook named `oo.sh` and
/// `…/foo.sh.bak` from being read as `foo.sh`: the character on either side
/// of the match may not itself be a filename character.
fn command_runs_hook(command: &str, target: &HookTarget) -> bool {
    if command.trim() == target.absolute {
        return true;
    }
    let boundary = |c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    let mut from = 0;
    while let Some(offset) = command[from..].find(&target.rel) {
        let start = from + offset;
        let end = start + target.rel.len();
        let before = command[..start].chars().next_back().is_none_or(boundary);
        let after = command[end..].chars().next().is_none_or(boundary);
        if before && after {
            return true;
        }
        from = start + 1;
    }
    false
}

/// The `hooks` object of a settings file, as mesa understands it — plus the
/// raw text it came from, which every write splices back into.
struct Settings {
    raw: String,
    hooks: serde_json::Map<String, serde_json::Value>,
}

/// Reads and validates a settings file. A missing or whitespace-only file is
/// an empty one.
fn read_settings(path: &Path) -> StoreResult<Settings> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(Error::Io(e)),
    };
    let hooks = parse_settings(&raw, path)?;
    Ok(Settings { raw, hooks })
}

/// The validation half of [`read_settings`], run again on a splice's own
/// output before it is written.
///
/// Anything mesa cannot understand — invalid JSON, a top level that is not an
/// object, a `hooks` that is not an object, an event whose value is not an
/// array — is `validation` **naming the file**, never a rewrite: the rest of
/// that file is the user's own configuration, and a best-effort repair would
/// destroy it. It is also what lets the raw-text splice below assume the
/// shapes it navigates.
fn parse_settings(
    raw: &str,
    path: &Path,
) -> StoreResult<serde_json::Map<String, serde_json::Value>> {
    if raw.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        Error::Validation(format!(
            "{} is not valid JSON ({e}); mesa will not rewrite a settings file it cannot read",
            path.display()
        ))
    })?;
    let root = root.as_object().ok_or_else(|| {
        Error::Validation(format!(
            "{} does not hold a JSON object at its top level",
            path.display()
        ))
    })?;
    let hooks = match root.get("hooks") {
        None | Some(serde_json::Value::Null) => serde_json::Map::new(),
        Some(serde_json::Value::Object(map)) => map.clone(),
        Some(_) => {
            return Err(Error::Validation(format!(
                "{}'s \"hooks\" is not an object; mesa will not rewrite it",
                path.display()
            )));
        }
    };
    for (event, groups) in &hooks {
        if !groups.is_array() {
            return Err(Error::Validation(format!(
                "{}'s \"hooks\".{event:?} is not an array; mesa will not rewrite it",
                path.display()
            )));
        }
    }
    Ok(hooks)
}

/// A group's matcher, defaulting to `*` — an absent `matcher` key means
/// "everything", so it is the same group as an explicit `"*"` and appending
/// into it beats writing a second group that would fire on the same events.
fn group_matcher(group: &serde_json::Value) -> &str {
    group
        .get("matcher")
        .and_then(|m| m.as_str())
        .unwrap_or(DEFAULT_HOOK_MATCHER)
}

/// Every registration of `target` currently in `hooks`, in event then group
/// then command order.
fn registrations_in(
    hooks: &serde_json::Map<String, serde_json::Value>,
    target: &HookTarget,
) -> Vec<LibraryHookRegistration> {
    let mut found = Vec::new();
    for (event, groups) in hooks {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            let matcher = group_matcher(group).to_string();
            let Some(commands) = group.get("hooks").and_then(|h| h.as_array()) else {
                continue;
            };
            for entry in commands {
                let Some(command) = entry.get("command").and_then(|c| c.as_str()) else {
                    continue;
                };
                if command_runs_hook(command, target) {
                    found.push(LibraryHookRegistration {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        command: command.to_string(),
                    });
                }
            }
        }
    }
    found
}

/// Assembles the answer every one of the three public functions returns —
/// the same shape whether anything was written or not, so a caller reads the
/// outcome rather than inferring it.
fn status_of(item: &LibraryItem, target: &HookTarget, settings: &Settings) -> LibraryHookStatus {
    let registrations = registrations_in(&settings.hooks, target);
    LibraryHookStatus {
        item_id: item.id,
        name: item.name.clone(),
        settings_path: target.settings.to_string_lossy().into_owned(),
        command: target.command.clone(),
        registered: !registrations.is_empty(),
        registrations,
        events: HOOK_EVENTS.iter().map(|e| e.to_string()).collect(),
    }
}

/// Where a hook item is registered right now — a pure read.
pub fn hook_registrations(store: &Store, item: &LibraryItem) -> StoreResult<LibraryHookStatus> {
    let target = hook_target(store, item)?;
    let settings = read_settings(&target.settings)?;
    Ok(status_of(item, &target, &settings))
}

/// Validates a caller-supplied event/matcher pair.
fn validate_event(event: &str) -> StoreResult<String> {
    HOOK_EVENTS
        .iter()
        .find(|e| **e == event)
        .map(|e| (*e).to_string())
        .ok_or_else(|| {
            Error::Validation(format!(
                "{event:?} is not a Claude Code hook event; expected one of {}",
                HOOK_EVENTS.join(", ")
            ))
        })
}

fn validate_matcher(matcher: Option<&str>) -> StoreResult<String> {
    let matcher = matcher.unwrap_or(DEFAULT_HOOK_MATCHER);
    if matcher.is_empty() {
        return Ok(DEFAULT_HOOK_MATCHER.to_string());
    }
    if matcher.len() > HOOK_MATCHER_MAX {
        return Err(Error::Validation(format!(
            "matcher is {} characters; the limit is {HOOK_MATCHER_MAX}",
            matcher.len()
        )));
    }
    if matcher.contains('\n') || matcher.contains('\r') {
        return Err(Error::Validation(
            "matcher may not contain a newline".into(),
        ));
    }
    Ok(matcher.to_string())
}

/// Writes the hook's own script to disk if it is not there already, so a
/// registration never names a file that does not exist.
///
/// A built-in hook is *code*, and a fork or a hand-authored row is a database
/// row: neither reaches the disk until the user runs a library sync. Without
/// this, enabling the shipped `stop-notify.sh` on a fresh install writes a
/// command Claude Code then fails on every session — the same failure
/// `HOOK_EVENTS` validation exists to prevent, only louder.
///
/// This is deliberately [`ensure_agent_file`]'s posture, for the same reason
/// it has one: a spawn (there) and a registration (here) may not depend on
/// something the user has to run first, but **neither may overwrite** — after
/// the first seed the file belongs to the sync flow, where a difference
/// between disk and mesa is a row the user resolves. The executable bit is
/// set because a hook is a script Claude Code runs, not a file it reads.
fn seed_hook_file(target: &HookTarget, body: &str) -> StoreResult<()> {
    let path = Path::new(&target.absolute);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Registers a hook under one event, and answers its status afterwards.
///
/// Idempotent: a group with the same `matcher` is appended into rather than
/// duplicated, and a command already registered for that `(event, matcher)`
/// leaves the file untouched — not even its mtime moves, since a write that
/// would change nothing is skipped outright.
pub fn register_hook(
    store: &Store,
    item: &LibraryItem,
    event: &str,
    matcher: Option<&str>,
) -> StoreResult<LibraryHookStatus> {
    let target = hook_target(store, item)?;
    let event = validate_event(event)?;
    let matcher = validate_matcher(matcher)?;
    seed_hook_file(&target, &item.body)?;
    let settings = read_settings(&target.settings)?;
    let spliced = splice_register(&settings.raw, &event, &matcher, &target.command, &|c| {
        command_runs_hook(c, &target)
    });
    apply(item, &target, settings, spliced)
}

/// Removes this hook's registrations — all of them, or only those under
/// `event` (and `matcher`, when given). Removing something that was never
/// registered is a no-op success, the mirror of `register_hook`'s
/// idempotence.
///
/// Cleanup runs upward: a group whose command list empties is dropped, an
/// event whose group list empties is dropped, and a `hooks` key that empties
/// is removed from the file rather than left as `{}`.
pub fn unregister_hook(
    store: &Store,
    item: &LibraryItem,
    event: Option<&str>,
    matcher: Option<&str>,
) -> StoreResult<LibraryHookStatus> {
    let target = hook_target(store, item)?;
    let event = event.map(validate_event).transpose()?;
    // An absent matcher here means "every matcher", not `*` — unlike
    // `register_hook`, where there is one group to write and it needs a name.
    // It is also **not validated**: on this path the matcher is a filter
    // naming which existing registrations to cut, never text mesa writes, so
    // `validate_matcher`'s input rules do not apply. Holding them here would
    // make a matcher already hand-written into the file — over 200 bytes, or
    // carrying a newline — impossible to narrow to, and an empty string would
    // silently become `*` rather than the group actually named "".
    let matcher = matcher.map(str::to_string);
    let settings = read_settings(&target.settings)?;
    let spliced = splice_unregister(&settings.raw, event.as_deref(), matcher.as_deref(), &|c| {
        command_runs_hook(c, &target)
    });
    apply(item, &target, settings, spliced)
}

/// Writes a splice's result, if it produced one, and answers the resulting
/// status either way. `Ok(None)` from a splice means the file already says
/// what was asked for, so nothing is written at all — not even the mtime
/// moves.
///
/// The new text is re-parsed before the status is built, which doubles as a
/// self-check that the splice produced valid JSON.
fn apply(
    item: &LibraryItem,
    target: &HookTarget,
    settings: Settings,
    spliced: Result<Option<String>, String>,
) -> StoreResult<LibraryHookStatus> {
    let spliced = spliced.map_err(|e| {
        Error::Validation(format!(
            "{} could not be edited ({e}); nothing was changed",
            target.settings.display()
        ))
    })?;
    let Some(raw) = spliced else {
        return Ok(status_of(item, target, &settings));
    };
    let hooks = parse_settings(&raw, &target.settings)?;
    if let Some(parent) = target.settings.parent() {
        fs::create_dir_all(parent)?;
    }
    // Written through a sibling temp file and renamed, the reasoning
    // `config::write_atomically` states for mesa's *own* config holding
    // doubly here: `fs::write` truncates first, so a crash mid-write would
    // leave the user's settings a partial document — and unlike the config,
    // this is a file mesa did not author and cannot regenerate. (Copied
    // rather than called: that function reports a `config::SaveError`, and
    // mapping it in would be more code than the three lines it saves.)
    let mut tmp = target.settings.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, &raw)?;
    fs::rename(&tmp, &target.settings).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(status_of(item, target, &Settings { raw, hooks }))
}

// ---- the splice ----
//
// mesa does not own `.claude/settings.json`: the user's model, environment,
// permissions and everything else live beside the `hooks` key, and inside
// `hooks` most of what is there was written by somebody else. So a write
// here is not a reserialization of the file, nor even of its `hooks` block —
// it is a cut or an insert at the span of **the one entry being added or
// removed**. Bytes mesa did not semantically change do not move: a sibling
// command, another group, another event and every key ordering among them
// come through identical, because they are never re-emitted.
//
// Only genuinely new structure is serialized — and only the fragment being
// introduced, spliced in at its neighbours' own indentation and comma style.

/// A `(start, end)` byte span in the raw text, `end` exclusive.
type Span = (usize, usize);

/// One entry of a JSON object, located in the raw text.
struct ObjEntry {
    key: String,
    /// The whole entry, from the key's opening quote to the end of its value.
    span: Span,
    /// The value alone.
    value: Span,
}

/// Adds one command entry under `event`/`matcher`, answering the new text —
/// or `Ok(None)` when the file already registers this hook there.
///
/// Exactly one thing is ever written: the innermost structure that does not
/// exist yet. An existing group gains one command entry; a missing group,
/// event or `hooks` key is introduced whole, but always spliced in beside its
/// siblings rather than replacing them.
fn splice_register(
    raw: &str,
    event: &str,
    matcher: &str,
    command: &str,
    is_ours: &dyn Fn(&str) -> bool,
) -> Result<Option<String>, String> {
    let entry = serde_json::json!({"type": "command", "command": command});
    let group = serde_json::json!({"matcher": matcher, "hooks": [entry]});

    // A file with no JSON in it at all has nothing to preserve.
    if raw.trim().is_empty() {
        return Ok(Some(format!(
            "{}\n",
            pretty(&serde_json::json!({"hooks": {event: [group]}}))
        )));
    }

    let (top_open, top_close, top) = top_level_object(raw)?;
    let top_spans: Vec<Span> = top.iter().map(|e| e.span).collect();
    let Some(hooks_entry) = top.iter().find(|e| e.key == "hooks") else {
        let value = serde_json::json!({event: [group]});
        return Ok(Some(insert_last(
            raw,
            top_open,
            top_close,
            &top_spans,
            Some("hooks"),
            &value,
        )));
    };

    if is_null_value(raw, hooks_entry.value) {
        // `parse_settings` reads a null `hooks` as an empty one, so the splice
        // must too: writing the value in its place is the same act as
        // introducing the key, one span further in.
        let value = serde_json::json!({event: [group]});
        return Ok(Some(replace_value(
            raw,
            hooks_entry.value,
            top_open,
            top_close,
            &value,
        )));
    }
    let hooks_open = expect_open(raw, hooks_entry.value.0, b'{', "\"hooks\"")?;
    let (hooks_close, events) = object_entries(raw, hooks_open)?;
    let event_spans: Vec<Span> = events.iter().map(|e| e.span).collect();
    let Some(event_entry) = events.iter().find(|e| e.key == event) else {
        return Ok(Some(insert_last(
            raw,
            hooks_open,
            hooks_close,
            &event_spans,
            Some(event),
            &serde_json::json!([group]),
        )));
    };

    let event_open = expect_open(raw, event_entry.value.0, b'[', event)?;
    let (event_close, groups) = array_elements(raw, event_open)?;
    let mut found = None;
    for span in &groups {
        if raw.as_bytes()[span.0] != b'{' {
            continue;
        }
        let (close, entries) = object_entries(raw, span.0)?;
        if raw_group_matcher(raw, &entries) == matcher {
            found = Some((span.0, close, entries));
            break;
        }
    }
    let Some((group_open, group_close, group_entries)) = found else {
        return Ok(Some(insert_last(
            raw,
            event_open,
            event_close,
            &groups,
            None,
            &group,
        )));
    };

    // An existing group for this matcher is appended into: two groups with
    // one matcher fire on exactly the same events, so a second one is noise
    // the user would have to reconcile by hand.
    let group_spans: Vec<Span> = group_entries.iter().map(|e| e.span).collect();
    let Some(commands_entry) = group_entries.iter().find(|e| e.key == "hooks") else {
        return Ok(Some(insert_last(
            raw,
            group_open,
            group_close,
            &group_spans,
            Some("hooks"),
            &serde_json::json!([entry]),
        )));
    };
    let commands_open = expect_open(raw, commands_entry.value.0, b'[', "a group's \"hooks\"")?;
    let (commands_close, commands) = array_elements(raw, commands_open)?;
    for span in &commands {
        if raw_command(raw, *span).is_some_and(|c| is_ours(&c)) {
            return Ok(None);
        }
    }
    Ok(Some(insert_last(
        raw,
        commands_open,
        commands_close,
        &commands,
        None,
        &entry,
    )))
}

/// Cuts out every command entry this hook owns, answering the new text — or
/// `Ok(None)` when there was nothing to remove.
///
/// The cut escalates only as far as it must: a group whose command list would
/// empty is cut instead of its commands, an event whose group list would
/// empty is cut instead of its groups, and a `hooks` key that would empty is
/// cut from the file rather than left behind as `{}`. Anything that survives
/// is never rewritten.
fn splice_unregister(
    raw: &str,
    event_filter: Option<&str>,
    matcher_filter: Option<&str>,
    is_ours: &dyn Fn(&str) -> bool,
) -> Result<Option<String>, String> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let (top_open, top_close, top) = top_level_object(raw)?;
    let Some(hooks_index) = top.iter().position(|e| e.key == "hooks") else {
        return Ok(None);
    };
    if is_null_value(raw, top[hooks_index].value) {
        // A null `hooks` holds no registration, so there is nothing to cut —
        // the same no-op success an absent key gets, and the same reading
        // `parse_settings` already takes of it.
        return Ok(None);
    }
    let hooks_open = expect_open(raw, top[hooks_index].value.0, b'{', "\"hooks\"")?;
    let (hooks_close, events) = object_entries(raw, hooks_open)?;

    let mut cuts: Vec<Span> = Vec::new();
    let mut dead_events = vec![false; events.len()];
    for (event_index, event) in events.iter().enumerate() {
        if event_filter.is_some_and(|wanted| wanted != event.key) {
            continue;
        }
        let event_open = expect_open(raw, event.value.0, b'[', &event.key)?;
        let (event_close, groups) = array_elements(raw, event_open)?;
        let mut dead_groups = vec![false; groups.len()];
        let mut inner: Vec<Span> = Vec::new();
        for (group_index, group) in groups.iter().enumerate() {
            if raw.as_bytes()[group.0] != b'{' {
                continue;
            }
            let (group_close, entries) = object_entries(raw, group.0)?;
            if matcher_filter.is_some_and(|m| m != raw_group_matcher(raw, &entries)) {
                continue;
            }
            let Some(commands_entry) = entries.iter().find(|e| e.key == "hooks") else {
                continue;
            };
            let commands_open =
                expect_open(raw, commands_entry.value.0, b'[', "a group's \"hooks\"")?;
            let (commands_close, commands) = array_elements(raw, commands_open)?;
            let dead: Vec<bool> = commands
                .iter()
                .map(|s| raw_command(raw, *s).is_some_and(|c| is_ours(&c)))
                .collect();
            let count = dead.iter().filter(|d| **d).count();
            if count == 0 {
                continue;
            }
            if count == commands.len() {
                // Every command in this group is ours: cut the group, not its
                // contents, so no empty `{"matcher": …, "hooks": []}` is left.
                let _ = (group_close, commands_close);
                dead_groups[group_index] = true;
            } else {
                inner.extend(cut_spans(
                    raw,
                    &commands,
                    &dead,
                    commands_open,
                    commands_close,
                ));
            }
        }
        let count = dead_groups.iter().filter(|d| **d).count();
        if count > 0 && count == groups.len() {
            dead_events[event_index] = true;
        } else {
            if count > 0 {
                cuts.extend(cut_spans(
                    raw,
                    &groups,
                    &dead_groups,
                    event_open,
                    event_close,
                ));
            }
            cuts.extend(inner);
        }
    }

    let count = dead_events.iter().filter(|d| **d).count();
    if count > 0 && count == events.len() && cuts.is_empty() {
        // Nothing would be left under `hooks`: cut the key itself.
        let top_spans: Vec<Span> = top.iter().map(|e| e.span).collect();
        let mut dead_top = vec![false; top.len()];
        dead_top[hooks_index] = true;
        cuts = cut_spans(raw, &top_spans, &dead_top, top_open, top_close);
    } else if count > 0 {
        let event_spans: Vec<Span> = events.iter().map(|e| e.span).collect();
        cuts.extend(cut_spans(
            raw,
            &event_spans,
            &dead_events,
            hooks_open,
            hooks_close,
        ));
    }

    if cuts.is_empty() {
        return Ok(None);
    }
    // Applied last-first so an earlier cut's offsets stay valid.
    cuts.sort_by_key(|(start, _)| std::cmp::Reverse(*start));
    let mut out = raw.to_string();
    for (start, end) in cuts {
        out.replace_range(start..end, "");
    }
    Ok(Some(out))
}

/// The spans to delete so that exactly the items flagged in `dead` are gone,
/// each taking one separating comma with it and leaving every survivor's own
/// bytes — indentation included — untouched.
///
/// Two rules, and the split between them is what keeps the spans from
/// overlapping when a run of items at the end is removed: an item before the
/// last survivor takes the comma that *follows* it (so the cut runs to where
/// the next item's own whitespace begins), while the whole trailing run after
/// the last survivor is one cut that takes the comma *preceding* it.
///
/// With no survivors at all the container is emptied — the caller normally
/// escalates instead of asking for that, so it is a safe default rather than
/// a path in the cascade.
fn cut_spans(raw: &str, items: &[Span], dead: &[bool], open: usize, close: usize) -> Vec<Span> {
    let Some(last_survivor) = (0..items.len()).rev().find(|i| !dead[*i]) else {
        return vec![(open + 1, close)];
    };
    let mut cuts = Vec::new();
    for index in 0..last_survivor {
        if dead[index] {
            cuts.push((
                item_start(raw, items[index].0),
                item_start(raw, items[index + 1].0),
            ));
        }
    }
    if last_survivor + 1 < items.len() {
        cuts.push((items[last_survivor].1, items[items.len() - 1].1));
    }
    cuts
}

/// Appends one item to an object or array, in its existing siblings' style.
///
/// The separator is copied verbatim from the last sibling's own leading
/// whitespace, so the new item lands at exactly that indentation — and a
/// single-line container stays single-line, since a separator with no newline
/// in it means the value is rendered compact. Only an empty container has no
/// style to copy, and there the value is opened out one level in from the
/// container's own line.
fn insert_last(
    raw: &str,
    open: usize,
    close: usize,
    items: &[Span],
    key: Option<&str>,
    value: &serde_json::Value,
) -> String {
    let render = |indent: &str, multiline: bool| {
        let body = if multiline {
            reindent(&pretty(value), indent)
        } else {
            value.to_string()
        };
        match key {
            Some(k) => format!("{}: {body}", serde_json::Value::String(k.to_string())),
            None => body,
        }
    };
    let Some(last) = items.last() else {
        // An empty container has no sibling to copy, so it inherits the one
        // thing it does say about itself: whether it is written across lines.
        // An inline `[]` stays inline; a container already opened out gets
        // its new item one level in from its own line.
        if !raw[open..close].contains('\n') {
            return format!("{}{}{}", &raw[..=open], render("", false), &raw[close..]);
        }
        let outer = line_indent(raw, open);
        let inner = format!("{outer}  ");
        let text = render(&inner, true);
        return format!("{}\n{inner}{text}\n{outer}{}", &raw[..=open], &raw[close..]);
    };
    let separator = &raw[item_start(raw, last.0)..last.0];
    let indent = separator.rsplit('\n').next().unwrap_or("");
    let text = render(indent, separator.contains('\n'));
    format!("{},{separator}{text}{}", &raw[..last.1], &raw[last.1..])
}

/// Whether a located value is the literal `null`. `parse_settings` accepts a
/// null `hooks` as an empty one, so both splices have to agree with it rather
/// than refusing a file mesa's own parser calls fine.
fn is_null_value(raw: &str, value: Span) -> bool {
    raw[value.0..value.1].trim() == "null"
}

/// Replaces one value span, in its container's style — the same choice
/// [`insert_last`] makes for an empty container: a single-line object keeps
/// its new value compact, a container already opened out gets it
/// pretty-printed at the holding key's own indentation.
fn replace_value(
    raw: &str,
    value: Span,
    open: usize,
    close: usize,
    replacement: &serde_json::Value,
) -> String {
    let body = if raw[open..close].contains('\n') {
        reindent(&pretty(replacement), line_indent(raw, value.0))
    } else {
        replacement.to_string()
    };
    format!("{}{body}{}", &raw[..value.0], &raw[value.1..])
}

/// A group's matcher read straight from the raw text, defaulting to `*` — an
/// absent `matcher` key means "everything", so it is the same group as an
/// explicit `"*"`.
fn raw_group_matcher(raw: &str, entries: &[ObjEntry]) -> String {
    entries
        .iter()
        .find(|e| e.key == "matcher")
        .and_then(|e| serde_json::from_str::<String>(&raw[e.value.0..e.value.1]).ok())
        .unwrap_or_else(|| DEFAULT_HOOK_MATCHER.to_string())
}

/// The `command` string of one entry in a group's `hooks` array.
fn raw_command(raw: &str, span: Span) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(&raw[span.0..span.1]).ok()?;
    Some(value.get("command")?.as_str()?.to_string())
}

/// Confirms a located value really opens with the bracket its shape requires.
/// [`parse_settings`] has already checked all of this on the parsed document;
/// this is the raw-text side saying so again before it cuts anything.
fn expect_open(raw: &str, at: usize, want: u8, what: &str) -> Result<usize, String> {
    if raw.as_bytes().get(at) == Some(&want) {
        Ok(at)
    } else {
        Err(format!("{what} is not a {}", want as char))
    }
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).expect("a json value always serializes")
}

/// The leading whitespace of the line `at` sits on, whatever else is on it.
fn line_indent(raw: &str, at: usize) -> &str {
    let line_start = raw[..at].rfind('\n').map_or(0, |i| i + 1);
    let line = &raw[line_start..];
    let end = line
        .find(|c: char| c != ' ' && c != '\t')
        .unwrap_or(line.len());
    &line[..end]
}

/// Re-indents a pretty-printed value so its continuation lines sit under the
/// item that holds it. The first line is left alone — it follows a separator
/// that already placed it.
fn reindent(pretty: &str, indent: &str) -> String {
    let mut out = String::new();
    for (i, line) in pretty.lines().enumerate() {
        if i > 0 {
            out.push('\n');
            out.push_str(indent);
        }
        out.push_str(line);
    }
    out
}

/// Where an item's text begins, counting the whitespace separating it from
/// the `{`, `[` or `,` before it — so cutting between two neighbours'
/// `item_start`s removes one whole line, indentation included.
fn item_start(raw: &str, at: usize) -> usize {
    raw[..at]
        .rfind(|c: char| !c.is_ascii_whitespace())
        .map_or(0, |i| i + 1)
}

/// The outermost object: `(open, close, entries)`.
fn top_level_object(raw: &str) -> Result<(usize, usize, Vec<ObjEntry>), String> {
    let open = skip_ws(raw.as_bytes(), 0);
    if raw.as_bytes().get(open) != Some(&b'{') {
        return Err("the top level is not an object".into());
    }
    let (close, entries) = object_entries(raw, open)?;
    Ok((open, close, entries))
}

/// Every entry of the object opening at `open`, plus that object's closing
/// brace.
///
/// This and its siblings only ever run on text `serde_json` has already
/// parsed (see [`parse_settings`]), so they may assume well-formed JSON;
/// every error below is a defensive one, and every one of them aborts the
/// write rather than guessing.
fn object_entries(raw: &str, open: usize) -> Result<(usize, Vec<ObjEntry>), String> {
    let b = raw.as_bytes();
    let mut i = open + 1;
    let mut entries = Vec::new();
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            None => return Err("an object is unterminated".into()),
            Some(b'}') => return Ok((i, entries)),
            Some(b'"') => {}
            Some(c) => {
                return Err(format!(
                    "unexpected {:?} where a key was expected",
                    *c as char
                ));
            }
        }
        let key_start = i;
        let key_end = string_end(b, key_start)?;
        let key: String = serde_json::from_str(&raw[key_start..key_end])
            .map_err(|e| format!("unreadable key: {e}"))?;
        i = skip_ws(b, key_end);
        if b.get(i) != Some(&b':') {
            return Err(format!("no ':' after key {key:?}"));
        }
        let value_start = skip_ws(b, i + 1);
        let value_end = value_end(b, value_start)?;
        entries.push(ObjEntry {
            key,
            span: (key_start, value_end),
            value: (value_start, value_end),
        });
        i = skip_ws(b, value_end);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => return Ok((i, entries)),
            _ => return Err("an object is unterminated".into()),
        }
    }
}

/// Every element of the array opening at `open`, plus that array's closing
/// bracket.
fn array_elements(raw: &str, open: usize) -> Result<(usize, Vec<Span>), String> {
    let b = raw.as_bytes();
    let mut i = open + 1;
    let mut items = Vec::new();
    loop {
        i = skip_ws(b, i);
        match b.get(i) {
            None => return Err("an array is unterminated".into()),
            Some(b']') => return Ok((i, items)),
            _ => {}
        }
        let end = value_end(b, i)?;
        items.push((i, end));
        i = skip_ws(b, end);
        match b.get(i) {
            Some(b',') => i += 1,
            Some(b']') => return Ok((i, items)),
            _ => return Err("an array is unterminated".into()),
        }
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] as char).is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Index just past the closing quote of the string starting at `start`.
fn string_end(b: &[u8], start: usize) -> Result<usize, String> {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err("unterminated string".into())
}

/// Index just past the JSON value starting at `start`.
fn value_end(b: &[u8], start: usize) -> Result<usize, String> {
    match b.get(start) {
        None => Err("a value was expected".into()),
        Some(b'"') => string_end(b, start),
        Some(&c @ (b'{' | b'[')) => {
            let close = if c == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut i = start;
            while i < b.len() {
                if b[i] == b'"' {
                    i = string_end(b, i)?;
                    continue;
                }
                if b[i] == c {
                    depth += 1;
                } else if b[i] == close {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(i + 1);
                    }
                }
                i += 1;
            }
            Err("unterminated value".into())
        }
        // A number, `true`, `false` or `null` — everything up to the first
        // character that can end it.
        Some(_) => {
            let mut i = start;
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
            {
                i += 1;
            }
            Ok(i)
        }
    }
}

/// A controlled `user`-scope base for tests, and the lock that keeps two of
/// them from seeing each other's `$HOME`. Lives outside `mod tests` because
/// `core::live`'s seed tests need the **same** lock: `$HOME` is process-global,
/// so one mutex per module would serialise nothing.
#[cfg(test)]
pub(crate) mod test_home {
    use std::path::Path;

    /// Serializes every test that needs a controlled `user`-scope base — the
    /// `claude-md` and `mesa-live` built-ins only exist at `user` scope, so
    /// exercising them means overriding the real, process-global `$HOME` for
    /// the duration of the closure. Guarded by a mutex (not just "no other
    /// test reads MESA_DB"-style luck) because several tests need it, and
    /// `cargo test` runs them on separate threads: two of these running
    /// concurrently without a lock could each briefly see the other's temp
    /// `$HOME`. Tests that stay on `project` scope never take this lock and
    /// are unaffected either way, since a passing `$HOME` value they never
    /// asked for and don't inspect is harmless to them.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(crate) fn with_home_dir<F: FnOnce(&Path)>(f: F) {
        let _guard = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let original = std::env::var("HOME").ok();
        unsafe { std::env::set_var("HOME", dir.path()) };
        f(dir.path());
        match original {
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_home::with_home_dir;
    use super::*;
    use crate::core::store::LibraryPatch;

    /// `scan_disk` without the per-file mtime — a real clock's value is not
    /// assertable, and every test below is about *which files* the scan finds.
    fn scanned(base: &Path) -> Vec<(LibraryKind, String, String)> {
        scan_disk(base)
            .into_iter()
            .map(|(kind, name, body, _)| (kind, name, body))
            .collect()
    }

    fn kinds(diff: &[LibraryDiffLine]) -> Vec<(LibraryDiffKind, Option<u32>, Option<u32>, &str)> {
        diff.iter()
            .map(|l| (l.kind, l.mesa_line, l.disk_line, l.text.as_str()))
            .collect()
    }

    #[test]
    fn diff_lines_reports_identical_bodies_as_all_context() {
        let diff = diff_lines("a\nb\n", "a\nb\n");
        assert_eq!(
            kinds(&diff),
            vec![
                (LibraryDiffKind::Context, Some(1), Some(1), "a"),
                (LibraryDiffKind::Context, Some(2), Some(2), "b"),
            ]
        );
    }

    #[test]
    fn diff_lines_reports_an_insertion_on_the_disk_side_only() {
        let diff = diff_lines("a\nb\n", "a\nnew\nb\n");
        assert_eq!(
            kinds(&diff),
            vec![
                (LibraryDiffKind::Context, Some(1), Some(1), "a"),
                (LibraryDiffKind::DiskOnly, None, Some(2), "new"),
                (LibraryDiffKind::Context, Some(2), Some(3), "b"),
            ]
        );
    }

    #[test]
    fn diff_lines_reports_a_deletion_on_the_mesa_side_only() {
        let diff = diff_lines("a\ngone\nb\n", "a\nb\n");
        assert_eq!(
            kinds(&diff),
            vec![
                (LibraryDiffKind::Context, Some(1), Some(1), "a"),
                (LibraryDiffKind::MesaOnly, Some(2), None, "gone"),
                (LibraryDiffKind::Context, Some(3), Some(2), "b"),
            ]
        );
    }

    #[test]
    fn diff_lines_reports_a_replaced_line_as_both_a_removal_and_an_addition() {
        // No three-way attribution and no "changed" kind: a replacement is
        // exactly a mesa-only line and a disk-only one, which is what a
        // resolution actually picks between.
        let diff = diff_lines("a\nold\nb\n", "a\nnew\nb\n");
        assert_eq!(
            kinds(&diff),
            vec![
                (LibraryDiffKind::Context, Some(1), Some(1), "a"),
                (LibraryDiffKind::MesaOnly, Some(2), None, "old"),
                (LibraryDiffKind::DiskOnly, None, Some(2), "new"),
                (LibraryDiffKind::Context, Some(3), Some(3), "b"),
            ]
        );
    }

    #[test]
    fn diff_lines_against_an_empty_side_is_every_line_of_the_other() {
        assert_eq!(
            kinds(&diff_lines("a\nb\n", "")),
            vec![
                (LibraryDiffKind::MesaOnly, Some(1), None, "a"),
                (LibraryDiffKind::MesaOnly, Some(2), None, "b"),
            ]
        );
        assert_eq!(
            kinds(&diff_lines("", "a\n")),
            vec![(LibraryDiffKind::DiskOnly, None, Some(1), "a")]
        );
    }

    #[test]
    fn diff_lines_ignores_a_missing_trailing_newline() {
        // `str::lines` gives both sides the same two lines — a trailing
        // newline is not something a person resolves a conflict over.
        let diff = diff_lines("a\nb", "a\nb\n");
        assert_eq!(
            kinds(&diff),
            vec![
                (LibraryDiffKind::Context, Some(1), Some(1), "a"),
                (LibraryDiffKind::Context, Some(2), Some(2), "b"),
            ]
        );
    }

    #[test]
    fn diff_lines_caps_its_output_and_says_so() {
        let mesa: String = (0..DIFF_MAX_LINES + 500)
            .map(|i| format!("line {i}\n"))
            .collect();
        let diff = diff_lines(&mesa, "");
        assert_eq!(diff.len(), DIFF_MAX_LINES + 1);
        let last = diff.last().unwrap();
        assert_eq!(last.kind, LibraryDiffKind::Context);
        assert_eq!(last.mesa_line, None);
        assert_eq!(last.disk_line, None);
        assert!(
            last.text.contains("500 more diff lines"),
            "the marker must say how much was dropped, got {:?}",
            last.text
        );
    }

    #[test]
    fn diff_lines_refuses_to_build_a_pathological_table() {
        // Past DIFF_MAX_CELLS the quadratic table is not built at all — one
        // marker line, never an error and never an unbounded walk.
        let big: String = (0..5000).map(|i| format!("line {i}\n")).collect();
        let other: String = (0..5000).map(|i| format!("other {i}\n")).collect();
        let diff = diff_lines(&big, &other);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].kind, LibraryDiffKind::Context);
        assert_eq!(diff[0].mesa_line, None);
        assert!(
            diff[0].text.contains("diff not computed"),
            "got {:?}",
            diff[0].text
        );
    }

    #[test]
    fn relative_path_covers_every_kind_and_scope() {
        assert_eq!(
            relative_path(LibraryKind::Agent, LibraryScope::User, "reviewer"),
            Some(PathBuf::from(".claude/agents/reviewer.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::Agent, LibraryScope::Project, "reviewer"),
            Some(PathBuf::from(".claude/agents/reviewer.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::Skill, LibraryScope::User, "dataviz"),
            Some(PathBuf::from(".claude/skills/dataviz/SKILL.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::Skill, LibraryScope::Project, "dataviz"),
            Some(PathBuf::from(".claude/skills/dataviz/SKILL.md"))
        );
        // A hook's name carries its own extension, so the path appends
        // nothing — which is what lets a `.py` guard live here too.
        assert_eq!(
            relative_path(LibraryKind::Hook, LibraryScope::User, "stop-notify.sh"),
            Some(PathBuf::from(".claude/hooks/stop-notify.sh"))
        );
        assert_eq!(
            relative_path(LibraryKind::Hook, LibraryScope::Project, "poll-guard.py"),
            Some(PathBuf::from(".claude/hooks/poll-guard.py"))
        );
        assert_eq!(
            relative_path(LibraryKind::Command, LibraryScope::User, "refine"),
            Some(PathBuf::from(".claude/commands/refine.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::Command, LibraryScope::Project, "refine"),
            Some(PathBuf::from(".claude/commands/refine.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::ClaudeMd, LibraryScope::User, "CLAUDE"),
            Some(PathBuf::from(".claude/CLAUDE.md"))
        );
        assert_eq!(
            relative_path(LibraryKind::ClaudeMd, LibraryScope::Project, "CLAUDE"),
            Some(PathBuf::from("CLAUDE.md"))
        );
        assert_eq!(
            relative_path(
                LibraryKind::Prompt,
                LibraryScope::User,
                "live-summary-prompt"
            ),
            None
        );
        assert_eq!(
            relative_path(
                LibraryKind::Prompt,
                LibraryScope::Project,
                "live-summary-prompt"
            ),
            None
        );
        // mesa task 1068: the live conversation's instructions are an agent
        // definition now, so unlike the prompt they used to be they have a
        // path and the sync flow carries them.
        assert_eq!(
            relative_path(LibraryKind::Agent, LibraryScope::User, "mesa-live"),
            Some(PathBuf::from(".claude/agents/mesa-live.md"))
        );
    }

    #[test]
    fn resolve_accepts_a_nested_path_within_base() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude/agents")).unwrap();
        let resolved = resolve(dir.path(), Path::new(".claude/agents/reviewer.md")).unwrap();
        assert!(resolved.ends_with(".claude/agents/reviewer.md"));
    }

    #[test]
    fn resolve_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        fs::create_dir_all(&base).unwrap();
        assert!(resolve(&base, Path::new("../escaped.md")).is_err());
    }

    #[test]
    fn resolve_rejects_a_deeply_nested_traversal_through_missing_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        fs::create_dir_all(&base).unwrap();
        assert!(resolve(&base, Path::new("a/b/../../../escaped.md")).is_err());
    }

    #[test]
    fn resolve_rejects_an_absolute_path_as_the_relative_argument() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        fs::create_dir_all(&base).unwrap();
        // An absolute "relative" path carries a RootDir component, which the
        // lexical walk refuses outright rather than treating as rooted at
        // `base`.
        assert!(resolve(&base, Path::new("/etc/passwd")).is_err());
    }

    #[test]
    fn resolve_rejects_a_symlink_that_escapes_base() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "top secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, base.join("escape-link")).unwrap();
        #[cfg(unix)]
        {
            // The symlinked directory component itself exists, so the naive
            // "canonicalize the deepest existing ancestor" check would happily
            // resolve straight through it. `resolve` must catch this via the
            // final `starts_with(base_canon)` check on the fully-canonicalised
            // result.
            let result = resolve(&base, Path::new("escape-link/secret.md"));
            assert!(
                result.is_err(),
                "a symlink under base pointing outside it must not resolve, got {result:?}"
            );
        }
    }

    #[test]
    fn resolve_accepts_dot_and_empty_components() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".claude/agents")).unwrap();
        let resolved = resolve(dir.path(), Path::new("./.claude/./agents/reviewer.md")).unwrap();
        assert!(resolved.ends_with(".claude/agents/reviewer.md"));
        // An empty relative path resolves to base itself.
        let resolved = resolve(dir.path(), Path::new("")).unwrap();
        assert_eq!(resolved, fs::canonicalize(dir.path()).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_never_escapes_base_for_a_component_with_a_nul_byte() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        fs::create_dir_all(&base).unwrap();
        // A NUL byte can never appear in a real path component (the syscall
        // layer rejects it), so this can never exist on disk — the point of
        // this test is only that `resolve` does not silently escape `base`
        // while failing to find it, whatever it decides to do with it.
        let evil = OsStr::from_bytes(b"evil\0name");
        let rel = Path::new(evil);
        // Both outcomes are safe here — an `Err` (refusing it outright) is
        // exactly as acceptable as an `Ok` that stays contained, so there is
        // nothing to assert on the error path itself. This differs from the
        // real sync path (`apply_mesa`/`apply_disk`), which never discards a
        // `resolve()` error — it is always propagated as the row's
        // `LibrarySyncResult.error`, never swallowed.
        if let Ok(resolved) = resolve(&base, rel) {
            let base_canon = fs::canonicalize(&base).unwrap();
            assert!(
                resolved.starts_with(&base_canon),
                "resolve must never answer a path outside base, got {resolved:?}"
            );
        }
    }

    #[test]
    fn classify_covers_every_row() {
        // M == D -> in-sync, regardless of baseline.
        assert_eq!(classify("x", Some("x"), None), LibrarySyncStatus::InSync);
        assert_eq!(
            classify("x", Some("x"), Some("y")),
            LibrarySyncStatus::InSync
        );

        // no file, never synced -> mesa-new
        assert_eq!(classify("x", None, None), LibrarySyncStatus::MesaNew);

        // no file, baseline == mesa -> disk-deleted
        assert_eq!(
            classify("x", None, Some("x")),
            LibrarySyncStatus::DiskDeleted
        );

        // no file, baseline != mesa -> both-changed (mesa moved away from a
        // baseline whose file is now gone)
        assert_eq!(
            classify("x", None, Some("y")),
            LibrarySyncStatus::BothChanged
        );

        // file exists, never synced, and mesa != disk -> both-changed
        assert_eq!(
            classify("x", Some("y"), None),
            LibrarySyncStatus::BothChanged
        );

        // baseline == disk, mesa moved -> mesa-changed
        assert_eq!(
            classify("x", Some("b"), Some("b")),
            LibrarySyncStatus::MesaChanged
        );

        // baseline == mesa, disk moved -> disk-changed
        assert_eq!(
            classify("b", Some("d"), Some("b")),
            LibrarySyncStatus::DiskChanged
        );

        // both moved away from the baseline, to different places -> both-changed
        assert_eq!(
            classify("x", Some("y"), Some("b")),
            LibrarySyncStatus::BothChanged
        );
    }

    #[test]
    fn scan_disk_round_trips_every_kind() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        fs::create_dir_all(base.join(".claude/commands")).unwrap();
        fs::create_dir_all(base.join(".claude/hooks")).unwrap();
        fs::create_dir_all(base.join(".claude/skills/dataviz")).unwrap();

        fs::write(base.join(".claude/agents/reviewer.md"), "reviewer body").unwrap();
        fs::write(base.join(".claude/commands/refine.md"), "refine body").unwrap();
        fs::write(base.join(".claude/hooks/stop-notify.sh"), "#!/bin/sh\n").unwrap();
        // A hook is any script, whatever its extension — and a name mesa
        // could not store is skipped without failing the scan.
        fs::write(base.join(".claude/hooks/poll-guard.py"), "# guard\n").unwrap();
        fs::write(base.join(".claude/hooks/warm"), "# no extension\n").unwrap();
        fs::write(base.join(".claude/hooks/.DS_Store"), "litter").unwrap();
        fs::write(base.join(".claude/skills/dataviz/SKILL.md"), "dataviz body").unwrap();
        fs::write(base.join(".claude/CLAUDE.md"), "claude md body").unwrap();
        // A non-matching extension in an agents dir must not be picked up.
        fs::write(base.join(".claude/agents/notes.txt"), "ignore me").unwrap();

        let found = scanned(base);

        assert!(found.contains(&(
            LibraryKind::Agent,
            "reviewer".to_string(),
            "reviewer body".to_string()
        )));
        assert!(found.contains(&(
            LibraryKind::Command,
            "refine".to_string(),
            "refine body".to_string()
        )));
        assert!(found.contains(&(
            LibraryKind::Hook,
            "stop-notify.sh".to_string(),
            "#!/bin/sh\n".to_string()
        )));
        assert!(found.contains(&(
            LibraryKind::Hook,
            "poll-guard.py".to_string(),
            "# guard\n".to_string()
        )));
        assert!(found.contains(&(
            LibraryKind::Hook,
            "warm".to_string(),
            "# no extension\n".to_string()
        )));
        assert!(
            !found
                .iter()
                .any(|(k, n, _)| *k == LibraryKind::Hook && n.starts_with('.')),
            "a dotfile is not a name mesa can store, so it is skipped: {found:?}"
        );
        assert!(found.contains(&(
            LibraryKind::Skill,
            "dataviz".to_string(),
            "dataviz body".to_string()
        )));
        assert!(found.contains(&(
            LibraryKind::ClaudeMd,
            "CLAUDE".to_string(),
            "claude md body".to_string()
        )));
        // Five kinds plus the two extra hooks — the `.DS_Store` is not here.
        assert_eq!(found.len(), 7);
    }

    #[test]
    fn scan_disk_skips_an_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        let big = "x".repeat(SCAN_MAX_BYTES as usize + 1);
        fs::write(base.join(".claude/agents/huge.md"), big).unwrap();
        let found = scanned(base);
        assert!(found.is_empty());
    }

    #[test]
    fn scan_disk_treats_every_directory_as_optional() {
        // Mirrors a real `~/.claude`: `hooks/` does not exist at all, `agents/`
        // and `skills/` exist but are empty, and only `commands/` has files —
        // none of that may error, and the files that are there (an on-disk
        // "no mesa row for this path yet" case, `disk-new` one level up in
        // the sync layer) still come back.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        fs::create_dir_all(base.join(".claude/skills")).unwrap();
        fs::create_dir_all(base.join(".claude/commands")).unwrap();
        // .claude/hooks is deliberately never created.
        fs::write(base.join(".claude/commands/refine.md"), "refine body").unwrap();
        fs::write(base.join(".claude/commands/triage-inbox.md"), "triage body").unwrap();
        fs::write(base.join(".claude/commands/todo.md"), "todo body").unwrap();

        let found = scanned(base);

        assert_eq!(found.len(), 3);
        assert!(
            found
                .iter()
                .all(|(kind, _, _)| *kind == LibraryKind::Command)
        );
        let names: std::collections::BTreeSet<&str> =
            found.iter().map(|(_, name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            std::collections::BTreeSet::from(["refine", "triage-inbox", "todo"])
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_disk_does_not_follow_a_symlinked_leaf_directory_out_of_base() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let outside = dir.path().join("outside-agents");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(base.join(".claude")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "outside agent body").unwrap();
        std::os::unix::fs::symlink(&outside, base.join(".claude/agents")).unwrap();

        let found = scanned(&base);
        assert!(
            found.is_empty(),
            "a symlinked .claude/agents must not be walked, got {found:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_disk_does_not_follow_a_symlinked_skills_directory_out_of_base() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let outside = dir.path().join("outside-skills");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(base.join(".claude")).unwrap();
        fs::create_dir_all(outside.join("dataviz")).unwrap();
        fs::write(outside.join("dataviz/SKILL.md"), "outside skill body").unwrap();
        std::os::unix::fs::symlink(&outside, base.join(".claude/skills")).unwrap();

        let found = scanned(&base);
        assert!(
            found.is_empty(),
            "a symlinked .claude/skills must not be walked, got {found:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_disk_does_not_follow_a_symlinked_claude_dir_out_of_base() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base");
        let outside = dir.path().join("outside-claude");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(outside.join("agents")).unwrap();
        fs::write(outside.join("agents/secret.md"), "outside agent body").unwrap();
        fs::write(outside.join("CLAUDE.md"), "outside claude md").unwrap();
        std::os::unix::fs::symlink(&outside, base.join(".claude")).unwrap();

        let found = scanned(&base);
        assert!(
            found.is_empty(),
            "a symlinked .claude must not be walked at all, got {found:?}"
        );
    }

    #[test]
    fn scan_disk_still_scans_a_legitimate_real_directory() {
        // The regression the fix above must not introduce: a real,
        // non-symlinked tree is still discovered exactly as before.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        fs::write(base.join(".claude/agents/reviewer.md"), "reviewer body").unwrap();

        let found = scanned(base);
        assert_eq!(
            found,
            vec![(
                LibraryKind::Agent,
                "reviewer".to_string(),
                "reviewer body".to_string()
            )]
        );
    }

    #[test]
    fn builtin_lookup() {
        assert!(builtin("mesa-live").is_some());
        assert!(builtin("supervisor").is_some());
        assert!(builtin("live-summary-prompt").is_some());
        assert!(builtin("starter-claude-md").is_some());
        assert!(builtin("stop-notify").is_some());
        assert!(builtin("no-such-builtin").is_none());
    }

    // ---- effective_items / sync_status / sync_apply ----

    fn temp_store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        (store, dir)
    }

    /// A project bound to `base` as `local_path` — every sync test below
    /// deliberately stays on `project` scope so it never has to touch the
    /// real `$HOME` (a global, process-wide value shared with every other
    /// test binary in this crate).
    fn project_at(store: &mut Store, base: &Path) -> i64 {
        store
            .create_project("proj", None, None, base.to_str(), None)
            .unwrap()
            .id
    }

    #[test]
    fn effective_items_includes_unshadowed_builtin_and_omits_it_once_forked() {
        let (store, _dir) = temp_store();
        let items = effective_items(&store, None).unwrap();
        let found = items
            .iter()
            .find(|i| i.builtin_id.as_deref() == Some("mesa-live"))
            .expect("unshadowed built-in must be reported");
        assert!(found.builtin);
        assert_eq!(found.id, None);
        assert_eq!(found.body, crate::core::live::AGENT_DEFINITION);
        assert_eq!(found.path.as_deref(), Some(".claude/agents/mesa-live.md"));

        let (mut store, _dir) = temp_store();
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::User,
                None,
                "mesa-live",
                "a custom definition",
                Some("mesa-live"),
            )
            .unwrap();
        let items = effective_items(&store, None).unwrap();
        let matches: Vec<_> = items.iter().filter(|i| i.name == "mesa-live").collect();
        assert_eq!(matches.len(), 1, "a fork must shadow, not duplicate");
        assert!(!matches[0].builtin);
        assert_eq!(matches[0].body, "a custom definition");
    }

    #[test]
    fn sync_status_produces_every_status() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let agents_dir = base.join(".claude/agents");
        fs::create_dir_all(&agents_dir).unwrap();

        // mesa-new: a row with no file on disk.
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-mesa-new",
                "new body",
                None,
            )
            .unwrap();

        // disk-deleted: baseline == mesa, but the file is gone.
        let disk_deleted = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-disk-deleted",
                "same body",
                None,
            )
            .unwrap();
        store
            .set_library_synced(disk_deleted.id.unwrap(), "same body")
            .unwrap();

        // mesa-changed: baseline == disk, mesa moved away from it.
        let mesa_changed = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-mesa-changed",
                "baseline body",
                None,
            )
            .unwrap();
        fs::write(agents_dir.join("case-mesa-changed.md"), "baseline body").unwrap();
        store
            .set_library_synced(mesa_changed.id.unwrap(), "baseline body")
            .unwrap();
        store
            .update_library_item(
                mesa_changed.id.unwrap(),
                LibraryPatch {
                    body: Some("new mesa body".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

        // disk-changed: baseline == mesa, disk moved away from it.
        let disk_changed = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-disk-changed",
                "baseline body 2",
                None,
            )
            .unwrap();
        fs::write(agents_dir.join("case-disk-changed.md"), "baseline body 2").unwrap();
        store
            .set_library_synced(disk_changed.id.unwrap(), "baseline body 2")
            .unwrap();
        fs::write(agents_dir.join("case-disk-changed.md"), "disk edited body").unwrap();

        // both-changed: both moved away from the baseline, to different places.
        let both_changed = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-both-changed",
                "baseline body 3",
                None,
            )
            .unwrap();
        fs::write(agents_dir.join("case-both-changed.md"), "baseline body 3").unwrap();
        store
            .set_library_synced(both_changed.id.unwrap(), "baseline body 3")
            .unwrap();
        store
            .update_library_item(
                both_changed.id.unwrap(),
                LibraryPatch {
                    body: Some("mesa edited".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        fs::write(agents_dir.join("case-both-changed.md"), "disk edited").unwrap();

        // in-sync: mesa and disk already agree.
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "case-in-sync",
                "same content",
                None,
            )
            .unwrap();
        fs::write(agents_dir.join("case-in-sync.md"), "same content").unwrap();

        // disk-new: a file with no row at all.
        fs::write(agents_dir.join("case-disk-new.md"), "orphan").unwrap();

        let rows = sync_status(&store, Some(pid)).unwrap();
        let status_of = |name: &str| {
            rows.iter()
                .find(|r| r.name == name)
                .unwrap_or_else(|| panic!("no row for {name}"))
                .status
        };

        assert_eq!(status_of("case-mesa-new"), LibrarySyncStatus::MesaNew);
        assert_eq!(
            status_of("case-disk-deleted"),
            LibrarySyncStatus::DiskDeleted
        );
        assert_eq!(
            status_of("case-mesa-changed"),
            LibrarySyncStatus::MesaChanged
        );
        assert_eq!(
            status_of("case-disk-changed"),
            LibrarySyncStatus::DiskChanged
        );
        assert_eq!(
            status_of("case-both-changed"),
            LibrarySyncStatus::BothChanged
        );
        assert_eq!(status_of("case-in-sync"), LibrarySyncStatus::InSync);
        let disk_new = rows.iter().find(|r| r.name == "case-disk-new").unwrap();
        assert_eq!(disk_new.status, LibrarySyncStatus::DiskNew);
        assert_eq!(disk_new.item_id, None);
        assert_eq!(disk_new.builtin_id, None);
        assert_eq!(disk_new.disk_body.as_deref(), Some("orphan"));
    }

    #[test]
    fn sync_apply_mesa_writes_a_nested_file_and_stamps_the_baseline() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "reviewer body",
                None,
            )
            .unwrap();

        let results = sync_apply(
            &mut store,
            Some(pid),
            &[(".claude/agents/reviewer.md".to_string(), "mesa".to_string())],
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].applied, "{:?}", results[0].error);

        let written = fs::read_to_string(base.join(".claude/agents/reviewer.md")).unwrap();
        assert_eq!(written, "reviewer body");
        let refreshed = store.get_library_item(item.id.unwrap()).unwrap();
        assert_eq!(refreshed.synced_body.as_deref(), Some("reviewer body"));
    }

    #[test]
    fn sync_apply_disk_pulls_the_body_and_appends_a_version() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let agents_dir = base.join(".claude/agents");
        fs::create_dir_all(&agents_dir).unwrap();

        let item = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "baseline body",
                None,
            )
            .unwrap();
        fs::write(agents_dir.join("reviewer.md"), "baseline body").unwrap();
        store
            .set_library_synced(item.id.unwrap(), "baseline body")
            .unwrap();
        fs::write(agents_dir.join("reviewer.md"), "disk edited body").unwrap();

        let results = sync_apply(
            &mut store,
            Some(pid),
            &[(".claude/agents/reviewer.md".to_string(), "disk".to_string())],
        )
        .unwrap();
        assert!(results[0].applied, "{:?}", results[0].error);

        let refreshed = store.get_library_item(item.id.unwrap()).unwrap();
        assert_eq!(refreshed.body, "disk edited body");
        assert_eq!(refreshed.synced_body.as_deref(), Some("disk edited body"));
        let versions = store.list_library_versions(item.id.unwrap()).unwrap();
        assert!(
            versions
                .iter()
                .any(|v| v.source == "sync-pull" && v.body == "disk edited body")
        );
    }

    #[test]
    fn sync_apply_disk_on_disk_deleted_destroys_the_row() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "same body",
                None,
            )
            .unwrap();
        store
            .set_library_synced(item.id.unwrap(), "same body")
            .unwrap();
        // No file was ever written — the classify() input matches disk-deleted.

        let results = sync_apply(
            &mut store,
            Some(pid),
            &[(".claude/agents/reviewer.md".to_string(), "disk".to_string())],
        )
        .unwrap();
        assert!(results[0].applied, "{:?}", results[0].error);
        assert!(matches!(
            store.get_library_item(item.id.unwrap()),
            Err(crate::core::store::Error::NotFound(_))
        ));
    }

    #[test]
    fn sync_apply_one_failing_row_does_not_stop_the_others() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "reviewer body",
                None,
            )
            .unwrap();

        let results = sync_apply(
            &mut store,
            Some(pid),
            &[
                (
                    ".claude/agents/no-such-path.md".to_string(),
                    "mesa".to_string(),
                ),
                (".claude/agents/reviewer.md".to_string(), "mesa".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(results.len(), 2);
        assert!(!results[0].applied);
        assert!(results[0].error.is_some());
        assert!(results[1].applied, "{:?}", results[1].error);
        assert!(base.join(".claude/agents/reviewer.md").exists());
    }

    #[test]
    fn sync_apply_refuses_a_repeated_path_in_one_batch() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "reviewer body",
                None,
            )
            .unwrap();

        let results = sync_apply(
            &mut store,
            Some(pid),
            &[
                (".claude/agents/reviewer.md".to_string(), "mesa".to_string()),
                (".claude/agents/reviewer.md".to_string(), "disk".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].applied, "{:?}", results[0].error);
        assert!(!results[1].applied);
        assert!(results[1].error.is_some());
        // The second, refused resolution must not have clobbered what the
        // first one wrote.
        let written = fs::read_to_string(base.join(".claude/agents/reviewer.md")).unwrap();
        assert_eq!(written, "reviewer body");
    }

    // ---- claude-md path-dedup regression (a scanned file must never
    // duplicate a row an item already reports for the same path) ----

    #[test]
    fn sync_status_does_not_duplicate_the_unshadowed_claude_md_builtin() {
        with_home_dir(|home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(home.join(".claude/CLAUDE.md"), "a different body on disk").unwrap();

            let (store, _dir) = temp_store();
            let rows = sync_status(&store, None).unwrap();
            let matches: Vec<_> = rows
                .iter()
                .filter(|r| r.path == ".claude/CLAUDE.md")
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "expected exactly one row for .claude/CLAUDE.md, got {matches:?}"
            );
            assert_eq!(matches[0].status, LibrarySyncStatus::BothChanged);
            assert_eq!(matches[0].builtin_id.as_deref(), Some("starter-claude-md"));
            assert_eq!(matches[0].item_id, None);
        });
    }

    #[test]
    fn sync_status_does_not_duplicate_a_forked_claude_md_item() {
        with_home_dir(|home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(home.join(".claude/CLAUDE.md"), "a different body on disk").unwrap();

            let (mut store, _dir) = temp_store();
            let forked = store
                .create_library_item(
                    LibraryKind::ClaudeMd,
                    LibraryScope::User,
                    None,
                    "CLAUDE",
                    "a custom claude.md",
                    Some("starter-claude-md"),
                )
                .unwrap();

            let rows = sync_status(&store, None).unwrap();
            let matches: Vec<_> = rows
                .iter()
                .filter(|r| r.path == ".claude/CLAUDE.md")
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "expected exactly one row for .claude/CLAUDE.md, got {matches:?}"
            );
            assert_eq!(matches[0].item_id, forked.id);
            assert_eq!(matches[0].status, LibrarySyncStatus::BothChanged);
        });
    }

    #[test]
    fn sync_status_does_not_duplicate_a_project_scope_claude_md_at_repo_root() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        store
            .create_library_item(
                LibraryKind::ClaudeMd,
                LibraryScope::Project,
                Some(pid),
                "CLAUDE",
                "project claude.md body",
                None,
            )
            .unwrap();
        fs::write(base.join("CLAUDE.md"), "a different body on disk").unwrap();

        let rows = sync_status(&store, Some(pid)).unwrap();
        let matches: Vec<_> = rows.iter().filter(|r| r.path == "CLAUDE.md").collect();
        assert_eq!(
            matches.len(),
            1,
            "expected exactly one row for CLAUDE.md, got {matches:?}"
        );
        assert_eq!(matches[0].status, LibrarySyncStatus::BothChanged);
        assert!(matches[0].item_id.is_some());
    }

    #[test]
    fn sync_status_still_reports_a_genuine_stray_file_as_disk_new() {
        // The regression the fix above must not introduce: a file nothing
        // claims is still discovered, so the fix is a dedup, not a
        // suppression.
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        fs::write(base.join(".claude/agents/orphan.md"), "orphan body").unwrap();

        let rows = sync_status(&store, Some(pid)).unwrap();
        let orphan = rows
            .iter()
            .find(|r| r.path == ".claude/agents/orphan.md")
            .expect("a genuinely unclaimed file must still produce a disk-new row");
        assert_eq!(orphan.status, LibrarySyncStatus::DiskNew);
        assert_eq!(orphan.item_id, None);
        assert_eq!(orphan.builtin_id, None);
    }

    #[test]
    fn sync_status_never_reports_two_rows_for_the_same_path() {
        // The general property that actually matters, over a realistic tree
        // spanning both scopes at once: a project with its own agent and
        // claude-md, the user-scope claude-md built-in (untouched, so it
        // stays unshadowed), a stray disk-new file on each scope, and a
        // forked live-summary-prompt (a `prompt`, which has no path at all
        // and so must contribute no row).
        with_home_dir(|home| {
            fs::create_dir_all(home.join(".claude/agents")).unwrap();
            fs::write(home.join(".claude/CLAUDE.md"), "home claude md").unwrap();
            fs::write(home.join(".claude/agents/stray-home.md"), "stray").unwrap();

            let (mut store, dir) = temp_store();
            let base = dir.path().to_path_buf();
            let pid = project_at(&mut store, &base);
            fs::create_dir_all(base.join(".claude/agents")).unwrap();

            store
                .create_library_item(
                    LibraryKind::Agent,
                    LibraryScope::Project,
                    Some(pid),
                    "reviewer",
                    "reviewer body",
                    None,
                )
                .unwrap();
            fs::write(base.join(".claude/agents/reviewer.md"), "reviewer body").unwrap();
            store
                .create_library_item(
                    LibraryKind::ClaudeMd,
                    LibraryScope::Project,
                    Some(pid),
                    "CLAUDE",
                    "project claude.md",
                    None,
                )
                .unwrap();
            fs::write(base.join(".claude/agents/stray-project.md"), "stray").unwrap();
            store
                .create_library_item(
                    LibraryKind::Prompt,
                    LibraryScope::User,
                    None,
                    "live-summary-prompt",
                    "a forked prompt",
                    Some("live-summary-prompt"),
                )
                .unwrap();

            let rows = sync_status(&store, Some(pid)).unwrap();
            assert!(!rows.is_empty());
            let mut paths = HashSet::new();
            for row in &rows {
                assert!(
                    paths.insert(row.path.clone()),
                    "path {:?} appeared more than once in sync_status: {rows:#?}",
                    row.path
                );
            }
            assert!(rows.iter().all(|r| r.kind != LibraryKind::Prompt));
        });
    }

    // ---- item-vs-item path-dedup regression (mesa task 1116: a db row that
    // shadows a built-in by name, not by `builtin_id`, must not leave the
    // built-in claiming the same file) ----

    /// A db row sharing a built-in's `(kind, scope, name)` with no
    /// `builtin_id` is an *override*, not a fork, so `effective_items` still
    /// reports both — and both resolve to one path. Exactly one sync row may
    /// come out of that, and the loop must actually settle: `sync_apply`
    /// resolves a path against the first row carrying it, so a second row for
    /// the same file is unreachable and re-appears on every scan forever.
    #[test]
    fn sync_status_folds_a_builtin_a_db_row_overrides_by_name() {
        with_home_dir(|home| {
            let agents = home.join(".claude/agents");
            fs::create_dir_all(&agents).unwrap();
            fs::write(agents.join("supervisor.md"), "a body on disk").unwrap();

            let (mut store, _dir) = temp_store();
            let overriding = store
                .create_library_item(
                    LibraryKind::Agent,
                    LibraryScope::User,
                    None,
                    // The built-in's own name, with no `builtin_id`: an
                    // override adopted from disk by a sync, never a fork.
                    crate::core::supervisor::SUPERVISOR_AGENT_BUILTIN,
                    "the overriding body",
                    None,
                )
                .unwrap();
            assert_eq!(overriding.builtin_id, None);
            // The premise: the built-in is still in the catalogue, since
            // nothing carries its id. Folding happens in the sync layer alone,
            // so the Library page keeps both rows to fold client-side.
            let items = effective_items(&store, None).unwrap();
            assert_eq!(
                items
                    .iter()
                    .filter(|i| i.name == crate::core::supervisor::SUPERVISOR_AGENT_BUILTIN)
                    .count(),
                2,
            );

            let path = ".claude/agents/supervisor.md";
            let rows = sync_status(&store, None).unwrap();
            let matches: Vec<_> = rows.iter().filter(|r| r.path == path).collect();
            assert_eq!(
                matches.len(),
                1,
                "expected exactly one row for {path}, got {matches:?}"
            );
            assert_eq!(
                matches[0].item_id, overriding.id,
                "the stored row outranks the built-in it overrides"
            );
            assert_eq!(matches[0].status, LibrarySyncStatus::BothChanged);

            // ...and the loop settles: one resolution reaches the one row.
            let results =
                sync_apply(&mut store, None, &[(path.to_string(), "mesa".to_string())]).unwrap();
            assert_eq!(results.len(), 1);
            assert!(results[0].applied, "{:?}", results[0].error);

            for pass in 1..=2 {
                let rows = sync_status(&store, None).unwrap();
                let matches: Vec<_> = rows.iter().filter(|r| r.path == path).collect();
                assert_eq!(matches.len(), 1, "pass {pass}: {matches:?}");
                assert_eq!(
                    matches[0].status,
                    LibrarySyncStatus::InSync,
                    "pass {pass}: the sync never settled"
                );
            }
            assert_eq!(
                fs::read_to_string(agents.join("supervisor.md")).unwrap(),
                "the overriding body"
            );
        });
    }
    /// The same defect between two *stored* rows, needing no built-in at all:
    /// a `claude-md`'s path does not depend on its name (`relative_path`), so
    /// any two of them in one scope resolve to the same file. Whichever row
    /// wins, exactly one may reach the sync table.
    #[test]
    fn sync_status_folds_two_claude_md_rows_sharing_one_path() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        for name in ["CLAUDE", "AGENTS"] {
            store
                .create_library_item(
                    LibraryKind::ClaudeMd,
                    LibraryScope::Project,
                    Some(pid),
                    name,
                    &format!("{name} body"),
                    None,
                )
                .unwrap();
        }
        fs::write(base.join("CLAUDE.md"), "a different body on disk").unwrap();

        let rows = sync_status(&store, Some(pid)).unwrap();
        let matches: Vec<_> = rows.iter().filter(|r| r.path == "CLAUDE.md").collect();
        assert_eq!(
            matches.len(),
            1,
            "expected exactly one row for CLAUDE.md, got {matches:?}"
        );
        // Both are stored rows, so rank does not separate them and
        // `effective_items`' own order — kind, then name case-insensitively —
        // decides, deterministically.
        assert_eq!(matches[0].name, "AGENTS");
    }

    // ---- export / import (mesa task 963) ----

    #[test]
    fn export_omits_unshadowed_builtins_but_includes_a_forked_one() {
        let (mut store, _dir) = temp_store();
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::User,
                None,
                "mesa-live",
                "a custom definition",
                Some("mesa-live"),
            )
            .unwrap();

        let bundle = export(&store, None).unwrap();
        assert_eq!(bundle.version, BUNDLE_VERSION);

        let forked = bundle
            .items
            .iter()
            .find(|i| i.name == "mesa-live")
            .expect("a forked built-in must be exported");
        assert_eq!(forked.builtin_id.as_deref(), Some("mesa-live"));
        assert_eq!(forked.body, "a custom definition");

        // live-summary-prompt was never forked, so it must not appear at all.
        assert!(
            bundle.items.iter().all(|i| i.name != "live-summary-prompt"),
            "an unshadowed built-in must never be exported: {:?}",
            bundle.items
        );
    }

    #[test]
    fn export_omits_the_sync_baseline() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "mesa body",
                None,
            )
            .unwrap();
        // Diverge the baseline from the mesa body to prove it never leaks in
        // — the bundle item type itself carries no synced_body/synced_at
        // field, so this asserts the exported *content* too.
        store
            .set_library_synced(item.id.unwrap(), "a stale baseline body")
            .unwrap();

        let bundle = export(&store, Some(pid)).unwrap();
        let exported = bundle.items.iter().find(|i| i.name == "reviewer").unwrap();
        assert_eq!(exported.body, "mesa body");
    }

    #[test]
    fn export_names_the_project_for_a_project_scoped_item() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "reviewer body",
                None,
            )
            .unwrap();
        store
            .create_library_item(
                LibraryKind::Hook,
                LibraryScope::User,
                None,
                "my-hook",
                "hook body",
                None,
            )
            .unwrap();

        let bundle = export(&store, Some(pid)).unwrap();

        let project_item = bundle.items.iter().find(|i| i.name == "reviewer").unwrap();
        assert_eq!(project_item.scope, LibraryScope::Project);
        assert_eq!(project_item.project.as_deref(), Some("proj"));

        let user_item = bundle.items.iter().find(|i| i.name == "my-hook").unwrap();
        assert_eq!(user_item.scope, LibraryScope::User);
        assert_eq!(user_item.project, None);
    }

    fn bundle_of(items: Vec<LibraryBundleItem>) -> LibraryBundle {
        LibraryBundle {
            version: BUNDLE_VERSION,
            exported_at: "2026-01-01T00:00:00".to_string(),
            items,
        }
    }

    #[test]
    fn import_creates_then_skips_then_replaces() {
        let (mut store, _dir) = temp_store();
        let bundle = bundle_of(vec![LibraryBundleItem {
            name: "my-hook".to_string(),
            kind: LibraryKind::Hook,
            scope: LibraryScope::User,
            project: None,
            body: "original body".to_string(),
            builtin_id: None,
        }]);

        let results = import(&mut store, &bundle, "skip").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, "created");
        let id = results[0].item_id.expect("a created row has an id");
        assert_eq!(store.get_library_item(id).unwrap().body, "original body");

        // A second import with the default policy leaves it entirely untouched.
        let results = import(&mut store, &bundle, "skip").unwrap();
        assert_eq!(results[0].status, "skipped");
        assert_eq!(results[0].item_id, Some(id));
        assert_eq!(store.get_library_item(id).unwrap().body, "original body");

        // Re-import with `replace` after the source changed updates the body.
        let mut changed = bundle;
        changed.items[0].body = "new body".to_string();
        let results = import(&mut store, &changed, "replace").unwrap();
        assert_eq!(results[0].status, "replaced");
        assert_eq!(results[0].item_id, Some(id));
        assert_eq!(store.get_library_item(id).unwrap().body, "new body");
    }

    #[test]
    fn import_fails_only_the_item_with_an_unknown_project() {
        let (mut store, _dir) = temp_store();
        let bundle = bundle_of(vec![
            LibraryBundleItem {
                name: "reviewer".to_string(),
                kind: LibraryKind::Agent,
                scope: LibraryScope::Project,
                project: Some("no-such-project".to_string()),
                body: "reviewer body".to_string(),
                builtin_id: None,
            },
            LibraryBundleItem {
                name: "my-hook".to_string(),
                kind: LibraryKind::Hook,
                scope: LibraryScope::User,
                project: None,
                body: "hook body".to_string(),
                builtin_id: None,
            },
        ]);

        let results = import(&mut store, &bundle, "skip").unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].status, "failed");
        assert!(results[0].error.is_some());
        assert_eq!(results[1].status, "created");
    }

    #[test]
    fn import_refuses_an_unknown_bundle_version_whole() {
        let (mut store, _dir) = temp_store();
        let bundle = bundle_of(vec![LibraryBundleItem {
            name: "my-hook".to_string(),
            kind: LibraryKind::Hook,
            scope: LibraryScope::User,
            project: None,
            body: "hook body".to_string(),
            builtin_id: None,
        }]);
        let mut unknown_version = bundle;
        unknown_version.version = 99;

        let err = import(&mut store, &unknown_version, "skip").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(
            store
                .list_library_items(None)
                .unwrap()
                .iter()
                .all(|i| i.name != "my-hook"),
            "nothing must be written when the whole bundle is refused"
        );
    }

    #[test]
    fn import_rejects_an_unknown_on_conflict_value_for_the_whole_call() {
        let (mut store, _dir) = temp_store();
        let bundle = bundle_of(vec![LibraryBundleItem {
            name: "my-hook".to_string(),
            kind: LibraryKind::Hook,
            scope: LibraryScope::User,
            project: None,
            body: "hook body".to_string(),
            builtin_id: None,
        }]);

        let err = import(&mut store, &bundle, "merge").unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(store.list_library_items(None).unwrap().is_empty());
    }

    #[test]
    fn import_fails_only_the_item_with_a_bad_name() {
        let (mut store, _dir) = temp_store();
        let bundle = bundle_of(vec![
            LibraryBundleItem {
                name: "../evil".to_string(),
                kind: LibraryKind::Hook,
                scope: LibraryScope::User,
                project: None,
                body: "evil body".to_string(),
                builtin_id: None,
            },
            LibraryBundleItem {
                name: "my-hook".to_string(),
                kind: LibraryKind::Hook,
                scope: LibraryScope::User,
                project: None,
                body: "hook body".to_string(),
                builtin_id: None,
            },
        ]);

        let results = import(&mut store, &bundle, "skip").unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].status, "failed");
        assert!(results[0].error.is_some());
        assert_eq!(results[1].status, "created");
    }

    // ---- hook registration in `.claude/settings.json` (mesa task 1115) ----

    fn hook_item(store: &mut Store, pid: i64, name: &str) -> LibraryItem {
        store
            .create_library_item(
                LibraryKind::Hook,
                LibraryScope::Project,
                Some(pid),
                name,
                "#!/bin/sh\necho hi\n",
                None,
            )
            .unwrap()
    }

    /// Stands in for `command_runs_hook` in the raw-text splice tests, which
    /// have no `Store` and no `HookTarget` — the splice only ever asks "is
    /// this command string ours?", so that is the whole of what it needs.
    fn ours(command: &str) -> bool {
        command.contains(".claude/hooks/stop-notify.sh")
    }

    const MINE: &str = "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh";

    fn enable(raw: &str, event: &str, matcher: &str) -> String {
        splice_register(raw, event, matcher, MINE, &ours)
            .unwrap()
            .expect("this registration is not already present")
    }

    fn disable_all(raw: &str) -> String {
        splice_unregister(raw, None, None, &ours)
            .unwrap()
            .expect("there was something to remove")
    }

    #[test]
    fn enabling_under_one_event_leaves_another_events_span_byte_identical() {
        let other = "    \"PreToolUse\": [\n      {\"matcher\": \"Bash\", \"hooks\": \
                     [{\"type\": \"command\", \"command\": \"guard.py\"}]}\n    ]";
        let raw = format!(
            "{{\n  \"model\": \"opus\",\n  \"hooks\": {{\n{other},\n    \"Stop\": [\n      \
             {{\"matcher\": \"*\", \"hooks\": [{{\"type\": \"command\", \"command\": \
             \"other.sh\"}}]}}\n    ]\n  }}\n}}\n"
        );
        let out = enable(&raw, "Stop", "*");

        assert!(
            out.contains(other),
            "the untouched event must not move a byte:\n{out}"
        );
        assert!(
            out.starts_with("{\n  \"model\": \"opus\",\n  \"hooks\": {\n"),
            "{out}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn disabling_one_entry_leaves_its_siblings_byte_identical() {
        // Deliberately non-standard: `command` before `type`, odd spacing, and
        // no `matcher` key at all. None of it may be normalized.
        let first = "{ \"command\":\"first.sh\",   \"type\":\"command\" }";
        let third = "{\"type\":\"command\",\"command\":\"third.sh\",\"timeout\":5}";
        let raw = format!(
            "{{\n  \"hooks\": {{\n    \"Stop\": [\n      {{\n        \"hooks\": [\n          \
             {first},\n          {{\"type\": \"command\", \"command\": \"{MINE}\"}},\n          \
             {third}\n        ]\n      }}\n    ]\n  }}\n}}\n"
        );
        let out = disable_all(&raw);

        assert!(out.contains(first), "sibling reformatted:\n{out}");
        assert!(out.contains(third), "sibling reformatted:\n{out}");
        assert!(!out.contains("stop-notify"), "{out}");
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        let commands = parsed["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[1]["timeout"], 5);
    }

    #[test]
    fn an_existing_groups_key_order_survives_an_unrelated_enable() {
        // `matcher` before `hooks` — the opposite of the order mesa writes,
        // and of the alphabetical order a reserialization would impose.
        let group = "{\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \
                     \"command\": \"guard.py\"}]}";
        let raw =
            format!("{{\n  \"hooks\": {{\n    \"PreToolUse\": [\n      {group}\n    ]\n  }}\n}}\n");
        let out = enable(&raw, "Stop", "*");

        assert!(
            out.contains(group),
            "an unrelated group must keep its own key order:\n{out}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(parsed["hooks"]["Stop"].is_array());
    }

    #[test]
    fn enable_then_disable_returns_the_file_byte_identical() {
        // The acceptance property, at all three depths a registration can be
        // introduced: into an existing group, as a new group under an
        // existing event, and as a new event under an existing `hooks` key —
        // plus the case where the `hooks` key itself has to be created.
        let with_hooks = "{\n  \"model\": \"opus\",\n  \"hooks\": {\n    \"Stop\": [\n      \
                          {\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \
                          \"command\": \"other.sh\"}]}\n    ]\n  },\n  \"env\": {\"FOO\": \
                          \"bar\"}\n}\n";
        for (raw, event, matcher) in [
            // Into the existing group.
            (with_hooks, "Stop", "Bash"),
            // A new group under the existing event.
            (with_hooks, "Stop", "*"),
            // A new event under the existing `hooks` key.
            (with_hooks, "SessionStart", "*"),
            // A whole new `hooks` key.
            ("{\n  \"model\": \"opus\"\n}\n", "Stop", "*"),
            // And a single-line file, where the splice must not open it out.
            (
                "{\"model\":\"opus\",\"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":                 [{\"type\":\"command\",\"command\":\"other.sh\"}]}]}}",
                "Stop",
                "*",
            ),
        ] {
            let enabled = enable(raw, event, matcher);
            assert_ne!(enabled, raw, "enable did nothing for {event}/{matcher}");
            let back = disable_all(&enabled);
            assert_eq!(
                back, raw,
                "enable({event}, {matcher}) then disable must be a round trip\n\
                 after enable:\n{enabled}"
            );
        }
    }

    #[test]
    fn a_container_that_was_already_empty_does_not_survive_the_round_trip() {
        // The one shape where enable-then-disable is NOT byte-identical, and
        // deliberately so: a group whose command list was *already* empty.
        // Disabling drops a group it empties, and within a single call it
        // cannot tell "empty because mesa just removed its last command" from
        // "empty before mesa ever touched it" — the two have identical input
        // state. Cleaning up the vacuous group is the documented behaviour and
        // the more useful one, so the round trip yields to it here.
        let raw = "{\"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":[]}]}}";
        let back = disable_all(&enable(raw, "Stop", "*"));
        assert_eq!(back, "{}", "the emptied group, event and hooks key all go");
    }

    #[test]
    fn a_single_line_container_stays_on_one_line() {
        let raw = "{\"hooks\":{\"Stop\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\
                   \"command\":\"other.sh\"}]}]}}";
        let out = enable(raw, "Stop", "*");
        assert!(
            !out.contains('\n'),
            "a one-line file must stay one line:\n{out}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            parsed["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn the_cut_escalates_only_as_far_as_it_must() {
        // A group holding only our command loses the group, not its contents.
        let raw = format!(
            "{{\n  \"model\": \"opus\",\n  \"hooks\": {{\n    \"Stop\": [\n      \
             {{\"matcher\": \"Bash\", \"hooks\": [{{\"type\": \"command\", \"command\": \
             \"other.sh\"}}]}},\n      {{\"matcher\": \"*\", \"hooks\": [{{\"type\": \
             \"command\", \"command\": \"{MINE}\"}}]}}\n    ]\n  }},\n  \"env\": 1\n}}\n"
        );
        let out = disable_all(&raw);
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(out.contains("{\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \"command\": \"other.sh\"}]}"), "{out}");

        // The last event under `hooks` losing its last group takes the whole
        // `hooks` key with it, and nothing else in the file moves.
        let raw = "{\n  \"model\": \"opus\",\n  \"hooks\": {\n    \"Stop\": [\n      \
                   {\"matcher\": \"*\", \"hooks\": [{\"type\": \"command\", \"command\": \
                   \"$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh\"}]}\n    ]\n  },\n  \
                   \"env\": 1\n}\n";
        assert_eq!(
            disable_all(raw),
            "{\n  \"model\": \"opus\",\n  \"env\": 1\n}\n"
        );

        // Hooks as the only top-level key collapses the object.
        let raw = "{\n  \"hooks\": {\"Stop\": [{\"matcher\": \"*\", \"hooks\": [{\"type\": \
                   \"command\", \"command\": \".claude/hooks/stop-notify.sh\"}]}]}\n}\n";
        assert_eq!(disable_all(raw), "{}\n");
    }

    #[test]
    fn the_scanner_walks_past_braces_and_commas_inside_strings() {
        // The locator tracks string state, so a `}` or a literal `"hooks"`
        // inside a value never terminates the entry it sits in.
        let greeting = "  \"greeting\": \"} , \\\"hooks\\\": no\"";
        let raw = format!("{{\n{greeting},\n  \"model\": \"opus\"\n}}\n");
        let out = enable(&raw, "Stop", "*");
        assert!(out.contains(greeting), "{out}");
        let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["greeting"], "} , \"hooks\": no");
        assert_eq!(parsed["model"], "opus");
        assert!(parsed["hooks"]["Stop"].is_array());
    }

    #[test]
    fn an_empty_or_absent_file_gets_a_fresh_document() {
        // The one shape with no bytes to preserve.
        for raw in ["", "   \n"] {
            let out = enable(raw, "Stop", "*");
            let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(parsed.as_object().unwrap().len(), 1, "{out}");
            assert_eq!(parsed["hooks"]["Stop"][0]["hooks"][0]["command"], MINE);
            assert_eq!(splice_unregister(raw, None, None, &ours).unwrap(), None);
        }
        // `{}` still goes through the splice: the braces are real bytes, and
        // an inline container stays inline.
        let out = enable("{}\n", "Stop", "*");
        assert!(!out.trim_end().contains('\n'), "{out}");
        assert_eq!(disable_all(&out), "{}\n");
        // A container already opened out keeps its shape instead.
        let out = enable("{\n}\n", "Stop", "*");
        assert!(out.starts_with("{\n  \"hooks\": {"), "{out}");
    }

    #[test]
    fn a_registration_already_present_is_not_written_twice() {
        let raw = format!(
            "{{\"hooks\":{{\"Stop\":[{{\"matcher\":\"*\",\"hooks\":[{{\"type\":\"command\",\
             \"command\":\"bash {MINE} --quiet\"}}]}}]}}}}"
        );
        // A hand-written command naming this hook counts as registered, so
        // there is nothing to add.
        assert_eq!(
            splice_register(&raw, "Stop", "*", MINE, &ours).unwrap(),
            None
        );
        // And removing something that is not there changes nothing.
        assert_eq!(
            splice_unregister("{\"model\": 1}", None, None, &ours).unwrap(),
            None
        );
    }

    #[test]
    fn a_settings_file_mesa_cannot_parse_is_refused_rather_than_clobbered() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();

        for bad in [
            "{ not json",
            "[1, 2, 3]",
            "{\"hooks\": \"nope\"}",
            "{\"hooks\": {\"Stop\": 7}}",
        ] {
            fs::write(&settings, bad).unwrap();
            let err = register_hook(&store, &item, "Stop", None).unwrap_err();
            assert!(
                matches!(err, Error::Validation(ref m) if m.contains("settings.json")),
                "{bad:?} produced {err:?}"
            );
            assert_eq!(
                fs::read_to_string(&settings).unwrap(),
                bad,
                "a file mesa could not understand must be left exactly as it was"
            );
        }
    }

    #[test]
    fn registering_is_idempotent_and_does_not_rewrite_the_file() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");

        let status = register_hook(&store, &item, "Stop", None).unwrap();
        assert!(status.registered);
        assert_eq!(status.registrations.len(), 1);
        assert_eq!(status.registrations[0].event, "Stop");
        assert_eq!(status.registrations[0].matcher, "*");
        assert_eq!(
            status.command,
            "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh"
        );
        // `resolve` canonicalizes, so compare canonical to canonical (macOS
        // resolves a temp dir through `/private`).
        assert_eq!(
            fs::canonicalize(&status.settings_path).unwrap(),
            fs::canonicalize(&settings).unwrap()
        );
        let first = fs::read_to_string(&settings).unwrap();

        let again = register_hook(&store, &item, "Stop", None).unwrap();
        assert_eq!(again.registrations.len(), 1, "no duplicate entry");
        assert_eq!(
            fs::read_to_string(&settings).unwrap(),
            first,
            "a registration that changes nothing must not rewrite the file"
        );

        // And the read agrees with what the write reported.
        let read = hook_registrations(&store, &item).unwrap();
        assert_eq!(read.registrations, again.registrations);
        assert_eq!(
            read.events,
            HOOK_EVENTS
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn registering_appends_into_an_existing_group_with_the_same_matcher() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            "{\n  \"hooks\": {\n    \"Stop\": [\n      {\"matcher\": \"*\", \"hooks\": \
             [{\"type\": \"command\", \"command\": \"someone-elses.sh\"}]}\n    ]\n  }\n}\n",
        )
        .unwrap();

        register_hook(&store, &item, "Stop", None).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        let groups = parsed["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "one matcher means one group: {parsed:#}");
        let commands = groups[0]["hooks"].as_array().unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0]["command"], "someone-elses.sh");
        assert_eq!(
            commands[1]["command"],
            "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh"
        );

        // A different matcher IS a second group.
        register_hook(&store, &item, "Stop", Some("Bash")).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(parsed["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn disabling_cleans_up_the_group_the_event_and_the_hooks_key() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{\n  \"model\": \"opus\"\n}\n").unwrap();

        register_hook(&store, &item, "Stop", None).unwrap();
        register_hook(&store, &item, "SessionStart", Some("startup")).unwrap();
        assert_eq!(
            hook_registrations(&store, &item)
                .unwrap()
                .registrations
                .len(),
            2
        );

        // Narrowed to one event: the other survives, the emptied event key goes.
        let status = unregister_hook(&store, &item, Some("Stop"), None).unwrap();
        assert_eq!(status.registrations.len(), 1);
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(parsed["hooks"].get("Stop").is_none(), "{parsed:#}");
        assert!(parsed["hooks"].get("SessionStart").is_some());

        // The last one: the `hooks` key itself goes, and `model` is untouched.
        let status = unregister_hook(&store, &item, None, None).unwrap();
        assert!(!status.registered);
        assert!(status.registrations.is_empty());
        assert_eq!(
            fs::read_to_string(&settings).unwrap(),
            "{\n  \"model\": \"opus\"\n}\n",
            "the file must come back to exactly what it was"
        );

        // Disabling something that was never registered is a no-op success.
        let status = unregister_hook(&store, &item, None, None).unwrap();
        assert!(!status.registered);
        assert_eq!(
            fs::read_to_string(&settings).unwrap(),
            "{\n  \"model\": \"opus\"\n}\n"
        );
    }

    #[test]
    fn disabling_keeps_a_group_that_still_holds_someone_elses_command() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            "{\"hooks\": {\"Stop\": [{\"matcher\": \"*\", \"hooks\": \
             [{\"type\": \"command\", \"command\": \"someone-elses.sh\"}]}]}}",
        )
        .unwrap();

        register_hook(&store, &item, "Stop", None).unwrap();
        unregister_hook(&store, &item, None, None).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        let commands = parsed["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["command"], "someone-elses.sh");
    }

    #[test]
    fn an_unknown_event_is_validation_and_writes_nothing() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");

        for bad in ["SessionStarted", "stop", ""] {
            let err = register_hook(&store, &item, bad, None).unwrap_err();
            assert!(matches!(err, Error::Validation(_)), "{bad:?} -> {err:?}");
        }
        assert!(
            !settings.exists(),
            "a refused call must not create the file"
        );

        // A matcher with a newline, and an over-long one, are refused too.
        assert!(matches!(
            register_hook(&store, &item, "Stop", Some("a\nb")).unwrap_err(),
            Error::Validation(_)
        ));
        let long = "x".repeat(HOOK_MATCHER_MAX + 1);
        assert!(matches!(
            register_hook(&store, &item, "Stop", Some(&long)).unwrap_err(),
            Error::Validation(_)
        ));
        assert!(!settings.exists());
    }

    #[test]
    fn only_a_hook_item_has_a_registration() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let agent = store
            .create_library_item(
                LibraryKind::Agent,
                LibraryScope::Project,
                Some(pid),
                "reviewer",
                "body",
                None,
            )
            .unwrap();
        for err in [
            hook_registrations(&store, &agent).unwrap_err(),
            register_hook(&store, &agent, "Stop", None).unwrap_err(),
            unregister_hook(&store, &agent, None, None).unwrap_err(),
        ] {
            assert!(
                matches!(err, Error::Validation(ref m) if m.contains("only a hook")),
                "{err:?}"
            );
        }
    }

    #[test]
    fn a_project_scope_hook_with_no_local_path_says_so() {
        let (mut store, _dir) = temp_store();
        let pid = store
            .create_project("nowhere", None, None, None, None)
            .unwrap()
            .id;
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let err = hook_registrations(&store, &item).unwrap_err();
        assert!(
            matches!(err, Error::Validation(ref m) if m.contains("local path")),
            "{err:?}"
        );
    }

    #[test]
    fn a_command_is_this_hooks_only_at_a_path_boundary() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "oo.sh");
        let target = hook_target(&store, &item).unwrap();

        // Exact, wrapped in a shell line, and the absolute path all count.
        assert!(command_runs_hook(
            "$CLAUDE_PROJECT_DIR/.claude/hooks/oo.sh",
            &target
        ));
        assert!(command_runs_hook(
            "bash $CLAUDE_PROJECT_DIR/.claude/hooks/oo.sh --quiet",
            &target
        ));
        assert!(command_runs_hook(&target.absolute, &target));

        // A longer filename that merely *ends* with this one does not.
        assert!(!command_runs_hook(
            "$CLAUDE_PROJECT_DIR/.claude/hooks/foo.sh",
            &target
        ));
        // Nor does a suffixed one.
        assert!(!command_runs_hook(
            "$CLAUDE_PROJECT_DIR/.claude/hooks/oo.sh.bak",
            &target
        ));
        // Nor an unrelated directory that happens to end in the same chars.
        assert!(!command_runs_hook("my.claude/hooks/oo.sh", &target));
        assert!(!command_runs_hook("echo done", &target));
    }

    #[test]
    fn a_hand_written_command_naming_this_hook_reads_as_registered() {
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            "{\"hooks\": {\"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \
             \"bash .claude/hooks/stop-notify.sh --quiet\"}]}]}}",
        )
        .unwrap();

        let status = hook_registrations(&store, &item).unwrap();
        assert!(status.registered);
        // A group with no `matcher` key is reported (and matched) as `*`.
        assert_eq!(status.registrations[0].matcher, "*");
        assert_eq!(
            status.registrations[0].command,
            "bash .claude/hooks/stop-notify.sh --quiet"
        );

        // Which means enabling it again appends nothing, and disabling
        // removes the hand-written line.
        register_hook(&store, &item, "Stop", None).unwrap();
        assert_eq!(
            hook_registrations(&store, &item)
                .unwrap()
                .registrations
                .len(),
            1
        );
        let status = unregister_hook(&store, &item, None, None).unwrap();
        assert!(!status.registered);
    }

    #[test]
    fn a_null_hooks_value_is_treated_as_an_absent_one() {
        // `parse_settings` reads `"hooks": null` as an empty map, so a splice
        // that refused it would make a file mesa's own parser calls valid
        // permanently un-editable — and would turn the documented no-op
        // success of an unnecessary disable into exit 1.
        for raw in [
            "{\"hooks\": null, \"model\": \"opus\"}",
            "{\n  \"hooks\": null,\n  \"model\": \"opus\"\n}\n",
        ] {
            assert_eq!(
                splice_unregister(raw, None, None, &ours).unwrap(),
                None,
                "a null hooks holds no registration to cut"
            );
            let out = enable(raw, "Stop", "*");
            let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(parsed["model"], "opus", "{out}");
            assert_eq!(parsed["hooks"]["Stop"][0]["hooks"][0]["command"], MINE);
            // And the round trip still holds: what was written is removable.
            let back = disable_all(&out);
            let parsed: serde_json::Value = serde_json::from_str(&back).unwrap();
            assert_eq!(parsed["model"], "opus", "{back}");
            assert!(parsed.get("hooks").is_none(), "{back}");
        }
    }

    #[test]
    fn enabling_seeds_the_hook_script_when_it_is_not_on_disk_and_never_overwrites() {
        // A library row — a built-in or a fork — reaches the disk only when
        // the user runs a sync, so without the seed the registration would
        // name a file that does not exist and Claude Code would fail the hook
        // every session.
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let script = base.join(".claude/hooks/stop-notify.sh");
        assert!(!script.exists());

        register_hook(&store, &item, "Stop", None).unwrap();
        assert_eq!(fs::read_to_string(&script).unwrap(), item.body);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "a hook is a script, not a document");
        }

        // After the first seed the file belongs to the sync flow, exactly as
        // `ensure_agent_file`'s does.
        fs::write(&script, "#!/bin/sh\n# edited by hand\n").unwrap();
        unregister_hook(&store, &item, None, None).unwrap();
        register_hook(&store, &item, "SessionEnd", None).unwrap();
        assert_eq!(
            fs::read_to_string(&script).unwrap(),
            "#!/bin/sh\n# edited by hand\n"
        );
    }

    #[test]
    fn unregister_narrows_to_a_matcher_register_would_have_refused() {
        // On the unregister path the matcher is a filter naming what to cut,
        // never text mesa writes — so a matcher already in the file, however
        // it got there, stays reachable. The web UI's per-row disable button
        // posts `reg.matcher` verbatim, straight from the file.
        let (mut store, dir) = temp_store();
        let base = dir.path().to_path_buf();
        let pid = project_at(&mut store, &base);
        let item = hook_item(&mut store, pid, "stop-notify.sh");
        let settings = base.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let long = "x".repeat(HOOK_MATCHER_MAX + 50);
        fs::write(
            &settings,
            format!(
                "{{\"hooks\":{{\"Stop\":[{{\"matcher\":\"{long}\",\"hooks\":                 [{{\"type\":\"command\",\"command\":\"{}\"}}]}}]}}}}",
                "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-notify.sh"
            ),
        )
        .unwrap();

        let status = unregister_hook(&store, &item, Some("Stop"), Some(&long)).unwrap();
        assert!(!status.registered, "{status:?}");
        // The same value on the way *in* is still refused: that rule is about
        // what mesa writes.
        assert!(matches!(
            register_hook(&store, &item, "Stop", Some(&long)),
            Err(Error::Validation(_))
        ));
    }
}
