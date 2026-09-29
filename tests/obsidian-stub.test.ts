// Conformance tests for the test stand-in renderer's footnote support (011, FR-030).
//
// The stand-in (tests/fixtures/obsidian-stub.ts) is `marked` plus hand-rolled Obsidian
// constructs, and had no footnote support at all. Every adapter-level test, the
// local-export harness and check-export-works render through it, so if it invents a
// footnote shape those tests would all pass against a fiction. These tests hold it to
// the REAL capture in tests/fixtures/footnotes-real.html (Obsidian 1.13.7).
//
// The properties that matter most, and that a naive stub would get wrong:
//   - every id/href carries a per-render RANDOM suffix (docId) — without the
//     randomness, an "export twice, get the same bytes" test would pass vacuously;
//   - orphans are destroyed before the DOM exists: a dangling [^x] becomes the bare
//     text "x", and an unused definition is not rendered at all.

import { describe, it, expect } from "vitest";
import { Component, MarkdownRenderer } from "./fixtures/obsidian-stub";
import { FOOTNOTE_SOURCE_MD, loadRealFootnotesHtml, mountHtml } from "./fixtures/footnote-fixtures";

const app = {
  metadataCache: { getFirstLinkpathDest: () => null },
  vault: { adapter: { getBasePath: () => "/vault" } },
} as never;

async function render(md: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  await MarkdownRenderer.render(app, md, el, "n.md", new Component() as never);
  return el;
}

const DOC_ID = /-([0-9a-f]{16})(?=")/g;
function docIds(html: string): string[] {
  return Array.from(new Set(Array.from(html.matchAll(DOC_ID), (m) => m[1])));
}

// Structure of a subtree independent of the random suffix, attribute order and
// whitespace. Wikilink anchors lose target/rel: that is the stub's wikilink shape,
// not a footnote property, and is covered by the stub's own link tests.
function canonical(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    return t ? JSON.stringify(t) : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const skip = el.classList.contains("internal-link") ? new Set(["target", "rel"]) : new Set<string>();
  const attrs = Array.from(el.attributes)
    .filter((a) => !skip.has(a.name))
    .map((a) => `${a.name}=${JSON.stringify(a.value.replace(/-[0-9a-f]{16}$/, "-DOC"))}`)
    .sort()
    .join(" ");
  const kids = Array.from(el.childNodes).map(canonical).filter(Boolean).join(",");
  return `<${el.localName} ${attrs}>[${kids}]`;
}

describe("stub footnotes: the marker and notes shape of real Obsidian", () => {
  it("emits markers as sup.footnote-ref > a.footnote-link with [N] / [N-K] text, in reference order", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    const markers = Array.from(el.querySelectorAll("sup.footnote-ref"));
    expect(markers.map((m) => m.textContent)).toEqual(["[1]", "[2]", "[3]", "[2-1]", "[4]", "[5]"]);
    for (const m of markers) {
      expect(m.getAttribute("data-footnote-id")).toMatch(/^fnref-\d+(-\d+)?-[0-9a-f]{16}$/);
      expect(m.getAttribute("id")).toBe(m.getAttribute("data-footnote-id"));
      const a = m.querySelector("a")!;
      expect(a.className).toBe("footnote-link");
      expect(a.getAttribute("href")).toMatch(/^#fn-\d+-[0-9a-f]{16}$/);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener nofollow");
      expect(a.hasAttribute("data-footref")).toBe(true);
    }
    expect(markers[3].getAttribute("id")).toMatch(/^fnref-2-1-/); // repeated reference to note 2
    expect(markers[4].querySelector("a")!.getAttribute("data-footref")).toBe("[inline3");
  });

  it("emits one section.footnotes with hr + ol + li ordered by number, and identical back-links", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    const sections = el.querySelectorAll("section.footnotes");
    expect(sections).toHaveLength(1);
    expect(sections[0].firstElementChild!.localName).toBe("hr");
    const lis = Array.from(sections[0].querySelectorAll(":scope > ol > li"));
    expect(lis.map((li) => li.getAttribute("id")!.replace(/-[0-9a-f]{16}$/, ""))).toEqual([
      "fn-1",
      "fn-2",
      "fn-3",
      "fn-4",
      "fn-5",
    ]);
    for (const li of lis) {
      expect(li.getAttribute("data-footnote-id")).toBe(li.getAttribute("id"));
      expect(li.getAttribute("dir")).toBe("auto");
    }
    const back = Array.from(lis[1].querySelectorAll("a.footnote-backref"));
    expect(back.map((a) => a.textContent)).toEqual(["↩︎", "↩︎"]);
    expect(back.map((a) => a.getAttribute("href")!.replace(/-[0-9a-f]{16}$/, ""))).toEqual([
      "#fnref-2",
      "#fnref-2-1",
    ]);
    expect(back.every((a) => a.className === "footnote-backref footnote-link")).toBe(true);
  });

  it("puts back-links on the LAST paragraph of a multi-paragraph note, and gives an inline note no <p>", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    const lis = Array.from(el.querySelectorAll("section.footnotes li"));
    const multi = Array.from(lis[1].querySelectorAll("p"));
    expect(multi).toHaveLength(2);
    expect(multi[0].querySelector("a")).toBeNull();
    expect(multi[1].querySelectorAll("a.footnote-backref")).toHaveLength(2);
    const inline = lis[3];
    expect(inline.querySelector("p")).toBeNull();
    expect(inline.textContent).toBe("an inline note↩︎");
    expect(inline.querySelector(":scope > a.footnote-backref")).not.toBeNull();
  });

  it("keeps the last of two definitions for one label, as Obsidian does", async () => {
    const el = await render("Ref[^d] here.\n\n[^d]: first definition.\n\n[^d]: second definition.");
    const lis = el.querySelectorAll("section.footnotes li");
    expect(lis).toHaveLength(1);
    expect(lis[0].textContent).toContain("second definition.");
    expect(el.textContent).not.toContain("first definition");
  });
});

