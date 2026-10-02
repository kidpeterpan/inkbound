// Bundled font assets are inlined as base64 STRINGS by esbuild's "base64"
// loader (see esbuild.config.mjs and scripts/local-export.ts — both set
// `loader: { ".ttf": "base64" }`), and vitest aliases these exact paths to
// tests/fixtures/font-bytes.ts so unit tests never load the real binaries.
//
// 008-mobile-support: this was the "binary" loader until mobile support. That
// loader emits `Buffer.from(...)` under platform: "node", and Buffer does not
// exist in Obsidian mobile's WebView — see the invariant comment in
// src/font-assets.ts before changing it back.
declare module "*.ttf" {
  const base64: string;
  export default base64;
}
