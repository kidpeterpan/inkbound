// The one place the image optimizer touches the browser: decode a PNG or JPEG
// into a canvas, scale it once, encode it again.
//
// Everything else about optimizing an image (whether to, how wide, what to
// keep, what to warn) is decided in image-optimizer.ts, which is pure and is
// tested without a canvas. This module is deliberately small so that what only
// a real browser can confirm stays small too (docs/DEVELOPMENT.md, FR-016).
//
// Like core/render/raster.ts it imports nothing from "obsidian": it reads only
// browser globals, and every one of them is touched inside a function, never at
// module scope, so the bundle still loads where those globals do not exist.
//
// See specs/013-eink-image-optimization/contracts/image-codec.md.
import { fitWidth } from "./image-fit";

export interface ImageCodecRequest {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  maxWidth: number;
  grayscale: boolean;
}

export interface ImageCodec {
  /** False when this environment cannot decode and encode images at all. Never throws. */
  available(): boolean;
  /**
   * Resolves the re-encoded image (same media type), or null when nothing needs
   * doing because the decoded image is already within `maxWidth`. Rejects with an
   * Error whose message is the reason when this one image cannot be processed.
   */
  resample(request: ImageCodecRequest): Promise<Uint8Array | null>;
}

// Fixed, because the same input must give the same bytes (FR-009). 0.85 is the
// usual point where a photo's file shrinks a lot before the eye notices.
export const JPEG_QUALITY = 0.85;

// The three globals a decode needs. jsdom has Image and a canvas element but no
// URL.createObjectURL; the Node harness has createObjectURL but no Image. Asking
// for all three tells "a real browser engine" from both without calling
// getContext, which jsdom answers by printing a "not implemented" error.
function browserCanProcessImages(): boolean {
  return (
    typeof Image === "function" &&
    typeof HTMLCanvasElement === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

// Resolves once the browser has decoded the image. A file it refuses becomes a
// rejection; a file that never settles is the caller's timeout to handle.
function loadImage(image: HTMLImageElement, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("could not be decoded"));
    image.src = url;
  });
}

// Rec. 601 luma in integer arithmetic (299, 587 and 114 per thousand), rounded
// to the nearest value: no floating point, so the same pixels always give the
// same bytes (FR-009).
const LUMA_RED = 299;
const LUMA_GREEN = 587;
const LUMA_BLUE = 114;
const LUMA_SCALE = 1000;

/**
 * Turns RGBA pixels gray in place. Alpha is left alone, so a transparent area
 * stays transparent. Done by hand rather than with the canvas `filter` property,
 * which older iOS WebViews may not have.
 */
export function toGrayscale(pixels: Uint8ClampedArray): void {
  const channelsPerPixel = 4;
  for (let offset = 0; offset < pixels.length; offset += channelsPerPixel) {
    const weighted =
      LUMA_RED * pixels[offset] + LUMA_GREEN * pixels[offset + 1] + LUMA_BLUE * pixels[offset + 2];
    const luma = Math.floor((weighted + LUMA_SCALE / 2) / LUMA_SCALE);
    pixels[offset] = luma;
    pixels[offset + 1] = luma;
    pixels[offset + 2] = luma;
  }
}

function drawScaled(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  width: number,
  height: number
): CanvasRenderingContext2D {
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2-D canvas available");

  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return context;
}

function convertToGrayscale(context: CanvasRenderingContext2D, width: number, height: number): void {
  const picture = context.getImageData(0, 0, width, height);
  toGrayscale(picture.data);
  context.putImageData(picture, 0, 0);
}

async function encodeCanvas(
  canvas: HTMLCanvasElement,
  mediaType: ImageCodecRequest["mediaType"]
): Promise<Uint8Array> {
  const quality = mediaType === "image/jpeg" ? JPEG_QUALITY : undefined;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, quality));
  if (!blob) throw new Error("could not be encoded");

  return new Uint8Array(await blob.arrayBuffer());
}

// A phone holds only a few decoded images at once, so everything one image used
// is given back as soon as it is done, on every path.
function release(image: HTMLImageElement, blobUrl: string, canvas: HTMLCanvasElement | null): void {
  image.onload = null;
  image.onerror = null;
  image.src = "";
  URL.revokeObjectURL(blobUrl);
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function resampleWithCanvas(request: ImageCodecRequest): Promise<Uint8Array | null> {
  // The cast is only for the type checker: lib.dom's BlobPart rejects a
  // Uint8Array whose buffer might be a SharedArrayBuffer, and bytes read from
  // the vault never are.
  const blobUrl = URL.createObjectURL(new Blob([request.bytes as BlobPart], { type: request.mediaType }));
  const image = new Image();
  let canvas: HTMLCanvasElement | null = null;
  try {
    await loadImage(image, blobUrl);

    // The decoded size, not the file's header: the browser has already applied
    // an EXIF rotation, so this is the size the picture is shown at.
    if (image.naturalWidth <= request.maxWidth) return null;

    const target = fitWidth(image.naturalWidth, image.naturalHeight, request.maxWidth);
    canvas = createEl("canvas");
    const context = drawScaled(canvas, image, target.width, target.height);
    if (request.grayscale) convertToGrayscale(context, target.width, target.height);
    return await encodeCanvas(canvas, request.mediaType);
  } finally {
    release(image, blobUrl, canvas);
  }
}

const canvasCodec: ImageCodec = { available: browserCanProcessImages, resample: resampleWithCanvas };

let installedCodec: ImageCodec = canvasCodec;

/** Install a scripted codec for tests. `null` restores the real (canvas) one. */
export function setImageCodec(codec: ImageCodec | null): void {
  installedCodec = codec ?? canvasCodec;
}

export function getImageCodec(): ImageCodec {
  return installedCodec;
}
