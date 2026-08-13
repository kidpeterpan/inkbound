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

const CHROME_SELECTORS = [
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
function collectForeignObjectLines(fo: Element): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = (): void => {
    const t = current.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
    current = "";
  };
  const walk = (node: ChildNode): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      flush();
      return;
    }
    const isBlock = FOREIGN_OBJECT_BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    Array.from(el.childNodes).forEach(walk);
    if (isBlock) flush();
  };
  Array.from(fo.childNodes).forEach(walk);
  flush();
  return lines;
}

// Converts every <foreignObject> under one mermaid <svg> into a real SVG
// <text> (or removes it, if it turns out to be an empty label placeholder).
// foreignObject/HTML-in-SVG is what e-ink EPUB readers refuse to render, and
// a <p> nested inside a <span> inside it is invalid XHTML (epubcheck RSC-005
// "element p not allowed here") — flattening to <text>/<tspan> fixes both.
function normalizeForeignObjects(svg: SVGElement): void {
  svg.querySelectorAll("foreignObject").forEach((fo) => {
    const width = parseFloat(fo.getAttribute("width") ?? "") || 0;
    const height = parseFloat(fo.getAttribute("height") ?? "") || 0;
    const lines = collectForeignObjectLines(fo);
    if (lines.length === 0) {
      // Empty edge-label placeholder (mermaid emits height="0" width="0"
      // with no text for edges that have no label) — contributes nothing.
      fo.remove();
      return;
    }
    // createElementNS is required here: createElement would place the node
    // in the XHTML namespace and it would serialize (and render) wrong.
    const text = document.createElementNS(SVG_NS, "text");
    const x = width / 2;
    const y = height / 2;
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(x));
      tspan.setAttribute("dy", i === 0 ? "0" : "1.2em");
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    fo.replaceWith(text);
  });
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
  const withIds: Element[] = [];
  if (svg.hasAttribute("id")) withIds.push(svg);
  svg.querySelectorAll("[id]").forEach((el) => withIds.push(el));

  const idMap = new Map<string, string>();
  for (const el of withIds) {
    const oldId = el.getAttribute("id");
    if (oldId && !idMap.has(oldId)) idMap.set(oldId, `${prefix}${oldId}`);
  }
  if (idMap.size === 0) return;

  for (const el of withIds) {
    const oldId = el.getAttribute("id");
    if (oldId) el.setAttribute("id", idMap.get(oldId)!);
  }

  const allElements: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
  for (const el of allElements) {
    for (const attr of Array.from(el.attributes)) {
      const { name, value } = attr;
      if (!value) continue;
      let newValue = value;
      if (newValue.includes("url(#")) {
        newValue = newValue.replace(/url\(#([^)'"]+)\)/g, (whole, id: string) => {
          const mapped = idMap.get(id);
          return mapped ? `url(#${mapped})` : whole;
        });
      }
      if ((name === "href" || name.endsWith(":href")) && newValue.startsWith("#")) {
        const mapped = idMap.get(newValue.slice(1));
        if (mapped) newValue = `#${mapped}`;
      }
      if (newValue !== value) el.setAttribute(name, newValue);
    }
  }

  svg.querySelectorAll("style").forEach((style) => {
    const rewritten = rewriteStyleIds(style.textContent ?? "", idMap);
    if (rewritten !== style.textContent) style.textContent = rewritten;
  });
}

// Mermaid diagrams live in div.mermaid > svg, but this handles any inline
// svg in the export. Give each one a stable 1-based document-order index so
// its ids never collide with a sibling diagram's ids in the same chapter.
export function normalizeMermaidSvg(root: HTMLElement): void {
  root.querySelectorAll("svg").forEach((svg, index) => {
    normalizeForeignObjects(svg);
    prefixIds(svg, `m${index + 1}_`);
  });
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
  const blockIdx = raw.indexOf("^");
  const hashIdx = raw.indexOf("#");
  const cutIdx = [blockIdx, hashIdx].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const linkpath = cutIdx === undefined ? raw : raw.slice(0, cutIdx);
  const heading = hashIdx !== -1 && hashIdx === cutIdx ? raw.slice(hashIdx + 1) : null;
  const block = blockIdx !== -1 && blockIdx === cutIdx ? raw.slice(blockIdx + 1) : null;
  return { raw, linkpath, heading, block };
}

