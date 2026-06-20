import ReactMarkdown from 'react-markdown'

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
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
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
