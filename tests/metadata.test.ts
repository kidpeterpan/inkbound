import { describe, it, expect } from "vitest";
import {
  normalizeLanguage, resolveAuthor, resolveTitle, resolveCoverUrl, resolveMeta,
} from "../src/metadata";

describe("normalizeLanguage", () => {
  it("passes through BCP-47-shaped codes, lowercased", () => {
    expect(normalizeLanguage("en", "th")).toBe("en");
    expect(normalizeLanguage("EN-GB", "th")).toBe("en-gb");
    expect(normalizeLanguage("tha", "en")).toBe("tha");
  });
  it("maps known language names case-insensitively", () => {
    expect(normalizeLanguage("thai", "en")).toBe("th");
    expect(normalizeLanguage("ENGLISH", "th")).toBe("en");
    expect(normalizeLanguage("Japanese", "th")).toBe("ja");
    expect(normalizeLanguage("chinese", "th")).toBe("zh");
    expect(normalizeLanguage("korean", "th")).toBe("ko");
  });
  it("falls back for unknown names rather than guessing", () => {
    expect(normalizeLanguage("klingon", "th")).toBe("th");
  });
  it("falls back for non-strings and blanks", () => {
    expect(normalizeLanguage(undefined, "th")).toBe("th");
    expect(normalizeLanguage(42, "th")).toBe("th");
    expect(normalizeLanguage(["en"], "th")).toBe("th");
    expect(normalizeLanguage("   ", "th")).toBe("th");
  });
});

describe("resolveAuthor", () => {
  it("trims a string author", () => {
    expect(resolveAuthor("  Robert C. Martin ", "Pan")).toBe("Robert C. Martin");
  });
  it("joins a YAML list author", () => {
    expect(resolveAuthor(["Kent Beck", "Martin Fowler"], "Pan")).toBe("Kent Beck, Martin Fowler");
  });
  it("drops empty entries when joining", () => {
    expect(resolveAuthor(["Kent Beck", "", "  "], "Pan")).toBe("Kent Beck");
  });
  it("falls back for blank, wrong-typed, or empty-array authors", () => {
    expect(resolveAuthor("", "Pan")).toBe("Pan");
    expect(resolveAuthor("   ", "Pan")).toBe("Pan");
    expect(resolveAuthor(undefined, "Pan")).toBe("Pan");
    expect(resolveAuthor(99, "Pan")).toBe("Pan");
    expect(resolveAuthor([], "Pan")).toBe("Pan");
    expect(resolveAuthor([1, 2], "Pan")).toBe("Pan");
  });
  it("uses Unknown when the fallback is itself empty", () => {
    expect(resolveAuthor(undefined, "")).toBe("Unknown");
    expect(resolveAuthor(undefined, "   ")).toBe("Unknown");
  });
});

describe("resolveTitle", () => {
  it("prefers a string alias", () => {
    expect(resolveTitle("clean_code", "Clean Code")).toBe("Clean Code");
  });
  it("prefers the first non-empty array alias", () => {
    expect(resolveTitle("clean_code", ["", "  ", "Clean Code", "CC"])).toBe("Clean Code");
  });
  it("falls back to basename for empty, absent, or wrong-typed aliases", () => {
    expect(resolveTitle("clean_code", undefined)).toBe("clean_code");
    expect(resolveTitle("clean_code", "")).toBe("clean_code");
    expect(resolveTitle("clean_code", [])).toBe("clean_code");
    expect(resolveTitle("clean_code", ["", "   "])).toBe("clean_code");
    expect(resolveTitle("clean_code", 7)).toBe("clean_code");
  });
});

describe("resolveCoverUrl", () => {
  it("accepts http and https, trimmed", () => {
    expect(resolveCoverUrl(" https://x.com/c.jpg ")).toBe("https://x.com/c.jpg");
    expect(resolveCoverUrl("HTTP://x.com/c.png")).toBe("HTTP://x.com/c.png");
  });
  it("rejects anything else", () => {
    expect(resolveCoverUrl("assets/cover.png")).toBeNull();
    expect(resolveCoverUrl("file:///c.png")).toBeNull();
    expect(resolveCoverUrl(undefined)).toBeNull();
    expect(resolveCoverUrl(["https://x.com/c.jpg"])).toBeNull();
    expect(resolveCoverUrl("")).toBeNull();
  });
});

describe("resolveMeta", () => {
  const defaults = { fallbackAuthor: "Pan", language: "th" };

  it("resolves every field from real vault-shaped frontmatter", () => {
    expect(
      resolveMeta(
        {
          aliases: ["Clean Code"],
          author: "Robert C. Martin",
          language: "english",
          coverUrl: "https://m.media-amazon.com/images/I/71T7aD3EOTL.jpg",
          tags: ["book", "main"],
        },
        "clean_code",
        defaults
      )
    ).toEqual({
      title: "Clean Code",
      author: "Robert C. Martin",
      language: "en",
      coverUrl: "https://m.media-amazon.com/images/I/71T7aD3EOTL.jpg",
    });
  });

  it("falls back on every field when frontmatter is absent", () => {
    expect(resolveMeta(undefined, "grokking_algorithms", defaults)).toEqual({
      title: "grokking_algorithms",
      author: "Pan",
      language: "th",
      coverUrl: null,
    });
  });

  it("handles the Thai book shape", () => {
    const m = resolveMeta({ language: "thai", author: "Aditya Y. Bhargava" }, "grokking_algorithms", defaults);
    expect(m.language).toBe("th");
    expect(m.author).toBe("Aditya Y. Bhargava");
    expect(m.title).toBe("grokking_algorithms");
  });
});
