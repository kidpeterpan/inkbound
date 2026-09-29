// Shared fixtures and an independent oracle for 011-footnote-semantics.
//
// DELIBERATELY imports nothing from src/. Everything the footnote pass produces is
// judged here by code that shares none of its logic, so a mistake in the pass cannot
// also hide in the check that is meant to catch it.
//
// Framework-agnostic on purpose: the oracle throws plain Errors, so vitest reports a
// violation as a test failure AND scripts/check-export-works.ts (which runs under tsx, with
// no test runner) can call the very same function on the shipped bundle's output.
//
// The markup fixtures are REAL Obsidian 1.13.7 output (see the provenance headers in
// footnotes-real.html and footnotes-real-contexts.html). Loading them — rather than
// hand-writing markup — is what FR-030 requires: the test stand-in renderer has no
// footnote support of its own and must not be the only source of the shape under test.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = __dirname;

/** The markdown footnotes-real.html was rendered from (its header records it too). */
export const FOOTNOTE_SOURCE_MD = [
  "# Title with note[^h]",
  "",
  "Numbered ref[^1] and a named one[^note] and repeated[^1] and inline^[an inline note] text.",
  "",
  "- list item with ref[^3]",
  "",
  "Dangling ref[^nope] here.",
  "",
  "[^1]: First note, para one.",
  "",
  "    Second paragraph of note one.",
  "",
  "[^note]: Named note with [[Some Link]] and **bold**.",
  "[^3]: Third.",
  "[^h]: Heading note.",
  "[^unused]: Never referenced.",
].join("\n");

function stripCapture(html: string): string {
  // Leading provenance comment, then dataview's outer <span> wrapper.
  const noComment = html.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  const m = /^<span>([\s\S]*)<\/span>\s*$/.exec(noComment);
  return (m ? m[1] : noComment).trim();
}

/** Obsidian's real render of FOOTNOTE_SOURCE_MD: the inner HTML only. */
export function loadRealFootnotesHtml(): string {
  return stripCapture(readFileSync(join(FIXTURE_DIR, "footnotes-real.html"), "utf-8"));
}

export type RealContext =
  "table" | "callout" | "blockquote" | "duplicateDefinition" | "sameLabelTwoRefsAndUnusedAfter";

