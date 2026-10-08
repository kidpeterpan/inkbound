// Unit tests for src/core/content/footnotes.ts (011-footnote-semantics).
//
// Input is REAL Obsidian 1.13.7 markup wherever it exists (tests/fixtures/footnotes-real.html
// and footnotes-real-contexts.html — FR-030). Synthetic markup, built with the fixture
// helpers, is used only for shapes the real renderer cannot produce (a note referenced
// three times, an orphan, an older Obsidian's shape), and is labelled as such.
//
// Output is judged by tests/fixtures/footnote-fixtures.ts's assertChapterFootnoteInvariants,
// an independent oracle that imports nothing from src/.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processFootnotes } from "../src/core/content/footnotes";
import { serializeBody } from "../src/core/render";
import {
  assertChapterFootnoteInvariants,
  loadRealContextHtml,
  loadRealFootnotesHtml,
  marker,
  mountHtml,
  noteItem,
  notesSection,
  olderShapeMarker,
  olderShapeNotes,
  withDocId,
} from "./fixtures/footnote-fixtures";

function run(html: string): { root: HTMLElement; warnings: string[]; xhtml: string } {
  const root = mountHtml(html);
  const warnings = processFootnotes(root);
  return { root, warnings, xhtml: serializeBody(root) };
}

const attrs = (e: Element): string[] => e.getAttributeNames().sort();
const texts = (root: ParentNode, selector: string): (string | null)[] =>
  Array.from(root.querySelectorAll(selector)).map((e) => e.textContent);

describe("processFootnotes on Obsidian's real render (FR-001, FR-005…FR-011)", () => {
  it("rewrites the real capture into contract-conformant markup", () => {
    const { warnings, xhtml } = run(loadRealFootnotesHtml());
    expect(warnings).toEqual([]);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 6, notes: 5 });
  });

  it("numbers notes 1…5 in first-reference order and mints ids from those numbers alone", () => {
    const { root } = run(loadRealFootnotesHtml());
    const markers = Array.from(root.querySelectorAll("sup.footnote-ref a"));
    expect(markers.map((a) => a.textContent)).toEqual(["1", "2", "3", "2", "4", "5"]);
    expect(markers.map((a) => a.getAttribute("id"))).toEqual([
      "fnref-1",
      "fnref-2",
      "fnref-3",
      "fnref-2-2",
      "fnref-4",
      "fnref-5",
    ]);
    expect(markers.map((a) => a.getAttribute("href"))).toEqual([
      "#fn-1",
      "#fn-2",
      "#fn-3",
      "#fn-2",
      "#fn-4",
      "#fn-5",
    ]);
    expect(Array.from(root.querySelectorAll("aside")).map((a) => a.getAttribute("id"))).toEqual([
      "fn-1",
      "fn-2",
      "fn-3",
      "fn-4",
      "fn-5",
    ]);
  });

  it("emits exactly the contract's attributes on each footnote element", () => {
    const { root } = run(loadRealFootnotesHtml());
    expect(attrs(root.querySelector("sup.footnote-ref")!)).toEqual(["class"]);
    expect(attrs(root.querySelector("sup.footnote-ref a")!)).toEqual(["epub:type", "href", "id", "role"]);
    expect(root.querySelector("sup.footnote-ref a")!.getAttribute("role")).toBe("doc-noteref");
    expect(root.querySelector("sup.footnote-ref a")!.getAttribute("epub:type")).toBe("noteref");
    const aside = root.querySelector("aside")!;
    expect(attrs(aside)).toEqual(["class", "epub:type", "id", "role"]);
    expect(aside.getAttribute("role")).toBe("doc-footnote");
    expect(aside.getAttribute("epub:type")).toBe("footnote");
    const back = root.querySelector("a.footnote-backref")!;
    expect(attrs(back)).toEqual(["class", "href", "role"]);
    expect(back.getAttribute("role")).toBe("doc-backlink");
  });

  it("gathers the notes into one section that is the last thing in the chapter (FR-011)", () => {
    const { root } = run(loadRealFootnotesHtml());
    const section = root.lastElementChild!;
    expect(section.localName).toBe("section");
    expect(section.getAttribute("class")).toBe("footnotes");
    expect(section.getAttribute("epub:type")).toBe("footnotes");
    expect(root.querySelectorAll("section")).toHaveLength(1);
    expect(Array.from(section.children).every((c) => c.localName === "aside")).toBe(true);
  });

  it("leaves no trace of Obsidian's per-render identifiers (FR-008, FR-009)", () => {
    const { root, xhtml } = run(loadRealFootnotesHtml());
    expect(xhtml).not.toMatch(/-[0-9a-f]{16}/);
    expect(root.querySelector("[data-footnote-id]")).toBeNull();
    expect(root.querySelector("[data-footref]")).toBeNull();
    expect(root.querySelector("sup.footnote-ref a[target], a.footnote-backref[target]")).toBeNull();
    expect(root.querySelector("sup.footnote-ref a[rel], a.footnote-backref[rel]")).toBeNull();
    expect(root.querySelector("hr")).toBeNull();
    expect(root.querySelector("ol > li[data-footnote-id]")).toBeNull();
  });

  it("gives the same output for two renders that differ only in their random suffix (FR-008)", () => {
    const first = run(loadRealFootnotesHtml()).xhtml;
    const second = run(withDocId(loadRealFootnotesHtml(), "bbbbbbbbbbbbbbbb")).xhtml;
    expect(second).toBe(first);
  });

  it("recognises the marker inside the heading and inside the list item", () => {
    const { root } = run(loadRealFootnotesHtml());
    expect(root.querySelector("h1 sup.footnote-ref a[role=doc-noteref]")).not.toBeNull();
    expect(root.querySelector("li sup.footnote-ref a[role=doc-noteref]")!.textContent).toBe("5");
  });

  it("numbers each note in the visible label and puts the number before the text", () => {
    const { root } = run(loadRealFootnotesHtml());
    const p = root.querySelector('aside[id="fn-1"] p')!;
    expect(p.firstElementChild!.getAttribute("class")).toBe("footnote-num");
    expect(p.textContent).toBe("1. Heading note.↩︎");
  });
});

