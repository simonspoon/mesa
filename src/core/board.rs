//! Rendering a mesa diagram as a **snapshot** SVG, for the live conversation's
//! whiteboard (mesa task 1071).
//!
//! `mesa live board push --diagram <id>` reads a diagram's frames and edges
//! once and renders this static picture, which is then what the board holds
//! for the rest of the conversation. That is what "snapshot" means here: the
//! canvas may be moved, relabelled or deleted afterwards and the board the
//! person was shown does not change under them.
//!
//! It is deliberately plain — rectangles with their titles, straight lines
//! between frame centres — and does not try to match the React canvas pixel
//! for pixel. The canvas knows about shapes, markers, waypoints and
//! Sugiyama-routed connectors (`docs/diagrams.md`); this is the picture a
//! person glances at while someone talks them through it.
//!
//! Every piece of text that reaches the output goes through [`escape`] first:
//! a frame title is free text an untrusted source may have written, and the
//! result is served as `image/svg+xml`, which is markup.

use super::types::{DiagramView, LiveBoard, LiveBoardKind};

/// The file extension a board's bytes should carry — what the render route
/// names its `Content-Disposition` and what `mesa live board keep` defaults an
/// artifact's or an attachment's filename to, so the two can never disagree.
///
/// Three of the four kinds answer from the kind alone; an `image` answers from
/// the content type it recorded at push time, mapped back through the same allowlist
/// `files::image_mime` reads forward (`png` for anything unrecognised, which a
/// row `Store` accepted cannot be).
pub fn extension_for(kind: LiveBoardKind, content_type: Option<&str>) -> &'static str {
    match kind {
        LiveBoardKind::Markdown => "md",
        LiveBoardKind::Html => "html",
        LiveBoardKind::Diagram => "svg",
        LiveBoardKind::Image => match content_type.unwrap_or_default() {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/x-icon" => "ico",
            "image/svg+xml" => "svg",
            _ => "png",
        },
    }
}

/// What one board is called when it leaves the conversation — the filename
/// the render route puts in its `Content-Disposition`, and the default name
/// `mesa live board keep` gives the artifact or attachment it writes. One
/// function, so the two can never answer differently.
///
/// The caption when there is one, else `board-<id>`, plus the extension its
/// kind implies — and never twice, so a title someone already wrote as
/// `plan.md` stays `plan.md`.
pub fn filename(board: &LiveBoard) -> String {
    let stem = board
        .title
        .clone()
        .unwrap_or_else(|| format!("board-{}", board.id));
    let ext = extension_for(board.kind, board.content_type.as_deref());
    if stem.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}

/// Padding around the content's bounding box, in canvas units.
const PAD: f64 = 24.0;

