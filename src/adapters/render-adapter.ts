// ── Obsidian adapter (exercised via manual smoke tests, not unit tests) ──
//
// Deliberately its own module, NOT appended to src/core/render/index.ts, even though the
// brief's Step 5 shows it inline there. Reason: "obsidian" ships type
// declarations only, no runtime JS (node_modules/obsidian/package.json has
// "main": ""). MarkdownRenderer.render(...) and `instanceof TFile` are real
// VALUE usages, not just type positions, so that import can't be elided —
// bundling it into render/index.ts would make Vite try to eagerly resolve the
// "obsidian" package the moment anything in render/index.ts is loaded, which
// breaks every pure-function test in tests/render.test.ts (verified: it
// fails with "Failed to resolve entry for package obsidian"). Splitting this
// adapter out mirrors the same fix already applied to settings.ts/
// settings-core.ts (Adjustment B) for the identical reason.
import { App, Component, MarkdownRenderer, TFile, type CachedMetadata } from "obsidian";
import { attributedTo, errorMessage } from "../core/common/error-text";
import { footnoteSourceWarnings, processFootnotes, scanFootnoteSource } from "../core/content/footnotes";
import type { ChapterImage } from "../core/types";
import {
  stripFrontmatter,
  stripDynamicBlocks,
  cleanupDom,
  splitEmbedTarget,
  isImageEmbedSrc,
  findHeadingSection,
  findBlockRange,
  dedentBlock,
  stripBlockMarker,
  rewriteLinks,
  rewriteImages,
  rasterizeMermaidDiagrams,
  collectHeadingToc,
  serializeBody,
  EMBED_RENDERED_ATTR,
  EMBED_WRAPPER_CLASS,
  type EmbedTarget,
  type TocEntry,
  type HeadingInfo,
  type SectionInfo,
  type ListItemInfo,
} from "../core/render";
import { protectMath, renderMath, type MathSpan } from "../core/content/math";
import { getBaseRenderer } from "./bases-adapter";

// Adapts real Obsidian's CachedMetadata shapes (position.start.line-based)
// into the plain arrays render/index.ts's pure heading/block functions expect —
// see research.md's Unknown 1/4 for why the pure module doesn't take these
// real Obsidian cache types directly.
function toHeadingInfo(headings: CachedMetadata["headings"]): HeadingInfo[] {
  return (headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line }));
}
function toSectionInfo(sections: CachedMetadata["sections"]): SectionInfo[] {
  return (sections ?? []).map((s) => ({
    id: s.id,
    type: s.type,
    startLine: s.position.start.line,
    endLine: s.position.end.line,
  }));
}
function toListItemInfo(listItems: CachedMetadata["listItems"]): ListItemInfo[] {
  return (listItems ?? []).map((i) => ({
    id: i.id,
    parent: i.parent,
    startLine: i.position.start.line,
    endLine: i.position.end.line,
  }));
}

// ── Note-embed content population (001-note-embed-hardening,
// 002-scoped-note-embeds) ──────────────────────────────────────────────────
//
// Real Obsidian's MarkdownRenderer.render() synchronously emits a
// `.internal-embed` wrapper for each `![[note]]` embed, carrying the exact
// linktext on its `src` attribute, and MAY populate the wrapper's
// `.markdown-embed-content` div asynchronously on its own schedule — a race
// this pipeline must not depend on either way (see render/index.ts's "Note-embed
// hardening" comment for how this was confirmed live). So this function
// renders its OWN copy of each embedded note into a private child div
// stamped with EMBED_RENDERED_ATTR; flattenEmbeds later replaces the whole
// wrapper with that div's children, discarding whatever Obsidian's async
// loader did or didn't produce in the meantime. The wrapper's `src`
// attribute is the authoritative "which note is this" handle — the actual
// linkpath the user wrote (alias excluded), heading/block suffix included —
// so no positional pairing against the raw markdown is needed.
//
// Heading/block-scoped embeds (`![[Note#Heading]]`, `![[Note^block]]`) render
// just that section/block (specs/002-scoped-note-embeds), by slicing the
// target note's raw markdown using line positions from
// `app.metadataCache.getFileCache()`, adapted to render/index.ts's pure
// `findHeadingSection`/`findSupportedBlock` — see that feature's data-model.md
// for the full extraction contract. A heading/block that doesn't resolve in
// an otherwise-valid note degrades to the existing placeholder with a
// distinct reason ("heading-not-found"/"block-not-found"), same as a
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
// guards (see render/index.ts) mean an already-finalized nested region is safely
// skipped when a shallower pass later scans over it.

