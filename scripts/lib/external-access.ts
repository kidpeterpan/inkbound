// What the shipped bundle can touch, checked instead of promised.
//
// WHY THIS EXISTS: Obsidian's plugin review reports the capabilities it detects
// in the bundle — "Direct Filesystem Access", "Clipboard Access" — and a human
// then has to read the answer out of the code. Inkbound's answer is short and
// stable, so it is written down once, here: an allowlist with a reason per entry,
// and a finding for anything outside it. A capability that arrives by accident —
// a new dependency's node shim, a convenience read of a file outside the vault, a
// clipboard read — then fails a gate instead of quietly widening what the plugin
// can do. The README's "What Inkbound touches" section is the same answer for
// readers; this module is the one that can fail a build.
//
// Two layers use it:
//   - `scripts/check-review-safe.ts` scans the SHIPPED main.js — what the
//     reviewer's scanner actually reads, vendor code included.
//   - `tests/external-access.test.ts` scans `src/`, so a mistake fails
//     `npm test` before any build, and pins the plugin's own fs calls and node
//     imports to exactly what the README discloses.
//
// PURE: no imports at all (not even node's), so both callers and vitest load it
// with no build step. See docs/DEVELOPMENT.md, "What the bundle can touch".

/** One thing the scanned text can do that the allowlist does not cover. */
export interface AccessFinding {
  kind: "builtin" | "clipboard" | "filesystem";
  /** What was found, e.g. `require("child_process")` or `fs.readFile(`. */
  what: string;
  /** 1-based line number in the scanned text. */
  line: number;
  /** The trimmed line, for a human reading the gate's output. */
  text: string;
}

/** One node builtin the scanned text asks for. */
export interface BuiltinRequire {
  name: string;
  /** `await import(...)` (allowed on mobile: it only runs if reached) vs a bare `require(...)`. */
  dynamic: boolean;
  line: number;
}

/**
 * Node builtins the shipped bundle may ask for, and why each is there. Anything
 * else is a finding: adding an entry is a deliberate act that also owes the
 * reader a line in the README's "What Inkbound touches".
 *
 * The four vendor entries are node-compatibility shims inside bundled
 * dependencies (they sit in the bundle's first ~2,000 lines, before any plugin
 * module). They are not plugin code and no plugin module imports them; they are
 * listed so the gate's failure output stays honest about the difference between
 * "vendor shim" and "our import".
 */
export const ALLOWED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["fs", "the one write: mkdir + writeFile of the finished book, desktop only"],
  ["os", "homedir(), to expand a `~` output folder, desktop only"],
  ["buffer", "vendor node-compat shim (bundled dependency, not plugin code)"],
  ["events", "vendor node-compat shim (bundled dependency, not plugin code)"],
  ["stream", "vendor node-compat shim (bundled dependency, not plugin code)"],
  ["util", "vendor node-compat shim (bundled dependency, not plugin code)"],
]);

/**
 * The filesystem calls the plugin MAKES. Everything else — reading, listing,
 * deleting, renaming, watching, permissions — is a finding, because the plugin
 * writes one finished book and never reads or removes anything outside the vault
 * (that is what makes the review's "can read and write any file" a statement
 * about the `fs` module rather than about this code).
 */
export const ALLOWED_FS_CALLS: readonly string[] = ["mkdir", "writeFile"];

// Node builtins, bare or `node:`-prefixed. Deliberately a design allowlist
// rather than an exhaustive copy of node's module list: these are the modules a
// bundled plugin could plausibly reach, and every one of them is either
// disclosed by ALLOWED_BUILTINS or a finding worth a human look.
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

