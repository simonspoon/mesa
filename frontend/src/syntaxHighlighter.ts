import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus'

// Registered once at module load, shared by every code-colouring surface
// (the Files content pane and markdown fenced code blocks — task 521).
// PrismLight (the sync "light" build) ships no language grammar unless
// registered and has no fallback-fetch for unregistered ones (unlike
// PrismAsyncLight, whose per-language dynamic imports pull Prism's entire
// ~290-language catalog into the build output), so the bundle only grows by
// the ~15 grammars registered here.
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('c', c)
SyntaxHighlighter.registerLanguage('cpp', cpp)
SyntaxHighlighter.registerLanguage('csharp', csharp)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('ruby', ruby)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('toml', toml)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('yaml', yaml)

export { SyntaxHighlighter, vscDarkPlus }

// A language token -> the registered Prism grammar name it should render with.
// Covers both the Files CONTENT endpoint's `language` values (server-side
// core::files::language_of) and the aliases people actually write after a
// markdown fence (```ts, ```sh, ```yml). Anything absent -> undefined, which
// each caller treats as "render as a plain, uncoloured literal block".
const PRISM_GRAMMAR: Record<string, string> = {
  rust: 'rust',
  rs: 'rust',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  python: 'python',
  py: 'python',
  json: 'json',
  // Only edit mode (task 658) ever reaches this entry for a .md FILE — the
  // Files pane renders a saved .md as formatted markdown, not as code — but a
  // ```markdown fence inside that prose resolves here too.
  markdown: 'markdown',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  shell: 'bash',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markup: 'markup',
  css: 'css',
  go: 'go',
  golang: 'go',
  ruby: 'ruby',
  rb: 'ruby',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  'c#': 'csharp',
  dotnet: 'csharp',
}

/** Resolve a free-form language token to a registered Prism grammar name, or
 * `undefined` when we carry no grammar for it (unknown or empty). */
export function prismGrammar(token: string | null | undefined): string | undefined {
  if (!token) return undefined
  return PRISM_GRAMMAR[token.toLowerCase()]
}

/** The source a highlight layer must render to stay line-for-line aligned with
 * a `<textarea>` holding `value` (task 658's editor overlay).
 *
 * A `<pre>` swallows exactly one trailing newline, so `"a\n"` — two lines in
 * the textarea, the caret sitting on the empty second one — would paint as a
 * single line and shear every subsequent scroll position. Padding one extra
 * newline restores the line count. Only the LAST newline is swallowed, so one
 * extra is always enough, however many blank lines trail. */
export function highlightOverlaySource(value: string): string {
  return value.endsWith('\n') ? `${value}\n` : value
}