describe("processFootnotes: every source form is marked identically (FR-002, FR-005, FR-014)", () => {
  it("marks numbered, named and inline references the same way", () => {
    const { root } = run(loadRealFootnotesHtml());
    const shapes = Array.from(root.querySelectorAll("sup.footnote-ref a")).map((a) => attrs(a).join(","));
    expect(new Set(shapes).size).toBe(1);
  });

  it("wraps an inline note, which Obsidian renders with no <p>, in exactly one <p>", () => {
    const { root } = run(loadRealFootnotesHtml());
    const aside = root.querySelector('aside[id="fn-4"]')!;
    expect(Array.from(aside.children).map((c) => c.localName)).toEqual(["p"]);
    expect(aside.textContent).toBe("4. an inline note↩︎");
  });

  it("keeps a multi-paragraph note as ONE note with its back-links on the last paragraph", () => {
    const { root } = run(loadRealFootnotesHtml());
    const aside = root.querySelector('aside[id="fn-2"]')!;
    const paras = Array.from(aside.querySelectorAll(":scope > p"));
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toBe("2. First note, para one.");
    expect(paras[0].querySelector("a")).toBeNull();
    expect(paras[1].textContent).toBe("Second paragraph of note one.↩︎1↩︎2");
    expect(root.querySelectorAll("aside")).toHaveLength(5);
  });

  it("distinguishes back-links when a note has several references (FR-005)", () => {
    const { root } = run(loadRealFootnotesHtml());
    const back = Array.from(root.querySelectorAll('aside[id="fn-2"] a[role=doc-backlink]'));
    expect(back.map((a) => a.textContent)).toEqual(["↩︎1", "↩︎2"]);
    expect(back.map((a) => a.getAttribute("href"))).toEqual(["#fnref-2", "#fnref-2-2"]);
  });

  it("uses a bare arrow when a note has a single reference", () => {
    const { root } = run(loadRealFootnotesHtml());
    const back = Array.from(root.querySelectorAll('aside[id="fn-1"] a[role=doc-backlink]'));
    expect(back.map((a) => a.textContent)).toEqual(["↩︎"]);
    expect(back[0].getAttribute("href")).toBe("#fnref-1");
  });

  // SYNTHETIC: the real capture stops at two references to one note.
  it("handles a note referred to three times, sharing one number", () => {
    const html =
      `<p>A${marker({ n: 1 })} B${marker({ n: 1, k: 1 })} C${marker({ n: 1, k: 2 })}</p>` +
      notesSection([noteItem({ n: 1, body: "Shared", refs: 3 })]);
    const { root, xhtml } = run(html);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 3, notes: 1 });
    expect(texts(root, "sup.footnote-ref a")).toEqual(["1", "1", "1"]);
    expect(Array.from(root.querySelectorAll("sup.footnote-ref a")).map((a) => a.getAttribute("id"))).toEqual([
      "fnref-1",
      "fnref-1-2",
      "fnref-1-3",
    ]);
    expect(texts(root, "a[role=doc-backlink]")).toEqual(["↩︎1", "↩︎2", "↩︎3"]);
  });
});

