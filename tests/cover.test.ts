import { describe, it, expect } from "vitest";
import { parseCoverValue, findImageEmbeds, isSupportedCoverExt } from "../src/cover";

describe("parseCoverValue", () => {
  it("accepts a vault-relative path", () => {
    expect(parseCoverValue("assets/cover.png")).toEqual({ kind: "path", path: "assets/cover.png" });
  });

  it("accepts a bare filename", () => {
    expect(parseCoverValue("cover.png")).toEqual({ kind: "path", path: "cover.png" });
  });

  it("strips wikilink brackets", () => {
    expect(parseCoverValue("[[cover.png]]")).toEqual({ kind: "path", path: "cover.png" });
  });

  it("strips embed markers and an |alt suffix", () => {
    expect(parseCoverValue("![[cover.png|200]]")).toEqual({ kind: "path", path: "cover.png" });
    expect(parseCoverValue("![[cover.webp]]")).toEqual({ kind: "path", path: "cover.webp" });
  });

  it("accepts http(s) URLs", () => {
    expect(parseCoverValue("https://x.example/c.png")).toEqual({
      kind: "url",
      url: "https://x.example/c.png",
    });
    expect(parseCoverValue("HTTP://x.example/c.jpg")).toEqual({
      kind: "url",
      url: "HTTP://x.example/c.jpg",
    });
  });

  it("returns null for empty, whitespace-only, undefined, and non-string values", () => {
    expect(parseCoverValue("")).toBeNull();
    expect(parseCoverValue("   ")).toBeNull();
    expect(parseCoverValue(undefined)).toBeNull();
    expect(parseCoverValue(123)).toBeNull();
    expect(parseCoverValue(null)).toBeNull();
  });

  it("takes the first parseable entry from an array", () => {
    expect(parseCoverValue(["[[a.png]]", "b.png"])).toEqual({ kind: "path", path: "a.png" });
    expect(parseCoverValue(["", "b.png"])).toEqual({ kind: "path", path: "b.png" });
    expect(parseCoverValue(["", "  "])).toBeNull();
  });

  it("keeps whitespace-trimmed path values", () => {
    expect(parseCoverValue("  assets/cover.png  ")).toEqual({ kind: "path", path: "assets/cover.png" });
  });
});

describe("findImageEmbeds", () => {
  it("returns image embeds in document order", () => {
    expect(findImageEmbeds("![[a.png]]\n\n![alt](b.png)")).toEqual(["a.png", "b.png"]);
  });

  it("skips embeds inside fenced code blocks (``` and ~~~)", () => {
    const md = "![[a.png]]\n```ts\n![[b.png]]\n```\n![alt](c.png)\n~~~\n![d](d.png)\n~~~";
    expect(findImageEmbeds(md)).toEqual(["a.png", "c.png"]);
  });

  it("strips |alt suffixes from wikilink embeds", () => {
    expect(findImageEmbeds("![[img.png|300]]")).toEqual(["img.png"]);
  });

  it("handles quoted markdown-image targets", () => {
    expect(findImageEmbeds('![alt]("x.png")')).toEqual(["x.png"]);
  });

  it("returns an empty array for notes without images", () => {
    expect(findImageEmbeds("just text\n\n# heading")).toEqual([]);
    expect(findImageEmbeds("")).toEqual([]);
  });

  it("keeps a wikilink heading/block suffix for the caller to resolve", () => {
    expect(findImageEmbeds("![[img.png#part]]")).toEqual(["img.png#part"]);
  });

  it("does not treat plain (non-embed) wikilinks as images", () => {
    expect(findImageEmbeds("[[note.md]] and [[img.png]]")).toEqual([]);
  });
});

describe("isSupportedCoverExt", () => {
  it("accepts png, jpg, jpeg, and webp case-insensitively", () => {
    expect(isSupportedCoverExt("png")).toBe(true);
    expect(isSupportedCoverExt("jpg")).toBe(true);
    expect(isSupportedCoverExt("jpeg")).toBe(true);
    expect(isSupportedCoverExt("webp")).toBe(true);
    expect(isSupportedCoverExt("PNG")).toBe(true);
    expect(isSupportedCoverExt("WebP")).toBe(true);
  });

  it("rejects gif, svg, bmp, tiff, and empty strings", () => {
    expect(isSupportedCoverExt("gif")).toBe(false);
    expect(isSupportedCoverExt("svg")).toBe(false);
    expect(isSupportedCoverExt("bmp")).toBe(false);
    expect(isSupportedCoverExt("tiff")).toBe(false);
    expect(isSupportedCoverExt("")).toBe(false);
  });
});
