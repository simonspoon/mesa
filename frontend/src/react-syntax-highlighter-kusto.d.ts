// @types/react-syntax-highlighter declares one module per Prism grammar, but
// its list is missing `kusto` — the grammar `kql`/`csl` files highlight with
// (see syntaxHighlighter.ts) — while every other grammar registered there is
// covered. This is that one missing declaration; delete it if upstream adds
// kusto. The @types package types each grammar's default export as `any`;
// `unknown` is the same opaque value under this project's no-`any` lint rule,
// and `registerLanguage` is the only thing it is ever passed to.
declare module 'react-syntax-highlighter/dist/esm/languages/prism/kusto' {
  const language: unknown
  export default language
}
