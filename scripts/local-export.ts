// Local integration harness: runs the REAL src/main.ts orchestrator
// (exportSingle / exportFolder / exportLinked) against a real vault on disk,
// with no Obsidian installation involved.
//
// "obsidian" ships type declarations only (no runtime JS), so vitest can
// never import src/main.ts directly. This script bundles src/main.ts with
// esbuild (marking "obsidian" external) and, at runtime, redirects the
// bundle's `require("obsidian")` to the exact same tests/fixtures/
// obsidian-stub.ts instance this script itself loads via tsx — see
// installObsidianRequireShim below for why a naive alias/inline approach
// doesn't work. The bundle then runs under Node with a jsdom global DOM
// (src/render.ts / src/render-adapter.ts need a working document).
// tests/fixtures/vault-stub.ts supplies the `app` object, backed by real
// files under the vault root.
//
// Usage: tsx scripts/local-export.ts <note|folder|linked> <vault-relative-path>

import { mkdirSync, readFileSync, rmSync, statSync } from "fs";
import * as path from "path";
import * as os from "os";
import Module from "module";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import JSZip from "jszip";
import { DEFAULT_SETTINGS } from "../src/settings-core";

// Defaults to the author's vault location without hardcoding a machine-specific
// absolute path; override with VAULT_ROOT=/path/to/vault.
const VAULT_ROOT = process.env.VAULT_ROOT ?? path.join(os.homedir(), "Documents", "pan_vault");
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "local-out");
const BUNDLE_PATH = path.join(REPO_ROOT, ".local-export-bundle.cjs");

type Mode = "note" | "folder" | "linked";

function usageError(msg: string): never {
  console.error(msg);
  console.error("Usage: tsx scripts/local-export.ts <note|folder|linked> <vault-relative-path>");
  process.exit(1);
}

async function installJsdomGlobals(): Promise<void> {
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
  g.customElements = dom.window.customElements;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
}

async function buildBundle(): Promise<void> {
  // "obsidian" is marked external (NOT aliased/inlined) so the bundle keeps
  // a literal `require("obsidian")` at runtime. If we instead aliased it to
  // tests/fixtures/obsidian-stub.ts via an esbuild onResolve plugin, esbuild
  // would inline a *fresh, separately-transpiled copy* of that module into
  // the bundle — a different TFile/TFolder/Notice class identity than the
  // one tsx loads when this script itself imports obsidian-stub.ts/
  // vault-stub.ts directly. That would break every `instanceof TFile` check
  // inside main.ts (folder-listing, link resolution) against objects the
  // harness's vault-stub actually constructs, and would give the bundle its
  // own separate NOTICES array the harness could never observe.
  //
  // Instead, the runtime `require("obsidian")` is redirected (see
  // installObsidianRequireShim below) to the exact same module instance tsx
  // already loaded for this script — true singleton sharing across the
  // CJS/ESM boundary.
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, "src/main.ts")],
    outfile: BUNDLE_PATH,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2020",
    external: ["obsidian", "electron"],
    // Same alias as esbuild.config.mjs: route JSZip's `setimmediate` and
    // `lie`'s `immediate` to the local shims so this harness bundle exercises
    // the exact same async paths as the real shipped build (main.js), not
    // the real polyfills' IE-era <script>/new Function fallbacks.
    alias: {
      immediate: path.join(REPO_ROOT, "shims/immediate.cjs"),
      setimmediate: path.join(REPO_ROOT, "shims/setimmediate.cjs"),
    },
    logLevel: "warning",
  });
}

