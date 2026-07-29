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

const builder = new EpubBuilder({ title: "verify-real", author: "verify", language: "th" });
let foBefore = 0;
let foAfter = 0;
let textAfter = 0;
let pInSpanBefore = 0;
let pInSpanAfter = 0;
let svgCount = 0;

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
  console.log(`wrote ${out}`);
}

void main();
