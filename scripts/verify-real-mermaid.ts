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
import { cleanupDom, rasterizeMermaidDiagrams, serializeBody } from "../src/render";
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
// Round 3: the default (real) mermaid rasterizer in src/render.ts also
// touches Image/canvas. Deliberately NOT assigning a global `Image` here:
// Node's own global `URL.createObjectURL` (unlike jsdom's, which has none)
// actually works, and pairing that with jsdom's real `Image` element makes
// it attempt to load the resulting blob: URL — which jsdom's resource
// loader never resolves either way, hanging the script forever (verified:
// it does). Leaving `Image` unassigned makes `new Image()` throw a
// ReferenceError instead, caught by defaultRasterizeSvg's own catch-all —
// same eventual outcome (fall back to inline SVG), but deterministic and
// immediate rather than a hang. The canvas-2d-context gap (no "canvas" npm
// package) is still the conceptually "real" reason a from-scratch Node/jsdom
// environment can't rasterize — this just avoids a second, incidental way
// for the script to get stuck before ever reaching that gap.

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

// tsx emits CJS here, which has no top-level await — the whole per-chapter
// loop (now that it calls the async rasterizeMermaidDiagrams) lives inside
// this function instead of at module scope.
async function main() {
  const builder = new EpubBuilder({ title: "verify-real", author: "verify", language: "th" });
  let foBefore = 0;
  let foAfter = 0;
  let textAfter = 0;
  let pInSpanBefore = 0;
  let pInSpanAfter = 0;
  let svgCount = 0;
  let stylePassCount = 0;
  let styleFailCount = 0;
  let fallbackWarningCount = 0;

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
    // blobs (everything falls back to SVG's default fill). Deliberately runs
    // BEFORE rasterization below, mirroring production order
    // (render-adapter.ts's renderUnitToChapter): rasterizing removes the
    // very ids/styles this check inspects.
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

    // Round 3: rasterize every mermaid diagram this chapter has. Under
    // jsdom this always falls back (see the g.Image comment above) — the
    // point is proving the fallback leaves spec-valid inline SVG behind
    // (epubcheck: 0 errors) and surfaces exactly one warning per chapter
    // that had at least one diagram, not that the PNG pipeline itself runs
    // here (it can't, outside a real browser).
    const { warnings: mermaidWarnings } = await rasterizeMermaidDiagrams(holder, 0);
    fallbackWarningCount += mermaidWarnings.length;

    // Drop <img> references: the images themselves are not re-embedded here, and
    // a dangling href would add noise unrelated to the SVG question under test.
    holder.querySelectorAll("img").forEach((el) => el.remove());
    builder.addChapter(name, serializeBody(holder));
  }

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
  console.log(
    `[mermaid rasterization] chapters that fell back to inline SVG (no Electron canvas here): ${fallbackWarningCount} / ${chapters.length}`
  );
  console.log(`wrote ${out}`);
}

void main();
