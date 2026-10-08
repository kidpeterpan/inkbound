import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, parseLinktext } from "obsidian";
import type { NavItem } from "./core/epub/epub";
import type { CoverPlan } from "./core/epub/cover";
import type { FolderInput, NoteInput } from "./core/book/book-tree";
import { bfsLinked } from "./core/book/collect";
import {
  chapterOrderFallbackWarning,
  legacyChapterOrder,
  normalizeTags,
  orderedLinkTargets,
  planFolderOrder,
} from "./core/book/book-plan";
import { deriveChapterTitle } from "./core/book/naming";
import { canShareEpub, shareEpub, type ShareTarget } from "./core/delivery/share";
import { DEFAULT_SETTINGS, EpubExportSettings, EpubExportSettingTab } from "./adapters/settings";
import type { ExportMeta } from "./core/types";
import type { MetaDefaults } from "./core/book/metadata";
import { NoteMetaSource } from "./adapters/meta-adapter";
import { buildBookPreview, type PreviewInput } from "./core/book/export-preview";
import { openBookPreview } from "./adapters/preview-view";
import { errorMessage } from "./core/common/error-text";
import type { ExportReport } from "./core/delivery/report";
import { openExportReport } from "./adapters/report-view";
import { runExport as runExportPipeline, type Job } from "./adapters/export-pipeline";

// 014-preview-before-export: a book that has been DECIDED but not yet built —
// which notes, in what order, under which Parts, with what title, author and
// language, and where its cover will come from. Nothing in it is rendered, read
// from an image file or fetched.
//
// This is the seam between planning and running. An export plans and runs in
// one go; a preview plans, shows this, and runs it only if the reader asks. Both
// call the same planFolder/planLinked and the same exportPlanned, so the book a
// preview describes is the book the export writes — there is no second copy of
// the ordering rules to drift out of step.
interface PlannedExport {
  files: TFile[];
  /** Nested table-of-contents plan (folder exports with Parts), by position in `files`. */
  nav?: NavItem[];
  /** Planning warnings known before anything renders, e.g. the filename-order fallback. */
  warnings: string[];
  /** Title, author and language only: the cover is attached when the export runs. */
  meta: ExportMeta;
  cover: CoverPlan;
  /** The note the metadata was read from, which the cover is also resolved against. */
  metaFile: TFile | null;
}

export default class EpubExportPlugin extends Plugin {
  settings: EpubExportSettings = DEFAULT_SETTINGS;

