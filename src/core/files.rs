//! File-tree listing + file-content reads/writes rooted at a project's
//! `local_path` (see `.scratch/arch.md` under mesa task 277/278 for the
//! cross-area contract). Like `core::git`/`core::agents`, this module touches
//! EXTERNAL filesystem state only — `std::fs`, no `Store` dependency beyond
//! whatever `local_path` string its caller (279's API layer) already
//! resolved. Three writes live here, all narrow: `write_file` (task 327)
//! overwrites an existing text file's content in place, `create_dir`
//! (task 489) makes one empty directory for the folder picker, and
//! `create_file` (task 672) makes one empty file inside a project's tree.
//! Nothing in this module deletes or renames anything.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::core::types::{
    DirEntry, DirListing, FileContentView, FileSearchFile, FileSearchMatch, FileTreeEntry,
    ProjectFileSearch,
};

/// Mirrors `git.rs`'s `DIFF_CAP` precedent: one huge file can't balloon the
/// JSON response.
const FILE_CONTENT_CAP: usize = 256 * 1024;

/// Entries returned for one directory level (`tree_level`) before it stops
/// adding more. Applies per call now, not to a whole recursive walk — a
/// directory listing is one level, so this is the only cap that remains.
const MAX_TREE_ENTRIES: usize = 2_000;

/// Directory names excluded at any depth — common VCS/dependency/build
/// output that would otherwise dominate a tree listing.
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "vendor",
    ".cache",
];

/// Extensions treated as binary without inspecting content.
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "pdf", "zip", "gz", "tar", "bz2", "xz",
    "7z", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "wasm", "so", "dylib",
    "dll", "exe", "bin", "class", "jar", "db", "sqlite", "sqlite3",
];

/// Extension -> frontend color-coding tag. Unrecognized extensions map to
/// `None` (see `FileContentView::language`'s doc); the frontend keeps its own
/// copy of this table for tree-row tinting (see arch.md #4 — deliberately not
/// duplicated per tree entry to avoid bloating a payload capped at
/// `MAX_TREE_ENTRIES`).
fn language_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "json" => "json",
        "md" => "markdown",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" => "shell",
        "html" => "html",
        "svg" => "svg",
        "css" => "css",
        "go" => "go",
        "rb" => "ruby",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" => "cpp",
        "cs" => "csharp",
        // .NET project and UI files are XML documents under a bespoke
        // extension — tagging them "xml" is what gets them markup colouring
        // (task 823).
        "xml" | "csproj" | "xaml" => "xml",
        _ => return None,
    })
}

/// Extension allowlist for the inline image route
/// (`GET /api/projects/{id}/files/raw`). An extension NOT on this list yields
/// `None`, which the route turns into a 422 — so the allowlist, not any
/// content sniffing, is what decides whether a file may come back with a
/// non-`octet-stream` type at all. Hand-rolled (no new crate), mirroring
/// `attachments::guess_content_type`; deliberately narrower than that one —
/// images only, never `text/html` and never a generic fallback. Only the
/// lowercased extension is consulted, so `foo.png.html` is `.html` and is
/// rejected.
pub fn image_mime(path: &str) -> Option<&'static str> {
    let ext = extension_of(Path::new(path))?;
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Extracts a lowercased extension from a path's basename, or `None` when
/// there isn't one.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Resolves `rel` (a request-supplied relative path, forward or back
/// slashes) against `root` (the project's `local_path`) and verifies the
/// result is `root` itself or a descendant of it. Both `root` and the joined
/// candidate are run through [`fs::canonicalize`] (which resolves `.`/`..`
/// AND symlinks) before the descendant check, so:
///   - `../../etc/passwd`, absolute paths (`/etc/passwd`) -> the joined
///     candidate canonicalizes to something outside `root` -> `None`.
///   - a symlink inside the tree pointing outside `root` -> canonicalize
///     follows it to the real target -> fails the descendant check -> `None`.
///   - a nonexistent path -> canonicalize errors -> `None`.
///   - `root` itself failing to canonicalize (dead folder) -> `None`.
///
/// Returns the canonical absolute `PathBuf` on success. This is the ONLY
/// function that turns a request path into an fs path; [`read_file`] is its
/// sole caller. No fs read happens before this check succeeds.
pub fn safe_path(root: &str, rel: &str) -> Option<PathBuf> {
    let root_canon = fs::canonicalize(root).ok()?;
    // `Path::join` treats an absolute `rel` as replacing the base entirely
    // (rather than erroring), which is exactly the "absolute-path smuggling"
    // case the descendant check below must catch — so joining first and
    // verifying after is safe, not a bypass.
    let joined = root_canon.join(rel);
    let candidate = fs::canonicalize(&joined).ok()?;
    if candidate == root_canon || candidate.starts_with(&root_canon) {
        Some(candidate)
    } else {
        None
    }
}

/// Lists one directory level — `root` itself when `rel` is `""`, else the
/// subdirectory `rel` resolves to underneath `root`. `rel` is resolved via
/// [`safe_path`] exactly like [`read_file`]/[`write_file`] (traversal,
/// absolute-path smuggling, and symlink escape all collapse to `None` the
/// same way); a `rel` that resolves to a file rather than a directory is
/// also `None`. Excludes [`EXCLUDED_DIRS`] by name, sorts directories before
/// files alphabetically within each group, and caps at [`MAX_TREE_ENTRIES`]
/// entries (returning `truncated: true` when the cap is hit) — this is now a
/// per-directory cap, not a whole-tree one, since each call only ever lists
/// one level; the caller re-calls this per directory on expand to go
/// deeper. Symlinks are listed but never followed (`is_dir: false` for a
/// symlinked dir — avoids both escape and cycle risk with one rule). A
/// `read_dir` failure on an otherwise-valid, already-`safe_path`-verified
/// directory (permissions changing after the check) is swallowed as "no
/// entries", not a failure of the whole call — same "unreadable subdir does
/// not fail the walk" precedent the old recursive `walk_dir` used.
pub fn tree_level(root: &str, rel: &str) -> Option<(Vec<FileTreeEntry>, bool)> {
    let anchor = if rel.is_empty() { "." } else { rel };
    let dir = safe_path(root, anchor)?;
    if !dir.is_dir() {
        return None;
    }
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Some((Vec::new(), false));
    };
    let mut raw: Vec<(String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        // symlink_metadata (not `metadata`) so a symlink is never followed —
        // it is classified as a file leaf regardless of what it points to.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        raw.push((name, meta.is_dir()));
    }
    // Directories before files, alphabetical within each group.
    raw.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    let mut out = Vec::new();
    let mut truncated = false;
    for (name, is_dir) in raw {
        if out.len() >= MAX_TREE_ENTRIES {
            truncated = true;
            break;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        out.push(FileTreeEntry { name, path, is_dir });
    }
    Some((out, truncated))
}