/// Renders one diagram as a static SVG document.
///
/// The `viewBox` is the content's own bounding box plus [`PAD`], so a diagram
/// laid out anywhere in the canvas' coordinate space fills the picture; an
/// empty diagram still renders (a titled, empty sheet) rather than answering
/// with nothing a person could look at.
pub fn diagram_svg(view: &DiagramView) -> String {
    let (min_x, min_y, max_x, max_y) = bounds(view);
    let width = (max_x - min_x + PAD * 2.0).max(1.0);
    let height = (max_y - min_y + PAD * 2.0).max(1.0);
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{:.0} {:.0} {:.0} {:.0}\" \
         width=\"{:.0}\" height=\"{:.0}\">\n\
         <title>{}</title>\n\
         <rect x=\"{:.0}\" y=\"{:.0}\" width=\"{:.0}\" height=\"{:.0}\" fill=\"#0b0f14\"/>\n",
        min_x - PAD,
        min_y - PAD,
        width,
        height,
        width,
        height,
        escape(&view.diagram.title),
        min_x - PAD,
        min_y - PAD,
        width,
        height,
    );
    // Edges first, so a connector runs behind the cards it joins rather than
    // across their titles.
    for edge in &view.edges {
        let Some(from) = view.frames.iter().find(|f| f.id == edge.from_frame) else {
            continue;
        };
        let Some(to) = view.frames.iter().find(|f| f.id == edge.to_frame) else {
            continue;
        };
        let (x1, y1) = (from.x + from.w / 2.0, from.y + from.h / 2.0);
        let (x2, y2) = (to.x + to.w / 2.0, to.y + to.h / 2.0);
        out.push_str(&format!(
            "<line x1=\"{x1:.0}\" y1=\"{y1:.0}\" x2=\"{x2:.0}\" y2=\"{y2:.0}\" \
             stroke=\"#5b6b7f\" stroke-width=\"2\"/>\n"
        ));
        if let Some(label) = &edge.label {
            out.push_str(&format!(
                "<text x=\"{:.0}\" y=\"{:.0}\" fill=\"#9fb0c3\" font-family=\"sans-serif\" \
                 font-size=\"12\" text-anchor=\"middle\">{}</text>\n",
                (x1 + x2) / 2.0,
                (y1 + y2) / 2.0 - 4.0,
                escape(label),
            ));
        }
    }
    for frame in &view.frames {
        // A frame's own colour is a CSS colour string the canvas honours; it
        // is free text, so it is escaped like everything else here.
        let stroke = frame.color.as_deref().unwrap_or("#00e5ff");
        out.push_str(&format!(
            "<rect x=\"{:.0}\" y=\"{:.0}\" width=\"{:.0}\" height=\"{:.0}\" rx=\"8\" \
             fill=\"#131a22\" stroke=\"{}\" stroke-width=\"2\"/>\n\
             <text x=\"{:.0}\" y=\"{:.0}\" fill=\"#e6edf3\" font-family=\"sans-serif\" \
             font-size=\"14\">{}</text>\n",
            frame.x,
            frame.y,
            frame.w.max(1.0),
            frame.h.max(1.0),
            escape(stroke),
            frame.x + 10.0,
            frame.y + 24.0,
            escape(&frame.title),
        ));
    }
    out.push_str("</svg>\n");
    out
}

/// The content's bounding box, or a modest empty sheet when there are no
/// frames to bound.
fn bounds(view: &DiagramView) -> (f64, f64, f64, f64) {
    if view.frames.is_empty() {
        return (0.0, 0.0, 320.0, 180.0);
    }
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for frame in &view.frames {
        min_x = min_x.min(frame.x);
        min_y = min_y.min(frame.y);
        max_x = max_x.max(frame.x + frame.w);
        max_y = max_y.max(frame.y + frame.h);
    }
    (min_x, min_y, max_x, max_y)
}

