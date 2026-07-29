// ── Obsidian adapter (exercised via manual smoke tests, not unit tests) ──
//
// Deliberately its own module, NOT appended to src/render.ts, even though the
// brief's Step 5 shows it inline there. Reason: "obsidian" ships type
// declarations only, no runtime JS (node_modules/obsidian/package.json has
// "main": ""). MarkdownRenderer.render(...) and `instanceof TFile` are real
// VALUE usages, not just type positions, so that import can't be elided —
// bundling it into render.ts would make Vite try to eagerly resolve the
// "obsidian" package the moment anything in render.ts is loaded, which
// breaks every pure-function test in tests/render.test.ts (verified: it
// fails with "Failed to resolve entry for package obsidian"). Splitting this
// adapter out mirrors the same fix already applied to settings.ts/
// settings-core.ts (Adjustment B) for the identical reason.
import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import {
  stripFrontmatter,
  stripDynamicBlocks,
  cleanupDom,
  rewriteLinks,
  rewriteImages,
  serializeBody,
} from "./render";

export interface ChapterRender {
  xhtmlBody: string;
  images: { vaultPath: string; newHref: string }[];
  warnings: string[];
}

export async function renderUnitToChapter(
  app: App,
  component: Component,
  markdown: string,
  sourcePath: string,
  hrefByPath: Map<string, string>,
  basePath: string,
  startImageIndex: number
): Promise<ChapterRender> {
  const warnings: string[] = [];
  const md = stripDynamicBlocks(stripFrontmatter(markdown));
  const el = document.createElement("div");
  document.body.appendChild(el);
  try {
    await MarkdownRenderer.render(app, md, el, sourcePath, component);
    cleanupDom(el);
    const resolve = (linkpath: string): string | null => {
      const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      return f instanceof TFile ? f.path : null;
    };
    warnings.push(...rewriteLinks(el, hrefByPath, resolve));
    const images = rewriteImages(el, basePath, startImageIndex);
    return { xhtmlBody: serializeBody(el), images, warnings };
  } finally {
    el.remove();
  }
}