// The chapter-wide math accumulator (005-latex-math): placeholder indices stay
// unique across the host note and every embed it pulls in, so a single
// renderMath pass over the final DOM can resolve them all. Shared by reference
// between the chapter build and every embed expansion below.
interface MathSink {
  counter: { next: number };
  spans: MathSpan[];
}

// State threaded through an embed expansion that does not change between
// recursion levels: the Obsidian runtime, the chapter's link/image bookkeeping,
// and the shared math accumulator.
interface EmbedPipeline {
  app: App;
  component: Component;
  hrefByPath: Map<string, string>;
  basePath: string;
  math: MathSink;
}

interface EmbeddedImage {
  vaultPath: string;
  newHref: string;
  sourcePath: string;
}

interface EmbedExpansion {
  warnings: string[];
  images: EmbeddedImage[];
}

// Per-recursion-level state for one embed expansion: the note the current
// content came from, the running image-number counter continuing the
// caller's count, and the set of note paths already expanded along THIS
// chain (the cycle guard — see the "Recursion + cycle safety" note above).
// Bundled together because populateEmbeds/expandOneWrapper/expandMarkdownEmbed
// all three change it together one recursion level at a time; EmbedPipeline
// stays a separate parameter because its fields DON'T change across levels.
interface EmbedContext {
  sourcePath: string;
  startIndex: number;
  visited: ReadonlySet<string>;
}

async function populateEmbeds(
  container: HTMLElement,
  context: EmbedContext,
  pipeline: EmbedPipeline
): Promise<EmbedExpansion> {
  const warnings: string[] = [];
  const images: EmbeddedImage[] = [];
  let index = context.startIndex;

  for (const wrapper of topLevelEmbedWrappers(container)) {
    const expanded = await expandOneWrapper(wrapper, { ...context, startIndex: index }, pipeline);
    warnings.push(...expanded.warnings);
    images.push(...expanded.images);
    index += expanded.images.length;
  }

  return { warnings, images };
}

// Expands ONE top-level embed wrapper. Image embeds are left to rewriteImages;
// a broken link, unsupported type, or circular note degrades in place with its
// reason; a markdown note renders its own copy. Returns the wrapper's warnings
// and images (both empty when it was skipped or degraded in place).
async function expandOneWrapper(
  wrapper: HTMLElement,
  context: EmbedContext,
  pipeline: EmbedPipeline
): Promise<EmbedExpansion> {
  const src = (wrapper.getAttribute("src") ?? "").trim();
  if (!src || isImageEmbedSrc(src)) return { warnings: [], images: [] }; // image embed: rewriteImages' job

  const target = splitEmbedTarget(src);
  const dest = pipeline.app.metadataCache.getFirstLinkpathDest(target.linkpath, context.sourcePath);
  if (!(dest instanceof TFile)) {
    wrapper.setAttribute("data-embed-reason", "unresolved");
    return { warnings: [], images: [] };
  }
  if (dest.extension === "base") return attachBaseTable(wrapper, src, context.sourcePath, pipeline);
  if (dest.extension !== "md") {
    wrapper.setAttribute("data-embed-reason", "unsupported-type");
    return { warnings: [], images: [] };
  }
  if (context.visited.has(dest.path)) {
    // Runs before any heading/block lookup, so a scoped embed targeting a
    // note already in the current chain (including itself) degrades as
    // circular the same way a whole-note embed would — no separate
    // self-reference check needed (spec.md FR-008).
    wrapper.setAttribute("data-embed-reason", "circular");
    return { warnings: [], images: [] };
  }

  // The render can throw (a note that cannot be read, a renderer that
  // rejects, a rasterizer that throws inside the recursive call).
  // expandMarkdownEmbed catches that, so it costs this one embed and never
  // the host chapter; on failure nothing is added to `images`, so the next
  // wrapper still numbers its own from `index`.
  return expandMarkdownEmbed(wrapper, dest, target, context, pipeline);
}

