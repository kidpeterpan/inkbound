import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, parseLinktext } from "obsidian";
import type { NavItem } from "./epub";
import { planBook, type FolderInput, type NoteInput, type NavPlanNode } from "./book-tree";
import { orderChapters, pickIndexNote, bfsLinked } from "./collect";
import { deriveChapterTitle } from "./naming";
import { canShareEpub, shareEpub, type ShareTarget } from "./share";
import { DEFAULT_SETTINGS, EpubExportSettings, EpubExportSettingTab } from "./settings";
import type { ExportMeta } from "./types";
import type { MetaDefaults } from "./metadata";
import { NoteMetaSource } from "./meta-adapter";
import type { ExportReport } from "./report";
import { openExportReport } from "./report-view";
import { errorMessage } from "./error-text";
import { runExport as runExportPipeline, type Job } from "./export-pipeline";

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
      new Notice("Active file is not a Markdown note.");
      return;
    }
    fn(f);
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
    return new NoteMetaSource(this.app, this.metaDefaults()).resolve(file, fallbackBasename, warn);
  }

  async exportSingle(file: TFile) {
    const warnings: string[] = [];
    const meta = await this.metaFromNote(file, file.basename, (m) => warnings.push(m));
    await this.runExport({ meta, files: [file], warnings });
  }

  async exportLinked(file: TFile) {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    const warnings: string[] = [];
    const meta = await this.metaFromNote(file, file.basename, (m) => warnings.push(m));
    await this.runExport({ meta, files, warnings });
  }

  // Frontmatter `tags` can be a scalar string (e.g. `tags: handbook`)
  // rather than a list. pickIndexNote's `.includes(...)` checks are
  // Array.prototype.includes for list-shaped tags, but a string scalar
  // would silently fall through to String.prototype.includes, which is
  // substring matching and can misfire (e.g. "notebook mainframe"
  // contains both "book" and "main"). Only genuine arrays count.
  private tagsOf(f: TFile): string[] {
    const tags: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.tags;
    return Array.isArray(tags) ? (tags as string[]) : [];
  }

  // 009-index-order-parts (research R4): an index note's REGULAR links, in
  // document order, resolved to vault paths. Obsidian keeps embeds in
  // `embeds` and frontmatter links in `frontmatterLinks`, so reading `links`
  // alone is what makes FR-005 ("embeds never order") hold — do not widen
  // this to resolvedLinks, whose key order is not document order.
  private orderedLinkTargets(file: TFile): string[] {
    const links = [...(this.app.metadataCache.getFileCache(file)?.links ?? [])];
    links.sort((a, b) => a.position.start.offset - b.position.start.offset);
    const targets: string[] = [];
    for (const l of links) {
      const { path } = parseLinktext(l.link);
      if (path === "") continue; // [[#heading]] — a link to the note itself
      const dest = this.app.metadataCache.getFirstLinkpathDest(path, file.path);
      // Notes only (FR-004): a plain link to an image inside `Part I/` would
      // otherwise resolve to a path under that folder and drag the Part with it.
      if (dest instanceof TFile && dest.extension === "md") targets.push(dest.path);
    }
    return targets;
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
          linkTargets: this.orderedLinkTargets(child),
        });
      } else if (child instanceof TFolder) {
        subfolders.push(this.buildFolderInput(child, byPath));
      }
    }
    return { name: folder.name, path: folder.path, notes, subfolders };
  }

  // Pre-009 folder collection: direct children only, index first, NN_ then
  // alphabetical. Kept as the fallback the planner degrades to (research R5)
  // and as the reference for FR-013 ("flat folders export identically").
  private legacyFolderOrder(mdFiles: TFile[], folder: TFolder): { index: TFile | null; files: TFile[] } {
    const candidates = mdFiles.map((f) => ({ basename: f.basename, tags: this.tagsOf(f) }));
    const indexName = pickIndexNote(candidates, folder.name);
    const index = mdFiles.find((f) => f.basename === indexName) ?? null;
    const chapterNames = orderChapters(mdFiles.filter((f) => f !== index).map((f) => f.basename));
    const files = chapterNames.map((n) => mdFiles.find((f) => f.basename === n)!);
    if (index) files.unshift(index);
    return { index, files };
  }

  // Plans a folder export's reading order and nav tree. Returns null after
  // notifying when the folder has no Markdown notes; a planner failure
  // degrades to the legacy flat order with a warning, never aborts
  // (Constitution II / FR-016).
  private planFolderExport(
    folder: TFolder,
    legacy: { index: TFile | null; files: TFile[] }
  ): { files: TFile[]; nav?: NavItem[]; warnings: string[] } | null {
    const warnings: string[] = [];
    let files = legacy.files;
    let nav: NavItem[] | undefined;
    try {
      const byPath = new Map<string, TFile>();
      const input = this.buildFolderInput(folder, byPath);
      if (byPath.size === 0) {
        new Notice("Folder has no Markdown notes.");
        return null;
      }
      const plan = planBook(input);
      // Path-keyed, not basename-keyed: two subfolders may hold same-named notes (FR-018).
      files = plan.order.map((p) => byPath.get(p)!);
      // The nav tree references chapters by POSITION in `files` (research
      // R2): runExport's hrefByPath and the failed-chapter placeholder are
      // both position-derived, so an index-keyed tree stays aligned with
      // them for free. Only set when there is at least one Part — a flat
      // folder keeps the flat nav untouched (FR-013).
      const position = new Map(plan.order.map((p, i) => [p, i]));
      const toNavItem = (node: NavPlanNode): NavItem =>
        node.kind === "chapter"
          ? { kind: "chapter", chapter: position.get(node.path)! }
          : {
              kind: "part",
              title: node.indexPath ? this.titleFor(byPath.get(node.indexPath)!) : node.folderName,
              indexChapter: node.indexPath ? position.get(node.indexPath)! : null,
              children: node.children.map(toNavItem),
            };
      if (plan.nav.some((n) => n.kind === "part")) nav = plan.nav.map(toNavItem);
    } catch (e) {
      // Constitution II / FR-016: ordering is structure, not content — a bug
      // here degrades to the pre-009 flat order and says so, never aborts.
      warnings.push(`chapter ordering fell back to filename order: ${errorMessage(e)}`);
      if (files.length === 0) {
        new Notice("Folder has no Markdown notes.");
        return null;
      }
    }
    return { files, nav, warnings };
  }

  async exportFolder(folder: TFolder) {
    const mdFiles = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    const legacy = this.legacyFolderOrder(mdFiles, folder);
    const plan = this.planFolderExport(folder, legacy);
    if (!plan) return;

    const meta = await this.metaFromNote(legacy.index, folder.name, (m) => plan.warnings.push(m));
    await this.runExport({ meta, files: plan.files, nav: plan.nav, warnings: plan.warnings });
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
