//! Git status of a project's `local_path`: branch, dirty count, ahead/behind.
//! Shells out to `git` (like the CLI's root-commit calls — no libgit2
//! dependency) and reads EXTERNAL state only; nothing here touches the mesa
//! store. Decorative data for the sidebar: any failure (no repo, no git,
//! detached folder) is `None`, never an error surfaced to the client.

use std::process::{Command, Stdio};

use crate::core::types::{GitCommit, GitCommitFile, GitFile, GitRepoView, GitStatus};

/// Diff text is capped so one huge file can't balloon the JSON response
/// (hooks' 64 KiB output cap precedent, scaled for diffs).
const DIFF_CAP: usize = 256 * 1024;

/// Cap on `commit_log_of` — recent history for browsing, not a full walk; no
/// pagination UI (spec W2), so a fixed size. 100 is generous for "browse
/// recent history" while keeping the `git log` call and response bounded
/// (same order-of-magnitude judgement as DIFF_CAP).
const LOG_CAP: usize = 100;

/// Reads the working-tree status of the repo at `dir`, or `None` when `dir`
/// is not a git repo / git is unavailable.
pub fn status_of(dir: &str) -> Option<GitStatus> {
    let out = Command::new("git")
        .args(["-C", dir, "status", "--porcelain=v2", "--branch"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_status(&String::from_utf8_lossy(&out.stdout)))
}

/// Kept pure (text in, status out) so the porcelain contract is unit-testable
/// without spawning git, like agents.rs's `parse_sessions`.
fn parse_status(porcelain: &str) -> GitStatus {
    let mut branch = String::new();
    let mut oid = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut dirty = 0;
    for line in porcelain.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            oid = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+<ahead> -<behind>"; only present when an upstream is set.
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.is_empty() {
            // Every non-header line is one changed/untracked/conflicted path.
            dirty += 1;
        }
    }
    if branch == "(detached)" {
        // No branch name to show; the short commit id is the position.
        branch = oid.chars().take(8).collect();
    }
    GitStatus {
        branch,
        dirty,
        ahead,
        behind,
    }
}

/// Full working-tree view of the repo at `dir` (branch summary + per-file
/// change list), or `None` when `dir` is not a git repo / git is unavailable.
/// Same single porcelain call as `status_of`.
pub fn view_of(dir: &str) -> Option<GitRepoView> {
    let out = Command::new("git")
        .args(["-C", dir, "status", "--porcelain=v2", "--branch"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_view(&String::from_utf8_lossy(&out.stdout)))
}

/// Kept pure (text in, view out) so the porcelain contract is unit-testable
/// without spawning git, like `parse_status`.
fn parse_view(porcelain: &str) -> GitRepoView {
    let mut files = Vec::new();
    for line in porcelain.lines() {
        // '1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>'
        if let Some(rest) = line.strip_prefix("1 ") {
            let mut it = rest.splitn(8, ' ');
            let status = it.next().unwrap_or("").to_string();
            if let Some(path) = it.nth(6) {
                files.push(GitFile {
                    status,
                    path: path.to_string(),
                    orig_path: None,
                });
            }
        // '2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>'
        } else if let Some(rest) = line.strip_prefix("2 ") {
            let mut it = rest.splitn(9, ' ');
            let status = it.next().unwrap_or("").to_string();
            if let Some(paths) = it.nth(7) {
                let (path, orig) = match paths.split_once('\t') {
                    Some((p, o)) => (p, Some(o.to_string())),
                    None => (paths, None),
                };
                files.push(GitFile {
                    status,
                    path: path.to_string(),
                    orig_path: orig,
                });
            }
        // 'u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>'
        } else if let Some(rest) = line.strip_prefix("u ") {
            let mut it = rest.splitn(10, ' ');
            let status = it.next().unwrap_or("").to_string();
            if let Some(path) = it.nth(8) {
                files.push(GitFile {
                    status,
                    path: path.to_string(),
                    orig_path: None,
                });
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            files.push(GitFile {
                status: "??".to_string(),
                path: path.to_string(),
                orig_path: None,
            });
        }
    }
    GitRepoView {
        status: parse_status(porcelain),
        files,
    }
}

/// Unified diff for one path from the status list — staged + unstaged as one
/// diff vs HEAD; untracked rendered all-added via `--no-index /dev/null`.
/// `None` on any git failure; binary files carry git's own
/// "Binary files ... differ" line as the diff text.
pub fn diff_of(dir: &str, path: &str, untracked: bool) -> Option<String> {
    if untracked {
        // `--no-index` exits 1 when the files differ — that IS the diff.
        return run_diff(
            dir,
            &["diff", "--no-index", "--", "/dev/null", path],
            &[0, 1],
        );
    }
    // Unborn HEAD (no commits yet) makes `diff HEAD` fail; fall back to the
    // index-only then worktree-only reads before giving up.
    run_diff(dir, &["diff", "HEAD", "--", path], &[0])
        .or_else(|| run_diff(dir, &["diff", "--cached", "--", path], &[0]))
        .or_else(|| run_diff(dir, &["diff", "--", path], &[0]))
}

/// Runs one read-only `git -C <dir> <args…>`, accepting the listed exit
/// codes; lossy UTF-8 stdout, capped at [`DIFF_CAP`] on a char boundary.
fn run_diff(dir: &str, args: &[&str], ok_codes: &[i32]) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", dir])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !ok_codes.contains(&out.status.code()?) {
        return None;
    }
    Some(capped(&out.stdout))
}

