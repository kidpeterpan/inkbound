export interface ExportMeta {
  title: string;
  author: string;
  language: string;
  coverBytes?: Uint8Array;
  coverExt?: "jpg" | "png" | "webp";
  /** Absent when the metadata note uses none of the book-detail properties. */
  details?: BookDetails;
}

// 015-richer-book-metadata: what a book says about itself beyond its title,
// author, language and cover. A field is present only with a usable value;
// there is no "present but empty" state.
export interface BookDetails {
  description?: string;
  publisher?: string;
  /** Always `YYYY`, `YYYY-MM` or `YYYY-MM-DD`: the content's date, never the build time. */
  date?: string;
  series?: SeriesMembership;
  /** Non-empty when present, in the order the note lists them. */
  subjects?: string[];
}

export interface SeriesMembership {
  name: string;
  /** Zero or greater. Never present without a name. */
  position?: number;
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
