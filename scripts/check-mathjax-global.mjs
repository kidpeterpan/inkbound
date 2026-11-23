// MathJax-coexistence load gate (issue #14).
//
// THE INVARIANT: the plugin must load even when another plugin has already
// put a MathJax on the page. Inkbound bundles its own copy of mathjax-full
// and renders math headlessly through it — it never needs, and must never
// consult, whatever `window.MathJax` another plugin left behind. Numerals,
// for one, calls Obsidian's `loadMathJax()` in its own onload.
//
// But mathjax-full's input/tex/AllPackages.js — bundled into main.js — has a
// top-level block:
//
//   if (typeof MathJax !== 'undefined' && MathJax.loader) {
//       MathJax.loader.preLoad('[tex]/action', ... 30 more ...);
//   }
//
// That preLoad hint exists for MathJax's separate loader-component workflow,
// which Inkbound never uses. The guard only checks that SOME MathJax global
// exists with a truthy `.loader` — not that the global is a real v3 loader
// with a `preLoad` function. So when another plugin's MathJax is already on
// the page, enabling Inkbound evaluates this at plugin load, `MathJax.loader`
// is truthy but `preLoad` is not a function, and the whole plugin dies:
//
//   Plugin failure: inkbound TypeError: MathJax.loader.preLoad is not a function
//       at node_modules/mathjax-full/js/input/tex/AllPackages.js (plugin:inkbound:...)
//       at __require (plugin:inkbound:...)
//       at async UI.loadPlugin (app.js:...)
//
// The issue's workaround is order-dependent for exactly that reason: enable
// Inkbound first and the global does not exist yet when this module runs, so
// the guard short-circuits and the crash never happens.
//
// esbuild.config.mjs's mathjaxReviewHygiene plugin strips that block from
// the bundled AllPackages.js at build time. This gate proves the SHIPPED
// artifact stopped touching the page's global — in both directions:
//
//   Check 1 (behavior): the bundle LOADS with a foreign MathJax global
//   present —
//     1a. one shaped like the reported crash (truthy `.loader`, no `preLoad`);
//     1b. one where the consulted APIs exist, wrapped in a recording Proxy
//         that counts every access to the global or its nested loader — the
//         count must stay at zero: consulting another plugin's MathJax would
//         mark thirty-odd TeX packages as already loaded inside it, breaking
//         that plugin instead.
//   Check 2 (text): the shipped bundle no longer contains the call — a fast
//   belt-and-braces scan that also fails on machines where the load harness
//   cannot run for unrelated reasons.
//
// Like check-mobile-safe, the load runs the bundle the way Obsidian does — a
// plain `require` of main.js in a fresh DOM context — because the property it
// guards (what happens at plugin load) only exists in the built artifact.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const BUNDLE = fileURLToPath(new URL("../main.js", import.meta.url));

if (!existsSync(BUNDLE)) {
  console.error("check-mathjax-global: main.js not found — run `npm run build` first.");
  process.exit(2);
}

const source = readFileSync(BUNDLE, "utf8");

// ── Check 1: load the bundle with foreign MathJax globals present ────────────
//
// Same harness as check-mobile-safe's runtime check: jsdom (a real DOM, so
// nothing fails for a missing browser API Obsidian actually provides), a
// require stub for the obsidian module, and no Node globals. The one
// addition is the pre-installed `MathJax` global — which is the point.
function loadWithGlobal(mathjax) {
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
  context.MathJax = mathjax;
  context.require = (id) => {
    const bare = String(id).replace(/^node:/, "");
    if (bare === "obsidian" || bare === "electron") return stubModule();
    const err = new Error(`require("${id}") — not available in this load harness`);
    throw err;
  };

  vm.runInContext(source, context, { filename: "main.js" });
}

