// 016-export-all-books — the windows of "Export all books": the list of books a
// run will export, shown before anything is written or pushed.
//
// A THIN adapter in the mould of preview-view.ts and report-view.ts: what a run
// contains is decided in the pure core; what is left here is the DOM and the
// Modal lifecycle. NO CSS, for the reason report-view.ts gives (styles.css ships
// empty and the release attaches it only when non-empty), and the buttons sit
// ABOVE the list so a long library keeps them in a phone reader's reach.
// Every title and folder is set with `text`, never as markup.
import { App, Modal, Notice } from "obsidian";
import {
  LIBRARY_REPORT_TITLE,
  librarySummary,
  listRow,
  outcomeLine,
  renderLibraryReportText,
  type LibraryReport,
} from "../core/delivery/library-report";

const LIST_INTRO =
  "These books will be exported one after another, each as exporting its folder would. Nothing is written or pushed until you choose Export all.";

export class LibraryListModal extends Modal {
  private readonly rows: readonly string[];
  private readonly onExportAll: () => void;
  // One window starts at most one run, however often Export all is activated
  // (a double tap on a phone): a second run would export and push every book again.
  private runStarted = false;

  constructor(app: App, rows: readonly string[], onExportAll: () => void) {
    super(app);
    this.rows = rows;
    this.onExportAll = onExportAll;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Opening twice must not double the content.
    contentEl.empty();
    this.runStarted = false;

    contentEl.createEl("h2", { text: LIBRARY_REPORT_TITLE });
    contentEl.createEl("p", { text: LIST_INTRO });
    this.renderActions(contentEl);
    contentEl.createEl("h3", { text: bookCountLabel(this.rows.length) });
    const list = contentEl.createEl("ol");
    for (const row of this.rows) list.createEl("li", { text: row });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderActions(contentEl: HTMLElement): void {
    const actions = contentEl.createDiv();
    const exportAllButton = actions.createEl("button", { text: "Export all", cls: "mod-cta" });
    exportAllButton.addEventListener("click", () => this.startRun(exportAllButton));
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
  }

  private startRun(exportAllButton: HTMLButtonElement): void {
    if (this.runStarted) return;
    this.runStarted = true;
    exportAllButton.disabled = true;
    this.close();
    this.onExportAll();
  }
}

// Counts every row, skipped books included: they are part of what the reader
// is deciding about.
function bookCountLabel(count: number): string {
  return count === 1 ? "1 book" : `${count} books`;
}

/** Opens the list of books a run will export. `onExportAll` runs only if the reader confirms. */
export function openLibraryList(app: App, rows: readonly string[], onExportAll: () => void): void {
  new LibraryListModal(app, rows, onExportAll).open();
}

/**
 * The report of a whole run: every book with what happened to it and, under a
 * book that has them, its warnings. What "Show last export report" opens after
 * a run (spec FR-008).
 */
export class LibraryReportModal extends Modal {
  private readonly report: LibraryReport;

  constructor(app: App, report: LibraryReport) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Opening twice must not double the content.
    contentEl.empty();

    contentEl.createEl("h2", { text: LIBRARY_REPORT_TITLE });
    contentEl.createEl("p", { text: librarySummary(this.report) });
    for (const book of this.report.books) {
      contentEl.createEl("h3", { text: listRow(book) });
      contentEl.createEl("p", { text: outcomeLine(book) });
      if (book.messages.length === 0) continue;
      const list = contentEl.createEl("ul");
      for (const message of book.messages) list.createEl("li", { text: message });
    }

    const copy = contentEl.createEl("button", { text: "Copy report" });
    copy.addEventListener("click", () => void this.copyToClipboard());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // As report-view.ts: a diagnostic window must never throw at the reader, and a
  // clipboard can be absent or refuse.
  private async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(renderLibraryReportText(this.report));
      new Notice("Export report copied");
    } catch {
      new Notice("Could not copy the report — this device did not allow it");
    }
  }
}

/** Opens the report of a whole run. */
export function openLibraryReport(app: App, report: LibraryReport): void {
  new LibraryReportModal(app, report).open();
}
