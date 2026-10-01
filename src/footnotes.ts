// Footnote handling for the export pipeline (011-footnote-semantics).
//
// PURE MODULE — no `obsidian` import, needs only a DOM (Constitution Principle IV), so
// vitest loads it directly. It falls under Principle IV's rule for pure modules; the
// constitution's list of examples is not exhaustive.
//
// The DOM shapes handled here are Obsidian's own, captured from a live 1.13.7 and kept
// in tests/fixtures/footnotes-real*.html; the design and its evidence are in
// specs/011-footnote-semantics/{research.md,contracts/footnote-markup.md}. In short:
// Obsidian renders each footnote as a marker (`sup.footnote-ref > a`) plus a note in a
// `section.footnotes > ol > li`, once PER RENDER — so a chapter with embeds holds several
// sections, each numbered from 1 — with ids carrying a random per-render suffix. This
// module gathers them into one section of EPUB 3 notes with deterministic ids.
//
// Two halves, because Obsidian destroys orphan footnotes BEFORE the DOM exists (a dangling
// `[^x]` renders as the bare text "x"; an unused definition is not rendered at all):
//   - the SOURCE half (`scanFootnoteSource`) reads a note's markdown, the only place a real
//     problem is still visible;
//   - the DOM half (`processFootnotes`) rewrites what survived, and degrades defensively
//     if a renderer ever does hand it an orphan.

export interface FootnoteSourceScan {
  orphanRefs: string[];
  unusedDefs: string[];
}

// ── strings ──────────────────────────────────────────────────────────────────

// [^label] (no whitespace or ']' in the label) and simple, non-nested ^[inline note].
const FOOTNOTE_REF_SOURCE = /\[\^[^\]\s]+\]|\^\[[^\]]*\]/;

