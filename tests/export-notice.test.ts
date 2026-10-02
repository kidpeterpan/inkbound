// The export completion notice (src/adapters/export-notice.ts) — 010-export-report.
//
// This became testable the moment it left main.ts's plugin class: reaching it
// used to require a whole export, and the invariant it carries is worth pinning
// directly — a report that fails to build must never turn a book that IS on
// disk into a "the export failed" message (FR-019, Constitution II).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODALS, NOTICES, NOTICE_ELS } from "./fixtures/obsidian-stub";
import { showExportNotice } from "../src/adapters/export-notice";
import * as reportModule from "../src/core/report";
import type { ScopedWarning } from "../src/core/report";

const SAVED_TEXT = "EPUB saved to /books/my-book.epub";
const BOOK = { bookTitle: "My Book", chapterPaths: ["a.md", "b.md"] };
/** Only `app` is handed on to the modal, which the stub records rather than renders. */
const APP = {} as never;

beforeEach(() => {
  NOTICES.length = 0;
  NOTICE_ELS.length = 0;
  MODALS.length = 0;
  vi.restoreAllMocks();
});

describe("showExportNotice", () => {
  it("shows the plain notice, unchanged, when the export produced no warnings", () => {
    const result = showExportNotice(APP, SAVED_TEXT, { ...BOOK, warnings: [] });

    expect(NOTICES).toEqual([SAVED_TEXT]);
    expect(result?.total).toBe(0);
  });

  it("builds a tappable notice that opens the report when there are warnings", () => {
    const warnings: ScopedWarning[] = [{ scope: "a.md", message: "missing image" }];

    const result = showExportNotice(APP, SAVED_TEXT, { ...BOOK, warnings });

    expect(result?.total).toBe(1);
    const body = NOTICE_ELS[0].querySelector("div");
    expect(body, "the notice body the reader taps").not.toBeNull();

    body!.click();
    expect(MODALS, "the report the tap opens").toHaveLength(1);
  });

  it("still tells the reader the book was saved when the report cannot be built", () => {
    const reportedError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(reportModule, "buildReport").mockImplementation(() => {
      throw new Error("report exploded");
    });

    const result = showExportNotice(APP, SAVED_TEXT, { ...BOOK, warnings: [] });

    expect(result).toBeNull();
    expect(NOTICES).toEqual([SAVED_TEXT]);
    expect(reportedError).toHaveBeenCalled();
  });
});