/** True when an embed wrapper's src targets an image, not a note. */
export function isImageEmbedSrc(src: string): boolean {
  return EMBED_IMAGE_EXT.test(src.trim());
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
  const needle = target.trim().toLowerCase();
  const matchIndex = headings.findIndex((h) => h.heading.trim().toLowerCase() === needle);
  if (matchIndex === -1) return null;

  const matched = headings[matchIndex];
  const next = headings.slice(matchIndex + 1).find((h) => h.level <= matched.level);
  const endLine = next ? next.line - 1 : totalLines - 1;
  return { startLine: matched.line, endLine };
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
  const seen = new Set<ListItemInfo>([seed]);
  let endLine = seed.endLine;

  // Repeat until no further item joins: a child may appear before its parent
  // in the array, so a single pass could miss part of the chain.
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of listItems) {
      if (seen.has(candidate) || !descendantStarts.has(candidate.parent)) continue;
      seen.add(candidate);
      descendantStarts.add(candidate.startLine);
      if (candidate.endLine > endLine) endLine = candidate.endLine;
      grew = true;
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
  const prefix = /^[ \t]*/.exec(lines[0])![0];
  if (prefix === "") return md;
  return lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l)).join("\n");
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
  const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    md
      .split("\n")
      // A marker sitting alone on its line (how Obsidian labels tables, lists
      // and code blocks) takes the line with it — leaving a blank would split
      // the block it belongs to.
      .filter((l) => !new RegExp(`^[ \\t]*\\^${escaped}[ \\t]*$`).test(l))
      // Otherwise it trails the block's own last line (paragraphs, headings).
      .map((l) => l.replace(new RegExp(`[ \\t]*\\^${escaped}[ \\t]*$`), ""))
      .join("\n")
  );
}

// Maps a populateEmbeds-stamped data-embed-reason to its warning message.
// No "unsupported-scope" case: every heading/block-suffixed embed now
// attempts real resolution (findHeadingSection/findSupportedBlock above), so
// nothing stamps that reason anymore — see spec.md's Scoped Note Embeds
// feature and its FR-005/FR-006.
function embedOmissionMessage(reason: string | null, name: string): string {
  switch (reason) {
    case "circular":
      return `circular embed skipped: ${name}`;
    case "unsupported-type":
      return `unsupported embed type (not a note): ${name}`;
    case "heading-not-found":
      return `heading not found: ${name}`;
    case "block-not-found":
      return `block not found: ${name}`;
    default:
      return `missing embed: ${name}`;
  }
}

// The omission marker an embed degrades to when it has no rendered content
// (spec.md Clarifications Q2 — matches the existing missing-image/
// cover-download-failure convention of surfacing degraded content in the
// export's warning summary, not just inline).
function embedOmissionPlaceholder(name: string): HTMLElement {
  const p = createEl("p");
  p.className = "omitted";
  p.textContent = `[embedded content omitted: ${name}]`;
  return p;
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
  const onlyChild = Array.from(parent.childNodes).every(
    (n) => n === wrapper || (n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim())
  );
  return onlyChild ? parent : wrapper;
}

