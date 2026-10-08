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
import { resolveMeta, type MetaDefaults } from "../core/book/metadata";
import {
  parseCoverValue,
  findImageEmbeds,
  isSupportedCoverExt,
  declaredCover,
  planCoverFromEmbeds,
  type CoverPlan,
  type CoverValue,
} from "../core/epub/cover";
import { errorMessage } from "../core/common/error-text";
import type { ExportMeta } from "../core/types";

/**
 * What a note's frontmatter decides about its book, before any cover is
 * fetched: the text fields (no cover bytes yet) and which cover source applies.
 */
export interface MetaPlan {
  meta: ExportMeta;
  cover: CoverPlan;
}

/**
 * Resolves a book's metadata from one note's frontmatter and attaches a cover.
 *
 * Constructed per export rather than held on the plugin: the defaults it reads
 * (`fallbackAuthor`, `language`) come from settings, which the user can change
 * between exports.
 *
 * 014-preview-before-export: the work is two steps so a preview can do the
 * first without the second. `plan` decides (and never touches the network or
 * an image); `attachCover` carries the decision out; `resolve` is the two in
 * order, which is all an export ever did.
 */
export class NoteMetaSource {
  constructor(
    private app: App,
    private defaults: MetaDefaults
  ) {}

  /**
   * Reads `file`'s frontmatter for title/author/language and decides which
   * cover source applies. A null file (a folder export with no index note)
   * falls back to `fallbackBasename` for the title and gets no cover.
   */
  async plan(file: TFile | null, fallbackBasename: string): Promise<MetaPlan> {
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const resolved = resolveMeta(fm, file ? file.basename : fallbackBasename, this.defaults);
    const meta: ExportMeta = {
      title: resolved.title,
      author: resolved.author,
      language: resolved.language,
    };
    const cover = await this.planCover(file, parseCoverValue(fm?.cover), resolved.coverUrl);
    return { meta, cover };
  }

  /** `plan`, then `attachCover`: the whole of what an export has always done. */
  async resolve(
    file: TFile | null,
    fallbackBasename: string,
    warn: (message: string) => void
  ): Promise<ExportMeta> {
    const { meta, cover } = await this.plan(file, fallbackBasename);
    await this.attachCover(meta, cover, file, warn);
    return meta;
  }

  /**
   * Carries a cover plan out, adding the cover to `meta`. Every failure mode
   * degrades to a coverless export with a warning — never fails an export over
   * artwork (spec + constitution II).
   */
  async attachCover(
    meta: ExportMeta,
    cover: CoverPlan,
    file: TFile | null,
    warn: (message: string) => void
  ): Promise<void> {
    switch (cover.kind) {
      case "url":
        await this.downloadCover(meta, cover.url, warn);
        return;
      case "path":
        await this.embedLocalCover(meta, cover.path, file, `cover: ${cover.path}`, warn);
        return;
      case "embeds":
        await this.embedFirstUsableImage(meta, cover, file);
        return;
      case "none":
        return;
    }
  }

  // Cover source order (FR-007, research R5): explicit `cover:` field →
  // legacy `coverUrl:` field → first image embed in the metadata note's
  // source (fallback, FR-003). The first two are decided by the pure
  // declaredCover; the note's own text is read only when neither is declared.
  private async planCover(
    file: TFile | null,
    coverValue: CoverValue | null,
    legacyCoverUrl: string | null
  ): Promise<CoverPlan> {
    const declared = declaredCover(coverValue, legacyCoverUrl);
    if (declared) return declared;
    if (!file) return { kind: "none" };
    // No cover frontmatter at all — fall back to the first image embed of
    // the metadata note itself (code-fence-aware scan in cover.ts).
    const md = await this.app.vault.cachedRead(file).catch(() => null);
    if (md === null) return { kind: "none" };
    return planCoverFromEmbeds(file.path, findImageEmbeds(md));
  }

  // Keep trying: an embed that is missing or unsupported is skipped in favor
  // of the next one (spec edge case). Fallback candidates are skipped
  // SILENTLY: a note whose first embed is a gif or a stale link but whose
  // second is a fine png gets a cover with no noise. Warnings are reserved for
  // the explicitly declared `cover:` (US4).
  private async embedFirstUsableImage(
    meta: ExportMeta,
    cover: Extract<CoverPlan, { kind: "embeds" }>,
    file: TFile | null
  ): Promise<void> {
    for (const target of cover.targets) {
      if (await this.embedLocalCover(meta, target, file, `first image in ${cover.notePath}`, null)) return;
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
