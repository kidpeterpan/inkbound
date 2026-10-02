// The export pipeline: everything that happens between "the user picked a
// scope" and "the reader has been told the book is saved".
//
// This is the pipes-and-filters core of the plugin. It used to be nine methods
// on the plugin class, interleaved with command registration and settings
// handling; here it is one function whose dependencies arrive as arguments, so
// what the pipeline needs from its host is visible in one signature instead of
// scattered across `this.`.
//
// ADAPTER by this repo's rule (it imports `obsidian` for TFile/Notice and the
// vault): the PURE stages it drives live in render.ts, chapter-assets.ts,
// book-tree.ts, report.ts and epub.ts, and the writing half lives in
// output-adapter.ts. See tests/module-boundaries.test.ts.
import { App, Component, FileSystemAdapter, Notice, TFile } from "obsidian";
import { EpubBuilder, chapterHref, type NavItem } from "../core/epub";
import { escapeXml } from "../core/xml";
import { systemBookIdentity } from "../core/book-identity";
import { renderUnitToChapter } from "./render-adapter";
import { resolveChapterAssets, type AssetVault } from "../core/chapter-assets";
import { computeBacklinks, renderBacklinksFragment } from "../core/backlinks";
import { BooxDropClient } from "../core/booxdrop";
import { obsidianHttp } from "./http";
import { resolveDestination, type ExportDestination } from "../core/output";
import { desktopHomedir, platformKind, writeBook } from "./output-adapter";
import { showExportNotice } from "./export-notice";
import { createWarningCollector, type ExportReport, type WarningCollector } from "../core/report";
import { coerceBacklinkPosition, summarizeWarnings, type EpubExportSettings } from "../core/settings-core";
import { slugify } from "../core/naming";
import { getThaiFontLoader } from "../core/font-assets";
import { containsThai } from "../core/fonts";
import { errorMessage } from "../core/error-text";
import type { ShareTarget } from "../core/share";
import type { ExportMeta } from "../core/types";

export interface Job {
  meta: ExportMeta;
  files: TFile[]; // chapter order
  // 009-index-order-parts: nested TOC plan (folder exports only); absent ⇒
  // today's flat nav. Indices refer to positions in `files`.
  nav?: NavItem[];
  // Warnings raised while BUILDING the job (before the pipeline owns the list),
  // e.g. the folder planner falling back to filename order. Seeded into the
  // collector below so they reach the user with everything else.
  warnings?: string[];
}

/** What the pipeline needs from the plugin hosting it. */
export interface ExportPipelineDeps {
  app: App;
  /** Passed to MarkdownRenderer as the owning Component (the plugin itself). */
  component: Component;
  settings: EpubExportSettings;
  /** Chapter title resolution — metadata cache plus naming.ts. */
  titleFor: (file: TFile) => string;
}

/** What the caller has to remember after a completed export. */
export interface ExportOutcome {
  /** The report the completion notice was built from, for the report command. */
  report: ExportReport | null;
  /** Set only on mobile: the written book, for the share command. */
  shareTarget: ShareTarget | null;
}

// State of the chapter loop, assembled once and mutated chapter by chapter by
// renderAndAddChapter — passing it keeps that function's signature short while
// preserving the loop's original mutation order exactly.
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

/**
 * Renders every chapter of `job` into a book, writes it, optionally pushes it,
 * and shows the completion notice. Never throws: a failure anywhere is
 * reported to the reader and recorded in the console, because a partial book
 * must still leave the warnings it gathered behind.
 */
