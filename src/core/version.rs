//! The version of the *app* a project's `local_path` holds, read out of its
//! package manifest. Like `core::git`, this reads EXTERNAL state only and
//! nothing here touches the mesa store: it is decoration for the project
//! page's header, so any failure (no folder, no manifest, an unparseable one)
//! is `None`, never an error surfaced to the client.
//!
//! Deliberately no `toml` crate: only three keys in two file formats are
//! wanted, so the two TOML cases are hand-parsed the way `git::parse_status`
//! hand-parses porcelain — section header tracked line by line, first match
//! inside the wanted table wins. The parsers stay pure (text in,
//! `Option<String>` out) so the contract is unit-testable without a
//! filesystem.

use std::path::Path;

/// Per-file read cap: a manifest is a few KiB, so anything past this is not
/// one and must not be slurped into memory (`git::DIFF_CAP` precedent).
const FILE_CAP: u64 = 256 * 1024;

/// One manifest mesa knows how to read: its filename and the pure parser for
/// it. The read order below is the precedence order.
type Manifest = (&'static str, fn(&str) -> Option<String>);

/// The version of the app in `dir`, as `(version, source filename)`.
///
/// Checks the manifests in a fixed order — `Cargo.toml`, `package.json`,
/// `pyproject.toml` — at the **top level of `dir` only**: no recursion, no
/// workspace/monorepo scanning, and the only path input is the project's own
/// `local_path`. A file that exists but yields no usable version falls
/// through to the next one.
pub fn version_of(dir: &str) -> Option<(String, String)> {
    let candidates: [Manifest; 3] = [
        ("Cargo.toml", parse_cargo_toml),
        ("package.json", parse_package_json),
        ("pyproject.toml", parse_pyproject_toml),
    ];
    for (name, parse) in candidates {
        let Some(text) = read_capped(&Path::new(dir).join(name)) else {
            continue;
        };
        if let Some(v) = parse(&text).filter(|v| !v.is_empty()) {
            return Some((v, name.to_string()));
        }
    }
    None
}

/// Reads a file, or `None` when it is absent, unreadable, not UTF-8, or
/// larger than `FILE_CAP` (checked before the read, so an oversized file is
/// skipped rather than loaded).
fn read_capped(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > FILE_CAP {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// `version` in Cargo.toml's `[package]` table.
fn parse_cargo_toml(text: &str) -> Option<String> {
    toml_version_in(text, &["package"])
}

/// `version` in pyproject.toml's `[project]` table, else `[tool.poetry]`.
fn parse_pyproject_toml(text: &str) -> Option<String> {
    toml_version_in(text, &["project"]).or_else(|| toml_version_in(text, &["tool.poetry"]))
}

/// The first `version = "…"` inside one of `sections`, tracking the current
/// `[header]` line by line. A `version` under any other table (a dependency's
/// pin, say) must not match — which is the whole reason this is
/// section-aware rather than a grep.
fn toml_version_in(text: &str, sections: &[&str]) -> Option<String> {
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('[') {
            // Only plain `[table]` headers matter here; `[[array]]` headers
            // (which start with a second '[') are never a wanted section.
            current = rest
                .split_once(']')
                .map(|(name, _)| name.trim().to_string());
            continue;
        }
        if current.as_deref().is_none_or(|c| !sections.contains(&c)) {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "version" {
            continue;
        }
        if let Some(v) = toml_string_value(value) {
            return Some(v);
        }
    }
    None
}

/// The contents of a TOML basic/literal string value, ignoring a trailing
/// `# comment`. Anything else (a table, an array, a bare word) is `None`.
fn toml_string_value(value: &str) -> Option<String> {
    let value = value.trim();
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let rest = &value[quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some(rest[..end].trim().to_string())
}

/// The top-level `"version"` string of a package.json. Real JSON parsing —
/// `serde_json` is already a dependency, so there is no reason to hand-roll
/// this one the way the TOML cases are hand-rolled.
fn parse_package_json(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(v.get("version")?.as_str()?.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_package_version() {
        let text = "[package]\nname = \"mesa\"\nversion = \"0.9.0\"\nedition = \"2024\"\n";
        assert_eq!(parse_cargo_toml(text), Some("0.9.0".to_string()));
    }

    #[test]
    fn cargo_version_in_another_table_does_not_match() {
        let text = "[dependencies.foo]\nversion = \"1.2.3\"\n\n[package]\nname = \"x\"\n";
        assert_eq!(parse_cargo_toml(text), None);
    }

    #[test]
    fn cargo_version_before_any_header_does_not_match() {
        assert_eq!(parse_cargo_toml("version = \"9.9.9\"\n[package]\n"), None);
    }

    #[test]
    fn cargo_version_tolerates_comment_and_single_quotes() {
        let text = "[package]\nversion = '1.0.1' # the shipped one\n";
        assert_eq!(parse_cargo_toml(text), Some("1.0.1".to_string()));
    }

    #[test]
    fn cargo_stops_at_the_next_header() {
        let text = "[package]\nname = \"x\"\n[dependencies]\nversion = \"7.7.7\"\n";
        assert_eq!(parse_cargo_toml(text), None);
    }

    #[test]
    fn package_json_version() {
        let text = r#"{"name": "frontend", "version": "2.3.4"}"#;
        assert_eq!(parse_package_json(text), Some("2.3.4".to_string()));
    }

    #[test]
    fn package_json_without_version() {
        assert_eq!(parse_package_json(r#"{"name": "frontend"}"#), None);
    }

    #[test]
    fn package_json_malformed() {
        assert_eq!(parse_package_json("{not json"), None);
    }

    #[test]
    fn pyproject_project_table() {
        let text =
            "[build-system]\nrequires = []\n\n[project]\nname = \"p\"\nversion = \"0.4.2\"\n";
        assert_eq!(parse_pyproject_toml(text), Some("0.4.2".to_string()));
    }

    #[test]
    fn pyproject_falls_back_to_tool_poetry() {
        let text = "[project]\nname = \"p\"\n\n[tool.poetry]\nversion = \"1.9.0\"\n";
        assert_eq!(parse_pyproject_toml(text), Some("1.9.0".to_string()));
    }

    #[test]
    fn pyproject_without_any_version() {
        assert_eq!(parse_pyproject_toml("[project]\nname = \"p\"\n"), None);
    }

    #[test]
    fn cargo_toml_wins_over_package_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nversion = \"0.9.0\"\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"version": "1.0.0"}"#).unwrap();
        let got = version_of(dir.path().to_str().unwrap());
        assert_eq!(got, Some(("0.9.0".to_string(), "Cargo.toml".to_string())));
    }

    #[test]
    fn unusable_manifest_falls_through_to_the_next() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"version": "1.0.0"}"#).unwrap();
        let got = version_of(dir.path().to_str().unwrap());
        assert_eq!(got, Some(("1.0.0".to_string(), "package.json".to_string())));
    }

    #[test]
    fn no_manifest_is_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "hi").unwrap();
        assert_eq!(version_of(dir.path().to_str().unwrap()), None);
    }

    #[test]
    fn missing_dir_is_none() {
        assert_eq!(version_of("/nonexistent/mesa-version-test"), None);
    }

    #[test]
    fn oversized_manifest_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = String::from("[package]\nversion = \"0.9.0\"\n");
        body.push_str(&"# pad\n".repeat(60_000));
        assert!(body.len() as u64 > FILE_CAP);
        std::fs::write(dir.path().join("Cargo.toml"), body).unwrap();
        assert_eq!(version_of(dir.path().to_str().unwrap()), None);
    }
}
