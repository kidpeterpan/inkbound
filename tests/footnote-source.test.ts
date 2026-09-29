// Tests for the markdown-level half of src/footnotes.ts (011 US4, FR-015, FR-016).
//
// Why this exists: Obsidian destroys orphan footnotes BEFORE the DOM does. Captured from a
// live 1.13.7 (tests/fixtures/footnotes-real.html): a dangling `[^nope]` renders as the bare
// text "nope" with no marker, and an unused `[^unused]:` is not rendered at all. Neither can
// be noticed by looking at the rendered page, so the only place a real footnote problem is
// visible is the note's SOURCE — which is what these functions read.

import { describe, it, expect } from "vitest";
import {
  footnoteSourceWarnings,
  scanFootnoteSource,
  stripFootnoteRefs,
  usesFootnoteMarkup,
} from "../src/footnotes";

describe("scanFootnoteSource: finding footnotes that will not survive", () => {
  it("reports a reference with no definition, and a definition with no reference", () => {
    const scan = scanFootnoteSource("Text[^a] and[^nope].\n\n[^a]: Defined.\n[^unused]: Never used.\n");
    expect(scan).toEqual({ orphanRefs: ["nope"], unusedDefs: ["unused"] });
  });

  it("reports nothing for a note whose footnotes all pair up", () => {
    expect(scanFootnoteSource("One[^1] two[^b].\n\n[^1]: a\n[^b]: b\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
  });

  it("reports nothing for text with no footnotes at all, or no text", () => {
    expect(scanFootnoteSource("")).toEqual({ orphanRefs: [], unusedDefs: [] });
    expect(scanFootnoteSource("# Title\n\nJust prose, a^b and [brackets] and [link](x).\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
  });

  it("compares labels case-insensitively and returns them lowercased, as Obsidian does", () => {
    expect(scanFootnoteSource("Ref[^ABC].\n\n[^abc]: def\n")).toEqual({ orphanRefs: [], unusedDefs: [] });
    expect(scanFootnoteSource("Ref[^MiXed].\n")).toEqual({ orphanRefs: ["mixed"], unusedDefs: [] });
    expect(scanFootnoteSource("[^LOUD]: def\n")).toEqual({ orphanRefs: [], unusedDefs: ["loud"] });
  });

  it("de-duplicates, keeping first-appearance order", () => {
    const scan = scanFootnoteSource("[^z] [^y] [^z] [^y] [^x]\n\n[^q]: 1\n[^p]: 2\n[^q]: 3\n");
    expect(scan.orphanRefs).toEqual(["z", "y", "x"]);
    expect(scan.unusedDefs).toEqual(["q", "p"]);
  });

  it("ignores everything inside fenced code, backtick and tilde alike", () => {
    const md =
      "```\nnot a ref[^fence]\n[^fenced]: not a def\n```\n\n~~~ts\n[^tilde]\n~~~\n\nreal[^r].\n\n[^r]: yes\n";
    expect(scanFootnoteSource(md)).toEqual({ orphanRefs: [], unusedDefs: [] });
  });

  it("does not let a shorter or different fence close a longer one early", () => {
    const md = "````\n```\n[^inside]\n```\n````\n\nafter[^a].\n";
    expect(scanFootnoteSource(md)).toEqual({ orphanRefs: ["a"], unusedDefs: [] });
  });

  it("ignores references inside inline code", () => {
    expect(scanFootnoteSource("Write `[^x]` to make a note, or ``[^y]``.\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
  });

  it("ignores an indented code block, but not the indented continuation of a definition", () => {
    const code = "Prose.\n\n    [^codeonly]: shown as code\n    [^ref]\n\nEnd.\n";
    expect(scanFootnoteSource(code)).toEqual({ orphanRefs: [], unusedDefs: [] });
    const continuation = "Ref[^a].\n\n[^a]: First.\n\n    Second paragraph mentions[^b].\n";
    expect(scanFootnoteSource(continuation)).toEqual({ orphanRefs: ["b"], unusedDefs: [] });
  });

  it("takes a definition at up to three leading spaces, and a mid-line [^x]: as a reference", () => {
    expect(scanFootnoteSource("Ref[^a].\n\n   [^a]: three spaces is fine\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
    expect(scanFootnoteSource("see[^1]: yes\n")).toEqual({ orphanRefs: ["1"], unusedDefs: [] });
  });

  it("does not treat simple inline notes ^[…] as references or definitions", () => {
    expect(scanFootnoteSource("Inline^[a note] and more^[another].\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
  });

  it("rejects labels with whitespace, which are not footnotes", () => {
    expect(scanFootnoteSource("[^has space] and [^] and [^ x]\n")).toEqual({
      orphanRefs: [],
      unusedDefs: [],
    });
  });

  it("copes with CRLF line endings and a very large note", () => {
    expect(scanFootnoteSource("Ref[^a].\r\n\r\n[^a]: def\r\n")).toEqual({ orphanRefs: [], unusedDefs: [] });
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i} with[^n${i % 50}]`).join("\n");
    const t0 = performance.now();
    const scan = scanFootnoteSource(big);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(scan.orphanRefs).toHaveLength(50);
  });
});

describe("footnoteSourceWarnings: one warning per problem, naming the note", () => {
  it("words each case as the contract does, ending with the note's path", () => {
    const warnings = footnoteSourceWarnings({ orphanRefs: ["far"], unusedDefs: ["spare"] }, "Notes/Far.md");
    expect(warnings).toEqual([
      "Footnote [^far] is referenced but has no matching note (referenced by Notes/Far.md)",
      "Footnote note [^spare] is never referenced and was left out (referenced by Notes/Far.md)",
    ]);
  });

  it("gives exactly one warning per label, orphans first", () => {
    const warnings = footnoteSourceWarnings({ orphanRefs: ["b", "a"], unusedDefs: ["c"] }, "n.md");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("[^b]");
    expect(warnings[1]).toContain("[^a]");
    expect(warnings[2]).toContain("[^c]");
  });

  it("produces nothing for a clean scan", () => {
    expect(footnoteSourceWarnings({ orphanRefs: [], unusedDefs: [] }, "n.md")).toEqual([]);
  });
});

describe("stripFootnoteRefs", () => {
  it("removes references and tidies the gap they leave", () => {
    expect(stripFootnoteRefs("Title[^1]")).toBe("Title");
    expect(stripFootnoteRefs("A[^1] and [^two] B")).toBe("A and B");
  });

  it("returns text without a reference completely untouched, even odd whitespace", () => {
    for (const t of ["plain", "  padded  ", "two  spaces", "a^b", "[^ x]", ""])
      expect(stripFootnoteRefs(t)).toBe(t);
  });
});

describe("usesFootnoteMarkup", () => {
  it("is true for a serialized chapter that carries a note reference, whatever the attribute order", () => {
    expect(
      usesFootnoteMarkup('<p>x<a id="f" href="#n" role="doc-noteref" epub:type="noteref">1</a></p>')
    ).toBe(true);
    expect(usesFootnoteMarkup('<a role="doc-noteref" href="#n">1</a>')).toBe(true);
  });

  it("is false when the words merely appear in prose, code, or on another element", () => {
    expect(usesFootnoteMarkup('<p>Use <code>role="doc-noteref"</code> on links.</p>')).toBe(false);
    expect(usesFootnoteMarkup('<aside role="doc-footnote" id="n">x</aside>')).toBe(false);
    expect(usesFootnoteMarkup('<a href="#x" role="doc-backlink">↩︎</a>')).toBe(false);
    expect(usesFootnoteMarkup("")).toBe(false);
  });
});
