import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import {
  SyntaxHighlighter,
  vscDarkPlus,
  prismGrammar,
} from '../syntaxHighlighter'

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
 *
 * Fenced code blocks render as literal blocks colour-coded by language
 * (task 521). The `pre` override reads the single `<code>` child react-markdown
 * nests inside every block, pulls its ```` ```lang ```` tag from the
 * `language-*` class, and — when we carry a Prism grammar for it (see
 * `prismGrammar`) — hands the verbatim text to `SyntaxHighlighter`. This stays
 * inside the no-raw-HTML guarantee: the highlighter tokenises the string into
 * inert `<span>`s, it never interprets the content as markup. Unknown/no
 * language falls back to a plain `<pre>` — still a literal block, just
 * uncoloured. Inline code (no enclosing `pre`) is untouched and keeps the
 * default `<code>` chip.
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
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

/**
 * Renders one fenced code block. react-markdown always wraps a block in
 * `<pre><code class="language-xxx">…</code></pre>`, so `children` here is that
 * lone `<code>` element — we read its class + text rather than re-parsing.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = children as ReactElement<ComponentPropsWithoutRef<'code'>>
  const className = code?.props?.className ?? ''
  const grammar = prismGrammar(/language-([\w-]+)/.exec(className)?.[1])
  const source = String(code?.props?.children ?? '').replace(/\n$/, '')

  // No grammar (unknown or bare fence): a plain literal block. Keep the inner
  // `<code>` so it still picks up `.markdown-body`'s monospace rule.
  if (!grammar)
    return (
      <pre>
        <code className={className}>{source}</code>
      </pre>
    )
  return (
    <SyntaxHighlighter
      language={grammar}
      style={vscDarkPlus}
      customStyle={{ margin: '0.5rem 0', borderRadius: '4px' }}
    >
      {source}
    </SyntaxHighlighter>
  )
}
