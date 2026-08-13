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
 * must not run together — see `EntityNode` in `DiagramCanvas.tsx`. Like
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
 *
 * `resolveImageSrc` lets a caller rewrite `![alt](src)` sources (task 801).
 * It receives the source text verbatim and returns the URL to actually load,
 * or `null` for "render no image at all" — in which case the alt text renders
 * as inert muted text rather than a broken-image icon. Only the Files tab
 * passes it, to turn a relative path in a repo file into that repo's raw-file
 * route; every other caller omits it and keeps react-markdown's default
 * `<img>` (an absolute `http(s)` src renders exactly as it does today).
 * react-markdown's URL sanitisation runs before this hook either way, so an
 * unsafe scheme never reaches the resolver.
 */
export function Markdown({
  text,
  breaks,
  resolveImageSrc,
}: {
  text: string
  breaks?: boolean
  resolveImageSrc?: (src: string) => string | null
}) {
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
        // Added only when a caller passes a resolver, so every existing caller
        // keeps react-markdown's own `img` element byte for byte.
        ...(resolveImageSrc
          ? {
              img: ({ src, alt, title }: ComponentPropsWithoutRef<'img'>) => {
                const resolved =
                  typeof src === 'string' ? resolveImageSrc(src) : null
                if (resolved === null)
                  return <span className="markdown-img-missing">{alt ?? ''}</span>
                return <img src={resolved} alt={alt ?? ''} title={title} />
              },
            }
          : {}),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

/**
 * Reset class for the `<code>` react-markdown nests inside every fenced block
 * (task 659). The global `code {}` chip style (background/border/padding, meant
 * for short inline snippets) otherwise applies to it too — and because that
 * `<code>` is inline yet spans many lines, the browser paints the chip's
 * border/background around EVERY line box, so a block renders as a stack of
 * boxed lines. Same trap, same cure as `.files-content-text` in the whole-file
 * view; here it is applied to both code-block paths below. Inline code (no
 * enclosing `pre`) never gets the class and keeps its chip.
 */
const CODE_TAG_CLASS = 'markdown-code-block'

/**
 * The slab both fenced-block paths paint (task 812). vscDarkPlus carries VS
 * Code's own `#1e1e1e` warm grey on its `<pre>`, which reads as a foreign
 * panel dropped into mesa's near-black/cyan theme — and it arrives as an
 * INLINE style, so only `customStyle` can displace it (no class rule, at any
 * specificity, wins against it). The whole-file viewer and the editor overlay
 * already sidestep it by rendering on `background: transparent`; a markdown
 * block is a slab inside prose, so it takes the theme's own raised-panel
 * tokens instead — the same background/border pair as `.files-frontmatter`
 * and every other inset panel. Token colours are untouched: they stay
 * identical to the ones the Files viewer paints for the same language.
 *
 * The plain (no-grammar) path takes the same object rather than a CSS twin,
 * so an unknown fence and a highlighted one are the same block — before this
 * they disagreed twice over, one grey slab and one with no slab at all.
 */
const CODE_SLAB = {
  margin: '0.5rem 0',
  padding: '0.6rem 0.8rem',
  background: 'var(--panel-raised)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
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
      <pre style={CODE_SLAB}>
        <code className={`${CODE_TAG_CLASS} ${className}`.trim()}>{source}</code>
      </pre>
    )
  return (
    <SyntaxHighlighter
      language={grammar}
      style={vscDarkPlus}
      customStyle={CODE_SLAB}
      codeTagProps={{ className: CODE_TAG_CLASS }}
    >
      {source}
    </SyntaxHighlighter>
  )
}