// Makes require("obsidian") — as called from inside the esbuild bundle above
// — resolve to the SAME module instance this script gets from
// `import(".../obsidian-stub.ts")` (tsx-transpiled, ESM). We inject a fake
// entry directly into Node's CJS require cache so no re-loading/re-transpiling
// ever happens; the bundle's `require("obsidian")` call just returns the
// identical exports object, giving true class identity across the ESM (tsx)
// / CJS (esbuild bundle) boundary.
function installObsidianRequireShim(stubNamespace: Record<string, unknown>): void {
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

interface ZipInventory {
  entries: string[];
  manifestHrefs: string[];
  missingFromZip: string[];
  missingFromManifest: string[];
  invariantPass: boolean;
}

async function inspectEpub(epubPath: string): Promise<ZipInventory> {
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

interface ChapterImageStats {
  file: string;
  title: string;
  totalImg: number;
  rewritten: number; // src starts with ../images/
  other: number;
  otherSrcs: string[];
}

async function perChapterImageStats(epubPath: string): Promise<ChapterImageStats[]> {
  const bytes = readFileSync(epubPath);
  const zip = await JSZip.loadAsync(bytes);
  const chapterNames = Object.keys(zip.files)
    .filter((n) => /^OEBPS\/text\/chapter_\d+\.xhtml$/.test(n))
    .sort();

  const stats: ChapterImageStats[] = [];
  for (const name of chapterNames) {
    const text = await zip.file(name)!.async("string");
    const titleMatch = /<title>([^<]*)<\/title>/.exec(text);
    const imgSrcs = [...text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    const rewritten = imgSrcs.filter((s) => s.startsWith("../images/"));
    const other = imgSrcs.filter((s) => !s.startsWith("../images/"));
    stats.push({
      file: name,
      title: titleMatch ? titleMatch[1] : "(untitled)",
      totalImg: imgSrcs.length,
      rewritten: rewritten.length,
      other: other.length,
      otherSrcs: other,
    });
  }
  return stats;
}

interface DanglingImageInvariant {
  totalChecked: number;
  missing: string[]; // "../images/X" srcs whose OEBPS/images/X target isn't in the zip
  pass: boolean;
}

// The manifest↔zip invariant (inspectEpub) and the "rewritten" count
// (perChapterImageStats) both only look at what's *referenced* — an <img>
// pointing at a file present in NEITHER the manifest nor the zip passes both
// checks silently. This invariant instead resolves every "../images/X" src to
// its actual zip entry and asserts it exists, so a build that embedded
// nothing can no longer report a clean bill of health.
async function checkDanglingImages(epubPath: string): Promise<DanglingImageInvariant> {
  const bytes = readFileSync(epubPath);
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  const chapterNames = Object.keys(zip.files)
    .filter((n) => /^OEBPS\/text\/chapter_\d+\.xhtml$/.test(n))
    .sort();

  const missing: string[] = [];
  let totalChecked = 0;
  for (const name of chapterNames) {
    const text = await zip.file(name)!.async("string");
    const imgSrcs = [...text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    for (const src of imgSrcs) {
      if (!src.startsWith("../images/")) continue;
      totalChecked++;
      const target = `OEBPS/images/${src.slice("../images/".length)}`;
      if (!entries.has(target)) missing.push(src);
    }
  }
  return { totalChecked, missing, pass: missing.length === 0 };
}

async function main(): Promise<void> {
  const [, , modeArg, targetRel] = process.argv;
  if (!modeArg || !targetRel) usageError("Missing arguments.");
  if (modeArg !== "note" && modeArg !== "folder" && modeArg !== "linked") {
    usageError(`Invalid mode "${modeArg}".`);
  }
  const mode = modeArg as Mode;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  await installJsdomGlobals();

  // Load the stub and the vault-stub through tsx's normal ESM loader FIRST,
  // so there is exactly one instance of each in the process. vault-stub.ts's
  // own `import ... from "./obsidian-stub"` resolves to this same cached
  // instance (Node/tsx dedup ESM modules by resolved URL) — that's what
  // gives the harness's TFile/TFolder objects the identical class the
  // esbuild bundle will check `instanceof` against, once shimmed below.
  const obsidianStubNs = (await import(path.join(REPO_ROOT, "tests/fixtures/obsidian-stub.ts"))) as Record<
    string,
    unknown
  >;
  const { createVaultStub } = (await import(path.join(REPO_ROOT, "tests/fixtures/vault-stub.ts"))) as {
    createVaultStub: (
      vaultRoot: string,
      scanRoot: string
    ) => {
      app: unknown;
      setActiveFile: (f: unknown) => void;
    };
  };
  const NOTICES = obsidianStubNs.NOTICES as string[];

  installObsidianRequireShim(obsidianStubNs);
  await buildBundle();

  const require = Module.createRequire(import.meta.url);
  const mod = require(BUNDLE_PATH) as { default?: unknown };
  const PluginClass = (mod.default ?? mod) as new (
    app: unknown,
    manifest: unknown
  ) => {
    settings: unknown;
    exportSingle(f: unknown): Promise<void>;
    exportFolder(f: unknown): Promise<void>;
    exportLinked(f: unknown): Promise<void>;
  };

  const normalizedTarget = targetRel.replace(/^\/+/, "").replace(/\/+$/, "");
  const scanRoot = mode === "folder" ? normalizedTarget : path.dirname(normalizedTarget);

  const { app, setActiveFile } = createVaultStub(VAULT_ROOT, scanRoot);

  const targetNode = (
    app as { vault: { getAbstractFileByPath(p: string): unknown } }
  ).vault.getAbstractFileByPath(normalizedTarget);
  if (!targetNode) {
    console.error(`Not found in vault: "${normalizedTarget}" (resolved under ${VAULT_ROOT})`);
    process.exit(1);
  }

  const manifest = {
    id: "inkbound",
    name: "Inkbound",
    version: "0.1.0",
    minAppVersion: "1.5.0",
    description: "harness run",
    author: "Pan",
    isDesktopOnly: true,
  };
  const plugin = new PluginClass(app, manifest);
  // Spread DEFAULT_SETTINGS so a new setting added in settings-core.ts is
  // picked up here automatically (this harness used to hand-list every
  // field, silently dropping any setting added after the last edit —
  // tocHeadingDepth was undefined until it spread the defaults).
  plugin.settings = {
    ...DEFAULT_SETTINGS,
    outputFolder: OUTPUT_DIR,
    linkDepth: 1,
    language: "th",
    fallbackAuthor: "Pan",
    booxUrl: "",
    pushAfterExport: false,
  };

  const warnLines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnLines.push(args.map((a) => String(a)).join(" "));
    originalWarn(...args);
  };

  console.log(`\n=== local-export: mode=${mode} target="${normalizedTarget}" scanRoot="${scanRoot}" ===\n`);

  try {
    if (mode === "note") {
      await plugin.exportSingle(targetNode);
    } else if (mode === "folder") {
      await plugin.exportFolder(targetNode);
    } else {
      setActiveFile(targetNode as never);
      await plugin.exportLinked(targetNode);
    }
  } finally {
    console.warn = originalWarn;
  }

  console.log("--- Notices captured ---");
  for (const n of NOTICES as string[]) console.log(`  [Notice] ${n}`);

  console.log("\n--- console.warn lines emitted by the plugin ---");
  if (warnLines.length === 0) console.log("  (none)");
  for (const w of warnLines) console.log(`  [warn] ${w}`);

  const savedNotice = (NOTICES as string[])
    .slice()
    .reverse()
    .find((n) => n.startsWith("EPUB saved to "));
  if (!savedNotice) {
    console.log("\n--- FAILED: no 'EPUB saved to' notice found ---");
    process.exitCode = 1;
    return;
  }
  const afterPrefix = savedNotice.slice("EPUB saved to ".length);
  const outPath = afterPrefix.split("\n")[0].split(" and pushed to Boox")[0].trim();

  const size = statSync(outPath).size;
  console.log(`\n--- Output ---`);
  console.log(`  path: ${outPath}`);
  console.log(`  size: ${size} bytes`);

  const inv = await inspectEpub(outPath);
  console.log("\n--- ZIP inventory ---");
  for (const e of inv.entries) console.log(`  ${e}`);
  console.log("\n--- Manifest hrefs (OEBPS/package.opf) ---");
  for (const h of inv.manifestHrefs) console.log(`  ${h}`);
  console.log(
    `\n--- Manifest/zip invariant: ${inv.invariantPass ? "PASS" : "FAIL"} ---` +
      (inv.invariantPass
        ? ""
        : `\n  missing from zip: ${JSON.stringify(inv.missingFromZip)}\n  missing from manifest: ${JSON.stringify(inv.missingFromManifest)}`)
  );

  const chapterStats = await perChapterImageStats(outPath);
  console.log("\n--- Per-chapter image stats ---");
  for (const c of chapterStats) {
    console.log(
      `  ${c.file} [${c.title}] — <img> total=${c.totalImg} rewritten(../images/)=${c.rewritten} other/dangling=${c.other}` +
        (c.other > 0 ? ` e.g. ${JSON.stringify(c.otherSrcs.slice(0, 3))}` : "")
    );
  }

  const totalImg = chapterStats.reduce((a, c) => a + c.totalImg, 0);
  const totalRewritten = chapterStats.reduce((a, c) => a + c.rewritten, 0);
  const totalOther = chapterStats.reduce((a, c) => a + c.other, 0);
  console.log(
    `\n--- Totals: <img> total=${totalImg} rewritten=${totalRewritten} other/dangling=${totalOther} ---`
  );

  const dangling = await checkDanglingImages(outPath);
  console.log(
    `\n--- Dangling-image invariant (every ../images/X actually present in the zip): ${dangling.pass ? "PASS" : "FAIL"} (checked ${dangling.totalChecked}) ---` +
      (dangling.pass ? "" : `\n  offending srcs: ${JSON.stringify(dangling.missing)}`)
  );

  const hasBadWarning = warnLines.some(
    (w) => w.includes("missing image:") || w.includes("unsupported image type:")
  );
  if (!dangling.pass || hasBadWarning) {
    process.exitCode = 1;
  }

  // Clean up the gitignored temp bundle; local-out/ is left for inspection.
  try {
    rmSync(BUNDLE_PATH);
  } catch {
    // ignore
  }
}

main().catch((e) => {
  console.error("local-export failed:", e);
  process.exit(1);
});