  // 008-mobile-support: the most recent successfully-written book, kept so the
  // "Share last exported book" command has something to hand to the share
  // sheet. Only set on mobile, and only after the file is safely on disk —
  // sharing is a bonus layered on a completed export, never part of one.
  private lastShareTarget: ShareTarget | null = null;
  // 010-export-report FR-016: only the most recent export's report is kept —
  // same in-memory, session-only shape as lastShareTarget above, and for the
  // same reason: the command that consumes it needs something to hand over,
  // and nothing about it belongs in a synced data.json.
  private lastReport: ExportReport | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new EpubExportSettingTab(this.app, this));
    this.registerCommands();
    this.registerFileMenu();
  }

  // Every command the plugin contributes to the palette (7) — kept together
  // so adding one is a single place to look.
  private registerCommands(): void {
    this.addCommand({
      id: "export-note",
      name: "Export note to EPUB",
      callback: () => this.withActiveFile((f) => void this.exportSingle(f)),
    });
    this.addCommand({
      id: "export-folder",
      name: "Export folder as EPUB (active note's folder)",
      callback: () => this.withActiveFolder((folder) => void this.exportFolder(folder)),
    });
    this.addCommand({
      id: "export-linked",
      name: "Export note + linked notes to EPUB",
      callback: () => this.withActiveFile((f) => void this.exportLinked(f)),
    });
    // 014-preview-before-export: a SEPARATE command rather than a step in the
    // export commands above, so nobody who exports today gets an extra click.
    this.addCommand({
      id: "preview-folder",
      name: "Preview folder export (active note's folder)",
      callback: () => this.withActiveFolder((folder) => void this.previewFolder(folder)),
    });
    this.addCommand({
      id: "preview-linked",
      name: "Preview note + linked notes export",
      callback: () => this.withActiveFile((f) => void this.previewLinked(f)),
    });
    // 008-mobile-support FR-016/FR-017: hand the finished book to the device's
    // own share sheet. A COMMAND rather than something fired on export
    // completion, for two reasons: the Web Share API requires transient user
    // activation and rejects a share with no tap behind it, and FR-017 requires
    // the offer to be ABSENT (not failing) where sharing is unsupported —
    // checkCallback returning false hides the command from the palette
    // entirely, which is exactly that.
    // 010-export-report FR-013/FR-014. A plain `callback`, deliberately NOT
    // the `checkCallback` its neighbour below uses: checkCallback returning
    // false HIDES a command from the palette, and a hidden command cannot
    // tell the reader that there is nothing to show. Being told is the
    // requirement, so this command is always present and answers for itself.
    this.addCommand({
      id: "show-export-report",
      name: "Show last export report",
      callback: () => {
        if (!this.lastReport) {
          new Notice("No export has run yet — the report appears after your first export.");
          return;
        }
        openExportReport(this.app, this.lastReport);
      },
    });

    this.addCommand({
      id: "share-last-export",
      name: "Share last exported book",
      checkCallback: (checking: boolean) => {
        const target = this.lastShareTarget;
        if (!target || !canShareEpub()) return false;
        if (!checking) void shareEpub(target);
        return true;
      },
    });
  }

  // The right-click entries for notes and folders.
  private registerFileMenu(): void {
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
          menu.addItem((i) =>
            i
              .setTitle("Preview note + linked notes export")
              .setIcon("eye")
              .onClick(() => this.previewLinked(file))
          );
        }
        if (file instanceof TFolder) {
          menu.addItem((i) =>
            i
              .setTitle("Export folder as EPUB")
              .setIcon("book")
              .onClick(() => this.exportFolder(file))
          );
          menu.addItem((i) =>
            i
              .setTitle("Preview folder export")
              .setIcon("eye")
              .onClick(() => this.previewFolder(file))
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
      new Notice("Active file is not a Markdown note.");
      return;
    }
    fn(f);
  }

  // The folder of the active note, for the commands that work on a whole folder.
  private withActiveFolder(fn: (folder: TFolder) => void) {
    this.withActiveFile((f) => {
      if (f.parent instanceof TFolder) fn(f.parent);
      else new Notice("Active note has no parent folder.");
    });
  }

  // ── scope builders ──────────────────────────────────────────────

  private titleFor(f: TFile): string {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    // Raw frontmatter value: plain-string aliases are legal (FR-002) and the
    // pure resolver's firstNonEmptyString handles both string and list shapes.
    const aliases: unknown = fm?.aliases;
    const h1 = this.app.metadataCache.getFileCache(f)?.headings?.find((h) => h.level === 1)?.heading;
    return deriveChapterTitle(f.basename, aliases, h1);
  }

  private metaDefaults(): MetaDefaults {
    return {
      fallbackAuthor: this.settings.fallbackAuthor,
      language: this.settings.language || "th",
    };
  }

  // Resolves EPUB metadata from a note's own frontmatter and attaches a cover.
  // The resolution policy — field precedence, the three cover sources, every
  // degradation path — lives in meta-adapter.ts; what stays here is the
  // settings read it needs, done per export so a settings change is picked up.
  private async metaFromNote(
    file: TFile | null,
    fallbackBasename: string,
    warn: (message: string) => void
  ): Promise<ExportMeta> {
    return this.metaSource().resolve(file, fallbackBasename, warn);
  }

  // Built per use, not held: the defaults it reads come from settings, which
  // the reader can change between exports.
  private metaSource(): NoteMetaSource {
    return new NoteMetaSource(this.app, this.metaDefaults());
  }

  async exportSingle(file: TFile) {
    const warnings: string[] = [];
    const meta = await this.metaFromNote(file, file.basename, (m) => warnings.push(m));
    await this.runExport({ meta, files: [file], warnings });
  }

  async exportLinked(file: TFile) {
    await this.exportPlanned(await this.planLinked(file));
  }

  // The notes the link walk reaches at the reader's link depth, in the order
  // the export will use. Shared with the linked-notes preview.
  private async planLinked(file: TFile): Promise<PlannedExport> {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    const { meta, cover } = await this.metaSource().plan(file, file.basename);
    return { files, warnings: [], meta, cover, metaFile: file };
  }

  // The frontmatter read; the shape rule (why a scalar `tags` string is NOT
  // tags) lives in core/book/book-plan.ts normalizeTags.
  private tagsOf(f: TFile): string[] {
    return normalizeTags(this.app.metadataCache.getFileCache(f)?.frontmatter?.tags);
  }

  // Reads one note's regular links off the metadata cache and hands them to
  // the pure rule in core/book/book-plan.ts (document order, no self-links, notes
  // only). Obsidian keeps embeds in `embeds` and frontmatter links in
  // `frontmatterLinks`, so reading `links` alone is what makes FR-005
  // ("embeds never order") hold — do not widen this to resolvedLinks, whose
  // key order is not document order.
  private linkTargetsOf(file: TFile): string[] {
    const links = [...(this.app.metadataCache.getFileCache(file)?.links ?? [])];
    return orderedLinkTargets(
      links.map((l) => ({ path: parseLinktext(l.link).path, startOffset: l.position.start.offset })),
      (linkpath) => {
        const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
        // Notes only (FR-004): a plain link to an image inside `Part I/` would
        // otherwise resolve to a path under that folder and drag the Part with it.
        return dest instanceof TFile && dest.extension === "md" ? dest.path : null;
      }
    );
  }

  // Plain-data mirror of a TFolder subtree for the pure planner. Only `.md`
  // files become notes; every subfolder is included (the planner drops the
  // ones with no notes beneath them).
  private buildFolderInput(folder: TFolder, byPath: Map<string, TFile>): FolderInput {
    const notes: NoteInput[] = [];
    const subfolders: FolderInput[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (child.extension !== "md") continue;
        byPath.set(child.path, child);
        notes.push({
          path: child.path,
          basename: child.basename,
          tags: this.tagsOf(child),
          linkTargets: this.linkTargetsOf(child),
        });
      } else if (child instanceof TFolder) {
        subfolders.push(this.buildFolderInput(child, byPath));
      }
    }
    return { name: folder.name, path: folder.path, notes, subfolders };
  }

  // Pre-009 folder collection: direct children only, index first, NN_ then
  // alphabetical — the shape the planner degrades to (research R5) and the
  // reference for FR-013 ("flat folders export identically"). The ordering
  // rules live in core/book/book-plan.ts; this maps the basenames back to TFiles
  // (unique within one folder — these are direct children of a single TFolder).
  private legacyFolderOrder(mdFiles: TFile[], folder: TFolder): { index: TFile | null; files: TFile[] } {
    const { indexBasename, order } = legacyChapterOrder(
      mdFiles.map((f) => ({ basename: f.basename, tags: this.tagsOf(f) })),
      folder.name
    );
    const fileNamed = (basename: string): TFile => mdFiles.find((f) => f.basename === basename)!;
    return {
      index: indexBasename === null ? null : fileNamed(indexBasename),
      files: order.map(fileNamed),
    };
  }

  // Plans a folder export's reading order and nav tree. Returns null after
  // notifying when the folder has no Markdown notes; a planner failure
  // degrades to the legacy flat order with a warning, never aborts
  // (Constitution II / FR-016 — the degradation itself lives in
  // core/book/book-plan.ts, where it is unit-tested).
  private planFolderExport(
    folder: TFolder,
    legacy: { index: TFile | null; files: TFile[] }
  ): { files: TFile[]; nav?: NavItem[]; warnings: string[] } | null {
    const byPath = new Map<string, TFile>();
    let input: FolderInput;
    try {
      input = this.buildFolderInput(folder, byPath);
    } catch (e) {
      // The WALK can fail where the planner is written never to (research R5):
      // it reads the metadata cache once per note. Degrade to the legacy
      // TFiles this export already holds — byPath may be half-filled, so its
      // paths must not be re-derived through it.
      if (legacy.files.length === 0) {
        new Notice("Folder has no Markdown notes.");
        return null;
      }
      return { files: legacy.files, warnings: [chapterOrderFallbackWarning(e)] };
    }
    if (byPath.size === 0) {
      new Notice("Folder has no Markdown notes.");
      return null;
    }
    // A planning failure degrades to the legacy flat order inside here
    // (Constitution II / FR-016).
    const plan = planFolderOrder(
      input,
      legacy.files.map((f) => f.path),
      (path) => this.titleFor(byPath.get(path)!)
    );
    // Path-keyed, not basename-keyed: two subfolders may hold same-named
    // notes (FR-018).
    const files = plan.order.map((path) => byPath.get(path)!);
    // Reachable only through the degraded branch: the folder's notes live in
    // subfolders, so the legacy direct-children list was empty.
    if (files.length === 0) {
      new Notice("Folder has no Markdown notes.");
      return null;
    }
    return { files, nav: plan.nav, warnings: plan.warnings };
  }

  async exportFolder(folder: TFolder) {
    const planned = await this.planFolder(folder);
    if (!planned) return;
    await this.exportPlanned(planned);
  }

  // A folder's book, decided: chapter order and Parts (planFolderExport), then
  // the metadata of its index note. Null after the notice when the folder has
  // no Markdown notes. Shared with the folder preview.
  private async planFolder(folder: TFolder): Promise<PlannedExport | null> {
    const mdFiles = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    const legacy = this.legacyFolderOrder(mdFiles, folder);
    const plan = this.planFolderExport(folder, legacy);
    if (!plan) return null;

    const { meta, cover } = await this.metaSource().plan(legacy.index, folder.name);
    return { files: plan.files, nav: plan.nav, warnings: plan.warnings, meta, cover, metaFile: legacy.index };
  }

  // Builds the book a PlannedExport describes. It works on COPIES of the plan's
  // metadata and warnings because attaching the cover adds to both, and the
  // same PlannedExport may be what a preview window is still holding.
  private async exportPlanned(planned: PlannedExport): Promise<void> {
    const meta = { ...planned.meta };
    const warnings = [...planned.warnings];
    await this.metaSource().attachCover(meta, planned.cover, planned.metaFile, (m) => warnings.push(m));
    await this.runExport({ meta, files: planned.files, nav: planned.nav, warnings });
  }

  // ── preview (014-preview-before-export) ─────────────────────────

  // Shows the book a folder export WOULD write — its plan, with nothing
  // rendered, fetched or written — and runs it only if the reader chooses
  // Export in the window.
  async previewFolder(folder: TFolder): Promise<void> {
    await this.planAndShowPreview(() => this.planFolder(folder));
  }

  // The linked-notes counterpart: the notes the link walk reaches at the
  // reader's link depth, in the order the export will use.
  async previewLinked(file: TFile): Promise<void> {
    await this.planAndShowPreview(() => this.planLinked(file));
  }

  // A preview exists to look before exporting, so when looking itself goes
  // wrong the reader gets a notice and nothing else: the one-step export
  // commands never run any of this, and they stay available (Constitution II).
  // A null plan already showed its own notice.
  private async planAndShowPreview(makePlan: () => Promise<PlannedExport | null>): Promise<void> {
    try {
      const planned = await makePlan();
      if (planned) this.showPreview(planned);
    } catch (e) {
      console.error("[inkbound] preview failed", e);
      new Notice(`Could not build the preview: ${errorMessage(e)}. You can still export the book as usual.`);
    }
  }

  private showPreview(planned: PlannedExport): void {
    const preview = buildBookPreview(this.previewInputFor(planned));
    openBookPreview(this.app, preview, () => void this.exportPlanned(planned));
  }

  private previewInputFor(planned: PlannedExport): PreviewInput {
    return {
      title: planned.meta.title,
      author: planned.meta.author,
      language: planned.meta.language,
      cover: planned.cover,
      chapters: planned.files.map((file) => ({ title: this.titleFor(file), path: file.path })),
      nav: planned.nav,
      warnings: planned.warnings,
    };
  }

  // ── orchestrator ────────────────────────────────────────────────

  /**
   * Runs one export and remembers what the commands need afterwards. The
   * pipeline itself — chapter loop, asset resolution, backlinks, Thai font,
   * nav tree, write, push, completion notice — lives in export-pipeline.ts.
   * What stays here is the wiring (which app, settings and title resolver it
   * gets) and the plugin's own session state.
   */
  async runExport(job: Job): Promise<void> {
    const outcome = await runExportPipeline(job, {
      app: this.app,
      component: this,
      settings: this.settings,
      titleFor: (file: TFile) => this.titleFor(file),
    });
    this.lastReport = outcome.report;
    this.lastShareTarget = outcome.shareTarget;
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
