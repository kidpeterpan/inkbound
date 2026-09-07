// Shipped-bundle export gate.
//
// THE GAP THIS CLOSES: every other check runs something OTHER than the file
// users install. vitest imports src/*.ts; `npm run local-export` re-bundles
// src/main.ts with its own esbuild options; `check-mobile-safe` evaluates
// main.js but only its module top level; `check-review-safe` greps it. None of
// them ever asks main.js to export a book. So a build-time transform that only
// exists in esbuild.config.mjs — the MathJax source rewrite (mathjax-review-
// hygiene), the base64 font inlining, the shim aliases, the dynamic-import
// lowering — can break an export while every gate stays green. 1.7.0 and 1.7.1
// both shipped with desktop export completely broken.
//
// WHAT IT DOES: loads the built main.js exactly as Obsidian would (CommonJS
// `require`, `obsidian` supplied from outside), points it at the fixture vault
// in tests/fixtures/smoke-vault, runs a folder export through the real
// orchestrator, and asserts the resulting EPUB is a book: correct container
// files, both chapters, the embedded image, the Thai fonts, typeset math, and a
// wikilink rewritten to its sibling chapter.
//
// WHAT IT DOES NOT PROVE: Node resolves a native `import("os")` happily, so
// the exact 1.7.0 failure ("Failed to resolve module specifier") does NOT
// reproduce here (verified: a bundle built without `supported: { "dynamic-
// import": false }` passes this gate) — check-mobile-safe's check 1b covers
// that by scanning the bundle. Rendering still goes through the marked-based stub, not Obsidian's
// MarkdownRenderer. This gate proves the shipped artifact can run its export
// pipeline end to end; it is not a substitute for the manual check in real
// Obsidian (docs/DEVELOPMENT.md, "Testing and its limits").
//
// Usage: tsx scripts/check-export-works.ts   (after `npm run build`)

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { DEFAULT_SETTINGS } from "../src/settings-core";
import {
  REPO_ROOT,
  inspectEpub,
  installJsdomGlobals,
  installObsidianRequireShim,
  loadPluginClass,
  savedPathFromNotices,
} from "./lib/harness";

const BUNDLE = path.join(REPO_ROOT, "main.js");
const VAULT_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "smoke-vault");
const BOOK_FOLDER = "Book";