describe("processFootnotes: wherever a marker sits (FR-003)", () => {
  it("recognises a marker inside a table cell (real capture)", () => {
    const { root, xhtml } = run(loadRealContextHtml("table"));
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 1, notes: 1 });
    expect(root.querySelector("td sup.footnote-ref a[role=doc-noteref]")).not.toBeNull();
    expect(root.lastElementChild!.localName).toBe("section");
  });

  it("recognises a marker inside a callout (real capture)", () => {
    const { root, xhtml } = run(loadRealContextHtml("callout"));
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 1, notes: 1 });
    expect(root.querySelector(".callout-content sup.footnote-ref a[role=doc-noteref]")).not.toBeNull();
    expect(root.querySelector(".callout section")).toBeNull();
  });

  it("recognises a marker inside a blockquote (real capture)", () => {
    const { root, xhtml } = run(loadRealContextHtml("blockquote"));
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 1, notes: 1 });
    expect(root.querySelector("blockquote sup.footnote-ref a[role=doc-noteref]")).not.toBeNull();
  });

  it("keeps the one note Obsidian rendered when a label was defined twice (real capture)", () => {
    const { root, xhtml } = run(loadRealContextHtml("duplicateDefinition"));
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 1, notes: 1 });
    expect(root.querySelector("aside")!.textContent).toContain("second definition.");
    expect(root.textContent).not.toContain("first definition");
  });

  it("shares one number between two references to one note (real capture)", () => {
    const { root, xhtml } = run(loadRealContextHtml("sameLabelTwoRefsAndUnusedAfter"));
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 2, notes: 1 });
    expect(texts(root, "sup.footnote-ref a")).toEqual(["1", "1"]);
    expect(texts(root, "a[role=doc-backlink]")).toEqual(["↩︎1", "↩︎2"]);
  });
});

describe("processFootnotes: things that only look like footnotes (FR-004, FR-023)", () => {
  const LOOKALIKES =
    '<p>Text <a href="#usage">jump</a> and <sup>y</sup> and <sup class="footnote-ref">z</sup> end</p>' +
    "<pre><code>[^1]: not a note</code></pre>";

  it("leaves a chapter with only lookalikes exactly as it was", () => {
    const root = mountHtml(LOOKALIKES);
    const before = root.innerHTML;
    expect(processFootnotes(root)).toEqual([]);
    expect(root.innerHTML).toBe(before);
  });

  it("leaves lookalikes untouched next to a real footnote", () => {
    const root = mountHtml(LOOKALIKES + loadRealContextHtml("blockquote"));
    const before = ["a[href='#usage']", "sup:not(.footnote-ref)", "pre"].map(
      (s) => root.querySelector(s)!.outerHTML
    );
    processFootnotes(root);
    const after = ["a[href='#usage']", "sup:not(.footnote-ref)", "pre"].map(
      (s) => root.querySelector(s)!.outerHTML
    );
    expect(after).toEqual(before);
    expect(root.querySelectorAll("a[role=doc-noteref]")).toHaveLength(1);
  });

  it("returns [] and does not touch a chapter with no footnote structure at all", () => {
    const root = mountHtml("<h1>T</h1><p>plain <em>text</em></p><ul><li>a</li></ul>");
    const before = root.innerHTML;
    expect(processFootnotes(root)).toEqual([]);
    expect(root.innerHTML).toBe(before);
  });

  it("is idempotent: a second pass over its own output is a no-op", () => {
    const { root } = run(loadRealFootnotesHtml());
    const once = root.innerHTML;
    expect(processFootnotes(root)).toEqual([]);
    expect(root.innerHTML).toBe(once);
  });
});

