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
// Inside core/ the layout carries three more rules, checked in the second
// describe below: nothing but types.ts sits directly in core/ (every other
// module lives in a concern folder), core/common/ imports nothing else from
// src/, and no core module can import its way back to itself.
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
const COMMON_PREFIX = "core/common/";
const CORE_ROOT_MODULE = "core/types.ts";

/** Every .ts under src/, as paths relative to src/ ("core/render/index.ts"). */
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

const MODULE_SET = new Set(MODULES);

/**
 * Resolves a relative specifier to the .ts module it names, as a src-relative
 * path: "../render" from core/content/math.ts is "core/render/index.ts". Null
 * when it names no module (a package, or a file that is not .ts, such as a
 * bundled font).
 */
function resolveToModule(importer: string, specifier: string): string | null {
  const target = resolvesWithinSrc(importer, specifier);
  if (target === null) return null;

  const candidates = [`${target}.ts`, `${target}/index.ts`];
  return candidates.find((candidate) => MODULE_SET.has(candidate)) ?? null;
}

/** Which core modules each core module imports. Type-only imports count: a cycle that only types
 * form is erased at runtime but is still coupling. */
function coreImportGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const moduleName of MODULES.filter((m) => m.startsWith(CORE_PREFIX))) {
    const importedCoreModules = importedSpecifiers(moduleName)
      .map((specifier) => resolveToModule(moduleName, specifier))
      .filter((resolved): resolved is string => resolved !== null && resolved.startsWith(CORE_PREFIX));
    graph.set(moduleName, importedCoreModules);
  }

  return graph;
}

/** Every distinct import cycle, each written as a path that returns to where it started. */
function findImportCycles(graph: Map<string, string[]>): string[] {
  const cycles = new Set<string>();
  const fullyVisited = new Set<string>();
  const pathSoFar: string[] = [];

  function visit(moduleName: string): void {
    const positionInPath = pathSoFar.indexOf(moduleName);
    if (positionInPath !== -1) {
      cycles.add([...pathSoFar.slice(positionInPath), moduleName].join(" -> "));
      return;
    }
    if (fullyVisited.has(moduleName)) return;

    pathSoFar.push(moduleName);
    for (const importedModule of graph.get(moduleName) ?? []) visit(importedModule);
    pathSoFar.pop();
    fullyVisited.add(moduleName);
  }

  for (const moduleName of graph.keys()) visit(moduleName);
  return [...cycles];
}

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
    // A zero-import module: error-text.ts is a leaf by construction (it exists
    // to be the one shared string coercion). render/index.ts used to be this
    // exemplar; it is now a re-export facade, so the "no imports at all" case
    // needs a module that still has none.
    expect(importedSpecifiers("core/common/error-text.ts")).not.toContain("obsidian");
    expect(importedSpecifiers("core/common/error-text.ts").length).toBe(0);
    expect(importedSpecifiers("adapters/render-adapter.ts")).toContain("obsidian");
    // Dynamic import: adapters/output-adapter.ts does `await import("fs")`.
    expect(importedSpecifiers("adapters/output-adapter.ts")).toContain("fs");
  });

  it("resolves specifiers to modules the way the layout checks below need", () => {
    // The directory-index form is what lets "core/render" keep naming the facade
    // now that it lives in render/index.ts; the plain form is every other import.
    // If the resolver returned null for everything, the cycle check would pass vacuously.
    expect(resolveToModule("core/content/math.ts", "../render")).toBe("core/render/index.ts");
    expect(resolveToModule("core/render/index.ts", "./md")).toBe("core/render/md.ts");
  });
});

describe("the core folder layout", () => {
  it("keeps only types.ts directly in core/, so the flat list cannot regrow", () => {
    const modulesDirectlyInCore = MODULES.filter(
      (m) => m.startsWith(CORE_PREFIX) && !m.slice(CORE_PREFIX.length).includes("/")
    );
    const strayModules = modulesDirectlyInCore.filter((m) => m !== CORE_ROOT_MODULE);

    // Guard first: a wrong path would otherwise leave both lists empty and pass.
    expect(
      modulesDirectlyInCore,
      `${CORE_ROOT_MODULE} is the one module that lives in the core root`
    ).toContain(CORE_ROOT_MODULE);
    expect(
      strayModules,
      "core/ may hold only types.ts directly: move each of these into a concern folder " +
        "(common, render, content, book, epub, delivery)"
    ).toEqual([]);
  });

  it("keeps core/common/ free of imports from the rest of src/", () => {
    const commonModules = MODULES.filter((m) => m.startsWith(COMMON_PREFIX));

    expect(
      commonModules.length,
      "core/common/ has no modules, so this check would pass without checking anything"
    ).toBeGreaterThan(0);

    const offenders = commonModules.flatMap((moduleName) =>
      importedSpecifiers(moduleName)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => `${moduleName} imports ${specifier}`)
    );

    expect(
      offenders,
      "core/common/ must import nothing else from src/ (it is the layer everything may depend on)"
    ).toEqual([]);
  });

  it("has no import cycle among core modules", () => {
    const cycles = findImportCycles(coreImportGraph());

    expect(
      cycles,
      "core/ modules must not import each other in a cycle: break the loop by moving what they " +
        "share into a module both can import"
    ).toEqual([]);
  });
});
