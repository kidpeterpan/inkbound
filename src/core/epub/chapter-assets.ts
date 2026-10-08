// Pure (no "obsidian" import): turns a rendered chapter's image list into
// assets on the book. main.ts's runExport used to do this inline; it lives
// here so the "one bad image costs one warning, never the chapter" rule can be
// tested with a fake vault instead of the obsidian stub.
import { mediaTypeForExt } from "../common/media-types";
import { attributedTo, errorMessage } from "../common/error-text";
import type { ImageOptimizer } from "./image-optimizer";
import type { ChapterImage } from "../types";

// What resolving an image needs from the vault. `F` is whatever the caller
// uses to name a found file (a TFile in main.ts); this module only passes it
// from locate() to read() and never looks inside.
export interface AssetVault<F> {
  // The vault file `vaultPath` refers to, or null. `fromPath` is the note the
  // reference was written in, for paths relative to that note.
  locate(vaultPath: string, fromPath: string): F | null;
  read(file: F): Promise<ArrayBuffer>;
}

// Runs the optimizer in a try/catch of its OWN, apart from the caller's.
//
// The caller's catch means "this image is missing" and drops the asset, so an
// optimizer that threw inside it would delete a perfectly good image from the
// book. Whatever goes wrong here, the original bytes are embedded and the
// reader is told by name (FR-006).
async function optimizedBytesOrOriginal(
  original: Uint8Array,
  mediaType: string,
  optimize: ImageOptimizer,
  warnNotOptimized: (reason: string) => void
): Promise<Uint8Array> {
  try {
    const outcome = await optimize(original, mediaType);
    if (outcome.kind === "optimized") return outcome.bytes;
    if (outcome.kind === "failed") warnNotOptimized(outcome.reason);
    return original;
  } catch (e) {
    warnNotOptimized(errorMessage(e));
    return original;
  }
}

// `optimize` is absent when image optimization is off: the image is then
// embedded exactly as it is in the vault, which is how an OFF export stays
// identical to what the plugin produced before optimization existed (FR-008).
export async function resolveChapterAssets<F>(
  images: ChapterImage[],
  chapterPath: string,
  vault: AssetVault<F>,
  addAsset: (href: string, bytes: Uint8Array, mediaType: string) => void,
  warn: (message: string) => void,
  optimize?: ImageOptimizer
): Promise<void> {
  const attribute = attributedTo(chapterPath);
  for (const img of images) {
    // Chapters live in text/, images in images/, so newHref is "../images/…";
    // the archive path the builder wants has no leading "../".
    const assetHref = img.newHref.replace(/^\.\.\//, "");
    try {
      if (img.bytes) {
        // Rasterized mermaid diagram or math: bytes were produced directly by
        // renderUnitToChapter, not read from a vault file — skip vault
        // resolution entirely. Inside the try so that a builder that rejects
        // the asset costs one warning, not the chapter (the href is already
        // burned into the HTML either way).
        addAsset(assetHref, img.bytes, img.mediaType!);
        continue;
      }
      // img.sourcePath is set only for images that came from embedded content
      // (FR-006, render-adapter.ts's populateEmbeds): a relative path written
      // inside an embedded note must resolve against THAT note's folder, not
      // this chapter's own file.
      const file = vault.locate(img.vaultPath!, img.sourcePath ?? chapterPath);
      if (!file) throw new Error("not found in vault");
      const ext = img.newHref.split(".").pop()!;
      const mediaType = mediaTypeForExt(ext);
      if (!mediaType) {
        // Outside the allowlist (e.g. .bmp/.tiff/.avif/.md): embedding it
        // would mislabel the asset and epubcheck flags malformed images /
        // non-core media types. Skip, don't embed.
        warn(attribute(`unsupported image type: ${img.vaultPath}`));
        continue;
      }
      const original = new Uint8Array(await vault.read(file));
      // An optimized image keeps its type, and so the `.ext` already stamped
      // into this chapter's HTML: that href is fixed before any bytes are read,
      // so changing the type here would leave the reference pointing at nothing.
      const warnNotOptimized = (reason: string) =>
        warn(attribute(`image not optimized: ${img.vaultPath} — ${reason}`));
      const bytes = optimize
        ? await optimizedBytesOrOriginal(original, mediaType, optimize, warnNotOptimized)
        : original;
      addAsset(assetHref, bytes, mediaType);
    } catch (e) {
      // Missing image: export continues (spec's error table) — this one
      // image's href stays dangling in the chapter HTML, but the chapter
      // itself is still added by the caller.
      warn(
        attribute(
          img.bytes
            ? `image could not be added: ${img.newHref} — ${errorMessage(e)}`
            : `missing image: ${img.vaultPath}`
        )
      );
    }
  }
}
