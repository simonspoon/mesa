//! Photographing the browser window a live conversation is being held in
//! (mesa task 895), with the external `loki` desktop-automation binary.
//!
//! The agent driving a live conversation is otherwise **blind**. It knows the
//! `route` the person is on and the `context` open on it, and neither of those
//! is what actually rendered — so "does this look right?" can only be answered
//! by asking the person to describe their own screen. `mesa live look` answers
//! it directly: it screenshots the window and prints a path the agent opens
//! with its image tool.
//!
//! The whole design problem is **which window**. Several headless browsers on
//! a developer's machine report a window titled `mesa`, so a title match would
//! photograph one of those. A window's position and size together are its
//! identity instead: the page reports its own
//! `screenX`/`screenY`/`outerWidth`/`outerHeight` on the poll it already makes
//! (`Store::set_live_route`), `loki` reports every window's frame in the same
//! screen coordinates, and the two match exactly. Only the browser that is
//! *joined to the conversation* ever reports a box, so a headless window can
//! never be the one that is looked at.
//!
//! Like every other shell-out in `core` (`git.rs`, `speech.rs`, `hooks.rs`),
//! loki is invoked as **argv** — never through a shell — and it is never a
//! hard requirement: a machine with no loki installed holds ordinary
//! conversations, one command short.
//!
//! There is deliberately **no `/api/live/look` route**. This captures the
//! person's screen, and `serve --lan` offers the API to every device on the
//! network with no auth at all; no gate in this codebase makes "photograph the
//! owner's desktop" an acceptable thing to expose over HTTP. It is a CLI
//! command, reachable only by something already running as the person.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;

use super::store::{Error, Result};
use super::types::LiveWindow;

/// How much of loki's stderr rides back in an error message. Enough to name
/// the real failure, bounded because it lands in a JSON error the agent reads
/// aloud-ish; the same instinct as every other bounded field in this codebase.
const STDERR_EXCERPT: usize = 400;

/// The desktop-automation binary to run. `MESA_LOKI_BIN` overrides it — the
/// same test seam as `agents::claude_bin` and `speech::kokoro_bin`, and how the
/// end-to-end checks drive this against a stub instead of a real screen.
fn loki_bin() -> String {
    std::env::var("MESA_LOKI_BIN").unwrap_or_else(|_| "loki".to_string())
}

/// One window as `loki -f json windows` reports it. Only the three fields mesa
/// uses are named; loki reports more (`pid`, `title`, `bundle_id`,
/// `is_on_screen`) and may grow others, so unknown keys are ignored rather
/// than making the parse brittle.
#[derive(Debug, Clone, Deserialize)]
struct LokiWindow {
    window_id: i64,
    frame: LokiFrame,
}

/// A window's frame in screen coordinates. Floats, because loki reports the
/// platform's own `CGRect`; mesa rounds before comparing (see [`matches`]).
#[derive(Debug, Clone, Copy, Deserialize)]
struct LokiFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// One screenshot: where it landed, and which window it is of. Small and
/// bounded, so it is the whole of what `mesa live look` prints.
///
/// **Not ts-exported**, unlike every other type on the live surface: this has
/// no HTTP route (see the module doc) and therefore no TypeScript consumer. A
/// generated `.ts` nothing imports is rot the `build.sh` dirty check would
/// then hold everyone to.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LiveShot {
    pub path: String,
    pub window_id: i64,
    pub width: i32,
    pub height: i32,
}

/// Screenshots the window at `window`, writing the PNG to `path`.
///
/// `Unavailable` — never `Validation` — when loki is missing, refuses, or has
/// no window at that box: none of those is a bad input, they are all "the
/// world is not currently arranged for this", which is what that code means.
pub fn shoot(window: &LiveWindow, path: &Path) -> Result<LiveShot> {
    // loki drives macOS's own window server. Saying so beats a confusing
    // "binary not found" on a machine where the tool could never have worked.
    if !cfg!(target_os = "macos") {
        return Err(Error::Unavailable(
            "`mesa live look` needs loki, which is a macOS tool; this machine is not a Mac".into(),
        ));
    }
    let windows = list_windows()?;
    let matched = match_window(&windows, window)?;
    screenshot(matched.window_id, path)?;
    Ok(LiveShot {
        path: path.to_string_lossy().into_owned(),
        window_id: matched.window_id,
        width: window.width,
        height: window.height,
    })
}

/// Every window loki can see.
fn list_windows() -> Result<Vec<LokiWindow>> {
    let out = run(&["-f", "json", "windows"])?;
    serde_json::from_slice(&out).map_err(|e| {
        Error::Unavailable(format!(
            "loki did not answer `windows` with JSON mesa understands: {e}"
        ))
    })
}

/// Takes the shot, then confirms it exists: loki can exit 0 having written
/// nothing (a window that vanished between the two calls), and a path the
/// agent then fails to open is a worse answer than saying so here.
fn screenshot(window_id: i64, path: &Path) -> Result<()> {
    run(&[
        "screenshot",
        "--window",
        &window_id.to_string(),
        "--output",
        &path.to_string_lossy(),
    ])?;
    if !path.is_file() {
        return Err(Error::Unavailable(format!(
            "loki reported success but wrote no file at {}",
            path.display()
        )));
    }
    Ok(())
}

