import { describe, it, expect } from "vitest";
import { planImage, type ImageOptimizeOptions } from "../src/core/epub/image-optimizer";
import { readImageHeader } from "../src/core/epub/image-header";
import { jpegBytes, pngBytes } from "./fixtures/image-bytes";

// planImage decides from a file's header alone; building the header from real
// header bytes (rather than hand-written objects) keeps these tests honest
// about what the reader actually produces.
const OPTIONS: ImageOptimizeOptions = { maxWidth: 1200, grayscale: false };

function planFor(bytes: Uint8Array, mediaType: string, options: ImageOptimizeOptions = OPTIONS) {
  return planImage(readImageHeader(bytes), mediaType, options);
}

describe("planImage: files that are left alone", () => {
  it("keeps anything that is not a PNG or JPEG, whatever its bytes are (FR-003)", () => {
    const anyBytes = pngBytes({ width: 4000, height: 4000 });
    for (const mediaType of ["image/svg+xml", "image/gif", "image/webp"]) {
      expect(planFor(anyBytes, mediaType)).toEqual({ action: "keep" });
    }
  });

  it("keeps a file whose bytes do not match its media type (the extension lies; do not guess)", () => {
    expect(planFor(jpegBytes({ width: 4000, height: 3000 }), "image/png")).toEqual({ action: "keep" });
    expect(planFor(pngBytes({ width: 4000, height: 3000 }), "image/jpeg")).toEqual({ action: "keep" });
  });

  it("keeps an animated PNG, which shrinking would flatten to one frame", () => {
    const animated = pngBytes({ width: 4000, height: 3000, animation: "before-data" });
    expect(planFor(animated, "image/png")).toEqual({ action: "keep" });
  });

  it("keeps a PNG no wider than the maximum width, exactly equal included (FR-002)", () => {
    expect(planFor(pngBytes({ width: 800, height: 600 }), "image/png")).toEqual({ action: "keep" });
    expect(planFor(pngBytes({ width: 1200, height: 5000 }), "image/png")).toEqual({ action: "keep" });
  });

  it("keeps a JPEG when BOTH sides are within the maximum width (orientation cannot make it wider)", () => {
    expect(planFor(jpegBytes({ width: 1200, height: 900 }), "image/jpeg")).toEqual({ action: "keep" });
    expect(planFor(jpegBytes({ width: 900, height: 1200 }), "image/jpeg")).toEqual({ action: "keep" });
  });

  it("leaves a small image alone even with grayscale on: grayscale only changes images that are shrunk", () => {
    const grayscaleOn = { maxWidth: 1200, grayscale: true };
    expect(planFor(pngBytes({ width: 800, height: 600 }), "image/png", grayscaleOn)).toEqual({
      action: "keep",
    });
  });
});

describe("planImage: files handed to the codec", () => {
  it("processes a PNG wider than the maximum width", () => {
    expect(planFor(pngBytes({ width: 3200, height: 1800 }), "image/png")).toEqual({ action: "process" });
  });

  it("processes a JPEG wider than the maximum width", () => {
    expect(planFor(jpegBytes({ width: 4000, height: 3000 }), "image/jpeg")).toEqual({ action: "process" });
  });

  it("processes a tall, narrow JPEG: its stored width may be the rotated height, so the decoded size decides", () => {
    expect(planFor(jpegBytes({ width: 1000, height: 3000 }), "image/jpeg")).toEqual({ action: "process" });
  });

  it("follows the maximum width it is given", () => {
    const narrow = { maxWidth: 800, grayscale: false };
    expect(planFor(pngBytes({ width: 1000, height: 500 }), "image/png", narrow)).toEqual({
      action: "process",
    });
    expect(planFor(pngBytes({ width: 1000, height: 500 }), "image/png")).toEqual({ action: "keep" });
  });
});

describe("planImage: files that cannot be processed", () => {
  it("fails an image media type whose bytes are not a readable PNG or JPEG (a damaged file)", () => {
    const damaged = Uint8Array.of(1, 2, 3, 4);
    expect(planFor(damaged, "image/png")).toEqual({
      action: "fail",
      reason: "not a readable PNG or JPEG image",
    });
    expect(planFor(damaged, "image/jpeg")).toEqual({
      action: "fail",
      reason: "not a readable PNG or JPEG image",
    });
  });

  it("does not call a damaged SVG, GIF or WebP a failure: those types are never touched", () => {
    expect(planFor(Uint8Array.of(1, 2, 3, 4), "image/svg+xml")).toEqual({ action: "keep" });
  });

  it("fails an image over the source ceiling, naming its size", () => {
    expect(planFor(pngBytes({ width: 10001, height: 10000 }), "image/png")).toEqual({
      action: "fail",
      reason: "too large to process (10001×10000)",
    });
  });

  it("processes an image exactly at the source ceiling", () => {
    expect(planFor(pngBytes({ width: 10000, height: 10000 }), "image/png")).toEqual({ action: "process" });
  });

  it("fails an image whose shrunk result would be over the output ceiling, naming the result's size", () => {
    expect(planFor(pngBytes({ width: 2400, height: 27964 }), "image/png")).toEqual({
      action: "fail",
      reason: "result would be too large (1200×13982)",
    });
  });

  it("processes an image whose shrunk result is exactly within the output ceiling", () => {
    // 1200 × 13981 = 16,777,200, just under 16,777,216.
    expect(planFor(pngBytes({ width: 2400, height: 27962 }), "image/png")).toEqual({ action: "process" });
  });
});

// The ceilings only apply to an image that would otherwise be processed. These
// pass before the ceilings exist and turn red if one is ever placed ahead of the
// "already small" rules, which would warn about images that need no work (FR-002).
describe("planImage: the ceilings never apply to an image that is left alone", () => {
  it("keeps a very tall PNG that is narrower than the target, however many pixels it holds", () => {
    // 104 million pixels: over the source ceiling, but nothing will be decoded.
    expect(planFor(pngBytes({ width: 800, height: 130000 }), "image/png")).toEqual({ action: "keep" });
  });

  it("processes a tall, narrow JPEG, because its stored width is within the target and no resize can happen", () => {
    // 1000×30000 would "shrink" to 1200×36000 if it were estimated as a resize.
    expect(planFor(jpegBytes({ width: 1000, height: 30000 }), "image/jpeg")).toEqual({ action: "process" });
  });
});
