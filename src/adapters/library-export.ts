// 016-export-all-books — runs "Export all books": every planned book, one after
// another, each through the same pipeline a single folder export uses.
//
// What differs from exporting each book by hand is only how the reader is told:
// one notice for the whole run instead of a progress and a completion notice
// per book (spec FR-008). The pipeline's own notices are replaced by a run
// feedback; its console lines are not, because scripts parse them (010 FR-020).
//
// Generic over the plan type, so this module needs nothing from main.ts: the
// caller says how to build one planned book.
import { App, Notice } from "obsidian";
import { openLibraryReport } from "./library-view";
import { buildReportSafely, type ExportFeedback, type ProgressHandle } from "./export-notice";
import type { ExportOutcome } from "./export-pipeline";
import {
  NO_NOTES_REASON,
  chapterText,
  exportedOutcome,
  failedOutcome,
  isCleanRun,
  librarySummary,
  progressText,
  pushingText,
  skippedOutcome,
  type BookOutcome,
  type LibraryReport,
  type RunPosition,
} from "../core/delivery/library-report";
import { errorMessage } from "../core/common/error-text";
import type { ShareTarget } from "../core/delivery/share";

export interface LibraryEntry<Plan> {
  book: { folderPath: string; title: string };
  /** Null when the folder could not be planned. */
  plan: Plan | null;
  /** Set when an earlier book of the run has this book's file name: it is skipped. */
  clashesWith?: string | null;
}

export interface LibraryRunDeps<Plan> {
  /** Builds one planned book, telling the reader through `feedback`. */
  buildBook(plan: Plan, feedback: ExportFeedback): Promise<ExportOutcome>;
}

export interface LibraryRunResult {
  /** Every entry's outcome, in run order. */
  report: LibraryReport;
  /** The last book the run wrote, for "Share last exported book" on mobile. */
  shareTarget: ShareTarget | null;
}

export async function runLibraryExport<Plan>(
  entries: readonly LibraryEntry<Plan>[],
  deps: LibraryRunDeps<Plan>
): Promise<LibraryRunResult> {
  const result: LibraryRunResult = { report: { books: [] }, shareTarget: null };
  const toBuild = entries.filter((entry) => isBuildable(entry));
  const notice = new Notice(progressText(positionOf(toBuild, 0)), 0);
  try {
    for (const entry of entries) {
      if (entry.clashesWith) {
        result.report.books.push(skippedOutcome(entry.book, entry.clashesWith));
        continue;
      }
      if (entry.plan === null) {
        result.report.books.push(failedOutcome(entry.book, NO_NOTES_REASON));
        continue;
      }
      const position = positionOf(toBuild, toBuild.indexOf(entry));
      const built = await buildOneBook(entry.book, entry.plan, runFeedback(notice, position), deps);
      result.report.books.push(built.outcome);
      if (built.shareTarget) result.shareTarget = built.shareTarget;
    }
  } finally {
    notice.hide();
  }
  return result;
}

// Skipped and unplanned books are reported but not built, so they take no
// place in "book <i> of <n>".
function isBuildable<Plan>(entry: LibraryEntry<Plan>): boolean {
  return entry.plan !== null && !entry.clashesWith;
}

// One book's outcome, and the book it wrote. A book that fails in any way, even
// by throwing, is recorded and the run moves on: one broken book never stops the
// others (FR-005, Constitution II).
async function buildOneBook<Plan>(
  book: LibraryEntry<Plan>["book"],
  plan: Plan,
  feedback: ExportFeedback,
  deps: LibraryRunDeps<Plan>
): Promise<{ outcome: BookOutcome; shareTarget: ShareTarget | null }> {
  try {
    const exported = await deps.buildBook(plan, feedback);
    const outcome =
      exported.failure === null
        ? exportedOutcome(book, exported.report)
        : failedOutcome(book, exported.failure);
    return { outcome, shareTarget: exported.shareTarget };
  } catch (e) {
    console.error("[inkbound] export failed", e);
    return { outcome: failedOutcome(book, errorMessage(e)), shareTarget: null };
  }
}

function positionOf(entries: readonly LibraryEntry<unknown>[], index: number): RunPosition {
  return { index: index + 1, total: entries.length, title: entries[index]?.book.title ?? "" };
}

// Shows each book's progress on the run's one notice, and nothing else: no
// per-book completion or failure notice. The report is still built, safely,
// because the run reports every book's warnings at the end.
function runFeedback(notice: Notice, position: RunPosition): ExportFeedback {
  return {
    started: () => {
      notice.setMessage(progressText(position));
      return runProgress(notice, position);
    },
    finished: (_savedText, input) => buildReportSafely(input),
    failed: () => {},
  };
}

// hide() does nothing: the run's notice outlives each book and is hidden once,
// when the run ends.
function runProgress(notice: Notice, position: RunPosition): ProgressHandle {
  return {
    chapter: (index, total) => notice.setMessage(chapterText(position, index, total)),
    pushing: () => notice.setMessage(pushingText(position)),
    hide: () => {},
  };
}

// The run's one closing notice, shown for as long as a single export's. Tappable,
// opening the run report, unless every book was exported cleanly: the same rule
// a single export's completion notice follows. A DocumentFragment rather than
// Notice.noticeEl or messageEl, for the reasons export-notice.ts gives.
export function showLibrarySummary(app: App, report: LibraryReport): void {
  const summary = librarySummary(report);
  if (isCleanRun(report)) {
    new Notice(summary, 8000);
    return;
  }
  new Notice(
    createFragment((fragment) => {
      const body = fragment.createDiv({ text: summary });
      body.addEventListener("click", () => openLibraryReport(app, report));
    }),
    8000
  );
}
