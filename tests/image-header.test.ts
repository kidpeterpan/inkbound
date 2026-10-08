import { describe, it, expect } from "vitest";
import { readImageHeader } from "../src/core/epub/image-header";
import { jpegBytes, pngBytes } from "./fixtures/image-bytes";

describe("readImageHeader: PNG", () => {
  it("reads the dimensions from the IHDR chunk", () => {
    expect(readImageHeader(pngBytes({ width: 3200, height: 1800 }))).toEqual({
      format: "png",
      width: 3200,
      height: 1800,
      animated: false,
    });
  });

  it("flags an animated PNG when the acTL chunk comes before the first IDAT", () => {
    const header = readImageHeader(pngBytes({ width: 10, height: 10, animation: "before-data" }));
    expect(header?.animated).toBe(true);
  });

  it("does not flag a PNG whose acTL comes after the image data (not a valid animation)", () => {
    const header = readImageHeader(pngBytes({ width: 10, height: 10, animation: "after-data" }));
    expect(header?.animated).toBe(false);
  });

  it("finds the acTL chunk even when other chunks sit between IHDR and IDAT", () => {
    const bytes = pngBytes({ width: 10, height: 10, animation: "before-data", padBytes: 500 });
    expect(readImageHeader(bytes)?.animated).toBe(true);
  });

  it("stops scanning at a chunk whose length runs past the end of the file, and still returns the header", () => {
    const bytes = pngBytes({ width: 640, height: 480, padBytes: 10 });
    // After the signature and the 25-byte IHDR chunk comes the padding chunk's
    // length field; make it enormous.
    bytes.set([0x7f, 0xff, 0xff, 0xff], 8 + 25);
    expect(readImageHeader(bytes)).toEqual({ format: "png", width: 640, height: 480, animated: false });
  });

  it("returns null for a PNG cut off inside its IHDR chunk", () => {
    expect(readImageHeader(pngBytes({ width: 100, height: 100, truncated: true }))).toBeNull();
  });

  it("returns null when a dimension is zero", () => {
    expect(readImageHeader(pngBytes({ width: 0, height: 100 }))).toBeNull();
    expect(readImageHeader(pngBytes({ width: 100, height: 0 }))).toBeNull();
  });

  it("returns null when the first chunk is not IHDR", () => {
    const bytes = pngBytes({ width: 100, height: 100 });
    bytes.set([0x41, 0x42, 0x43, 0x44], 8 + 4); // the chunk type of the first chunk
    expect(readImageHeader(bytes)).toBeNull();
  });
});

describe("readImageHeader: JPEG", () => {
  it("reads the dimensions from a baseline (SOF0) frame header", () => {
    expect(readImageHeader(jpegBytes({ width: 4000, height: 3000 }))).toEqual({
      format: "jpeg",
      width: 4000,
      height: 3000,
      animated: false,
    });
  });

  it("reads the dimensions from a progressive (SOF2) frame header", () => {
    expect(readImageHeader(jpegBytes({ width: 1920, height: 1080, progressive: true }))).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it("skips an APP1 (EXIF) segment before the frame header", () => {
    expect(readImageHeader(jpegBytes({ width: 800, height: 600, withApp1: true }))).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("does not mistake a Huffman-table marker (0xC4) for a frame header", () => {
    expect(readImageHeader(jpegBytes({ width: 800, height: 600, withHuffmanTable: true }))).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("skips 0xFF fill bytes before a marker", () => {
    expect(readImageHeader(jpegBytes({ width: 800, height: 600, fillBytes: 3 }))).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it("returns null for a JPEG cut off inside its frame header", () => {
    expect(readImageHeader(jpegBytes({ width: 800, height: 600, truncated: true }))).toBeNull();
  });

  it("returns null when a dimension is zero", () => {
    expect(readImageHeader(jpegBytes({ width: 0, height: 600 }))).toBeNull();
    expect(readImageHeader(jpegBytes({ width: 800, height: 0 }))).toBeNull();
  });

  it("returns null when a segment length runs past the end of the file before any frame header", () => {
    const bytes = jpegBytes({ width: 800, height: 600, withApp1: true });
    bytes.set([0xff, 0xff], 4); // the APP1 segment's length field
    expect(readImageHeader(bytes)).toBeNull();
  });

  it("returns null for a file that ends before any frame header appears", () => {
    expect(readImageHeader(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
  });
});

describe("readImageHeader: things that are not a PNG or JPEG", () => {
  it("returns null for an empty array", () => {
    expect(readImageHeader(new Uint8Array(0))).toBeNull();
  });

  it("returns null for text", () => {
    expect(readImageHeader(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("returns null for a GIF", () => {
    expect(readImageHeader(new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000"))).toBeNull();
  });

  it("returns null for a file too short to hold a signature", () => {
    expect(readImageHeader(Uint8Array.of(0x89, 0x50))).toBeNull();
    expect(readImageHeader(Uint8Array.of(0xff))).toBeNull();
  });
});
