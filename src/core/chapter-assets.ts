// Pure (no "obsidian" import): turns a rendered chapter's image list into
// assets on the book. main.ts's runExport used to do this inline; it lives
// here so the "one bad image costs one warning, never the chapter" rule can be
// tested with a fake vault instead of the obsidian stub.
import { mediaTypeForExt } from "./media-types";
import { errorMessage } from "./error-text";
import type { ChapterImage } from "./types";

// What resolving an image needs from the vault. `F` is whatever the caller
// uses to name a found file (a TFile in main.ts); this module only passes it
// from locate() to read() and never looks inside.
export interface AssetVault<F> {
  // The vault file `vaultPath` refers to, or null. `fromPath` is the note the
  // reference was written in, for paths relative to that note.
  locate(vaultPath: string, fromPath: string): F | null;
  read(file: F): Promise<ArrayBuffer>;
}

export async function resolveChapterAssets<F>(
  images: ChapterImage[],
  chapterPath: string,
  vault: AssetVault<F>,
  addAsset: (href: string, bytes: Uint8Array, mediaType: string) => void,
  warn: (message: string) => void
): Promise<void> {
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
        warn(`unsupported image type: ${img.vaultPath} (referenced by ${chapterPath})`);
        continue;
      }
      addAsset(assetHref, new Uint8Array(await vault.read(file)), mediaType);
    } catch (e) {
      // Missing image: export continues (spec's error table) — this one
      // image's href stays dangling in the chapter HTML, but the chapter
      // itself is still added by the caller.
      warn(
        img.bytes
          ? `image could not be added: ${img.newHref} — ${errorMessage(e)} (referenced by ${chapterPath})`
          : `missing image: ${img.vaultPath} (referenced by ${chapterPath})`
      );
    }
  }
}