// The keyword is CAPTURED, not merely matched: "is this lazy?" is the whole
// mobile-load question, and the answer is which keyword was used.
const REQUIRE = /\b(require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
// The receiver is matched loosely (`fs`, `fs2`, `fs$1`) because a bundle renames
// importers; the METHOD is what the allowlist decides.
const FS_CALL = /\bfs[0-9A-Za-z_$]*\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
// Reading the clipboard is the capability the review warns about ("may expose
// content copied from outside Obsidian"). Writing on the reader's click is not,
// so the method is captured and `writeText` is the one that passes.
const CLIPBOARD_CALL = /\bclipboard\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

function isNodeBuiltin(name: string): boolean {
  return NODE_BUILTINS.has(name.replace(/^node:/, ""));
}

/**
 * The lines worth scanning. Comment lines are blanked, not dropped, so line
 * numbers still point at the real file — the same convention as
 * `check-mobile-safe` and this module's own caller: prose explaining a hazard
 * (this repository has a lot of it, by design) is not an execution of it.
 */
function scannableLines(source: string): string[] {
  return source.split("\n").map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line));
}

/** Every node builtin the text asks for, in source order, with how it asked. */
export function builtinRequires(source: string): BuiltinRequire[] {
  const found: BuiltinRequire[] = [];
  for (const [index, line] of scannableLines(source).entries()) {
    for (const match of line.matchAll(REQUIRE)) {
      const [, keyword, raw] = match;
      if (!isNodeBuiltin(raw)) continue;
      found.push({ name: raw.replace(/^node:/, ""), dynamic: keyword === "import", line: index + 1 });
    }
  }
  return found;
}

/** One call the scanned text makes, and where. */
export interface CallRef {
  /** The method name alone: `readFile`, `writeText`, `mkdir`. */
  method: string;
  line: number;
}

/** Every filesystem call the text makes, allowlisted or not. */
export function fsCalls(source: string): CallRef[] {
  return callsIn(scannableLines(source), FS_CALL);
}

/** Every clipboard call the text makes: how the plugin's clipboard use is pinned to writes. */
export function clipboardCalls(source: string): CallRef[] {
  return callsIn(scannableLines(source), CLIPBOARD_CALL);
}

function callsIn(lines: readonly string[], pattern: RegExp): CallRef[] {
  const found: CallRef[] = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(pattern)) found.push({ method: match[1], line: index + 1 });
  }
  return found;
}

/**
 * Everything the text can do that the allowlists above do not cover. Empty means
 * the text touches only what the README discloses.
 *
 * Matched per line rather than over the whole source: line numbers come free and
 * a human reads them in the gate's output. A call split across lines would be
 * missed — esbuild never emits one, and the source-level test in
 * `tests/external-access.test.ts` reads the same shapes from `src/`.
 */
export function externalAccessFindings(source: string): AccessFinding[] {
  const lines = scannableLines(source);
  const findings: AccessFinding[] = [];
  // The line the call was found on, as a human reads it in the gate's output.
  // Indexed directly: every call below came from this same array.
  const textAt = (line: number): string => lines[line - 1].trim().slice(0, 120);

  for (const call of callsIn(lines, FS_CALL)) {
    if (ALLOWED_FS_CALLS.includes(call.method)) continue;
    findings.push({
      kind: "filesystem",
      what: `fs.${call.method}(`,
      line: call.line,
      text: textAt(call.line),
    });
  }

  for (const call of callsIn(lines, CLIPBOARD_CALL)) {
    if (call.method === "writeText") continue;
    findings.push({
      kind: "clipboard",
      what: `clipboard.${call.method}`,
      line: call.line,
      text: textAt(call.line),
    });
  }

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(REQUIRE)) {
      const raw = match[2];
      const name = raw.replace(/^node:/, "");
      if (!isNodeBuiltin(raw) || ALLOWED_BUILTINS.has(name)) continue;
      findings.push({ kind: "builtin", what: `require("${raw}")`, line: index + 1, text: textAt(index + 1) });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/** The one-line summary a gate prints for an allowlisted builtin list. */
export function describeBuiltins(found: readonly BuiltinRequire[]): string {
  const names = [...new Set(found.map((entry) => entry.name))].sort();
  return names.length === 0 ? "none" : names.join(", ");
}
