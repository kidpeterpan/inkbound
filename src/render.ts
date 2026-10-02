// This module is a pure function library with ZERO imports from "obsidian"
// (see the CRITICAL ARCHITECTURAL CONSTRAINT in CLAUDE.md / the module-split
// rationale in render-adapter.ts): the npm "obsidian" package ships type
// declarations with no runtime JS, so importing it here would make this
// module unloadable by vitest and collapse the unit-test coverage this file
// currently has.
//
// Correction (2026-07-30): the plain-HTML-element `document.createElement`
// call sites below (span/p/canvas/img) DO use Obsidian's `createEl` now.
// `createEl`/`createDiv`/`createSpan`/`createFragment` are declared in
// node_modules/obsidian/obsidian.d.ts as AMBIENT GLOBAL FUNCTIONS (inside a
// `declare global { ... }` block), not only as `Node.prototype` methods —
// calling the bare global requires no `import` statement, so this file keeps
// its zero-"obsidian"-imports property (still loadable by vitest) while
// using the real helper. tests/fixtures/obsidian-stub.ts installs a matching
// global `createEl` polyfill for the test environment (jsdom has neither the
// real Obsidian app's global nor its Node.prototype patch).
//
// The SVG-namespaced sites (createElementNS calls, elsewhere in this file)
// are NOT converted: createEl cannot set the SVG namespace at all, and SVG
// text created in the wrong namespace serializes (and renders) incorrectly.
// Those keep `document.createElementNS(SVG_NS, ...)`, commented individually.
//
// NOTE: no `/* eslint-disable prefer-create-el */` directive is added here —
// that rule ships in eslint-plugin-obsidianmd (Obsidian's own review
// tooling), which is not a devDependency of this repo's eslint.config.mjs.
// Naming the unregistered rule in a directive makes this project's own
// `eslint .` fail hard ("Definition for rule ... was not found"), and a bare
// `/* eslint-disable */` would blanket-suppress this file's real local rules
// (no-explicit-any, no-unused-vars, ...) for no benefit. This comment is the
// intentional substitute.

export const CHROME_SELECTORS = [
  ".edit-block-button",
  ".copy-code-button",
  ".collapse-indicator",
  ".markdown-preview-pusher",
  ".mod-frontmatter",
  ".frontmatter",
  ".metadata-container",
];

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function stripDynamicBlocks(md: string): string {
  return md.replace(/```dataview(js)?\r?\n[\s\S]*?```/g, "*[dynamic content omitted]*");
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Block-level (or block-like) tags inside a mermaid foreignObject's XHTML
// content whose boundaries should become a line break in the flattened SVG
// <text>. Mermaid's own markup only ever nests <span>/<p>/<br> here, but a
// few extra tags are included defensively since foreignObject content is
// arbitrary XHTML.
const FOREIGN_OBJECT_BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// Collects the normalized text lines inside a mermaid label foreignObject.
// Runs of whitespace collapse to a single space and each result is trimmed;
// <br> and block-level children each start a new line so multi-line labels
// (e.g. "mid = ...<br/>guess = ...") survive as separate lines rather than
// being smashed together.
function collectForeignObjectLines(foreignObject: Element): string[] {
  const lines: string[] = [];
  let pendingLine = "";

  const flushPendingLine = (): void => {
    const normalized = pendingLine.replace(/\s+/g, " ").trim();
    if (normalized !== "") lines.push(normalized);
    pendingLine = "";
  };

  const visit = (node: ChildNode): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pendingLine += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (tagName === "br") {
      flushPendingLine();
      return;
    }

    // A block-level child delimits a line on BOTH sides: the line it starts,
    // and the line it ends. <p>a</p><p>b</p> is therefore two lines, not one.
    const isBlockLevel = FOREIGN_OBJECT_BLOCK_TAGS.has(tagName);
    if (isBlockLevel) flushPendingLine();
    for (const child of Array.from(element.childNodes)) visit(child);
    if (isBlockLevel) flushPendingLine();
  };

  for (const child of Array.from(foreignObject.childNodes)) visit(child);
  flushPendingLine();
  return lines;
}

// Converts every <foreignObject> under one mermaid <svg> into a real SVG
// <text> (or removes it, if it turns out to be an empty label placeholder).
// foreignObject/HTML-in-SVG is what e-ink EPUB readers refuse to render, and
// a <p> nested inside a <span> inside it is invalid XHTML (epubcheck RSC-005
// "element p not allowed here") — flattening to <text>/<tspan> fixes both.
function normalizeForeignObjects(svg: SVGElement): void {
  const foreignObjects = Array.from(svg.querySelectorAll("foreignObject"));

  for (const foreignObject of foreignObjects) {
    const width = parseFloat(foreignObject.getAttribute("width") ?? "") || 0;
    const height = parseFloat(foreignObject.getAttribute("height") ?? "") || 0;

    const lines = collectForeignObjectLines(foreignObject);
    if (lines.length === 0) {
      // Empty edge-label placeholder (mermaid emits height="0" width="0"
      // with no text for edges that have no label) — contributes nothing.
      foreignObject.remove();
      continue;
    }

    foreignObject.replaceWith(buildLabelText(lines, width, height));
  }
}

// Builds the SVG <text> that stands in for one label foreignObject, centered
// on the box the foreignObject occupied.
function buildLabelText(lines: string[], width: number, height: number): SVGElement {
  // createElementNS is required here: createElement would place the node
  // in the XHTML namespace and it would serialize (and render) wrong.
  const text = document.createElementNS(SVG_NS, "text");
  const centerX = width / 2;
  const centerY = height / 2;
  text.setAttribute("x", String(centerX));
  text.setAttribute("y", String(centerY));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");

  lines.forEach((line, lineIndex) => {
    const tspan = document.createElementNS(SVG_NS, "tspan");
    tspan.setAttribute("x", String(centerX));
    tspan.setAttribute("dy", lineIndex === 0 ? "0" : "1.2em");
    tspan.textContent = line;
    text.appendChild(tspan);
  });

  return text;
}

// Escapes a string for safe interpolation into a RegExp source.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Rewrites one mermaid <style> element's textContent so its selectors (and
// any url(#OLD) references) target the freshly-prefixed ids instead of the
// pre-prefix ones, and so its font-family declaration survives outside
// Obsidian. Mermaid scopes its entire stylesheet under the svg's own id
// (e.g. "#abc123{...} #abc123 .error-icon{...}"); once prefixIds renames the
// svg's id to "m2_abc123" but leaves the style text saying "#abc123", none of
// the rules match anything anymore and every shape falls back to SVG's
// default black fill. The lookahead boundary check (next char not
// [A-Za-z0-9_-]) prevents an id that's a textual prefix of another id (e.g.
// "abc123" vs "abc123-marker") from corrupting the longer one; it also
// happens to cover "url(#OLD)" for free, since "#OLD" there is followed by
// ")" (not an id-continuation char) as well as "#OLD{" and "#OLD " selectors.
function rewriteStyleIds(styleText: string, idMap: Map<string, string>): string {
  let result = styleText;
  for (const [oldId, newId] of idMap) {
    const pattern = new RegExp(`#${escapeRegExp(oldId)}(?![A-Za-z0-9_-])`, "g");
    result = result.replace(pattern, `#${newId}`);
  }
  // The mermaid-supplied font-family variable only exists inside Obsidian's
  // own CSS; in an EPUB reader the declaration collapses to nothing, so give
  // it a fallback.
  return result.replace(/var\(--font-mermaid\)/g, "var(--font-mermaid, sans-serif)");
}

