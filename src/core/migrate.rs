//! `mesa migrate` — move mesa and Claude Code's home directory to a new
//! computer (mesa task 1206, `docs/migrate.md`).
//!
//! An archive is a tar.gz, written and read by the system `tar` (argv, never
//! a shell string), holding `manifest.json`, a `VACUUM INTO` snapshot of the
//! db as `mesa.db`, and every bundled file at its path relative to `$HOME`
//! (`.mesa/config.json`, `.claude/...`). Import restores all of it under the
//! current `$HOME`, rewriting absolute paths through a list of prefix
//! mappings (the old home onto the new one, and optionally the manifest's
//! `repo_root` onto a new repo root) — in the text files that hold
//! hand-written paths, in every project's `local_path` (through
//! `Store::update_project`), and in the names of Claude Code's
//! `projects/<encoded path>` directories.
//!
//! CLI only: there is no HTTP route, since this reads and writes the home
//! directory.

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::store::{Error, ProjectPatch, Result, Store};

/// The archive layout version `manifest.json` carries. An archive naming any
/// other version is refused (`validation`) rather than half-understood.
pub const FORMAT_VERSION: u64 = 1;

/// What `export` bundles from the home directory, relative to `$HOME`. The
/// per-project memory dirs (`.claude/projects/*/memory`) are added on top,
/// or with `--with-sessions` the whole of `.claude/projects` plus
/// `.claude/history.jsonl`.
const HOME_ITEMS: &[&str] = &[
    ".mesa/config.json",
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/keybindings.json",
    ".claude/statusline-command.sh",
    ".claude/agents",
    ".claude/hooks",
    ".claude/commands",
    ".claude/skills",
    ".claude/output-styles",
    ".claude/plugins/installed_plugins.json",
    ".claude/plugins/known_marketplaces.json",
];

/// The user's home directory, the same resolution `config` uses — `$HOME`
/// first, so a throwaway `HOME` isolates every path this module touches.
pub fn home_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default()
}

// ---- path mapping ----

/// One prefix rewrite: every path equal to `from`, or under it, is moved
/// under `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mapping {
    pub from: String,
    pub to: String,
}

/// A path with any trailing `/` removed (the root itself kept as `/`), so a
/// mapping's boundary check sees the same spelling however it was typed.
fn trim_path(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() && p.starts_with('/') {
        "/".to_string()
    } else {
        t.to_string()
    }
}

/// Parses `--home-map OLD=NEW`. Both halves must be absolute paths.
pub fn parse_home_map(spec: &str) -> Result<Mapping> {
    let bad = || {
        Error::Validation(format!(
            "--home-map must be OLD=NEW with both absolute paths, got {spec:?}"
        ))
    };
    let (from, to) = spec.split_once('=').ok_or_else(bad)?;
    if !from.starts_with('/') || !to.starts_with('/') {
        return Err(bad());
    }
    Ok(Mapping {
        from: trim_path(from),
        to: trim_path(to),
    })
}

/// A character that can continue a path component: a match must not be
/// followed (or preceded) by one, so `/Users/sim` never matches inside
/// `/Users/simon`.
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Mappings ordered longest `from` first — the longest prefix wins — with
/// identity mappings dropped.
fn ordered(mappings: &[Mapping]) -> Vec<&Mapping> {
    let mut out: Vec<&Mapping> = mappings.iter().filter(|m| m.from != m.to).collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.from.len()));
    out
}

/// Whether `from` occurs in `text` at byte `i` on a path boundary on both
/// sides: not preceded by a path character, and followed by the end, a `/`,
/// or anything that cannot continue the last component (a `.` counts as a
/// boundary only when nothing name-like follows it — sentence punctuation,
/// not `/Users/sim.bak`).
fn matches_at(text: &str, i: usize, from: &str) -> bool {
    if !text[i..].starts_with(from) {
        return false;
    }
    if let Some(prev) = text[..i].chars().next_back()
        && (is_name_char(prev) || prev == '.' || prev == '/')
    {
        return false;
    }
    let rest = &text[i + from.len()..];
    if from.ends_with('/') {
        return true;
    }
    let mut chars = rest.chars();
    match chars.next() {
        None => true,
        Some('.') => !chars.next().is_some_and(|c| is_name_char(c) || c == '.'),
        Some(c) => !is_name_char(c),
    }
}

