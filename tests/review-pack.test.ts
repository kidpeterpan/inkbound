// The review pack's diff logic (scripts/lib/review-pack.ts).
//
// The wording is tested, not just the arithmetic: the whole point of the pack
// is that a reviewer can tell WITHOUT judgment whether the manual device pass
// has anything new to look at. A clean run must say so outright, and a dirty
// one must name the entries to check.
import { describe, expect, it } from "vitest";
import {
  diffBook,
  diffBooks,
  fixtureHeader,
  isClean,
  reviewLines,
  type Fingerprints,
} from "../scripts/lib/review-pack";

const book = (over: Fingerprints = {}): Fingerprints => ({
  "OEBPS/text/chapter_001.xhtml": "aaa",
  "OEBPS/package.opf": "bbb",
  ...over,
});

describe("diffBook", () => {
  it("reports nothing for identical fingerprints", () => {
    expect(diffBook("Book", book(), book())).toEqual({
      book: "Book",
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("names a changed entry", () => {
    const diff = diffBook("Book", book(), book({ "OEBPS/text/chapter_001.xhtml": "zzz" }));

    expect(diff.changed).toEqual(["OEBPS/text/chapter_001.xhtml"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("tells an added entry from a removed one", () => {
    const diff = diffBook(
      "Book",
      book({ "OEBPS/images/old.png": "old" }),
      book({ "OEBPS/images/new.png": "new" })
    );

    expect(diff.added).toEqual(["OEBPS/images/new.png"]);
    expect(diff.removed).toEqual(["OEBPS/images/old.png"]);
  });

  it("sorts every list, so two runs of the same diff read identically", () => {
    const baseline: Fingerprints = { b: "1", a: "1", d: "1", c: "1" };
    const current: Fingerprints = {};

    expect(diffBook("Book", baseline, current).removed).toEqual(["a", "b", "c", "d"]);
  });

  it("treats an empty baseline as all-added (a freshly recorded book)", () => {
    expect(diffBook("Book", {}, book()).added).toEqual(["OEBPS/package.opf", "OEBPS/text/chapter_001.xhtml"]);
  });
});

describe("diffBooks", () => {
  it("covers books that only one side knows about", () => {
    const diffs = diffBooks({ Book: book() }, { Footnotes: book() });

    expect(diffs.map((d) => d.book)).toEqual(["Book", "Footnotes"]);
    expect(diffs[0].removed).toHaveLength(2);
    expect(diffs[1].added).toHaveLength(2);
  });

  it("is clean when every book matches", () => {
    expect(diffBooks({ Book: book() }, { Book: book() }).every(isClean)).toBe(true);
  });

  it("is not clean when any single entry moved", () => {
    const diffs = diffBooks({ Book: book() }, { Book: book({ "OEBPS/package.opf": "different" }) });

    expect(diffs.some(isClean)).toBe(false);
  });
});

describe("fixtureHeader", () => {
  it("reads the version and capture date", () => {
    expect(fixtureHeader({ obsidianVersion: "1.13.7", capturedAt: "2026-09-29" })).toEqual({
      obsidianVersion: "1.13.7",
      capturedAt: "2026-09-29",
    });
  });

  it("answers null for a fixture that predates a field, or has junk", () => {
    expect(fixtureHeader({})).toEqual({ obsidianVersion: null, capturedAt: null });
    expect(fixtureHeader({ obsidianVersion: 42, capturedAt: "   " })).toEqual({
      obsidianVersion: null,
      capturedAt: null,
    });
    expect(fixtureHeader(null)).toEqual({ obsidianVersion: null, capturedAt: null });
  });
});

describe("reviewLines", () => {
  const fixture = { obsidianVersion: "1.13.7", capturedAt: "2026-09-29" };

  it("says outright that a clean pack has nothing new to look at", () => {
    const text = reviewLines([diffBook("Book", book(), book())], fixture).join("\n");

    expect(text).toContain("Nothing changed in the fixture books");
    expect(text).toContain("nothing NEW for the device pass");
  });

  it("names the changed entries and says what they are for", () => {
    const text = reviewLines(
      [diffBook("Book", book(), book({ "OEBPS/text/chapter_001.xhtml": "zzz" }))],
      fixture
    ).join("\n");

    expect(text).toContain("device-check them");
    expect(text).toContain("changed: OEBPS/text/chapter_001.xhtml");
    expect(text).toContain("manual pass in real Obsidian");
  });

  it("lists added and removed entries distinctly", () => {
    const text = reviewLines(
      [diffBook("Book", { keep: "1", gone: "1" }, { keep: "1", fresh: "2" })],
      fixture
    ).join("\n");

    expect(text).toContain("added:   fresh");
    expect(text).toContain("removed: gone");
  });

  it("always says which Obsidian the fixtures came from, and how to check for drift", () => {
    const text = reviewLines([], fixture).join("\n");

    expect(text).toContain("Obsidian 1.13.7");
    expect(text).toContain("2026-09-29");
    expect(text).toContain("npm run check-obsidian-drift");
  });

  it("admits an unknown fixture version instead of inventing one", () => {
    const text = reviewLines([], { obsidianVersion: null, capturedAt: null }).join("\n");

    expect(text).toContain("Obsidian unknown");
    expect(text).toContain("an unknown date");
  });
});
