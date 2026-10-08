// The pure rendering library — its public facade. The implementation lives in
// the sibling modules of this folder, grouped by pipeline stage:
//
//   md.ts      markdown source text: stripping, embed targets, scoped
//              heading/block line ranges
//   svg.ts     Mermaid/inline-SVG normalization (foreignObject -> text,
//              per-diagram id prefixing)
//   embeds.ts  embed flattening + omission markers/warnings
//   dom.ts     renderer chrome removal, task glyphs, tag links,
//              serialization
//   links.ts   wikilink -> chapter href, image -> numbered img href
//   raster.ts  Mermaid SVG -> PNG rasterization
//   toc.ts     heading-level TOC collection
//
// Every module here is a pure function library with ZERO imports from
// "obsidian" (enforced by tests/module-boundaries.test.ts): the npm "obsidian"
// package ships type declarations with no runtime JS, so importing it in any
// of them would make the module unloadable by vitest and collapse the unit-test
// coverage the rendering library has.
//
// The plain-HTML-element document.createElement call sites in those modules
// (span/p/canvas/img) use Obsidian's ambient-global `createEl`/`createSpan`;
// they are declared GLOBAL in node_modules/obsidian/obsidian.d.ts (inside a
// `declare global { ... }` block), so calling them requires no `import`
// statement and the zero-"obsidian"-imports property holds.
// tests/fixtures/obsidian-stub.ts installs matching global polyfills for the
// test environment (jsdom has neither the real Obsidian app's global nor its
// Node.prototype patch). The SVG-namespaced sites (createElementNS calls in
// svg.ts, and canvas/image creation in raster.ts) are NOT
// converted: createEl cannot set the SVG namespace, and SVG text created in the
// wrong namespace serializes (and renders) incorrectly.
//
// NOTE: no `/* eslint-disable prefer-create-el */` directive is added in the
// modules — that rule ships in eslint-plugin-obsidianmd (Obsidian's own review
// tooling), which is not a devDependency of this repo's eslint.config.mjs.
// Naming the unregistered rule in a directive makes this project's own
// `eslint .` fail hard ("Definition for rule ... was not found"), and a bare
// `/* eslint-disable */` would blanket-suppress real local rules
// (no-explicit-any, no-unused-vars, ...) for no benefit. This comment is the
// intentional substitute.

export {
  stripFrontmatter,
  stripDynamicBlocks,
  splitEmbedTarget,
  isImageEmbedSrc,
  findHeadingSection,
  findBlockRange,
  listItemRange,
  dedentBlock,
  stripBlockMarker,
} from "./md";
export type { EmbedTarget, HeadingInfo, HeadingSection, SectionInfo, ListItemInfo, BlockRange } from "./md";

export { normalizeMermaidSvg } from "./svg";

export {
  EMBED_WRAPPER_CLASS,
  EMBED_TITLE_CLASS,
  EMBED_CONTENT_CLASS,
  EMBED_RENDERED_ATTR,
  flattenEmbeds,
} from "./embeds";

export { CHROME_SELECTORS, cleanupDom, serializeBody } from "./dom";

export { rewriteLinks, rewriteImages } from "./links";

export { rasterizeOrNull, setSvgRasterizer, getSvgRasterizer, rasterizeMermaidDiagrams } from "./raster";
export type { SvgRasterizer, RasterizedMermaidImage } from "./raster";

export { sanitizeHeadingId, collectHeadingToc } from "./toc";
export type { TocEntry } from "./toc";