/// Rewrites every boundary-aware occurrence of a mapping's `from` in `text`,
/// left to right, longest prefix first at each position. A replacement is
/// never re-scanned, so mappings cannot chain.
pub fn rewrite_text(text: &str, mappings: &[Mapping]) -> String {
    let order = ordered(mappings);
    if order.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'scan: while i < text.len() {
        for m in &order {
            if matches_at(text, i, &m.from) {
                out.push_str(&m.to);
                i += m.from.len();
                continue 'scan;
            }
        }
        let c = text[i..].chars().next().expect("char at a boundary");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Claude Code's name for a directory under `~/.claude/projects`: the
/// absolute path with every character that is not an ASCII letter or digit
/// replaced by `-` (`/Users/me/.claude` → `-Users-me--claude`).
pub fn encode_path(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The new name for a `projects/<name>` directory, if its (encoded) path
/// falls under a mapped prefix. The encoding is lossy, so the match is made
/// on the encoded form: the name equals the encoded `from`, or continues
/// with the `-` a `/` became.
pub fn rename_encoded(name: &str, mappings: &[Mapping]) -> Option<String> {
    for m in ordered(mappings) {
        let from = encode_path(&m.from);
        if let Some(rest) = name.strip_prefix(&from)
            && (rest.is_empty() || rest.starts_with('-'))
        {
            return Some(format!("{}{rest}", encode_path(&m.to)));
        }
    }
    None
}

/// The longest common ancestor directory of `paths` (component-wise), or
/// `None` when there are none or they share only `/`.
pub fn repo_root(paths: &[String]) -> Option<String> {
    let mut common: Option<Vec<&str>> = None;
    for p in paths {
        let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
        common = Some(match common {
            None => parts,
            Some(c) => c
                .iter()
                .zip(&parts)
                .take_while(|(a, b)| a == b)
                .map(|(a, _)| *a)
                .collect(),
        });
    }
    let c = common?;
    (!c.is_empty()).then(|| format!("/{}", c.join("/")))
}

/// Whether import rewrites paths inside this file (relative to `$HOME`):
/// the files that hold hand-written absolute paths. Everything else — the
/// memories, session transcripts — is restored byte-identical.
fn is_rewritable(rel: &str) -> bool {
    if rel == ".mesa/config.json" {
        return true;
    }
    let Some(r) = rel.strip_prefix(".claude/") else {
        return false;
    };
    matches!(
        r,
        "settings.json" | "settings.local.json" | "CLAUDE.md" | "statusline-command.sh"
    ) || [
        "agents/",
        "hooks/",
        "commands/",
        "skills/",
        "output-styles/",
    ]
    .iter()
    .any(|d| r.starts_with(d))
        || r.strip_prefix("plugins/")
            .is_some_and(|f| !f.contains('/') && f.ends_with(".json"))
}

/// `rel` with its `.claude/projects/<name>` component renamed through
/// `mappings`, plus the rename when there was one.
fn map_rel(rel: &str, mappings: &[Mapping]) -> (String, Option<(String, String)>) {
    if let Some(rest) = rel.strip_prefix(".claude/projects/") {
        let (name, tail) = rest.split_once('/').unwrap_or((rest, ""));
        if let Some(new) = rename_encoded(name, mappings) {
            let mapped = if tail.is_empty() {
                format!(".claude/projects/{new}")
            } else {
                format!(".claude/projects/{new}/{tail}")
            };
            return (mapped, Some((name.to_string(), new)));
        }
    }
    (rel.to_string(), None)
}

// ---- walking the home directory ----

/// Every file and symlink under `root` (itself, if it is one), as paths
/// relative to `base`, sorted. Symlinks are listed, never followed.
fn walk(base: &Path, root: &Path, out: &mut Vec<String>) -> Result<()> {
    let meta = fs::symlink_metadata(root)?;
    if meta.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(root)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<_>>()?;
        entries.sort();
        for e in entries {
            walk(base, &e, out)?;
        }
    } else {
        let rel = root.strip_prefix(base).unwrap_or(root);
        out.push(rel.to_string_lossy().into_owned());
    }
    Ok(())
}

/// One bundle entry `check`/`export` report.
struct Item {
    rel: String,
    files: Vec<String>,
    bytes: u64,
}

/// The items `export` bundles, relative to `home`: present ones with their
/// files, and the names of the missing ones.
fn collect(home: &Path, with_sessions: bool) -> Result<(Vec<Item>, Vec<String>)> {
    let mut rels: Vec<String> = HOME_ITEMS.iter().map(|s| s.to_string()).collect();
    let projects = home.join(".claude/projects");
    if with_sessions {
        rels.push(".claude/projects".into());
        rels.push(".claude/history.jsonl".into());
    } else if projects.is_dir() {
        let mut names: Vec<String> = fs::read_dir(&projects)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().join("memory").is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        rels.extend(
            names
                .into_iter()
                .map(|n| format!(".claude/projects/{n}/memory")),
        );
    }
    let mut present = Vec::new();
    let mut missing = Vec::new();
    for rel in rels {
        let path = home.join(&rel);
        if fs::symlink_metadata(&path).is_err() {
            missing.push(rel);
            continue;
        }
        let mut files = Vec::new();
        walk(home, &path, &mut files)?;
        let bytes = files
            .iter()
            .filter_map(|f| fs::symlink_metadata(home.join(f)).ok())
            .map(|m| m.len())
            .sum();
        present.push(Item { rel, files, bytes });
    }
    Ok((present, missing))
}

// ---- temp dirs and tar ----

/// A scratch directory removed on drop, so every exit path cleans up.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("mesa-migrate-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Runs the system `tar` with `args`; a missing binary or a failed run is
/// returned as its stderr.
fn tar(args: &[&std::ffi::OsStr]) -> std::result::Result<(), String> {
    let out = Command::new("tar")
        .args(args)
        .output()
        .map_err(|e| format!("could not run tar: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn now_text() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    super::cc::fmt_store_ts(secs)
}

fn project_rows(store: &Store) -> Result<(Vec<Value>, Option<String>)> {
    let projects = store.list_projects_all()?;
    let paths: Vec<String> = projects
        .iter()
        .filter_map(|p| p.local_path.clone())
        .collect();
    let rows = projects
        .iter()
        .map(|p| json!({"id": p.id, "name": p.name, "local_path": p.local_path}))
        .collect();
    Ok((rows, repo_root(&paths)))
}

// ---- check ----

/// Where a hard-coded absolute path under `home` ends: the first character
/// that cannot be part of an unquoted path in a config or script.
fn path_token(s: &str) -> &str {
    let end = s
        .find(|c: char| c.is_whitespace() || "\"'`<>()[]{},;:|&=$*?!".contains(c))
        .unwrap_or(s.len());
    s[..end].trim_end_matches('.')
}

/// The dry run: every item `export` would bundle (present or missing, with
/// its size) and every hard-coded path under `home` in the files `import`
/// would rewrite. Reads only; `store` is `None` when no db exists yet.
pub fn check(home: &Path, db_path: &Path, store: Option<&Store>) -> Result<Value> {
    let (present, missing) = collect(home, false)?;
    let home_s = trim_path(&home.to_string_lossy());
    let mut hardcoded = Vec::new();
    for item in &present {
        for rel in &item.files {
            if !is_rewritable(rel) {
                continue;
            }
            let path = home.join(rel);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            for (n, line) in text.lines().enumerate() {
                let mut i = 0;
                while let Some(off) = line[i..].find(home_s.as_str()) {
                    let at = i + off;
                    if matches_at(line, at, &home_s) {
                        hardcoded.push(json!({
                            "file": rel,
                            "line": n + 1,
                            "match": path_token(&line[at..]),
                        }));
                    }
                    i = at + home_s.len();
                }
            }
        }
    }
    let items: Vec<Value> = present
        .iter()
        .map(|i| json!({"path": i.rel, "present": true, "bytes": i.bytes, "files": i.files.len()}))
        .chain(
            missing
                .iter()
                .map(|m| json!({"path": m, "present": false, "bytes": 0, "files": 0})),
        )
        .collect();
    let (projects, root) = match store {
        Some(s) => project_rows(s)?,
        None => (Vec::new(), None),
    };
    let db_bytes = fs::metadata(db_path).ok().map(|m| m.len());
    Ok(json!({
        "home": home_s,
        "db": {"path": db_path, "present": db_bytes.is_some(), "bytes": db_bytes.unwrap_or(0)},
        "items": items,
        "hardcoded": hardcoded,
        "projects": projects,
        "repo_root": root,
    }))
}

// ---- export ----

/// Writes the archive: a db snapshot (`Store::backup`, safe while `serve`
/// runs), the manifest and every present item. A missing item is skipped and
/// listed, never an error; an existing `archive` is `conflict`.
pub fn export(store: &Store, home: &Path, archive: &Path, with_sessions: bool) -> Result<Value> {
    if fs::symlink_metadata(archive).is_ok() {
        return Err(Error::Conflict(format!(
            "{} already exists; pick a new archive path",
            archive.display()
        )));
    }
    let (present, missing) = collect(home, with_sessions)?;
    let scratch = Scratch::new()?;
    store.backup(&scratch.0.join("mesa.db"))?;
    let (projects, root) = project_rows(store)?;
    let home_s = trim_path(&home.to_string_lossy());
    let username = std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| home.file_name().map(|n| n.to_string_lossy().into_owned()));
    let files: Vec<&String> = present.iter().flat_map(|i| &i.files).collect();
    let manifest = json!({
        "format_version": FORMAT_VERSION,
        "created_at": now_text(),
        "mesa_version": env!("CARGO_PKG_VERSION"),
        "source_home": home_s,
        "username": username,
        "repo_root": root,
        "projects": projects,
        "files": files,
        "with_sessions": with_sessions,
    });
    fs::write(
        scratch.0.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).expect("json serialize"),
    )?;
    let mut args: Vec<&std::ffi::OsStr> = vec![
        "-czf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        scratch.0.as_os_str(),
        "manifest.json".as_ref(),
        "mesa.db".as_ref(),
    ];
    if !present.is_empty() {
        args.push("-C".as_ref());
        args.push(home.as_os_str());
        args.extend(present.iter().map(|i| i.rel.as_ref() as &std::ffi::OsStr));
    }
    if let Err(e) = tar(&args) {
        let _ = fs::remove_file(archive);
        return Err(Error::Unavailable(format!(
            "tar could not write the archive: {e}"
        )));
    }
    let bytes = fs::metadata(archive)?.len();
    Ok(json!({
        "archive": archive,
        "bytes": bytes,
        "files": files.len(),
        "file_bytes": present.iter().map(|i| i.bytes).sum::<u64>(),
        "projects": projects.len(),
        "repo_root": root,
        "with_sessions": with_sessions,
        "skipped": missing,
    }))
}

// ---- import ----

/// What import may be told on top of the archive.
#[derive(Debug, Default)]
pub struct ImportOptions {
    /// `--home-map OLD=NEW`; absent = the manifest's home onto `$HOME`.
    pub home_map: Option<Mapping>,
    /// `--repo-root DIR`: the manifest's `repo_root` moves here.
    pub repo_root: Option<String>,
    /// Overwrite an existing db and differing files.
    pub force: bool,
}

/// One file import would write.
enum Content {
    File { bytes: Vec<u8>, mode: u32 },
    Link(PathBuf),
}

struct Planned {
    rel: String,
    target: PathBuf,
    content: Content,
    rewritten: bool,
}

/// Whether `target` already holds exactly `content`.
fn same_as(target: &Path, content: &Content) -> bool {
    match content {
        Content::File { bytes, .. } => {
            fs::symlink_metadata(target).is_ok_and(|m| m.is_file())
                && fs::read(target).is_ok_and(|b| &b == bytes)
        }
        Content::Link(to) => fs::read_link(target).is_ok_and(|l| &l == to),
    }
}

/// The mappings import applies: the home map, plus `repo_root` → DIR when
/// asked for (longest prefix wins, so the repo root outranks the home it
/// usually sits under).
fn import_mappings(manifest: &Value, home: &Path, opts: &ImportOptions) -> Result<Vec<Mapping>> {
    let mut maps = Vec::new();
    let home_map = match &opts.home_map {
        Some(m) => m.clone(),
        None => {
            let from = manifest["source_home"]
                .as_str()
                .ok_or_else(|| Error::Validation("manifest.json has no source_home".into()))?;
            Mapping {
                from: trim_path(from),
                to: trim_path(&home.to_string_lossy()),
            }
        }
    };
    if let Some(dir) = &opts.repo_root {
        if !dir.starts_with('/') {
            return Err(Error::Validation(format!(
                "--repo-root must be an absolute path, got {dir:?}"
            )));
        }
        let from = manifest["repo_root"].as_str().ok_or_else(|| {
            Error::Validation(
                "--repo-root given, but the archive records no repo_root (no project had a local_path)"
                    .into(),
            )
        })?;
        maps.push(Mapping {
            from: trim_path(from),
            to: trim_path(dir),
        });
    }
    maps.push(home_map);
    Ok(maps)
}

/// Restores an archive under `home` and the db at `db_path`. Refuses with
/// `conflict`, writing nothing, when the db exists or any file it would
/// write already exists with different content — unless `opts.force`.
pub fn import(archive: &Path, home: &Path, db_path: &Path, opts: &ImportOptions) -> Result<Value> {
    if !archive.is_file() {
        return Err(Error::Validation(format!(
            "{} is not an archive file",
            archive.display()
        )));
    }
    let scratch = Scratch::new()?;
    tar(&[
        "-xzf".as_ref(),
        archive.as_os_str(),
        "-C".as_ref(),
        scratch.0.as_os_str(),
    ])
    .map_err(|e| {
        Error::Validation(format!(
            "{} is not a readable mesa migrate archive: {e}",
            archive.display()
        ))
    })?;
    let manifest: Value = fs::read(scratch.0.join("manifest.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| {
            Error::Validation(format!(
                "{} has no valid manifest.json — not a mesa migrate archive",
                archive.display()
            ))
        })?;
    match manifest["format_version"].as_u64() {
        Some(FORMAT_VERSION) => {}
        other => {
            return Err(Error::Validation(format!(
                "unknown archive format_version {other:?}; this mesa reads version {FORMAT_VERSION}"
            )));
        }
    }
    let snapshot = scratch.0.join("mesa.db");
    if !snapshot.is_file() {
        return Err(Error::Validation("the archive holds no mesa.db".into()));
    }
    let mappings = import_mappings(&manifest, home, opts)?;

    // Plan every write before making any, so a refusal writes nothing.
    let mut extracted = Vec::new();
    for top in [".claude", ".mesa"] {
        let root = scratch.0.join(top);
        if fs::symlink_metadata(&root).is_ok() {
            walk(&scratch.0, &root, &mut extracted)?;
        }
    }
    let mut plan = Vec::new();
    let mut renamed = BTreeSet::new();
    for rel in extracted {
        let src = scratch.0.join(&rel);
        let meta = fs::symlink_metadata(&src)?;
        let (target_rel, rename) = map_rel(&rel, &mappings);
        if let Some(r) = rename {
            renamed.insert(r);
        }
        let mut rewritten = false;
        let content = if meta.file_type().is_symlink() {
            let to = fs::read_link(&src)?.to_string_lossy().into_owned();
            let new = rewrite_text(&to, &mappings);
            rewritten = new != to;
            Content::Link(PathBuf::from(new))
        } else {
            let mut bytes = fs::read(&src)?;
            if is_rewritable(&rel)
                && let Ok(text) = std::str::from_utf8(&bytes)
            {
                let new = rewrite_text(text, &mappings);
                if new != text {
                    rewritten = true;
                    bytes = new.into_bytes();
                }
            }
            Content::File {
                bytes,
                mode: meta.permissions().mode() & 0o7777,
            }
        };
        plan.push(Planned {
            target: home.join(&target_rel),
            rel: target_rel,
            content,
            rewritten,
        });
    }
    let mut conflicts = Vec::new();
    if fs::symlink_metadata(db_path).is_ok() {
        conflicts.push(db_path.to_string_lossy().into_owned());
    }
    let mut unchanged = 0;
    let mut writes = Vec::new();
    for p in plan {
        if fs::symlink_metadata(&p.target).is_err() {
            writes.push(p);
        } else if same_as(&p.target, &p.content) {
            unchanged += 1;
        } else {
            conflicts.push(p.target.to_string_lossy().into_owned());
            writes.push(p);
        }
    }
    if !conflicts.is_empty() && !opts.force {
        return Err(Error::Conflict(format!(
            "import would overwrite {} existing path(s) (pass --force to overwrite): {}",
            conflicts.len(),
            conflicts.join(", ")
        )));
    }

    // The db first: a snapshot copied into place, then every project's
    // local_path moved through the Store.
    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir)?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_owned();
        p.push(suffix);
        let _ = fs::remove_file(PathBuf::from(p));
    }
    fs::copy(&snapshot, db_path)?;
    let mut store = Store::open(db_path)?;
    let mut remapped = Vec::new();
    for project in store.list_projects_all()? {
        let Some(old) = project.local_path.clone() else {
            continue;
        };
        let new = rewrite_text(&old, &mappings);
        if new != old {
            store.update_project(
                project.id,
                &ProjectPatch {
                    local_path: Some(Some(new.clone())),
                    ..Default::default()
                },
            )?;
            remapped.push(json!({"id": project.id, "name": project.name, "from": old, "to": new}));
        }
    }

    let mut rewritten = Vec::new();
    for p in &writes {
        if let Some(dir) = p.target.parent() {
            fs::create_dir_all(dir)?;
        }
        if fs::symlink_metadata(&p.target).is_ok_and(|m| !m.is_dir()) {
            fs::remove_file(&p.target)?;
        }
        match &p.content {
            Content::File { bytes, mode } => {
                fs::write(&p.target, bytes)?;
                fs::set_permissions(&p.target, fs::Permissions::from_mode(*mode))?;
            }
            Content::Link(to) => std::os::unix::fs::symlink(to, &p.target)?,
        }
        if p.rewritten {
            rewritten.push(p.rel.clone());
        }
    }

    let clone_paths: Vec<String> = store
        .list_projects_all()?
        .into_iter()
        .filter_map(|p| p.local_path.map(|l| format!("clone {} to {l}", p.name)))
        .collect();
    let mut todo = clone_paths;
    todo.extend(
        [
            "install the mesa, qorvex, khora and loki binaries (they are built, not copied)",
            "re-authenticate Claude Code: run `claude` and log in",
            "re-enable plugins: installed_plugins.json was restored, the plugin caches were not",
        ]
        .map(String::from),
    );
    Ok(json!({
        "archive": archive,
        "source_home": manifest["source_home"],
        "home": home,
        "db": db_path,
        "mappings": mappings.iter().map(|m| json!({"from": m.from, "to": m.to})).collect::<Vec<_>>(),
        "restored": writes.len(),
        "unchanged": unchanged,
        "overwritten": conflicts,
        "projects": remapped,
        "rewritten": rewritten,
        "renamed": renamed.iter().map(|(f, t)| json!({"from": f, "to": t})).collect::<Vec<_>>(),
        "todo": todo,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(from: &str, to: &str) -> Mapping {
        Mapping {
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn rewrite_is_boundary_aware() {
        let maps = [m("/Users/sim", "/Users/new")];
        assert_eq!(rewrite_text("/Users/simon/x", &maps), "/Users/simon/x");
        assert_eq!(rewrite_text("/Users/sim_x", &maps), "/Users/sim_x");
        assert_eq!(rewrite_text("/Users/sim.bak", &maps), "/Users/sim.bak");
        assert_eq!(rewrite_text("/other/Users/sim", &maps), "/other/Users/sim");
        assert_eq!(rewrite_text("/Users/sim", &maps), "/Users/new");
        assert_eq!(
            rewrite_text("cd \"/Users/sim/a\" && ls /Users/sim.", &maps),
            "cd \"/Users/new/a\" && ls /Users/new."
        );
        assert_eq!(
            rewrite_text(
                "{\"command\":\"bash /Users/sim/.claude/hooks/x.sh\"}",
                &maps
            ),
            "{\"command\":\"bash /Users/new/.claude/hooks/x.sh\"}"
        );
    }

    #[test]
    fn longest_prefix_wins_and_replacements_do_not_chain() {
        let maps = [
            m("/Users/old", "/Users/new"),
            m("/Users/old/inaros", "/Volumes/code"),
        ];
        assert_eq!(
            rewrite_text("/Users/old/inaros/mesa /Users/old/.claude", &maps),
            "/Volumes/code/mesa /Users/new/.claude"
        );
        // a → b and b → c must not turn a into c.
        let chain = [m("/a", "/b"), m("/b", "/c")];
        assert_eq!(rewrite_text("/a/x /b/y", &chain), "/b/x /c/y");
    }

    #[test]
    fn identity_mapping_is_a_no_op() {
        let maps = [m("/Users/me", "/Users/me")];
        assert_eq!(rewrite_text("/Users/me/x", &maps), "/Users/me/x");
    }

    #[test]
    fn encodes_like_claude_code() {
        assert_eq!(
            encode_path("/Users/simonspoon/inaros/projects/tools/mesa"),
            "-Users-simonspoon-inaros-projects-tools-mesa"
        );
        assert_eq!(
            encode_path("/Users/simonspoon/.claude"),
            "-Users-simonspoon--claude"
        );
        assert_eq!(encode_path("/tmp/a_b.c"), "-tmp-a-b-c");
    }

    #[test]
    fn renames_encoded_dirs_on_a_boundary_longest_first() {
        let maps = [
            m("/Users/old", "/Users/new"),
            m("/Users/old/inaros", "/Volumes/code"),
        ];
        assert_eq!(
            rename_encoded("-Users-old-inaros-mesa", &maps).as_deref(),
            Some("-Volumes-code-mesa")
        );
        assert_eq!(
            rename_encoded("-Users-old--claude", &maps).as_deref(),
            Some("-Users-new--claude")
        );
        assert_eq!(
            rename_encoded("-Users-old", &maps).as_deref(),
            Some("-Users-new")
        );
        assert_eq!(rename_encoded("-Users-olduser-x", &maps), None);
        assert_eq!(rename_encoded("-private-tmp", &maps), None);
        let (rel, r) = map_rel(".claude/projects/-Users-old-x/memory/MEMORY.md", &maps);
        assert_eq!(rel, ".claude/projects/-Users-new-x/memory/MEMORY.md");
        assert_eq!(r, Some(("-Users-old-x".into(), "-Users-new-x".into())));
    }

    #[test]
    fn repo_root_is_the_common_ancestor() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            repo_root(&p(&["/Users/o/inaros/a/x", "/Users/o/inaros/b"])).as_deref(),
            Some("/Users/o/inaros")
        );
        assert_eq!(
            repo_root(&p(&["/Users/o/inaros/ab", "/Users/o/inaros/abc"])).as_deref(),
            Some("/Users/o/inaros")
        );
        assert_eq!(repo_root(&p(&["/a/x", "/b/y"])), None);
        assert_eq!(repo_root(&[]), None);
    }

    #[test]
    fn home_map_syntax() {
        assert_eq!(
            parse_home_map("/Users/a/=/Users/b").unwrap(),
            m("/Users/a", "/Users/b")
        );
        for bad in ["/Users/a", "a=/b", "/a=b", "=/b"] {
            assert!(
                matches!(parse_home_map(bad), Err(Error::Validation(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn rewritable_files() {
        for yes in [
            ".mesa/config.json",
            ".claude/settings.json",
            ".claude/settings.local.json",
            ".claude/CLAUDE.md",
            ".claude/agents/supervisor.md",
            ".claude/hooks/guard.sh",
            ".claude/skills/x/SKILL.md",
            ".claude/plugins/known_marketplaces.json",
        ] {
            assert!(is_rewritable(yes), "{yes}");
        }
        for no in [
            ".claude/projects/-x/memory/MEMORY.md",
            ".claude/history.jsonl",
            ".claude/plugins/cache/x.json",
        ] {
            assert!(!is_rewritable(no), "{no}");
        }
    }

    /// Builds a source home under `root`, exports it, and returns the archive.
    fn exported(root: &Path) -> PathBuf {
        let home = root.join("Users/old");
        fs::create_dir_all(home.join(".claude/hooks")).unwrap();
        let memory = home
            .join(".claude/projects")
            .join(encode_path(&home.join("repo").to_string_lossy()))
            .join("memory");
        fs::create_dir_all(&memory).unwrap();
        let settings = home.join(".claude/settings.json");
        fs::write(
            &settings,
            format!("{{\"statusLine\":\"{}/.claude/s.sh\"}}", home.display()),
        )
        .unwrap();
        fs::write(memory.join("MEMORY.md"), "memo").unwrap();
        let mut store = Store::open(&root.join("src.db")).unwrap();
        let repo = home.join("repo").to_string_lossy().into_owned();
        store
            .create_project("p", None, None, Some(&repo), None)
            .unwrap();
        let archive = root.join("a.tar.gz");
        export(&store, &home, &archive, false).unwrap();
        archive
    }

    #[test]
    fn import_refuses_existing_paths_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = exported(tmp.path());
        let home = tmp.path().join("Users/new");
        let db = tmp.path().join("new.db");
        let opts = ImportOptions::default();
        let out = import(&archive, &home, &db, &opts).unwrap();
        assert_eq!(out["projects"][0]["to"], format!("{}/repo", home.display()));
        let memo = home
            .join(".claude/projects")
            .join(encode_path(&home.join("repo").to_string_lossy()))
            .join("memory/MEMORY.md");
        assert_eq!(fs::read_to_string(memo).unwrap(), "memo");
        let settings = fs::read_to_string(home.join(".claude/settings.json")).unwrap();
        assert!(settings.contains(&format!("{}/.claude/s.sh", home.display())));

        // Change a restored file: a second import must refuse, listing the db
        // and that file, and leave both exactly as they are.
        fs::write(home.join(".claude/settings.json"), "mine").unwrap();
        let before = fs::read(&db).unwrap();
        let err = import(&archive, &home, &db, &opts).unwrap_err();
        let Error::Conflict(msg) = err else {
            panic!("expected conflict, got {err:?}")
        };
        assert!(
            msg.contains("new.db") && msg.contains("settings.json"),
            "{msg}"
        );
        assert_eq!(
            fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
            "mine"
        );
        assert_eq!(fs::read(&db).unwrap(), before);

        // --force overwrites.
        let forced = ImportOptions {
            force: true,
            ..Default::default()
        };
        import(&archive, &home, &db, &forced).unwrap();
        assert_ne!(
            fs::read_to_string(home.join(".claude/settings.json")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn import_rejects_an_unknown_format_version() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = tmp.path().join("stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("manifest.json"), "{\"format_version\": 99}").unwrap();
        let archive = tmp.path().join("bad.tar.gz");
        tar(&[
            "-czf".as_ref(),
            archive.as_os_str(),
            "-C".as_ref(),
            stage.as_os_str(),
            "manifest.json".as_ref(),
        ])
        .unwrap();
        let err = import(
            &archive,
            &tmp.path().join("h"),
            &tmp.path().join("d.db"),
            &ImportOptions::default(),
        )
        .unwrap_err();
        assert!(
            matches!(err, Error::Validation(ref m) if m.contains("format_version")),
            "{err:?}"
        );
    }
}
