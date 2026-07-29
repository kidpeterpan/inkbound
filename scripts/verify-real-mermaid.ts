// Independent verification of the mermaid fix against a REAL Obsidian export.
//
// Usage: tsx scripts/verify-real-mermaid.ts <dir-of-unzipped-epub>
//
// Takes the chapter bodies out of an EPUB that real Obsidian produced, re-runs
// them through the current pipeline, rebuilds an EPUB and writes it so epubcheck
// can judge it. This exercises every real mermaid diagram in the book rather
// than a single hand-picked fixture, which is the only way to know the fix holds
// at scale. Not part of the test suite: it needs a real export as input.
import { readFileSync, writeFileSync, readdirSync } from "fs";
import * as path from "path";
import { JSDOM } from "jsdom";
import { cleanupDom, serializeBody } from "../src/render";
import { EpubBuilder } from "../src/epub";

const extractDir = process.argv[2];
if (!extractDir) {
  console.error("usage: tsx scripts/verify-real-mermaid.ts <dir-of-unzipped-epub>");
  process.exit(1);
}

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.Node = dom.window.Node;
g.XMLSerializer = dom.window.XMLSerializer;
g.HTMLElement = dom.window.HTMLElement;

const textDir = path.join(extractDir, "OEBPS", "text");
const chapters = readdirSync(textDir)
  .filter((f) => f.startsWith("chapter_"))
  .sort();

// Extracts every "#some-id" ID-selector token that appears in the SELECTOR
// part of a CSS rule (i.e. before its "{"), ignoring anything inside the
// declaration body so color values like "fill:#333;" are never mistaken for
// selectors.
function extractSelectorIds(cssText: string): string[] {
  const ids: string[] = [];
  for (const rule of cssText.split("}")) {
    const openIdx = rule.indexOf("{");
    if (openIdx === -1) continue;
    const selectorPart = rule.slice(0, openIdx);
    const idMatches = selectorPart.match(/#[A-Za-z_][\w-]*/g) ?? [];
    for (const m of idMatches) ids.push(m.slice(1));
  }
  return ids;
}

// Also treats url(#some-id) occurrences anywhere in the style text (selector
// or declaration) as a reference that must resolve, since a broken url(#...)
// reference (e.g. a marker fill) is exactly the same class of bug.
function extractUrlRefIds(cssText: string): string[] {
  return Array.from(cssText.matchAll(/url\(#([A-Za-z_][\w-]*)\)/g)).map((m) => m[1]);
}

const builder = new EpubBuilder({ title: "verify-real", author: "verify", language: "th" });
let foBefore = 0;
let foAfter = 0;
let textAfter = 0;
let pInSpanBefore = 0;
let pInSpanAfter = 0;
let svgCount = 0;
let stylePassCount = 0;
let styleFailCount = 0;

for (const name of chapters) {
  const raw = readFileSync(path.join(textDir, name), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(raw);
  if (!body) continue;
  const holder = dom.window.document.createElement("div");
  holder.innerHTML = body[1];
  foBefore += holder.querySelectorAll("foreignObject").length;
  pInSpanBefore += holder.querySelectorAll("span p").length;
  svgCount += holder.querySelectorAll("svg").length;
  cleanupDom(holder);
  foAfter += holder.querySelectorAll("foreignObject").length;
  pInSpanAfter += holder.querySelectorAll("span p").length;
  textAfter += holder.querySelectorAll("text").length;

  // Style-scoping check: every #id token referenced by this chapter's
  // <style> blocks (as a selector, or via url(#id)) must resolve to an id
  // that actually exists in this chapter's post-cleanup markup. If the
  // style-rewrite step regresses (or is bypassed), mermaid's stylesheet
  // keeps targeting pre-prefix ids that no longer exist anywhere in the
  // chapter, every rule stops matching, and diagrams render as solid black
  // blobs (everything falls back to SVG's default fill).
  const idsInChapter = new Set(
    Array.from(holder.querySelectorAll("[id]")).map((el) => el.getAttribute("id"))
  );
  const unresolved: string[] = [];
  holder.querySelectorAll("style").forEach((style) => {
    const cssText = style.textContent ?? "";
    const referenced = [...extractSelectorIds(cssText), ...extractUrlRefIds(cssText)];
    for (const id of referenced) {
      if (!idsInChapter.has(id)) unresolved.push(id);
    }
  });
  const status = unresolved.length === 0 ? "PASS" : "FAIL";
  if (status === "PASS") stylePassCount++;
  else styleFailCount++;
  const uniqueUnresolved = Array.from(new Set(unresolved));
  const detail = uniqueUnresolved.length
    ? ` (unresolved: ${uniqueUnresolved.slice(0, 5).join(", ")}${uniqueUnresolved.length > 5 ? ", ..." : ""})`
    : "";
  console.log(`[style-scoping] ${status} ${name}${detail}`);

  // Drop <img> references: the images themselves are not re-embedded here, and
  // a dangling href would add noise unrelated to the SVG question under test.
  holder.querySelectorAll("img").forEach((el) => el.remove());
  builder.addChapter(name, serializeBody(holder));
}

// tsx emits CJS here, which has no top-level await.
async function main() {
  const out = "/tmp/verify-real-mermaid.epub";
  writeFileSync(out, Buffer.from(await builder.build()));

  console.log(`chapters processed:                ${chapters.length}`);
  console.log(`inline <svg> diagrams seen:        ${svgCount}`);
  console.log(`foreignObject before -> after:     ${foBefore} -> ${foAfter}`);
  console.log(`<p> inside <span> before -> after: ${pInSpanBefore} -> ${pInSpanAfter}`);
  console.log(`<text> elements after:             ${textAfter}`);
  console.log(
    `[style-scoping] TOTAL: ${stylePassCount} PASS, ${styleFailCount} FAIL (of ${chapters.length} chapters)`
  );
  console.log(`wrote ${out}`);
}

void main();
