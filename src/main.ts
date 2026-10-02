import {
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  parseLinktext,
} from "obsidian";
import { EpubBuilder, chapterHref, type NavItem } from "./epub";
import { escapeXml } from "./xml";
import { systemBookIdentity } from "./book-identity";
import { planBook, type FolderInput, type NoteInput, type NavPlanNode } from "./book-tree";
import { computeBacklinks, renderBacklinksFragment } from "./backlinks";
import { orderChapters, pickIndexNote, bfsLinked } from "./collect";
import { renderUnitToChapter } from "./render-adapter";
import { slugify, deriveChapterTitle } from "./naming";
import { resolveDestination, type ExportDestination } from "./output";
import { desktopHomedir, platformKind, writeBook } from "./output-adapter";
import { canShareEpub, shareEpub, type ShareTarget } from "./share";
import { resolveChapterAssets, type AssetVault } from "./chapter-assets";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./http";
import {
  DEFAULT_SETTINGS,
  EpubExportSettings,
  EpubExportSettingTab,
  coerceBacklinkPosition,
  summarizeWarnings,
} from "./settings";
import type { ExportMeta } from "./types";
import type { MetaDefaults } from "./metadata";
import { NoteMetaSource } from "./meta-adapter";
import { containsThai } from "./fonts";
import { getThaiFontLoader } from "./font-assets";
import { createWarningCollector, buildReport, type ExportReport, type WarningCollector } from "./report";
import { openExportReport } from "./report-view";
import { errorMessage } from "./error-text";

interface Job {
  meta: ExportMeta;
  files: TFile[]; // chapter order
  // 009-index-order-parts: nested TOC plan (folder exports only); absent ⇒
  // today's flat nav. Indices refer to positions in `files`.
  nav?: NavItem[];
  // Warnings raised while BUILDING the job (before runExport owns the list),
  // e.g. the folder planner falling back to filename order. Seeded into
  // runExport's warnings so they reach the user with everything else.
  warnings?: string[];
}

// State of runExport's chapter loop, assembled once and mutated chapter by
// chapter by renderAndAddChapter — passing it keeps that method's signature
// short while preserving the loop's original mutation order exactly.
interface ChapterPass {
  builder: EpubBuilder;
  hrefByPath: Map<string, string>;
  basePath: string;
  assetVault: AssetVault<TFile>;
  withBacklinks: (file: TFile, xhtmlBody: string) => string;
  // Running total of images rewriteImages has STAMPED into chapter HTML
  // so far — not the count that later loaded as assets. The <img> hrefs
  // are burned into r.xhtmlBody the moment renderUnitToChapter returns,
  // before any vault read is attempted, so the next chapter's startIndex
  // must be measured against what was stamped, not what loaded — else a
  // missing/failed image would let a later chapter reissue an href
  // that's already sitting in an earlier chapter's HTML.
  imageCount: number;
  // 006-thai-font FR-001: Thai anywhere in any chapter body (including
  // linked/embedded content, which flows through xhtmlBody) marks the
  // book for font embedding — decided AFTER the loop, when the setting
  // is consulted, so detection alone never changes output.
  hasThai: boolean;
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