/// Lossy UTF-8, truncated to [`DIFF_CAP`] on a char boundary (the hooks
/// `capped` shape).
fn capped(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() > DIFF_CAP {
        let cut = (0..=DIFF_CAP).rev().find(|i| s.is_char_boundary(*i));
        s.truncate(cut.unwrap_or(0));
        s.push_str("\n[diff truncated]");
    }
    s
}

/// Recent commit log (`git -C <dir> log -n LOG_CAP --date=iso-strict
/// --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s`), newest first (git log's
/// default order). Empty vec on ANY failure — not a repo, or a real repo
/// with an unborn HEAD (no commits yet) are indistinguishable at this level
/// on purpose; the caller has already established repo validity via
/// `project_git_view`, so here "git log failed" only ever means "no commits
/// yet" in practice, and either way an empty list is the correct quiet
/// result (M9).
pub fn commit_log_of(dir: &str) -> Vec<GitCommit> {
    let out = Command::new("git")
        .args(["-C", dir])
        .args([
            "log",
            "-n",
            &LOG_CAP.to_string(),
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s",
        ])
        .stdin(Stdio::null())
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_log(&String::from_utf8_lossy(&out.stdout))
}

/// Kept pure like parse_status/parse_view: splits `%x1f`-joined fields per
/// line (unit separator — commit subjects/authors can contain almost
/// anything but a newline, so a control byte avoids delimiter collisions
/// that a tab or comma could hit).
fn parse_log(text: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut it = line.split('\u{1f}');
        let (hash, short_hash, author, date, subject) = (
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
        );
        commits.push(GitCommit {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            author: author.to_string(),
            date: date.to_string(),
            subject: subject.to_string(),
        });
    }
    commits
}

