// Heading-level TOC collection (004-heading-toc).
//
// Part of the pure rendering library (see render/index.ts for the module map and
// the zero-"obsidian"-import constraint).
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
