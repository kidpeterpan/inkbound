// 016-export-all-books — what happened to each book of an "Export all books"
// run, and how the run is told to the reader: the progress line, the summary
// and the report (specs/016-export-all-books/contracts/library-export.md).
//
// Pure module: zero `obsidian` imports (constitution IV). The notices and the
// report window that show these texts are thin adapters.
import type { ExportReport } from "./report";

/** The outcome of one book of a run. */
export interface BookOutcome {
  folderPath: string;
  title: string;
  outcome: "exported" | "warnings" | "skipped" | "failed";
  /** The book's warnings, in report order; empty unless `outcome` is "warnings". */
  messages: string[];
  /** Why the book was skipped or failed; null otherwise. */
  reason: string | null;
}

/** One run over the whole library: every book's outcome, in run order. */
export interface LibraryReport {
  books: BookOutcome[];
}

/** Why a book whose folder could not be planned is reported as failed. */
export const NO_NOTES_REASON = "Folder has no Markdown notes.";

type BookName = Pick<BookOutcome, "folderPath" | "title">;

/** A written book: with warnings when its report has any. */
export function exportedOutcome(book: BookName, report: ExportReport | null): BookOutcome {
  // A null report means the book was written but its report could not be
  // built; the book itself is fine (010 FR-019).
  const messages = report ? report.groups.flatMap((group) => group.messages) : [];
  return { ...book, outcome: messages.length > 0 ? "warnings" : "exported", messages, reason: null };
}

export function failedOutcome(book: BookName, reason: string): BookOutcome {
  return { ...book, outcome: "failed", messages: [], reason };
}

/** A book not written because an earlier book of the run has its file name. */
export function skippedOutcome(book: BookName, clashesWith: string): BookOutcome {
  return { ...book, outcome: "skipped", messages: [], reason: sameFileNameAs(clashesWith) };
}

function sameFileNameAs(folderPath: string): string {
  return `same file name as ${folderPath}`;
}

// ── the run's progress notice ─────────────────────────────────────────────

/** Which book of the run is being exported. `total` counts the books being exported. */
export interface RunPosition {
  index: number;
  total: number;
  title: string;
}

/** `Exporting book 3 of 12: Dune` */
export function progressText({ index, total, title }: RunPosition): string {
  return `Exporting book ${index} of ${total}: ${title}`;
}

/** Per chapter, so a long book on a phone does not look frozen (008 FR-014). */
export function chapterText(position: RunPosition, chapter: number, chapters: number): string {
  return `${progressText(position)} — chapter ${chapter}/${chapters}…`;
}

export function pushingText(position: RunPosition): string {
  return `${progressText(position)} — Pushing to Boox…`;
}

// ── the list of books ─────────────────────────────────────────────────────

// An em dash with spaces, as the preview and the export report use ("… — …").
const LABEL_SEPARATOR = " — ";

/** `Dune — Library/Fiction/Dune`, with `(skipped: …)` for a book left out of the run. */
export function listRow(book: { title: string; folderPath: string; clashesWith?: string | null }): string {
  const row = `${book.title}${LABEL_SEPARATOR}${book.folderPath}`;
  return book.clashesWith ? `${row} (skipped: ${sameFileNameAs(book.clashesWith)})` : row;
}

// ── the account of the run ────────────────────────────────────────────────

/** The title of the run's report window and of its plain-text copy. */
export const LIBRARY_REPORT_TITLE = "Export all books";

// The order the summary lists the outcomes in, and how it names each.
const SUMMARY_PARTS: readonly [BookOutcome["outcome"], string][] = [
  ["exported", "exported"],
  ["warnings", "with warnings"],
  ["skipped", "skipped"],
  ["failed", "failed"],
];

/** `3 books exported`, or `5 books: 3 exported, 1 with warnings, 1 failed`. */
export function librarySummary(report: LibraryReport): string {
  const books = countOf(report.books.length, "book");
  if (isCleanRun(report)) return `${books} exported`;
  const parts = SUMMARY_PARTS.map(([outcome, label]) => [countWhere(report, outcome), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return `${books}: ${parts.join(", ")}`;
}

/** Every book was exported without a warning: nothing for the reader to look into. */
export function isCleanRun(report: LibraryReport): boolean {
  return report.books.every((book) => book.outcome === "exported");
}

/** What happened to one book, in words. */
export function outcomeLine(book: BookOutcome): string {
  switch (book.outcome) {
    case "exported":
      return "Exported";
    case "warnings":
      return `Exported with ${countOf(book.messages.length, "warning")}`;
    case "skipped":
      return `Skipped: ${book.reason ?? ""}`;
    case "failed":
      return `Failed: ${book.reason ?? ""}`;
  }
}

/** The run report as plain text, for the copy button: no markup. */
export function renderLibraryReportText(report: LibraryReport): string {
  const lines = [LIBRARY_REPORT_TITLE, librarySummary(report), ""];
  for (const book of report.books) {
    lines.push(listRow(book), outcomeLine(book), ...book.messages.map((message) => `  - ${message}`), "");
  }
  return lines.join("\n");
}

function countWhere(report: LibraryReport, outcome: BookOutcome["outcome"]): number {
  return report.books.filter((book) => book.outcome === outcome).length;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