export async function runExport(job: Job, deps: ExportPipelineDeps): Promise<ExportOutcome> {
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
  // job.warnings carries the chapter-ordering fallback, which the scope
  // builders record BEFORE this runs — so it is book-level by definition,
  // and is seeded here rather than looked for in the chapter loop below.
  (job.warnings ?? []).forEach(collector.forBook());
  const outcome: ExportOutcome = { report: null, shareTarget: null };

  let notice: Notice | null = null;
  try {
    notice = new Notice(`Exporting "${job.meta.title}"…`, 0);
    const adapter = deps.app.vault.adapter;
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

    const withBacklinks = backlinkDecorator(job.files, hrefByPath, deps);

    const chapterPass: ChapterPass = {
      builder,
      hrefByPath,
      basePath,
      assetVault: assetVaultFor(deps.app),
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
      await renderAndAddChapter(chapterPass, file, warnForChapter, deps);
    }

    applyThaiFont(builder, chapterPass.hasThai, collector, deps.settings);

    applyNavTree(builder, job.nav, collector);

    const bytes = await builder.build();
    return await finishExport(job, bytes, collector, notice, deps);
  } catch (e) {
    console.error("[inkbound] export failed", e);
    new Notice(`EPUB export failed: ${errorMessage(e)}`);
    return outcome;
  } finally {
    // In `finally`, not on the success path: a write that fails must not
    // take the warnings gathered before it down with it — on mobile the
    // console is all a failed export leaves behind for the developer, and
    // scripts/local-export.ts parses these lines (FR-020).
    collector.messages().forEach((w) => console.warn("[inkbound]", w));
    notice?.hide();
  }
}

// The one place the obsidian types (TFile, the link resolver) meet the pure
// chapter-assets module: how resolveChapterAssets finds and reads a vault image.
function assetVaultFor(app: App): AssetVault<TFile> {
  return {
    locate: (vaultPath, fromPath) => {
      const direct = app.vault.getAbstractFileByPath(vaultPath);
      if (direct instanceof TFile) return direct;
      // Not a vault-rooted path (or app://-derived path didn't match
      // as-is) — fall back to Obsidian's own link resolver, which
      // handles paths relative to the source note and bare
      // filenames (same resolver render-adapter.ts uses for links).
      const resolved = app.metadataCache.getFirstLinkpathDest(vaultPath, fromPath);
      return resolved instanceof TFile ? resolved : null;
    },
    read: (file) => app.vault.readBinary(file),
  };
}

// Renders one chapter and adds it — or a failure placeholder — to the book,
// resolving its images and advancing the pass's running totals. The whole
// body of the chapter loop above, split out so the loop reads as a loop.
async function renderAndAddChapter(
  pass: ChapterPass,
  file: TFile,
  warn: (message: string) => void,
  deps: ExportPipelineDeps
): Promise<void> {
  try {
    const md = await deps.app.vault.cachedRead(file);
    const r = await renderUnitToChapter(
      deps.app,
      deps.component,
      md,
      file.path,
      pass.hrefByPath,
      pass.basePath,
      pass.imageCount,
      deps.settings.tocHeadingDepth
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
    pass.builder.addChapter(deps.titleFor(file), pass.withBacklinks(file, r.xhtmlBody), r.toc);
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
      deps.titleFor(file),
      pass.withBacklinks(file, `<p class="omitted">[chapter failed to render: ${escapeXml(file.path)}]</p>`)
    );
  }
}

