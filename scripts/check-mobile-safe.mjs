// Mobile load-safety gate (008-mobile-support).
//
// THE INVARIANT: the built main.js must contain no node-builtin require() that
// executes when Obsidian loads the plugin. Obsidian mobile has no `require`,
// so a top-level `require("fs")` throws before onload() runs — the plugin does
// not fail to work, it fails to EXIST. No amount of Platform.isDesktopApp
// guarding inside the code can save a plugin that dies at load.
//
// esbuild.config.mjs sets platform: "node", which externalizes node builtins
// rather than bundling them, so a static `import ... from "fs"` compiles to a
// top-level require(). A dynamic `await import("fs")` inside a function body
// compiles to a require() inside that function body, which mobile never
// reaches. This script is what keeps a future refactor from quietly turning
// the second form back into the first.
//
// HOW IT DECIDES: esbuild's non-minified output puts top-level statements at
// column 0 and indents everything nested inside a function. So a require() of
// a node builtin on an unindented line executes at load; an indented one does
// not. That assumption is checked below — if the bundle ever becomes minified,
// this script fails loudly rather than silently passing everything.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const BUNDLE = fileURLToPath(new URL("../main.js", import.meta.url));

// Externalized by esbuild's platform: "node". `obsidian` and `electron` are
// externals too, but Obsidian itself provides those — they are not the hazard.
const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "cluster", "constants", "crypto", "dns",
  "domain", "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

const pattern = new RegExp(
  `require\\(\\s*["'](?:node:)?(${NODE_BUILTINS.join("|")})["']\\s*\\)`,
  "g",
);

if (!existsSync(BUNDLE)) {
  console.error("check-mobile-safe: main.js not found — run `npm run build` first.");
  process.exit(2);
}

const source = readFileSync(BUNDLE, "utf8");
const lines = source.split("\n");

// Guard the load-bearing assumption. Minified output collapses everything onto
// a few enormous lines, which would make "unindented" meaningless and turn this
// gate into a rubber stamp.
//
// Judged by AVERAGE line length, not longest: this bundle legitimately contains
// two ~64KB lines, the base64-inlined Noto Sans Thai TTFs (006-thai-font), and
// a longest-line test would flag those as minification forever.
const avgLineLength = source.length / lines.length;
if (lines.length < 50 || avgLineLength > 500) {
  console.error(
    `check-mobile-safe: main.js looks minified (${lines.length} lines, ` +
      `${Math.round(avgLineLength)} chars/line average). This check distinguishes ` +
      "top-level from nested code by indentation, which minification destroys. " +
      "Revisit this script before shipping a minified bundle.",
  );
  process.exit(2);
}

const topLevel = [];
const nested = [];

lines.forEach((line, i) => {
  for (const match of line.matchAll(pattern)) {
    const hit = { line: i + 1, module: match[1], text: line.trim().slice(0, 100) };
    // Column 0 == top level of the CJS bundle == executed at plugin load.
    if (/^\S/.test(line)) topLevel.push(hit);
    else nested.push(hit);
  }
});

if (topLevel.length > 0) {
  console.error(
    `check-mobile-safe: FAIL — ${topLevel.length} node-builtin require(s) execute at plugin load.\n` +
      "Obsidian mobile has no require(), so the plugin will fail to load entirely.\n",
  );
  for (const hit of topLevel) {
    console.error(`  main.js:${hit.line}  require("${hit.module}")`);
    console.error(`    ${hit.text}`);
  }
  console.error(
    "\nFix: move the import inside the desktop-only branch as a dynamic import,\n" +
      '  e.g. `const { promises: fs } = await import("fs");` inside the function\n' +
      "  body, reached only when Platform.isDesktopApp is true.\n" +
      "  See specs/008-mobile-support/contracts/platform-seam.md.",
  );
  process.exit(1);
}

// ── Check 2: actually load the bundle with mobile's globals ────────────────
//
// The scan above only finds hazards shaped like require(). It cannot see the
// other way a bundle dies at load on mobile: touching a Node GLOBAL. That is
// not hypothetical — esbuild's "binary" loader under platform: "node" emitted
// `Buffer.from(base64, "base64")` at module top level to decode the inlined
// fonts, and `Buffer` does not exist in a mobile WebView. No require() was
// involved, so the scan passed while the plugin was still unloadable.
//
// So: evaluate the bundle in a context that has what a WebView has and lacks
// what Node has. This is the real condition, not a proxy for it.

// The DOM comes from jsdom rather than a hand-rolled stub so the simulation is
// FAIR: a mobile WebView is a real browser environment, and a thin stub would
// fail the bundle for missing DOM methods that mobile actually has. (MathJax,
// for one, calls document.getElementsByTagName at module top level — legal on
// mobile, and not something this gate should flag.) What jsdom does NOT give
// us is Buffer, process, or require — exactly the Node-only surface we are
// testing for the absence of.
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://obsidian.md/",
  runScripts: "outside-only",
});
const context = dom.getInternalVMContext();

const stubModule = () => new Proxy(function () {}, { get: () => stubModule(), construct: () => ({}) });

const module_ = { exports: {} };
context.module = module_;
context.exports = module_.exports;
context.console = console;
// Obsidian provides these to the plugin on BOTH platforms. Everything else is
// a node builtin the mobile runtime does not have.
context.require = (id) => {
  const bare = String(id).replace(/^node:/, "");
  if (bare === "obsidian" || bare === "electron") return stubModule();
  const err = new Error(`require("${id}") — not available on Obsidian mobile`);
  err.mobileFatal = true;
  throw err;
};

try {
  vm.runInContext(source, context, { filename: "main.js" });
} catch (err) {
  console.error("check-mobile-safe: FAIL — the bundle throws while loading on a mobile-like runtime.");
  console.error(`  ${err.message}`);
  if (err.stack) {
    const frame = err.stack.split("\n").find((l) => l.includes("main.js:"));
    if (frame) console.error(`  ${frame.trim()}`);
  }
  console.error(
    "\nThe plugin would not merely misbehave on mobile — it would fail to load.\n" +
      "  Cause is usually a Node-only API used at module top level: a static node\n" +
      "  import, or a Node global such as Buffer/process (esbuild's `binary` loader\n" +
      "  emits Buffer.from under platform: \"node\" — use `base64` and decode with atob).\n" +
      "  See specs/008-mobile-support/contracts/platform-seam.md.",
  );
  process.exit(1);
}

console.log(
  "check-mobile-safe: PASS — no node-builtin require executes at plugin load" +
    (nested.length > 0
      ? ` (${nested.length} lazy require(s) inside function bodies, which is the permitted form)`
      : "") +
    ", and the bundle loads cleanly in a mobile-like runtime.",
);
