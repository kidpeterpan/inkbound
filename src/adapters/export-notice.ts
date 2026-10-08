// The completion notice for a finished export: plain text for a clean book, a
// tappable one when the export produced warnings worth reading.
//
// Split out of main.ts (010-export-report). The report is built inside its own
// try/catch here because of WHERE this runs: everything upstream has already
// succeeded and the book IS on disk, so a bug in the report must never fall
// through to the export's outer catch and tell the reader the export failed
// (FR-019, Constitution II). Worst case is a saved book shown with the plain
// notice — exactly the pre-feature behavior.
import { App, Notice } from "obsidian";
import { buildReport, type ExportReport, type ScopedWarning } from "../core/delivery/report";
import { openExportReport } from "./report-view";

export interface ExportNoticeInput {
  /** The book's title, used as the report's heading. */
  bookTitle: string;
  /** Chapter paths in book order, which is the order the report lists them. */
  chapterPaths: readonly string[];
  /** Already attributed to their chapter or to the book by the collector. */
  warnings: readonly ScopedWarning[];
}

/**
 * Shows the export's completion notice and returns the report it built, for
 * the caller to keep (`null` when the report could not be built). The notice is
 * clickable only when the report has warnings; a warning-free export's notice
 * is byte-identical to what it was before this feature (FR-003).
 */
export function showExportNotice(app: App, savedText: string, input: ExportNoticeInput): ExportReport | null {
  let report: ExportReport | null = null;
  try {
    report = buildReport(input.bookTitle, input.chapterPaths, input.warnings);
  } catch (e) {
    console.error("[inkbound] could not build the export report", e);
  }

  if (report === null || report.total === 0) {
    new Notice(savedText, 8000);
    return report;
  }

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
      body.addEventListener("click", () => openExportReport(app, openReport));
    }),
    8000
  );
  return report;
}
