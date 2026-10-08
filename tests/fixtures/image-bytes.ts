// Minimal PNG and JPEG byte builders for tests.
//
// These are NOT decodable pictures. They carry exactly the structure the image
// header reader and the optimizer's decisions look at (signature, dimensions,
// the animation marker, padding that makes a file bigger) and nothing else, so a
// test can say "a 3200×1800 PNG" without shipping megabytes of pixels.
//
// Plain Uint8Array arithmetic only — no Buffer — so the same builders can run
// inside scripts/build-sample.ts and anything else that must also load on mobile.

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function uint16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

// ── PNG ──────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

// The header reader never checks a CRC, so the four CRC bytes are zeros.
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat(uint32(data.length), ascii(type), data, uint32(0));
}

export type PngAnimation = "none" | "before-data" | "after-data";

export interface PngSpec {
  width: number;
  height: number;
  // Where the APNG `acTL` chunk sits relative to the first `IDAT`. Only
  // "before-data" makes a PNG animated.
  animation?: PngAnimation;
  // Cut the file off in the middle of its IHDR chunk.
  truncated?: boolean;
  // Adds a text chunk of this many data bytes, so a file can be made larger than
  // whatever a fake codec returns.
  padBytes?: number;
}

export function pngBytes(spec: PngSpec): Uint8Array {
  const { width, height, animation = "none", truncated = false, padBytes = 0 } = spec;

  const headerChunk = pngChunk("IHDR", concat(uint32(width), uint32(height), Uint8Array.of(8, 6, 0, 0, 0)));
  const animationChunk = pngChunk("acTL", concat(uint32(2), uint32(0)));
  const paddingChunk = padBytes > 0 ? pngChunk("tEXt", new Uint8Array(padBytes)) : new Uint8Array(0);
  const dataChunk = pngChunk("IDAT", Uint8Array.of(0x78, 0x9c, 0x03, 0x00));
  const endChunk = pngChunk("IEND", new Uint8Array(0));

  const whole = concat(
    PNG_SIGNATURE,
    headerChunk,
    animation === "before-data" ? animationChunk : new Uint8Array(0),
    paddingChunk,
    dataChunk,
    animation === "after-data" ? animationChunk : new Uint8Array(0),
    endChunk
  );
  return truncated ? whole.slice(0, PNG_SIGNATURE.length + 10) : whole;
}

// ── JPEG ─────────────────────────────────────────────────────────────────

export interface JpegSpec {
  width: number;
  height: number;
  progressive?: boolean; // SOF2 instead of SOF0
  withApp1?: boolean; // an EXIF-style APP1 segment before the frame header
  withHuffmanTable?: boolean; // a DHT segment (marker 0xC4) before the frame header
  fillBytes?: number; // extra 0xFF bytes before the frame header's marker
  truncated?: boolean; // cut off in the middle of the frame header
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0xff, marker), uint16(payload.length + 2), payload);
}

export function jpegBytes(spec: JpegSpec): Uint8Array {
  const { width, height, progressive = false, withApp1 = false, withHuffmanTable = false } = spec;
  const { fillBytes = 0, truncated = false } = spec;

  const startOfImage = Uint8Array.of(0xff, 0xd8);
  const exifSegment = withApp1
    ? jpegSegment(0xe1, concat(ascii("Exif"), new Uint8Array(20)))
    : new Uint8Array(0);
  const huffmanSegment = withHuffmanTable ? jpegSegment(0xc4, new Uint8Array(16)) : new Uint8Array(0);
  const fill = new Uint8Array(fillBytes).fill(0xff);

  const threeComponents = Uint8Array.of(1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  const frameHeader = jpegSegment(
    progressive ? 0xc2 : 0xc0,
    concat(Uint8Array.of(8), uint16(height), uint16(width), Uint8Array.of(3), threeComponents)
  );
  const startOfScan = jpegSegment(0xda, Uint8Array.of(3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0));
  const endOfImage = Uint8Array.of(0xff, 0xd9);

  const whole = concat(startOfImage, exifSegment, huffmanSegment, fill, frameHeader, startOfScan, endOfImage);
  if (!truncated) return whole;

  const frameStart = startOfImage.length + exifSegment.length + huffmanSegment.length + fill.length;
  return whole.slice(0, frameStart + 6);
}