// A .base embed whose table view rendered becomes a stamped div; anything else
// (a card view, a grouped table, an error, a timeout) degrades to the
// "unsupported-type" marker, with Obsidian's reason attached.
async function attachBaseTable(
  wrapper: HTMLElement,
  src: string,
  sourcePath: string,
  pipeline: EmbedPipeline
): Promise<EmbedExpansion> {
  const base = await expandBaseEmbed(pipeline.app, src, sourcePath);
  if (base.kind === "unsupported") {
    wrapper.setAttribute("data-embed-reason", "unsupported-type");
    wrapper.setAttribute("data-embed-detail", base.reason);
    return { warnings: [], images: [] };
  }
  // A Bases TABLE view becomes a static table. No rewriteLinks here: a
  // cell's link to a note is finalised by the pass of whatever encloses
  // this embed (the embedded note's own, or the chapter's), resolving
  // against the note the Base is written in. It points at that note's
  // chapter if the note is in the book, and degrades to plain text if not.
  const ourDiv = wrapper.createDiv();
  ourDiv.setAttribute(EMBED_RENDERED_ATTR, "");
  ourDiv.appendChild(base.table);
  const warnings = base.warning ? [attributedTo(sourcePath)(`${base.warning}: ${src}`)] : [];
  return { warnings, images: [] };
}

