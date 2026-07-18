//! File-tree listing + file-content reads/writes rooted at a project's
//! `local_path` (see `.scratch/arch.md` under mesa task 277/278 for the
//! cross-area contract). Like `core::git`/`core::agents`, this module touches
//! EXTERNAL filesystem state only — `std::fs`, no `Store` dependency beyond
//! whatever `local_path` string its caller (279's API layer) already
//! resolved. `write_file` (task 327) is the one write in the module — it
//! overwrites an existing text file's content in place; it never creates,
//! deletes, or renames anything.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::core::types::{DirEntry, DirListing, FileContentView, FileTreeEntry};

/// Mirrors `git.rs`'s `DIFF_CAP` precedent: one huge file can't balloon the
/// JSON response.
const FILE_CONTENT_CAP: usize = 256 * 1024;

/// Total nodes added across a `tree_of` walk before it stops adding more.
const MAX_TREE_ENTRIES: usize = 2_000;

/// Directory nesting levels `tree_of` will descend before it stops
/// descending further.
const MAX_TREE_DEPTH: usize = 12;

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
        "css" => "css",
        "go" => "go",
        "rb" => "ruby",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" => "cpp",
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

/// Walks `root` (assumed already verified as a live, readable directory by
/// the caller — same division of labor as `git.rs`'s `is_dir` check living
/// in `api.rs`, not in `view_of`). Excludes [`EXCLUDED_DIRS`] by name at any
/// depth, sorts directories-before-files alphabetically at each level, stops
/// descending/adding once [`MAX_TREE_DEPTH`] or [`MAX_TREE_ENTRIES`] is hit.
/// Symlinks are listed but never followed (`is_dir: false` for a symlinked
/// dir — avoids both escape and cycle risk with one rule). Any `read_dir`
/// error on a sub-directory (permissions) is swallowed as "no children" for
/// that node, not a failure of the whole walk.
pub fn tree_of(root: &str) -> (Vec<FileTreeEntry>, bool) {
    let mut count = 0usize;
    let mut truncated = false;
    let entries = walk_dir(Path::new(root), "", 0, &mut count, &mut truncated);
    (entries, truncated)
}

/// Reads one directory's entries, recursing into subdirectories up to
/// `MAX_TREE_DEPTH`, tracking the total node count against
/// `MAX_TREE_ENTRIES` in `count` and setting `truncated` when either cap is
/// hit anywhere in the walk. `rel_prefix` is `dir`'s own path relative to the
/// tree root ("" for the root itself), so each entry's relative path is
/// assembled incrementally instead of re-deriving it from the root each call.
fn walk_dir(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    count: &mut usize,
    truncated: &mut bool,
) -> Vec<FileTreeEntry> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut raw: Vec<(String, PathBuf, bool)> = Vec::new();
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
        let is_dir = meta.is_dir();
        raw.push((name, entry.path(), is_dir));
    }
    // Directories before files, alphabetical within each group.
    raw.sort_by(|a, b| match (a.2, b.2) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });

    let mut out = Vec::new();
    for (name, path, is_dir) in raw {
        if *count >= MAX_TREE_ENTRIES {
            *truncated = true;
            break;
        }
        *count += 1;
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let children = if is_dir {
            if depth + 1 >= MAX_TREE_DEPTH {
                *truncated = true;
                Some(Vec::new())
            } else {
                Some(walk_dir(&path, &rel, depth + 1, count, truncated))
            }
        } else {
            None
        };
        out.push(FileTreeEntry {
            name,
            path: rel,
            is_dir,
            children,
        });
    }
    out
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
///    found" precedent `tree_of`'s per-subdirectory `read_dir` errors use.
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

    // --- tree_of ---------------------------------------------------------

    #[test]
    fn tree_of_excludes_vcs_and_dependency_dirs_and_sorts_dirs_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join("zzz_dir")).unwrap();
        fs::write(root.join("a_file.txt"), "a").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();

        let (tree, truncated) = tree_of(root.to_str().unwrap());
        assert!(!truncated);
        let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"target"));
        // Directories sort before files.
        assert_eq!(names[0], "zzz_dir");
        assert_eq!(names[1], "a_file.txt");

        let zzz = tree.iter().find(|e| e.name == "zzz_dir").unwrap();
        assert!(zzz.is_dir);
        assert_eq!(zzz.children, Some(Vec::new()));
        let file = tree.iter().find(|e| e.name == "a_file.txt").unwrap();
        assert!(!file.is_dir);
        assert_eq!(file.children, None);
    }

    #[test]
    fn tree_of_reports_truncated_when_entry_cap_hit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..(MAX_TREE_ENTRIES + 5) {
            fs::write(root.join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let (tree, truncated) = tree_of(root.to_str().unwrap());
        assert!(truncated);
        assert!(tree.len() <= MAX_TREE_ENTRIES);
    }

    #[test]
    fn tree_of_reports_truncated_when_depth_cap_hit() {
        let dir = tempfile::tempdir().unwrap();
        let mut cur = dir.path().to_path_buf();
        for i in 0..(MAX_TREE_DEPTH + 3) {
            cur = cur.join(format!("d{i}"));
            fs::create_dir_all(&cur).unwrap();
        }
        let (_tree, truncated) = tree_of(dir.path().to_str().unwrap());
        assert!(truncated);
    }

    #[test]
    fn tree_of_relative_paths_use_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/f.txt"), "x").unwrap();
        let (tree, _truncated) = tree_of(root.to_str().unwrap());
        let sub = tree.iter().find(|e| e.name == "sub").unwrap();
        let children = sub.children.as_ref().unwrap();
        assert_eq!(children[0].path, "sub/f.txt");
    }

    #[test]
    #[cfg(unix)]
    fn tree_of_lists_symlinked_dir_as_file_leaf_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "top secret").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();

        let (tree, _truncated) = tree_of(root.to_str().unwrap());
        let link = tree.iter().find(|e| e.name == "linkdir").unwrap();
        assert!(!link.is_dir);
        assert_eq!(link.children, None);
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
}
