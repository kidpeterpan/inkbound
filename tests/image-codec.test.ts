import { describe, it, expect, afterEach, vi } from "vitest";
// createEl() — the global the codec uses to make its canvas — is installed by
// the obsidian stub. The codec itself imports nothing from obsidian, so load the
// stub explicitly rather than rely on another test having done it.
import "./fixtures/obsidian-stub";
import { JPEG_QUALITY, getImageCodec, setImageCodec, toGrayscale } from "../src/core/epub/image-codec";
import { fakeImageCodec } from "./fixtures/fake-image-codec";

// The default codec talks to Image, URL.createObjectURL and a 2-D canvas, none
// of which jsdom can really run. These tests stub just enough of that surface to
// walk the codec's branches deterministically, exactly as tests/render.test.ts
// does for the SVG rasterizer. They do NOT prove that a real canvas scales a
// picture well: that is a device check (docs/DEVELOPMENT.md, FR-016).

const ORIGINAL_IMAGE = globalThis.Image;
const ORIGINAL_CREATE_OBJECT_URL = URL.createObjectURL;
const ORIGINAL_REVOKE_OBJECT_URL = URL.revokeObjectURL;
const ORIGINAL_GET_CONTEXT = HTMLCanvasElement.prototype.getContext;
const ORIGINAL_TO_BLOB = HTMLCanvasElement.prototype.toBlob;

afterEach(() => {
  globalThis.Image = ORIGINAL_IMAGE;
  URL.createObjectURL = ORIGINAL_CREATE_OBJECT_URL;
  URL.revokeObjectURL = ORIGINAL_REVOKE_OBJECT_URL;
  HTMLCanvasElement.prototype.getContext = ORIGINAL_GET_CONTEXT;
  HTMLCanvasElement.prototype.toBlob = ORIGINAL_TO_BLOB;
  setImageCodec(null);
  vi.restoreAllMocks();
});

const ENCODED_BYTES = Uint8Array.of(7, 7, 7);

interface Surface {
  revokedUrls: string[];
  imageSources: string[];
  drawCalls: unknown[][];
  canvas: { sizeAtDraw?: { width: number; height: number }; element?: HTMLCanvasElement };
  encoded: { type?: string; quality?: unknown };
  smoothingQuality: string[];
  // Which canvas operations ran, in order, so a test can say "converted to gray
  // BEFORE it was encoded".
  operations: string[];
  // The pixels the fake canvas holds: one opaque red pixel and one half-transparent blue one.
  pixels: Uint8ClampedArray;
  imageDataRequests: unknown[][];
}