describe("processFootnotes: a note's content is carried like body content (FR-013)", () => {
  it("keeps a wikilink and emphasis inside a note, in order, with the link's attributes intact", () => {
    const { root } = run(loadRealFootnotesHtml());
    const p = root.querySelector('aside[id="fn-3"] p')!;
    expect(Array.from(p.children).map((c) => c.localName)).toEqual(["span", "a", "strong", "a"]);
    const link = p.querySelector("a.internal-link")!;
    expect(link.getAttribute("data-href")).toBe("Some Link");
    expect(link.getAttribute("href")).toBe("Some Link");
    expect(link.textContent).toBe("Some Link");
    expect(p.querySelector("strong")!.textContent).toBe("bold");
  });

  // SYNTHETIC: Obsidian's real output for a note whose last block is not a paragraph —
  // it appends a fresh <p> holding only the back-link.
  it("keeps images, code, nested lists and a trailing back-link paragraph, in order", () => {
    const li =
      '<li data-footnote-id="fn-1-aaaaaaaaaaaaaaaa" id="fn-1-aaaaaaaaaaaaaaaa" dir="auto">' +
      '<p>Lead <code>x</code> <img src="../images/img_001.png" alt="pic"></p>' +
      "<ul><li>a<ul><li>b</li></ul></li></ul><pre><code>c = 1</code></pre>" +
      '<p><a href="#fnref-1-aaaaaaaaaaaaaaaa" class="footnote-backref footnote-link" target="_blank" rel="noopener nofollow">↩︎</a></p></li>';
    const { root, xhtml } = run(`<p>Body${marker({ n: 1 })}</p>${notesSection([li])}`);
    assertChapterFootnoteInvariants(xhtml);
    const aside = root.querySelector("aside")!;
    expect(Array.from(aside.children).map((c) => c.localName)).toEqual(["p", "ul", "pre", "p"]);
    expect(aside.querySelector("img")!.getAttribute("src")).toBe("../images/img_001.png");
    expect(aside.querySelector("ul ul li")!.textContent).toBe("b");
    expect(aside.querySelector("pre code")!.textContent).toBe("c = 1");
    expect(aside.lastElementChild!.textContent).toBe("↩︎");
    expect(aside.firstElementChild!.textContent!.startsWith("1. Lead")).toBe(true);
  });

  // SYNTHETIC: Obsidian always starts a note with a paragraph, but another renderer might not.
  // The number must still not be glued into the list.
  it("gives the number a paragraph of its own when a note opens with a list", () => {
    const li =
      '<li data-footnote-id="fn-1-aaaaaaaaaaaaaaaa" id="fn-1-aaaaaaaaaaaaaaaa" dir="auto">' +
      "<ul><li>first</li><li>second</li></ul>" +
      '<p>Then a paragraph.<a href="#fnref-1-aaaaaaaaaaaaaaaa" class="footnote-backref footnote-link">↩︎</a></p></li>';
    const { root, xhtml } = run(`<p>Body${marker({ n: 1 })}</p>${notesSection([li])}`);
    assertChapterFootnoteInvariants(xhtml);
    const aside = root.querySelector("aside")!;
    expect(Array.from(aside.children).map((c) => c.localName)).toEqual(["p", "ul", "p"]);
    expect(aside.firstElementChild!.textContent).toBe("1.");
    expect(aside.querySelector("ul")!.textContent).toBe("firstsecond");
  });

  // SYNTHETIC: a note that ends in a list with no paragraph after it, so there is nowhere yet
  // to put the back-link.
  it("adds a closing paragraph for the back-link when a note ends in a list", () => {
    const li =
      '<li data-footnote-id="fn-1-aaaaaaaaaaaaaaaa" id="fn-1-aaaaaaaaaaaaaaaa" dir="auto">' +
      "<p>Lead.</p><ul><li>a</li></ul></li>";
    const { root, xhtml } = run(`<p>Body${marker({ n: 1 })}</p>${notesSection([li])}`);
    assertChapterFootnoteInvariants(xhtml);
    const aside = root.querySelector("aside")!;
    expect(Array.from(aside.children).map((c) => c.localName)).toEqual(["p", "ul", "p"]);
    expect(aside.lastElementChild!.textContent).toBe("↩︎");
  });

  // SYNTHETIC: an empty definition.
  it("still yields a numbered note with a back-link when the note has no text", () => {
    const { root, xhtml } = run(
      `<p>Body${marker({ n: 1 })}</p>${notesSection([noteItem({ n: 1, body: "" })])}`
    );
    assertChapterFootnoteInvariants(xhtml);
    expect(root.querySelector("aside")!.textContent).toBe("1. ↩︎");
  });
});

