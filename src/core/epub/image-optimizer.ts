// Pure of the app (no "obsidian" import): decides what happens to each image on
// its way into the book — leave it alone, shrink it, or give up on it — and never
// makes a book bigger.
//
// The only thing that touches pixels is the injected ImageCodec, so every rule
// here is tested with a scripted codec and no canvas. The one browser global this
// module reads is the window's timer, inside withTimeout, and only when an image
// is actually being processed. The rules follow
// specs/013-eink-image-optimization/data-model.md §4.
import { errorMessage } from "../common/error-text";
import type { ImageCodec, ImageCodecRequest } from "./image-codec";
import { fitWidth } from "./image-fit";
import { readImageHeader, type ImageHeader } from "./image-header";

// Refused before anything is decoded. On a phone a canvas past the platform's
// area limit can come back blank instead of throwing, and a blank picture is far
// smaller than the original, so it would sail through "keep the original unless
// the result is smaller". Both numbers are conservative guesses that only a real
// device can confirm (docs/DEVELOPMENT.md): 100 megapixels still admits a
// 48-megapixel phone photo.
export const MAX_SOURCE_PIXELS = 100_000_000;
export const MAX_OUTPUT_PIXELS = 16_777_216;

// A decode that never settles must not hold the export up. One image may take
// 20 seconds; three in a row stop further attempts for the book, so the worst
// case is about a minute of waiting rather than one wait per image.
export const IMAGE_TIMEOUT_MS = 20_000;
export const MAX_CONSECUTIVE_TIMEOUTS = 3;

const UNAVAILABLE_WARNING = "image optimization unavailable here — images kept at original size";
const STOPPED_WARNING =
  "image optimization stopped — several images timed out; the rest were kept at original size";

export interface ImageOptimizeOptions {
  maxWidth: number;
  grayscale: boolean;
}

export type ImagePlan = { action: "keep" } | { action: "process" } | { action: "fail"; reason: string };

export type OptimizeOutcome =
  // The original bytes are the right answer; nothing to report.
  | { kind: "kept" }
  | { kind: "optimized"; bytes: Uint8Array }
  // This image could not be processed: embed the original and warn.
  | { kind: "failed"; reason: string };

export type ImageOptimizer = (bytes: Uint8Array, mediaType: string) => Promise<OptimizeOutcome>;

const KEEP: ImagePlan = { action: "keep" };
const PROCESS: ImagePlan = { action: "process" };
const KEPT: OptimizeOutcome = { kind: "kept" };

const FORMAT_BY_MEDIA_TYPE: Record<string, ImageHeader["format"]> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
};

// "Already small" must hold however the file is rotated. A PNG has no rotation,
// so its width is its width. A JPEG's stored size ignores its EXIF orientation,
// so it is only certainly small when BOTH sides fit; a tall, narrow JPEG is
// decoded and the codec judges it by its real, rotated width.
function isAlreadySmall(header: ImageHeader, maxWidth: number): boolean {
  const widestSide = header.format === "png" ? header.width : Math.max(header.width, header.height);
  return widestSide <= maxWidth;
}

// Only asked of an image that is about to be decoded. The output ceiling applies
// only when a resize will actually happen (stored width over the target): a tall,
// narrow JPEG is not enlarged by being estimated at the target width.
function ceilingFailure(header: ImageHeader, maxWidth: number): string | null {
  if (header.width * header.height > MAX_SOURCE_PIXELS) {
    return `too large to process (${header.width}×${header.height})`;
  }
  if (header.width <= maxWidth) return null;

  const result = fitWidth(header.width, header.height, maxWidth);
  if (result.width * result.height > MAX_OUTPUT_PIXELS) {
    return `result would be too large (${result.width}×${result.height})`;
  }
  return null;
}

// The ceilings come LAST, after every rule that leaves an image alone: a file
// that needs no work stays byte-for-byte and warning-free (FR-002), however many
// pixels it holds.
export function planImage(
  header: ImageHeader | null,
  mediaType: string,
  options: ImageOptimizeOptions
): ImagePlan {
  const format = FORMAT_BY_MEDIA_TYPE[mediaType];
  if (format === undefined) return KEEP;
  if (header === null) return { action: "fail", reason: "not a readable PNG or JPEG image" };
  // The extension lies about the contents; do not guess, do not touch.
  if (header.format !== format) return KEEP;
  if (header.animated) return KEEP;
  if (isAlreadySmall(header, options.maxWidth)) return KEEP;

  const reason = ceilingFailure(header, options.maxWidth);
  return reason === null ? PROCESS : { action: "fail", reason };
}

function smallerOrKept(original: Uint8Array, resampled: Uint8Array | null): OptimizeOutcome {
  if (resampled === null) return KEPT;
  // A tie is "not smaller": the encoder is not an optimizer, and equal bytes
  // would only mean a different file for no gain (FR-005).
  return resampled.length < original.length ? { kind: "optimized", bytes: resampled } : KEPT;
}

class ImageTimeoutError extends Error {
  constructor(milliseconds: number) {
    super(`timed out after ${milliseconds / 1000} seconds`);
  }
}

// Rejects with an ImageTimeoutError when `work` has not settled in time. Whatever
// `work` does afterwards is ignored, so a late rejection is never unhandled.
// `window.setTimeout`, not the bare global: Obsidian's review asks for it so a
// timer belongs to the window the plugin runs in, popout windows included.
function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new ImageTimeoutError(milliseconds)), milliseconds);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    );
  });
}

// `warnBook` carries the two things that are about the whole book rather than
// one image: the device cannot process images at all, or it kept timing out.
// Either way the codec is not asked again for the rest of the book.
export function createImageOptimizer(
  options: ImageOptimizeOptions,
  codec: ImageCodec,
  warnBook: (message: string) => void
): ImageOptimizer {
  let stopped = false;
  let consecutiveTimeouts = 0;

  function stopForTheBook(warning: string): void {
    stopped = true;
    warnBook(warning);
  }

  // Asked only when an image actually needs the codec, so a book with nothing to
  // process never mentions the device.
  function deviceCanProcessImages(): boolean {
    if (codec.available()) return true;

    stopForTheBook(UNAVAILABLE_WARNING);
    return false;
  }

  // Counts timeouts in a row. Any other answer from the codec, good or bad,
  // proves it is still responding and starts the count again.
  function failedOutcome(error: unknown): OptimizeOutcome {
    const timedOut = error instanceof ImageTimeoutError;
    consecutiveTimeouts = timedOut ? consecutiveTimeouts + 1 : 0;
    if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) stopForTheBook(STOPPED_WARNING);

    return { kind: "failed", reason: errorMessage(error) };
  }

  async function processWithCodec(bytes: Uint8Array, mediaType: string): Promise<OptimizeOutcome> {
    // planImage has already established that this is a PNG or a JPEG.
    const request: ImageCodecRequest = {
      bytes,
      mediaType: mediaType as ImageCodecRequest["mediaType"],
      maxWidth: options.maxWidth,
      grayscale: options.grayscale,
    };
    try {
      const resampled = await withTimeout(codec.resample(request), IMAGE_TIMEOUT_MS);
      consecutiveTimeouts = 0;
      return smallerOrKept(bytes, resampled);
    } catch (error) {
      return failedOutcome(error);
    }
  }

  return async (bytes, mediaType) => {
    const plan = planImage(readImageHeader(bytes), mediaType, options);
    if (plan.action === "keep") return KEPT;
    if (plan.action === "fail") return { kind: "failed", reason: plan.reason };

    if (stopped || !deviceCanProcessImages()) return KEPT;
    return processWithCodec(bytes, mediaType);
  };
}