function fail(message: string, details: string[] = []): never {
  console.error(`check-export-works: FAIL — ${message}`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) {
    console.error("check-export-works: main.js not found — run `npm run build` first.");
    process.exit(2);
  }

  installJsdomGlobals();

  // Load the stub through tsx FIRST so there is exactly one instance in the
  // process, then make the bundle's require("obsidian") return that instance.
  // See installObsidianRequireShim for why this order and this mechanism.
  const obsidianStubNs = (await import(path.join(REPO_ROOT, "tests/fixtures/obsidian-stub.ts"))) as Record<
    string,
    unknown
  >;
  const { createVaultStub } = (await import(path.join(REPO_ROOT, "tests/fixtures/vault-stub.ts"))) as {
    createVaultStub: (vaultRoot: string, scanRoot: string) => { app: unknown };
  };
  const NOTICES = obsidianStubNs.NOTICES as string[];
  installObsidianRequireShim(obsidianStubNs);

  // THE shipped bundle. Not a rebuild, not src/ — the file `npm run build`
  // produced and a release would publish. A throw here is the gate's most
  // likely real catch (a build-time transform left the bundle inconsistent —
  // e.g. the MathJax rename in esbuild.config.mjs), so it gets its own message
  // rather than being reported as a harness bug.
  let PluginClass: ReturnType<typeof loadPluginClass>;
  try {
    PluginClass = loadPluginClass(BUNDLE);
  } catch (e) {
    fail("the shipped main.js threw while loading (before any export ran).", [
      e instanceof Error ? (e.stack ?? e.message) : String(e),
      "This is usually a build-time transform in esbuild.config.mjs leaving the",
      "bundle inconsistent — nothing in src/ or vitest can see it.",
    ]);
  }

  const outDir = mkdtempSync(path.join(os.tmpdir(), "inkbound-check-export-"));
  const errors: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    const { app } = createVaultStub(VAULT_ROOT, BOOK_FOLDER);
    const folder = (
      app as { vault: { getAbstractFileByPath(p: string): unknown } }
    ).vault.getAbstractFileByPath(BOOK_FOLDER);
    if (!folder) fail(`fixture folder "${BOOK_FOLDER}" not found under ${VAULT_ROOT}`);

    const plugin = new PluginClass(app, {
      id: "inkbound",
      name: "Inkbound",
      version: "0.0.0-check",
      minAppVersion: "1.5.0",
      description: "check-export-works",
      author: "ci",
      isDesktopOnly: false,
    });
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      outputFolder: outDir,
      booxUrl: "",
      pushAfterExport: false,
    };

    // The orchestrator reports failures through console.error + a Notice
    // rather than throwing (an export must never crash Obsidian), so capture
    // both. Warnings are allowed — an omitted embed is a degraded book, not a
    // broken one — but they are printed so a new one is visible in CI logs.
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" "));
    };
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    await plugin.exportFolder(folder);

    console.error = originalError;
    console.warn = originalWarn;

    for (const w of warnings) console.log(`  [warn] ${w}`);

    const failureNotice = NOTICES.find((n) => n.startsWith("EPUB export failed"));
    if (failureNotice || errors.length > 0) {
      fail("the shipped bundle could not complete an export.", [
        ...(failureNotice ? [`notice: ${failureNotice}`] : []),
        ...errors,
      ]);
    }
    const epubPath = savedPathFromNotices(NOTICES);
    if (!epubPath)
      fail(
        "no 'EPUB saved to' notice was shown.",
        NOTICES.map((n) => `notice: ${n}`)
      );
    if (!existsSync(epubPath)) fail(`the completion notice names a file that does not exist: ${epubPath}`);

    const problems = await checkBook(epubPath);
    if (problems.length > 0) fail(`the exported EPUB is not a usable book (${epubPath}).`, problems);

    console.log(
      "check-export-works: PASS — the shipped main.js exported the fixture book end to end " +
        "(3 chapters incl. a nested Part, image, Thai fonts, typeset math, rewritten wikilink)."
    );
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Every assertion is about what a reader would notice missing. Returns a list
// so one run reports every problem rather than the first.
async function checkBook(epubPath: string): Promise<string[]> {
  const problems: string[] = [];
  const zip = await JSZip.loadAsync(readFileSync(epubPath));
  const entries = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  const text = async (name: string): Promise<string> => (await zip.file(name)?.async("string")) ?? "";

  // EPUB container skeleton.
  for (const required of [
    "mimetype",
    "META-INF/container.xml",
    "OEBPS/package.opf",
    "OEBPS/nav.xhtml",
    "OEBPS/text/chapter_001.xhtml",
    "OEBPS/text/chapter_002.xhtml",
  ]) {
    if (!entries.has(required)) problems.push(`missing zip entry: ${required}`);
  }
  if (!problems.length && (await text("mimetype")) !== "application/epub+zip") {
    problems.push("mimetype entry does not read application/epub+zip");
  }

  // Manifest and zip agree (nothing declared but absent, nothing shipped but undeclared).
  const inv = await inspectEpub(epubPath);
  if (!inv.invariantPass) {
    problems.push(
      `manifest/zip mismatch — missing from zip: ${JSON.stringify(inv.missingFromZip)}, ` +
        `missing from manifest: ${JSON.stringify(inv.missingFromManifest)}`
    );
  }

  // Metadata came from the first note's frontmatter.
  const opf = await text("OEBPS/package.opf");
  if (!opf.includes("Smoke Book")) problems.push("package.opf does not carry the frontmatter title");
  if (!opf.includes("Inkbound CI")) problems.push("package.opf does not carry the frontmatter author");

  // Chapter 1: the embedded image resolved to real bytes in the zip, and the
  // wikilink to chapter 2 became a sibling href.
  const ch1 = await text("OEBPS/text/chapter_001.xhtml");
  const imgSrcs = [...ch1.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const embedded = imgSrcs.filter((s) => s.startsWith("../images/"));
  if (embedded.length === 0) problems.push("chapter 1 has no <img> rewritten to ../images/");
  for (const src of embedded) {
    const entry = `OEBPS/images/${src.slice("../images/".length)}`;
    if (!entries.has(entry)) problems.push(`chapter 1 references ${src} but ${entry} is not in the zip`);
  }
  if (!/href="chapter_002\.xhtml(#[^"]*)?"/.test(ch1)) {
    problems.push("chapter 1's wikilink to the second note was not rewritten to chapter_002.xhtml");
  }
  if (!ch1.includes("<pre>") && !ch1.includes("<code")) problems.push("chapter 1 lost its code block");

  // Chapter 2: math was typeset (the mathjax-review-hygiene rewrite in
  // esbuild.config.mjs runs ONLY in this bundle — this is the one place it is
  // exercised) and no placeholder leaked into the book.
  const ch2 = await text("OEBPS/text/chapter_002.xhtml");
  if (!ch2.includes("<svg") && !/<img\b[^>]*math/.test(ch2)) {
    problems.push("chapter 2 contains no typeset math (no <svg> or math image)");
  }
  if (ch2.includes("data-inkbound-math")) problems.push("chapter 2 leaked a raw math placeholder");
  if (/\$E = mc\^2\$/.test(ch2)) problems.push("chapter 2 still contains the raw TeX source");

  // Nested Parts (009-index-order-parts): the fixture's `Part Two/` subfolder
  // must appear in nav.xhtml as a Part entry with its chapter nested beneath
  // it — one <li>, one <a>, one <ol> — and its chapter must be in the spine.
  const nav = await text("OEBPS/nav.xhtml");
  if (!entries.has("OEBPS/text/chapter_003.xhtml"))
    problems.push("missing zip entry: OEBPS/text/chapter_003.xhtml (subfolder note)");
  const partLi = nav.indexOf('<li><a href="text/chapter_003.xhtml">Part Two</a><ol>');
  if (partLi === -1) problems.push("nav.xhtml has no Part entry for the Part Two subfolder");
  else if (nav.indexOf('<li><a href="text/chapter_003.xhtml">Deep</a></li>', partLi) === -1) {
    problems.push("nav.xhtml does not nest the subfolder's chapter under its Part entry");
  }

  // Thai text in the fixture + embedThaiFont default ON → both fonts shipped
  // (proves the base64-inlined TTFs decode through the shipped bundle).
  const fonts = [...entries].filter((e) => /^OEBPS\/fonts\/.*\.ttf$/.test(e));
  if (fonts.length < 2) problems.push(`expected 2 embedded Thai font files, found ${fonts.length}`);
  for (const f of fonts) {
    const bytes = await zip.file(f)!.async("uint8array");
    // A real TrueType file starts with the 0x00010000 sfnt tag.
    if (bytes.length < 1000 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) {
      problems.push(`${f} is not a TrueType font (${bytes.length} bytes)`);
    }
  }

  return problems;
}

main().catch((e) => {
  console.error("check-export-works: FAIL — harness threw before the export could be judged.");
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