// Builds the function that adds a chapter's backlink trail to its body.
function backlinkDecorator(
  files: TFile[],
  hrefByPath: Map<string, string>,
  deps: ExportPipelineDeps
): (file: TFile, xhtmlBody: string) => string {
  // Backlink trail: which chapters in THIS book link to each chapter,
  // in book order. Sources come from the same resolvedLinks graph the
  // linked-notes collector consumed, so anything bfsLinked counted as a
  // link is guaranteed to show up as a backlink here.
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const backlinks = computeBacklinks(
    deps.app.metadataCache.resolvedLinks,
    files.map((f) => f.path)
  );
  const backlinkPosition = coerceBacklinkPosition(deps.settings.backlinkPosition);
  return (file: TFile, xhtmlBody: string): string => {
    // "none" restores pre-feature output exactly — no trail on any chapter.
    if (backlinkPosition === "none") return xhtmlBody;
    const entries = (backlinks.get(file.path) ?? []).flatMap((path) => {
      const source = fileByPath.get(path);
      const href = hrefByPath.get(path);
      // Chapters live side by side in text/, so link by filename only
      // (same convention as rewriteLinks in render.ts).
      return source && href ? [{ title: deps.titleFor(source), href: href.replace(/^text\//, "") }] : [];
    });
    const fragment = renderBacklinksFragment(entries);
    if (!fragment) return xhtmlBody;
    if (backlinkPosition === "end") return xhtmlBody + fragment;
    if (backlinkPosition === "both") return fragment + xhtmlBody + fragment;
    return fragment + xhtmlBody;
  };
}

function applyThaiFont(
  builder: EpubBuilder,
  hasThai: boolean,
  collector: WarningCollector,
  settings: EpubExportSettings
): void {
  // 006-thai-font FR-002/FR-008/FR-009: embed only when the setting is
  // ON and Thai was detected; an unusable font asset degrades to a valid
  // fontless book with a warning — never a failure (constitution II).
  if (!settings.embedThaiFont || !hasThai) return;
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

function applyNavTree(builder: EpubBuilder, nav: NavItem[] | undefined, collector: WarningCollector): void {
  // 009-index-order-parts: set AFTER the chapter loop so every slot —
  // including failed-chapter placeholders — exists to be referenced. A
  // tree the builder rejects degrades to the flat nav with a warning;
  // the book itself is unaffected (constitution II).
  if (!nav) return;
  try {
    builder.setNavTree(nav);
  } catch (e) {
    collector.forBook()(`table of contents fell back to a flat list: ${errorMessage(e)}`);
  }
}

// Everything after the book is built: write it, push it, and tell the reader.
// Runs inside runExport's try, so a throw here is still reported as a failed
// export and the collected warnings still reach the console.
async function finishExport(
  job: Job,
  bytes: Uint8Array,
  collector: WarningCollector,
  notice: Notice,
  deps: ExportPipelineDeps
): Promise<ExportOutcome> {
  const dest = resolveDestination(
    platformKind(),
    deps.settings,
    slugify(job.meta.title),
    // Desktop-only input. Called unconditionally because desktopHomedir
    // carries the platform guard itself and answers "" on mobile — one
    // guard, in the place that owns the node import, instead of the same
    // condition written twice and drifting.
    await desktopHomedir()
  );
  await writeBook(dest, bytes, deps.app.vault); // save ALWAYS precedes push (spec)
  const shareTarget: ShareTarget | null =
    dest.kind === "mobile" ? { fileName: dest.fileName, bytes, mimeType: "application/epub+zip" } : null;

  const pushMsg = await pushToBoox(dest, bytes, notice, collector, deps.settings);
  const warnMsg = summarizeWarnings(collector.messages());
  const savedText = `EPUB saved to ${dest.displayPath}${pushMsg}${warnMsg ? `\n${warnMsg}` : ""}`;

  const report = showExportNotice(deps.app, savedText, {
    bookTitle: job.meta.title,
    chapterPaths: job.files.map((f) => f.path),
    warnings: collector.scoped(),
  });

  return { report, shareTarget };
}

// Pushes the finished book when the setting is on, returning the fragment the
// completion notice shows. A push failure is a warning, never a failed
// export — the book is already safely on disk.
async function pushToBoox(
  dest: ExportDestination,
  bytes: Uint8Array,
  notice: Notice,
  collector: WarningCollector,
  settings: EpubExportSettings
): Promise<string> {
  if (!settings.pushAfterExport || !settings.booxUrl) return "";
  try {
    notice.setMessage("Pushing to Boox…");
    // dest.fileName, not a path split at the call site: BooxDrop must
    // upload under the same name on both platforms (FR-010).
    await new BooxDropClient(settings.booxUrl, obsidianHttp).push(dest.fileName, bytes);
    return " and pushed to Boox ✓";
  } catch (e) {
    const msg = errorMessage(e);
    collector.forBook()(`push to Boox failed: ${msg}`);
    return ` — saved locally, push failed: ${msg}`;
  }
}