/// Backs `GET /api/fs/dirs` (the new-project folder picker; see
/// `.scratch/arch.md` under mesa task 405). UNLIKE every other function in
/// this module, this is deliberately NOT bound to any root — there is no
/// `local_path`/project to be contained within, so it does not call or
/// extend [`safe_path`]. The security boundary is the OS's own permission
/// model (the caller's OS user, enforced by `fs::read_dir` itself failing on
/// paths that user can't read) plus the loopback-only access gate at the API
/// layer — not a path prefix this function checks.
///
/// 1. `fs::canonicalize(path)` resolves `.`/`..`/symlinks to one
///    deterministic absolute path; a nonexistent path errors out to `None`
///    here rather than round-tripping to `read_dir` first.
/// 2. Reject if the canonical path is not a directory -> `None`.
/// 3. `fs::read_dir` the canonical path; any error (permission denied — the
///    OS boundary above firing) collapses to `None`, same "swallow as not
///    found" precedent `tree_level`'s own unreadable-directory case uses.
/// 4. List only entries that are themselves directories, using
///    `entry.path().metadata()` (follows symlinks) rather than
///    `symlink_metadata()` — the opposite of `walk_dir`'s choice. `walk_dir`
///    avoids following symlinks because it is a recursive, bound-checked
///    walk where following could escape the root or cycle; this is a single-
///    level listing with no root to escape and no recursion to cycle, so a
///    symlinked directory is just a real, reachable folder the user may
///    legitimately want to pick. An entry whose `metadata()` fails
///    (permission denied, dangling symlink) is skipped rather than failing
///    the whole listing. `EXCLUDED_DIRS` is deliberately not applied either —
///    `node_modules`/dotfiles must remain pickable as a project root, unlike
///    in a de-noised recursive tree view.
///
/// Each entry's `path` is `entry.path()` — the directory's own location
/// (`canon.join(name)`), NOT a further-resolved symlink target: a symlinked
/// entry's `path` still points at the symlink itself (basename always
/// matches `name`), it is only its directory-ness that follows the link.
///
/// `entries` is sorted alphabetically by name; `parent` is the canonical
/// path's own parent directory, or `None` at the filesystem root.
pub fn list_dir(path: &str) -> Option<DirListing> {
    let canon = fs::canonicalize(path).ok()?;
    if !canon.is_dir() {
        return None;
    }
    let read_dir = fs::read_dir(&canon).ok()?;
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in read_dir.flatten() {
        let Ok(meta) = entry.path().metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let parent = canon.parent().map(|p| p.to_string_lossy().into_owned());
    Some(DirListing {
        path: canon.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// Why [`create_dir`] rejected the request:
///   - `NotFound`: `parent` doesn't resolve or isn't a directory — the same
///     collapse [`list_dir`]'s `None` performs, so browsing a folder and
///     creating inside it fail identically once it vanishes.
///   - `Validation(reason)`: `name` isn't a usable single directory name.
///   - `Conflict`: something already occupies `parent/name`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateDirError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

/// Creates one directory named `name` directly inside `parent`, returning it
/// as a [`DirEntry`] shaped exactly like the ones [`list_dir`] returns (so a
/// caller can navigate into it without a second listing).
///
/// `name` must be a single path component — separators, NUL, `.` and `..` are
/// rejected outright, which is what keeps `canon.join(name)` inside `parent`.
/// That is the whole containment story, deliberately NOT `safe_path`'s
/// root-plus-relative model, for the same reason [`list_dir`] doesn't use it
/// (docs/fs-browse.md): there is no root here to be contained within, and the
/// bound on *where* a directory may be created is the OS's own permission
/// model plus the endpoint's caller gate, never a mesa-imposed path prefix.
///
/// `fs::create_dir`, never `create_dir_all`: one level only, and an existing
/// path is a `Conflict` the caller is told about rather than a silent success.
pub fn create_dir(parent: &str, name: &str) -> Result<DirEntry, CreateDirError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateDirError::Validation("folder name cannot be empty"));
    }
    if name == "." || name == ".." {
        return Err(CreateDirError::Validation("folder name cannot be . or .."));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(CreateDirError::Validation(
            "folder name must be a single name, not a path",
        ));
    }
    let canon = fs::canonicalize(parent).map_err(|_| CreateDirError::NotFound)?;
    if !canon.is_dir() {
        return Err(CreateDirError::NotFound);
    }
    let target = canon.join(name);
    // `symlink_metadata`, not `exists()`: a dangling symlink is still a name
    // taken, which `fs::create_dir` would refuse anyway.
    if target.symlink_metadata().is_ok() {
        return Err(CreateDirError::Conflict);
    }
    fs::create_dir(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => CreateDirError::Conflict,
        _ => CreateDirError::NotFound,
    })?;
    Ok(DirEntry {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
    })
}

/// Resolves `rel` via [`safe_path`], then:
///   - `None` from `safe_path`, OR the resolved path is a directory ->
///     `None`.
///   - extension in a known-binary set, OR a NUL byte in the first 8 KiB ->
///     `Some(FileContentView{is_binary: true, content: "", truncated: false,
///     language})`.
///   - else: read up to [`FILE_CONTENT_CAP`] bytes (lossy UTF-8, same
///     `capped` char-boundary truncation as `git.rs`),
///     `Some(FileContentView{is_binary: false, content, truncated, language})`.
///
/// `language` is derived from the extension in both branches — it describes
/// the FILE, not the content, so it's set even for binaries.
pub fn read_file(root: &str, rel: &str) -> Option<FileContentView> {
    let path = safe_path(root, rel)?;
    if path.is_dir() {
        return None;
    }
    let ext = extension_of(&path);
    let language = ext.as_deref().and_then(language_of);
    let ext_is_binary = ext
        .as_deref()
        .is_some_and(|e| BINARY_EXTENSIONS.contains(&e));

    // Read at most FILE_CONTENT_CAP+1 bytes — enough to both sniff and cap
    // content without pulling an arbitrarily large file fully into memory.
    let mut file = fs::File::open(&path).ok()?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(FILE_CONTENT_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let is_binary = ext_is_binary || sniff_binary(&bytes);
    if is_binary {
        return Some(FileContentView {
            path: rel.to_string(),
            is_binary: true,
            content: String::new(),
            truncated: false,
            language: language.map(str::to_string),
        });
    }

    let (content, truncated) = capped(&bytes);
    Some(FileContentView {
        path: rel.to_string(),
        is_binary: false,
        content,
        truncated,
        language: language.map(str::to_string),
    })
}

/// Whole-file byte cap for [`read_file_download`] — deliberately three orders
/// of magnitude above [`FILE_CONTENT_CAP`], because the two caps answer
/// different questions: `FILE_CONTENT_CAP` bounds a JSON *view* a browser has
/// to render, this one bounds only how much memory one response may occupy.
/// It exists at all because the crate has no streaming-body dependency (no
/// `tokio-util`), so the API layer builds the response from a `Vec<u8>` held
/// whole in memory; a file past this size is refused rather than read. Adding
/// a dependency to stream instead is a separate decision, not this cap's job.
const FILE_DOWNLOAD_CAP: u64 = 100 * 1024 * 1024;

/// Why [`read_file_download`] rejected the request, collapsing causes the same
/// way [`WriteFileError`] does:
///   - `NotFound`: [`safe_path`] rejected `rel` (traversal, absolute-path
///     smuggling, symlink escape, nonexistent path), the target is a
///     directory, or an `fs` call (metadata/open/read) failed — the same
///     "io failure collapses to NotFound" precedent [`write_file`] sets.
///   - `TooLarge`: the file is bigger than [`FILE_DOWNLOAD_CAP`]. Detected by
///     stat, so an over-cap file is never read into memory at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadFileError {
    NotFound,
    TooLarge,
}

