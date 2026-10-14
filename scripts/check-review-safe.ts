// Review-hygiene gate: what the shipped main.js contains, and what it can touch.
//
// TWO KINDS OF FINDING, one gate, because both are answered by reading the
// artifact rather than by trusting src/:
//
// 1. DYNAMIC-CODE-EXECUTION TEXT. Obsidian's plugin review greps the bundle
//    verbatim — statically-dead or not, a comment-safe `false ? eval("require") : x`
//    branch still ships and still gets flagged. Both findings this guards against
//    arrived as substring collisions inside bundled vendor code, which no lint over
//    src/ can see:
//
//    - mathjax-full's components/version.js reads its package.json via
//      eval("require")/eval("__dirname"). esbuild.config.mjs's
//      mathjaxReviewHygiene plugin replaces that module with a stub; if a
//      MathJax upgrade changes the file layout so the plugin's filter stops
//      matching, the eval text would silently ship again.
//    - MathJax's FunctionList class matches the `new Function` substring. The
//      plugin renames it (source stage) and the esbuild-generated consumer
//      identifier FunctionList_js_1 (onEnd stage); a new dependency, or a
//      renamed mathjax file the filters miss, would reintroduce hits that LOOK
//      like dynamic code execution to the scanner.
//
//    If this fails: find what now bundles the flagged text and extend the
//    mathjaxReviewHygiene plugin in esbuild.config.mjs (or add a shim) — do NOT
//    loosen this check without a human-reviewed reason the text is benign.
//
// 2. CAPABILITIES. The review's other findings for this plugin are "Direct
//    Filesystem Access" (a warning) and "Clipboard Access" (a recommendation),
//    and the answer to both is a short, stable list: one desktop write, one
//    clipboard write the reader pressed a button for. That list lives in
//    scripts/lib/external-access.ts as an allowlist with a reason per entry;
//    this file applies it to the SHIPPED bundle, vendor code included, so the
//    answer comes from the artifact and a new capability fails a build. The
//    source-level half of the same rule is tests/external-access.test.ts.
//
//    If this fails: the finding names the capability and the line. Either it is
//    a mistake — remove it — or it is real, in which case it needs an entry in
//    ALLOWED_BUILTINS/ALLOWED_FS_CALLS *and* a line in the README's "What
//    Inkbound touches" section, because a capability the plugin has is a
//    capability the reader is entitled to read about.
//
// Runs after `npm run build` in CI and in the release workflow: it inspects the
// file a release publishes, not a rebuild.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_FS_CALLS,
  builtinRequires,
  clipboardCalls,
  describeBuiltins,
  externalAccessFindings,
  fsCalls,
} from "./lib/external-access";
import { REPO_ROOT } from "./lib/harness";

const BUNDLE = join(REPO_ROOT, "main.js");

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
  "createElement('script')",
  'setTimeout("',
  "setTimeout(`",
  'setImmediate("',
  "setImmediate(`",
];

const source = readFileSync(BUNDLE, "utf8");
// Comment lines are skipped (same convention as check-mobile-safe's check 1b, and
// of the scanner this file calls): the bundle preserves src/'s invariant comments
// verbatim, and prose explaining a hazard is not an execution of it. Matches
// inside string literals could in principle sneak past this; none exist today,
// and a false positive here is a cheap human look rather than a silent pass.
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

const access = externalAccessFindings(source);
if (access.length > 0) {
  console.error(
    `check-review-safe: FAIL — ${access.length} capability finding(s) in the shipped bundle.\n` +
      "Obsidian's plugin review reports these; the README's \"What Inkbound touches\"\n" +
      "section is the list the plugin is allowed to have (scripts/lib/external-access.ts).\n"
  );
  for (const finding of access) {
    console.error(`  main.js:${finding.line}  (${finding.kind}) ${finding.what}`);
    console.error(`    ${finding.text}`);
  }
  console.error(
    "\nFix: remove the capability, or — if it is real — add it to the allowlist in\n" +
      "  scripts/lib/external-access.ts WITH a reason, and disclose it in the README."
  );
  process.exit(1);
}

const builtins = describeBuiltins(builtinRequires(source));
const fsMethods = [...new Set(fsCalls(source).map((call) => call.method))].sort();
const clipboardWrites = clipboardCalls(source).filter((call) => call.method === "writeText").length;

console.log(
  `check-review-safe: PASS — no eval(), new Function or script-injection text in the bundle; ` +
    `node builtins required: ${builtins}; filesystem calls: ${fsMethods.join(", ")} ` +
    `(allowed: ${ALLOWED_FS_CALLS.join(", ")}); clipboard: ${clipboardWrites} write(s), no reads.`
);