// Prefixes every id in one mermaid <svg> (and the svg's own id) with a
// stable per-diagram prefix, rewriting every url(#OLD)/href="#OLD" reference
// in lockstep so nothing breaks. Mermaid emits the same element ids (e.g.
// "L_A_B_0") in every diagram it renders, so multiple diagrams sharing one
// XHTML chapter collide (epubcheck RSC-005 "Duplicate ID") unless each
// diagram's ids are made unique.
function prefixIds(svg: SVGElement, prefix: string): void {
  const elementsWithIds = collectElementsWithIds(svg);
  const idRenames = buildIdRenameMap(elementsWithIds, prefix);
  if (idRenames.size === 0) return;

  renameIds(elementsWithIds, idRenames);
  retargetIdReferences(svg, idRenames);
  rewriteStyleSheets(svg, idRenames);
}

// Every element carrying an id, the <svg> itself first: mermaid scopes its
// stylesheet under the svg's own id, so that one has to be renamed too.
function collectElementsWithIds(svg: SVGElement): Element[] {
  const elements: Element[] = [];
  if (svg.hasAttribute("id")) elements.push(svg);
  svg.querySelectorAll("[id]").forEach((element) => elements.push(element));
  return elements;
}

function buildIdRenameMap(elementsWithIds: Element[], prefix: string): Map<string, string> {
  const idRenames = new Map<string, string>();
  for (const element of elementsWithIds) {
    const oldId = element.getAttribute("id");
    if (oldId && !idRenames.has(oldId)) idRenames.set(oldId, `${prefix}${oldId}`);
  }
  return idRenames;
}

function renameIds(elementsWithIds: Element[], idRenames: Map<string, string>): void {
  for (const element of elementsWithIds) {
    const oldId = element.getAttribute("id");
    const newId = oldId === null ? undefined : idRenames.get(oldId);
    if (newId !== undefined) element.setAttribute("id", newId);
  }
}

// Points every reference at the renamed ids: url(#OLD) (fill, stroke, filter,
// mask, clip-path) and href="#OLD" (<use>, gradients). An attribute that
// references nothing renamed is left byte-identical.
function retargetIdReferences(svg: SVGElement, idRenames: Map<string, string>): void {
  const allElements: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];

  for (const element of allElements) {
    for (const attribute of Array.from(element.attributes)) {
      const { name, value } = attribute;
      if (value === "") continue;

      let newValue = value;
      if (newValue.includes("url(#")) {
        newValue = newValue.replace(/url\(#([^)'"]+)\)/g, (wholeMatch, id: string) => {
          const newId = idRenames.get(id);
          return newId === undefined ? wholeMatch : `url(#${newId})`;
        });
      }
      if ((name === "href" || name.endsWith(":href")) && newValue.startsWith("#")) {
        const newId = idRenames.get(newValue.slice(1));
        if (newId !== undefined) newValue = `#${newId}`;
      }
      if (newValue !== value) element.setAttribute(name, newValue);
    }
  }
}

function rewriteStyleSheets(svg: SVGElement, idRenames: Map<string, string>): void {
  svg.querySelectorAll("style").forEach((style) => {
    const originalText = style.textContent ?? "";
    const rewrittenText = rewriteStyleIds(originalText, idRenames);
    if (rewrittenText !== originalText) style.textContent = rewrittenText;
  });
}

// Mermaid diagrams live in div.mermaid > svg, but this handles any inline
// svg in the export. Give each one a stable 1-based document-order index so
// its ids never collide with a sibling diagram's ids in the same chapter.
export function normalizeMermaidSvg(root: HTMLElement): void {
  const svgs = Array.from(root.querySelectorAll("svg"));
  for (const [index, svg] of svgs.entries()) {
    normalizeForeignObjects(svg);
    prefixIds(svg, `m${index + 1}_`);
  }
}

// ── Note-embed hardening ───────────────────────────────────────────────────
//
// Second corrected understanding (2026-07-31, LIVE console diagnostics inside
// a real Obsidian export run — the ground truth; supersedes both this
// comment's previous revision, which inspected only serialized EPUB output
// and wrongly concluded "no wrapper, never populated", and the original
// pre-feature theory research.md documents):
//
// Real Obsidian's `MarkdownRenderer.render()` DOES wrap a note-to-note embed
// (`![[note]]`) in a wrapper element carrying the authoritative linktext:
//   <span alt="Note" src="Note" class="internal-embed markdown-embed inline-embed">
//     <div class="embed-title markdown-embed-title">Note</div>
//     <div class="markdown-embed-content"></div>
//   </span>
// The synchronous render leaves `.markdown-embed-content` empty — and then
// Obsidian's own embed machinery MAY populate it asynchronously (adding
// `is-loaded` to the wrapper and a `.markdown-preview-view` child to the
// content div), on its own schedule, racing this plugin's pipeline. An
// UNRESOLVED embed's wrapper is asynchronously rewritten to
//   <span class="internal-embed file-embed mod-empty" src="X">"X" is not created yet. Click to create.</span>
// (title/content pair gone entirely). Whether the async population has
// happened by serialization time is a race — which is exactly why exports
// showed embeds sometimes empty, and why any design that reads or waits on
// Obsidian's own embed content is wrong.
//
// The race-immune design: render-adapter.ts's `populateEmbeds` renders its
// OWN copy of each embedded note into a private child div stamped with
// EMBED_RENDERED_ATTR, and `flattenEmbeds` below replaces the ENTIRE wrapper
// with that stamped div's children — discarding whatever Obsidian's async
// loader did or didn't put in `.markdown-embed-content` (and its "Click to
// create." text for broken links), no matter when it lands.

export const EMBED_WRAPPER_CLASS = "internal-embed";
export const EMBED_TITLE_CLASS = "markdown-embed-title";
export const EMBED_CONTENT_CLASS = "markdown-embed-content";
/** Marks the div populateEmbeds rendered an embedded note's content into. */
export const EMBED_RENDERED_ATTR = "data-inkbound-embed";

// Known-image extensions Obsidian embeds inline as `<img>` rather than as a
// note transclusion — mirrors media-types.ts's allowlist scope, kept as its
// own narrow regex here so this pure module doesn't need to import from it.
const EMBED_IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)$/i;

export interface EmbedTarget {
  /** The full linktext as written, e.g. "Note#Heading" or "Note^blockid". */
  raw: string;
  /** Just the note-name portion, with any "#..."/"^..." suffix stripped. */
  linkpath: string;
  /** Heading name after a "#" suffix (not a "^" block ref), if present. */
  heading: string | null;
  /** Block ID after a "^" suffix, if present. */
  block: string | null;
}

