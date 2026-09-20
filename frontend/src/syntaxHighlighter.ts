import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import dart from 'react-syntax-highlighter/dist/esm/languages/prism/dart'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import elixir from 'react-syntax-highlighter/dist/esm/languages/prism/elixir'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql'
import groovy from 'react-syntax-highlighter/dist/esm/languages/prism/groovy'
import haskell from 'react-syntax-highlighter/dist/esm/languages/prism/haskell'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import kusto from 'react-syntax-highlighter/dist/esm/languages/prism/kusto'
import less from 'react-syntax-highlighter/dist/esm/languages/prism/less'
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua'
import makefile from 'react-syntax-highlighter/dist/esm/languages/prism/makefile'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import objectivec from 'react-syntax-highlighter/dist/esm/languages/prism/objectivec'
import perl from 'react-syntax-highlighter/dist/esm/languages/prism/perl'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import protobuf from 'react-syntax-highlighter/dist/esm/languages/prism/protobuf'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
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
// the grammars registered here — 42 of them since mesa task 1236, whose 22
// additions cost ~41 KB minified (~13 KB gzipped).
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('c', c)
SyntaxHighlighter.registerLanguage('cpp', cpp)
SyntaxHighlighter.registerLanguage('csharp', csharp)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('dart', dart)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('docker', docker)
SyntaxHighlighter.registerLanguage('elixir', elixir)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('graphql', graphql)
SyntaxHighlighter.registerLanguage('groovy', groovy)
SyntaxHighlighter.registerLanguage('haskell', haskell)
SyntaxHighlighter.registerLanguage('ini', ini)
SyntaxHighlighter.registerLanguage('java', java)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('kotlin', kotlin)
SyntaxHighlighter.registerLanguage('kusto', kusto)
SyntaxHighlighter.registerLanguage('less', less)
SyntaxHighlighter.registerLanguage('lua', lua)
SyntaxHighlighter.registerLanguage('makefile', makefile)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('objectivec', objectivec)
SyntaxHighlighter.registerLanguage('perl', perl)
SyntaxHighlighter.registerLanguage('php', php)
SyntaxHighlighter.registerLanguage('powershell', powershell)
SyntaxHighlighter.registerLanguage('protobuf', protobuf)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('r', r)
SyntaxHighlighter.registerLanguage('ruby', ruby)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('scala', scala)
SyntaxHighlighter.registerLanguage('scss', scss)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('swift', swift)
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
  sql: 'sql',
  // The server tags Kusto "kql" (the extension people write), but Prism's
  // grammar is registered under its own name — this pair is the bridge.
  kql: 'kusto',
  kusto: 'kusto',
  csl: 'kusto',
  scss: 'scss',
  less: 'less',
  swift: 'swift',
  kotlin: 'kotlin',
  kt: 'kotlin',
  java: 'java',
  objectivec: 'objectivec',
  objc: 'objectivec',
  php: 'php',
  dart: 'dart',
  scala: 'scala',
  lua: 'lua',
  perl: 'perl',
  // Prism's grammar for the R language is registered under its one-letter
  // name, which is also the only token a fence or the server ever carries.
  r: 'r',
  haskell: 'haskell',
  hs: 'haskell',
  elixir: 'elixir',
  docker: 'docker',
  dockerfile: 'docker',
  makefile: 'makefile',
  make: 'makefile',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  env: 'ini',
  dotenv: 'ini',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  protobuf: 'protobuf',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  groovy: 'groovy',
  gradle: 'groovy',
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
