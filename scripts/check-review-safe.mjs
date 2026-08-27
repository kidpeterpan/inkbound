// Review-hygiene gate: the built main.js must contain no dynamic-code-execution
// TEXT, because Obsidian's plugin review greps the shipped bundle verbatim —
// statically-dead or not, a comment-safe `false ? eval("require") : x` branch
// still ships and still gets flagged.
//
// Why a whole gate for a grep: both findings this guards against arrived as
// substring collisions inside bundled vendor code, which no lint over src/ can
// see:
//
// - mathjax-full's components/version.js reads its package.json via
//   eval("require")/eval("__dirname"). esbuild.config.mjs's
//   mathjaxReviewHygiene plugin replaces that module with a stub; if a
//   MathJax upgrade changes the file layout so the plugin's filter stops
//   matching, the eval text would silently ship again.
// - MathJax's FunctionList class matches the `new Function` substring. The
//   plugin renames it (source stage) and the esbuild-generated consumer
//   identifier FunctionList_js_1 (onEnd stage); a new dependency, or a
//   renamed mathjax file the filters miss, would reintroduce hits that LOOK
//   like dynamic code execution to the scanner.
//
// If this fails: find what now bundles the flagged text and extend the
// mathjaxReviewHygiene plugin in esbuild.config.mjs (or add a shim) — do NOT
// loosen this check without a human-reviewed reason the text is benign.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../main.js", import.meta.url));

if (!existsSync(BUNDLE)) {
  console.error("check-review-safe: main.js not found — run `npm run build` first.");
  process.exit(2);
}

// Plain SUBSTRINGS, deliberately not \b-anchored regexes: the review scanner
// matches raw text, which is exactly how MathJax's `new FunctionList` got
// flagged — `new Function\b` would NOT match that, so an anchored pattern here
// would silently re-allow the very collision this gate exists to catch. The
// cost of mirroring the scanner (a hypothetical `medieval(` also failing) is a
// cheap human look, not a silent pass.
const PATTERNS = [
  "eval(",
  "new Function",
  'createElement("script")',
  'createElement(\'script\')',
  'setTimeout("',
  "setTimeout(`",
  'setImmediate("',
  "setImmediate(`",
];

const source = readFileSync(BUNDLE, "utf8");
// Comment lines are skipped (same convention as check-mobile-safe's check 1b):
// the bundle preserves src/'s invariant comments verbatim, and prose explaining
// a hazard is not an execution of it. Matches inside string literals could in
// principle sneak past this; none exist today, and a false positive here is a
// cheap human look rather than a silent pass.
const codeLines = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

const hits = [];
for (const pattern of PATTERNS) {
  for (const [i, line] of codeLines.entries()) {
    if (line.includes(pattern)) {
      hits.push({ name: JSON.stringify(pattern), line: i + 1, text: line.trim().slice(0, 120) });
    }
  }
}

if (hits.length > 0) {
  console.error(
    `check-review-safe: FAIL — ${hits.length} dynamic-code-execution pattern(s) in the shipped bundle.\n` +
      "Obsidian's plugin review flags these as dynamic code execution.\n"
  );
  for (const hit of hits) {
    console.error(`  main.js:${hit.line}  (${hit.name})`);
    console.error(`    ${hit.text}`);
  }
  console.error(
    "\nFix: extend the mathjaxReviewHygiene plugin in esbuild.config.mjs\n" +
      "  (its onLoad replaces flagged vendor modules; its onEnd renames\n" +
      "  esbuild-generated identifiers derived from flagged file names)."
  );
  process.exit(1);
}

console.log("check-review-safe: PASS — no eval(), new Function, or script-injection text in the bundle.");