/// Returns `(basename, full bytes)` for the file at `rel` under `root` — the
/// raw file, for saving to disk, NOT the capped/sniffed view [`read_file`]
/// builds for display. So: no [`FILE_CONTENT_CAP`], no binary sniff, no lossy
/// UTF-8, and every file qualifies — including the two the viewer can show
/// nothing useful for (binary, and text past the display cap), which is
/// exactly where a download earns its place. [`read_file`] and
/// `FILE_CONTENT_CAP` are untouched by this path.
///
/// `rel` is resolved through [`safe_path`] like every other reader here — no
/// second path-resolution rule. The basename is the RESOLVED path's final
/// component (so it can never carry a directory prefix out of `rel`), falling
/// back to `rel` only if there is none.
pub fn read_file_download(root: &str, rel: &str) -> Result<(String, Vec<u8>), DownloadFileError> {
    let path = safe_path(root, rel).ok_or(DownloadFileError::NotFound)?;
    // Stat before reading: an over-cap file must be refused, not slurped.
    let meta = fs::metadata(&path).map_err(|_| DownloadFileError::NotFound)?;
    if meta.is_dir() {
        return Err(DownloadFileError::NotFound);
    }
    if meta.len() > FILE_DOWNLOAD_CAP {
        return Err(DownloadFileError::TooLarge);
    }
    let bytes = fs::read(&path).map_err(|_| DownloadFileError::NotFound)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.to_string());
    Ok((name, bytes))
}

/// Why [`write_file`] rejected the request. Both variants collapse many
/// distinct causes into one, mirroring `read_file`'s own "one `None` for
/// traversal/absolute/unlisted/directory" precedent:
///   - `NotFound`: `safe_path` rejected `rel` (traversal, absolute-path
///     smuggling, symlink escape, nonexistent path), the target is a
///     directory, or the actual `fs::write` failed (permissions, disk full,
///     the path vanished between the check and the write).
///   - `Validation(reason)`: the target resolves to a real file but can't be
///     safely edited from the capped, possibly-lossy view the editor showed
///     — binary content, a truncated read (the true file is bigger than
///     [`FILE_CONTENT_CAP`], so what was displayed wasn't the whole file),
///     or new content that itself exceeds the cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteFileError {
    NotFound,
    Validation(&'static str),
}

/// Overwrites the file at `rel` (resolved the same way [`read_file`] resolves
/// it — reused directly, not re-implemented) with `content`, replacing its
/// entire byte content. Only ever writes to a path that already resolves to
/// an existing, non-directory, non-binary, non-truncated file — this is an
/// edit of a file the caller was shown, never a create, delete, or rename.
pub fn write_file(root: &str, rel: &str, content: &str) -> Result<(), WriteFileError> {
    let view = read_file(root, rel).ok_or(WriteFileError::NotFound)?;
    if view.is_binary {
        return Err(WriteFileError::Validation("cannot edit a binary file"));
    }
    if view.truncated {
        return Err(WriteFileError::Validation(
            "file is larger than mesa can safely edit",
        ));
    }
    if content.len() > FILE_CONTENT_CAP {
        return Err(WriteFileError::Validation(
            "content is larger than mesa can safely write",
        ));
    }
    // Re-resolve rather than reuse a path out of `view` (which carries none)
    // — `safe_path` is the module's sole request-path-to-fs-path chokepoint,
    // used identically by every reader/writer.
    let path = safe_path(root, rel).ok_or(WriteFileError::NotFound)?;
    fs::write(&path, content).map_err(|_| WriteFileError::NotFound)
}

/// Why [`create_file`] rejected the request, the same three-way split
/// [`CreateDirError`] uses (and mapped to the same 404/422/409 at the API
/// layer):
///   - `NotFound`: the PARENT directory doesn't resolve through [`safe_path`]
///     (traversal, absolute-path smuggling, symlink escape, nonexistent), is
///     not a directory, or the `fs::write` itself failed.
///   - `Validation(reason)`: the final component isn't a usable single file
///     name.
///   - `Conflict`: something already occupies the target path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateFileError {
    NotFound,
    Validation(&'static str),
    Conflict,
}

/// Creates ONE empty file at `rel` underneath `root` (task 672) — the Files
/// tab's only create, and the only write in this module that brings a new
/// path into existence.
///
/// The load-bearing detail is *what* is resolved: [`safe_path`] canonicalizes
/// its candidate, so a not-yet-existing path always collapses to `None` — the
/// new file itself can never be resolved through it. So the PARENT is
/// resolved instead, exactly as [`create_dir`] splits parent from name, and
/// the final component is then held inside that parent by the same
/// single-component rules `create_dir` applies (no separator, no NUL, not
/// `.`/`..`), which is what makes `parent.join(name)` provably stay put. That
/// keeps `safe_path` the module's sole request-path-to-fs-path chokepoint —
/// no second containment rule here, and no relaxation of `safe_path` itself
/// (whose rejection of nonexistent paths is exactly what
/// `read_file`/`write_file`/`tree_level` rely on).
///
/// The file is created EMPTY, never from a caller-supplied body: content
/// arrives afterwards through the existing [`write_file`] edit path, so there
/// is no second content cap, binary sniff or truncation rule to keep in sync.
pub fn create_file(root: &str, rel: &str) -> Result<(), CreateFileError> {
    let (parent_rel, name) = match rel.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", rel),
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateFileError::Validation("file name cannot be empty"));
    }
    if name == "." || name == ".." {
        return Err(CreateFileError::Validation("file name cannot be . or .."));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(CreateFileError::Validation(
            "file name must be a single name, not a path",
        ));
    }
    let anchor = if parent_rel.is_empty() {
        "."
    } else {
        parent_rel
    };
    let parent = safe_path(root, anchor).ok_or(CreateFileError::NotFound)?;
    if !parent.is_dir() {
        return Err(CreateFileError::NotFound);
    }
    let target = parent.join(name);
    // `symlink_metadata`, not `exists()`: a dangling symlink is still a name
    // taken — `create_dir`'s rule, for the same reason.
    if target.symlink_metadata().is_ok() {
        return Err(CreateFileError::Conflict);
    }
    fs::write(&target, "").map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => CreateFileError::Conflict,
        _ => CreateFileError::NotFound,
    })
}

