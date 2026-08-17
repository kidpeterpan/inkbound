import { describe, expect, it, afterEach } from "vitest";
import { containsThai, thaiFontCss, THAI_FONT_FAMILY, OFL_LICENSE_TEXT, THAI_FONT_META } from "../src/fonts";
import {
  buildAsset,
  decodeBase64,
  loadThaiFontAsset,
  setThaiFontLoader,
  getThaiFontLoader,
} from "../src/font-assets";

describe("containsThai", () => {
  it("detects Thai consonants and vowels", () => {
    expect(containsThai("ภาษาไทย")).toBe(true);
    expect(containsThai("ก")).toBe(true);
    expect(containsThai("a ข b")).toBe(true);
  });

  it("detects Thai combining marks and tone marks", () => {
    expect(containsThai("ไม้เอก \u0E48")).toBe(true);
    expect(containsThai("กำ")).toBe(true); // ก + ำ (U+0E33)
  });

  it("detects Thai digits", () => {
    expect(containsThai("\u0E50\u0E59")).toBe(true);
  });

  it("does not detect Lao (different block), CJK, or Latin", () => {
    expect(containsThai("ພາສາລາວ")).toBe(false);
    expect(containsThai("中文")).toBe(false);
    expect(containsThai("english text")).toBe(false);
    expect(containsThai("")).toBe(false);
  });
});

describe("thaiFontCss", () => {
  it("declares regular and bold faces in the same family", () => {
    const css = thaiFontCss();
    expect(css).toContain(`font-family: "${THAI_FONT_FAMILY}"`);
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("font-weight: 700");
    expect(css).toContain('format("truetype")');
    expect((css.match(/@font-face/g) ?? []).length).toBe(2);
  });

  it("sets the body chain with a serif fallback for Latin text", () => {
    const css = thaiFontCss();
    expect(css).toContain(`body { font-family: "${THAI_FONT_FAMILY}", serif; }`);
  });
});

describe("THAI_FONT_META / license", () => {
  it("carries regular + bold entries with font/ttf media types", () => {
    expect(THAI_FONT_META).toHaveLength(2);
    expect(THAI_FONT_META.map((f) => f.mediaType)).toEqual(["font/ttf", "font/ttf"]);
  });

  it("carries the SIL OFL license text", () => {
    expect(OFL_LICENSE_TEXT).toContain("SIL Open Font License");
  });
});

describe("loadThaiFontAsset", () => {
  afterEach(() => {
    setThaiFontLoader(null); // module state discipline
  });

  it("returns non-empty regular and bold bytes (vitest fixture alias)", () => {
    const asset = loadThaiFontAsset();
    expect(asset).not.toBeNull();
    expect(asset!.regular.length).toBeGreaterThan(0);
    expect(asset!.bold.length).toBeGreaterThan(0);
    expect(asset!.license).toContain("SIL Open Font License");
  });

  it("degrades to null when the loader reports unusable fonts (FR-008)", () => {
    setThaiFontLoader(() => null);
    expect(getThaiFontLoader()()).toBeNull();
    setThaiFontLoader(null);
    expect(getThaiFontLoader()()).not.toBeNull();
  });

  // 008-mobile-support: the fonts are inlined as base64 rather than raw bytes,
  // because esbuild's "binary" loader under platform: "node" emits
  // `Buffer.from(...)` — and Buffer is a Node global that does not exist in
  // Obsidian mobile's WebView. It ran at module top level, so it killed the
  // plugin at load on mobile just as surely as a top-level require("fs") did.
  // decodeBase64 must therefore use only APIs present on BOTH platforms.
  it("decodeBase64 decodes without Buffer (008-mobile-support)", () => {
    expect(Array.from(decodeBase64("AAECAwQ="))).toEqual([0, 1, 2, 3, 4]);
  });

  it("decodeBase64 returns empty bytes for an empty string", () => {
    expect(decodeBase64("").length).toBe(0);
  });

  it("decodeBase64 degrades to empty bytes on malformed input, never throws (constitution II)", () => {
    expect(() => decodeBase64("!!!not base64!!!")).not.toThrow();
    expect(decodeBase64("!!!not base64!!!").length).toBe(0);
  });

  it("buildAsset degrades to null on empty regular or bold bytes (FR-008)", () => {
    expect(buildAsset(new Uint8Array(0), new Uint8Array([1]))).toBeNull();
    expect(buildAsset(new Uint8Array([1]), new Uint8Array(0))).toBeNull();
    expect(buildAsset(new Uint8Array([1]), new Uint8Array([1]))?.license).toContain("SIL Open Font License");
  });
});
