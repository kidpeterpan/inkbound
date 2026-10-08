import { describe, it, expect, afterEach, vi } from "vitest";
import { createImageOptimizer, type ImageOptimizeOptions } from "../src/core/epub/image-optimizer";
import { fakeImageCodec, SHRUNK_BYTES, type FakeCodecResult } from "./fixtures/fake-image-codec";
import { jpegBytes, pngBytes } from "./fixtures/image-bytes";

const OPTIONS: ImageOptimizeOptions = { maxWidth: 1200, grayscale: false };

// A 3200×1800 PNG padded well past one byte, so the codec's one-byte answer is
// genuinely smaller than the original.
const bigPng = () => pngBytes({ width: 3200, height: 1800, padBytes: 2000 });

function optimizerWith(script: FakeCodecResult[] = [], options: ImageOptimizeOptions = OPTIONS) {
  const codec = fakeImageCodec({ script });
  const warnBook = vi.fn();
  const optimize = createImageOptimizer(options, codec, warnBook);
  return { codec, warnBook, optimize };
}

describe("createImageOptimizer: images that get processed", () => {
  it("returns the codec's bytes when they are smaller than the original (US1-1)", async () => {
    const { optimize } = optimizerWith();
    const outcome = await optimize(bigPng(), "image/png");
    expect(outcome).toEqual({ kind: "optimized", bytes: SHRUNK_BYTES });
  });

  it("asks the codec for exactly this image, width and grayscale choice", async () => {
    const { codec, optimize } = optimizerWith([], { maxWidth: 800, grayscale: true });
    const original = bigPng();
    await optimize(original, "image/png");
    expect(codec.requests).toEqual([
      { bytes: original, mediaType: "image/png", maxWidth: 800, grayscale: true },
    ]);
  });

  it("processes a wide JPEG too, and keeps its media type", async () => {
    const { codec, optimize } = optimizerWith();
    const outcome = await optimize(jpegBytes({ width: 4000, height: 3000 }), "image/jpeg");
    expect(outcome.kind).toBe("optimized");
    expect(codec.requests[0]!.mediaType).toBe("image/jpeg");
  });

  it("keeps the original when the codec's result is the same size (FR-005: never bigger, never a tie)", async () => {
    const original = bigPng();
    const { optimize } = optimizerWith([new Uint8Array(original.length)]);
    expect(await optimize(original, "image/png")).toEqual({ kind: "kept" });
  });

  it("keeps the original when the codec's result is larger (US1-4)", async () => {
    const original = bigPng();
    const { optimize } = optimizerWith([new Uint8Array(original.length + 1)]);
    expect(await optimize(original, "image/png")).toEqual({ kind: "kept" });
  });

  it("keeps the original when the codec says there is nothing to do (decoded width already within the maximum)", async () => {
    const { optimize } = optimizerWith([null]);
    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "kept" });
  });

  it("gives the same outcome for the same input twice (FR-009)", async () => {
    const { optimize } = optimizerWith([SHRUNK_BYTES, SHRUNK_BYTES]);
    const first = await optimize(bigPng(), "image/png");
    const second = await optimize(bigPng(), "image/png");
    expect(second).toEqual(first);
  });
});

describe("createImageOptimizer: images that are never handed to the codec", () => {
  it("keeps a small image without calling the codec (US1-2)", async () => {
    const { codec, optimize } = optimizerWith();
    expect(await optimize(pngBytes({ width: 800, height: 600 }), "image/png")).toEqual({ kind: "kept" });
    expect(codec.requests).toEqual([]);
  });

  it("keeps SVG, GIF and WebP without calling the codec (US1-3)", async () => {
    const { codec, optimize } = optimizerWith();
    for (const mediaType of ["image/svg+xml", "image/gif", "image/webp"]) {
      expect(await optimize(new TextEncoder().encode("anything"), mediaType)).toEqual({ kind: "kept" });
    }
    expect(codec.requests).toEqual([]);
  });

  it("keeps an animated PNG without calling the codec", async () => {
    const { codec, optimize } = optimizerWith();
    const animated = pngBytes({ width: 4000, height: 3000, animation: "before-data" });
    expect(await optimize(animated, "image/png")).toEqual({ kind: "kept" });
    expect(codec.requests).toEqual([]);
  });
});

// ── User Story 3: images that cannot be processed ─────────────────────────

const UNAVAILABLE_WARNING = "image optimization unavailable here — images kept at original size";
const STOPPED_WARNING =
  "image optimization stopped — several images timed out; the rest were kept at original size";
const TIMEOUT_MS = 20_000;

