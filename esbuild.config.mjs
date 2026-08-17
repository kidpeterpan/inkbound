import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
const prod = process.argv[2] === "production";

// JSZip pulls in `setimmediate` (directly) and `lie`'s `immediate` (transitively)
// purely as IE-era setImmediate polyfills. Both ship a `new Function(...)` and/or
// `document.createElement("script")` fallback, which Obsidian's plugin review
// flags as dynamic code execution — dead weight in Electron/Chromium, which
// always has a real setImmediate/queueMicrotask. Alias them to local shims that
// use queueMicrotask/setTimeout instead. See shims/immediate.cjs and
// shims/setimmediate.cjs for details.
const alias = {
  immediate: fileURLToPath(new URL("./shims/immediate.cjs", import.meta.url)),
  setimmediate: fileURLToPath(new URL("./shims/setimmediate.cjs", import.meta.url)),
};

const buildOptions = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  // 008-mobile-support — INVARIANT: `platform: "node"` is why this plugin can
  // break on mobile in ways the source does not show. It makes esbuild (a)
  // externalize node builtins, so a STATIC `import ... from "fs"` becomes a
  // top-level require() that throws at load on mobile, and (b) emit Node
  // variants of its runtime helpers, e.g. the Buffer-based `__toBinaryNode`
  // for the "binary" loader (see the ttf loader note below). Neither is
  // visible in src/. `npm run check-mobile-safe` guards both by scanning the
  // built bundle AND loading it in a mobile-like runtime; it runs in CI right
  // after `build`. Changing this line means re-reading that script first.
  platform: "node",
  external: ["obsidian", "electron"],
  alias,
  // mathjax-full's version.js does `eval('require')` + __dirname to read its
  // own package.json — a bundler-proofing trick that resolves against the
  // bundle's location instead of the package's (and has no `require` at all
  // inside the shipped plugin). Defining PACKAGE_VERSION makes it take the
  // static branch instead. Keep in sync with package.json's mathjax-full.
  define: { PACKAGE_VERSION: JSON.stringify("3.2.1") },
  // 006-thai-font: inline the bundled TTFs so the plugin ships its fonts
  // offline.
  // 008-mobile-support — INVARIANT: "base64" (a plain string), NOT "binary".
  // Under `platform: "node"` above, the "binary" loader emits a
  // `__toBinaryNode` helper built on `Buffer.from(base64, "base64")` that runs
  // at module top level. `Buffer` is a Node global absent from Obsidian
  // mobile's WebView, so "binary" makes the plugin fail to LOAD on mobile —
  // with no require() involved for a static scan to catch. src/font-assets.ts
  // decodes the string with atob, which exists on both platforms.
  loader: { ".ttf": "base64" },
  sourcemap: prod ? false : "inline",
  logLevel: "info",
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[esbuild] watching for changes... (Ctrl-C to stop)");
}