describe("stub footnotes: orphans are gone before the DOM exists", () => {
  it("renders a dangling [^nope] as the bare label, glued to the text, with no marker and no note", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    expect(el.textContent).toContain("Dangling refnope here.");
    expect(el.innerHTML).not.toContain("nope-");
    expect(el.querySelector('[data-footref="nope"]')).toBeNull();
  });

  it("does not render a definition nothing refers to", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    expect(el.textContent).not.toContain("Never referenced");
  });

  it("renders a slice that has a reference but no definition as the bare label", async () => {
    const el = await render("A paragraph with a ref[^1] but no definition in this slice.");
    expect(el.textContent!.trim()).toBe("A paragraph with a ref1 but no definition in this slice.");
    expect(el.querySelector("section.footnotes")).toBeNull();
  });
});

describe("stub footnotes: the same pitfalls as the real renderer", () => {
  it("leaks the marker into a heading's textContent", async () => {
    const el = await render(FOOTNOTE_SOURCE_MD);
    expect(el.querySelector("h1")!.textContent).toBe("Title with note[1]");
  });

  it("puts a DIFFERENT random 16-hex suffix on every render of the same markdown", async () => {
    const a = docIds((await render(FOOTNOTE_SOURCE_MD)).innerHTML);
    const b = docIds((await render(FOOTNOTE_SOURCE_MD)).innerHTML);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
  });

  it("leaves markdown without footnotes exactly as it rendered before the feature", async () => {
    const md = "# Plain\n\nText with [[a link]], a^b, [brackets] and a #tag.\n";
    const el = await render(md);
    expect(el.querySelector("section.footnotes")).toBeNull();
    expect(el.querySelector("sup")).toBeNull();
    expect(el.textContent).toContain("a^b");
    expect(el.textContent).toContain("[brackets]");
  });
});

describe("stub footnotes: conformance to the captured real render", () => {
  it("produces the same footnote structure as tests/fixtures/footnotes-real.html", async () => {
    const stub = await render(FOOTNOTE_SOURCE_MD);
    const real = mountHtml(loadRealFootnotesHtml());
    const pick = (root: HTMLElement) =>
      Array.from(root.querySelectorAll("sup.footnote-ref, section.footnotes")).map(canonical);
    const stubShape = pick(stub);
    const realShape = pick(real);
    expect(stubShape).toHaveLength(7); // six markers + one notes section
    expect(stubShape).toEqual(realShape);
  });
});
