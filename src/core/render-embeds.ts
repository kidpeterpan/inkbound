// Note-embed finalization: after render-adapter.ts renders its own copy of
// every embedded note (into a div stamped with EMBED_RENDERED_ATTR), these
// functions replace each `.internal-embed` wrapper with what should actually
// ship — the rendered children, an unwrapped image, or an omission marker —
// and produce the warnings those degradations owe the reader.
//
// Part of the pure rendering library (see render.ts for the module map and
// the zero-"obsidian"-import constraint).
import { isBasesSrc, isImageEmbedSrc } from "./render-md";

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
export function omitBasesBlocks(root: HTMLElement): string[] {
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