// Splits an embed wrapper's `src` linktext (the authoritative target — real
// Obsidian stamps the exact linkpath the user wrote, alias excluded, onto the
// wrapper's src attribute) into its note path and optional heading/block
// scope suffix. Replaces the old raw-markdown positional scan
// (parseNoteEmbeds): with the src attribute available on every wrapper there
// is nothing positional left to reconstruct.
export function splitEmbedTarget(src: string): EmbedTarget {
  const raw = src.trim();

  const headingIndex = raw.indexOf("#");
  const blockIndex = raw.indexOf("^");
  const suffixIndices = [headingIndex, blockIndex].filter((index) => index !== -1);

  // Whichever suffix appears FIRST in the linktext is the one that scopes the
  // embed ("Note#Heading" scopes by heading, "Note^blockid" by block); a
  // second suffix, if any, is just part of that scope's name.
  const firstSuffixIndex = suffixIndices.length === 0 ? null : Math.min(...suffixIndices);
  const hasHeadingSuffix = headingIndex !== -1 && headingIndex === firstSuffixIndex;
  const hasBlockSuffix = blockIndex !== -1 && blockIndex === firstSuffixIndex;

  return {
    raw,
    linkpath: firstSuffixIndex === null ? raw : raw.slice(0, firstSuffixIndex),
    heading: hasHeadingSuffix ? raw.slice(headingIndex + 1) : null,
    block: hasBlockSuffix ? raw.slice(blockIndex + 1) : null,
  };
}

/** True when an embed wrapper's src targets an image, not a note. */
export function isImageEmbedSrc(src: string): boolean {
  return EMBED_IMAGE_EXT.test(src.trim());
}

