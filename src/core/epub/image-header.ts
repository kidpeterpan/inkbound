// Pure (no "obsidian" import, no Node global): reads an image's format and
// size from its first bytes, without decoding a single pixel.
//
// Everything the optimizer needs to decide "leave this file alone" comes from
// here — already small, animated, not really a PNG or JPEG at all — so those
// decisions cost a few byte reads instead of a decode (and hold by
// construction rather than by comparing results afterwards).
//
// DataView and Uint8Array only, never Buffer: the plugin bundle has to load on
// mobile, where a Node global at module scope is fatal (check-mobile-safe).
//
// Malformed input returns null and never throws: a null header is how a
// damaged file is recognized, and the caller turns it into a warning.

export interface ImageHeader {
  format: "png" | "jpeg";
  // Stored size in pixels. For a JPEG this ignores its EXIF orientation flag, so
  // it may be the transposed size of what a viewer shows.
  width: number;
  height: number;
  // PNG only: an APNG `acTL` chunk appears before the first `IDAT`.
  animated: boolean;
}

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return readPngHeader(bytes) ?? readJpegHeader(bytes);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ── PNG ──────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length;
// A chunk is: 4-byte length, 4-byte type, `length` data bytes, 4-byte CRC.
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_TYPE_OFFSET = 4;
const PNG_CHUNK_DATA_OFFSET = 8;
// IHDR's data starts with width then height, 4 bytes each.
const PNG_HEADER_END = PNG_SIGNATURE_LENGTH + PNG_CHUNK_DATA_OFFSET + 8;

function readPngHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < PNG_HEADER_END) return null;
  if (!PNG_SIGNATURE.every((expected, index) => bytes[index] === expected)) return null;

  const view = viewOf(bytes);
  const firstChunkOffset = PNG_SIGNATURE_LENGTH;
  if (pngChunkType(bytes, firstChunkOffset) !== "IHDR") return null;

  const dataOffset = firstChunkOffset + PNG_CHUNK_DATA_OFFSET;
  const width = view.getUint32(dataOffset);
  const height = view.getUint32(dataOffset + 4);
  if (width === 0 || height === 0) return null;

  const animated = hasAnimationBeforeImageData(bytes, view, firstChunkOffset);
  return { format: "png", width, height, animated };
}

function pngChunkType(bytes: Uint8Array, chunkOffset: number): string {
  const typeOffset = chunkOffset + PNG_CHUNK_TYPE_OFFSET;
  return String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
}

// Walks the chunks after IHDR looking for `acTL` before the first `IDAT`. A
// chunk whose length would run past the end of the file stops the walk: what
// follows cannot be trusted, and "not animated" is the safe answer (the file is
// then left to the normal rules).
function hasAnimationBeforeImageData(bytes: Uint8Array, view: DataView, headerChunkOffset: number): boolean {
  let chunkOffset = nextPngChunkOffset(view, headerChunkOffset);
  while (chunkOffset !== null && chunkOffset + PNG_CHUNK_DATA_OFFSET <= bytes.length) {
    const type = pngChunkType(bytes, chunkOffset);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    chunkOffset = nextPngChunkOffset(view, chunkOffset);
  }
  return false;
}

function nextPngChunkOffset(view: DataView, chunkOffset: number): number | null {
  const dataLength = view.getUint32(chunkOffset);
  const next = chunkOffset + PNG_CHUNK_OVERHEAD + dataLength;
  return next > view.byteLength ? null : next;
}

// ── JPEG ─────────────────────────────────────────────────────────────────

const JPEG_MARKER_PREFIX = 0xff;
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_END_OF_IMAGE = 0xd9;
const JPEG_START_OF_SCAN = 0xda;
// Segment layout after the marker: 2-byte length (counting itself), then for a
// frame header 1 byte of sample precision, 2 bytes height, 2 bytes width.
const JPEG_FRAME_HEIGHT_OFFSET = 3;
const JPEG_FRAME_WIDTH_OFFSET = 5;
const JPEG_FRAME_MIN_LENGTH = 8;

function readJpegHeader(bytes: Uint8Array): ImageHeader | null {
  const startsLikeJpeg =
    bytes.length >= 4 && bytes[0] === JPEG_MARKER_PREFIX && bytes[1] === JPEG_START_OF_IMAGE;
  if (!startsLikeJpeg) return null;

  const view = viewOf(bytes);
  let offset = 2;
  while (offset < bytes.length) {
    const marker = readJpegMarker(bytes, offset);
    if (marker === null) return null;
    offset = marker.nextOffset;

    if (isStandaloneJpegMarker(marker.code)) continue;
    // Reaching the image data (or its end) without a frame header means there
    // is no size to read.
    if (marker.code === JPEG_END_OF_IMAGE || marker.code === JPEG_START_OF_SCAN) return null;

    const segmentLength = readJpegSegmentLength(view, offset);
    if (segmentLength === null) return null;

    if (isJpegFrameHeader(marker.code)) return readJpegFrame(view, offset, segmentLength);
    offset += segmentLength;
  }
  return null;
}

// A marker is 0xFF then a code byte, optionally preceded by extra 0xFF fill
// bytes. Anything else where a marker should be means the file is damaged.
function readJpegMarker(bytes: Uint8Array, offset: number): { code: number; nextOffset: number } | null {
  if (bytes[offset] !== JPEG_MARKER_PREFIX) return null;

  let codeOffset = offset;
  while (bytes[codeOffset] === JPEG_MARKER_PREFIX) codeOffset++;
  if (codeOffset >= bytes.length) return null;

  return { code: bytes[codeOffset], nextOffset: codeOffset + 1 };
}

// Markers with no length field: TEM, the restart markers and SOI.
function isStandaloneJpegMarker(code: number): boolean {
  const isRestartOrStart = code >= 0xd0 && code <= JPEG_START_OF_IMAGE;
  return code === 0x01 || isRestartOrStart;
}

// SOF0–SOF15 are frame headers, except 0xC4 (Huffman table), 0xC8 (reserved)
// and 0xCC (arithmetic-coding conditioning), which share the numeric range.
function isJpegFrameHeader(code: number): boolean {
  const inFrameRange = code >= 0xc0 && code <= 0xcf;
  return inFrameRange && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
}

// The length field counts itself, and the whole segment must fit in the file.
function readJpegSegmentLength(view: DataView, lengthOffset: number): number | null {
  if (lengthOffset + 2 > view.byteLength) return null;

  const segmentLength = view.getUint16(lengthOffset);
  const endOfSegment = lengthOffset + segmentLength;
  return segmentLength < 2 || endOfSegment > view.byteLength ? null : segmentLength;
}

function readJpegFrame(view: DataView, segmentOffset: number, segmentLength: number): ImageHeader | null {
  if (segmentLength < JPEG_FRAME_MIN_LENGTH) return null;

  const height = view.getUint16(segmentOffset + JPEG_FRAME_HEIGHT_OFFSET);
  const width = view.getUint16(segmentOffset + JPEG_FRAME_WIDTH_OFFSET);
  if (width === 0 || height === 0) return null;

  return { format: "jpeg", width, height, animated: false };
}