/// Defense-in-depth (M8): rejects anything that isn't plausibly a git hash
/// BEFORE it reaches a `git` subprocess, so a commit id can never be read as
/// a flag (leading `-`) or a path. 7..=64 hex chars — covers any sha1
/// abbreviation up to a full sha1 (40) and full sha256 (64) without
/// hardcoding one hash algorithm; our own `commit_log_of` always hands back
/// full 40-char hashes, so in practice callers built against this contract
/// never send anything shorter.
fn is_valid_commit_id(sha: &str) -> bool {
    let len = sha.len();
    (7..=64).contains(&len) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Files changed in one commit: `git -C <dir> show --no-color --name-status
/// --format= <sha>` (`--format=` suppresses the commit header, leaving only
/// the name-status lines — works unmodified for the root/initial commit,
/// which `git show` diffs against the empty tree, satisfying M4; for merge
/// commits this is git's own default combined-diff behavior, per the spec's
/// stated assumption). `sha` is validated by `is_valid_commit_id` (M8)
/// BEFORE the Command is built; an invalid shape short-circuits to `None`
/// without spawning git. `None` on invalid shape or git failure (unknown
/// sha, not a repo) — the caller maps this to `not_found`. `Some(vec![])`
/// is a legitimate answer (an empty commit).
pub fn commit_files_of(dir: &str, sha: &str) -> Option<Vec<GitCommitFile>> {
    if !is_valid_commit_id(sha) {
        return None;
    }
    let out = Command::new("git")
        .args(["-C", dir])
        .args(["show", "--no-color", "--name-status", "--format=", sha])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_commit_files(&String::from_utf8_lossy(&out.stdout)))
}

/// Kept pure: parses `git show --name-status` lines. Two shapes, tab-
/// separated: `STATUS\tpath` (add/modify/delete/etc.) and
/// `STATUS\told_path\tnew_path` (rename/copy, STATUS carries a similarity
/// score e.g. "R100").
fn parse_commit_files(text: &str) -> Vec<GitCommitFile> {
    let mut files = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let status = parts.next().unwrap_or("").to_string();
        let a = parts.next();
        let b = parts.next();
        let (path, orig_path) = match (a, b) {
            (Some(old), Some(new)) => (new.to_string(), Some(old.to_string())),
            (Some(p), None) => (p.to_string(), None),
            (None, _) => continue,
        };
        files.push(GitCommitFile {
            status,
            path,
            orig_path,
        });
    }
    files
}