// Returns any warnings produced while flattening embeds — the caller
// (render-adapter.ts) folds these into the chapter's own warnings, enriching
// them with chapter context this pure module doesn't have.
//
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
//
// Fallback pass — a bare `.markdown-embed-title` + `.markdown-embed-content`
// sibling pair with no wrapper ancestor (never observed from real Obsidian,
// kept as a cheap safety net for renderer variants): unwrap if populated,
// placeholder if empty.
//
// Both passes are idempotent: a processed wrapper/pair is removed from the
// DOM, so a later call finds nothing left to do.
export function flattenEmbeds(root: HTMLElement): string[] {
  const warnings: string[] = [];

  const wrappers = Array.from(root.querySelectorAll(`.${EMBED_WRAPPER_CLASS}`))
    .filter((w) => {
      // Inside Obsidian's own async-rendered embed preview: discarded
      // wholesale when its host wrapper is replaced — flattening it here
      // would double-count warnings for content that never ships.
      return !w.parentElement?.closest(`.${EMBED_CONTENT_CLASS}`);
    })
    .reverse(); // document order is outermost-first; process innermost-first

  for (const wrapper of wrappers) {
    const name =
      (wrapper.getAttribute("src") ?? wrapper.getAttribute("alt") ?? "unknown").trim() || "unknown";

    if (isImageEmbedSrc(name)) {
      // Image embed (`![[pic.png]]`): the wrapper span itself is the problem
      // — its `alt`/`src` attributes are invalid on a span in XHTML
      // (epubcheck RSC-005, observed on a real-Obsidian export). A resolved
      // one is unwrapped to its bare <img> (inheriting the wrapper's alt
      // caption — Obsidian puts the caption on the wrapper, not the img); an
      // unresolved one (real Obsidian renders "not created yet. Click to
      // create." text and no <img>) degrades to the placeholder instead of
      // leaking that text into the book.
      const img = wrapper.querySelector("img");
      if (img) {
        const caption = wrapper.getAttribute("alt");
        if (caption && !img.getAttribute("alt")) img.setAttribute("alt", caption);
        wrapper.replaceWith(img);
      } else {
        embedReplaceTarget(wrapper).replaceWith(embedOmissionPlaceholder(name));
        warnings.push(embedOmissionMessage(wrapper.getAttribute("data-embed-reason"), name));
      }
      continue;
    }

    const ourDiv = wrapper.querySelector(`:scope > [${EMBED_RENDERED_ATTR}]`);
    const target = embedReplaceTarget(wrapper);
    if (ourDiv) {
      const frag = document.createDocumentFragment();
      Array.from(ourDiv.childNodes).forEach((child) => frag.appendChild(child));
      target.replaceWith(frag);
    } else {
      const reason = wrapper.getAttribute("data-embed-reason");
      target.replaceWith(embedOmissionPlaceholder(name));
      warnings.push(embedOmissionMessage(reason, name));
    }
  }

  root.querySelectorAll(`.${EMBED_TITLE_CLASS}`).forEach((titleEl) => {
    if (titleEl.closest(`.${EMBED_WRAPPER_CLASS}`)) return; // wrapper pass owns it
    const contentEl = titleEl.nextElementSibling;
    if (!contentEl || !contentEl.classList.contains(EMBED_CONTENT_CLASS)) return; // malformed/unexpected: leave alone
    if (contentEl.childNodes.length > 0) {
      // Unwrap: the embedded note's own content already carries whatever
      // title/heading it wants to show, so the bare `.embed-title` text
      // (just the raw link name) is dropped rather than shown twice.
      Array.from(contentEl.childNodes).forEach((child) => {
        contentEl.parentNode?.insertBefore(child, contentEl);
      });
      contentEl.remove();
      titleEl.remove();
    } else {
      const reason = contentEl.getAttribute("data-embed-reason");
      const name = (titleEl.textContent ?? "unknown").trim();
      contentEl.replaceWith(embedOmissionPlaceholder(name));
      titleEl.remove();
      warnings.push(embedOmissionMessage(reason, name));
    }
  });

  return warnings;
}

export function cleanupDom(root: HTMLElement): string[] {
  normalizeMermaidSvg(root);
  for (const sel of CHROME_SELECTORS) root.querySelectorAll(sel).forEach((n) => n.remove());
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const glyph = (input as HTMLInputElement).checked ? "☑ " : "☐ ";
    input.replaceWith(document.createTextNode(glyph));
  });
  root.querySelectorAll("a.tag").forEach((a) => {
    // Obsidian renders inline #tags as <a class="tag" href="#tagname" ...>
    // with no data-href, so rewriteLinks's internal-link/data-href check
    // never sees them — they'd otherwise pass through as dead fragment
    // links in the EPUB (epubcheck RSC-012; dead taps on e-ink readers).
    const span = createEl("span");
    span.textContent = a.textContent ?? "";
    a.replaceWith(span);
  });
  return flattenEmbeds(root);
}

