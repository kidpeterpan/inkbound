// DOM hygiene and serialization: the last stops before a chapter's body is
// serialized to XHTML — renderer chrome removal, task-list glyphs, dead
// fragment links (tags), embed flattening, and the outerHTML-to-inner-XML
// serialization itself.
//
// Part of the pure rendering library (see render/index.ts for the module map and
// the zero-"obsidian"-import constraint).
import { normalizeMermaidSvg } from "./svg";
import { flattenEmbeds, omitBasesBlocks } from "./embeds";

export const CHROME_SELECTORS = [
  ".edit-block-button",
  ".copy-code-button",
  ".collapse-indicator",
  ".markdown-preview-pusher",
  ".mod-frontmatter",
  ".frontmatter",
  ".metadata-container",
];

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
export function replaceWithPlainTextSpan(element: Element): void {
  const span = createSpan();
  span.textContent = element.textContent ?? "";
  element.replaceWith(span);
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