// Obsidian's metadata cache keeps a heading's SOURCE text, so "Title[^h]" would reach the
// book as a literal title. Returns the input untouched unless a reference was present —
// the byte-identical path for every ordinary heading.
export function stripFootnoteRefs(text: string): string {
  if (!FOOTNOTE_REF_SOURCE.test(text)) return text;
  return text
    .replace(new RegExp(FOOTNOTE_REF_SOURCE.source, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// True when a serialized chapter body carries footnote markup. Matches an attribute
// inside a tag, not prose that happens to mention the attribute.
export function usesFootnoteMarkup(body: string): boolean {
  return /<a\b[^<>]*\srole="doc-noteref"/.test(body);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:/;
const REFERENCE = /\[\^([^\]\s]+)\]/g;

function referencesIn(text: string): string[] {
  const withoutCode = text.replace(/(`+)[^`]+\1/g, "");
  return Array.from(withoutCode.matchAll(REFERENCE), (m) => m[1].toLowerCase());
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

// Finds footnote problems in a note's markdown: references with no definition and
// definitions nothing refers to. Labels are compared case-insensitively (Obsidian
// lowercases them) and returned lowercased, de-duplicated, in first-appearance order.
// Fenced, indented and inline code are ignored; simple inline `^[…]` notes are neither.
export function scanFootnoteSource(markdown: string): FootnoteSourceScan {
  const defined: string[] = [];
  const referenced: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // An indented line is a definition's continuation (not code) when the last block began
  // with a definition; otherwise, after a blank line, it opens an indented code block.
  let inDefinition = false;
  let inCode = false;
  let previousBlank = true;

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE.exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        line.slice(close[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      inDefinition = false;
      previousBlank = false;
      continue;
    }
    if (line.trim() === "") {
      previousBlank = true;
      continue;
    }

    const indented = /^( {4}|\t)/.test(line);
    if (indented && !inDefinition && (previousBlank || inCode)) {
      inCode = true;
      previousBlank = false;
      continue;
    }
    inCode = false;

    let text = line;
    const def = DEFINITION.exec(line);
    if (def) {
      defined.push(def[1].toLowerCase());
      inDefinition = true;
      text = line.slice(def[0].length);
    } else if (!indented) {
      inDefinition = false;
    }
    referenced.push(...referencesIn(text));
    previousBlank = false;
  }

  const definedSet = new Set(defined);
  const referencedSet = new Set(referenced);
  return {
    orphanRefs: unique(referenced.filter((label) => !definedSet.has(label))),
    unusedDefs: unique(defined.filter((label) => !referencedSet.has(label))),
  };
}

// One warning per label, orphans first, each naming the note whose source holds the
// problem — worded like the pipeline's other per-note warnings.
export function footnoteSourceWarnings(scan: FootnoteSourceScan, sourcePath: string): string[] {
  return [
    ...scan.orphanRefs.map(
      (label) => `Footnote [^${label}] is referenced but has no matching note (referenced by ${sourcePath})`
    ),
    ...scan.unusedDefs.map(
      (label) =>
        `Footnote note [^${label}] is never referenced and was left out (referenced by ${sourcePath})`
    ),
  ];
}

// ── DOM ──────────────────────────────────────────────────────────────────────

const BACK_ARROW = "↩︎";
const BLOCK_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "div",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const SNIPPET_LENGTH = 40;

interface Note {
  li: Element;
  markers: Element[];
  number: number;
  id: string;
}

interface ResolvedMarker {
  sup: Element;
  note: Note;
  ordinal: number;
}

function hasClass(el: Element, name: string): boolean {
  return (el.getAttribute("class") ?? "").split(/\s+/).includes(name);
}

function markerAnchor(sup: Element): Element | null {
  const a = sup.querySelector("a");
  const href = a?.getAttribute("href") ?? "";
  return a && href.length > 1 && href.startsWith("#") ? a : null;
}

// A marker is a <sup> that is a footnote reference — the class on the <sup> (Obsidian
// 1.13.7) or on its anchor (the older shape) — with an in-page anchor, that is not already
// one of OUR rewritten markers (`role="doc-noteref"`; keeps the pass idempotent) and that
// holds no other <sup> (of a nested pair, only the innermost is the marker; the outer is
// just a superscript).
function isMarker(sup: Element): boolean {
  if (!hasClass(sup, "footnote-ref") && !sup.querySelector("a.footnote-ref")) return false;
  const anchor = markerAnchor(sup);
  if (!anchor || anchor.getAttribute("role") === "doc-noteref") return false;
  return sup.querySelector("sup") === null;
}

// A note is an `li` directly under `.footnotes > ol` (Obsidian 1.13.7) or directly under
// `.footnotes` (older shape). A list INSIDE a note's content is not another note.
function noteItems(container: Element): Element[] {
  const items: Element[] = [];
  for (const child of Array.from(container.children)) {
    if (child.localName === "li") items.push(child);
    else if (child.localName === "ol") {
      for (const li of Array.from(child.children)) if (li.localName === "li") items.push(li);
    }
  }
  return items;
}

function isProcessed(container: Element): boolean {
  return container.getAttribute("epub:type") === "footnotes";
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: [string, string][],
  text?: string
): HTMLElementTagNameMap[K] {
  // The bare global `createEl` (Obsidian's; polyfilled for tests in obsidian-stub.ts) — the
  // same one render.ts uses — rather than document.createElement, per the plugin-review lint.
  const el = createEl(tag);
  for (const [name, value] of attrs) el.setAttribute(name, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// What a marker with no usable note becomes: the bare label, like Obsidian's own reading
// view shows a dangling reference. The label is the source label when the renderer kept
// it (`data-footref`, except its internal value for inline notes), else the visible text
// with its brackets removed.
function degradeMarker(sup: Element, anchor: Element): void {
  const kept = anchor.getAttribute("data-footref") ?? "";
  const label = kept && !kept.startsWith("[inline") ? kept : (anchor.textContent ?? "").replace(/[[\]]/g, "");
  sup.replaceWith(document.createTextNode(label));
}

// A short, stable description of a note for a warning. Not its id: Obsidian's ids carry a
// random per-render suffix, which would make the same warning read differently each export.
function describeNote(note: Note): string {
  const clone = note.li.cloneNode(true) as Element;
  for (const back of Array.from(clone.querySelectorAll("a.footnote-backref"))) back.remove();
  const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…` : text;
}

// Gathers every note in the chapter into ONE section of EPUB 3 footnotes and rewrites
// each marker to point at it. Returns warnings, like rasterizeMermaidDiagrams does.
//
// Leaves the DOM untouched — and returns [] — when there is no footnote structure, and
// when the chapter has already been processed, so a footnote-free chapter's serialization
// (FR-023) and a second pass (idempotence) are both unaffected. Never throws: a structure
// it cannot make sense of degrades to plain text with a warning (Principle II).
export function processFootnotes(root: HTMLElement): string[] {
  const containers = Array.from(root.querySelectorAll(".footnotes")).filter(
    (c) => !isProcessed(c) && noteItems(c).length > 0
  );
  const markerSups = Array.from(root.querySelectorAll("sup")).filter(isMarker);
  if (containers.length === 0 && markerSups.length === 0) return [];

  const warnings: string[] = [];
  const { notes, byKey } = gatherNotes(containers);
  const mint = createIdMinter(reservedIds(root));
  const { resolved, ambiguousNotes } = matchMarkers(markerSups, byKey, mint, warnings);
  for (const note of notes) {
    if (note.number === 0 && !ambiguousNotes.has(note)) {
      warnings.push(`Footnote note "${describeNote(note)}" has no marker and was left out`);
    }
  }

  rewriteMarkers(resolved, mint);
  appendFootnoteSection(root, notes, containers);
  return warnings;
}

function gatherNotes(containers: Element[]): { notes: Note[]; byKey: Map<string, Note[]> } {
  const notes: Note[] = [];
  const byKey = new Map<string, Note[]>();
  for (const container of containers) {
    for (const li of noteItems(container)) {
      const keys = new Set<string>();
      for (const attr of ["id", "data-footnote-id"]) {
        const v = li.getAttribute(attr);
        if (v) keys.add(v);
      }
      const note: Note = { li, markers: [], number: 0, id: "" };
      notes.push(note);
      for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), note]);
    }
  }
  return { notes, byKey };
}

// Ids held by anything that is NOT part of the footnote structure being
// replaced: the minted ids must not collide with these (a heading titled
// "fn 1" is the realistic case).
function reservedIds(root: HTMLElement): Set<string> {
  const taken = new Set<string>();
  for (const el of Array.from(root.querySelectorAll("[id]"))) {
    if (el.closest(".footnotes") || el.closest("sup.footnote-ref")) continue;
    taken.add(el.getAttribute("id")!);
  }
  return taken;
}

function createIdMinter(taken: Set<string>): (base: string) => string {
  return (base) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-x${n}`;
    taken.add(id);
    return id;
  };
}

// Number notes by first reference, in document order across the whole chapter —
// an embed's markers appear where the embed sits, so its notes are numbered
// there. A marker is only ever tied to a note when exactly ONE note answers to
// its fragment: flattening leaves no boundary between renders, so a fragment
// shared by several notes cannot be attributed, and guessing would silently
// attach a marker to the wrong note.
function matchMarkers(
  markerSups: Element[],
  byKey: Map<string, Note[]>,
  mint: (base: string) => string,
  warnings: string[]
): { resolved: ResolvedMarker[]; ambiguousNotes: Set<Note> } {
  const resolved: ResolvedMarker[] = [];
  const ambiguousNotes = new Set<Note>();
  const ambiguousFragments = new Set<string>();
  let counter = 0;
  for (const sup of markerSups) {
    const anchor = markerAnchor(sup)!;
    const fragment = anchor.getAttribute("href")!.slice(1);
    const candidates = byKey.get(fragment) ?? [];
    if (candidates.length === 1) {
      const note = candidates[0];
      if (note.number === 0) {
        note.number = ++counter;
        note.id = mint(`fn-${note.number}`);
      }
      note.markers.push(sup);
      resolved.push({ sup, note, ordinal: note.markers.length });
    } else if (candidates.length === 0) {
      warnings.push(
        `Footnote marker "${(anchor.textContent ?? "").trim()}" has no matching note and was left as plain text`
      );
      degradeMarker(sup, anchor);
    } else {
      if (!ambiguousFragments.has(fragment)) {
        ambiguousFragments.add(fragment);
        warnings.push(
          `Footnote reference "${fragment}" matches more than one note and was left as plain text`
        );
        for (const note of candidates) ambiguousNotes.add(note);
      }
      degradeMarker(sup, anchor);
    }
  }
  return { resolved, ambiguousNotes };
}

// Markers: a superscript number linking to the note, with the standard semantics.
function rewriteMarkers(resolved: ResolvedMarker[], mint: (base: string) => string): void {
  for (const { sup, note, ordinal } of resolved) {
    for (const name of sup.getAttributeNames()) sup.removeAttribute(name);
    sup.setAttribute("class", "footnote-ref");
    clearChildren(sup);
    sup.appendChild(
      create(
        "a",
        [
          ["id", mint(ordinal === 1 ? `fnref-${note.number}` : `fnref-${note.number}-${ordinal}`)],
          ["href", `#${note.id}`],
          ["role", "doc-noteref"],
          ["epub:type", "noteref"],
        ],
        String(note.number)
      )
    );
  }
}

// Notes: one section, one aside per referenced note, in number order. Every
// source container goes, including any whose notes nothing referred to.
function appendFootnoteSection(root: HTMLElement, notes: Note[], containers: Element[]): void {
  const referenced = notes.filter((n) => n.number > 0).sort((a, b) => a.number - b.number);
  const asides = referenced.map(buildAside);
  for (const container of containers) container.remove();
  if (asides.length === 0) return;
  const section = create("section", [
    ["class", "footnotes"],
    ["epub:type", "footnotes"],
  ]);
  for (const aside of asides) section.appendChild(aside);
  root.appendChild(section);
}

function buildAside(note: Note): HTMLElement {
  const aside = create("aside", [
    ["id", note.id],
    ["class", "footnote"],
    ["epub:type", "footnote"],
    ["role", "doc-footnote"],
  ]);

  // Obsidian's own back-links are replaced by ours (distinguishable, deterministic).
  for (const back of Array.from(note.li.querySelectorAll("a.footnote-backref"))) back.remove();

  // An inline note (`^[…]`) has no block children: its text and marks sit directly in the
  // li. Wrap them so every note is made of blocks and has somewhere to put the back-links.
  const isBlockNote = Array.from(note.li.children).some((c) => BLOCK_TAGS.has(c.localName));
  if (isBlockNote) {
    while (note.li.firstChild) aside.appendChild(note.li.firstChild);
  } else {
    const p = createEl("p");
    while (note.li.firstChild) p.appendChild(note.li.firstChild);
    aside.appendChild(p);
  }

  // The visible number leads the note's first block; if that block is not a paragraph, it
  // gets a paragraph of its own so the number is never glued into a list or code block.
  const number = create("span", [["class", "footnote-num"]], `${note.number}.`);
  const first = Array.from(aside.children)[0];
  if (first && first.localName === "p") {
    first.insertBefore(document.createTextNode(" "), first.firstChild);
    first.insertBefore(number, first.firstChild);
  } else {
    const p = createEl("p");
    p.appendChild(number);
    aside.insertBefore(p, aside.firstChild);
  }

  // Back-links go on the LAST paragraph (added if the note ends in some other block).
  let last = Array.from(aside.children).pop()!;
  if (last.localName !== "p") {
    last = createEl("p");
    aside.appendChild(last);
  }
  note.markers.forEach((_marker, i) => {
    last.appendChild(
      create(
        "a",
        [
          ["class", "footnote-backref"],
          ["href", `#${markerId(note, i)}`],
          ["role", "doc-backlink"],
        ],
        note.markers.length === 1 ? BACK_ARROW : `${BACK_ARROW}${i + 1}`
      )
    );
  });
  return aside;
}

// The id a note's i-th marker was given (kept in step with the marker rewrite above).
function markerId(note: Note, i: number): string {
  const a = note.markers[i].querySelector("a");
  return a!.getAttribute("id")!;
}
