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

use crate::core::store::{Error, LibraryPatch, Result as StoreResult, Store};
use crate::core::types::{
    LibraryBundle, LibraryBundleItem, LibraryImportResult, LibraryItem, LibraryKind, LibraryScope,
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
        name: "stop-notify",
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
pub fn relative_path(kind: LibraryKind, scope: LibraryScope, name: &str) -> Option<PathBuf> {
    match kind {
        LibraryKind::Agent => Some(PathBuf::from(format!(".claude/agents/{name}.md"))),
        LibraryKind::Skill => Some(PathBuf::from(format!(".claude/skills/{name}/SKILL.md"))),
        LibraryKind::Hook => Some(PathBuf::from(format!(".claude/hooks/{name}.sh"))),
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
/// `(kind, name, body)` for every file found. The caller already knows which
/// scope `base` is for and so which of the two CLAUDE.md hits is the real
/// one; scanning both costs nothing since at most one is ever present in
/// practice. Bounded on purpose: it skips anything over [`SCAN_MAX_BYTES`],
/// skips non-UTF-8 files, and does not recurse arbitrarily — agents,
/// commands and hooks are one level of `.md`/`.sh` files, skills is exactly
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
pub fn scan_disk(base: &Path) -> Vec<(LibraryKind, String, String)> {
    let mut found = Vec::new();

    let safe_dir = |rel: &str| -> Option<PathBuf> { resolve(base, Path::new(rel)).ok() };

    let leaf_dir = |sub: &str, kind: LibraryKind, ext: &str, found: &mut Vec<_>| {
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
            if path.extension().and_then(|e| e.to_str()) != Some(ext) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(body) = read_bounded(&path) {
                found.push((kind, stem.to_string(), body));
            }
        }
    };

    leaf_dir("agents", LibraryKind::Agent, "md", &mut found);
    leaf_dir("commands", LibraryKind::Command, "md", &mut found);
    leaf_dir("hooks", LibraryKind::Hook, "sh", &mut found);

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
            if let Some(body) = read_bounded(&skill_md) {
                found.push((LibraryKind::Skill, name, body));
            }
        }
    }

    // CLAUDE.md's "name" is fixed — there is exactly one per scope, matching
    // `Builtin::name` for `starter-claude-md`.
    for rel in [".claude/CLAUDE.md", "CLAUDE.md"] {
        let Some(path) = safe_dir(rel) else {
            continue;
        };
        if let Some(body) = read_bounded(&path) {
            found.push((LibraryKind::ClaudeMd, "CLAUDE".to_string(), body));
        }
    }

    found
}

/// Reads a file's contents, refusing anything over [`SCAN_MAX_BYTES`], a
/// symlink, or non-UTF-8 bytes rather than failing the whole scan.
fn read_bounded(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    if meta.len() > SCAN_MAX_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
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
fn read_sync_side(path: &Path) -> Option<String> {
    read_bounded(path)
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

    for item in &items {
        if item.kind == LibraryKind::Prompt {
            continue;
        }
        let Some(rel) = item.path.as_ref().map(PathBuf::from) else {
            continue;
        };
        claimed.insert((item.scope.as_str(), rel.to_string_lossy().into_owned()));

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
        let disk_body = read_sync_side(&full);
        let baseline = item.synced_body.clone();
        let status = classify(&item.body, disk_body.as_deref(), baseline.as_deref());
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
        });
    }

    for (scope, base) in [
        (LibraryScope::User, user_base.clone()),
        (LibraryScope::Project, project_base.clone()),
    ] {
        let Some(base) = base else { continue };
        let mut seen: HashSet<String> = HashSet::new();
        for (kind, name, body) in scan_disk(&base) {
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
        assert_eq!(
            relative_path(LibraryKind::Hook, LibraryScope::User, "stop-notify"),
            Some(PathBuf::from(".claude/hooks/stop-notify.sh"))
        );
        assert_eq!(
            relative_path(LibraryKind::Hook, LibraryScope::Project, "stop-notify"),
            Some(PathBuf::from(".claude/hooks/stop-notify.sh"))
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
        fs::write(base.join(".claude/skills/dataviz/SKILL.md"), "dataviz body").unwrap();
        fs::write(base.join(".claude/CLAUDE.md"), "claude md body").unwrap();
        // A non-matching extension in an agents dir must not be picked up.
        fs::write(base.join(".claude/agents/notes.txt"), "ignore me").unwrap();

        let found = scan_disk(base);

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
            "stop-notify".to_string(),
            "#!/bin/sh\n".to_string()
        )));
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
        assert_eq!(found.len(), 5);
    }

    #[test]
    fn scan_disk_skips_an_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".claude/agents")).unwrap();
        let big = "x".repeat(SCAN_MAX_BYTES as usize + 1);
        fs::write(base.join(".claude/agents/huge.md"), big).unwrap();
        let found = scan_disk(base);
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

        let found = scan_disk(base);

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

        let found = scan_disk(&base);
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

        let found = scan_disk(&base);
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

        let found = scan_disk(&base);
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

        let found = scan_disk(base);
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
}
