// 016-export-all-books: which folders are books when the whole library is
// exported (spec FR-002, research R1/R2), and the order and file-name clashes
// of a run (FR-004, FR-006, research R3).
import { describe, expect, it } from "vitest";
import { findBookFolders, planLibraryRun, type LibraryFolder } from "../src/core/book/library";

const folder = (path: string, hasBookIndex: boolean, subfolders: LibraryFolder[] = []): LibraryFolder => ({
  path,
  hasBookIndex,
  subfolders,
});

describe("findBookFolders: which folders are books", () => {
  it("never counts the vault's top-level folder, even with a tagged note in it", () => {
    expect(findBookFolders(folder("", true, [folder("Dune", true)]))).toEqual(["Dune"]);
  });

  it("finds books at any depth below folders that are not books", () => {
    const root = folder("", false, [
      folder("Solo", true),
      folder("Library", false, [folder("Library/Fiction", false, [folder("Library/Fiction/Dune", true)])]),
    ]);

    expect(findBookFolders(root)).toEqual(["Library/Fiction/Dune", "Solo"]);
  });

  it("treats a tagged folder inside a book as part of that book, not a book of its own", () => {
    const root = folder("", false, [
      folder("Book", true, [folder("Book/Part", true, [folder("Book/Part/Deep", true)])]),
    ]);

    expect(findBookFolders(root)).toEqual(["Book"]);
  });

  it("finds nothing in folders without a tagged index note", () => {
    expect(findBookFolders(folder("", false, [folder("Notes", false), folder("Misc", false)]))).toEqual([]);
  });

  it("orders books by plain string comparison of their paths, every time", () => {
    const root = folder("", false, [
      folder("Library", false, [folder("Library/a", true), folder("Library/B", true)]),
    ]);

    expect(findBookFolders(root)).toEqual(["Library/B", "Library/a"]);
    expect(findBookFolders(root)).toEqual(findBookFolders(root));
  });

  it("finds nothing in an empty vault", () => {
    expect(findBookFolders(folder("", false))).toEqual([]);
  });
});

describe("planLibraryRun: the run's order and file-name clashes (FR-006)", () => {
  const book = (folderPath: string, title: string) => ({ folderPath, title });

  it("exports every book with a file name of its own, in the order given", () => {
    const plan = planLibraryRun([book("A", "Dune"), book("B", "Tide")]);

    expect(plan.toExport.map((b) => b.folderPath)).toEqual(["A", "B"]);
    expect(plan.skipped).toEqual([]);
  });

  it("compares file names, not titles: titles differing only in case clash", () => {
    const plan = planLibraryRun([book("Library/A", "Tidal Notes"), book("Old/B", "tidal notes")]);

    expect(plan.toExport.map((b) => b.folderPath)).toEqual(["Library/A"]);
    expect(plan.skipped).toEqual([
      { folderPath: "Old/B", title: "tidal notes", fileName: "tidal_notes", clashesWith: "Library/A" },
    ]);
  });

  it("finds clashes slugify makes out of punctuation", () => {
    const plan = planLibraryRun([book("X", "A: B"), book("Y", "A B")]);

    expect(plan.skipped.map((b) => [b.folderPath, b.fileName, b.clashesWith])).toEqual([["Y", "a_b", "X"]]);
  });

  it("names the first book in every clash, however many there are", () => {
    const plan = planLibraryRun([book("1", "Same"), book("2", "same"), book("3", "SAME")]);

    expect(plan.toExport.map((b) => b.folderPath)).toEqual(["1"]);
    expect(plan.skipped.map((b) => b.clashesWith)).toEqual(["1", "1"]);
  });

  it("gives every book the file name its export will use", () => {
    expect(planLibraryRun([book("A", "Dune: Part One")]).toExport[0].fileName).toBe("dune_part_one");
  });
});
