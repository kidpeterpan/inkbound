export interface ExportMeta {
  title: string;
  author: string;
  language: string;
  coverBytes?: Uint8Array;
  coverExt?: "jpg" | "png" | "webp";
}

// One image a rendered chapter references, as renderUnitToChapter hands it to
// the export loop. `newHref` is already burned into the chapter's HTML; the
// rest says where the bytes come from: `bytes` set means they were produced
// in memory (rasterized Mermaid or math) and there is nothing to look up;
// otherwise `vaultPath` names the file to find in the vault.
// sourcePath: set only for images that came from embedded content, naming
// the note they actually came from (FR-006) — a relative image path written
// inside an embedded note resolves against THAT note's folder, not the host
// chapter's.
export interface ChapterImage {
  newHref: string;
  vaultPath?: string;
  bytes?: Uint8Array;
  mediaType?: string;
  sourcePath?: string;
}