/// The two toggles a search carries, mirroring the in-file find bar's
/// (`frontend/src/fileFind.ts`) — the same two questions, asked of the whole
/// tree instead of one open file.
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// The most matches [`search_files`] returns from one file. A file that
/// mentions the query on every line is one row per line in a panel that has
/// to stay scannable; the file's own `truncated` flag is how it says there
/// are more, and the in-file find bar (`Cmd/Ctrl+F`, which has its own,
/// larger cap) is where an exhaustive answer for one file lives.
const MAX_SEARCH_MATCHES_PER_FILE: usize = 50;

/// The most files one search reports hits for.
const MAX_SEARCH_FILES: usize = 200;

/// The most matches one search returns in total, across every file — the
/// ceiling on the response, and on the DOM the panel builds from it.
const MAX_SEARCH_TOTAL_MATCHES: usize = 1_000;

/// The most files one search will *open*, hit or not. The other three caps
/// bound the answer; this one bounds the work, so a query that matches
/// nothing in a huge tree still terminates promptly instead of reading every
/// byte under `local_path`.
const MAX_SEARCH_SCANNED_FILES: usize = 20_000;

/// The longest query [`search_files`] accepts. A literal scan is linear in
/// it, and nothing a person types at a search box comes near this — the API
/// layer turns a longer one into a 422 rather than scanning a megabyte of
/// pasted text against every file.
pub const MAX_SEARCH_QUERY: usize = 200;

/// Characters of context kept *before* a match in a result snippet.
const SNIPPET_LEAD: usize = 40;

/// The longest snippet a result row carries. A minified bundle is one line
/// of half a megabyte; windowing around the match is what keeps the row a
/// row.
const SNIPPET_MAX: usize = 240;

/// True when `ch` is a word character for the whole-word toggle — ASCII
/// letters, digits and `_`, the *same* set `fileFind.ts::isWordChar` uses.
/// Deliberately not a unicode-aware class: the two implementations answer the
/// same question about the same query, and widening one of them silently
/// would make the panel and the find bar disagree about what a word is.
fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// True when `a` and `b` are the same character under the chosen case rule.
/// Folded per character, `fileFind.ts::sameChar`'s rule and for its reason:
/// a lowercased *copy* of a line is not character-for-character the line the
/// snippet is cut out of.
fn same_char(a: char, b: char, case_sensitive: bool) -> bool {
    if a == b {
        return true;
    }
    if case_sensitive {
        return false;
    }
    a.to_lowercase().eq(b.to_lowercase())
}

/// Every match of `query` in `line`, as start indices into `line`, in order
/// and never overlapping — the char-slice twin of `fileFind.ts::findMatches`,
/// with the same whole-word rule (a boundary is demanded only on the sides
/// where the *query itself* ends in a word character, so `(x` still finds
/// `f(x)`).
///
/// Both sides are `&[char]` rather than `&str` because a snippet is cut by
/// character position: indexing a `&str` by byte offset is the one way this
/// could panic, and there is no reason to go near it.
fn line_matches(line: &[char], query: &[char], opts: SearchOptions) -> Vec<usize> {
    let mut out = Vec::new();
    if query.is_empty() || line.len() < query.len() {
        return out;
    }
    let head_is_word = is_word_char(query[0]);
    let tail_is_word = is_word_char(query[query.len() - 1]);
    let mut i = 0;
    while i + query.len() <= line.len() {
        let hit = (0..query.len()).all(|k| same_char(line[i + k], query[k], opts.case_sensitive));
        if !hit {
            i += 1;
            continue;
        }
        let end = i + query.len();
        if opts.whole_word
            && ((head_is_word && i > 0 && is_word_char(line[i - 1]))
                || (tail_is_word && line.get(end).copied().is_some_and(is_word_char)))
        {
            i += 1;
            continue;
        }
        out.push(i);
        // The scan index only ever moves forward — by one on a miss, by the
        // whole (non-empty) query on a hit — so no input can loop.
        i = end;
    }
    out
}

/// The snippet a result row paints: the line with its leading indentation
/// dropped, windowed around the match, `…` marking either cut.
///
/// Shaped here rather than in the client for the reason the offsets are not
/// on the wire at all ([`crate::core::types::FileSearchMatch`]): one
/// implementation, tested with `cargo test`, and a payload whose size is
/// bounded before it is serialized rather than after it is rendered.
fn snippet(line: &[char], at: usize) -> String {
    let indent = line.iter().take_while(|c| c.is_whitespace()).count();
    // A match *inside* the indentation (searching for a tab, say) must not
    // put the window before the text it is in.
    let body_start = indent.min(at);
    let start = at.saturating_sub(SNIPPET_LEAD).max(body_start);
    let end = (start + SNIPPET_MAX).min(line.len());
    let mut out = String::new();
    if start > body_start {
        out.push('…');
    }
    out.extend(&line[start..end]);
    if end < line.len() {
        out.push('…');
    }
    out
}

/// Every match of `query` under `root`, grouped by file — the project-wide
/// search behind `GET /api/projects/{id}/files/search` (mesa task 813) and
/// the Files tab's `Cmd/Ctrl+Shift+F` panel.
///
/// A **literal** scan, never a regular expression, for `fileFind.ts`'s reason:
/// a query is a user's typing, not a pattern language. `query` must be
/// non-empty and no longer than [`MAX_SEARCH_QUERY`]; the API layer rejects
/// both before calling, and an empty one here answers "no results" rather
/// than "every position".
///
/// What it reads is exactly what the Files tab can show, which is the whole
/// point of not reusing a `grep`:
///   - The walk is [`tree_level`]'s, applied recursively — [`EXCLUDED_DIRS`]
///     skipped by name, directories before files alphabetically, and symlinks
///     never followed (one rule covering escape and cycle at once), so no
///     result can name a path the tree would not list.
///   - A file is read through the same [`FILE_CONTENT_CAP`]-bounded read and
///     the same extension/NUL binary rules [`read_file`] applies, so a hit's
///     line number always exists in the viewer that opens next, and binary
///     bytes are never scanned or quoted.
///   - `root` itself is resolved once through [`safe_path`] and every
///     descendant is reached by walking real directory entries from there, so
///     nothing outside the project's `local_path` is ever opened.
///
/// Four caps bound the answer and the work
/// ([`MAX_SEARCH_MATCHES_PER_FILE`], [`MAX_SEARCH_FILES`],
/// [`MAX_SEARCH_TOTAL_MATCHES`], [`MAX_SEARCH_SCANNED_FILES`]); hitting any
/// of them sets `truncated` on the result, and the per-file one sets it on
/// that file as well. `None` only for a `root` that does not resolve to a
/// directory — the caller's 404, exactly as for [`tree_level`].
pub fn search_files(root: &str, query: &str, opts: SearchOptions) -> Option<ProjectFileSearch> {
    let root_canon = safe_path(root, ".")?;
    if !root_canon.is_dir() {
        return None;
    }
    let needle: Vec<char> = query.chars().collect();
    let mut out = ProjectFileSearch {
        files: Vec::new(),
        total_matches: 0,
        truncated: false,
    };
    if needle.is_empty() || needle.len() > MAX_SEARCH_QUERY {
        return Some(out);
    }
    let mut scanned = 0usize;
    search_dir(&root_canon, "", &needle, opts, &mut out, &mut scanned);
    Some(out)
}

