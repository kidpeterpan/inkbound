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
  it("returns basename by default", () => {
    expect(deriveChapterTitle("01_hello_world", ["Hello"], "Hello World")).toBe("01_hello_world");
  });
});
