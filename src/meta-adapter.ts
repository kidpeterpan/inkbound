// The Obsidian half of book-metadata resolution. The pure policy it leans on —
// frontmatter field precedence, language/author normalization, which embeds
// count as images — lives in metadata.ts and cover.ts; this module is the part
// that has to touch the app: the metadata cache, the vault, and the network.
//
// Split out of main.ts, which had the whole cover policy (five methods and
// three fallback sources) interleaved with plugin lifecycle code. The split is
// what makes the policy testable on its own and keeps main.ts's export methods
// reading as a sequence of steps.
import { App, requestUrl, TAbstractFile, TFile } from "obsidian";
import { resolveMeta, type MetaDefaults } from "./metadata";
import { parseCoverValue, findImageEmbeds, isSupportedCoverExt, type CoverValue } from "./cover";
import { errorMessage } from "./error-text";
import type { ExportMeta } from "./types";

/**
 * Resolves a book's metadata from one note's frontmatter and attaches a cover.
 *
 * Constructed per export rather than held on the plugin: the defaults it reads
 * (`fallbackAuthor`, `language`) come from settings, which the user can change
 * between exports.
 */
export class NoteMetaSource {
  constructor(
    private app: App,
    private defaults: MetaDefaults
  ) {}

  /**
   * Reads `file`'s frontmatter for title/author/language/cover. A null file
   * (a folder export with no index note) falls back to `fallbackBasename` for
   * the title and gets no cover.
   */
  async resolve(
    file: TFile | null,
    fallbackBasename: string,
    warn: (message: string) => void
  ): Promise<ExportMeta> {
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const resolved = resolveMeta(fm, file ? file.basename : fallbackBasename, this.defaults);
    const meta: ExportMeta = {
      title: resolved.title,
      author: resolved.author,
      language: resolved.language,
    };
    await this.attachCover(meta, parseCoverValue(fm?.cover), resolved.coverUrl, file, warn);
    return meta;
  }

  // Cover resolution order (FR-007, research R5): explicit `cover:` field →
  // legacy `coverUrl:` field → first image embed in the metadata note's
  // source (fallback, FR-003). Every failure mode degrades to a coverless
  // export with a warning — never fails an export over artwork (spec +
  // constitution II).
  private async attachCover(
    meta: ExportMeta,
    coverValue: CoverValue | null,
    legacyCoverUrl: string | null,
    file: TFile | null,
    warn: (message: string) => void
  ): Promise<void> {
    if (coverValue?.kind === "url") {
      await this.downloadCover(meta, coverValue.url, warn);
      return;
    }
    if (coverValue?.kind === "path") {
      await this.embedLocalCover(meta, coverValue.path, file, `cover: ${coverValue.path}`, warn);
      return;
    }
    if (legacyCoverUrl) {
      await this.downloadCover(meta, legacyCoverUrl, warn);
      return;
    }
    if (!file) return;
    // No cover frontmatter at all — fall back to the first image embed of
    // the metadata note itself (code-fence-aware scan in cover.ts). Keep
    // scanning: an embed that is missing or unsupported is skipped in
    // favor of the next one (spec edge case).
    const md = await this.app.vault.cachedRead(file).catch(() => null);
    if (md === null) return;
    for (const target of findImageEmbeds(md)) {
      // Fallback candidates are skipped SILENTLY: a note whose first
      // embed is a gif or a stale link but whose second is a fine png
      // gets a cover with no noise. Warnings are reserved for the
      // explicitly declared `cover:` (US4).
      if (await this.embedLocalCover(meta, target, file, `first image in ${file.path}`, null)) return;
    }
  }

  // Remote cover: fetch and sniff png/webp from the content-type; anything
  // else is treated as jpeg (existing coverUrl behavior, extended with webp).
  private async downloadCover(meta: ExportMeta, url: string, warn: (message: string) => void): Promise<void> {
    try {
      const res = await requestUrl({ url, throw: false });
      if (res.status === 200) {
        const contentType = res.headers["content-type"] ?? "";
        meta.coverBytes = new Uint8Array(res.arrayBuffer);
        meta.coverExt = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
      } else {
        warn(`cover download failed: ${url} (status ${res.status})`);
      }
    } catch (e) {
      warn(`cover download failed: ${url} (${errorMessage(e)})`);
    }
  }

  // Local cover: resolve like any body image (vault path first, then
  // Obsidian's link resolver for bare filenames / note-relative paths),
  // accept only the cover allowlist, and read the bytes. Returns whether a
  // cover was attached, so the fallback loop can stop at the first usable
  // image. Warnings name the reference for every failure mode (FR-006); a
  // null sink means the caller wants silence (the first-image fallback scan).
  private async embedLocalCover(
    meta: ExportMeta,
    target: string,
    sourceFile: TFile | null,
    ref: string,
    warn: ((message: string) => void) | null
  ): Promise<boolean> {
    let af: TAbstractFile | null = null;
    if (sourceFile) {
      af = this.app.vault.getAbstractFileByPath(target);
      if (!(af instanceof TFile)) {
        af = this.app.metadataCache.getFirstLinkpathDest(target, sourceFile.path);
      }
    }
    if (!(af instanceof TFile)) {
      warn?.(`cover not found: ${target} (${ref})`);
      return false;
    }
    const ext = af.extension.toLowerCase();
    if (!isSupportedCoverExt(ext)) {
      warn?.(`unsupported cover type: ${target} (${ref})`);
      return false;
    }
    try {
      meta.coverBytes = new Uint8Array(await this.app.vault.readBinary(af));
      // Builder maps jpeg→image/jpeg via the "jpg" key; keep coverExt in its
      // canonical three-value shape ("jpg" | "png" | "webp").
      meta.coverExt = ext === "jpeg" ? "jpg" : (ext as "jpg" | "png" | "webp");
      return true;
    } catch (e) {
      warn?.(`cover read failed: ${target} (${errorMessage(e)})`);
      return false;
    }
  }
}