// Obsidian Bases (.base) render an interactive, filtered view of note
// properties — an EPUB reader has no way to reproduce that, so the embed
// degrades with a message naming the feature rather than the generic
// "not a note" wording (GitHub issue #2: read as a failed export).
// The suffix may carry a `#`/`^` scope (the wrapper's src is the raw
// linktext), so the extension need not sit at the very end.
function isBasesSrc(src: string): boolean {
  return /\.base([#^].*)?$/i.test(src.trim());
}

// ── Scoped (heading/block) embed extraction ────────────────────────────────
//
// A heading-scoped (`![[Note#Heading]]`) or block-scoped (`![[Note^blockid]]`)
// embed needs to know WHERE in the target note's raw markdown its section or
// block starts and ends. Obsidian's own `app.metadataCache.getFileCache()`
// already computes exactly this (line-numbered headings and root-level
// sections) — render-adapter.ts adapts that real, Obsidian-specific cache
// shape into the plain `HeadingInfo`/`SectionInfo` arrays below, so the
// matching and boundary math here stays pure and independently testable
// (see research.md's Unknown 4 for why this doesn't reuse Obsidian's own
// `stripHeading()`/`stripHeadingForLink()` normalization functions).

export interface HeadingInfo {
  heading: string;
  level: number;
  /** 0-based line number in the note's raw markdown. */
  line: number;
}

export interface HeadingSection {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

// Finds the heading matching `target` (case-insensitive, leading/trailing
// whitespace ignored — FR-002) and computes its section's line range: from
// the heading's own line through the line before the next heading whose
// level is equal to or higher (numerically lower or equal) than the matched
// heading's, or through the note's last line if no such heading follows.
// When more than one heading shares the same text, the first in document
// order wins, matching how Obsidian itself resolves a duplicate heading link.
export function findHeadingSection(
  headings: HeadingInfo[],
  target: string,
  totalLines: number
): HeadingSection | null {
  const normalizedTarget = target.trim().toLowerCase();
  const matchedIndex = headings.findIndex(
    (heading) => heading.heading.trim().toLowerCase() === normalizedTarget
  );
  if (matchedIndex === -1) return null;

  const matchedHeading = headings[matchedIndex];
  // The section runs until the next heading at the same level or higher.
  const nextHeading = headings
    .slice(matchedIndex + 1)
    .find((heading) => heading.level <= matchedHeading.level);
  const endLine = nextHeading ? nextHeading.line - 1 : totalLines - 1;
  return { startLine: matchedHeading.line, endLine };
}

export interface SectionInfo {
  id: string | undefined;
  /** e.g. "paragraph" | "heading" | "list" | "table" | ... (non-exhaustive). */
  type: string;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

// One entry per list item, mirroring Obsidian's ListItemCache. `parent` is the
// mechanism its own docs point at for reconstructing hierarchy, which is what
// an embedded item's descendant range needs (spec 002 FR-006).
export interface ListItemInfo {
  id: string | undefined;
  /**
   * Start line of this item's parent item. NEGATIVE for a root-level item,
   * where its magnitude is the list's first line (Obsidian's own convention).
   */
  parent: number;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

export interface BlockRange extends HeadingSection {
  /**
   * True when this range came from a list item rather than a root-level
   * section. The caller dedents ONLY these: a root-level section either starts
   * at column 0 (dedent is a no-op) or is an indented-style code block, whose
   * leading whitespace IS what makes it code — dedenting that would silently
   * demote it to a paragraph (spec 002 research R3a).
   */
  fromListItem: boolean;
}

// Finds the block matching `blockId` across BOTH structures Obsidian exposes
// at block granularity: root-level `sections` (any type — table, code,
// blockquote, callout, list, html, paragraph, heading, or one Obsidian adds
// later) and per-item `listItems`. There is deliberately no type allowlist:
// SectionCache["type"] is documented as non-exhaustive, so absence of a
// resolvable RANGE — not absence from a hand-maintained list — is the
// rejection criterion. An ID in neither structure returns null and
// render-adapter.ts degrades it exactly as before (spec 002 FR-009).
//
// Sections are checked first so an ID on a whole list can never be mistaken
// for one on an item inside it.
export function findBlockRange(
  sections: SectionInfo[],
  listItems: ListItemInfo[],
  blockId: string
): BlockRange | null {
  const section = sections.find((s) => s.id === blockId);
  if (section) {
    return { startLine: section.startLine, endLine: section.endLine, fromListItem: false };
  }
  const item = listItems.find((i) => i.id === blockId);
  if (!item) return null;
  return { ...listItemRange(listItems, item), fromListItem: true };
}

// Widens a list item's own range to cover its nested descendants (spec 002
// FR-006 — Obsidian shows a block reference to an item together with what's
// under it). Descendants come from `parent`, which Obsidian's own docs point
// at for exactly this: an item's `parent` is its parent's start line (negative
// for a root-level item), so a sibling's `parent` is the seed's parent, never
// the seed's start line — which is what keeps siblings out (FR-005).
//
// `seen` guards against malformed input (a self-parenting or cyclic chain)
// making this loop forever.
export function listItemRange(listItems: ListItemInfo[], seed: ListItemInfo): HeadingSection {
  const descendantStarts = new Set<number>([seed.startLine]);
  const visitedItems = new Set<ListItemInfo>([seed]);
  let endLine = seed.endLine;

  // Repeat until no further item joins: a child may appear before its parent
  // in the array, so a single pass could miss part of the chain.
  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    for (const candidate of listItems) {
      if (visitedItems.has(candidate) || !descendantStarts.has(candidate.parent)) continue;
      visitedItems.add(candidate);
      descendantStarts.add(candidate.startLine);
      if (candidate.endLine > endLine) endLine = candidate.endLine;
      addedDescendant = true;
    }
  }
  return { startLine: seed.startLine, endLine };
}

// Removes the block's own leading indentation so it re-renders as the kind of
// thing it is. Without this a sliced nested item (`    - child`) begins with
// four spaces, which CommonMark reads as an INDENTED CODE BLOCK — the reader
// would get a grey box of literal text instead of a bullet (spec 002 FR-007).
//
// Only the first line's exact prefix is removed, so relative nesting survives
// (FR-006). Callers apply this to LIST-ITEM ranges only: a root-level section
// either starts at column 0 or is an indented-style code block whose
// indentation is its meaning (research R3a).
export function dedentBlock(md: string): string {
  const lines = md.split("\n");
  const leadingWhitespace = /^[ \t]*/.exec(lines[0])?.[0] ?? "";
  if (leadingWhitespace === "") return md;
  return lines
    .map((line) => (line.startsWith(leadingWhitespace) ? line.slice(leadingWhitespace.length) : line))
    .join("\n");
}

// Removes the `^id` marker the author wrote to label this block, so it can't
// surface as stray text in the finished book (spec 002 FR-013). Whether real
// Obsidian's renderer would have hidden it is exactly the kind of behavior the
// stub can't model (docs/DEVELOPMENT.md), so this makes it unconditional.
//
// Scoped to the ONE resolved id, never a generic caret pattern: an embedded
// code block can legitimately contain `^` tokens (regex, exponent, Vim
// notation) and silently editing a reader's code would be a worse defect than
// the stray marker being fixed.
export function stripBlockMarker(md: string, blockId: string): string {
  const escapedId = escapeRegExp(blockId);
  const markerAloneOnLine = new RegExp(`^[ \\t]*\\^${escapedId}[ \\t]*$`);
  const markerAtEndOfLine = new RegExp(`[ \\t]*\\^${escapedId}[ \\t]*$`);

  const keptLines: string[] = [];
  for (const line of md.split("\n")) {
    // A marker sitting alone on its line (how Obsidian labels tables, lists
    // and code blocks) takes the line with it — leaving a blank would split
    // the block it belongs to.
    if (markerAloneOnLine.test(line)) continue;
    // Otherwise it trails the block's own last line (paragraphs, headings).
    keptLines.push(line.replace(markerAtEndOfLine, ""));
  }
  return keptLines.join("\n");
}

// With a reason (a Base that WAS attempted and could not be exported) the message
// says what went wrong; without one it is the general "no EPUB equivalent" text,
// which is all that is true of an inline ```base block.
function basesOmittedMessage(name: string, reason?: string | null): string {
  if (reason) return `bases view omitted: ${name} — ${reason}`;
  return `bases view omitted (interactive Bases have no EPUB equivalent): ${name}`;
}

// Maps a populateEmbeds-stamped data-embed-reason to its warning message.
// No "unsupported-scope" case: every heading/block-suffixed embed now
// attempts real resolution (findHeadingSection/findSupportedBlock above), so
// nothing stamps that reason anymore — see spec.md's Scoped Note Embeds
// feature and its FR-005/FR-006.
function embedOmissionMessage(reason: string | null, name: string, detail?: string | null): string {
  switch (reason) {
    case "render-failed":
      return `embed could not be rendered: ${name}${detail ? ` — ${detail}` : ""}`;
    case "circular":
      return `circular embed skipped: ${name}`;
    case "unsupported-type":
      if (isBasesSrc(name)) return basesOmittedMessage(name, detail);
      return `unsupported embed type (not a note): ${name}`;
    case "heading-not-found":
      return `heading not found: ${name}`;
    case "block-not-found":
      return `block not found: ${name}`;
    default:
      return `missing embed: ${name}`;
  }
}

// Every omission notice is the same paragraph shape: a reader-visible marker
// that also feeds the export's warning summary.
function createOmittedParagraph(text: string): HTMLElement {
  const paragraph = createEl("p");
  paragraph.className = "omitted";
  paragraph.textContent = text;
  return paragraph;
}

// An inline ```base code block is a Bases view too, and Obsidian renders its
// toolbar (buttons, a search <input>, icons) into the DOM even when the render
// target is detached — which is how the export renders. Left alone, that chrome
// goes into the book with no warning. (A .base FILE embed never reaches here:
// flattenEmbeds discards its wrapper's content and leaves a marker.) With the
// Bases core plugin off, Obsidian renders an ordinary <pre><code>, which has no
// such wrapper and is correctly left alone.
function omitBasesBlocks(root: HTMLElement): string[] {
  const warnings: string[] = [];
  root.querySelectorAll(".block-language-base").forEach((block) => {
    block.replaceWith(createOmittedParagraph("[Bases view omitted: inline base block]"));
    warnings.push(basesOmittedMessage("inline base block"));
  });
  return warnings;
}

// Names the feature that was omitted, so a reader-side marker explains why no
// table is there (GitHub issue #2: the generic wording read as a failed export).
function omissionLabel(reason: string | null, name: string): string {
  const wasBasesView = reason === "unsupported-type" && isBasesSrc(name);
  return wasBasesView ? "Bases view omitted" : "embedded content omitted";
}

// The omission marker an embed degrades to when it has no rendered content
// (spec.md Clarifications Q2 — matches the existing missing-image/
// cover-download-failure convention of surfacing degraded content in the
// export's warning summary, not just inline).
function embedOmissionPlaceholder(reason: string | null, name: string): HTMLElement {
  return createOmittedParagraph(`[${omissionLabel(reason, name)}: ${name}]`);
}

// An embed written on its own line renders as `<p><span.internal-embed/></p>`
// — replacing just the wrapper would leave the embedded note's block content
// (divs, headings, lists) inside that <p>, which is invalid XHTML (epubcheck
// RSC-005). When the wrapper is the paragraph's only meaningful child, the
// paragraph itself is the thing to replace. A wrapper with real inline
// siblings (text around an inline embed) is replaced in place — a rare shape
// with a known validity trade-off, preferred over destroying the sibling text.
function embedReplaceTarget(wrapper: Element): Element {
  const parent = wrapper.parentElement;
  if (!parent || parent.tagName.toLowerCase() !== "p") return wrapper;

  const isOnlyMeaningfulChild = Array.from(parent.childNodes).every(
    (node) => node === wrapper || isWhitespaceTextNode(node)
  );
  return isOnlyMeaningfulChild ? parent : wrapper;
}

function isWhitespaceTextNode(node: ChildNode): boolean {
  return node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === "";
}

// Returns any warnings produced while flattening embeds — the caller
// (render-adapter.ts) folds these into the chapter's own warnings, enriching
// them with chapter context this pure module doesn't have.
//
// Both passes are idempotent: a processed wrapper/pair is removed from the
// DOM, so a later call finds nothing left to do.
export function flattenEmbeds(root: HTMLElement): string[] {
  return [...flattenEmbedWrappers(root), ...flattenBareTitlePairs(root)];
}

// Primary pass — wrapper-based (the confirmed real-Obsidian shape, see the
// "Note-embed hardening" comment above): every `.internal-embed` wrapper is
// replaced with the children of the EMBED_RENDERED_ATTR div populateEmbeds
// rendered into it, or with the omission placeholder when populateEmbeds
// deliberately left it unrendered (broken link, unsupported scope, circular
// — the data-embed-reason it stamped picks the message). Everything ELSE
// inside the wrapper — the bare `.embed-title` text, Obsidian's own
// asynchronously-populated `.markdown-embed-content` copy, its "Click to
// create." text for broken links — is discarded with the wrapper, which is
// what makes this immune to the async-population race. Image embeds
// (`![[pic.png]]`) are unwrapped to their bare `<img>` — the wrapper span's
// own `alt`/`src` attributes are invalid XHTML — leaving the img itself for
// rewriteImages. Wrappers are processed innermost-first so an embedded
// note's own nested embeds flatten before their host.
function flattenEmbedWrappers(root: HTMLElement): string[] {
  const warnings: string[] = [];

  for (const wrapper of embedsToFlatten(root)) {
    const warning = flattenEmbedWrapper(wrapper);
    if (warning !== null) warnings.push(warning);
  }

  return warnings;
}

// Document order is outermost-first, so reverse it: an embedded note's own
// nested embeds must flatten before the wrapper that hosts them.
function embedsToFlatten(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll(`.${EMBED_WRAPPER_CLASS}`))
    .filter((wrapper) => {
      // Inside Obsidian's own async-rendered embed preview: discarded
      // wholesale when its host wrapper is replaced — flattening it here
      // would double-count warnings for content that never ships.
      return !wrapper.parentElement?.closest(`.${EMBED_CONTENT_CLASS}`);
    })
    .reverse();
}

// Replaces ONE wrapper with whatever should ship in its place, and returns the
// warning to report — or null when the embed resolved cleanly.
function flattenEmbedWrapper(wrapper: Element): string | null {
  const name = embedDisplayName(wrapper);

  if (isImageEmbedSrc(name)) return unwrapImageEmbed(wrapper, name);

  const renderedContent = wrapper.querySelector(`:scope > [${EMBED_RENDERED_ATTR}]`);
  const replaceTarget = embedReplaceTarget(wrapper);

  if (renderedContent) {
    // replaceWith accepts multiple nodes directly — no document fragment
    // needed (and the plugin review flags document.createDocumentFragment).
    replaceTarget.replaceWith(...Array.from(renderedContent.childNodes));
    return null;
  }

  const reason = wrapper.getAttribute("data-embed-reason");
  replaceTarget.replaceWith(embedOmissionPlaceholder(reason, name));
  return embedOmissionMessage(reason, name, wrapper.getAttribute("data-embed-detail"));
}

// The wrapper's `src` is authoritative (real Obsidian stamps the exact
// linkpath the user wrote on it); `alt`, then a literal "unknown", are the
// fallbacks for a wrapper shape that carries neither.
function embedDisplayName(wrapper: Element): string {
  const name = wrapper.getAttribute("src") ?? wrapper.getAttribute("alt") ?? "unknown";
  return name.trim() || "unknown";
}

// Image embed (`![[pic.png]]`): the wrapper span itself is the problem
// — its `alt`/`src` attributes are invalid on a span in XHTML
// (epubcheck RSC-005, observed on a real-Obsidian export). A resolved
// one is unwrapped to its bare <img> (inheriting the wrapper's alt
// caption — Obsidian puts the caption on the wrapper, not the img); an
// unresolved one (real Obsidian renders "not created yet. Click to
// create." text and no <img>) degrades to the placeholder instead of
// leaking that text into the book.
function unwrapImageEmbed(wrapper: Element, name: string): string | null {
  const image = wrapper.querySelector("img");
  if (image) {
    const caption = wrapper.getAttribute("alt");
    if (caption && !image.getAttribute("alt")) image.setAttribute("alt", caption);
    wrapper.replaceWith(image);
    return null;
  }

  const reason = wrapper.getAttribute("data-embed-reason");
  embedReplaceTarget(wrapper).replaceWith(embedOmissionPlaceholder(reason, name));
  return embedOmissionMessage(reason, name);
}

// Fallback pass — a bare `.markdown-embed-title` + `.markdown-embed-content`
// sibling pair with no wrapper ancestor (never observed from real Obsidian,
// kept as a cheap safety net for renderer variants): unwrap if populated,
// placeholder if empty.
function flattenBareTitlePairs(root: HTMLElement): string[] {
  const warnings: string[] = [];

  root.querySelectorAll(`.${EMBED_TITLE_CLASS}`).forEach((titleElement) => {
    if (titleElement.closest(`.${EMBED_WRAPPER_CLASS}`)) return; // wrapper pass owns it

    const contentElement = titleElement.nextElementSibling;
    // Malformed/unexpected shape (no `.markdown-embed-content` sibling):
    // leave it alone rather than guess at what it meant.
    if (!contentElement || !contentElement.classList.contains(EMBED_CONTENT_CLASS)) return;

    if (contentElement.childNodes.length > 0) {
      // Unwrap: the embedded note's own content already carries whatever
      // title/heading it wants to show, so the bare `.embed-title` text
      // (just the raw link name) is dropped rather than shown twice.
      unwrapContentsIntoParent(contentElement);
    } else {
      const reason = contentElement.getAttribute("data-embed-reason");
      const name = (titleElement.textContent ?? "unknown").trim();
      contentElement.replaceWith(embedOmissionPlaceholder(reason, name));
      warnings.push(embedOmissionMessage(reason, name));
    }
    titleElement.remove();
  });

  return warnings;
}

// Moves `element`'s children up to where `element` itself sat, then drops the
// now-empty element.
function unwrapContentsIntoParent(element: Element): void {
  const parent = element.parentNode;
  for (const child of Array.from(element.childNodes)) parent?.insertBefore(child, element);
  element.remove();
}

export function cleanupDom(root: HTMLElement): string[] {
  normalizeMermaidSvg(root);
  removeRendererChrome(root);
  replaceCheckboxesWithGlyphs(root);
  replaceTagAnchorsWithText(root);

  const warnings = flattenEmbeds(root);
  // AFTER flattenEmbeds, not before: it discards Obsidian's own async-populated
  // preview of each embed (which can hold a base block of its own), and a
  // warning about content that never ships would be noise in the report.
  warnings.push(...omitBasesBlocks(root));
  return warnings;
}

function removeRendererChrome(root: HTMLElement): void {
  for (const selector of CHROME_SELECTORS) {
    root.querySelectorAll(selector).forEach((element) => element.remove());
  }
}

// A task-list item renders as a disabled <input type="checkbox">, which no
// EPUB reader can toggle — swap in the glyph a reader CAN show.
function replaceCheckboxesWithGlyphs(root: HTMLElement): void {
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const isChecked = (input as HTMLInputElement).checked;
    input.replaceWith(document.createTextNode(isChecked ? "☑ " : "☐ "));
  });
}

function replaceTagAnchorsWithText(root: HTMLElement): void {
  // Obsidian renders inline #tags as <a class="tag" href="#tagname" ...>
  // with no data-href, so rewriteLinks's internal-link/data-href check
  // never sees them — they'd otherwise pass through as dead fragment
  // links in the EPUB (epubcheck RSC-012; dead taps on e-ink readers).
  root.querySelectorAll("a.tag").forEach((tagAnchor) => replaceWithPlainTextSpan(tagAnchor));
}

// Drops a link-shaped element but keeps what it said: an internal link with
// nothing to point at is still text the reader should see.
function replaceWithPlainTextSpan(element: Element): void {
  const span = createSpan();
  span.textContent = element.textContent ?? "";
  element.replaceWith(span);
}

export function rewriteLinks(
  root: HTMLElement,
  hrefByPath: Map<string, string>,
  resolve: (linkpath: string) => string | null
): void {
  root.querySelectorAll("a").forEach((anchor) => {
    const dataHref = anchor.getAttribute("data-href");
    const isInternalLink = anchor.classList.contains("internal-link") || dataHref !== null;
    if (!isInternalLink) return; // external link: leave untouched

    const targetPath = dataHref ? resolve(dataHref) : null;
    const chapterHref = targetPath ? hrefByPath.get(targetPath) : undefined;
    if (!chapterHref) {
      replaceWithPlainTextSpan(anchor);
      return;
    }

    // Chapters live side by side in text/, so link by filename only.
    anchor.setAttribute("href", chapterHref.replace(/^text\//, ""));
    anchor.removeAttribute("data-href");
    anchor.removeAttribute("class");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
  });
}

// The vault path an <img> src refers to, or null when the src is malformed
// (a warning is emitted in that case). `scheme` is the src's parsed scheme,
// or undefined for a relative/vault-absolute path. Left UNRESOLVED against the
// vault — the caller resolves it against the source note (render.ts stays
// pure, zero obsidian imports).
function vaultPathFromSrc(
  src: string,
  scheme: string | undefined,
  basePath: string,
  warn?: (message: string) => void
): string | null {
  const pathWithoutQueryOrFragment = src.split(/[?#]/)[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathWithoutQueryOrFragment);
  } catch {
    // Malformed URI (e.g., literal % in filename): skip this image, but
    // say so — the src stays as it was, which no reader can open.
    warn?.(`malformed image reference skipped: ${src}`);
    return null;
  }

  if (scheme !== "app") {
    // Relative or vault-absolute markdown image path (not app://-resolved).
    return decodedPath;
  }

  // 008-mobile-support — INVARIANT: the empty check is NOT redundant with
  // `basePathIndex === -1`. `"anything".indexOf("")` returns 0, not -1, so an
  // empty basePath takes the "found at position 0" branch, slices off nothing,
  // and hands the caller the entire `app://…` URL as a vault path — the
  // exact failure the fallback below was written to prevent. An empty
  // basePath is not exotic: main.ts produces it whenever the vault adapter
  // is not a FileSystemAdapter, which is EVERY export on Obsidian mobile.
  const basePathIndex = basePath === "" ? -1 : decodedPath.indexOf(basePath);
  if (basePathIndex === -1) {
    // Path doesn't contain the given basePath (multi-vault, symlinked
    // attachment folders, path-case differences). Fall through with just
    // the basename so the caller's fuzzy resolver (getFirstLinkpathDest)
    // gets a chance, and failing that, the missing-image warning fires —
    // every image ends up either embedded or warned, never silently
    // left as a broken app:// href.
    return decodedPath.split("/").pop() ?? decodedPath;
  }
  return decodedPath.slice(basePathIndex + basePath.length).replace(/^\//, "");
}

// An <img> src already produced by this function on an earlier pass.
// Idempotence guard: it matches only what we ourselves emit, not an arbitrary
// note-relative "../images/..." reference from a sibling folder.
const ALREADY_REWRITTEN_IMAGE_SRC = /^\.\.\/images\/img_\d+\.[a-z0-9]+$/i;

// What to do with one <img> src. The parsed scheme travels with the decision
// so the caller doesn't have to parse the src a second time.
type ImageSrcDecision = { action: "leave" } | { action: "rewrite"; scheme: string | undefined };

function decideImageSrc(src: string): ImageSrcDecision {
  // Missing/empty src: nothing to resolve, nothing to warn about.
  if (src === "") return { action: "leave" };
  // Protocol-relative (scheme-less): leave completely untouched.
  if (/^\/\//.test(src)) return { action: "leave" };
  // Any other scheme (http:, https:, data:, blob:, file:, mailto:, ...)
  // except our own "app://" internal-resource scheme: leave untouched.
  // Case-insensitive per RFC 3986 (scheme names are not case sensitive).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1].toLowerCase();
  if (scheme && scheme !== "app") return { action: "leave" };
  if (ALREADY_REWRITTEN_IMAGE_SRC.test(src)) return { action: "leave" };
  return { action: "rewrite", scheme };
}

// Every image asset in a book lives at images/img_NNN.<ext>; the shared
// numbering keeps two chapters' images, and rasterized diagrams, from
// colliding with each other.
function numberedImageHref(imageNumber: number, extension: string): string {
  return `../images/img_${String(imageNumber).padStart(3, "0")}.${extension}`;
}

export function rewriteImages(
  root: HTMLElement,
  basePath: string,
  startIndex = 0,
  warn?: (message: string) => void
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];

  root.querySelectorAll("img").forEach((image) => {
    const src = image.getAttribute("src") ?? "";
    const decision = decideImageSrc(src);
    if (decision.action === "leave") return;

    const vaultPath = vaultPathFromSrc(src, decision.scheme, basePath, warn);
    if (vaultPath === null) return;

    const extension = /\.(\w+)$/.exec(vaultPath)?.[1].toLowerCase() ?? "png";
    // startIndex offsets numbering so images from different chapters in the
    // same export never collide (each call only sees one chapter's <img>s).
    const newHref = numberedImageHref(startIndex + found.length + 1, extension);
    found.push({ vaultPath, newHref });
    image.setAttribute("src", newHref);
    if (!image.getAttribute("alt")) image.setAttribute("alt", "");
  });

  return found;
}

export function serializeBody(root: HTMLElement): string {
  if (root.childNodes.length === 0) return "";

  // Serialize the root element once (includes xmlns handling).
  const serializedRoot = new XMLSerializer().serializeToString(root);

  // Strip root's opening and closing tags positionally (not regex).
  // First ">" ends root's start tag, last "</" starts root's close tag.
  const innerXml = serializedRoot.slice(serializedRoot.indexOf(">") + 1, serializedRoot.lastIndexOf("</"));

  // Normalize <br /> to <br/>.
  return innerXml.replace(/ \/>/g, "/>");
}

// ── Mermaid rasterization (Round 3) ───────────────────────────────────────
//
// The prior rounds (normalizeMermaidSvg above) made mermaid SVGs spec-valid
// (epubcheck: 0 errors). That's not enough for every device: at least one
// e-ink reader (Onyx Boox / Neo Reader 3) doesn't render inline SVG inside
// EPUB XHTML at all, while plain raster <img> assets are proven to work on
// it. The fix is to rasterize each normalized mermaid SVG to a PNG at export
// time and embed it as a normal image, falling back to the (still
// spec-valid) inline SVG when rasterization isn't possible.
//
// This lives HERE rather than in src/render-adapter.ts (where an earlier
// draft of this feature placed it) for the same reason rewriteImages leaves
// vault-path resolution to its caller: render-adapter.ts imports real
// VALUES from "obsidian" (App, Component, MarkdownRenderer, TFile), and
// "obsidian" ships type declarations only, no runtime JS. Anything that
// imports render-adapter.ts outside vitest's "obsidian" alias crashes with
// "Cannot find module 'obsidian'" (verified directly: a plain `tsx` run of a
// one-line script importing renderUnitToChapter throws exactly that).
// scripts/verify-real-mermaid.ts needs to exercise the DEFAULT rasterizer's
// fallback behavior (no canvas under jsdom) without going through Obsidian,
// so the rasterizer plumbing stays in this obsidian-free module.
// render-adapter.ts re-exports `setSvgRasterizer`/`SvgRasterizer` and wires
// `rasterizeMermaidDiagrams` into `renderUnitToChapter`.

export type SvgRasterizer = (
  svg: SVGSVGElement
) => Promise<{ bytes: Uint8Array; width: number; height: number } | null>;

const RASTER_SCALE = 2;
const MAX_CANVAS_DIM = 4096;

// The canvas size to rasterize at: RASTER_SCALE, unless that would push either
// axis past MAX_CANVAS_DIM, in which case the diagram is scaled down just far
// enough to fit. Never below 1px, so a degenerate svg can't produce a
// zero-width canvas that throws on drawImage.
function canvasSizeForDiagram(cssWidth: number, cssHeight: number): { width: number; height: number } {
  let scale = RASTER_SCALE;
  if (cssWidth * scale > MAX_CANVAS_DIM || cssHeight * scale > MAX_CANVAS_DIM) {
    scale = Math.min(MAX_CANVAS_DIM / cssWidth, MAX_CANVAS_DIM / cssHeight);
  }
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

// Resolves true once the image has decoded, false when the browser refuses it.
// Never rejects: to the caller this is a fallback, not an error.
function loadImageFromUrl(image: HTMLImageElement, url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

// PNG data URL -> raw PNG bytes; null when the URL carries no base64 payload.
function pngBytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const payloadStart = dataUrl.indexOf(",");
  if (payloadStart === -1) return null;

  const binary = atob(dataUrl.slice(payloadStart + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Real (Electron-renderer) rasterizer: serialize -> Blob URL -> Image ->
// canvas -> PNG bytes. Returns null on ANY failure instead of throwing —
// callers treat null as "keep the inline SVG fallback", not an export error.
async function defaultRasterizeSvg(
  svg: SVGSVGElement
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const cssWidth = parseFloat(svg.getAttribute("width") ?? "") || 0;
  const cssHeight = parseFloat(svg.getAttribute("height") ?? "") || 0;
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  const canvasSize = canvasSizeForDiagram(cssWidth, cssHeight);

  let blobUrl: string | null = null;
  try {
    const serializedSvg = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serializedSvg], { type: "image/svg+xml" });
    blobUrl = URL.createObjectURL(blob);

    const image = new Image();
    const loaded = await loadImageFromUrl(image, blobUrl);
    if (!loaded) return null;

    const canvas = createEl("canvas");
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;
    const context = canvas.getContext("2d");
    if (!context) return null; // jsdom (no "canvas" package installed): no 2d context

    // Fill white first: e-ink readers, and PNG would otherwise be transparent.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);
    context.drawImage(image, 0, 0, canvasSize.width, canvasSize.height);

    const bytes = pngBytesFromDataUrl(canvas.toDataURL("image/png"));
    if (bytes === null) return null;

    // Report the CSS size, not the canvas size: the PNG is embedded at the
    // size the diagram was authored at (its own scale is carried by the file).
    return { bytes, width: cssWidth, height: cssHeight };
  } catch {
    return null;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

let svgRasterizer: SvgRasterizer = defaultRasterizeSvg;

/**
 * The contract is "null on failure", but an injected rasterizer (or a browser
 * API under it) may throw instead. Either way the caller keeps the inline SVG
 * and warns — a diagram must never cost the chapter it sits in.
 */
export async function rasterizeOrNull(
  rasterize: SvgRasterizer,
  svg: SVGSVGElement
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    return await rasterize(svg);
  } catch {
    return null;
  }
}

/** Install a deterministic rasterizer for tests. `null` restores the default (real) one. */
export function setSvgRasterizer(rasterizer: SvgRasterizer | null): void {
  svgRasterizer = rasterizer ?? defaultRasterizeSvg;
}

/** Read the currently-installed rasterizer (used by math.ts's renderMath). */
export function getSvgRasterizer(): SvgRasterizer {
  return svgRasterizer;
}

export interface RasterizedMermaidImage {
  newHref: string;
  bytes: Uint8Array;
  mediaType: string;
}

// Finds every mermaid diagram in `root` (div.mermaid > svg — the shape a
// real Obsidian export produces, see tests/fixtures/mermaid-real.xhtml —
// plus a defensive svg.mermaid-with-no-wrapper-div variant) and rasterizes
// each one via the currently-installed rasterizer. A diagram that rasterizes
// successfully has its whole div.mermaid replaced with a <p><img></p>
// (numbered starting at startIndex+1, continuing rewriteImages's numbering
// so the two compose); one that doesn't is left exactly as-is (the
// spec-valid inline-SVG fallback), and a single warning is emitted per
// chapter no matter how many diagrams in it fell back.
// Obsidian's vault-trust gate for Mermaid (observed on a real 2026-07
// export): when the vault hasn't been allowed to render Mermaid, the
// diagram renders as guard UI instead of an svg —
//   <div class="mermaid-wrapper is-guarded">
//     <div class="mermaid-guard-header">…"Display Mermaid diagrams in this
//       vault?" text and an <button>Allow</button>…</div>
//     <div class="mermaid-guard-source"><pre class="language-mermaid">…</pre></div>
//   </div>
// Serializing that verbatim ships an inert "Allow" button into the book. Keep
// the readable part (the highlighted source fence), drop the UI chrome, and
// return the warning telling the user how to get the real diagram — or null
// when there was no guarded wrapper.
function unguardMermaidWrappers(root: HTMLElement): string | null {
  const guarded = root.querySelectorAll(".mermaid-wrapper.is-guarded");
  if (guarded.length === 0) return null;
  guarded.forEach((wrapper) => {
    const source = wrapper.querySelector(".mermaid-guard-source pre");
    if (source) wrapper.replaceWith(source);
    else wrapper.remove();
  });
  return "mermaid diagram not rendered: Obsidian hasn't been allowed to display Mermaid in this vault — open the note in reading view, click Allow on the diagram, then re-export";
}

// Every mermaid diagram in the chapter: div.mermaid (the shape a real Obsidian
// export produces, see tests/fixtures/mermaid-real.xhtml) plus a defensive
// svg.mermaid-with-no-wrapper-div variant.
function mermaidHosts(root: HTMLElement): Element[] {
  const hosts: Element[] = [];
  root.querySelectorAll("div.mermaid").forEach((div) => hosts.push(div));
  root.querySelectorAll("svg.mermaid").forEach((svg) => {
    if (!svg.closest("div.mermaid")) hosts.push(svg);
  });
  return hosts;
}

// Replaces a rasterized diagram's host with its PNG and returns the image the
// caller numbers into the chapter.
function embedRasterizedDiagram(
  host: Element,
  imageNumber: number,
  rasterized: { bytes: Uint8Array; width: number; height: number }
): RasterizedMermaidImage {
  const newHref = numberedImageHref(imageNumber, "png");
  const image = createEl("img");
  image.setAttribute("src", newHref);
  image.setAttribute("alt", "diagram");
  // XHTML's `width` attribute must be an integer (epubcheck RSC-005: "must
  // be a decimal number without any significant digits after the decimal
  // point") — a real mermaid svg's width is fractional (e.g.
  // "774.8046875"), so round it. Omit the attribute entirely rather than
  // writing "NaN" if the width is missing/non-finite.
  if (Number.isFinite(rasterized.width)) {
    image.setAttribute("width", String(Math.round(rasterized.width)));
  }
  const paragraph = createEl("p");
  paragraph.appendChild(image);
  host.replaceWith(paragraph);
  return { newHref, bytes: rasterized.bytes, mediaType: "image/png" };
}

// Finds every mermaid diagram in `root` and rasterizes each one via the
// currently-installed rasterizer. A diagram that rasterizes successfully has
// its whole host replaced with a <p><img></p> (numbered starting at
// startIndex+1, continuing rewriteImages's numbering so the two compose); one
// that doesn't is left exactly as-is (the spec-valid inline-SVG fallback), and
// a single warning is emitted per chapter no matter how many diagrams in it
// fell back.
export async function rasterizeMermaidDiagrams(
  root: HTMLElement,
  startIndex: number
): Promise<{ images: RasterizedMermaidImage[]; warnings: string[] }> {
  const images: RasterizedMermaidImage[] = [];
  const warnings: string[] = [];
  let fallbackWarned = false;

  const guardWarning = unguardMermaidWrappers(root);
  if (guardWarning) warnings.push(guardWarning);

  for (const host of mermaidHosts(root)) {
    const svg = mermaidSvgIn(host);
    if (!svg) continue;

    const rasterized = await rasterizeOrNull(svgRasterizer, svg);
    if (rasterized) {
      images.push(embedRasterizedDiagram(host, startIndex + images.length + 1, rasterized));
      continue;
    }

    // ONE warning per chapter, however many of its diagrams fell back.
    if (!fallbackWarned) {
      warnings.push("mermaid rasterization unavailable — kept inline SVG (may not render on e-ink)");
      fallbackWarned = true;
    }
  }

  return { images, warnings };
}

// The diagram's own <svg>: the host itself for the defensive svg.mermaid
// variant, otherwise the svg inside the div.mermaid wrapper.
function mermaidSvgIn(host: Element): SVGSVGElement | null {
  const svg = host.tagName.toLowerCase() === "svg" ? host : host.querySelector("svg");
  return svg as SVGSVGElement | null;
}

// ── Heading-level TOC collection (004-heading-toc) ────────────────────────
//
// The EPUB nav (OEBPS/nav.xhtml) lists chapters; this feature adds each
// chapter's headings as nested sub-entries with fragment links. Anchors are
// generated HERE, in the pure layer, rather than read from the renderer:
// the vitest stub renders via `marked`, which emits bare `<h2>Text</h2>`
// with no id attributes, while real Obsidian adds its own ids with different
// slug rules — relying on either would make stub and production output
// diverge (research R1). Ids are stamped onto the heading elements so the
// serialized chapter body carries the targets nav links into; the entries
// themselves flow to EpubBuilder via ChapterRender.toc.
//
// Depth-0 identity (FR-006): when maxDepth is 0 this function must not even
// be CALLED by the adapter (see render-adapter.ts) — but it is also a safe
// no-op here (returns [] and stamps nothing), so a forgotten call can't
// silently alter chapter bodies.

export interface TocEntry {
  level: number;
  text: string;
  id: string;
}

// Sanitizes heading text into an XML NCName (epubcheck RSC-012 resolves nav
// fragment links; ids must be well-formed XML names and unique per
// document). ASCII letters/digits/underscore/hyphen survive; whitespace
// collapses to "-"; ASCII punctuation is stripped; Unicode letters (e.g.
// Thai) are preserved — they are valid NCNames. The "h-" prefix guards
// against ids that would start with a digit, hyphen, or nothing.
export function sanitizeHeadingId(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    // XML NameChar keeps [a-z0-9_-] plus the U+00A0–U+D7FF Unicode range
    // (Thai and other letters/ideographs); everything else — ASCII
    // punctuation like . , ! ? & < > — is stripped. The hyphen sits at the
    // END of the class: anywhere else (e.g. `_-\u00A0`) JS parses it as a
    // range from "_" and silently drops the Unicode range.
    .replace(/[^a-z0-9\u00A0-\uFFFF_-]/g, "")
    // Removed punctuation often leaves hyphen runs behind ("-&-" -> "--").
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // XML NCName cannot START with a digit or hyphen.
  return /^[a-z\u00A0-\uFFFF_]/.test(cleaned) ? cleaned : `h-${cleaned}`;
}

// A heading's own text for the TOC. A footnote marker inside it is part of the page but
// not of the heading: "Part A" + marker "1" would otherwise become the entry "Part A1" and
// the id "part-a1" (011-footnote-semantics FR-012). Headings without a marker take the
// untouched textContent path, so every existing book's TOC is unchanged.
function headingText(heading: Element): string {
  if (!heading.querySelector("sup.footnote-ref")) return (heading.textContent ?? "").trim();

  // Clone before stripping: the marker must vanish from the collected TEXT
  // without being removed from the rendered page.
  const clone = heading.cloneNode(true) as Element;
  clone.querySelectorAll("sup.footnote-ref").forEach((marker) => marker.remove());
  return (clone.textContent ?? "").trim();
}

// Sanitizes `text` into an id, then suffixes "-2", "-3", ... until it is one
// the document isn't already using (a duplicate id is an invalid book).
function uniqueHeadingId(text: string, usedIds: Set<string>): string {
  const baseId = sanitizeHeadingId(text);
  let id = baseId;
  for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}-${suffix}`;
  return id;
}

export function collectHeadingToc(root: HTMLElement, maxDepth: number): TocEntry[] {
  // Depth 0 means "no heading entries at all". Returning before anything is
  // read or stamped keeps that identity promise from the comment above true
  // even for a caller that forgets not to call this.
  if (maxDepth <= 0) return [];

  // Seeded with ids already on NON-heading elements (the footnote pass mints fn-N /
  // fnref-N ids before this runs), so a heading whose text sanitizes to one of them is
  // renamed instead of producing a duplicate id — an invalid book. Where nothing clashes
  // this changes nothing, so existing output is byte-identical.
  const usedIds = new Set<string>();
  for (const element of Array.from(root.querySelectorAll("[id]"))) {
    if (!/^h[1-6]$/i.test(element.tagName)) usedIds.add(element.id);
  }

  const entries: TocEntry[] = [];
  const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));

  for (const [headingIndex, heading] of headings.entries()) {
    // A heading inside a footnote is part of a note, not of the chapter's outline
    // (011-footnote-semantics FR-012: the notes section adds nothing to the TOC).
    if (heading.closest(".footnotes")) continue;

    const level = parseInt(heading.tagName.slice(1), 10);
    if (level > maxDepth) continue;

    // The chapter's first heading, when it is an H1, is its title — the
    // nav already lists the chapter itself, so the H1 would be a duplicate
    // entry (FR-004).
    if (headingIndex === 0 && level === 1) continue;

    const text = headingText(heading);
    if (text === "") continue;

    const id = uniqueHeadingId(text, usedIds);
    usedIds.add(id);
    heading.setAttribute("id", id);
    entries.push({ level, text, id });
  }

  return entries;
}