// Installs every browser surface the default codec uses. `image` is what the
// browser "decodes"; `encode` says whether toBlob yields a Blob or null.
function installSurface(options: {
  image?: "load" | "error";
  naturalWidth?: number;
  naturalHeight?: number;
  context?: "available" | "missing";
  encode?: "blob" | "null";
}): Surface {
  const { image = "load", naturalWidth = 3200, naturalHeight = 1800 } = options;
  const { context = "available", encode = "blob" } = options;
  const surface: Surface = {
    revokedUrls: [],
    imageSources: [],
    drawCalls: [],
    canvas: {},
    encoded: {},
    smoothingQuality: [],
    operations: [],
    pixels: Uint8ClampedArray.of(255, 0, 0, 255, 0, 0, 255, 128),
    imageDataRequests: [],
  };

  URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => surface.revokedUrls.push(url)) as typeof URL.revokeObjectURL;

  class FakeImage {
    naturalWidth = naturalWidth;
    naturalHeight = naturalHeight;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      surface.imageSources.push(value);
      if (value === "") return; // clearing the source must not fire a load
      queueMicrotask(() => (image === "load" ? this.onload?.() : this.onerror?.()));
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image;

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    if (context === "missing") return null;
    surface.canvas.element = this;
    return {
      set imageSmoothingQuality(value: string) {
        surface.smoothingQuality.push(value);
      },
      drawImage: (...args: unknown[]) => {
        surface.drawCalls.push(args);
        surface.canvas.sizeAtDraw = { width: this.width, height: this.height };
      },
      getImageData: (...args: unknown[]) => {
        surface.operations.push("getImageData");
        surface.imageDataRequests.push(args);
        return { data: surface.pixels };
      },
      putImageData: () => {
        surface.operations.push("putImageData");
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, quality?: unknown) {
    surface.encoded = { type, quality };
    surface.operations.push("toBlob");
    const blob = encode === "null" ? null : ({ arrayBuffer: async () => ENCODED_BYTES.buffer } as Blob);
    queueMicrotask(() => callback(blob));
  } as unknown as typeof HTMLCanvasElement.prototype.toBlob;

  return surface;
}

const request = (overrides: Partial<Parameters<ReturnType<typeof getImageCodec>["resample"]>[0]> = {}) => ({
  bytes: Uint8Array.of(1, 2, 3),
  mediaType: "image/png" as const,
  maxWidth: 1200,
  grayscale: false,
  ...overrides,
});

describe("the default image codec: availability", () => {
  it("is unavailable under plain jsdom, and says so without logging anything", () => {
    const consoleSpies = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    expect(getImageCodec().available()).toBe(false);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("is available once Image, URL.createObjectURL and a canvas exist", () => {
    installSurface({});
    expect(getImageCodec().available()).toBe(true);
  });
});

describe("the default image codec: scaling", () => {
  it("scales a 3200×1800 PNG to 1200×675 in one high-quality draw and encodes it as a PNG", async () => {
    const surface = installSurface({ naturalWidth: 3200, naturalHeight: 1800 });
    const bytes = await getImageCodec().resample(request());

    expect(bytes).toEqual(ENCODED_BYTES);
    expect(surface.smoothingQuality).toEqual(["high"]);
    expect(surface.canvas.sizeAtDraw).toEqual({ width: 1200, height: 675 });
    expect(surface.drawCalls).toHaveLength(1);
    expect(surface.drawCalls[0]!.slice(1)).toEqual([0, 0, 1200, 675]);
    expect(surface.encoded.type).toBe("image/png");
  });

  it("encodes a JPEG as a JPEG at the fixed quality (FR-009: same input, same bytes)", async () => {
    const surface = installSurface({ naturalWidth: 4000, naturalHeight: 3000 });
    await getImageCodec().resample(request({ mediaType: "image/jpeg" }));

    expect(surface.encoded).toEqual({ type: "image/jpeg", quality: JPEG_QUALITY });
    expect(JPEG_QUALITY).toBe(0.85);
  });

  it("sizes the result from the decoded image, not from the file's bytes", async () => {
    // The request's bytes are three arbitrary bytes with no header at all; only
    // the decoded size (already rotated by the browser) can have driven this.
    const surface = installSurface({ naturalWidth: 3000, naturalHeight: 4000 });
    await getImageCodec().resample(request());
    expect(surface.canvas.sizeAtDraw).toEqual({ width: 1200, height: 1600 });
  });

  it("resolves null, and draws nothing, when the decoded width is already within the maximum", async () => {
    const surface = installSurface({ naturalWidth: 1000, naturalHeight: 30000 });
    await expect(getImageCodec().resample(request())).resolves.toBeNull();
    expect(surface.drawCalls).toEqual([]);
  });
});

describe("the default image codec: failures", () => {
  it("rejects with 'could not be decoded' when the browser refuses the file", async () => {
    installSurface({ image: "error" });
    await expect(getImageCodec().resample(request())).rejects.toThrow("could not be decoded");
  });

  it("rejects with 'could not be encoded' when toBlob yields nothing", async () => {
    installSurface({ encode: "null" });
    await expect(getImageCodec().resample(request())).rejects.toThrow("could not be encoded");
  });

  it("rejects when the canvas has no 2-D context", async () => {
    installSurface({ context: "missing" });
    await expect(getImageCodec().resample(request())).rejects.toThrow("no 2-D canvas");
  });
});

describe("the default image codec: releasing what it used", () => {
  it("zeroes the canvas, revokes the Blob URL and clears the image source after a success", async () => {
    const surface = installSurface({});
    await getImageCodec().resample(request());

    expect(surface.canvas.element!.width).toBe(0);
    expect(surface.canvas.element!.height).toBe(0);
    expect(surface.revokedUrls).toEqual(["blob:fake"]);
    expect(surface.imageSources.at(-1)).toBe("");
  });

  it("does the same after a failure", async () => {
    const surface = installSurface({ encode: "null" });
    await expect(getImageCodec().resample(request())).rejects.toThrow();

    expect(surface.canvas.element!.width).toBe(0);
    expect(surface.revokedUrls).toEqual(["blob:fake"]);
    expect(surface.imageSources.at(-1)).toBe("");
  });

  it("revokes the Blob URL even when the image is already small and nothing is drawn", async () => {
    const surface = installSurface({ naturalWidth: 800, naturalHeight: 600 });
    await getImageCodec().resample(request());
    expect(surface.revokedUrls).toEqual(["blob:fake"]);
  });
});

describe("setImageCodec / getImageCodec", () => {
  it("returns an installed codec, and null restores the default", () => {
    const fake = fakeImageCodec();
    setImageCodec(fake);
    expect(getImageCodec()).toBe(fake);

    setImageCodec(null);
    expect(getImageCodec()).not.toBe(fake);
  });
});

// ── User Story 4: grayscale ───────────────────────────────────────────────

describe("toGrayscale", () => {
  it("sets red, green and blue to the same integer luma value", () => {
    const pixels = Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255);
    toGrayscale(pixels);
    // (299 r + 587 g + 114 b + 500) / 1000, rounded down.
    expect(Array.from(pixels)).toEqual([
      76, 76, 76, 255, 150, 150, 150, 255, 29, 29, 29, 255, 255, 255, 255, 255,
    ]);
  });

  it("leaves every alpha byte exactly as it was, so a transparent area stays transparent (US4-4)", () => {
    const pixels = Uint8ClampedArray.of(10, 20, 30, 0, 200, 100, 50, 128);
    toGrayscale(pixels);
    expect([pixels[3], pixels[7]]).toEqual([0, 128]);
  });

  it("leaves a pixel that is already gray unchanged", () => {
    const pixels = Uint8ClampedArray.of(90, 90, 90, 255);
    toGrayscale(pixels);
    expect(Array.from(pixels)).toEqual([90, 90, 90, 255]);
  });

  it("accepts an empty array", () => {
    expect(() => toGrayscale(new Uint8ClampedArray(0))).not.toThrow();
  });
});

describe("the default image codec: grayscale", () => {
  it("converts the scaled pixels to gray BEFORE it encodes them (US4-1)", async () => {
    const surface = installSurface({ naturalWidth: 3200, naturalHeight: 1800 });
    await getImageCodec().resample(request({ grayscale: true }));

    expect(surface.operations).toEqual(["getImageData", "putImageData", "toBlob"]);
    expect(surface.imageDataRequests).toEqual([[0, 0, 1200, 675]]);
    // The fake canvas's red pixel is now luma 76 on all three channels.
    expect(Array.from(surface.pixels.slice(0, 4))).toEqual([76, 76, 76, 255]);
  });

  it("does not touch the pixels when grayscale is off (US4-2)", async () => {
    const surface = installSurface({ naturalWidth: 3200, naturalHeight: 1800 });
    await getImageCodec().resample(request({ grayscale: false }));

    expect(surface.operations).toEqual(["toBlob"]);
    expect(Array.from(surface.pixels.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it("still returns null for an image that already fits, even with grayscale on: small images are never converted (US4-3)", async () => {
    const surface = installSurface({ naturalWidth: 800, naturalHeight: 600 });
    await expect(getImageCodec().resample(request({ grayscale: true }))).resolves.toBeNull();
    expect(surface.operations).toEqual([]);
  });
});