/// One file's diff as introduced by one commit: `git -C <dir> show
/// --no-color <sha> -- <path>` via the existing `run_diff` helper (same
/// DIFF_CAP truncation as working-tree diffs, S4). Root commit renders
/// fully-added (M4) because `git show` on the first commit diffs against
/// the empty tree, same as commit_files_of. `sha` validated the same way
/// (M8); `None` on invalid shape or git failure.
pub fn commit_file_diff_of(dir: &str, sha: &str, path: &str) -> Option<String> {
    if !is_valid_commit_id(sha) {
        return None;
    }
    run_diff(dir, &["show", "--no-color", sha, "--", path], &[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_with_upstream_and_changes() {
        let s = parse_status(
            "# branch.oid 1111111111111111111111111111111111111111\n\
             # branch.head main\n\
             # branch.upstream origin/main\n\
             # branch.ab +2 -1\n\
             1 .M N... 100644 100644 100644 aaa bbb src/lib.rs\n\
             2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs\n\
             ? untracked.txt\n",
        );
        assert_eq!(s.branch, "main");
        assert_eq!(s.dirty, 3);
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
    }

    #[test]
    fn parses_clean_branch_without_upstream() {
        let s = parse_status(
            "# branch.oid 2222222222222222222222222222222222222222\n\
             # branch.head feature/x\n",
        );
        assert_eq!(s.branch, "feature/x");
        assert_eq!(s.dirty, 0);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
    }

    #[test]
    fn detached_head_shows_short_oid() {
        let s = parse_status(
            "# branch.oid deadbeefcafe0000000000000000000000000000\n\
             # branch.head (detached)\n",
        );
        assert_eq!(s.branch, "deadbeef");
    }

    #[test]
    fn parse_view_reads_headers_and_all_file_line_kinds() {
        let v = parse_view(
            "# branch.oid 1111111111111111111111111111111111111111\n\
             # branch.head main\n\
             # branch.upstream origin/main\n\
             # branch.ab +2 -1\n\
             1 .M N... 100644 100644 100644 aaa bbb src/lib.rs\n\
             1 MM N... 100644 100644 100644 aaa bbb with space.txt\n\
             2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs\n\
             u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.rs\n\
             ? untracked.txt\n",
        );
        assert_eq!(v.status.branch, "main");
        assert_eq!(v.status.ahead, 2);
        assert_eq!(v.status.behind, 1);
        assert_eq!(v.status.dirty, 5);
        assert_eq!(v.files.len(), 5);
        assert_eq!(v.files[0].status, ".M");
        assert_eq!(v.files[0].path, "src/lib.rs");
        assert_eq!(v.files[0].orig_path, None);
        assert_eq!(v.files[1].status, "MM");
        assert_eq!(v.files[1].path, "with space.txt");
        assert_eq!(v.files[2].status, "R.");
        assert_eq!(v.files[2].path, "new.rs");
        assert_eq!(v.files[2].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(v.files[3].status, "UU");
        assert_eq!(v.files[3].path, "conflict.rs");
        assert_eq!(v.files[4].status, "??");
        assert_eq!(v.files[4].path, "untracked.txt");
        assert_eq!(v.files[4].orig_path, None);
    }

    #[test]
    fn parse_view_of_clean_repo_is_empty() {
        let v = parse_view(
            "# branch.oid 2222222222222222222222222222222222222222\n\
             # branch.head feature/x\n",
        );
        assert_eq!(v.status.branch, "feature/x");
        assert!(v.files.is_empty());
    }

    #[test]
    fn capped_truncates_on_char_boundary_with_notice() {
        assert_eq!(capped(b"short"), "short");
        // 4-byte chars straddling the cap: truncation lands on a boundary.
        let s = "🦀".repeat(DIFF_CAP / 4 + 8);
        let out = capped(s.as_bytes());
        assert!(out.ends_with("\n[diff truncated]"));
        assert!(out.len() <= DIFF_CAP + "\n[diff truncated]".len());
    }

    #[test]
    fn status_of_rejects_non_repo_and_reads_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(status_of(path), None);
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let s = status_of(path).unwrap();
        assert_eq!(s.branch, "trunk");
        assert_eq!(s.dirty, 1);
    }

    #[test]
    fn view_of_and_diff_of_read_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(view_of(path), None);
        assert_eq!(diff_of(path, "f.txt", false), None);
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("tracked.txt"), "old line\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "seed"]);
        // Staged + unstaged edits on the tracked file, plus an untracked one.
        std::fs::write(dir.path().join("tracked.txt"), "staged line\n").unwrap();
        git(&["add", "tracked.txt"]);
        std::fs::write(
            dir.path().join("tracked.txt"),
            "staged line\nworktree line\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("new.txt"), "brand new\n").unwrap();

        let v = view_of(path).unwrap();
        assert_eq!(v.status.branch, "trunk");
        assert_eq!(v.status.dirty, 2);
        let tracked = v.files.iter().find(|f| f.path == "tracked.txt").unwrap();
        assert_eq!(tracked.status, "MM");
        let untracked = v.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(untracked.status, "??");

        // One diff vs HEAD covers staged AND unstaged edits together.
        let d = diff_of(path, "tracked.txt", false).unwrap();
        assert!(d.contains("-old line"), "diff was: {d}");
        assert!(d.contains("+staged line"), "diff was: {d}");
        assert!(d.contains("+worktree line"), "diff was: {d}");

        // Untracked renders all-added via --no-index /dev/null (exit code 1).
        let d = diff_of(path, "new.txt", true).unwrap();
        assert!(d.contains("+brand new"), "diff was: {d}");
        assert!(d.contains("/dev/null"), "diff was: {d}");

        // A clean/unknown path is an empty diff, not an error.
        assert_eq!(diff_of(path, "absent.txt", false).unwrap(), "");
    }

    #[test]
    fn diff_of_falls_back_on_unborn_head() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let ok = Command::new("git")
            .args(["-C", path, "init", "-b", "trunk"])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok);
        std::fs::write(dir.path().join("s.txt"), "staged\n").unwrap();
        let ok = Command::new("git")
            .args(["-C", path, "add", "s.txt"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        // No commits: `diff HEAD` fails, the --cached fallback still shows it.
        let d = diff_of(path, "s.txt", false).unwrap();
        assert!(d.contains("+staged"), "diff was: {d}");
    }

    /// A synthetic repo with a root commit (`a.txt` + `b.txt`) and a
    /// follow-on commit that modifies `a.txt` and renames `b.txt` ->
    /// `c.txt`. Returns `(tempdir, root_sha, second_sha)`.
    fn synthetic_history_repo() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("a.txt"), "line one\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b content\n").unwrap();
        git(&["add", "a.txt", "b.txt"]);
        git(&["commit", "-m", "root commit"]);
        let root_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        std::fs::write(dir.path().join("a.txt"), "line one\nline two\n").unwrap();
        std::fs::remove_file(dir.path().join("b.txt")).unwrap();
        std::fs::write(dir.path().join("c.txt"), "b content\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-m", "modify a, rename b to c"]);
        let second_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        (dir, root_sha, second_sha)
    }

    #[test]
    fn commit_log_of_lists_newest_first_and_is_capped() {
        let (dir, root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let log = commit_log_of(path);
        assert_eq!(log.len(), 2);
        // Newest first.
        assert_eq!(log[0].hash, second_sha);
        assert_eq!(log[0].subject, "modify a, rename b to c");
        assert_eq!(log[0].author, "t");
        assert!(!log[0].date.is_empty());
        assert!(second_sha.starts_with(&log[0].short_hash));
        assert_eq!(log[1].hash, root_sha);
        assert_eq!(log[1].subject, "root commit");
        assert!(log.len() <= LOG_CAP);
    }

    #[test]
    fn commit_log_of_empty_on_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(commit_log_of(dir.path().to_str().unwrap()), Vec::new());
    }

    #[test]
    fn commit_files_of_root_commit_returns_all_files_added() {
        let (dir, root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let mut files = commit_files_of(path, &root_sha).unwrap();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].orig_path, None);
        assert_eq!(files[1].status, "A");
        assert_eq!(files[1].path, "b.txt");
    }

    #[test]
    fn commit_files_of_rename_commit_reports_rename_with_orig_path() {
        let (dir, _root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let files = commit_files_of(path, &second_sha).unwrap();
        let modified = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(modified.status, "M");
        assert_eq!(modified.orig_path, None);
        let renamed = files.iter().find(|f| f.path == "c.txt").unwrap();
        assert!(
            renamed.status.starts_with('R'),
            "status: {}",
            renamed.status
        );
        assert_eq!(renamed.orig_path.as_deref(), Some("b.txt"));
    }

    #[test]
    fn commit_file_diff_of_root_commit_renders_fully_added() {
        let (dir, root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let d = commit_file_diff_of(path, &root_sha, "a.txt").unwrap();
        assert!(d.contains("+line one"), "diff was: {d}");
        assert!(
            d.contains("new file mode") || d.contains("+++ b/a.txt"),
            "diff was: {d}"
        );
    }

    #[test]
    fn commit_files_of_and_diff_of_reject_invalid_sha_before_spawning_git() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        for bad in ["; rm -rf /", "short", "not-hex-zzzz", "-flag"] {
            assert!(!is_valid_commit_id(bad), "should reject: {bad}");
            assert_eq!(commit_files_of(path, bad), None);
            assert_eq!(commit_file_diff_of(path, bad, "a.txt"), None);
        }
    }

    #[test]
    fn commit_files_of_unknown_but_well_shaped_sha_is_none() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let unknown = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        assert!(is_valid_commit_id(unknown));
        assert_eq!(commit_files_of(path, unknown), None);
    }

    #[test]
    fn is_valid_commit_id_accepts_only_plausible_hex_hashes() {
        assert!(is_valid_commit_id("1234567"));
        assert!(is_valid_commit_id(&"a".repeat(40)));
        assert!(is_valid_commit_id(&"f".repeat(64)));
        assert!(!is_valid_commit_id("123456")); // too short (6 chars)
        assert!(!is_valid_commit_id(&"a".repeat(65))); // too long
        assert!(!is_valid_commit_id("abcdefg")); // non-hex char
        assert!(!is_valid_commit_id("-rf"));
    }
}
