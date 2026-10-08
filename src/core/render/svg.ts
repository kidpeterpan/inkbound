// Mermaid/inline-SVG normalization: converts HTML-in-SVG labels
// (foreignObject) into real SVG <text>, and makes every diagram's element
// ids unique per chapter so multiple diagrams in one XHTML document don't
// collide (epubcheck RSC-005).
//
// Part of the pure rendering library (see render/index.ts for the module map and
// the zero-"obsidian"-import constraint). The SVG-namespaced element creation
// below deliberately uses document.createElementNS, not the ambient createEl:
// createEl cannot set the SVG namespace, and SVG text created in the wrong
// namespace serializes (and renders) incorrectly.
import { escapeRegExp } from "../common/regex";

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
