// Bundled font assets are inlined by esbuild's binary loader (see
// esbuild.config.mjs and scripts/local-export.ts — both set
// `loader: { ".ttf": "binary" }`), and vitest aliases these exact paths to
// tests/fixtures/font-bytes.ts so unit tests never load the real binaries.
declare module "*.ttf" {
  const bytes: Uint8Array;
  export default bytes;
}
