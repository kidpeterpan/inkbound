import { describe, it, expect } from "vitest";
import { slugify, deriveChapterTitle } from "../src/naming";

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
