// Shared plumbing for the two harnesses that run the REAL orchestrator outside
// Obsidian: scripts/local-export.ts (a rebuilt bundle against a real vault)
// and scripts/check-export-works.ts (the SHIPPED main.js against a fixture
// vault, as a CI gate). Both need the same three things — a jsdom global DOM,
// a `require("obsidian")` that resolves to the one stub instance the harness
// itself loaded, and a way to inventory the EPUB zip they produce — and the
// require shim in particular has a subtle identity invariant (below) that
// must not be allowed to drift between two copies.

import { readFileSync } from "fs";
import * as path from "path";
import Module from "module";
import { JSDOM } from "jsdom";
import JSZip from "jszip";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export function installJsdomGlobals(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const g = globalThis as Record<string, unknown>;
  const defineGlobal = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  g.window = dom.window as unknown;
  g.document = dom.window.document;
  defineGlobal("navigator", dom.window.navigator);
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Text = dom.window.Text;
  g.DocumentFragment = dom.window.DocumentFragment;
  g.XMLSerializer = dom.window.XMLSerializer;
  // 005-latex-math: math.ts's svgStringToElement parses MathJax SVG strings
  // via DOMParser + instanceof SVGSVGElement — browser globals the harness
  // must install by hand for that path to run here too.
  defineGlobal("DOMParser", dom.window.DOMParser);
  defineGlobal("SVGSVGElement", dom.window.SVGSVGElement);
  g.customElements = dom.window.customElements;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
}

// Makes require("obsidian") — as called from inside an esbuild CJS bundle —
// resolve to the SAME module instance the harness gets from
// `import(".../obsidian-stub.ts")` (tsx-transpiled, ESM). We inject a fake
// entry directly into Node's CJS require cache so no re-loading/re-transpiling
// ever happens; the bundle's `require("obsidian")` call just returns the
// identical exports object, giving true class identity across the ESM (tsx)
// / CJS (esbuild bundle) boundary.
//
// Why identity matters: the harness constructs TFile/TFolder objects via
// tests/fixtures/vault-stub.ts, and main.ts checks `instanceof TFile` against
// them. A second, separately-loaded copy of the stub would make every such
// check false and give the bundle its own NOTICES array the harness could
// never observe.
export function installObsidianRequireShim(stubNamespace: Record<string, unknown>): void {
  const virtualPath = path.join(REPO_ROOT, "__virtual_obsidian_module__.js");
  const fakeModule = new Module(virtualPath, undefined);
  fakeModule.filename = virtualPath;
  fakeModule.loaded = true;
  fakeModule.exports = { ...stubNamespace };
  (Module as unknown as { _cache: Record<string, unknown> })._cache[virtualPath] = fakeModule;

  type ResolveFilename = (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
  const originalResolveFilename = (Module as unknown as { _resolveFilename: ResolveFilename })
    ._resolveFilename;
  (Module as unknown as { _resolveFilename: ResolveFilename })._resolveFilename = function (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown
  ) {
    if (request === "obsidian") return virtualPath;
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

// The shape of the plugin class as both harnesses drive it. main.ts's default
// export is the real class; only the members the harnesses touch are typed.
export interface HarnessPlugin {
  settings: unknown;
  exportSingle(f: unknown): Promise<void>;
  exportFolder(f: unknown): Promise<void>;
  exportLinked(f: unknown): Promise<void>;
}

export type HarnessPluginClass = new (app: unknown, manifest: unknown) => HarnessPlugin;

export function loadPluginClass(bundlePath: string): HarnessPluginClass {
  const require = Module.createRequire(__filename);
  const mod = require(bundlePath) as { default?: unknown };
  return (mod.default ?? mod) as HarnessPluginClass;
}

// Both harnesses find the finished book the same way the user does: from the
// completion notice. Returns null when no export completed.
export function savedPathFromNotices(notices: readonly string[]): string | null {
  const savedNotice = notices
    .slice()
    .reverse()
    .find((n) => n.startsWith("EPUB saved to "));
  if (!savedNotice) return null;
  const afterPrefix = savedNotice.slice("EPUB saved to ".length);
  return afterPrefix.split("\n")[0].split(" and pushed to Boox")[0].split(" — saved locally")[0].trim();
}

export interface ZipInventory {
  entries: string[];
  manifestHrefs: string[];
  missingFromZip: string[];
  missingFromManifest: string[];
  invariantPass: boolean;
}

export async function inspectEpub(epubPath: string): Promise<ZipInventory> {
  const bytes = readFileSync(epubPath);
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  const opfFile = zip.file("OEBPS/package.opf");
  const opfText = opfFile ? await opfFile.async("string") : "";
  const manifestHrefs = [...opfText.matchAll(/<item\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  const manifestZipPaths = new Set(manifestHrefs.map((h) => `OEBPS/${h}`));

  const contentEntries = entries.filter((e) => e.startsWith("OEBPS/") && e !== "OEBPS/package.opf");
  const missingFromZip = manifestHrefs.filter((h) => !entries.includes(`OEBPS/${h}`));
  const missingFromManifest = contentEntries.filter((e) => !manifestZipPaths.has(e));

  return {
    entries,
    manifestHrefs,
    missingFromZip,
    missingFromManifest,
    invariantPass: missingFromZip.length === 0 && missingFromManifest.length === 0,
  };
}
