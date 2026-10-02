import { describe, it, expect } from "vitest";
import { slugify, deriveChapterTitle } from "../src/core/naming";

describe("slugify", () => {
  it("lowercases and snake_cases spaces", () => {
    expect(slugify("Learn Go With Tests")).toBe("learn_go_with_tests");
  });
  it("strips filesystem-hostile characters", () => {
    expect(slugify('a/b\\c:d*e?f"g<h>i|j#k')).toBe("abcdefghijk");
  });
  it("preserves Thai characters", () => {
    expect(slugify("สรุปหนังสือ Go")).toBe("สรุปหนังสือ_go");
  });
  it("falls back to 'export' when empty", () => {
    expect(slugify("???")).toBe("export");
  });
});

describe("deriveChapterTitle (default rule: basename)", () => {
  it("returns basename when there is no H1 and no aliases", () => {
    expect(deriveChapterTitle("01_hello_world", undefined, undefined)).toBe("01_hello_world");
  });
  it("uses the first H1 when present", () => {
    expect(deriveChapterTitle("01_hello_world", undefined, "Hello World")).toBe("Hello World");
  });
  it("prefers the first H1 over aliases", () => {
    expect(deriveChapterTitle("01_hello_world", ["Hello"], "Hello World")).toBe("Hello World");
  });
  it("uses the H1 verbatim, including inline markdown", () => {
    expect(deriveChapterTitle("go_generics", undefined, "Go *Generics*")).toBe("Go *Generics*");
  });
  it("trims the H1", () => {
    expect(deriveChapterTitle("01_intro", undefined, "  Introduction  ")).toBe("Introduction");
  });
  it("uses a plain-string alias when there is no H1", () => {
    expect(deriveChapterTitle("03_recursion", "Recursion", undefined)).toBe("Recursion");
  });
  it("uses the first non-empty alias from a list when there is no H1", () => {
    expect(deriveChapterTitle("03_recursion", ["", "Recursion"], undefined)).toBe("Recursion");
  });
  it("falls back to basename when the only alias is unusable", () => {
    expect(deriveChapterTitle("03_recursion", ["", 42, "  "], undefined)).toBe("03_recursion");
  });
  it("treats a whitespace-only H1 as absent and falls through to aliases", () => {
    expect(deriveChapterTitle("01_intro", ["Intro"], "   ")).toBe("Intro");
  });
  it("never throws for degenerate inputs", () => {
    const degenerate: [string, unknown, string | undefined][] = [
      ["", undefined, undefined],
      ["note", 42, undefined],
      ["note", null, ""],
      ["note", [[]], "#"],
      ["note", [""], " "],
    ];
    for (const [basename, aliases, h1] of degenerate) {
      expect(() => deriveChapterTitle(basename, aliases, h1)).not.toThrow();
    }
  });
});

// 011-footnote-semantics: the chapter title comes from Obsidian's metadata cache, which
// keeps the heading's SOURCE text — so "Title[^h]" reached the book as a literal title.
describe("deriveChapterTitle and footnote references (011 FR-012)", () => {
  it("strips a numbered, named or inline footnote reference from the heading", () => {
    expect(deriveChapterTitle("n", undefined, "Title with note[^h]")).toBe("Title with note");
    expect(deriveChapterTitle("n", undefined, "Title[^1]")).toBe("Title");
    expect(deriveChapterTitle("n", undefined, "Title^[an inline note]")).toBe("Title");
  });

  it("strips several references and tidies the whitespace they leave", () => {
    expect(deriveChapterTitle("n", undefined, "A[^1] and [^two] B")).toBe("A and B");
    expect(deriveChapterTitle("n", undefined, "[^1] Leading")).toBe("Leading");
  });

  it("falls through to the alias, then the basename, when the heading was only a reference", () => {
    expect(deriveChapterTitle("base", ["Alias"], "[^1]")).toBe("Alias");
    expect(deriveChapterTitle("base", undefined, "[^1]")).toBe("base");
  });

  it("returns ordinary headings exactly as before, including brackets, carets and markdown", () => {
    for (const h1 of ["[link] text", "a^b", "**bold** and _it_", "Array[0]", "x ^ y", "[^]", "[^ spaced]"]) {
      expect(deriveChapterTitle("n", undefined, h1)).toBe(h1);
    }
  });

  it("never throws on odd input", () => {
    for (const h1 of ["[^", "^[", "[^]]", "^[[[", "[^a]^[b]^[", "\u0000[^x]", " [^x] "]) {
      expect(() => deriveChapterTitle("n", undefined, h1)).not.toThrow();
    }
  });
});
