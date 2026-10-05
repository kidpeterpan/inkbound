// The pure rendering library — its public facade. The implementation lives in
// the sibling render-*.ts modules, grouped by pipeline stage:
//
//   render-md.ts      markdown source text: stripping, embed targets, scoped
//                     heading/block line ranges
//   render-svg.ts     Mermaid/inline-SVG normalization (foreignObject -> text,
//                     per-diagram id prefixing)
//   render-embeds.ts  embed flattening + omission markers/warnings
//   render-dom.ts     renderer chrome removal, task glyphs, tag links,
//                     serialization
//   render-links.ts   wikilink -> chapter href, image -> numbered img href
//   render-raster.ts  Mermaid SVG -> PNG rasterization
//   render-toc.ts     heading-level TOC collection
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
// render-svg.ts, and canvas/image creation in render-raster.ts) are NOT
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
} from "./render-md";
export type {
  EmbedTarget,
  HeadingInfo,
  HeadingSection,
  SectionInfo,
  ListItemInfo,
  BlockRange,
} from "./render-md";

export { normalizeMermaidSvg } from "./render-svg";

export {
  EMBED_WRAPPER_CLASS,
  EMBED_TITLE_CLASS,
  EMBED_CONTENT_CLASS,
  EMBED_RENDERED_ATTR,
  flattenEmbeds,
} from "./render-embeds";

export { CHROME_SELECTORS, cleanupDom, serializeBody } from "./render-dom";

export { rewriteLinks, rewriteImages } from "./render-links";

export {
  rasterizeOrNull,
  setSvgRasterizer,
  getSvgRasterizer,
  rasterizeMermaidDiagrams,
} from "./render-raster";
export type { SvgRasterizer, RasterizedMermaidImage } from "./render-raster";

export { sanitizeHeadingId, collectHeadingToc } from "./render-toc";
export type { TocEntry } from "./render-toc";
