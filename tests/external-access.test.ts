// What the plugin can touch, enforced instead of promised.
//
// Obsidian's plugin review reports the capabilities it finds in the bundle:
// "Direct Filesystem Access" and "Clipboard Access" for this plugin, with a pass
// for vault reads through the API. The README answers those findings for readers
// ("What Inkbound touches"); this file is the half that fails a build. It reads
// the real `src/` tree — the technique tests/module-boundaries.test.ts established
// for the pure/adapter split — and pins the plugin's own answer to exactly:
//
//   node builtins:  fs and os, both reached with `await import(...)` inside a
//                   Platform.isDesktop guard, so mobile never loads them
//   filesystem:     mkdir + writeFile of the finished book, nothing else
//   clipboard:      writeText, from a button the reader pressed, never a read
//
// A finding here means the README's disclosure is now wrong, which is why it
// fails `npm test` rather than waiting for a scanner to notice:
// `scripts/check-review-safe.ts` runs the same scanner over the SHIPPED bundle.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_BUILTINS,
  ALLOWED_FS_CALLS,
  builtinRequires,
  clipboardCalls,
  describeBuiltins,
  externalAccessFindings,
  fsCalls,
} from "../scripts/lib/external-access";

const summary = (source: string) =>
  externalAccessFindings(source).map((finding) => `${finding.kind}:${finding.what}`);

describe("externalAccessFindings: what the plugin may touch", () => {
  it("passes the calls this plugin actually makes", () => {
    const source = [
      'const { homedir } = await import("os");',
      'const { promises: fs } = await import("fs");',
      "await fs.mkdir(folder, { recursive: true });",
      "await fs.writeFile(path, bytes);",
      "await navigator.clipboard.writeText(report);",
    ].join("\n");

    expect(externalAccessFindings(source)).toEqual([]);
  });

  it("flags any node builtin the allowlist does not name", () => {
    expect(summary('require("child_process")')).toEqual(['builtin:require("child_process")']);
    expect(summary('const net = await import("node:net");')).toEqual(['builtin:require("node:net")']);
    expect(summary('require("http")')).toEqual(['builtin:require("http")']);
    expect(summary('require("worker_threads")')).toEqual(['builtin:require("worker_threads")']);
  });

  it("allows the vendor node shims the bundle carries, and nothing else silently", () => {
    for (const name of ["buffer", "events", "stream", "util"]) {
      expect(summary(`require("${name}")`), name).toEqual([]);
    }
    expect([...ALLOWED_BUILTINS.keys()].sort()).toEqual(["buffer", "events", "fs", "os", "stream", "util"]);
  });

  it("flags every filesystem call that is not the one write", () => {
    const reads = [
      "fs.readFile(",
      "fs.readFileSync(",
      "fs.readdir(",
      "fs.readdirSync(",
      "fs.stat(",
      "fs.lstatSync(",
      "fs.access(",
      "fs.realpath(",
    ];
    for (const call of reads) {
      expect(summary(`await ${call}"p");`), call).toEqual([`filesystem:${call}`]);
    }
    const destroys = [
      "fs.unlink(",
      "fs.rm(",
      "fs.rmdir(",
      "fs.rename(",
      "fs.copyFile(",
      "fs.chmod(",
      "fs.watch(",
    ];
    for (const call of destroys) {
      expect(summary(`await ${call}"p");`), call).toHaveLength(1);
    }
  });

  it("passes the two calls it does make, whatever the bundle renamed the importer to", () => {
    for (const allowed of ALLOWED_FS_CALLS) {
      expect(summary(`await fs.${allowed}("p");`), allowed).toEqual([]);
      expect(summary(`await fs2.${allowed}("p");`), `${allowed} via fs2`).toEqual([]);
    }
  });

  it("flags reading the clipboard and passes writing to it", () => {
    expect(summary("const text = await navigator.clipboard.readText();")).toEqual([
      "clipboard:clipboard.readText",
    ]);
    expect(summary("navigator.clipboard.read();")).toEqual(["clipboard:clipboard.read"]);
    expect(summary("await navigator.clipboard.writeText(report);")).toEqual([]);
  });

  it("ignores prose about a hazard, because comments are not executions", () => {
    const source = [
      '// a static import { promises as fs } from "fs" compiles to require("fs")',
      '// and require("child_process") would be a finding if it were code',
      " * clipboard.readText() is the capability the review warns about",
      "/* await fs.unlink(path) is something this plugin must never do */",
    ].join("\n");

    expect(externalAccessFindings(source)).toEqual([]);
  });

  it("does not mistake ordinary words for capabilities (the bundle's own false positives)", () => {
    // Both of these occur in the real shipped bundle today: the planner's
    // "unlinked" notes and MathJax's renameIds(). A substring scan would fail
    // the gate on them, so they are pinned here.
    const source = [
      "const unlinked = orderByName(items, nameOf);",
      "const children = [...linked, ...unlinked].map(toNode);",
      "renameIds(elementsWithIds, idRenames);",
      "function renameIds(elements, renames) {}",
    ].join("\n");

    expect(externalAccessFindings(source)).toEqual([]);
    expect(fsCalls(source)).toEqual([]);
  });

  it("reports what and where, for the gate's output", () => {
    const source = ["const a = 1;", "", 'await fs.readFile("p");'].join("\n");
    const [finding] = externalAccessFindings(source);

    expect(finding).toEqual({
      kind: "filesystem",
      what: "fs.readFile(",
      line: 3,
      text: 'await fs.readFile("p");',
    });
  });

  it("lists findings in source order when a line has several", () => {
    const source = ['await fs.readFile("a"); require("child_process");', "await fs.unlink("].join("\n");

    expect(externalAccessFindings(source).map((f) => f.line)).toEqual([1, 1, 2]);
  });
});

