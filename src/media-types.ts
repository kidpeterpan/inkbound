// Pure media-type allowlist — zero "obsidian" imports so vitest can load this
// module directly. src/main.ts's per-image loop uses this instead of
// defaulting unrecognised extensions to "image/png", which used to embed and
// mislabel unsupported files (.bmp, .tiff, .avif, .md, ...) as PNGs and made
// epubcheck flag malformed images / non-core media types.

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function mediaTypeForExt(ext: string): string | null {
  return MEDIA_TYPES[ext.toLowerCase()] ?? null;
}
