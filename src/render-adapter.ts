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
  splitEmbedTarget,
  isImageEmbedSrc,
  rewriteLinks,
  rewriteImages,
  rasterizeMermaidDiagrams,
  serializeBody,
  EMBED_RENDERED_ATTR,
  EMBED_WRAPPER_CLASS,
} from "./render";

// ── Note-embed content population (spec.md FR-001..FR-006) ────────────────
//
// Real Obsidian's MarkdownRenderer.render() synchronously emits a
// `.internal-embed` wrapper for each `![[note]]` embed, carrying the exact
// linktext on its `src` attribute, and MAY populate the wrapper's
// `.markdown-embed-content` div asynchronously on its own schedule — a race
// this pipeline must not depend on either way (see render.ts's "Note-embed
// hardening" comment for how this was confirmed live). So this function
// renders its OWN copy of each embedded note into a private child div
// stamped with EMBED_RENDERED_ATTR; flattenEmbeds later replaces the whole
// wrapper with that div's children, discarding whatever Obsidian's async
// loader did or didn't produce in the meantime. The wrapper's `src`
// attribute is the authoritative "which note is this" handle — the actual
// linkpath the user wrote (alias excluded), heading/block suffix included —
// so no positional pairing against the raw markdown is needed.
//
// Heading/block-scoped embeds (`![[Note#Heading]]`, `![[Note^block]]`) are a
// deliberate scope cut (spec.md Assumptions): populating only a scoped
// SECTION of a note requires this plugin to parse and extract that section
// itself, which is real additional work with its own edge cases. Rather than
// guess at it, those targets are left unrendered (data-embed-reason
// "unsupported-scope") and degrade to the existing placeholder, same as a
// genuinely broken link. Embeds of non-markdown files (e.g. `![[doc.pdf]]`)
// likewise degrade ("unsupported-type") rather than dumping binary content.
//
// Recursion + cycle safety: `visited` is the set of note paths already
// expanded along THIS embed chain (not global) — reusing it structurally
// GUARANTEES termination (a cycle can revisit a path at most once before
// being skipped), which is a stronger guarantee than the previous "trust
// Obsidian's own async loading to terminate" (Clarifications Q1) — that
// clarification is now moot, since this plugin drives the recursion itself
// rather than waiting on Obsidian.
//
// Link/image rewriting happens INLINE, immediately after a rendered div's
// own nested embeds have been fully populated and rewritten (post-order) — a
// div's own rewriteLinks/rewriteImages pass must run AFTER its children's,
// because those functions permanently finalize whatever they touch (removing
// the internal-link marker / renumbering an image src), and idempotence
// guards (see render.ts) mean an already-finalized nested region is safely
// skipped when a shallower pass later scans over it.
async function populateEmbeds(
  app: App,
  component: Component,
  container: HTMLElement,
  sourcePath: string,
  hrefByPath: Map<string, string>,
  basePath: string,
  startIndex: number,
  visited: ReadonlySet<string>
): Promise<{ warnings: string[]; images: { vaultPath: string; newHref: string; sourcePath: string }[] }> {
  const warnings: string[] = [];
  const images: { vaultPath: string; newHref: string; sourcePath: string }[] = [];
  let index = startIndex;

  const wrappers = Array.from(container.querySelectorAll<HTMLElement>(`.${EMBED_WRAPPER_CLASS}`)).filter(
    (w) => {
      // Nested wrappers are someone else's job: ones inside a div this
      // function rendered are handled by the recursive call on that div, and
      // ones inside Obsidian's own async-populated `.markdown-embed-content`
      // preview are discarded wholesale by flattenEmbeds along with their
      // host wrapper.
      const enclosing = w.parentElement?.closest(`.${EMBED_WRAPPER_CLASS}`);
      return !enclosing || !container.contains(enclosing);
    }
  );

  for (const wrapper of wrappers) {
    const src = (wrapper.getAttribute("src") ?? "").trim();
    if (!src || isImageEmbedSrc(src)) continue; // image embed: rewriteImages' job

    const target = splitEmbedTarget(src);
    if (target.heading || target.block) {
      wrapper.setAttribute("data-embed-reason", "unsupported-scope");
      continue;
    }
    const dest = app.metadataCache.getFirstLinkpathDest(target.linkpath, sourcePath);
    if (!(dest instanceof TFile)) {
      wrapper.setAttribute("data-embed-reason", "unresolved");
      continue;
    }
    if (dest.extension !== "md") {
      wrapper.setAttribute("data-embed-reason", "unsupported-type");
      continue;
    }
    if (visited.has(dest.path)) {
      wrapper.setAttribute("data-embed-reason", "circular");
      continue;
    }

    const ourDiv = wrapper.createEl("div");
    ourDiv.setAttribute(EMBED_RENDERED_ATTR, "");
    const childMd = stripDynamicBlocks(stripFrontmatter(await app.vault.cachedRead(dest)));
    await MarkdownRenderer.render(app, childMd, ourDiv, dest.path, component);

    const childVisited = new Set(visited);
    childVisited.add(dest.path);
    const child = await populateEmbeds(
      app,
      component,
      ourDiv,
      dest.path,
      hrefByPath,
      basePath,
      index,
      childVisited
    );
    warnings.push(...child.warnings);
    images.push(...child.images);
    index += child.images.length;

    const resolve = (linkpath: string): string | null => {
      const f = app.metadataCache.getFirstLinkpathDest(linkpath, dest.path);
      return f instanceof TFile ? f.path : null;
    };
    warnings.push(...rewriteLinks(ourDiv, hrefByPath, resolve));
    const found = rewriteImages(ourDiv, basePath, index);
    // Tagged with the embed's own resolved path — a relative (non-app://)
    // image reference inside this embed's content must resolve against the
    // note it came from, not the host chapter (FR-006), and this is the only
    // point that still has that context before it flows into main.ts.
    images.push(...found.map((f) => ({ ...f, sourcePath: dest.path })));
    index += found.length;
  }

  return { warnings, images };
}

