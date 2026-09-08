// 010-export-report: the Obsidian-facing half of the export report.
//
// Constitution IV — this is a THIN adapter. Every decision about what the
// report contains (grouping, ordering, counting, the plain-text rendering the
// copy action ships) lives in the pure src/report.ts, which vitest loads
// directly. What is left here is the DOM and the Modal lifecycle, the only
// parts that genuinely need Obsidian.
//
// NO CSS BY DESIGN (research R5). styles.css ships empty on purpose and the
// release workflow attaches it only when non-empty, so adding rules here
// would quietly change what a release publishes. Semantic elements inside a
// modal's contentEl are legible on both platforms without any of our own.
// Two lint rules enforce the same discipline from the other side:
// `prefer-create-el` (no innerHTML) and `no-static-styles-assignment` (no
// el.style writes).

import { App, Modal, Notice } from "obsidian";
import { BOOK_GROUP_LABEL, renderReportText, type ExportReport } from "./report";

export class ExportReportModal extends Modal {
  private readonly report: ExportReport;

  constructor(app: App, report: ExportReport) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Opening twice must not double the content — see the re-render test.
    contentEl.empty();

    contentEl.createEl("h2", { text: this.report.title });

    if (this.report.total === 0) {
      contentEl.createEl("p", { text: "This export produced no warnings." });
      return;
    }

    const n = this.report.total;
    contentEl.createEl("p", {
      text: `${n} ${n === 1 ? "warning" : "warnings"} while building this book. The book was saved; the items below were left out or degraded.`,
    });

    for (const group of this.report.groups) {
      contentEl.createEl("h3", {
        text: group.kind === "book" ? BOOK_GROUP_LABEL : (group.notePath ?? ""),
      });
      const list = contentEl.createEl("ul");
      for (const message of group.messages) {
        // `text`, never markup: a warning quotes a vault path the reader
        // chose, and a path can contain anything a filename can (FR-011).
        list.createEl("li", { text: message });
      }
    }

    const copy = contentEl.createEl("button", { text: "Copy report" });
    copy.addEventListener("click", () => void this.copyToClipboard());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // Constitution II applies to this view too: a diagnostic screen must never
  // throw at the reader. navigator.clipboard can be absent (older WebView) or
  // reject (denied permission, insecure context), and neither is something
  // the reader can act on — so both degrade to a notice.
  private async copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(renderReportText(this.report));
      new Notice("Export report copied");
    } catch {
      new Notice("Could not copy the report — this device did not allow it");
    }
  }
}

/** Opens the report for one finished export. */
export function openExportReport(app: App, report: ExportReport): void {
  new ExportReportModal(app, report).open();
}