  async runExport(job: Job) {
    // 010-export-report — WHY A COLLECTOR, NOT A string[]: the report groups
    // warnings by the chapter that produced them, and that fact is only
    // available HERE, as each warning is recorded. Recovering it afterwards
    // would mean regex-parsing prose ("... (referenced by X.md)") that four
    // modules author independently — and five warnings carry no path at all
    // (the Thai-font, Mermaid- and math-rasterization, chapter-ordering and
    // table-of-contents fallbacks), so parsing would mis-group those five
    // today and break silently the next time a message is reworded.
    // See specs/010-export-report/research.md R1.
    //
    // `collector.messages()` is exactly what the old string[] held, in the
    // same order — console output and summarizeWarnings must not change
    // (FR-020), because scripts/local-export.ts parses those console lines.
    const collector = createWarningCollector();
    // job.warnings carries the chapter-ordering fallback, which exportFolder
    // records BEFORE runExport is called — so it is book-level by definition,
    // and is seeded here rather than looked for in the chapter loop below.
    (job.warnings ?? []).forEach(collector.forBook());
    let notice: Notice | null = null;
    try {
      notice = new Notice(`Exporting "${job.meta.title}"…`, 0);
      const adapter = this.app.vault.adapter;
      // "" on mobile: the mobile vault adapter is not a FileSystemAdapter and
      // has no filesystem base path to give. rewriteImages in render.ts has an
      // explicit empty-basePath guard because of this — see the invariant
      // comment there before assuming "" is an impossible or harmless value.
      const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

      const hrefByPath = new Map(job.files.map((f, i) => [f.path, chapterHref(i)]));
      // The book's uuid / modified timestamp / ZIP entry dates come from here:
      // this is the composition root, so the one place an export picks up the
      // system clock is visible where the export is set up (book-identity.ts).
      const builder = new EpubBuilder(job.meta, systemBookIdentity());

      const withBacklinks = this.backlinkDecorator(job.files, hrefByPath);

      // How resolveChapterAssets finds and reads a vault image. The one place
      // the obsidian types (TFile, the link resolver) meet that pure module.
      const assetVault: AssetVault<TFile> = {
        locate: (vaultPath, fromPath) => {
          const direct = this.app.vault.getAbstractFileByPath(vaultPath);
          if (direct instanceof TFile) return direct;
          // Not a vault-rooted path (or app://-derived path didn't match
          // as-is) — fall back to Obsidian's own link resolver, which
          // handles paths relative to the source note and bare
          // filenames (same resolver render-adapter.ts uses for links).
          const resolved = this.app.metadataCache.getFirstLinkpathDest(vaultPath, fromPath);
          return resolved instanceof TFile ? resolved : null;
        },
        read: (file) => this.app.vault.readBinary(file),
      };

      const chapterPass: ChapterPass = {
        builder,
        hrefByPath,
        basePath,
        assetVault,
        withBacklinks,
        imageCount: 0,
        hasThai: false,
      };
      for (const [chapterIndex, file] of job.files.entries()) {
        // Everything recorded inside this iteration is about THIS chapter.
        const warnForChapter = collector.forNote(file.path);
        // 008-mobile-support FR-014/SC-006: a long export on a phone otherwise
        // looks like a frozen app. Reuses the persistent notice the push step
        // already updates, so this costs nothing new — and it helps desktop
        // exports of large books just as much.
        notice.setMessage(`Exporting "${job.meta.title}" — chapter ${chapterIndex + 1}/${job.files.length}…`);
        await this.renderAndAddChapter(chapterPass, file, warnForChapter);
      }

      this.applyThaiFont(builder, chapterPass.hasThai, collector);

      this.applyNavTree(builder, job.nav, collector);

      const bytes = await builder.build();
      await this.finishExport(job, bytes, collector, notice);
    } catch (e) {
      console.error("[inkbound] export failed", e);
      new Notice(`EPUB export failed: ${errorMessage(e)}`);
    } finally {
      // In `finally`, not on the success path: a write that fails must not
      // take the warnings gathered before it down with it — on mobile the
      // console is all a failed export leaves behind for the developer, and
      // scripts/local-export.ts parses these lines (FR-020).
      collector.messages().forEach((w) => console.warn("[inkbound]", w));
      notice?.hide();
    }
  }

