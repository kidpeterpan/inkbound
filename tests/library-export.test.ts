// 016-export-all-books: the run loop, with a fake way to build a book, so
// what happens to every entry is checked directly (FR-005, analysis U1).
import { beforeEach, describe, expect, it } from "vitest";
import { runLibraryExport, type LibraryEntry } from "../src/adapters/library-export";
import type { ExportOutcome } from "../src/adapters/export-pipeline";
import { NOTICES } from "./fixtures/obsidian-stub";

beforeEach(() => {
  NOTICES.length = 0;
});

const share = (fileName: string) => ({
  fileName,
  bytes: new Uint8Array([1]),
  mimeType: "application/epub+zip" as const,
});

const written = (fileName: string): ExportOutcome => ({
  report: { title: fileName, total: 0, groups: [] },
  shareTarget: share(fileName),
  failure: null,
});

describe("runLibraryExport: every entry gets one outcome, and nothing stops the run", () => {
  it("records success, failure, a throw, a skip and an unplanned book, in order", async () => {
    const built: string[] = [];
    const entries: LibraryEntry<string>[] = [
      { book: { folderPath: "A", title: "A" }, plan: "ok" },
      { book: { folderPath: "B", title: "B" }, plan: "disk" },
      { book: { folderPath: "C", title: "C" }, plan: "throw" },
      { book: { folderPath: "D", title: "D" }, plan: "never-built", clashesWith: "A" },
      { book: { folderPath: "E", title: "E" }, plan: null },
      { book: { folderPath: "F", title: "F" }, plan: "ok-too" },
    ];

    const result = await runLibraryExport(entries, {
      buildBook: async (plan) => {
        built.push(plan);
        if (plan === "disk") return { report: null, shareTarget: null, failure: "disk full" };
        if (plan === "throw") throw new Error("boom");
        return written(plan);
      },
    });

    expect(result.report.books.map((b) => [b.folderPath, b.outcome, b.reason])).toEqual([
      ["A", "exported", null],
      ["B", "failed", "disk full"],
      ["C", "failed", "boom"],
      ["D", "skipped", "same file name as A"],
      ["E", "failed", "Folder has no Markdown notes."],
      ["F", "exported", null],
    ]);
    expect(built).toEqual(["ok", "disk", "throw", "ok-too"]);
  });

  it("hands back the last book it wrote, for the share command", async () => {
    const result = await runLibraryExport(
      [
        { book: { folderPath: "A", title: "A" }, plan: "a" },
        { book: { folderPath: "B", title: "B" }, plan: "b" },
      ],
      { buildBook: async (plan) => written(plan) }
    );

    expect(result.shareTarget?.fileName).toBe("b");
  });
});