describe("createImageOptimizer: failures of one image", () => {
  it("reports a damaged file without calling the codec", async () => {
    const { codec, optimize } = optimizerWith();
    const outcome = await optimize(Uint8Array.of(1, 2, 3, 4), "image/png");
    expect(outcome).toEqual({ kind: "failed", reason: "not a readable PNG or JPEG image" });
    expect(codec.requests).toEqual([]);
  });

  it("reports an image over the pixel ceiling without calling the codec", async () => {
    const { codec, optimize } = optimizerWith();
    const outcome = await optimize(pngBytes({ width: 10001, height: 10000 }), "image/png");
    expect(outcome).toEqual({ kind: "failed", reason: "too large to process (10001×10000)" });
    expect(codec.requests).toEqual([]);
  });

  it("turns a rejected codec call into a failure carrying the error's message", async () => {
    const { optimize } = optimizerWith([new Error("could not be decoded")]);
    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "failed", reason: "could not be decoded" });
  });

  it("turns a codec that throws before returning a promise into a failure too", async () => {
    const { optimize } = optimizerWith(["throws"]);
    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "failed", reason: "codec exploded" });
  });

  it("carries on with the next image after a failure", async () => {
    const { optimize } = optimizerWith([new Error("could not be decoded"), SHRUNK_BYTES]);
    await optimize(bigPng(), "image/png");
    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "optimized", bytes: SHRUNK_BYTES });
  });
});

describe("createImageOptimizer: images that never finish", () => {
  afterEach(() => vi.useRealTimers());

  // Starts one image whose codec never answers, lets the timeout fire, and
  // returns what the optimizer concluded.
  async function optimizeUntilTimeout(optimize: ReturnType<typeof optimizerWith>["optimize"]) {
    const pending = optimize(bigPng(), "image/png");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    return pending;
  }

  it("gives up on an image after 20 seconds and keeps the original", async () => {
    vi.useFakeTimers();
    const { optimize } = optimizerWith(["never-settles"]);
    expect(await optimizeUntilTimeout(optimize)).toEqual({
      kind: "failed",
      reason: "timed out after 20 seconds",
    });
  });

  it("does not time out an image that finishes in time", async () => {
    vi.useFakeTimers();
    const { optimize } = optimizerWith([SHRUNK_BYTES]);
    const pending = optimize(bigPng(), "image/png");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(await pending).toEqual({ kind: "optimized", bytes: SHRUNK_BYTES });
  });

  it("stops trying after three timeouts in a row, warning once, and keeps every later image (FR-015)", async () => {
    vi.useFakeTimers();
    const { codec, warnBook, optimize } = optimizerWith(["never-settles", "never-settles", "never-settles"]);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await optimizeUntilTimeout(optimize)).toMatchObject({ kind: "failed" });
    }
    expect(warnBook).toHaveBeenCalledTimes(1);
    expect(warnBook).toHaveBeenCalledWith(STOPPED_WARNING);

    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "kept" });
    expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "kept" });
    expect(codec.requests).toHaveLength(3);
    expect(warnBook).toHaveBeenCalledTimes(1);
  });

  it("does not stop when a success comes between timeouts", async () => {
    vi.useFakeTimers();
    const script: FakeCodecResult[] = [
      "never-settles",
      "never-settles",
      SHRUNK_BYTES,
      "never-settles",
      "never-settles",
    ];
    const { codec, warnBook, optimize } = optimizerWith(script);

    await optimizeUntilTimeout(optimize);
    await optimizeUntilTimeout(optimize);
    expect(await optimize(bigPng(), "image/png")).toMatchObject({ kind: "optimized" });
    await optimizeUntilTimeout(optimize);
    await optimizeUntilTimeout(optimize);

    expect(codec.requests).toHaveLength(5);
    expect(warnBook).not.toHaveBeenCalled();
  });

  it("does not stop when another kind of failure comes between timeouts: the codec is still answering", async () => {
    vi.useFakeTimers();
    const script: FakeCodecResult[] = [
      "never-settles",
      "never-settles",
      new Error("could not be decoded"),
      "never-settles",
    ];
    const { warnBook, optimize } = optimizerWith(script);

    await optimizeUntilTimeout(optimize);
    await optimizeUntilTimeout(optimize);
    await optimize(bigPng(), "image/png");
    await optimizeUntilTimeout(optimize);

    expect(warnBook).not.toHaveBeenCalled();
  });
});

describe("createImageOptimizer: a device that cannot process images at all", () => {
  it("keeps every image, never calls the codec, and warns once for the whole book", async () => {
    const codec = fakeImageCodec({ available: false });
    const warnBook = vi.fn();
    const optimize = createImageOptimizer(OPTIONS, codec, warnBook);

    for (let image = 0; image < 3; image++) {
      expect(await optimize(bigPng(), "image/png")).toEqual({ kind: "kept" });
    }

    expect(codec.requests).toEqual([]);
    expect(warnBook).toHaveBeenCalledTimes(1);
    expect(warnBook).toHaveBeenCalledWith(UNAVAILABLE_WARNING);
  });

  it("does not ask whether the device can process images until an image actually needs it", async () => {
    const codec = fakeImageCodec({ available: false });
    const warnBook = vi.fn();
    const optimize = createImageOptimizer(OPTIONS, codec, warnBook);

    await optimize(pngBytes({ width: 800, height: 600 }), "image/png");
    await optimize(new TextEncoder().encode("<svg/>"), "image/svg+xml");

    expect(codec.availableCalls).toBe(0);
    expect(warnBook).not.toHaveBeenCalled();
  });
});