  // Renders one chapter and adds it — or a failure placeholder — to the book,
  // resolving its images and advancing the pass's running totals. The whole
  // body of runExport's chapter loop, split out so the loop reads as a loop.
  private async renderAndAddChapter(
    pass: ChapterPass,
    file: TFile,
    warn: (message: string) => void
  ): Promise<void> {
    try {
      const md = await this.app.vault.cachedRead(file);
      const r = await renderUnitToChapter(
        this.app,
        this,
        md,
        file.path,
        pass.hrefByPath,
        pass.basePath,
        pass.imageCount,
        this.settings.tocHeadingDepth
      );
      r.warnings.forEach(warn);
      pass.hasThai = pass.hasThai || containsThai(r.xhtmlBody);
      // Bump immediately, before the asset loop below: these numbers are
      // already burned into r.xhtmlBody regardless of what happens next.
      pass.imageCount += r.images.length;
      await resolveChapterAssets(
        r.images,
        file.path,
        pass.assetVault,
        (href, bytes, mediaType) => pass.builder.addAsset(href, bytes, mediaType),
        warn
      );
      pass.builder.addChapter(this.titleFor(file), pass.withBacklinks(file, r.xhtmlBody), r.toc);
    } catch (e) {
      warn(`chapter skipped: ${file.path} — ${String(e)}`);
      // Placeholder keeps builder's chapter count == job.files.length, so
      // hrefByPath (position-derived from job.files) stays in sync with
      // EpubBuilder's own internal numbering (which only advances on
      // addChapter). Without this, a skipped chapter shifts every later
      // chapter's real href back by one, silently retargeting any link
      // that pointed at or past the failed chapter.
      // The placeholder still gets the backlink trail: a failed chapter
      // keeps its spine slot and can still be navigated back from.
      pass.builder.addChapter(
        this.titleFor(file),
        pass.withBacklinks(file, `<p class="omitted">[chapter failed to render: ${escapeXml(file.path)}]</p>`)
      );
    }
  }

