// The module boundary, enforced instead of documented.
//
// The layout IS the rule:
//
//   src/core/*      pure. No `obsidian` import, no Node builtin, no import of
//                   anything that has one. vitest loads these directly, with
//                   no stub, which is what keeps the pipeline unit-testable.
//   src/adapters/*  may import `obsidian` (app, vault, renderer, transport).
//   src/main.ts     the plugin entry — an adapter, and the one file esbuild
//                   bundles (see esbuild.config.mjs's entryPoints).
//
// This test is a FITNESS FUNCTION: it fails when the rule is broken, in either
// direction, and names the offending file. Before this existed the rule was
// prose in CLAUDE.md, and prose does not fail a build.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const SRC_DIR = join(__dirname, "..", "src");
const CORE_PREFIX = "core/";
const ADAPTER_PREFIX = "adapters/";

/** Every .ts under src/, as paths relative to src/ ("core/render.ts"). */
function relativeTsFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...relativeTsFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

const MODULES = relativeTsFiles(SRC_DIR).sort();

// Two patterns, because the shapes differ: a static import starts its own line
// (`import x from "m"`, `import { x } from "m"`, `import "m"`, `export … from`,
// and their multi-line forms), while a dynamic one appears mid-expression —
// `const { promises: fs } = await import("fs")`. Comment lines are stripped
// first: this file's own subject matter means comments here talk ABOUT
// `from "obsidian"`, and a naive search matches that prose (it did, while this
// was being written).
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']/g;

// Node builtins, bare or `node:`-prefixed. `core/` must not reach for any of
// them: the plugin ships one bundle that has to LOAD on Obsidian mobile, where
// there is no require() — see docs/DEVELOPMENT.md's "The mobile load gate".
// (ESM-only builtins like `node:fs/promises` are covered by the prefix check.)
const NODE_BUILTIN = new Set([
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

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTIN.has(specifier);
}

function sourceWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function importedSpecifiers(moduleName: string): string[] {
  const source = sourceWithoutComments(readFileSync(join(SRC_DIR, moduleName), "utf8"));
  return [
    ...[...source.matchAll(STATIC_IMPORT)].map((match) => match[1]),
    ...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]),
  ];
}

/** Resolves a relative specifier to a src-relative path ("core/x"), or null. */
function resolvesWithinSrc(moduleName: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return normalize(join(dirname(moduleName), specifier));
}

const isAdapter = (moduleName: string): boolean =>
  moduleName.startsWith(ADAPTER_PREFIX) || moduleName === "main.ts";

describe("the pure/adapter module boundary", () => {
  it("has modules to check (so a broken path cannot make this pass vacuously)", () => {
    expect(MODULES.filter((m) => m.startsWith(CORE_PREFIX)).length).toBeGreaterThan(20);
    expect(MODULES.filter((m) => m.startsWith(ADAPTER_PREFIX)).length).toBeGreaterThan(5);
    expect(MODULES).toContain("main.ts");
  });

  it("keeps every core module free of obsidian and of adapter imports", () => {
    const leaks: string[] = [];

    for (const moduleName of MODULES.filter((m) => m.startsWith(CORE_PREFIX))) {
      for (const specifier of importedSpecifiers(moduleName)) {
        if (specifier === "obsidian") {
          leaks.push(`${moduleName} imports obsidian`);
          continue;
        }
        const resolved = resolvesWithinSrc(moduleName, specifier);
        if (resolved !== null && isAdapter(resolved)) {
          leaks.push(`${moduleName} imports ${specifier}`);
        }
      }
    }

    expect(leaks, "core/ must stay pure: move the impure part into adapters/, or the module itself").toEqual(
      []
    );
  });

  it("keeps node builtins out of core, so the bundle still loads on mobile", () => {
    const offenders: string[] = [];

    for (const moduleName of MODULES.filter((m) => m.startsWith(CORE_PREFIX))) {
      for (const specifier of importedSpecifiers(moduleName)) {
        if (isNodeBuiltin(specifier)) offenders.push(`${moduleName} imports ${specifier}`);
      }
    }

    expect(
      offenders,
      "core/ modules must not import node builtins: the shipped bundle is one file that has " +
        "to load on Obsidian mobile, where require() does not exist (see docs/DEVELOPMENT.md)"
    ).toEqual([]);
  });

  it("keeps obsidian out of everything that is not an adapter", () => {
    const importers = MODULES.filter((m) => importedSpecifiers(m).includes("obsidian"));
    const undeclared = importers.filter((m) => !isAdapter(m));

    expect(
      undeclared,
      'these modules import "obsidian" but live outside adapters/: either move them into ' +
        "adapters/, or move the obsidian use out of them"
    ).toEqual([]);
  });

  it("parses imports the way the modules actually write them", () => {
    // Guards the parser itself: the assertions above are silent if
    // IMPORT_SPECIFIER stops matching the shapes the code actually uses.
    expect(importedSpecifiers("main.ts")).toContain("obsidian"); // multi-line from
    expect(importedSpecifiers("core/render.ts")).not.toContain("obsidian");
    expect(importedSpecifiers("core/render.ts").length).toBe(0);
    expect(importedSpecifiers("adapters/render-adapter.ts")).toContain("obsidian");
    // Dynamic import: adapters/output-adapter.ts does `await import("fs")`.
    expect(importedSpecifiers("adapters/output-adapter.ts")).toContain("fs");
  });
});
