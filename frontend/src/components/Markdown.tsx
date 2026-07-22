import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * Renders frame card text as markdown, treating the source strictly as DATA.
 *
 * Safety: react-markdown does NOT pass raw HTML through — there is no
 * `rehype-raw` plugin here, so any embedded HTML (e.g. `<script>` or
 * `<img onerror=…>`) is rendered as inert text, never as live DOM. We do not
 * enable `allowDangerousHtml`/`dangerouslySetInnerHTML` anywhere. Card
 * titles/descriptions may be untrusted, so this is the only path that turns
 * their text into formatted output.
 *
 * Links open in a new tab with `rel="noreferrer"` so a card cannot leak the
 * referrer or hijack the opener. URL protocols are sanitised by react-markdown's
 * default URL transform (javascript: and other unsafe schemes are stripped).
 *
 * `remark-gfm` adds the GitHub-flavoured extensions core CommonMark lacks —
 * tables, strikethrough, task lists, autolinks (task 432). It is a source-text
 * parser extension only: it emits ordinary mdast nodes, so the no-raw-HTML
 * guarantee above is unaffected.
 *
 * `breaks` opts into `remark-breaks`, which turns a single newline into a hard
 * line break instead of CommonMark's soft break (collapsed to a space). Used by
 * ERD entity cards (task 492), whose bodies are line-per-attribute lists that
 * must not run together — see `EntityNode` in `StoryboardCanvas.tsx`. Like
 * `remark-gfm` it is a source-text parser extension emitting ordinary mdast
 * nodes, so the no-raw-HTML guarantee is unaffected.
 */
export function Markdown({ text, breaks }: { text: string; breaks?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