function topLevelEmbedWrappers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${EMBED_WRAPPER_CLASS}`)).filter((w) => {
    // Nested wrappers are someone else's job: ones inside a div this function
    // rendered are handled by the recursive call on that div, and ones inside
    // Obsidian's own async-populated `.markdown-embed-content` preview are
    // discarded wholesale by flattenEmbeds along with their host wrapper.
    const enclosing = w.parentElement?.closest(`.${EMBED_WRAPPER_CLASS}`);
    return !enclosing || !container.contains(enclosing);
  });
}

type BaseEmbedExpansion =
  { kind: "rendered"; table: HTMLElement; warning: string | null } | { kind: "unsupported"; reason: string };

async function expandBaseEmbed(app: App, src: string, sourcePath: string): Promise<BaseEmbedExpansion> {
  try {
    const outcome = await getBaseRenderer()(app, src, sourcePath);
    return outcome.ok
      ? { kind: "rendered", table: outcome.table, warning: outcome.warning }
      : { kind: "unsupported", reason: outcome.reason };
  } catch (e) {
    return { kind: "unsupported", reason: errorMessage(e) };
  }
}

type EmbedSource = { ok: true; md: string } | { ok: false; reason: "heading-not-found" | "block-not-found" };

// The markdown an embed renders: the whole note, or the cached line range a
// heading/block-scoped embed (`![[Note#Heading]]`, `![[Note^block]]`) selects.
function embedSource(app: App, dest: TFile, target: EmbedTarget, rawMd: string): EmbedSource {
  if (!target.heading && !target.block) {
    return { ok: true, md: stripDynamicBlocks(stripFrontmatter(rawMd)) };
  }
  const mdLines = rawMd.split(/\r?\n/);
  const cache = app.metadataCache.getFileCache(dest);
  const loc = target.heading
    ? findHeadingSection(toHeadingInfo(cache?.headings), target.heading, mdLines.length)
    : findBlockRange(toSectionInfo(cache?.sections), toListItemInfo(cache?.listItems), target.block!);
  if (!loc) return { ok: false, reason: target.heading ? "heading-not-found" : "block-not-found" };
  // No stripFrontmatter here: frontmatter always sits before any heading/
  // block worth embedding, so slicing against the RAW (frontmatter-
  // included) line array — matching how the cache's own line numbers are
  // computed — naturally excludes it without a separate strip step (see
  // research.md's Unknown 2).
  let sliced = mdLines.slice(loc.startLine, loc.endLine + 1).join("\n");
  if (target.block) {
    // Dedent ONLY a list-item range. A root-level section either starts at
    // column 0 (no-op) or is an indented-style code block, whose leading
    // whitespace is what makes it code — dedenting that would silently
    // demote it to a paragraph (002 research R3a).
    if ("fromListItem" in loc && loc.fromListItem) sliced = dedentBlock(sliced);
    sliced = stripBlockMarker(sliced, target.block);
  }
  return { ok: true, md: stripDynamicBlocks(sliced) };
}

function offsetMathPlaceholderIndices(md: string, offset: number): string {
  if (offset === 0) return md;
  return md.replace(
    /data-inkbound-math="(\d+)"/g,
    (_match, n: string) => `data-inkbound-math="${Number(n) + offset}"`
  );
}

// The vault-path resolver rewriteLinks needs, bound to the note a run of DOM
// came from: a chapter's own path for its body, an embedded note's path for
// that note's contents.
function vaultLinkResolver(app: App, sourcePath: string): (linkpath: string) => string | null {
  return (linkpath) => {
    const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return f instanceof TFile ? f.path : null;
  };
}

// Adds `md`'s math spans to the chapter accumulator and returns the markdown to
// render with its placeholders re-keyed chapter-uniquely. The host note seeds
// the accumulator (offset 0, markdown returned unchanged); each embed appends
// at the counter's current value, because protectMath numbers every render
// from 0 and only the shared sink can keep the indices unique (005-latex-math).
function protectIntoChapter(md: string, sink: MathSink): string {
  const protectedMd = protectMath(md);
  const offset = sink.counter.next;
  sink.spans.push(
    ...protectedMd.spans.map((s) => ({ tex: s.tex, display: s.display, index: s.index + offset }))
  );
  sink.counter.next += protectedMd.spans.length;
  return offset === 0 ? protectedMd.md : offsetMathPlaceholderIndices(protectedMd.md, offset);
}

// Finalises one run of rendered DOM: wikilinks become chapter hrefs, images
// become numbered hrefs continuing the caller's count, and warnings are
// attributed to the note whose content produced them. Returns the images tagged
// for that note.
function finalizeLinksAndImages(
  root: HTMLElement,
  sourcePath: string,
  startImageIndex: number,
  pipeline: EmbedPipeline,
  warnings: string[]
): EmbeddedImage[] {
  rewriteLinks(root, pipeline.hrefByPath, vaultLinkResolver(pipeline.app, sourcePath));
  const found = rewriteImages(root, pipeline.basePath, startImageIndex, (w) =>
    warnings.push(attributedTo(sourcePath)(w))
  );
  // Tagged with the note the image came from — a relative (non-app://) image
  // reference inside embed content must resolve against that note, not the host
  // chapter (FR-006), and this is the only point that still has that context
  // before it flows into main.ts. A chapter's OWN images stay untagged
  // (sourcePath absent = resolve against the chapter file).
  return found.map((f) => ({ ...f, sourcePath }));
}

// Renders `dest` into the wrapper's own copy and finalises its links and
// images. On any failure the wrapper is marked "render-failed", the
// partially-built content is discarded, and the caller's image numbering does
// not advance.
async function expandMarkdownEmbed(
  wrapper: HTMLElement,
  dest: TFile,
  target: EmbedTarget,
  context: EmbedContext,
  pipeline: EmbedPipeline
): Promise<EmbedExpansion> {
  const warnings: string[] = [];
  const spansBefore = pipeline.math.spans.length;
  try {
    const rawMd = await pipeline.app.vault.cachedRead(dest);
    const source = embedSource(pipeline.app, dest, target, rawMd);
    if (!source.ok) {
      wrapper.setAttribute("data-embed-reason", source.reason);
      return { warnings, images: [] };
    }
    // 011-footnote-semantics: an embed's slice is where a footnote most often loses its
    // partner (a heading- or block-scoped embed copies the reference but not the definition
    // that lives elsewhere in the note). Obsidian's renderer then shows just the bare label
    // and the DOM keeps no trace, so the problem is only visible here, in the slice's source.
    // Named for the embedded note (`dest.path`), whose source holds it.
    warnings.push(...footnoteSourceWarnings(scanFootnoteSource(source.md), dest.path));

    const ourDiv = wrapper.createDiv();
    ourDiv.setAttribute(EMBED_RENDERED_ATTR, "");
    await MarkdownRenderer.render(
      pipeline.app,
      protectIntoChapter(source.md, pipeline.math),
      ourDiv,
      dest.path,
      pipeline.component
    );

    const childVisited = new Set(context.visited);
    childVisited.add(dest.path);
    const childContext: EmbedContext = {
      sourcePath: dest.path,
      startIndex: context.startIndex,
      visited: childVisited,
    };
    const child = await populateEmbeds(ourDiv, childContext, pipeline);
    warnings.push(...child.warnings);

    const found = finalizeLinksAndImages(
      ourDiv,
      dest.path,
      context.startIndex + child.images.length,
      pipeline,
      warnings
    );
    return { warnings, images: [...child.images, ...found] };
  } catch (e) {
    wrapper.querySelector(`:scope > [${EMBED_RENDERED_ATTR}]`)?.remove();
    // The div is gone, so the image hrefs and math placeholders stamped into
    // it no longer exist and must not be counted. The counter itself is not
    // rolled back: placeholder indices only need to be unique, not dense.
    pipeline.math.spans.length = spansBefore;
    wrapper.setAttribute("data-embed-reason", "render-failed");
    wrapper.setAttribute("data-embed-detail", errorMessage(e));
    return { warnings, images: [] };
  }
}

// Re-exported so callers/tests can inject a deterministic rasterizer via the
// same module path they already import renderUnitToChapter from. The real
// implementation lives in render/index.ts — see the "Mermaid rasterization" block
// there for why (importing THIS module pulls in "obsidian", which has no
// runtime JS outside Obsidian/vitest).
export { setSvgRasterizer } from "../core/render";
export type { SvgRasterizer } from "../core/render";

export interface ChapterRender {
  xhtmlBody: string;
  images: ChapterImage[];
  warnings: string[];
  // Heading-level TOC entries (004-heading-toc): collected from the final
  // rendered DOM when tocDepth > 0; [] at depth 0, where no ids are stamped
  // either (depth-0 output identity, FR-006).
  toc: TocEntry[];
}

// Mutable state for one chapter's build, threaded through the finalisation
// phases below. The image counter is load-bearing: every phase stamps image
// hrefs into the DOM in pipeline order and continues the previous phase's
// numbering (see the invariant comment on `renderUnitToChapter`).
interface ChapterBuild {
  warnings: string[];
  images: ChapterImage[];
  nextImageNumber: number;
  math: MathSink;
}

// Phase 1 — steps 2-4 of the pipeline: render the note, render our own copy
// of every embed, then clean the DOM.
async function renderChapterDom(
  build: ChapterBuild,
  el: HTMLElement,
  pipeline: EmbedPipeline,
  protectedMd: string,
  sourcePath: string
): Promise<void> {
  await MarkdownRenderer.render(pipeline.app, protectedMd, el, sourcePath, pipeline.component);
  // Render our own copy of every embedded note's content BEFORE cleanupDom's
  // flattenEmbeds replaces the embed wrappers (with our copy, or with the
  // placeholder) and that structure is lost. Obsidian's own async embed
  // population is never consulted — see populateEmbeds' comment.
  const embedRewrite = await populateEmbeds(
    el,
    { sourcePath, startIndex: build.nextImageNumber, visited: new Set([sourcePath]) },
    pipeline
  );
  build.warnings.push(...embedRewrite.warnings);
  build.images.push(...embedRewrite.images);
  build.nextImageNumber += embedRewrite.images.length;

  build.warnings.push(...cleanupDom(el).map(attributedTo(sourcePath)));
}

// Phase 2 — steps 5-6: wikilinks and images. Only touches whatever cleanupDom
// left — embed-internal links/images were already finalized above and are
// skipped here (idempotence guards).
function finalizeChapterLinks(
  build: ChapterBuild,
  el: HTMLElement,
  pipeline: EmbedPipeline,
  sourcePath: string
): void {
  rewriteLinks(el, pipeline.hrefByPath, vaultLinkResolver(pipeline.app, sourcePath));
  const images = rewriteImages(el, pipeline.basePath, build.nextImageNumber, (w) =>
    build.warnings.push(attributedTo(sourcePath)(w))
  );
  build.images.push(...images);
  build.nextImageNumber += images.length;
}

// Phase 3 — steps 7-8: Mermaid diagrams and math expressions. Both continue the
// running image counter so no two images ever collide (see the chapter/image
// href numbering invariant in CLAUDE.md).
async function finalizeChapterMedia(build: ChapterBuild, el: HTMLElement, sourcePath: string): Promise<void> {
  // Composes with rewriteImages's numbering: mermaid PNGs continue where the
  // regular images left off, so this MUST run after finalizeChapterLinks.
  const mermaid = await rasterizeMermaidDiagrams(el, build.nextImageNumber);
  build.warnings.push(...mermaid.warnings);
  build.images.push(...mermaid.images);
  build.nextImageNumber += mermaid.images.length;

  const math = await renderMath(el, build.math.spans, build.nextImageNumber, sourcePath);
  build.warnings.push(...math.warnings);
  build.images.push(...math.images);
}

// Phase 4 — steps 9-10: footnotes, then the heading TOC. The POSITION is
// load-bearing (research R9):
//   - after cleanupDom's flattenEmbeds, so each embed's own `section.footnotes`
//     (one per render, each numbered from 1) is already in this DOM;
//   - after rewriteLinks / rewriteImages / renderMath, so a link, image or
//     expression INSIDE a note is processed as body content before the note is
//     moved;
//   - before collectHeadingToc, so heading text can exclude markers and heading
//     ids can avoid the footnote ids minted here.
// Moving nodes does not disturb the image-href numbering invariant (main.ts's
// imageCount): numbers are stamped into `src` attributes, not derived from
// position. A chapter with no footnotes is returned untouched (FR-023).
function finalizeChapterFootnotes(build: ChapterBuild, el: HTMLElement, tocDepth: number): TocEntry[] {
  build.warnings.push(...processFootnotes(el));
  // Depth-0 identity (FR-006): collectHeadingToc is NOT called at all when
  // tocDepth is 0, so no ids are stamped and the serialized body is
  // byte-identical to pre-feature output. It runs after embeds are flattened
  // (flattenEmbeds inside cleanupDom), so headings from inlined note embeds
  // are legitimately part of this chapter's toc (research R5).
  return tocDepth > 0 ? collectHeadingToc(el, tocDepth) : [];
}

/**
 * Turns one note's markdown into a chapter: rendered XHTML, the images it
 * needs, its warnings, and its heading TOC.
 *
 * THE PAGE PIPELINE RUNS IN THIS ORDER, and two of these steps are
 * order-sensitive in ways that are not obvious from the calls alone:
 *
 *   1. protectMath             — placeholders in, before any renderer sees $…$
 *   2. MarkdownRenderer.render — the real renderer, once per note      ┐
 *   3. populateEmbeds          — our own copy of every embedded note   ├ renderChapterDom
 *   4. cleanupDom              — flattenEmbeds + chrome + Bases        ┘
 *   5. rewriteLinks            — wikilinks -> sibling chapter hrefs    ┐ finalizeChapterLinks
 *   6. rewriteImages           — vault images -> numbered ../images/…  ┘
 *   7. rasterizeMermaidDiagrams— Mermaid -> PNG                        ┐ finalizeChapterMedia
 *   8. renderMath              — placeholders -> PNG                   ┘
 *   9. processFootnotes        — every note -> one EPUB 3 notes area   ┐ finalizeChapterFootnotes
 *  10. collectHeadingToc       — heading ids + nav entries (depth > 0) ┘
 *  11. serializeBody           — the finished XHTML (below)
 *
 * The load-bearing constraints: footnotes must run AFTER flattenEmbeds (each
 * embed brings its own `section.footnotes` into the DOM) and BEFORE heading
 * ids (so heading text can exclude markers and ids can avoid the footnote
 * ids). Steps 3-8 all stamp `<img>` hrefs into the chapter, so they share ONE
 * running image counter (ChapterBuild.nextImageNumber), advanced in step order.
 */
export async function renderUnitToChapter(
  app: App,
  component: Component,
  markdown: string,
  sourcePath: string,
  hrefByPath: Map<string, string>,
  basePath: string,
  startImageIndex: number,
  tocDepth = 0
): Promise<ChapterRender> {
  const build: ChapterBuild = {
    warnings: [],
    images: [],
    nextImageNumber: startImageIndex,
    math: { counter: { next: 0 }, spans: [] },
  };
  const md = stripDynamicBlocks(stripFrontmatter(markdown));
  // 011-footnote-semantics: orphan footnotes in the host note itself. See the matching call
  // in populateEmbeds for why this reads the source rather than the rendered DOM.
  build.warnings.push(...footnoteSourceWarnings(scanFootnoteSource(md), sourcePath));
  // 005-latex-math: swap math for placeholders BEFORE rendering, so neither
  // the real renderer's MathJax output nor the stub's raw $...$ text leaks
  // into the DOM. Indices stay chapter-unique via the shared sink as embeds
  // add their own spans.
  const protectedMd = protectIntoChapter(md, build.math);
  const pipeline: EmbedPipeline = { app, component, hrefByPath, basePath, math: build.math };
  // Obsidian's createEl (ambient Node.prototype augmentation installed by the
  // real app before plugin code runs — see tests/fixtures/obsidian-stub.ts's
  // polyfill of the same) both creates the element and appends it to `this`
  // in one call, replacing the createElement+appendChild pair.
  const el = document.body.createDiv();
  try {
    // Every image this chapter ends up with — embed content, regular images,
    // rasterized Mermaid, rendered math — becomes an
    // `<img src="../images/img_NNN.ext">` in the SAME chapter, so all four are
    // numbered from one running counter. Each phase advances it by however many
    // images it stamped; no phase recomputes the sum, so inserting a phase
    // cannot leave a later one reusing a number already burned into the HTML.
    await renderChapterDom(build, el, pipeline, protectedMd, sourcePath);
    finalizeChapterLinks(build, el, pipeline, sourcePath);
    await finalizeChapterMedia(build, el, sourcePath);
    const toc = finalizeChapterFootnotes(build, el, tocDepth);
    return { xhtmlBody: serializeBody(el), images: build.images, warnings: build.warnings, toc };
  } finally {
    el.remove();
  }
}