// Several renders in one chapter. Obsidian renders the host note and EVERY embed
// separately, each with its own `section.footnotes` numbered from 1 and its own random
// suffix; flattenEmbeds then splices an embed's children straight into the host. These
// tests build that flattened shape from real-shaped pieces (US2, FR-006, FR-010, FR-011).
describe("processFootnotes: notes from several renders become one chapter's notes (US2)", () => {
  const A = "aaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbb";
  const C = "cccccccccccccccc";
  const noteText = (root: Element): string[] =>
    Array.from(root.querySelectorAll("aside")).map((a) => a.textContent!);

  it("gathers a host's and an embed's notes into one section, numbered by first reference", () => {
    const html =
      `<p>host one${marker({ n: 1, docId: A })}</p>` +
      `<p>embedded${marker({ n: 1, docId: B })}</p>` +
      notesSection([noteItem({ n: 1, body: "embedded note", docId: B })]) +
      `<p>host two${marker({ n: 2, docId: A })}</p>` +
      notesSection([
        noteItem({ n: 1, body: "host first", docId: A }),
        noteItem({ n: 2, body: "host second", docId: A }),
      ]);
    const { root, xhtml } = run(html);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 3, notes: 3 });
    expect(root.querySelectorAll("section")).toHaveLength(1);
    // Document order, not each render's own numbering: A1, then the embed's, then A2.
    expect(noteText(root)).toEqual(["1. host first↩︎", "2. embedded note↩︎", "3. host second↩︎"]);
  });

  it("keeps the same note embedded twice as two distinct notes", () => {
    const first = loadRealFootnotesHtml();
    const second = withDocId(loadRealFootnotesHtml(), "dddddddddddddddd");
    const { root, xhtml } = run(first + second);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 12, notes: 10 });
    const texts = noteText(root);
    expect(texts[0]).toBe("1. Heading note.↩︎");
    expect(texts[5]).toBe("6. Heading note.↩︎");
    expect(Array.from(root.querySelectorAll("aside")).map((a) => a.getAttribute("id"))).toEqual(
      Array.from({ length: 10 }, (_, i) => `fn-${i + 1}`)
    );
  });

  it("handles an embed nested inside an embed", () => {
    const html =
      `<p>host${marker({ n: 1, docId: A })}</p>` +
      `<p>middle${marker({ n: 1, docId: B })}</p>` +
      `<p>inner${marker({ n: 1, docId: C })}</p>` +
      notesSection([noteItem({ n: 1, body: "inner note", docId: C })]) +
      notesSection([noteItem({ n: 1, body: "middle note", docId: B })]) +
      notesSection([noteItem({ n: 1, body: "host note", docId: A })]);
    const { root, xhtml } = run(html);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 3, notes: 3 });
    expect(noteText(root)).toEqual(["1. host note↩︎", "2. middle note↩︎", "3. inner note↩︎"]);
  });

  it("numbers a host that has no footnotes of its own from the embeds it pulls in", () => {
    const html =
      "<p>an index note with no footnotes</p>" +
      `<p>embedded${marker({ n: 1, docId: B })}</p>` +
      notesSection([noteItem({ n: 1, body: "only note", docId: B })]);
    const { xhtml } = run(html);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 1, notes: 1 });
  });

  it("keeps two renders' notes apart even when they use the same label and number", () => {
    const html =
      `<p>a${marker({ n: 1, label: "1", docId: A })}</p>${notesSection([noteItem({ n: 1, body: "from A", docId: A })])}` +
      `<p>b${marker({ n: 1, label: "1", docId: B })}</p>${notesSection([noteItem({ n: 1, body: "from B", docId: B })])}`;
    const { root, xhtml } = run(html);
    assertChapterFootnoteInvariants(xhtml);
    const pairs = Array.from(root.querySelectorAll("sup.footnote-ref a")).map((a) => {
      const target = root.querySelector(`[id="${a.getAttribute("href")!.slice(1)}"]`)!;
      return [a.parentElement!.previousSibling!.textContent, target.textContent];
    });
    expect(pairs).toEqual([
      ["a", "1. from A↩︎"],
      ["b", "2. from B↩︎"],
    ]);
  });

  it("copes with hundreds of notes across renders, within a generous bound", () => {
    const render = (docId: string, from: number): string => {
      const range = Array.from({ length: 100 }, (_, i) => i + 1);
      const body = range.map((n) => `<p>r${from} n${n}${marker({ n, docId })}</p>`).join("");
      return body + notesSection(range.map((n) => noteItem({ n, body: `note ${from}.${n}`, docId })));
    };
    const root = mountHtml(render(A, 1) + render(B, 2) + render(C, 3));
    const t0 = performance.now();
    processFootnotes(root);
    const elapsed = performance.now() - t0;
    expect(assertChapterFootnoteInvariants(serializeBody(root))).toEqual({ markers: 300, notes: 300 });
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("processFootnotes: a footnote never leaves its chapter (US2, FR-007, FR-018)", () => {
  it("gives two chapters that both define footnote 1 their own, self-contained ids and links", () => {
    const one = run(
      `<p>one${marker({ n: 1, docId: "1111111111111111" })}</p>${notesSection([noteItem({ n: 1, body: "first chapter", docId: "1111111111111111" })])}`
    );
    const two = run(
      `<p>two${marker({ n: 1, docId: "2222222222222222" })}</p>${notesSection([noteItem({ n: 1, body: "second chapter", docId: "2222222222222222" })])}`
    );
    for (const chapter of [one, two]) {
      assertChapterFootnoteInvariants(chapter.xhtml);
      expect(chapter.xhtml).not.toMatch(/href="[^#"][^"]*"/); // only bare fragments
      expect(chapter.xhtml).not.toContain(".xhtml");
    }
    expect(one.root.querySelector("aside")!.textContent).toContain("first chapter");
    expect(two.root.querySelector("aside")!.textContent).toContain("second chapter");
  });
});

// US3 / FR-023: every chapter shape that existed before this feature must pass through the
// footnote pass unchanged — same nodes, same serialization, no warnings.
describe("processFootnotes leaves every footnote-free chapter shape alone (US3, FR-023)", () => {
  const mermaid = readFileSync(join(__dirname, "fixtures", "mermaid-real.xhtml"), "utf-8");
  const CORPUS: Record<string, string> = {
    "a real Mermaid diagram": mermaid,
    "a callout":
      '<div class="callout" data-callout="note"><div class="callout-title">Note</div><div class="callout-content"><p>body</p></div></div>',
    "a table": "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
    code: '<pre><code class="language-ts">const x = 1;\n</code></pre><p>inline <code>y</code></p>',
    "an image": '<p><img src="../images/img_001.png" alt="cap"></p>',
    "a backlink trail":
      '<div class="backlinks"><p>Linked from: <a href="chapter_001.xhtml">One</a></p></div>',
    "typeset math":
      '<p class="math-block"><img src="../images/img_002.png" alt="x"></p><p>inline <img src="../images/img_003.png" alt="y"></p>',
    "headings, lists and an omitted embed":
      '<h1>T</h1><h2 id="a">A</h2><ul><li>x<ul><li>y</li></ul></li></ul><p class="omitted">[embedded content omitted: gone]</p>',
    "anchors and superscripts that are not footnotes":
      '<p>see <a href="#a">A</a>, x<sup>2</sup>, and H<sub>2</sub>O</p>',
    "an ordinary section that is not a footnotes container":
      '<section class="appendix"><ol><li>item</li></ol></section>',
  };

  for (const [name, html] of Object.entries(CORPUS)) {
    it(`returns [] and changes nothing for ${name}`, () => {
      const root = mountHtml(html);
      const before = root.innerHTML;
      expect(processFootnotes(root)).toEqual([]);
      expect(root.innerHTML).toBe(before);
    });
  }
});

// US4: the DOM half of graceful degradation. Real Obsidian cannot produce any of these —
// it discards orphans before the DOM exists (see tests/footnote-source.test.ts) — so every
// input below is SYNTHETIC. They exist because other renderers or versions might, and
// because a broken footnote must never fail an export or leave a dead link (FR-015…FR-017).
describe("processFootnotes: defensive degradation (US4)", () => {
  // Every footnote link the pass wrote must lead somewhere in the same chapter.
  const danglingLinks = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll("a[role=doc-noteref], a[role=doc-backlink]"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => !root.querySelector(`[id="${href.slice(1)}"]`));

  it("turns a marker with no note into its plain label, with a warning", () => {
    const { root, warnings } = run(`<p>text${marker({ n: 1, label: "nope" })} tail</p>`);
    expect(root.querySelector("sup")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("textnope tail");
    expect(warnings).toEqual(['Footnote marker "[1]" has no matching note and was left as plain text']);
  });

  it("falls back to the marker's visible text, brackets removed, when it has no label", () => {
    const html = `<p>text<sup class="footnote-ref"><a href="#fn-x">[7]</a></sup> tail</p>`;
    const { root } = run(html);
    expect(root.textContent).toBe("text7 tail");
  });

  it("drops a note that no marker refers to, with a warning naming its text", () => {
    const { root, warnings } = run(
      `<p>plain</p>${notesSection([noteItem({ n: 1, body: "Nobody mentions me" })])}`
    );
    expect(root.querySelector("section, aside, li")).toBeNull();
    expect(root.textContent).toBe("plain");
    expect(warnings).toEqual(['Footnote note "Nobody mentions me" has no marker and was left out']);
  });

  it("shortens a long unreferenced note in its warning", () => {
    const long = "word ".repeat(30).trim();
    const { warnings } = run(`<p>x</p>${notesSection([noteItem({ n: 1, body: long })])}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Footnote note "word word[^"]*…" has no marker and was left out$/);
  });

  it("degrades only the orphans when real footnotes are present", () => {
    const root = mountHtml(
      loadRealFootnotesHtml() + `<p>orphan${marker({ n: 99, label: "ghost", docId: "eeeeeeeeeeeeeeee" })}</p>`
    );
    const warnings = processFootnotes(root);
    expect(assertChapterFootnoteInvariants(serializeBody(root))).toEqual({ markers: 6, notes: 5 });
    expect(warnings).toEqual(['Footnote marker "[99]" has no matching note and was left as plain text']);
    expect(root.textContent).toContain("orphanghost");
  });

  it("drops an unreferenced note alongside real ones, leaving the rest intact", () => {
    const extra = noteItem({ n: 42, body: "Stray note", docId: "eeeeeeeeeeeeeeee" });
    const html = loadRealFootnotesHtml().replace("</ol></section>", `${extra}</ol></section>`);
    const root = mountHtml(html);
    const warnings = processFootnotes(root);
    expect(assertChapterFootnoteInvariants(serializeBody(root))).toEqual({ markers: 6, notes: 5 });
    expect(warnings).toEqual(['Footnote note "Stray note" has no marker and was left out']);
    expect(root.textContent).not.toContain("Stray note");
  });

  it("refuses to guess when two notes share the fragment a marker points at", () => {
    // Renderers that do not suffix their ids give a host and an embed the same fn-1.
    const html =
      `<p>a${olderShapeMarker(1)}</p>${olderShapeNotes([{ n: 1, body: "from the embed" }])}` +
      `<p>b${olderShapeMarker(1)}</p>${olderShapeNotes([{ n: 1, body: "from the host" }])}`;
    const { root, warnings } = run(html);
    expect(root.querySelector("sup, aside, section, a")).toBeNull();
    expect(root.textContent).toBe("a1b1");
    expect(warnings).toEqual([
      'Footnote reference "fn-1" matches more than one note and was left as plain text',
    ]);
  });

  it("accepts the older Obsidian shape (sup#fnref-N > a.footnote-ref, div.footnotes > ol > li#fn-N)", () => {
    const html =
      `<p>a${olderShapeMarker(1)} b${olderShapeMarker(2)}</p>` +
      olderShapeNotes([
        { n: 1, body: "old one" },
        { n: 2, body: "old two" },
      ]);
    const { root, xhtml, warnings } = run(html);
    expect(warnings).toEqual([]);
    expect(assertChapterFootnoteInvariants(xhtml)).toEqual({ markers: 2, notes: 2 });
    expect(Array.from(root.querySelectorAll("aside")).map((a) => a.textContent)).toEqual([
      "1. old one↩︎",
      "2. old two↩︎",
    ]);
  });

  it("leaves a .footnotes element that holds no notes alone", () => {
    const root = mountHtml('<div class="footnotes"><p>Not a notes list, just a class name.</p></div>');
    const before = root.innerHTML;
    expect(processFootnotes(root)).toEqual([]);
    expect(root.innerHTML).toBe(before);
  });

  const MALFORMED: Record<string, string> = {
    "an empty marker": '<sup class="footnote-ref"></sup>',
    "a marker whose anchor has no href":
      '<sup class="footnote-ref"><a>1</a></sup><section class="footnotes"><ol><li id="x"><p>n</p></li></ol></section>',
    "a marker whose href is a bare hash": '<sup class="footnote-ref"><a href="#">1</a></sup>',
    "a notes container with nothing in it": '<section class="footnotes"></section>',
    "an empty list and an orphan marker":
      '<section class="footnotes"><ol></ol></section><sup class="footnote-ref"><a href="#fn-1">1</a></sup>',
    "a marker nested inside a marker":
      '<sup class="footnote-ref"><sup class="footnote-ref"><a href="#fn-1">1</a></sup></sup><section class="footnotes"><ol><li id="fn-1"><p>n</p></li></ol></section>',
    "a marker inside the note it points at":
      '<sup class="footnote-ref"><a href="#fn-1">1</a></sup><section class="footnotes"><ol><li id="fn-1"><p>self <sup class="footnote-ref"><a href="#fn-1">1</a></sup></p></li></ol></section>',
    "a note with no children":
      '<p>x</p><sup class="footnote-ref"><a href="#fn-1">1</a></sup><section class="footnotes"><ol><li id="fn-1"></li></ol></section>',
    "a marker with two anchors":
      '<sup class="footnote-ref"><a href="#fn-1">1</a><a href="#fn-2">2</a></sup><section class="footnotes"><ol><li id="fn-1"><p>a</p></li><li id="fn-2"><p>b</p></li></ol></section>',
    "a notes container that is not a list":
      '<p class="footnotes">x</p><sup class="footnote-ref"><a href="#fn-1">1</a></sup>',
    "notes nested inside notes":
      '<sup class="footnote-ref"><a href="#fn-1">1</a></sup><section class="footnotes"><ol><li id="fn-1"><p>a</p><section class="footnotes"><ol><li id="fn-2"><p>inner</p></li></ol></section></li></ol></section>',
  };
  for (const [name, html] of Object.entries(MALFORMED)) {
    it(`never throws, and leaves no dead footnote link, for ${name}`, () => {
      const root = mountHtml(html);
      expect(() => processFootnotes(root)).not.toThrow();
      expect(danglingLinks(root)).toEqual([]);
      expect(() => serializeBody(root)).not.toThrow();
    });
  }
});
