// 014-preview-before-export: the Obsidian-facing half of the book preview.
//
// Constitution IV — a THIN adapter, in the mould of report-view.ts. What the
// preview contains is decided by the pure src/core/book/export-preview.ts; what
// is left here is the DOM and the Modal lifecycle.
//
// NO CSS BY DESIGN, for the reason report-view.ts gives: styles.css ships empty
// and the release workflow attaches it only when non-empty, so a rule added here
// would quietly change what a release publishes. Semantic elements are legible
// on desktop and mobile without any. Two lint rules hold the same line from the
// other side: `prefer-create-el` (no innerHTML) and `no-static-styles-assignment`.
//
// Export and Cancel sit ABOVE the chapter list, not below it: with no CSS there
// is no sticky footer, and a footer under a several-hundred-row list would be
// out of a phone reader's reach.
//
// Everything that comes from the vault (titles, paths, warning text) is set with
// `text`, never as markup: a note's name can contain anything a filename can.
import { App, Modal } from "obsidian";
import type { BookPreview, PreviewRow } from "../core/book/export-preview";

// An em dash with spaces, as the export report's warnings use ("… — …").
const LABEL_SEPARATOR = " — ";

export class BookPreviewModal extends Modal {
  private readonly preview: BookPreview;
  private readonly onExport: () => void;
  // One window starts at most one export, however often Export is activated
  // (a double tap on a phone): the second would write the same book again.
  private exportStarted = false;

  constructor(app: App, preview: BookPreview, onExport: () => void) {
    super(app);
    this.preview = preview;
    this.onExport = onExport;
  }

  onOpen(): void {
    const { contentEl } = this;
    // Opening twice must not double the content.
    contentEl.empty();
    this.exportStarted = false;

    contentEl.createEl("h2", { text: `Preview: ${this.preview.title}` });
    contentEl.createEl("p", { text: this.preview.intro });
    this.renderSummary(contentEl);
    this.renderWarnings(contentEl);
    this.renderActions(contentEl);
    contentEl.createEl("h3", { text: chapterCountLabel(this.preview.chapterCount) });
    contentEl.createEl("p", { text: this.preview.unknowns });
    renderRows(contentEl.createEl("ol"), this.preview.rows);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // Who the book says it is, exactly as the export will write it.
  private renderSummary(contentEl: HTMLElement): void {
    const { title, summary } = this.preview;
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: `Title: ${title}` });
    list.createEl("li", { text: `Author: ${summary.author}` });
    list.createEl("li", { text: `Language: ${summary.language}` });
    list.createEl("li", { text: `Cover: ${summary.cover}` });
  }

  // Only what the plan already knows: an export's other warnings (images, links,
  // math) appear when the book is built, not here.
  private renderWarnings(contentEl: HTMLElement): void {
    if (this.preview.warnings.length === 0) return;
    contentEl.createEl("h3", { text: "Known before building" });
    const list = contentEl.createEl("ul");
    for (const warning of this.preview.warnings) list.createEl("li", { text: warning });
  }

  private renderActions(contentEl: HTMLElement): void {
    const actions = contentEl.createDiv();
    const exportButton = actions.createEl("button", { text: "Export", cls: "mod-cta" });
    exportButton.addEventListener("click", () => this.startExport(exportButton));
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
  }

  private startExport(exportButton: HTMLButtonElement): void {
    if (this.exportStarted) return;
    this.exportStarted = true;
    exportButton.disabled = true;
    this.close();
    this.onExport();
  }
}

function chapterCountLabel(count: number): string {
  return count === 1 ? "1 chapter" : `${count} chapters`;
}

function renderRows(list: HTMLElement, rows: readonly PreviewRow[]): void {
  for (const row of rows) {
    const item = list.createEl("li");
    item.createSpan({ text: rowLabel(row) });
    if (row.kind === "part" && row.children.length > 0) renderRows(item.createEl("ol"), row.children);
  }
}

function rowLabel(row: PreviewRow): string {
  if (row.path === null) return row.title;
  return `${row.title}${LABEL_SEPARATOR}${row.path}`;
}

/** Opens the preview of one planned book. `onExport` runs only if the reader chooses Export. */
export function openBookPreview(app: App, preview: BookPreview, onExport: () => void): void {
  new BookPreviewModal(app, preview, onExport).open();
}