// 1a. The reported crash shape: a MathJax global with a truthy `.loader` and
// no `preLoad` function. This is what evaluating the unpatched AllPackages
// module throws on.
try {
  loadWithGlobal({ loader: { load: ["[tex]/ams"] } });
} catch (err) {
  console.error("check-mathjax-global: FAIL — the bundle throws at plugin load when a MathJax");
  console.error("  global is already on the page (issue #14).");
  console.error(`  ${err.message}`);
  if (err.stack) {
    const frame = err.stack.split("\n").find((l) => l.includes("main.js:"));
    if (frame) console.error(`  ${frame.trim()}`);
  }
  console.error(
    "\nIn Obsidian this kills the entire plugin, not just its math:\n" +
      "  `Plugin failure: inkbound TypeError: MathJax.loader.preLoad is not a function`.\n" +
      "  Fix: esbuild.config.mjs's mathjaxReviewHygiene plugin must strip the\n" +
      "  global-consulting block from mathjax-full's input/tex/AllPackages.js when\n" +
      "  bundling. If a mathjax-full update moved or reshaped the block, update the\n" +
      "  rewrite pattern there."
  );
  process.exit(1);
}

// 1b. The reverse direction: a global where the consulted APIs exist, wrapped
// in recording Proxies. The bundle must not touch it AT ALL — reading
// `MathJax.loader` and calling `preLoad` on it would mark thirty-odd TeX
// packages as already loaded inside another plugin's MathJax, breaking that
// plugin's own loading. A future MathJax shape could consult some other
// property instead, so every get/set/has on the global or its nested loader
// is counted whatever the property name — which is also what makes the PASS
// message below ("never touches it") literally true rather than only true of
// `preLoad`.
let touches = 0;
const countingLoader = new Proxy(
  {},
  {
    get() {
      touches += 1;
      // Any property reads as a callable, so a consulting bundle records the
      // touch and proceeds — the assertion below fails, naming the touch.
      return () => {};
    },
    set() {
      touches += 1;
      return true;
    },
    has() {
      touches += 1;
      return true;
    },
  }
);
const countingGlobal = new Proxy(
  { loader: countingLoader },
  {
    get(target, prop) {
      touches += 1;
      return target[prop];
    },
    set() {
      touches += 1;
      return true;
    },
    has() {
      touches += 1;
      return true;
    },
  }
);
try {
  loadWithGlobal(countingGlobal);
} catch (err) {
  console.error("check-mathjax-global: FAIL — the bundle throws at plugin load even when the");
  console.error("  foreign MathJax global has the APIs it consults.");
  console.error(`  ${err.message}`);
  if (err.stack) {
    const frame = err.stack.split("\n").find((l) => l.includes("main.js:"));
    if (frame) console.error(`  ${frame.trim()}`);
  }
  process.exit(1);
}
if (touches > 0) {
  console.error(
    `check-mathjax-global: FAIL — the bundle touched a foreign MathJax global ${touches} time(s) at\n` +
      "  plugin load. Inkbound bundles its own MathJax and must leave other plugins'\n" +
      "  MathJax alone: consulting it breaks whichever plugin owns it (e.g. marking TeX\n" +
      "  packages as pre-loaded there), and depending on its shape breaks ours."
  );
  process.exit(1);
}

// ── Check 2: the shipped text must not contain the call ─────────────────────
//
// The load checks above are the authority; this scan is a fast second layer
// that names the shipped line directly. Comments are exempt: main.ts's
// invariant comments ship in the bundle and may legitimately name the API in
// prose (the same exemption check-mobile-safe's import scan uses).
const offenders = [];
source.split("\n").forEach((line, i) => {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
  if (line.includes("MathJax.loader.preLoad")) {
    offenders.push({ line: i + 1, text: line.trim().slice(0, 100) });
  }
});
if (offenders.length > 0) {
  console.error(
    `check-mathjax-global: FAIL — ${offenders.length} line(s) of the shipped bundle call MathJax.loader.preLoad.\n` +
      "That call runs at plugin load and consults whatever MathJax global another\n" +
      "plugin left on the page (issue #14).\n"
  );
  for (const hit of offenders) {
    console.error(`  main.js:${hit.line}  ${hit.text}`);
  }
  console.error(
    "\nFix: esbuild.config.mjs's mathjaxReviewHygiene plugin must strip the\n" +
      "  `if (typeof MathJax !== 'undefined' && MathJax.loader) {...}` block from\n" +
      "  mathjax-full's input/tex/AllPackages.js when bundling."
  );
  process.exit(1);
}

console.log(
  "check-mathjax-global: PASS — the bundle loads with a foreign MathJax global present" +
    " and never touches it."
);