export function rewriteLinks(
  root: HTMLElement,
  hrefByPath: Map<string, string>,
  resolve: (linkpath: string) => string | null
): string[] {
  const warnings: string[] = [];
  root.querySelectorAll("a").forEach((a) => {
    const dataHref = a.getAttribute("data-href");
    const isInternal = a.classList.contains("internal-link") || dataHref !== null;
    if (!isInternal) return; // external link: leave untouched
    const targetPath = dataHref ? resolve(dataHref) : null;
    const chapter = targetPath ? hrefByPath.get(targetPath) : undefined;
    if (chapter) {
      // Chapters live side by side in text/, so link by filename only.
      a.setAttribute("href", chapter.replace(/^text\//, ""));
      a.removeAttribute("data-href");
      a.removeAttribute("class");
      a.removeAttribute("target");
      a.removeAttribute("rel");
    } else {
      const span = createEl("span");
      span.textContent = a.textContent ?? "";
      a.replaceWith(span);
    }
  });
  return warnings;
}

export function rewriteImages(
  root: HTMLElement,
  basePath: string,
  startIndex = 0
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // Missing/empty src: nothing to resolve, nothing to warn about.
    if (src === "") return;
    // Protocol-relative (scheme-less): leave completely untouched.
    if (/^\/\//.test(src)) return;
    // Any other scheme (http:, https:, data:, blob:, file:, mailto:, ...)
    // except our own "app://" internal-resource scheme: leave untouched.
    // Case-insensitive per RFC 3986 (scheme names are not case sensitive).
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1].toLowerCase();
    if (scheme && scheme !== "app") return;
    // Already rewritten by a previous pass: idempotence guard. Matches only
    // what this function itself emits, not an arbitrary note-relative
    // "../images/..." reference from a sibling folder.
    if (/^\.\.\/images\/img_\d+\.[a-z0-9]+$/i.test(src)) return;

    let vaultPath: string;
    if (scheme === "app") {
      const noQueryOrFragment = src.split(/[?#]/)[0];
      let decoded: string;
      try {
        decoded = decodeURIComponent(noQueryOrFragment);
      } catch {
        // Malformed URI (e.g., literal % in filename): skip this image.
        return;
      }
      const at = decoded.indexOf(basePath);
      if (at === -1) {
        // Path doesn't contain the given basePath (multi-vault, symlinked
        // attachment folders, path-case differences). Fall through with just
        // the basename so the caller's fuzzy resolver (getFirstLinkpathDest)
        // gets a chance, and failing that, the missing-image warning fires —
        // every image ends up either embedded or warned, never silently
        // left as a broken app:// href.
        vaultPath = decoded.split("/").pop() ?? decoded;
      } else {
        vaultPath = decoded.slice(at + basePath.length).replace(/^\//, "");
      }
    } else {
      // Relative or vault-absolute markdown image path (not app://-resolved).
      // Left UNRESOLVED here — the caller resolves it against the source
      // note (render.ts stays pure, zero obsidian imports).
      const noQueryOrFragment = src.split(/[?#]/)[0];
      try {
        vaultPath = decodeURIComponent(noQueryOrFragment);
      } catch {
        // Malformed URI (e.g., literal % in filename): skip this image.
        return;
      }
    }
    const extMatch = /\.(\w+)$/.exec(vaultPath);
    const ext = extMatch ? extMatch[1].toLowerCase() : "png";
    // startIndex offsets numbering so images from different chapters in the
    // same export never collide (each call only sees one chapter's <img>s).
    const newHref = `../images/img_${String(startIndex + found.length + 1).padStart(3, "0")}.${ext}`;
    found.push({ vaultPath, newHref });
    img.setAttribute("src", newHref);
    if (!img.getAttribute("alt")) img.setAttribute("alt", "");
  });
  return found;
}

export function serializeBody(root: HTMLElement): string {
  // Guard: empty root returns empty string.
  if (root.childNodes.length === 0) return "";

  const s = new XMLSerializer();
  // Serialize the root element once (includes xmlns handling).
  const whole = s.serializeToString(root);

  // Strip root's opening and closing tags positionally (not regex).
  // First ">" ends root's start tag, last "</" starts root's close tag.
  const inner = whole.slice(whole.indexOf(">") + 1, whole.lastIndexOf("</"));

  // Normalize <br /> to <br/>.
  return inner.replace(/ \/>/g, "/>");
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

// Real (Electron-renderer) rasterizer: serialize -> Blob URL -> Image ->
// canvas -> PNG bytes. Returns null on ANY failure instead of throwing —
// callers treat null as "keep the inline SVG fallback", not an export error.
async function defaultRasterizeSvg(
  svg: SVGSVGElement
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const cssWidth = parseFloat(svg.getAttribute("width") ?? "") || 0;
  const cssHeight = parseFloat(svg.getAttribute("height") ?? "") || 0;
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  let scale = RASTER_SCALE;
  if (cssWidth * scale > MAX_CANVAS_DIM || cssHeight * scale > MAX_CANVAS_DIM) {
    scale = Math.min(MAX_CANVAS_DIM / cssWidth, MAX_CANVAS_DIM / cssHeight);
  }
  const canvasWidth = Math.max(1, Math.round(cssWidth * scale));
  const canvasHeight = Math.max(1, Math.round(cssHeight * scale));

  let blobUrl: string | null = null;
  try {
    const serialized = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serialized], { type: "image/svg+xml" });
    blobUrl = URL.createObjectURL(blob);

    const img = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = blobUrl!;
    });
    if (!loaded) return null;

    const canvas = createEl("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null; // jsdom (no "canvas" package installed): no 2d context

    // Fill white first: e-ink readers, and PNG would otherwise be transparent.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    if (comma === -1) return null;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return { bytes, width: cssWidth, height: cssHeight };
  } catch {
    return null;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

let svgRasterizer: SvgRasterizer = defaultRasterizeSvg;

/** Install a deterministic rasterizer for tests. `null` restores the default (real) one. */
export function setSvgRasterizer(fn: SvgRasterizer | null): void {
  svgRasterizer = fn ?? defaultRasterizeSvg;
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
export async function rasterizeMermaidDiagrams(
  root: HTMLElement,
  startIndex: number
): Promise<{ images: RasterizedMermaidImage[]; warnings: string[] }> {
  const images: RasterizedMermaidImage[] = [];
  const warnings: string[] = [];
  let warned = false;

  // Obsidian's vault-trust gate for Mermaid (observed on a real 2026-07
  // export): when the vault hasn't been allowed to render Mermaid, the
  // diagram renders as guard UI instead of an svg —
  //   <div class="mermaid-wrapper is-guarded">
  //     <div class="mermaid-guard-header">…"Display Mermaid diagrams in this
  //       vault?" text and an <button>Allow</button>…</div>
  //     <div class="mermaid-guard-source"><pre class="language-mermaid">…</pre></div>
  //   </div>
  // Serializing that verbatim ships an inert "Allow" button into the book.
  // Keep the readable part (the highlighted source fence), drop the UI
  // chrome, and tell the user how to get the real diagram.
  const guarded = root.querySelectorAll(".mermaid-wrapper.is-guarded");
  if (guarded.length > 0) {
    guarded.forEach((wrapper) => {
      const source = wrapper.querySelector(".mermaid-guard-source pre");
      if (source) wrapper.replaceWith(source);
      else wrapper.remove();
    });
    warnings.push(
      "mermaid diagram not rendered: Obsidian hasn't been allowed to display Mermaid in this vault — open the note in reading view, click Allow on the diagram, then re-export"
    );
  }

  const hosts: Element[] = [];
  root.querySelectorAll("div.mermaid").forEach((div) => hosts.push(div));
  root.querySelectorAll("svg.mermaid").forEach((svg) => {
    if (!svg.closest("div.mermaid")) hosts.push(svg);
  });

  for (const host of hosts) {
    const svg = (
      host.tagName.toLowerCase() === "svg" ? host : host.querySelector("svg")
    ) as SVGSVGElement | null;
    if (!svg) continue;

    const result = await svgRasterizer(svg);
    if (result) {
      const index = startIndex + images.length + 1;
      const newHref = `../images/img_${String(index).padStart(3, "0")}.png`;
      const img = createEl("img");
      img.setAttribute("src", newHref);
      img.setAttribute("alt", "diagram");
      // XHTML's `width` attribute must be an integer (epubcheck RSC-005: "must
      // be a decimal number without any significant digits after the decimal
      // point") — a real mermaid svg's width is fractional (e.g.
      // "774.8046875"), so round it. Omit the attribute entirely rather than
      // writing "NaN" if the width is missing/non-finite.
      if (Number.isFinite(result.width)) {
        img.setAttribute("width", String(Math.round(result.width)));
      }
      const p = createEl("p");
      p.appendChild(img);
      host.replaceWith(p);
      images.push({ newHref, bytes: result.bytes, mediaType: "image/png" });
    } else if (!warned) {
      warnings.push("mermaid rasterization unavailable — kept inline SVG (may not render on e-ink)");
      warned = true;
    }
  }

  return { images, warnings };
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

export function collectHeadingToc(root: HTMLElement, maxDepth: number): TocEntry[] {
  const entries: TocEntry[] = [];
  const used = new Set<string>();
  if (maxDepth <= 0) return entries;
  const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  headings.forEach((el, i) => {
    const level = parseInt(el.tagName.slice(1), 10);
    if (level > maxDepth) return;
    // The chapter's first heading, when it is an H1, is its title — the
    // nav already lists the chapter itself, so the H1 would be a duplicate
    // entry (FR-004).
    if (i === 0 && level === 1) return;
    const text = (el.textContent ?? "").trim();
    if (text === "") return;
    let id = sanitizeHeadingId(text);
    let n = 2;
    while (used.has(id)) id = `${sanitizeHeadingId(text)}-${n++}`;
    used.add(id);
    el.setAttribute("id", id);
    entries.push({ level, text, id });
  });
  return entries;
}
