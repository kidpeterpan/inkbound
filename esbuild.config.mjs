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
  platform: "node",
  external: ["obsidian", "electron"],
  alias,
  // mathjax-full's version.js does `eval('require')` + __dirname to read its
  // own package.json — a bundler-proofing trick that resolves against the
  // bundle's location instead of the package's (and has no `require` at all
  // inside the shipped plugin). Defining PACKAGE_VERSION makes it take the
  // static branch instead. Keep in sync with package.json's mathjax-full.
  define: { PACKAGE_VERSION: JSON.stringify("3.2.1") },
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
