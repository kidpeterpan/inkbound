import {
  FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl,
} from "obsidian";
import { promises as fs } from "fs";
import { homedir } from "os";
import { EpubBuilder, chapterHref, escapeXml } from "./epub";
import { orderChapters, pickIndexNote, bfsLinked } from "./collect";
import { renderUnitToChapter } from "./render-adapter";
import { slugify, deriveChapterTitle } from "./naming";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./http";
import {
  DEFAULT_SETTINGS, EpubExportSettings, EpubExportSettingTab,
  resolveOutputPath, summarizeWarnings,
} from "./settings";
import type { ExportMeta } from "./types";

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
      id: "export-note", name: "Export note to EPUB",
      callback: () => this.withActiveFile((f) => this.exportSingle(f)),
    });
    this.addCommand({
      id: "export-folder", name: "Export folder as EPUB (active note's folder)",
      callback: () => this.withActiveFile((f) => f.parent instanceof TFolder
        ? this.exportFolder(f.parent)
        : new Notice("Active note has no parent folder.")),
    });
    this.addCommand({
      id: "export-linked", name: "Export note + linked notes to EPUB",
      callback: () => this.withActiveFile((f) => this.exportLinked(f)),
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === "md") {
        menu.addItem((i) => i.setTitle("Export note to EPUB").setIcon("book")
          .onClick(() => this.exportSingle(file)));
        menu.addItem((i) => i.setTitle("Export note + linked notes to EPUB").setIcon("book")
          .onClick(() => this.exportLinked(file)));
      }
      if (file instanceof TFolder) {
        menu.addItem((i) => i.setTitle("Export folder as EPUB").setIcon("book")
          .onClick(() => this.exportFolder(file)));
      }
    }));
  }

  private withActiveFile(fn: (f: TFile) => void) {
    const f = this.app.workspace.getActiveFile();
    if (f) fn(f); else new Notice("No active note.");
  }

  // ── scope builders ──────────────────────────────────────────────

  private titleFor(f: TFile): string {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const aliases: string[] | undefined = Array.isArray(fm?.aliases) ? fm.aliases : undefined;
    const h1 = this.app.metadataCache.getFileCache(f)?.headings?.find((h) => h.level === 1)?.heading;
    return deriveChapterTitle(f.basename, aliases, h1);
  }

  private baseMeta(title: string, author?: string): ExportMeta {
    return {
      title,
      author: author || this.settings.fallbackAuthor || "Unknown",
      language: this.settings.language || "th",
    };
  }

  async exportSingle(file: TFile) {
    await this.runExport({ meta: this.baseMeta(this.titleFor(file)), files: [file] });
  }

  async exportLinked(file: TFile) {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    await this.runExport({ meta: this.baseMeta(this.titleFor(file)), files });
  }

  async exportFolder(folder: TFolder) {
    const mdFiles = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    if (mdFiles.length === 0) { new Notice("Folder has no markdown notes."); return; }

    const candidates = mdFiles.map((f) => ({
      basename: f.basename,
      tags: (this.app.metadataCache.getFileCache(f)?.frontmatter?.tags ?? []) as string[],
    }));
    const indexName = pickIndexNote(candidates, folder.name);
    const index = mdFiles.find((f) => f.basename === indexName) ?? null;

    const chapterNames = orderChapters(mdFiles.filter((f) => f !== index).map((f) => f.basename));
    const files = chapterNames.map((n) => mdFiles.find((f) => f.basename === n)!);
    if (index) files.unshift(index);

    const fm = index ? this.app.metadataCache.getFileCache(index)?.frontmatter : undefined;
    const meta = this.baseMeta(index ? this.titleFor(index) : folder.name, fm?.author);
    if (typeof fm?.coverUrl === "string" && fm.coverUrl.startsWith("http")) {
      try {
        const res = await requestUrl({ url: fm.coverUrl, throw: false });
        if (res.status === 200) {
          const isPng = (res.headers["content-type"] ?? "").includes("png");
          meta.coverBytes = new Uint8Array(res.arrayBuffer);
          meta.coverExt = isPng ? "png" : "jpg";
        } else {
          console.warn("[epub-export] cover download failed", fm.coverUrl, res.status);
        }
      } catch (e) {
        // cover failure degrades to coverless export (spec)
        console.warn("[epub-export] cover download failed", fm.coverUrl, e);
      }
    }
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
          const r = await renderUnitToChapter(this.app, this, md, file.path, hrefByPath, basePath, imageCount);
          warnings.push(...r.warnings);
          // Bump immediately, before the asset loop below: these numbers are
          // already burned into r.xhtmlBody regardless of what happens next.
          imageCount += r.images.length;
          for (const img of r.images) {
            try {
              const af = this.app.vault.getAbstractFileByPath(img.vaultPath);
              if (!(af instanceof TFile)) throw new Error("not found in vault");
              const bytes = new Uint8Array(await this.app.vault.readBinary(af));
              const ext = img.newHref.split(".").pop()!;
              const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
                : ext === "svg" ? "image/svg+xml" : ext === "gif" ? "image/gif"
                : ext === "webp" ? "image/webp" : "image/png";
              builder.addAsset(img.newHref.replace(/^\.\.\//, ""), bytes, mediaType);
            } catch {
              // Missing image: export continues (spec's error table) — this
              // one image's href stays dangling in the chapter HTML, but the
              // chapter itself is still added below.
              warnings.push(`missing image: ${img.vaultPath} (referenced by ${file.path})`);
            }
          }
          builder.addChapter(this.titleFor(file), r.xhtmlBody);
        } catch (e) {
          warnings.push(`chapter skipped: ${file.path} — ${String(e)}`);
          // Placeholder keeps builder's chapter count == job.files.length, so
          // hrefByPath (position-derived from job.files) stays in sync with
          // EpubBuilder's own internal numbering (which only advances on
          // addChapter). Without this, a skipped chapter shifts every later
          // chapter's real href back by one, silently retargeting any link
          // that pointed at or past the failed chapter.
          builder.addChapter(
            this.titleFor(file),
            `<p class="omitted">[chapter failed to render: ${escapeXml(file.path)}]</p>`
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
          await new BooxDropClient(this.settings.booxUrl, obsidianHttp)
            .push(outPath.split("/").pop()!, bytes);
          pushMsg = " and pushed to Boox ✓";
        } catch (e) {
          pushMsg = ` — saved locally, push failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      warnings.forEach((w) => console.warn("[epub-export]", w));
      const warnMsg = summarizeWarnings(warnings);
      new Notice(`EPUB saved to ${outPath}${pushMsg}${warnMsg ? `\n${warnMsg}` : ""}`, 8000);
    } catch (e) {
      console.error("[epub-export] export failed", e);
      new Notice(`EPUB export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      notice?.hide();
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}
