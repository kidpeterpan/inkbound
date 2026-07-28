import { describe, it, expect } from "vitest";
import { resolveOutputPath, summarizeWarnings, DEFAULT_SETTINGS } from "../src/settings-core";

describe("resolveOutputPath", () => {
  it("expands empty folder to ~/Downloads", () => {
    expect(resolveOutputPath("", "my_book", "/Users/pan")).toBe("/Users/pan/Downloads/my_book.epub");
  });
  it("expands leading tilde", () => {
    expect(resolveOutputPath("~/books", "x", "/Users/pan")).toBe("/Users/pan/books/x.epub");
  });
  it("keeps absolute paths", () => {
    expect(resolveOutputPath("/tmp/out", "x", "/Users/pan")).toBe("/tmp/out/x.epub");
  });
});

describe("summarizeWarnings", () => {
  it("is null when there are no warnings", () => {
    expect(summarizeWarnings([])).toBeNull();
  });
  it("counts warnings and points at the console", () => {
    expect(summarizeWarnings(["a", "b"])).toBe("Exported with 2 warnings — details in developer console.");
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("matches the spec defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      outputFolder: "", linkDepth: 1, language: "th",
      fallbackAuthor: "", booxUrl: "", pushAfterExport: false,
    });
  });
});
