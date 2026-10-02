// The module boundary, enforced instead of documented.
//
// This repo's load-bearing architectural rule — pure modules never import
// "obsidian", so vitest can load them directly and the export pipeline stays
// testable without an Obsidian app — used to live only in prose (CLAUDE.md's
// Architecture section, render-adapter.ts's module-split rationale). Prose
// does not fail a build. This test does.
//
// It is a FITNESS FUNCTION, not a snapshot: it asserts the rule in both
// directions, so the adapter list cannot rot. Adding an `obsidian` import to a
// pure module fails, and so does removing the last one from a listed adapter
// (which would mean the list is lying about the code).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(__dirname, "..", "src");

/**
 * The modules allowed to import "obsidian". Every entry has a reason to be
 * here: it needs the app, the vault, the DOM renderer, or a transport.
 */
const OBSIDIAN_ADAPTERS = new Set([
  "bases-adapter.ts", // the app's Bases renderer
  "export-notice.ts", // Notice + the report modal
  "export-pipeline.ts", // drives the vault, the renderer and the book writer
  "http.ts", // requestUrl
  "main.ts", // the plugin itself
  "meta-adapter.ts", // metadata cache, vault reads, cover downloads
  "output-adapter.ts", // Platform + the vault adapter
  "render-adapter.ts", // MarkdownRenderer
  "report-view.ts", // Modal
  "settings.ts", // PluginSettingTab
]);

// Matches `import x from "m"`, `import { x } from "m"`, `import "m"` and the
// multi-line forms. Comment lines are stripped first — this file's own subject
// matter means comments here talk ABOUT `from "obsidian"`, and a naive search
// matches that prose (it did, while this was being written).
const IMPORT_SPECIFIER = /(?:^|\n)\s*import\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;

function sourceWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function importedSpecifiers(fileName: string): string[] {
  const source = sourceWithoutComments(readFileSync(join(SRC_DIR, fileName), "utf8"));
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);
}

const moduleNames = readdirSync(SRC_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("the pure/adapter boundary", () => {
  it("has modules to check (so a broken path cannot make this pass vacuously)", () => {
    expect(moduleNames.length).toBeGreaterThan(20);
    expect(moduleNames).toContain("main.ts");
  });

  it("lets exactly the listed adapters import obsidian, and requires them to", () => {
    const importersOfObsidian = moduleNames.filter((name) => importedSpecifiers(name).includes("obsidian"));

    const undeclaredAdapters = importersOfObsidian.filter((name) => !OBSIDIAN_ADAPTERS.has(name));
    const staleEntries = [...OBSIDIAN_ADAPTERS].filter((name) => !importersOfObsidian.includes(name));

    // Asserted separately so a failure NAMES the file instead of printing two
    // sets. Both directions are checked: an unlisted importer is a new adapter
    // to declare or a pure module that just lost its purity, and a listed
    // module that stopped importing obsidian makes the list a lie.
    expect(
      undeclaredAdapters,
      'these modules import "obsidian" but are not in OBSIDIAN_ADAPTERS: either move the ' +
        "obsidian use behind an adapter, or add the module here deliberately"
    ).toEqual([]);
    expect(
      staleEntries,
      "these modules are listed as adapters but no longer import obsidian: remove them " +
        "from OBSIDIAN_ADAPTERS so the list keeps describing the code"
    ).toEqual([]);
  });

  it("keeps every pure module from reaching into an adapter", () => {
    const pureModules = moduleNames.filter((name) => !OBSIDIAN_ADAPTERS.has(name));
    const leaks: string[] = [];

    for (const name of pureModules) {
      for (const specifier of importedSpecifiers(name)) {
        const target = specifier.startsWith("./") ? `${specifier.slice(2)}.ts` : null;
        if (target && OBSIDIAN_ADAPTERS.has(target)) {
          leaks.push(`${name} imports ${specifier}`);
        }
      }
    }

    expect(leaks, "pure modules must not depend on adapters").toEqual([]);
  });

  it("parses imports the way the modules actually write them", () => {
    // Guards the parser itself: main.ts's obsidian import spans several lines,
    // and the third assertion above is silent if IMPORT_SPECIFIER stops
    // matching multi-line imports.
    expect(importedSpecifiers("main.ts")).toContain("obsidian");
    expect(importedSpecifiers("render.ts")).not.toContain("obsidian");
    expect(importedSpecifiers("render.ts").length).toBe(0);
  });
});
