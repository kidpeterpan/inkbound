// 010-export-report: the pure core of the export report.
//
// Constitution IV — this module MUST NOT import "obsidian". Grouping,
// ordering, counting, and plain-text rendering are decisions with no UI in
// them, so they live here where vitest can load them directly. Only the DOM
// and the Modal lifecycle need Obsidian, and those live in report-view.ts.
//
// WHY A COLLECTOR RATHER THAN PARSING MESSAGES (research R1): most warnings
// name their source in prose ("... (referenced by Book/Ch1.md)"), but five do
// not — the Thai-font fallbacks, the Mermaid and math rasterization
// fallbacks, the chapter-ordering fallback, and the table-of-contents
// fallback. Four modules author these strings independently and none of them
// knows this report exists, so recovering a path by regex would mis-group the
// five today and break silently the next time a message is reworded. The
// export already knows which chapter it is on when it records a warning;
// this captures that instead of throwing it away and guessing later.

/** One warning, plus what it is about. `scope: null` means the book as a whole. */
export interface ScopedWarning {
  scope: string | null;
  message: string;
}

/**
 * The accumulator an export writes into, replacing the bare `string[]` that
 * `runExport` threaded before this feature.
 */
export interface WarningCollector {
  /** A reusable sink recording warnings against one note's vault path. */
  forNote(path: string): (message: string) => void;
  /** A reusable sink for warnings that belong to the book, not to any note. */
  forBook(): (message: string) => void;
  /**
   * Every message, in collection order.
   *
   * INVARIANT (FR-020): this MUST be exactly what pushing the same strings
   * onto a `string[]` would have produced — no sorting, no de-duplication, no
   * rewording. `console.warn` and `summarizeWarnings` are fed from it, and
   * `scripts/local-export.ts` parses those console lines, so a change here
   * silently breaks an existing tool.
   */
  messages(): string[];
  /** The same messages, same order, each paired with its scope. */
  scoped(): ScopedWarning[];
}

export function createWarningCollector(): WarningCollector {
  const recorded: ScopedWarning[] = [];
  const sink =
    (scope: string | null) =>
    (message: string): void => {
      recorded.push({ scope, message });
    };
  return {
    forNote: (path: string) => sink(path),
    forBook: () => sink(null),
    // Copies, not the live arrays: a caller that mutated what it got back
    // would corrupt console output and the report at once.
    messages: () => recorded.map((w) => w.message),
    scoped: () => recorded.map((w) => ({ ...w })),
  };
}

/** One heading in the report: a note's warnings, or the book's. */
export interface WarningGroup {
  kind: "note" | "book";
  /** The note's vault path; null when `kind` is "book". */
  notePath: string | null;
  messages: string[];
}

/** What one finished export produced. Immutable once built. */
export interface ExportReport {
  title: string;
  total: number;
  /** Note groups in book chapter order, then the book group last. */
  groups: WarningGroup[];
}

/**
 * Groups an export's warnings into the report a reader sees.
 *
 * @param title book title, copied through verbatim (FR-008)
 * @param chapterOrder note paths in the order the book presents them (FR-010)
 * @param warnings collection-ordered warnings from the collector
 */
export function buildReport(
  title: string,
  chapterOrder: readonly string[],
  warnings: readonly ScopedWarning[]
): ExportReport {
  const byNote = new Map<string, string[]>();
  const bookMessages: string[] = [];
  // First-appearance order, used only for scopes the chapter order does not
  // know about. Insertion order of a Map gives it for free.
  for (const { scope, message } of warnings) {
    if (scope === null) {
      bookMessages.push(message);
      continue;
    }
    const existing = byNote.get(scope);
    if (existing) existing.push(message);
    else byNote.set(scope, [message]);
  }

  // Chapter order first, then anything left over. A scope absent from
  // chapterOrder should not occur, but dropping its warnings to keep the
  // ordering tidy would violate FR-005 — so it sorts last rather than away.
  const ordered = chapterOrder.filter((p) => byNote.has(p));
  const leftover = [...byNote.keys()].filter((p) => !ordered.includes(p));

  const groups: WarningGroup[] = [...ordered, ...leftover].map((notePath) => ({
    kind: "note" as const,
    notePath,
    messages: byNote.get(notePath) ?? [],
  }));
  if (bookMessages.length > 0) {
    groups.push({ kind: "book", notePath: null, messages: bookMessages });
  }

  return { title, total: warnings.length, groups };
}

/** How the book group is labelled wherever the report is shown. */
export const BOOK_GROUP_LABEL = "The book as a whole";

/**
 * Plain-text rendering, for the copy action (FR-022) and for asserting report
 * content without a DOM. Contains no markup — a reader pastes this into an
 * issue or a note.
 */
export function renderReportText(report: ExportReport): string {
  const header = `${report.title} — ${report.total} ${report.total === 1 ? "warning" : "warnings"}`;
  if (report.total === 0) {
    return `${report.title}\n\nThis export produced no warnings.\n`;
  }
  const sections = report.groups.map((g) => {
    const heading = g.kind === "book" ? BOOK_GROUP_LABEL : (g.notePath ?? "");
    const lines = g.messages.map((m) => `  - ${m}`).join("\n");
    return `${heading}:\n${lines}`;
  });
  return `${header}\n\n${sections.join("\n\n")}\n`;
}