/// One loki invocation, as argv — nothing here is ever a shell string, and no
/// value on this path comes from mesa's data anyway (a window id and a path
/// mesa itself chose).
///
/// A missing binary and a failing one are both `unavailable`: mesa depends on
/// loki without owning it, so neither is a domain outcome.
fn run(args: &[&str]) -> Result<Vec<u8>> {
    let bin = loki_bin();
    let out = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Unavailable(format!(
                    "`{bin}` is not installed; `mesa live look` needs the loki \
                     desktop-automation tool to photograph a window"
                ))
            } else {
                Error::Unavailable(format!("could not run `{bin}`: {e}"))
            }
        })?;
    if !out.status.success() {
        return Err(Error::Unavailable(format!(
            "loki failed ({}): {}",
            out.status,
            excerpt(&out.stderr)
        )));
    }
    Ok(out.stdout)
}

/// A trimmed, bounded piece of what loki said on stderr, for an error message.
fn excerpt(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    match text.char_indices().nth(STDERR_EXCERPT) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None if text.is_empty() => "(no output)".to_string(),
        None => text.to_string(),
    }
}

/// Which of these windows is the one the page reported — the whole decision,
/// kept pure so it is unit-testable without a screen (the `parse_status`
/// precedent in `git.rs`).
///
/// The match is **exact on all four numbers**, rounded to whole pixels because
/// the page reports integers and the window server reports a float rect. It is
/// deliberately not a nearest-match: a wrong window here photographs something
/// the person did not ask to be seen, so "I am not sure" must be an error and
/// not a guess. That is also why two candidates are a `conflict` naming both
/// rather than a coin toss — two browser windows genuinely stacked at the same
/// box is a thing the person can fix, once they know.
fn match_window<'a>(windows: &'a [LokiWindow], want: &LiveWindow) -> Result<&'a LokiWindow> {
    let hits: Vec<&LokiWindow> = windows.iter().filter(|w| matches(w, want)).collect();
    match hits.as_slice() {
        [one] => Ok(one),
        // Nothing at that box: the browser that reported it has been closed or
        // moved since. Unavailable rather than not_found — the conversation is
        // fine, this moment is not.
        [] => Err(Error::Unavailable(format!(
            "no window at the box the conversation's browser reported \
             ({}×{} at {},{}); it has moved or been closed since — ask the \
             person to bring it back and try again",
            want.width, want.height, want.x, want.y
        ))),
        many => Err(Error::Conflict(format!(
            "{} windows share the box the conversation's browser reported \
             ({}×{} at {},{}): window ids {}",
            many.len(),
            want.width,
            want.height,
            want.x,
            want.y,
            many.iter()
                .map(|w| w.window_id.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Whether one loki window sits exactly where the page said it does.
fn matches(window: &LokiWindow, want: &LiveWindow) -> bool {
    let f = window.frame;
    f.x.round() as i64 == want.x as i64
        && f.y.round() as i64 == want.y as i64
        && f.width.round() as i64 == want.width as i64
        && f.height.round() as i64 == want.height as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: i64, x: f64, y: f64, width: f64, height: f64) -> LokiWindow {
        LokiWindow {
            window_id: id,
            frame: LokiFrame {
                x,
                y,
                width,
                height,
            },
        }
    }

    fn want() -> LiveWindow {
        LiveWindow {
            x: 22,
            y: 22,
            width: 1600,
            height: 1000,
        }
    }

    /// The real case, and the one that matters most: a headless browser
    /// **titled `mesa`** is sitting right beside the person's window, and is
    /// told apart from it by size alone. Matching on a title would have
    /// photographed the wrong one.
    #[test]
    fn the_reported_box_picks_the_persons_window_not_a_lookalike() {
        let windows = [
            window(40484, 22.0, 22.0, 1920.0, 1080.0),
            window(40041, 22.0, 22.0, 1600.0, 1000.0),
            window(38878, 0.0, 0.0, 1728.0, 38.0),
        ];
        assert_eq!(match_window(&windows, &want()).unwrap().window_id, 40041);
    }

    /// The window server reports a float rect; the page reports integers.
    /// Rounding is what makes those the same statement.
    #[test]
    fn a_fractional_frame_still_matches_the_rounded_box() {
        let windows = [window(7, 21.6, 22.4, 1599.8, 1000.2)];
        assert_eq!(match_window(&windows, &want()).unwrap().window_id, 7);
    }

    /// Nobody is at that box any more: the browser moved or closed after it
    /// reported. Unavailable — try again — rather than a nearest guess.
    #[test]
    fn no_window_at_the_reported_box_is_unavailable() {
        let windows = [window(40484, 22.0, 22.0, 1920.0, 1080.0)];
        let err = match_window(&windows, &want()).unwrap_err();
        assert!(matches!(err, Error::Unavailable(_)), "{err:?}");
    }

    /// Two windows genuinely stacked at one box is ambiguous, and ambiguity
    /// here means photographing the wrong screen — so it is a `conflict` that
    /// names both ids rather than a coin toss.
    #[test]
    fn two_windows_at_one_box_is_a_conflict_naming_both() {
        let windows = [
            window(11, 22.0, 22.0, 1600.0, 1000.0),
            window(12, 22.0, 22.0, 1600.0, 1000.0),
        ];
        let err = match_window(&windows, &want()).unwrap_err();
        let Error::Conflict(message) = err else {
            panic!("{err:?}");
        };
        assert!(
            message.contains("11") && message.contains("12"),
            "{message}"
        );
    }

    /// The shape mesa actually parses is loki's own, extra keys and all.
    #[test]
    fn lokis_windows_json_parses_with_fields_mesa_ignores() {
        let json = r#"[{"window_id":40041,"pid":34872,"title":"mesa",
            "bundle_id":"com.google.Chrome",
            "frame":{"x":22.0,"y":22.0,"width":1600.0,"height":1000.0},
            "is_on_screen":false}]"#;
        let windows: Vec<LokiWindow> = serde_json::from_str(json).unwrap();
        assert_eq!(match_window(&windows, &want()).unwrap().window_id, 40041);
    }
}