/** One case from the second capture: Obsidian's real render of a single context. */
export function loadRealContextHtml(name: RealContext): string {
  const raw = readFileSync(join(FIXTURE_DIR, "footnotes-real-contexts.html"), "utf-8").replace(
    /^\s*<!--[\s\S]*?-->\s*/,
    ""
  );
  for (const chunk of raw.split(/(?=^<div data-capture=")/m)) {
    const m = /^<div data-capture="(\w+)">([\s\S]*)<\/div>\s*$/.exec(chunk);
    if (m && m[1] === name) return m[2].trim();
  }
  throw new Error(`no captured context named "${name}" in footnotes-real-contexts.html`);
}

export function mountHtml(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

/** Simulates a second render of the same markdown: every 16-hex docId becomes `newId`. */
export function withDocId(html: string, newId: string): string {
  return html.replace(/-[0-9a-f]{16}(?=")/g, `-${newId}`);
}

// ── synthetic shapes (used only where the real renderer cannot produce them) ───────

const DOC = "aaaaaaaaaaaaaaaa";

/** A marker as Obsidian 1.13.7 emits it. `k` > 0 marks a repeated reference. */
export function marker(o: { n: number; k?: number; label?: string; docId?: string; text?: string }): string {
  const doc = o.docId ?? DOC;
  const ref = o.k && o.k > 0 ? `${o.n}-${o.k}` : `${o.n}`;
  return (
    `<sup data-footnote-id="fnref-${ref}-${doc}" class="footnote-ref" id="fnref-${ref}-${doc}">` +
    `<a data-footref="${o.label ?? String(o.n)}" href="#fn-${o.n}-${doc}" class="footnote-link" ` +
    `target="_blank" rel="noopener nofollow">${o.text ?? `[${ref}]`}</a></sup>`
  );
}

/** One note `li` with `refs` identical back-links, as Obsidian 1.13.7 emits it. */
export function noteItem(o: {
  n: number;
  body: string;
  refs?: number;
  docId?: string;
  inline?: boolean;
}): string {
  const doc = o.docId ?? DOC;
  const back = Array.from({ length: o.refs ?? 1 }, (_, i) => {
    const ref = i === 0 ? `${o.n}` : `${o.n}-${i}`;
    return `<a href="#fnref-${ref}-${doc}" class="footnote-backref footnote-link" target="_blank" rel="noopener nofollow">↩︎</a>`;
  }).join("");
  const inner = o.inline ? `${o.body}${back}` : `<p>${o.body}${back}</p>`;
  return `<li data-footnote-id="fn-${o.n}-${doc}" id="fn-${o.n}-${doc}" dir="auto">${inner}</li>`;
}

export function notesSection(items: string[]): string {
  return `<section class="footnotes"><hr><ol>${items.join("")}</ol></section>`;
}

/** The older shape found in Obsidian's own source but unused by the reading view. */
export function olderShapeMarker(n: number): string {
  return `<sup id="fnref-${n}"><a href="#fn-${n}" class="footnote-ref">${n}</a></sup>`;
}
export function olderShapeNotes(items: { n: number; body: string }[]): string {
  const lis = items
    .map(
      (i) => `<li id="fn-${i.n}"><p>${i.body}<a href="#fnref-${i.n}" class="footnote-backref">↩</a></p></li>`
    )
    .join("");
  return `<div class="footnotes"><hr><ol>${lis}</ol></div>`;
}

// ── the oracle ─────────────────────────────────────────────────────────────────

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const EPUB_NS = "http://www.idpf.org/2007/ops";
const FORBIDDEN_ATTRS = ["target", "rel", "data-footref", "data-footnote-id"];

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`footnote invariant violated: ${message}`);
}

/**
 * Parses a chapter as XML. A body FRAGMENT has no root element and no namespace
 * declarations, and an unbound `epub` prefix is a fatal parse error — so a fragment is
 * wrapped first. A full chapter document taken from a zip is parsed as it stands.
 */
export function parseChapterXml(xhtml: string): Document {
  const isDocument = /^\s*(<\?xml|<!DOCTYPE|<html[\s>])/i.test(xhtml);
  const text = isDocument
    ? xhtml
    : `<html xmlns="${XHTML_NS}" xmlns:epub="${EPUB_NS}"><body>${xhtml}</body></html>`;
  const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  const err = doc.getElementsByTagName("parsererror");
  must(err.length === 0, `chapter is not well-formed XML: ${err[0]?.textContent ?? ""}`);
  return doc;
}

export interface FootnoteSummary {
  markers: number;
  notes: number;
}

/**
 * Asserts contract invariants 1-8 (specs/011-footnote-semantics/contracts/
 * footnote-markup.md §2) on a chapter that HAS footnotes, independently of the code that
 * produced it. Throws on the first violation; returns counts so callers can also assert
 * how many there should be.
 */
export function assertChapterFootnoteInvariants(xhtml: string): FootnoteSummary {
  const doc = parseChapterXml(xhtml);
  const all = Array.from(doc.getElementsByTagName("*"));
  const cls = (e: Element) => (e.getAttribute("class") ?? "").split(/\s+/);

  // 3. every id in the chapter is unique
  const ids = all.map((e) => e.getAttribute("id")).filter((v): v is string => v !== null);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  must(dupes.length === 0, `duplicate ids: ${dupes.join(", ")}`);
  const byId = new Map(all.filter((e) => e.getAttribute("id")).map((e) => [e.getAttribute("id")!, e]));

  const refs = all.filter((e) => e.getAttribute("role") === "doc-noteref");
  const asides = all.filter((e) => e.getAttribute("role") === "doc-footnote");
  const backlinks = all.filter((e) => e.getAttribute("role") === "doc-backlink");
  must(refs.length > 0, "chapter has no doc-noteref markers");
  must(asides.length > 0, "chapter has no doc-footnote notes");

  // 1. every marker: semantics, an id, and an href that resolves to exactly one note here
  const refsByNote = new Map<string, Element[]>();
  for (const a of refs) {
    must(a.localName === "a", `a doc-noteref must be an <a>, found <${a.localName}>`);
    must(a.getAttribute("epub:type") === "noteref", "marker lacks epub:type=noteref");
    must(a.getAttribute("id"), "marker lacks an id");
    const href = a.getAttribute("href") ?? "";
    must(href.startsWith("#"), `marker href "${href}" must be a bare fragment`);
    const target = byId.get(href.slice(1));
    must(target, `marker href ${href} resolves to nothing in this chapter`);
    must(target.localName === "aside", `marker ${href} must lead to an <aside>, found <${target.localName}>`);
    must(
      target.getAttribute("role") === "doc-footnote",
      `marker ${href} leads to something that is not a doc-footnote`
    );
    refsByNote.set(href.slice(1), [...(refsByNote.get(href.slice(1)) ?? []), a]);
  }
  for (const a of refs) {
    const sup = a.parentElement;
    must(
      sup && sup.localName === "sup" && cls(sup).includes("footnote-ref"),
      "marker must sit in sup.footnote-ref"
    );
  }

  // 2 + 4 + 5. every note: semantics, id, a back-link per marker, matching number, order
  const sections = all.filter(
    (e) => e.localName === "section" && e.getAttribute("epub:type") === "footnotes"
  );
  must(sections.length === 1, `expected exactly one section[epub:type=footnotes], found ${sections.length}`);
  const section = sections[0];
  let expectedNumber = 0;
  for (const aside of asides) {
    must(aside.getAttribute("epub:type") === "footnote", "note lacks epub:type=footnote");
    const id = aside.getAttribute("id");
    must(id, "note lacks an id");
    must(section.contains(aside), `note ${id} is outside the notes section`);

    const markers = refsByNote.get(id) ?? [];
    must(markers.length > 0, `note ${id} has no marker referring to it`);
    const mine = backlinks.filter((b) => aside.contains(b));
    must(
      mine.length === markers.length,
      `note ${id} needs one back-link per marker (${mine.length} vs ${markers.length})`
    );
    for (const b of mine) {
      const back = byId.get((b.getAttribute("href") ?? "").slice(1));
      must(back, `back-link ${b.getAttribute("href")} resolves to nothing`);
      must(
        markers.includes(back),
        `back-link ${b.getAttribute("href")} does not lead to one of note ${id}'s markers`
      );
    }

    const label = Array.from(aside.getElementsByTagName("span")).find((sp) =>
      cls(sp).includes("footnote-num")
    );
    must(label, `note ${id} has no .footnote-num`);
    expectedNumber += 1;
    must(
      label.textContent!.trim() === `${expectedNumber}.`,
      `note ${id} is out of order: reads "${label.textContent}", expected "${expectedNumber}."`
    );
    for (const m of markers) {
      must(
        m.textContent!.trim() === String(expectedNumber),
        `marker for note ${id} reads "${m.textContent}", expected "${expectedNumber}"`
      );
    }
  }
  must(refsByNote.size === asides.length, "some marker points at something that is not a note");

  // 6. nothing interface-only survives on the footnote's OWN elements (a wikilink or list
  // inside a note's content is ordinary content, judged elsewhere), and none of
  // Obsidian's notes structure is left: the section's children are asides and nothing else.
  const own = [...refs, ...refs.map((a) => a.parentElement!), ...asides, ...backlinks];
  for (const e of own) {
    for (const attr of FORBIDDEN_ATTRS) must(!e.hasAttribute(attr), `<${e.localName}> still carries ${attr}`);
  }
  for (const child of Array.from(section.children)) {
    must(child.localName === "aside", "notes section may hold only asides (no hr / ol / li)");
  }
  must(
    all.filter((e) => cls(e).includes("footnotes")).length === 1,
    "leftover per-render .footnotes container"
  );
  must(
    all.filter((e) => cls(e).includes("footnote-backref") && e.getAttribute("role") !== "doc-backlink")
      .length === 0,
    "back-link without role=doc-backlink"
  );

  return { markers: refs.length, notes: asides.length };
}