/// XML-escapes one piece of text on its way into the picture. Titles, labels
/// and colour hints are free text from an untrusted source (CLAUDE.md), and
/// the output is markup a browser parses, so this is the one place that
/// decides they are data.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{Diagram, DiagramType, Frame, FrameEdge, LiveBoard};

    fn diagram() -> Diagram {
        Diagram {
            id: 1,
            project_id: 1,
            title: "Flow & <plan>".into(),
            description: None,
            author: None,
            diagram_type: DiagramType::Flowchart,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        }
    }

    fn frame(id: i64, title: &str, x: f64, y: f64) -> Frame {
        Frame {
            id,
            diagram_id: 1,
            title: title.into(),
            body: None,
            x,
            y,
            w: 160.0,
            h: 80.0,
            color: None,
            task_id: None,
            author: None,
            shape: None,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        }
    }

    fn edge(from: i64, to: i64, label: Option<&str>) -> FrameEdge {
        FrameEdge {
            id: 1,
            diagram_id: 1,
            from_frame: from,
            to_frame: to,
            label: label.map(str::to_string),
            author: None,
            created_at: "2026-01-01 00:00:00".into(),
            waypoints: vec![],
            from_anchor: None,
            to_anchor: None,
            style: None,
            from_marker: None,
            to_marker: None,
        }
    }

    fn board(kind: LiveBoardKind, title: Option<&str>, content_type: Option<&str>) -> LiveBoard {
        LiveBoard {
            id: 4,
            session_id: 1,
            kind,
            title: title.map(str::to_string),
            body: "x".into(),
            content_type: content_type.map(str::to_string),
            created_at: "2026-01-01 00:00:00".into(),
        }
    }

    /// The extension is **always** the one the kind (or an image's recorded
    /// `content_type`) implies — never one read off the caption, which is free
    /// text a caller writes. The only thing the title decides is the stem, and
    /// the one skip is a title that already ends in the very extension that
    /// would have been appended.
    #[test]
    fn filename_takes_its_extension_from_the_kind_never_from_the_title() {
        use LiveBoardKind::*;
        assert_eq!(
            filename(&board(Markdown, Some("The plan"), None)),
            "The plan.md"
        );
        assert_eq!(filename(&board(Markdown, Some("plan.md"), None)), "plan.md");
        assert_eq!(filename(&board(Html, None, None)), "board-4.html");
        assert_eq!(
            filename(&board(Diagram, Some("The flow"), None)),
            "The flow.svg"
        );
        assert_eq!(
            filename(&board(Image, Some("shot"), Some("image/webp"))),
            "shot.webp"
        );
        // A caption claiming another format does not get to name the file: the
        // recorded content type is what the bytes are.
        assert_eq!(
            filename(&board(Image, Some("shot.jpg"), Some("image/png"))),
            "shot.jpg.png"
        );
        // An image with no recorded type cannot happen (`Store` refuses one),
        // and if it somehow did the fallback is still a derived extension.
        assert_eq!(filename(&board(Image, None, None)), "board-4.png");
    }

    #[test]
    fn renders_frames_and_edges_inside_a_content_sized_viewbox() {
        let view = DiagramView {
            diagram: diagram(),
            frames: vec![
                frame(1, "Start", 100.0, 100.0),
                frame(2, "End", 400.0, 300.0),
            ],
            edges: vec![edge(1, 2, Some("then"))],
        };
        let svg = diagram_svg(&view);
        assert!(
            svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""),
            "{svg}"
        );
        assert!(svg.ends_with("</svg>\n"), "{svg}");
        // The box is the content plus PAD on every side, not the origin.
        assert!(svg.contains("viewBox=\"76 76 508 328\""), "{svg}");
        assert!(svg.contains(">Start</text>"), "{svg}");
        assert!(svg.contains(">End</text>"), "{svg}");
        // Centre to centre: (180,140) -> (480,340).
        assert!(
            svg.contains("<line x1=\"180\" y1=\"140\" x2=\"480\" y2=\"340\""),
            "{svg}"
        );
        assert!(svg.contains(">then</text>"), "{svg}");
    }

    /// Every string that reaches the picture is data: the output is markup a
    /// browser parses, and a frame title may come from an untrusted source.
    #[test]
    fn escapes_every_piece_of_text_it_writes() {
        let mut hostile = frame(1, "<script>alert('x')</script>", 0.0, 0.0);
        hostile.color = Some("\"/><script>alert(1)</script>".into());
        let view = DiagramView {
            diagram: diagram(),
            frames: vec![hostile],
            edges: vec![],
        };
        let svg = diagram_svg(&view);
        assert!(!svg.contains("<script>"), "{svg}");
        assert!(
            svg.contains("&lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;"),
            "{svg}"
        );
        // The diagram's own title too.
        assert!(
            svg.contains("<title>Flow &amp; &lt;plan&gt;</title>"),
            "{svg}"
        );
    }

    /// An edge whose endpoint is missing (a frame deleted between the two
    /// reads) is skipped rather than panicking or drawing a line to nowhere.
    #[test]
    fn skips_an_edge_whose_frame_is_gone_and_still_renders_an_empty_diagram() {
        let view = DiagramView {
            diagram: diagram(),
            frames: vec![frame(1, "Alone", 0.0, 0.0)],
            edges: vec![edge(1, 99, None)],
        };
        let svg = diagram_svg(&view);
        assert!(!svg.contains("<line"), "{svg}");

        let empty = DiagramView {
            diagram: diagram(),
            frames: vec![],
            edges: vec![],
        };
        let svg = diagram_svg(&empty);
        assert!(svg.contains("<svg"), "{svg}");
        assert!(svg.contains("viewBox=\"-24 -24 368 228\""), "{svg}");
    }
}