describe("builtinRequires: how the plugin asks node for something", () => {
  it("reports the name, the line, and whether the import is lazy", () => {
    const source = ['const { promises: fs } = await import("fs");', 'const x = require("path");'].join("\n");

    expect(builtinRequires(source)).toEqual([
      { name: "fs", dynamic: true, line: 1 },
      { name: "path", dynamic: false, line: 2 },
    ]);
  });

  it("ignores a builtin-shaped name that is not a builtin", () => {
    expect(builtinRequires('require("obsidian")')).toEqual([]);
    expect(builtinRequires('require("./core/book/naming")')).toEqual([]);
  });

  it("describes the set for a gate's summary line", () => {
    expect(describeBuiltins(builtinRequires('await import("fs"); await import("os"); require("fs");'))).toBe(
      "fs, os"
    );
    expect(describeBuiltins([])).toBe("none");
  });
});

// ── the fitness function over the real source tree ───────────────────────

const SRC_DIR = join(__dirname, "..", "src");

function sourceFiles(dir: string, prefix = ""): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(join(dir, entry.name), `${path}/`));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push({ path, text: readFileSync(join(dir, entry.name), "utf8") });
    }
  }
  return found;
}

const SOURCES = sourceFiles(SRC_DIR);

describe("the plugin's own source, scanned", () => {
  it("has sources to scan at all (so a moved directory cannot make this pass vacuously)", () => {
    expect(SOURCES.length).toBeGreaterThan(40);
    expect(SOURCES.map((file) => file.path)).toContain("adapters/output-adapter.ts");
  });

  it("touches nothing outside the allowlists", () => {
    const findings = SOURCES.flatMap((file) =>
      externalAccessFindings(file.text).map((finding) => `${file.path}:${finding.line} ${finding.what}`)
    );

    expect(findings).toEqual([]);
  });

  it("asks node for exactly fs and os, and only with a lazy import", () => {
    // Lazy is not a style choice: a top-level require("fs") stops the plugin from
    // LOADING on mobile, before onload(). `npm run check-mobile-safe` enforces the
    // same rule on the built bundle; this catches it before a build.
    const requires = SOURCES.flatMap((file) => builtinRequires(file.text).map((entry) => ({ file, entry })));

    expect(requires.map(({ entry }) => entry.name).sort()).toEqual(["fs", "os"]);
    expect(requires.filter(({ entry }) => !entry.dynamic)).toEqual([]);
  });

  it("makes exactly the filesystem calls the README discloses", () => {
    const calls = SOURCES.flatMap((file) => fsCalls(file.text));

    expect([...new Set(calls.map((call) => call.method))].sort()).toEqual([...ALLOWED_FS_CALLS].sort());
  });

  it("writes to the clipboard and never reads it", () => {
    const calls = SOURCES.flatMap((file) => clipboardCalls(file.text));

    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls.map((call) => call.method))]).toEqual(["writeText"]);
  });
});