  // Builds the function that adds a chapter's backlink trail to its body.
  private backlinkDecorator(
    files: TFile[],
    hrefByPath: Map<string, string>
  ): (file: TFile, xhtmlBody: string) => string {
    // Backlink trail: which chapters in THIS book link to each chapter,
    // in book order. Sources come from the same resolvedLinks graph the
    // linked-notes collector consumed, so anything bfsLinked counted as a
    // link is guaranteed to show up as a backlink here.
    const fileByPath = new Map(files.map((f) => [f.path, f]));
    const backlinks = computeBacklinks(
      this.app.metadataCache.resolvedLinks,
      files.map((f) => f.path)
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
    return withBacklinks;
  }

  private applyThaiFont(builder: EpubBuilder, hasThai: boolean, collector: WarningCollector): void {
    // 006-thai-font FR-002/FR-008/FR-009: embed only when the setting is
    // ON and Thai was detected; an unusable font asset degrades to a valid
    // fontless book with a warning — never a failure (constitution II).
    if (this.settings.embedThaiFont && hasThai) {
      try {
        const asset = getThaiFontLoader()();
        if (asset) {
          builder.setThaiFont(asset);
        } else {
          collector.forBook()("Thai font unavailable — exporting without embedded font");
        }
      } catch (e) {
        collector.forBook()(`Thai font embedding skipped: ${errorMessage(e)}`);
      }
    }
  }

  private applyNavTree(builder: EpubBuilder, nav: NavItem[] | undefined, collector: WarningCollector): void {
    // 009-index-order-parts: set AFTER the chapter loop so every slot —
    // including failed-chapter placeholders — exists to be referenced. A
    // tree the builder rejects degrades to the flat nav with a warning;
    // the book itself is unaffected (constitution II).
    if (nav) {
      try {
        builder.setNavTree(nav);
      } catch (e) {
        collector.forBook()(`table of contents fell back to a flat list: ${errorMessage(e)}`);
      }
    }
  }

  // Everything after the book is built: write it, push it, and tell the reader.
  // Runs inside runExport's try, so a throw here is still reported as a failed
  // export and the collected warnings still reach the console.
  private async finishExport(
    job: Job,
    bytes: Uint8Array,
    collector: WarningCollector,
    notice: Notice
  ): Promise<void> {
    const kind = platformKind();
    const dest = resolveDestination(
      kind,
      this.settings,
      slugify(job.meta.title),
      // Desktop-only input. Called unconditionally because desktopHomedir
      // carries the platform guard itself and answers "" on mobile — one
      // guard, in the place that owns the node import, instead of the same
      // condition written twice and drifting.
      await desktopHomedir()
    );
    await writeBook(dest, bytes, this.app.vault); // save ALWAYS precedes push (spec)
    this.lastShareTarget =
      dest.kind === "mobile" ? { fileName: dest.fileName, bytes, mimeType: "application/epub+zip" } : null;

    const pushMsg = await this.pushToBoox(dest, bytes, notice, collector);
    const warnMsg = summarizeWarnings(collector.messages());
    const savedText = `EPUB saved to ${dest.displayPath}${pushMsg}${warnMsg ? `\n${warnMsg}` : ""}`;

    this.showExportNotice(savedText, job, collector);
  }

  // Pushes the finished book when the setting is on, returning the fragment the
  // completion notice shows. A push failure is a warning, never a failed
  // export — the book is already safely on disk.
  private async pushToBoox(
    dest: ExportDestination,
    bytes: Uint8Array,
    notice: Notice,
    collector: WarningCollector
  ): Promise<string> {
    if (!this.settings.pushAfterExport || !this.settings.booxUrl) return "";
    try {
      notice.setMessage("Pushing to Boox…");
      // dest.fileName, not a path split at the call site: BooxDrop must
      // upload under the same name on both platforms (FR-010).
      await new BooxDropClient(this.settings.booxUrl, obsidianHttp).push(dest.fileName, bytes);
      return " and pushed to Boox ✓";
    } catch (e) {
      const msg = errorMessage(e);
      collector.forBook()(`push to Boox failed: ${msg}`);
      return ` — saved locally, push failed: ${msg}`;
    }
  }

  // Builds the export report and shows the completion notice — clickable when
  // the report has warnings, byte-identical to the pre-report notice otherwise.
  private showExportNotice(savedText: string, job: Job, collector: WarningCollector): void {
    // 010-export-report. Built and wired in its own try: everything above
    // has already succeeded and the book IS on disk, so a bug in the report
    // must not fall through to the outer catch and tell the reader the
    // export failed (FR-019, Constitution II). Worst case is a saved book
    // shown with the plain notice — exactly the pre-feature behavior.
    let report: ExportReport | null = null;
    try {
      report = buildReport(
        job.meta.title,
        job.files.map((f) => f.path),
        collector.scoped()
      );
      this.lastReport = report;
    } catch (e) {
      console.error("[inkbound] could not build the export report", e);
    }

    if (report && report.total > 0) {
      // WHY A DocumentFragment AND NOT Notice.noticeEl: the report needs a
      // tap target on the notice, and Notice exposes exactly two element
      // members — `messageEl` (@since 1.8.7, which manifest.json's
      // minAppVersion of 1.5.0 forbids: undefined on 1.5.0 through 1.8.6,
      // and the no-unsupported-api lint rule fails the build for it) and
      // `noticeEl` (available since 0.9.7 but deprecated, and this repo's
      // lint config forbids disabling @typescript-eslint/no-deprecated at
      // all). The constructor's DocumentFragment overload predates both and
      // is flagged by neither: we build the notice body ourselves and make
      // it clickable, so no Notice member is touched. See
      // specs/010-export-report/research.md R3.
      const openReport = report;
      new Notice(
        createFragment((frag) => {
          const body = frag.createDiv({ text: savedText });
          body.addEventListener("click", () => openExportReport(this.app, openReport));
        }),
        8000
      );
      return;
    }
    // FR-003: a warning-free export's notice is byte-identical to what it
    // was before this feature, and nothing about it is clickable.
    new Notice(savedText, 8000);
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
