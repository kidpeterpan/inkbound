import { describe, it, expect } from "vitest";
import { mediaTypeForExt } from "../src/media-types";

describe("mediaTypeForExt", () => {
  it("maps allowlisted extensions to their media types", () => {
    expect(mediaTypeForExt("png")).toBe("image/png");
    expect(mediaTypeForExt("jpg")).toBe("image/jpeg");
    expect(mediaTypeForExt("jpeg")).toBe("image/jpeg");
    expect(mediaTypeForExt("gif")).toBe("image/gif");
    expect(mediaTypeForExt("svg")).toBe("image/svg+xml");
    expect(mediaTypeForExt("webp")).toBe("image/webp");
  });

  it("is case-insensitive", () => {
    expect(mediaTypeForExt("PNG")).toBe("image/png");
    expect(mediaTypeForExt("JPG")).toBe("image/jpeg");
  });

  it("returns null for unsupported extensions instead of defaulting to png", () => {
    expect(mediaTypeForExt("bmp")).toBeNull();
    expect(mediaTypeForExt("tiff")).toBeNull();
    expect(mediaTypeForExt("avif")).toBeNull();
    expect(mediaTypeForExt("md")).toBeNull();
    expect(mediaTypeForExt("")).toBeNull();
  });
});