/// One directory level of [`search_files`]'s walk: scan this level's files,
/// then recurse into its subdirectories, in the order [`tree_level`] lists
/// them. Stops the moment any cap is hit, which is what `out.truncated`
/// carries back up.
fn search_dir(
    dir: &Path,
    rel: &str,
    needle: &[char],
    opts: SearchOptions,
    out: &mut ProjectFileSearch,
    scanned: &mut usize,
) {
    if out.truncated {
        return;
    }
    // An unreadable directory is "no entries", not a failed search — the same
    // precedent `tree_level` takes for a permission change under it.
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        // symlink_metadata, so a symlink is a file leaf whatever it points at
        // — never recursed into, never opened as a directory.
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if meta.is_symlink() {
            continue;
        }
        entries.push((name, meta.is_dir()));
    }
    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    for (name, is_dir) in &entries {
        if *is_dir {
            continue;
        }
        if out.truncated {
            return;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        search_one_file(&dir.join(name), &child_rel, needle, opts, out, scanned);
    }
    for (name, is_dir) in &entries {
        if !*is_dir {
            continue;
        }
        if out.truncated {
            return;
        }
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        search_dir(&dir.join(name), &child_rel, needle, opts, out, scanned);
    }
}

/// Scan one file and append its group, if it has one.
fn search_one_file(
    path: &Path,
    rel: &str,
    needle: &[char],
    opts: SearchOptions,
    out: &mut ProjectFileSearch,
    scanned: &mut usize,
) {
    if *scanned >= MAX_SEARCH_SCANNED_FILES {
        out.truncated = true;
        return;
    }
    *scanned += 1;
    let ext = extension_of(path);
    if ext
        .as_deref()
        .is_some_and(|e| BINARY_EXTENSIONS.contains(&e))
    {
        return;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    let mut bytes = Vec::new();
    if (&mut file)
        .take(FILE_CONTENT_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    if sniff_binary(&bytes) {
        return;
    }
    let (content, _) = capped(&bytes);

    let mut matches: Vec<FileSearchMatch> = Vec::new();
    let mut file_truncated = false;
    'lines: for (i, line) in content.lines().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        for at in line_matches(&chars, needle, opts) {
            if matches.len() >= MAX_SEARCH_MATCHES_PER_FILE {
                file_truncated = true;
                break 'lines;
            }
            matches.push(FileSearchMatch {
                line: (i + 1) as u32,
                text: snippet(&chars, at),
            });
            if out.total_matches as usize + matches.len() >= MAX_SEARCH_TOTAL_MATCHES {
                out.truncated = true;
                break 'lines;
            }
        }
    }
    if matches.is_empty() {
        return;
    }
    out.total_matches += matches.len() as u32;
    out.files.push(FileSearchFile {
        path: rel.to_string(),
        language: extension_of(path)
            .as_deref()
            .and_then(language_of)
            .map(str::to_string),
        matches,
        truncated: file_truncated,
    });
    if out.files.len() >= MAX_SEARCH_FILES {
        out.truncated = true;
    }
}

/// NUL-byte sniff over the first 8 KiB — the standard cheap binary-file
/// heuristic (git and most editors use the same signal).
fn sniff_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(8192)];
    probe.contains(&0)
}

