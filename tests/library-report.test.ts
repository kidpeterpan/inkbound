// 016-export-all-books: the texts a run over the whole library shows
// (specs/016-export-all-books/contracts/library-export.md).
import { describe, expect, it } from "vitest";
import {
  chapterText,
  exportedOutcome,
  failedOutcome,
  isCleanRun,
  librarySummary,
  listRow,
  outcomeLine,
  progressText,
  pushingText,
  renderLibraryReportText,
  skippedOutcome,
  type BookOutcome,
} from "../src/core/delivery/library-report";

describe("the run's progress line", () => {
  const dune = { index: 3, total: 12, title: "Dune" };

  it("names the book and its place in the run", () => {
    expect(progressText(dune)).toBe("Exporting book 3 of 12: Dune");
  });

  it("adds the chapter being rendered, so a long book does not look frozen", () => {
    expect(chapterText(dune, 4, 10)).toBe("Exporting book 3 of 12: Dune — chapter 4/10…");
  });

  it("says when the book is being pushed", () => {
    expect(pushingText(dune)).toBe("Exporting book 3 of 12: Dune — Pushing to Boox…");
  });
});

describe("a row of the list of books", () => {
  it("names the book and its folder", () => {
    expect(listRow({ title: "Dune", folderPath: "Library/Fiction/Dune" })).toBe(
      "Dune — Library/Fiction/Dune"
    );
  });
});

describe("what happened to one book", () => {
  const book = { folderPath: "Library/Dune", title: "Dune" };
  const report = (groups: { messages: string[] }[]) => ({
    title: "Dune",
    total: groups.reduce((n, g) => n + g.messages.length, 0),
    groups: groups.map((g) => ({ kind: "note" as const, notePath: "x.md", messages: g.messages })),
  });

  it("is exported when its report has no warnings", () => {
    expect(exportedOutcome(book, report([]))).toEqual({
      ...book,
      outcome: "exported",
      messages: [],
      reason: null,
    });
  });

  it("is exported with warnings, flattened in report order", () => {
    expect(exportedOutcome(book, report([{ messages: ["a", "b"] }, { messages: ["c"] }]))).toEqual({
      ...book,
      outcome: "warnings",
      messages: ["a", "b", "c"],
      reason: null,
    });
  });

  it("is exported when the book was written but its report could not be built", () => {
    expect(exportedOutcome(book, null).outcome).toBe("exported");
  });

  it("is failed, with the reason", () => {
    expect(failedOutcome(book, "disk full")).toEqual({
      ...book,
      outcome: "failed",
      messages: [],
      reason: "disk full",
    });
  });

  it("is skipped, naming the folder whose book has the same file name", () => {
    expect(skippedOutcome(book, "Old/Dune")).toEqual({
      ...book,
      outcome: "skipped",
      messages: [],
      reason: "same file name as Old/Dune",
    });
  });
});

describe("a skipped row of the list", () => {
  it("says it will be skipped and why", () => {
    expect(listRow({ title: "tidal notes", folderPath: "Old/Tidal", clashesWith: "Library/Tidal" })).toBe(
      "tidal notes — Old/Tidal (skipped: same file name as Library/Tidal)"
    );
  });
});

// US4: the summary notice and the report of the whole run.
const outcome = (outcome: BookOutcome["outcome"], extra: Partial<BookOutcome> = {}): BookOutcome => ({
  folderPath: "F",
  title: "T",
  outcome,
  messages: [],
  reason: null,
  ...extra,
});
const runOf = (...kinds: BookOutcome["outcome"][]) => ({ books: kinds.map((kind) => outcome(kind)) });

describe("librarySummary: one line for the whole run", () => {
  it.each([
    ["one clean book", runOf("exported"), "1 book exported"],
    ["three clean books", runOf("exported", "exported", "exported"), "3 books exported"],
    [
      "warnings and a failure",
      runOf("exported", "exported", "exported", "warnings", "failed"),
      "5 books: 3 exported, 1 with warnings, 1 failed",
    ],
    ["a skipped book", runOf("exported", "skipped", "exported"), "3 books: 2 exported, 1 skipped"],
    ["a single failure", runOf("failed"), "1 book: 1 failed"],
    [
      "every kind, listed in a fixed order",
      runOf("warnings", "skipped", "failed", "exported"),
      "4 books: 1 exported, 1 with warnings, 1 skipped, 1 failed",
    ],
  ])("%s → %s", (_label, report, text) => {
    expect(librarySummary(report)).toBe(text);
  });
});

describe("isCleanRun", () => {
  it("is true only when every book was exported without a warning", () => {
    expect(isCleanRun(runOf("exported", "exported"))).toBe(true);
    expect(isCleanRun(runOf("exported", "warnings"))).toBe(false);
    expect(isCleanRun(runOf("skipped"))).toBe(false);
    expect(isCleanRun(runOf("failed"))).toBe(false);
  });
});

describe("outcomeLine: what happened to one book, in words", () => {
  it.each([
    ["exported", outcome("exported"), "Exported"],
    ["one warning", outcome("warnings", { messages: ["a"] }), "Exported with 1 warning"],
    ["two warnings", outcome("warnings", { messages: ["a", "b"] }), "Exported with 2 warnings"],
    [
      "skipped",
      outcome("skipped", { reason: "same file name as Library/Tide" }),
      "Skipped: same file name as Library/Tide",
    ],
    ["failed", outcome("failed", { reason: "disk full" }), "Failed: disk full"],
  ])("%s → %s", (_label, book, text) => {
    expect(outcomeLine(book)).toBe(text);
  });
});

describe("renderLibraryReportText: the copy of the run report", () => {
  it("gives the summary, then every book with its outcome and warnings, as plain text", () => {
    const report = {
      books: [
        outcome("exported", { title: "Dune", folderPath: "Library/Dune" }),
        outcome("warnings", {
          title: "Tide",
          folderPath: "Library/Tide",
          messages: ["missing image: a.png"],
        }),
      ],
    };

    expect(renderLibraryReportText(report)).toBe(
      [
        "Export all books",
        "2 books: 1 exported, 1 with warnings",
        "",
        "Dune — Library/Dune",
        "Exported",
        "",
        "Tide — Library/Tide",
        "Exported with 1 warning",
        "  - missing image: a.png",
        "",
      ].join("\n")
    );
  });
});
