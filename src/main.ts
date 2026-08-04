import { FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { promises as fs } from "fs";
import { homedir } from "os";
import { EpubBuilder, chapterHref, escapeXml } from "./epub";
import { computeBacklinks, renderBacklinksFragment } from "./backlinks";
import { orderChapters, pickIndexNote, bfsLinked } from "./collect";
import { renderUnitToChapter } from "./render-adapter";
import { slugify, deriveChapterTitle } from "./naming";
import { mediaTypeForExt } from "./media-types";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./http";
import {
  DEFAULT_SETTINGS,
  EpubExportSettings,
  EpubExportSettingTab,
  coerceBacklinkPosition,
  resolveOutputPath,
  summarizeWarnings,
} from "./settings";
import type { ExportMeta } from "./types";
import { resolveMeta, MetaDefaults } from "./metadata";
import { parseCoverValue, findImageEmbeds, isSupportedCoverExt } from "./cover";

interface Job {
  meta: ExportMeta;
  files: TFile[]; // chapter order
}

export default class EpubExportPlugin extends Plugin {
  settings: EpubExportSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new EpubExportSettingTab(this.app, this));

    this.addCommand({
      id: "export-note",
      name: "Export note to EPUB",
      callback: () => this.withActiveFile((f) => void this.exportSingle(f)),
    });
    this.addCommand({
      id: "export-folder",
      name: "Export folder as EPUB (active note's folder)",
      callback: () =>
        this.withActiveFile((f) =>
          f.parent instanceof TFolder
            ? void this.exportFolder(f.parent)
            : new Notice("Active note has no parent folder.")
        ),
    });
    this.addCommand({
      id: "export-linked",
      name: "Export note + linked notes to EPUB",
      callback: () => this.withActiveFile((f) => void this.exportLinked(f)),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((i) =>
            i
              .setTitle("Export note to EPUB")
              .setIcon("book")
              .onClick(() => this.exportSingle(file))
          );
          menu.addItem((i) =>
            i
              .setTitle("Export note + linked notes to EPUB")
              .setIcon("book")
              .onClick(() => this.exportLinked(file))
          );
        }
        if (file instanceof TFolder) {
          menu.addItem((i) =>
            i
              .setTitle("Export folder as EPUB")
              .setIcon("book")
              .onClick(() => this.exportFolder(file))
          );
        }
      })
    );
  }

  private withActiveFile(fn: (f: TFile) => void) {
    const f = this.app.workspace.getActiveFile();
    if (!f) {
      new Notice("No active note.");
      return;
    }
    if (f.extension !== "md") {
      new Notice("Active file is not a markdown note.");
      return;
    }
    fn(f);
  }

  // ── scope builders ──────────────────────────────────────────────

  private titleFor(f: TFile): string {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const aliases: string[] | undefined = Array.isArray(fm?.aliases) ? fm.aliases : undefined;
    const h1 = this.app.metadataCache.getFileCache(f)?.headings?.find((h) => h.level === 1)?.heading;
    return deriveChapterTitle(f.basename, aliases, h1);
  }

  private metaDefaults(): MetaDefaults {
    return {
      fallbackAuthor: this.settings.fallbackAuthor,
      language: this.settings.language || "th",
    };
  }

  // Resolves EPUB metadata from a note's own frontmatter, then attaches a
  // cover if one can be found. Resolution order (FR-007, research R5):
  // explicit `cover:` field → legacy `coverUrl:` field → first image embed
  // in the metadata note's source (fallback, FR-003). Every failure mode
  // degrades to a coverless export with a warning — never fails an export
  // over artwork (spec + constitution II).
  private async metaFromNote(file: TFile | null, fallbackBasename: string): Promise<ExportMeta> {
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const resolved = resolveMeta(fm, file ? file.basename : fallbackBasename, this.metaDefaults());
    const meta: ExportMeta = {
      title: resolved.title,
      author: resolved.author,
      language: resolved.language,
    };

    const coverValue = parseCoverValue(fm?.cover);
    if (coverValue?.kind === "url") {
      await this.downloadCover(meta, coverValue.url);
    } else if (coverValue?.kind === "path") {
      await this.embedLocalCover(meta, coverValue.path, file, `cover: ${coverValue.path}`);
    } else if (resolved.coverUrl) {
      await this.downloadCover(meta, resolved.coverUrl);
    } else if (file) {
      // No cover frontmatter at all — fall back to the first image embed of
      // the metadata note itself (code-fence-aware scan in cover.ts). Keep
      // scanning: an embed that is missing or unsupported is skipped in
      // favor of the next one (spec edge case).
      const md = await this.app.vault.cachedRead(file).catch(() => null);
      if (md !== null) {
        for (const target of findImageEmbeds(md)) {
          // Fallback candidates are skipped SILENTLY: a note whose first
          // embed is a gif or a stale link but whose second is a fine png
          // gets a cover with no noise. Warnings are reserved for the
          // explicitly declared `cover:` (US4).
          if (await this.embedLocalCover(meta, target, file, `first image in ${file.path}`, true)) break;
        }
      }
    }
    return meta;
  }

  // Remote cover: fetch and sniff png/webp from the content-type; anything
  // else is treated as jpeg (existing coverUrl behavior, extended with webp).
  private async downloadCover(meta: ExportMeta, url: string): Promise<void> {
    try {
      const res = await requestUrl({ url, throw: false });
      if (res.status === 200) {
        const contentType = res.headers["content-type"] ?? "";
        meta.coverBytes = new Uint8Array(res.arrayBuffer);
        meta.coverExt = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
      } else {
        console.warn("[inkbound] cover download failed", url, `status ${res.status}`);
      }
    } catch (e) {
      console.warn("[inkbound] cover download failed", url, e);
    }
  }

  // Local cover: resolve like any body image (vault path first, then
  // Obsidian's link resolver for bare filenames / note-relative paths),
  // accept only the cover allowlist, and read the bytes. Returns whether a
  // cover was attached, so the fallback loop can stop at the first usable
  // image. Warnings name the reference for every failure mode (FR-006).
  private async embedLocalCover(
    meta: ExportMeta,
    target: string,
    sourceFile: TFile | null,
    ref: string,
    silent = false
  ): Promise<boolean> {
    let af: TAbstractFile | null = null;
    if (sourceFile) {
      af = this.app.vault.getAbstractFileByPath(target);
      if (!(af instanceof TFile)) {
        af = this.app.metadataCache.getFirstLinkpathDest(target, sourceFile.path);
      }
    }
    if (!(af instanceof TFile)) {
      if (!silent) console.warn(`[inkbound] cover not found: ${target} (${ref})`);
      return false;
    }
    const ext = af.extension.toLowerCase();
    if (!isSupportedCoverExt(ext)) {
      if (!silent) console.warn(`[inkbound] unsupported cover type: ${target} (${ref})`);
      return false;
    }
    try {
      meta.coverBytes = new Uint8Array(await this.app.vault.readBinary(af));
      // Builder maps jpeg→image/jpeg via the "jpg" key; keep coverExt in its
      // canonical three-value shape ("jpg" | "png" | "webp").
      meta.coverExt = ext === "jpeg" ? "jpg" : (ext as "jpg" | "png" | "webp");
      return true;
    } catch (e) {
      if (!silent) console.warn("[inkbound] cover read failed", target, e);
      return false;
    }
  }

  async exportSingle(file: TFile) {
    await this.runExport({ meta: await this.metaFromNote(file, file.basename), files: [file] });
  }

  async exportLinked(file: TFile) {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    await this.runExport({ meta: await this.metaFromNote(file, file.basename), files });
  }

  async exportFolder(folder: TFolder) {
    const mdFiles = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    if (mdFiles.length === 0) {
      new Notice("Folder has no markdown notes.");
      return;
    }

    const candidates = mdFiles.map((f) => {
      const tags: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.tags;
      return {
        basename: f.basename,
        // Frontmatter `tags` can be a scalar string (e.g. `tags: handbook`)
        // rather than a list. pickIndexNote's `.includes(...)` checks are
        // Array.prototype.includes for list-shaped tags, but a string scalar
        // would silently fall through to String.prototype.includes, which is
        // substring matching and can misfire (e.g. "notebook mainframe"
        // contains both "book" and "main"). Only genuine arrays count.
        tags: Array.isArray(tags) ? (tags as string[]) : [],
      };
    });
    const indexName = pickIndexNote(candidates, folder.name);
    const index = mdFiles.find((f) => f.basename === indexName) ?? null;

    const chapterNames = orderChapters(mdFiles.filter((f) => f !== index).map((f) => f.basename));
    const files = chapterNames.map((n) => mdFiles.find((f) => f.basename === n)!);
    if (index) files.unshift(index);

    const meta = await this.metaFromNote(index, folder.name);
    await this.runExport({ meta, files });
  }

  // ── orchestrator ────────────────────────────────────────────────

  async runExport(job: Job) {
    const warnings: string[] = [];
    let notice: Notice | null = null;
    try {
      notice = new Notice(`Exporting "${job.meta.title}"…`, 0);
      const adapter = this.app.vault.adapter;
      const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

      const hrefByPath = new Map(job.files.map((f, i) => [f.path, chapterHref(i)]));
      const builder = new EpubBuilder(job.meta);

      // Backlink trail: which chapters in THIS book link to each chapter,
      // in book order. Sources come from the same resolvedLinks graph the
      // linked-notes collector consumed, so anything bfsLinked counted as a
      // link is guaranteed to show up as a backlink here.
      const fileByPath = new Map(job.files.map((f) => [f.path, f]));
      const backlinks = computeBacklinks(
        this.app.metadataCache.resolvedLinks,
        job.files.map((f) => f.path)
      );
      const backlinkPosition = coerceBacklinkPosition(this.settings.backlinkPosition);
      const withBacklinks = (file: TFile, xhtmlBody: string): string => {
        // "none" restores pre-feature output exactly — no trail on any chapter.
        if (backlinkPosition === "none") return xhtmlBody;
        const entries = (backlinks.get(file.path) ?? []).flatMap((path) => {
          const source = fileByPath.get(path);
          const href = hrefByPath.get(path);
          // Chapters live side by side in text/, so link by filename only
          // (same convention as rewriteLinks in render.ts).
          return source && href ? [{ title: this.titleFor(source), href: href.replace(/^text\//, "") }] : [];
        });
        const fragment = renderBacklinksFragment(entries);
        if (!fragment) return xhtmlBody;
        if (backlinkPosition === "end") return xhtmlBody + fragment;
        if (backlinkPosition === "both") return fragment + xhtmlBody + fragment;
        return fragment + xhtmlBody;
      };
      // Running total of images rewriteImages has STAMPED into chapter HTML
      // so far — not the count that later loaded as assets. The <img> hrefs
      // are burned into r.xhtmlBody the moment renderUnitToChapter returns,
      // before any vault read is attempted, so the next chapter's startIndex
      // must be measured against what was stamped, not what loaded — else a
      // missing/failed image would let a later chapter reissue an href
      // that's already sitting in an earlier chapter's HTML.
      let imageCount = 0;

      for (const file of job.files) {
        try {
          const md = await this.app.vault.cachedRead(file);
          const r = await renderUnitToChapter(
            this.app,
            this,
            md,
            file.path,
            hrefByPath,
            basePath,
            imageCount
          );
          warnings.push(...r.warnings);
          // Bump immediately, before the asset loop below: these numbers are
          // already burned into r.xhtmlBody regardless of what happens next.
          imageCount += r.images.length;
          for (const img of r.images) {
            if (img.bytes) {
              // Rasterized mermaid diagram: bytes were produced directly by
              // renderUnitToChapter, not read from a vault file — skip vault
              // resolution entirely.
              builder.addAsset(img.newHref.replace(/^\.\.\//, ""), img.bytes, img.mediaType!);
              continue;
            }
            try {
              let af = this.app.vault.getAbstractFileByPath(img.vaultPath!);
              if (!(af instanceof TFile)) {
                // Not a vault-rooted path (or app://-derived path didn't match
                // as-is) — fall back to Obsidian's own link resolver, which
                // handles paths relative to the source note and bare
                // filenames (same resolver render-adapter.ts uses for links).
                // img.sourcePath is set only for images that came from
                // embedded content (FR-006, render-adapter.ts's
                // populateEmbeds) — a relative path written inside an
                // embedded note must resolve against THAT note's folder, not
                // this chapter's own file.
                af = this.app.metadataCache.getFirstLinkpathDest(img.vaultPath!, img.sourcePath ?? file.path);
              }
              if (!(af instanceof TFile)) throw new Error("not found in vault");
              const ext = img.newHref.split(".").pop()!;
              const mediaType = mediaTypeForExt(ext);
              if (!mediaType) {
                // Outside the allowlist (e.g. .bmp/.tiff/.avif/.md): embedding
                // it would mislabel the asset and epubcheck flags malformed
                // images / non-core media types. Skip, don't embed.
                warnings.push(`unsupported image type: ${img.vaultPath} (referenced by ${file.path})`);
                continue;
              }
              const bytes = new Uint8Array(await this.app.vault.readBinary(af));
              builder.addAsset(img.newHref.replace(/^\.\.\//, ""), bytes, mediaType);
            } catch {
              // Missing image: export continues (spec's error table) — this
              // one image's href stays dangling in the chapter HTML, but the
              // chapter itself is still added below.
              warnings.push(`missing image: ${img.vaultPath} (referenced by ${file.path})`);
            }
          }
          builder.addChapter(this.titleFor(file), withBacklinks(file, r.xhtmlBody));
        } catch (e) {
          warnings.push(`chapter skipped: ${file.path} — ${String(e)}`);
          // Placeholder keeps builder's chapter count == job.files.length, so
          // hrefByPath (position-derived from job.files) stays in sync with
          // EpubBuilder's own internal numbering (which only advances on
          // addChapter). Without this, a skipped chapter shifts every later
          // chapter's real href back by one, silently retargeting any link
          // that pointed at or past the failed chapter.
          // The placeholder still gets the backlink trail: a failed chapter
          // keeps its spine slot and can still be navigated back from.
          builder.addChapter(
            this.titleFor(file),
            withBacklinks(file, `<p class="omitted">[chapter failed to render: ${escapeXml(file.path)}]</p>`)
          );
        }
      }

      const bytes = await builder.build();
      const outPath = resolveOutputPath(this.settings.outputFolder, slugify(job.meta.title), homedir());
      await fs.mkdir(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(outPath, bytes); // save ALWAYS precedes push (spec)

      let pushMsg = "";
      if (this.settings.pushAfterExport && this.settings.booxUrl) {
        try {
          notice.setMessage("Pushing to Boox…");
          await new BooxDropClient(this.settings.booxUrl, obsidianHttp).push(
            outPath.split("/").pop()!,
            bytes
          );
          pushMsg = " and pushed to Boox ✓";
        } catch (e) {
          pushMsg = ` — saved locally, push failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      warnings.forEach((w) => console.warn("[inkbound]", w));
      const warnMsg = summarizeWarnings(warnings);
      new Notice(`EPUB saved to ${outPath}${pushMsg}${warnMsg ? `\n${warnMsg}` : ""}`, 8000);
    } catch (e) {
      console.error("[inkbound] export failed", e);
      new Notice(`EPUB export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      notice?.hide();
    }
  }

  async loadSettings() {
    const loaded: unknown = await this.loadData();
    const data = (loaded ?? {}) as Partial<EpubExportSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}