// Re-exported so callers/tests can inject a deterministic rasterizer via the
// same module path they already import renderUnitToChapter from. The real
// implementation lives in render.ts — see the "Mermaid rasterization" block
// there for why (importing THIS module pulls in "obsidian", which has no
// runtime JS outside Obsidian/vitest).
export { setSvgRasterizer } from "./render";
export type { SvgRasterizer } from "./render";

export interface ChapterRender {
  xhtmlBody: string;
  // sourcePath: set only for images that came from embedded content, naming
  // the note they actually came from (FR-006) — main.ts uses it instead of
  // the chapter's own path when resolving a relative (non-app://) image
  // reference, so a relative path written inside an embedded note resolves
  // against that note's folder, not the host chapter's.
  images: {
    newHref: string;
    vaultPath?: string;
    bytes?: Uint8Array;
    mediaType?: string;
    sourcePath?: string;
  }[];
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
  // Obsidian's createEl (ambient Node.prototype augmentation installed by the
  // real app before plugin code runs — see tests/fixtures/obsidian-stub.ts's
  // polyfill of the same) both creates the element and appends it to `this`
  // in one call, replacing the createElement+appendChild pair.
  const el = document.body.createEl("div");
  try {
    await MarkdownRenderer.render(app, md, el, sourcePath, component);
    // Render our own copy of every embedded note's content BEFORE cleanupDom's
    // flattenEmbeds replaces the embed wrappers (with our copy, or with the
    // placeholder) and that structure is lost. Obsidian's own async embed
    // population is never consulted — see populateEmbeds' comment.
    const embedRewrite = await populateEmbeds(
      app,
      component,
      el,
      sourcePath,
      hrefByPath,
      basePath,
      startImageIndex,
      new Set([sourcePath])
    );
    warnings.push(...embedRewrite.warnings);
    warnings.push(...cleanupDom(el).map((w) => `${w} (referenced by ${sourcePath})`));
    const resolve = (linkpath: string): string | null => {
      const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      return f instanceof TFile ? f.path : null;
    };
    // Only touches whatever's left — embed-internal links/images were
    // already finalized above and are skipped here (idempotence guards).
    warnings.push(...rewriteLinks(el, hrefByPath, resolve));
    const images = rewriteImages(el, basePath, startImageIndex + embedRewrite.images.length);
    // Composes with rewriteImages's numbering: mermaid PNGs continue where
    // the regular images left off, so run this AFTER rewriteImages and offset
    // by how many it already stamped.
    const mermaid = await rasterizeMermaidDiagrams(
      el,
      startImageIndex + embedRewrite.images.length + images.length
    );
    warnings.push(...mermaid.warnings);
    const xhtmlBody = serializeBody(el);
    return {
      xhtmlBody,
      images: [...embedRewrite.images, ...images, ...mermaid.images],
      warnings,
    };
  } finally {
    el.remove();
  }
}