/// Lossy UTF-8, truncated to [`FILE_CONTENT_CAP`] on a char boundary (same
/// shape as `git.rs::capped`). Returns `(content, truncated)`.
fn capped(bytes: &[u8]) -> (String, bool) {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() <= FILE_CONTENT_CAP {
        return (s, false);
    }
    let cut = (0..=FILE_CONTENT_CAP)
        .rev()
        .find(|i| s.is_char_boundary(*i));
    s.truncate(cut.unwrap_or(0));
    (s, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    // --- safe_path -----------------------------------------------------

    #[test]
    fn safe_path_accepts_root_itself_and_nested_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/f.txt"), "hi").unwrap();

        assert!(safe_path(root, ".").is_some());
        let p = safe_path(root, "sub/f.txt").unwrap();
        assert!(p.ends_with("sub/f.txt"));
    }

    #[test]
    fn safe_path_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.to_str().unwrap();
        assert_eq!(safe_path(root, "../secret.txt"), None);
        assert_eq!(safe_path(root, "../../../../../../etc/passwd"), None);
    }

    #[test]
    fn safe_path_rejects_absolute_path_smuggling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(safe_path(root, "/etc/passwd"), None);
    }

    #[test]
    fn safe_path_rejects_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(safe_path(root, "nope.txt"), None);
    }

    #[test]
    fn safe_path_rejects_dead_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("gone");
        assert_eq!(safe_path(root.to_str().unwrap(), "f.txt"), None);
    }

    #[test]
    #[cfg(unix)]
    fn safe_path_rejects_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        assert_eq!(safe_path(root.to_str().unwrap(), "link.txt"), None);
    }

    #[test]
    #[cfg(unix)]
    fn safe_path_rejects_symlinked_dir_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("f.txt"), "x").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        assert_eq!(safe_path(root.to_str().unwrap(), "linkdir/f.txt"), None);
    }

    // --- list_dir --------------------------------------------------------

    #[test]
    fn list_dir_lists_subdirectories_only_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("zzz")).unwrap();
        fs::create_dir_all(root.join("aaa")).unwrap();
        fs::write(root.join("a_file.txt"), "x").unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["aaa", "zzz"]);
    }

    #[test]
    fn list_dir_does_not_exclude_dotfiles_or_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&".git"));
        assert!(names.contains(&"node_modules"));
    }

    #[test]
    fn list_dir_resolves_canonical_path_and_reports_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();

        let listing = list_dir(root.join("sub").join("..").to_str().unwrap()).unwrap();
        let canon_root = fs::canonicalize(root).unwrap();
        assert_eq!(listing.path, canon_root.to_string_lossy());
        let parent = canon_root.parent().unwrap().to_string_lossy().into_owned();
        assert_eq!(listing.parent.as_deref(), Some(parent.as_str()));
    }

    #[test]
    fn list_dir_none_for_root_relative_traversal_that_does_not_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(
            list_dir(root.join("does/not/exist/../../nope").to_str().unwrap()),
            None
        );
    }

    #[test]
    fn list_dir_none_for_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(list_dir(dir.path().join("gone").to_str().unwrap()), None);
    }

    #[test]
    fn list_dir_none_for_file_given_as_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "hi").unwrap();
        assert_eq!(list_dir(dir.path().join("f.txt").to_str().unwrap()), None);
    }

    // --- create_dir ------------------------------------------------------

    #[test]
    fn create_dir_makes_the_folder_and_returns_it_as_a_listable_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let entry = create_dir(root.to_str().unwrap(), "new proj").unwrap();
        assert_eq!(entry.name, "new proj");
        assert!(fs::metadata(&entry.path).unwrap().is_dir());
        // The returned path is exactly what `list_dir` would report for it,
        // so the caller can navigate straight into it.
        let listing = list_dir(&entry.path).unwrap();
        assert_eq!(listing.path, entry.path);
        assert!(
            list_dir(root.to_str().unwrap())
                .unwrap()
                .entries
                .iter()
                .any(|e| e.path == entry.path)
        );
    }

    #[test]
    fn create_dir_trims_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let entry = create_dir(dir.path().to_str().unwrap(), "  spaced  ").unwrap();
        assert_eq!(entry.name, "spaced");
    }

    #[test]
    fn create_dir_rejects_empty_dot_and_path_shaped_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for bad in ["", "   ", ".", "..", "a/b", "../escape", "a\\b", "a\0b"] {
            assert!(
                matches!(create_dir(root, bad), Err(CreateDirError::Validation(_))),
                "expected validation error for {bad:?}"
            );
        }
    }

    #[test]
    fn create_dir_conflicts_on_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir(dir.path().join("taken")).unwrap();
        fs::write(dir.path().join("afile"), "x").unwrap();

        assert_eq!(create_dir(root, "taken"), Err(CreateDirError::Conflict));
        assert_eq!(create_dir(root, "afile"), Err(CreateDirError::Conflict));
    }

    #[test]
    fn create_dir_not_found_for_missing_or_non_directory_parent() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "x").unwrap();

        assert_eq!(
            create_dir(dir.path().join("gone").to_str().unwrap(), "x"),
            Err(CreateDirError::NotFound)
        );
        assert_eq!(
            create_dir(dir.path().join("f.txt").to_str().unwrap(), "x"),
            Err(CreateDirError::NotFound)
        );
    }

    #[test]
    #[cfg(unix)]
    fn list_dir_follows_symlinked_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        let listing = list_dir(root.to_str().unwrap()).unwrap();
        let entry = listing
            .entries
            .iter()
            .find(|e| e.name == "linkdir")
            .unwrap();
        // Listed as a directory (the symlink is followed to classify it),
        // but its `path` stays the symlink's own location, not the resolved
        // target — basename(path) == name always holds.
        let canon_root = fs::canonicalize(&root).unwrap();
        assert_eq!(entry.path, canon_root.join("linkdir").to_string_lossy());
    }

    // --- tree_level --------------------------------------------------------

    #[test]
    fn tree_level_excludes_vcs_and_dependency_dirs_and_sorts_dirs_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("zzz_dir")).unwrap();
        fs::write(root.join("a_file.txt"), "a").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();

        let (level, truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert!(!truncated);
        let names: Vec<&str> = level.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"target"));
        // Directories sort before files.
        assert_eq!(names[0], "zzz_dir");
        assert_eq!(names[1], "a_file.txt");

        let zzz = level.iter().find(|e| e.name == "zzz_dir").unwrap();
        assert!(zzz.is_dir);
        let file = level.iter().find(|e| e.name == "a_file.txt").unwrap();
        assert!(!file.is_dir);
    }

    #[test]
    fn tree_level_reports_truncated_when_entry_cap_hit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..(MAX_TREE_ENTRIES + 5) {
            fs::write(root.join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let (level, truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert!(truncated);
        assert!(level.len() <= MAX_TREE_ENTRIES);
    }

    #[test]
    fn tree_level_only_lists_one_level_deep() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::write(root.join("a/b/c/deep.txt"), "x").unwrap();

        let (level, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        assert_eq!(level.len(), 1);
        assert_eq!(level[0].name, "a");
        assert!(level[0].is_dir);
    }

    #[test]
    fn tree_level_relative_paths_use_forward_slashes_and_nest_via_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/f.txt"), "x").unwrap();

        let (top, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        let sub = top.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(sub.path, "sub");

        let (children, _truncated) = tree_level(root.to_str().unwrap(), "sub").unwrap();
        assert_eq!(children[0].path, "sub/f.txt");
    }

    #[test]
    #[cfg(unix)]
    fn tree_level_lists_symlinked_dir_as_file_leaf_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        let (level, _truncated) = tree_level(root.to_str().unwrap(), "").unwrap();
        let link = level.iter().find(|e| e.name == "linkdir").unwrap();
        assert!(!link.is_dir);
    }

    #[test]
    fn tree_level_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        assert_eq!(tree_level(root.to_str().unwrap(), "../"), None);
    }

    #[test]
    fn tree_level_none_for_file_given_as_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("f.txt"), "hi").unwrap();
        assert_eq!(tree_level(root, "f.txt"), None);
    }

    #[test]
    fn tree_level_none_for_nonexistent_rel() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(tree_level(root, "nope"), None);
    }

    // --- read_file --------------------------------------------------------

    #[test]
    fn read_file_returns_content_with_language() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();

        let v = read_file(root, "main.rs").unwrap();
        assert_eq!(v.path, "main.rs");
        assert!(!v.is_binary);
        assert_eq!(v.content, "fn main() {}\n");
        assert!(!v.truncated);
        assert_eq!(v.language.as_deref(), Some("rust"));
    }

    #[test]
    fn read_file_tags_cs_as_csharp() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("Program.cs"), "class P {}\n").unwrap();

        let v = read_file(root, "Program.cs").unwrap();
        assert!(!v.is_binary);
        assert_eq!(v.language.as_deref(), Some("csharp"));
    }

    #[test]
    fn read_file_caps_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_CONTENT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let v = read_file(root, "big.txt").unwrap();
        assert!(!v.is_binary);
        assert!(v.truncated);
        assert!(v.content.len() <= FILE_CONTENT_CAP);
    }

    #[test]
    fn read_file_detects_binary_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        let v = read_file(root, "img.png").unwrap();
        assert!(v.is_binary);
        assert_eq!(v.content, "");
        assert!(!v.truncated);
    }

    #[test]
    fn read_file_detects_binary_by_nul_byte_sniff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let mut bytes = b"some header".to_vec();
        bytes.push(0);
        bytes.extend_from_slice(b"more data");
        fs::write(dir.path().join("weird.dat"), &bytes).unwrap();

        let v = read_file(root, "weird.dat").unwrap();
        assert!(v.is_binary);
        assert_eq!(v.content, "");
    }

    #[test]
    fn read_file_none_for_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(read_file(root, "nope.txt"), None);
    }

    #[test]
    fn read_file_none_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(read_file(root, "sub"), None);
    }

    #[test]
    fn read_file_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        assert_eq!(read_file(root.to_str().unwrap(), "../secret.txt"), None);
    }

    #[test]
    fn read_file_unrecognized_extension_has_no_language() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("notes.xyz"), "plain text").unwrap();
        let v = read_file(root, "notes.xyz").unwrap();
        assert_eq!(v.language, None);
    }

    // --- image_mime (mesa task 801) ------------------------------------------

    #[test]
    fn image_mime_accepts_every_allowlisted_extension_case_insensitively() {
        for (name, mime) in [
            ("a.png", "image/png"),
            ("A.PNG", "image/png"),
            ("a.jpg", "image/jpeg"),
            ("x.JPEG", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.gif", "image/gif"),
            ("a.GIF", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.WebP", "image/webp"),
            ("a.bmp", "image/bmp"),
            ("a.ico", "image/x-icon"),
            ("a.svg", "image/svg+xml"),
            ("a.SVG", "image/svg+xml"),
            ("deep/nested/dir/photo.PnG", "image/png"),
        ] {
            assert_eq!(image_mime(name), Some(mime), "{name}");
        }
    }

    #[test]
    fn image_mime_rejects_markup_source_and_extensionless_names() {
        // `.html`/`.htm` above all: the route must never be able to return
        // same-origin markup. A double extension is judged by its LAST one.
        for name in [
            "a.html",
            "a.htm",
            "a.md",
            "a.rs",
            "a.json",
            "noext",
            "foo.png.html",
            ".gitignore",
            "a.pdf",
            "a.txt",
        ] {
            assert_eq!(image_mime(name), None, "{name}");
        }
    }

    #[test]
    fn language_of_tags_svg() {
        assert_eq!(language_of("svg"), Some("svg"));
    }

    #[test]
    fn language_of_tags_dotnet_markup_as_xml() {
        assert_eq!(language_of("csproj"), Some("xml"));
        assert_eq!(language_of("xaml"), Some("xml"));
        assert_eq!(language_of("xml"), Some("xml"));
    }

    #[test]
    fn read_file_tags_csproj_as_xml() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(
            dir.path().join("App.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        )
        .unwrap();

        let v = read_file(root, "App.csproj").unwrap();
        assert!(!v.is_binary);
        assert_eq!(v.language.as_deref(), Some("xml"));
    }

    // --- read_file_download -------------------------------------------------

    #[test]
    fn read_file_download_returns_basename_and_full_text_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src/core")).unwrap();
        fs::write(dir.path().join("src/core/main.rs"), "fn main() {}\n").unwrap();

        let (name, bytes) = read_file_download(root, "src/core/main.rs").unwrap();
        // The final component, never the `rel` that was asked for.
        assert_eq!(name, "main.rs");
        assert_eq!(bytes, b"fn main() {}\n");
    }

    #[test]
    fn read_file_download_returns_binary_bytes_verbatim_including_nuls() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let raw: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x0d, 0x0a];
        fs::write(dir.path().join("img.png"), &raw).unwrap();
        // The display path shows nothing for this file — the download must
        // still hand back every byte, unchanged and not lossy-UTF-8'd.
        assert!(read_file(root, "img.png").unwrap().is_binary);

        let (name, bytes) = read_file_download(root, "img.png").unwrap();
        assert_eq!(name, "img.png");
        assert_eq!(bytes, raw);
    }

    #[test]
    fn read_file_download_returns_an_over_display_cap_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_CONTENT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();
        // The viewer shows this one `truncated`; the download is the whole file.
        assert!(read_file(root, "big.txt").unwrap().truncated);

        let (_, bytes) = read_file_download(root, "big.txt").unwrap();
        assert_eq!(bytes.len(), big.len());
        assert_eq!(bytes, big.as_bytes());
    }

    #[test]
    fn read_file_download_not_found_for_traversal_absolute_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();
        let root = root.to_str().unwrap();

        for bad in ["../secret.txt", "/etc/passwd", "nope.txt"] {
            assert_eq!(
                read_file_download(root, bad),
                Err(DownloadFileError::NotFound),
                "path {bad:?}"
            );
        }
    }

    #[test]
    fn read_file_download_not_found_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(
            read_file_download(root, "sub"),
            Err(DownloadFileError::NotFound)
        );
    }

    #[test]
    #[cfg(unix)]
    fn read_file_download_not_found_for_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        assert_eq!(
            read_file_download(root.to_str().unwrap(), "link.txt"),
            Err(DownloadFileError::NotFound)
        );
    }

    #[test]
    fn read_file_download_cap_sits_far_above_the_display_cap() {
        // No 100 MiB fixture: the length check is asserted by the one property
        // that matters for the cases above — every file the viewer can open,
        // truncated ones included, is comfortably under the download cap.
        assert!(FILE_DOWNLOAD_CAP > FILE_CONTENT_CAP as u64);
    }

    // --- write_file ---------------------------------------------------------

    #[test]
    fn write_file_overwrites_existing_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();

        assert_eq!(
            write_file(root, "main.rs", "fn main() { edited(); }\n"),
            Ok(())
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("main.rs")).unwrap(),
            "fn main() { edited(); }\n"
        );
    }

    #[test]
    fn write_file_none_for_traversal_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "top secret").unwrap();

        assert_eq!(
            write_file(root.to_str().unwrap(), "../secret.txt", "pwned"),
            Err(WriteFileError::NotFound)
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("secret.txt")).unwrap(),
            "top secret"
        );
    }

    #[test]
    fn write_file_not_found_for_nonexistent_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert_eq!(
            write_file(root, "nope.txt", "hi"),
            Err(WriteFileError::NotFound)
        );
    }

    #[test]
    fn write_file_not_found_for_directory_given_as_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("sub")).unwrap();
        assert_eq!(write_file(root, "sub", "hi"), Err(WriteFileError::NotFound));
    }

    #[test]
    fn write_file_rejects_binary_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("img.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

        assert_eq!(
            write_file(root, "img.png", "not a real png"),
            Err(WriteFileError::Validation("cannot edit a binary file"))
        );
    }

    #[test]
    fn write_file_rejects_truncated_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let big = "a".repeat(FILE_CONTENT_CAP + 1000);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let err = write_file(root, "big.txt", "short replacement").unwrap_err();
        assert_eq!(
            err,
            WriteFileError::Validation("file is larger than mesa can safely edit")
        );
        // The write must never have happened — the file is untouched.
        assert_eq!(fs::read_to_string(dir.path().join("big.txt")).unwrap(), big);
    }

    #[test]
    fn write_file_rejects_oversized_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("small.txt"), "hi").unwrap();
        let big_content = "a".repeat(FILE_CONTENT_CAP + 1);

        let err = write_file(root, "small.txt", &big_content).unwrap_err();
        assert_eq!(
            err,
            WriteFileError::Validation("content is larger than mesa can safely write")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("small.txt")).unwrap(),
            "hi"
        );
    }

    // --- create_file --------------------------------------------------------

    #[test]
    fn create_file_makes_an_empty_file_at_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        assert_eq!(create_file(root, "notes.md"), Ok(()));
        assert_eq!(fs::read_to_string(dir.path().join("notes.md")).unwrap(), "");
    }

    #[test]
    fn create_file_makes_an_empty_file_inside_a_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::create_dir_all(dir.path().join("src/core")).unwrap();

        assert_eq!(create_file(root, "src/core/new.rs"), Ok(()));
        assert!(dir.path().join("src/core/new.rs").is_file());
    }

    #[test]
    fn create_file_reads_back_through_read_file_as_empty_content() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        create_file(root, "fresh.rs").unwrap();
        let view = read_file(root, "fresh.rs").unwrap();
        assert_eq!(view.content, "");
        assert!(!view.is_binary);
        assert!(!view.truncated);
        assert_eq!(view.language.as_deref(), Some("rust"));
    }

    #[test]
    fn create_file_not_found_for_traversal_and_absolute_parents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(&root).unwrap();
        let root = root.to_str().unwrap();

        assert_eq!(
            create_file(root, "../escape.txt"),
            Err(CreateFileError::NotFound)
        );
        assert_eq!(
            create_file(root, "/tmp/mesa-create-file-escape.txt"),
            Err(CreateFileError::NotFound)
        );
        assert_eq!(
            create_file(root, "a/../../x"),
            Err(CreateFileError::NotFound)
        );
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn create_file_not_found_when_the_parent_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("README.md"), "hi").unwrap();

        assert_eq!(
            create_file(root, "README.md/x.txt"),
            Err(CreateFileError::NotFound)
        );
    }

    #[test]
    fn create_file_rejects_empty_dot_and_path_shaped_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();

        assert_eq!(
            create_file(root, ""),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        assert_eq!(
            create_file(root, "   "),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        // A trailing slash leaves nothing for the final component.
        assert_eq!(
            create_file(root, "sub/"),
            Err(CreateFileError::Validation("file name cannot be empty"))
        );
        assert_eq!(
            create_file(root, "."),
            Err(CreateFileError::Validation("file name cannot be . or .."))
        );
        assert_eq!(
            create_file(root, ".."),
            Err(CreateFileError::Validation("file name cannot be . or .."))
        );
        // A separator surviving into the final component — `/` is consumed by
        // the parent split, so this is the backslash half of the same rule.
        assert_eq!(
            create_file(root, "a\\b"),
            Err(CreateFileError::Validation(
                "file name must be a single name, not a path"
            ))
        );
        assert_eq!(
            create_file(root, "x\0y"),
            Err(CreateFileError::Validation(
                "file name must be a single name, not a path"
            ))
        );
    }

    #[test]
    fn create_file_conflicts_on_an_existing_file_or_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("taken.txt"), "keep me").unwrap();
        fs::create_dir_all(dir.path().join("adir")).unwrap();

        assert_eq!(
            create_file(root, "taken.txt"),
            Err(CreateFileError::Conflict)
        );
        assert_eq!(create_file(root, "adir"), Err(CreateFileError::Conflict));
        // The existing file's content is untouched — a create is never a write.
        assert_eq!(
            fs::read_to_string(dir.path().join("taken.txt")).unwrap(),
            "keep me"
        );
    }

    // --- search_files (mesa task 813) ----------------------------------

    fn seed_search_tree(dir: &std::path::Path) {
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(
            dir.join("README.md"),
            "the needle is here\nand nowhere else\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    let needle = 1; // needle again\n    let Needle = 2;\n}\n",
        )
        .unwrap();
        fs::write(dir.join("node_modules/dep.js"), "needle needle needle\n").unwrap();
        fs::write(dir.join("logo.png"), "needle").unwrap();
        fs::write(dir.join("blob.dat"), b"nee\0dle needle").unwrap();
    }

    #[test]
    fn search_files_groups_hits_by_file_and_skips_excluded_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();

        // Files before directories is `tree_level`'s order: README.md then
        // src/main.rs. `node_modules` (excluded), the `.png` (binary
        // extension) and the NUL-carrying `.dat` are all absent.
        let paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/main.rs"]);
        assert!(!res.truncated);
        // Case-insensitive by default, so `Needle` on line 3 counts, and the
        // two on line 2 are two rows.
        assert_eq!(res.total_matches, 4);
        assert_eq!(res.files[0].matches[0].line, 1);
        assert_eq!(res.files[0].language.as_deref(), Some("markdown"));
        let rs = &res.files[1];
        assert_eq!(rs.language.as_deref(), Some("rust"));
        assert_eq!(
            rs.matches.iter().map(|m| m.line).collect::<Vec<_>>(),
            vec![2, 2, 3]
        );
        // Leading indentation is dropped from the snippet, and the whole
        // (short) line survives otherwise.
        assert_eq!(rs.matches[0].text, "let needle = 1; // needle again");
    }

    #[test]
    fn search_files_honours_case_and_whole_word() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let sensitive = search_files(
            root,
            "Needle",
            SearchOptions {
                case_sensitive: true,
                whole_word: false,
            },
        )
        .unwrap();
        assert_eq!(sensitive.total_matches, 1);
        assert_eq!(sensitive.files[0].path, "src/main.rs");
        assert_eq!(sensitive.files[0].matches[0].line, 3);

        fs::write(dir.path().join("words.txt"), "needle needles needle_x\n").unwrap();
        let whole = search_files(
            root,
            "needle",
            SearchOptions {
                case_sensitive: false,
                whole_word: true,
            },
        )
        .unwrap();
        let words = whole
            .files
            .iter()
            .find(|f| f.path == "words.txt")
            .expect("words.txt has a whole-word hit");
        assert_eq!(words.matches.len(), 1);
    }

    #[test]
    fn search_files_caps_matches_per_file_and_flags_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let body = "needle\n".repeat(MAX_SEARCH_MATCHES_PER_FILE + 10);
        fs::write(dir.path().join("many.txt"), body).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        assert_eq!(res.files.len(), 1);
        assert_eq!(res.files[0].matches.len(), MAX_SEARCH_MATCHES_PER_FILE);
        assert!(res.files[0].truncated);
        assert_eq!(res.total_matches as usize, MAX_SEARCH_MATCHES_PER_FILE);
    }

    #[test]
    fn search_files_windows_a_long_line_around_the_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        fs::write(dir.path().join("min.js"), line).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        let text = &res.files[0].matches[0].text;
        // Cut on both sides, marked on both sides, and bounded — never the
        // whole 1,006-character line.
        assert!(text.starts_with('…'), "{text}");
        assert!(text.ends_with('…'), "{text}");
        assert!(text.contains("needle"), "{text}");
        assert_eq!(text.chars().count(), SNIPPET_MAX + 2);
    }

    #[test]
    fn search_files_rejects_nothing_and_finds_nothing_for_an_empty_query() {
        let dir = tempfile::tempdir().unwrap();
        seed_search_tree(dir.path());
        let root = dir.path().to_str().unwrap();

        let res = search_files(root, "", SearchOptions::default()).unwrap();
        assert!(res.files.is_empty());
        assert_eq!(res.total_matches, 0);
        assert!(!res.truncated);

        let long = "n".repeat(MAX_SEARCH_QUERY + 1);
        assert!(
            search_files(root, &long, SearchOptions::default())
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[test]
    fn search_files_is_none_for_a_dead_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        assert!(search_files(missing.to_str().unwrap(), "x", SearchOptions::default()).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn search_files_never_follows_a_symlink_out_of_the_root() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "needle outside\n").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        fs::write(dir.path().join("inside.txt"), "needle inside\n").unwrap();
        symlink(outside.path(), dir.path().join("link")).unwrap();

        let res = search_files(root, "needle", SearchOptions::default()).unwrap();
        let paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["inside.txt"]);
    }
}
