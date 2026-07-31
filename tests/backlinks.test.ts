import { describe, it, expect } from "vitest";
import { computeBacklinks, renderBacklinksFragment, type BacklinkEntry } from "../src/backlinks";

// ── computeBacklinks (contract: specs/001-breadcrumb-trail/contracts/backlinks-fragment.md) ──

describe("computeBacklinks", () => {
  it("US1: A links B → B maps to [A]", () => {
    const links = { "A.md": { "B.md": 1 } };
    const result = computeBacklinks(links, ["A.md", "B.md"]);
    expect(result.get("B.md")).toEqual(["A.md"]);
  });

  it("US1: a chapter nothing links to is absent from the map (no key, not an empty list)", () => {
    const links = { "A.md": { "B.md": 1 } };
    const result = computeBacklinks(links, ["A.md", "B.md"]);
    expect(result.has("A.md")).toBe(false);
  });

  it("US1: a self-link never lists the chapter as its own backlink", () => {
    const links = { "A.md": { "A.md": 3, "B.md": 1 } };
    const result = computeBacklinks(links, ["A.md", "B.md"]);
    expect(result.has("A.md")).toBe(false);
    expect(result.get("B.md")).toEqual(["A.md"]);
  });

  it("US1: an empty graph yields an empty map", () => {
    expect(computeBacklinks({}, ["A.md", "B.md"]).size).toBe(0);
  });

  it("US1: a single-chapter export yields an empty map even if the graph has links", () => {
    const links = { "A.md": { "B.md": 1 }, "B.md": { "A.md": 1 } };
    expect(computeBacklinks(links, ["A.md"]).size).toBe(0);
  });

  it("US2: two chapters linking the same target are listed in book order, not alphabetical or discovery order", () => {
    // "z_early.md" precedes "a_late.md" in the book but follows it
    // alphabetically, and appears later in the links object — so passing
    // this test requires genuinely ordering by orderedPaths.
    const links = {
      "a_late.md": { "target.md": 1 },
      "z_early.md": { "target.md": 1 },
    };
    const result = computeBacklinks(links, ["z_early.md", "a_late.md", "target.md"]);
    expect(result.get("target.md")).toEqual(["z_early.md", "a_late.md"]);
  });

  it("US2: repeated links from the same source collapse to one entry (FR-005)", () => {
    // resolvedLinks counts multiplicity in the value; 5 links → one backlink.
    const links = { "A.md": { "C.md": 5 } };
    expect(computeBacklinks(links, ["A.md", "C.md"]).get("C.md")).toEqual(["A.md"]);
  });

  it("US2: mutually linked chapters each list the other exactly once", () => {
    const links = { "A.md": { "B.md": 2 }, "B.md": { "A.md": 1 } };
    const result = computeBacklinks(links, ["A.md", "B.md"]);
    expect(result.get("A.md")).toEqual(["B.md"]);
    expect(result.get("B.md")).toEqual(["A.md"]);
  });

  it("US2: sources and targets outside the export are ignored entirely", () => {
    const links = {
      "outside_source.md": { "A.md": 1 }, // source not in book → not a backlink
      "A.md": { "outside_target.md": 1, "B.md": 1 }, // out-of-book target → no key
    };
    const result = computeBacklinks(links, ["A.md", "B.md"]);
    expect(result.has("A.md")).toBe(false);
    expect(result.has("outside_target.md")).toBe(false);
    expect(result.get("B.md")).toEqual(["A.md"]);
  });

  it("US1: does not mutate its inputs", () => {
    const links = { "A.md": { "B.md": 1 } };
    const orderedPaths = ["A.md", "B.md"];
    const linksSnapshot = JSON.parse(JSON.stringify(links));
    const pathsSnapshot = [...orderedPaths];
    computeBacklinks(links, orderedPaths);
    expect(links).toEqual(linksSnapshot);
    expect(orderedPaths).toEqual(pathsSnapshot);
  });
});

// ── renderBacklinksFragment ──

describe("renderBacklinksFragment", () => {
  const entry = (title: string, href: string): BacklinkEntry => ({ title, href });

  it("US1: empty entries render to the empty string (FR-002 — no empty placeholder section)", () => {
    expect(renderBacklinksFragment([])).toBe("");
  });

  it("US1: one entry renders one div.backlinks with one p starting with the fixed label", () => {
    const html = renderBacklinksFragment([entry("Chapter A", "chapter_001.xhtml")]);
    expect(html).toBe(
      '<div class="backlinks"><p>Linked from: <a href="chapter_001.xhtml">Chapter A</a></p></div>'
    );
  });

  it("US1: titles with XML-special characters are escaped and survive round-tripping", () => {
    const html = renderBacklinksFragment([entry(`Tom & Jerry's <"Fun">`, "chapter_002.xhtml")]);
    expect(html).toContain("Tom &amp; Jerry&apos;s &lt;&quot;Fun&quot;&gt;");
    expect(html).not.toContain('<"');
    // Must parse as XML — chapter docs are XHTML (parsed strictly by e-readers).
    const doc = new DOMParser().parseFromString(
      `<root xmlns="http://www.w3.org/1999/xhtml">${html}</root>`,
      "application/xml"
    );
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("a")?.textContent).toBe(`Tom & Jerry's <"Fun">`);
  });

  it("US1: Thai titles pass through intact next to the fixed English label (FR-010)", () => {
    const html = renderBacklinksFragment([entry("บทนำ", "chapter_001.xhtml")]);
    expect(html).toContain("Linked from: ");
    expect(html).toContain(">บทนำ</a>");
  });

  it("US2: multiple entries render in input order, comma-separated", () => {
    const html = renderBacklinksFragment([
      entry("Zeta", "chapter_003.xhtml"),
      entry("Alpha", "chapter_001.xhtml"),
    ]);
    expect(html).toBe(
      '<div class="backlinks"><p>Linked from: <a href="chapter_003.xhtml">Zeta</a>, ' +
        '<a href="chapter_001.xhtml">Alpha</a></p></div>'
    );
  });

  it("US2 (edge): a large fan-in renders every entry and stays well-formed XML", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry(`Chapter ${i + 1}`, `chapter_${String(i + 1).padStart(3, "0")}.xhtml`)
    );
    const html = renderBacklinksFragment(entries);
    expect(html.match(/<a /g)).toHaveLength(20);
    const doc = new DOMParser().parseFromString(
      `<root xmlns="http://www.w3.org/1999/xhtml">${html}</root>`,
      "application/xml"
    );
    expect(doc.querySelector("parsererror")).toBeNull();
  });

  it("US1: output carries no id attributes (safe to appear twice for position 'both')", () => {
    const html = renderBacklinksFragment([entry("A", "chapter_001.xhtml"), entry("B", "chapter_002.xhtml")]);
    expect(html).not.toContain("id=");
  });
});
