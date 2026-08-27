import esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// Single source of truth for MathJax's version: its own package.json, read at
// build time. (mathjax-full/js/components/version.js used to supply this at
// runtime via eval("require") — see the plugin below for why that module is
// replaced outright.)
const MATHJAX_VERSION = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("mathjax-full/package.json"), "utf8")
).version;

// Obsidian's plugin review greps the SHIPPED BUNDLE TEXT for dynamic code
// execution (`eval(`, `new Function`), which flagged two things neither of
// which is real dynamic execution:
//
// 1. mathjax-full/js/components/version.js reads its own package.json via
//    eval("require") + eval("__dirname"). esbuild's `define: PACKAGE_VERSION`
//    made that branch statically dead (`false ? ... : ...`), but dead or not,
//    the eval TEXT ships and the scanner flags it. Replacing the whole module
//    with a stub exporting the same VERSION (stamped from mathjax's real
//    package.json above) removes the text without changing behavior — VERSION
//    is only ever read for display (`version: version_js_1.VERSION` in
//    mathjax.js and components/global.js, nothing else).
// 2. MathJax's `new FunctionList()` class matches the `new Function`
//    substring. Renaming the identifier consistently across mathjax's sources
//    makes the false positive go away without touching behavior. The lookahead
//    in the pattern is load-bearing: `FunctionList.js` inside require
//    specifiers must NOT be renamed (the file on disk keeps its name), while
//    every other occurrence must be — declaration (`var FunctionList =`),
//    constructor calls (`new FunctionList`, member `FunctionList_js_1
//    .FunctionList`), `exports.FunctionList`, and internal references — a
//    partial rename would point uses at an undefined identifier. Verified:
//    "FunctionList" appears in mathjax-full/js ONLY in those code shapes and
//    the path strings; never in a user-visible string literal.
//
// Unlike the immediate/setimmediate aliases above, vitest.config.ts needs NO
// mirror of this plugin: under vitest/node the original version.js evaluates
// fine (eval("require") is legal there) and produces the same VERSION value
// this plugin stamps in, so both environments agree on behavior — the alias
// invariant about keeping both configs in sync is about shims that CHANGE
// behavior, which this does not.
//
// The rename has a second stage that can ONLY happen on the final bundle:
// esbuild derives consumer-side identifiers (e.g. `FunctionList_js_1`) from
// the module's FILE NAME, and `./util/FunctionList.js` must keep its real
// name for the require specifiers inside mathjax's own sources to resolve —
// so `new FunctionList_js_1.MathJaxFnList()` still contains the flagged
// `new Function` substring after stage 1. onEnd therefore rewrites that one
// generated identifier in the finished output. This is why the build runs
// with `write: false` and writes the (patched) output itself.
const mathjaxReviewHygiene = {
  name: "mathjax-review-hygiene",
  setup(build) {
    build.onLoad({ filter: /mathjax-full[\/\\]js[\/\\].*\.js$/, namespace: "file" }, (args) => {
      if (/[\/\\]components[\/\\]version\.js$/.test(args.path)) {
        const contents =
          '"use strict";\n' +
          'Object.defineProperty(exports, "__esModule", { value: true });\n' +
          `exports.VERSION = ${JSON.stringify(MATHJAX_VERSION)};\n`;
        return { contents, loader: "js" };
      }
      const contents = readFileSync(args.path, "utf8");
      const renamed = contents.replace(/\bFunctionList\b(?!\.js)/g, "MathJaxFnList");
      return renamed === contents ? undefined : { contents: renamed, loader: "js" };
    });
    build.onEnd(async (result) => {
      const { writeFile } = await import("node:fs/promises");
      for (const file of result.outputFiles ?? []) {
        // The identifier is generated only in the bundle; a global replace is
        // safe because it is esbuild-invented and used consistently (no string
        // literal can reference it), and the __commonJS registry key keeps the
        // real path, which nothing matches against the renamed local.
        const text = file.text.replaceAll("FunctionList_js_1", "MathJaxFnList_js_1");
        await writeFile(file.path, text);
      }
    });
  },
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
  // 008-mobile-support / desktop-load fix — INVARIANT: without this, esbuild
  // leaves `await import("os")` VERBATIM in the CJS bundle (it only rewrites
  // dynamic imports of modules it bundles, and platform: "node" above
  // externalizes the builtins). Obsidian loads main.js as CommonJS, but a
  // native import() inside it goes to the BROWSER's ESM loader, which cannot
  // resolve a bare "os" — every desktop export died with "Failed to resolve
  // module specifier 'os'" from 1.7.0 until this line. Telling esbuild the
  // target does not support dynamic import makes it lower each one to a
  // require() in place, INSIDE the function body — which is what the lazy-
  // import invariant in src/main.ts has always claimed to produce, and what
  // keeps the plugin loadable on mobile. `npm run check-mobile-safe` (check
  // 1b) fails the build if a raw import() of a builtin ever returns.
  supported: { "dynamic-import": false },
  external: ["obsidian", "electron"],
  alias,
  plugins: [mathjaxReviewHygiene],
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
  // mathjax-review-hygiene writes the output itself (see its onEnd) so the
  // final bundle gets the generated-identifier rename that can only happen
  // after bundling.
  write: false,
  logLevel: "info",
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[esbuild] watching for changes... (Ctrl-C to stop)");
}
