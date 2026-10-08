// The scope-planning rules, tested directly (src/core/book/book-plan.ts).
//
// Every rule here used to be reachable only by running a whole export through
// the stubbed plugin (tests/main.test.ts), which is why those tests are the
// slowest in the repo. These are the same rules over plain data: no plugin,
// no TFile, no metadata cache, no Notice.
import { describe, expect, it } from "vitest";
import {
  chapterOrderFallbackWarning,
  degradedFolderPlan,
  legacyChapterOrder,
  normalizeTags,
  orderedLinkTargets,
  planFolderOrder,
  toNavItems,
  type IndexCandidate,
  type OrderedLink,
} from "../src/core/book/book-plan";
import type { FolderInput, NavPlanNode } from "../src/core/book/book-tree";

const note = (basename: string, tags: string[] = []): IndexCandidate => ({ basename, tags });

describe("normalizeTags: frontmatter tags shape (009 Fix 3)", () => {
  it("keeps a genuine array", () => {
    expect(normalizeTags(["book", "main"])).toEqual(["book", "main"]);
  });

  it("rejects a scalar string, so pickIndexNote cannot substring-match it", () => {
    // "handbook mainframe" contains both "book" and "main" as substrings;
    // treating it as tags would elect it as an index note.
    expect(normalizeTags("handbook mainframe")).toEqual([]);
    expect(normalizeTags("book")).toEqual([]);
  });

  it("returns [] for every other frontmatter shape", () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
    expect(normalizeTags({ tag: "book" })).toEqual([]);
  });

  it("keeps an empty array as an empty array", () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

describe("legacyChapterOrder: the pre-009 flat order (research R5)", () => {
  it("puts a tagged index note first, then NN_ by number, then the rest alphabetically", () => {
    const order = legacyChapterOrder(
      [note("Zeta"), note("02_Two"), note("Reader", ["book", "main"]), note("01_One"), note("Alpha")],
      "Reader"
    );

    expect(order.indexBasename).toBe("Reader");
    expect(order.order).toEqual(["Reader", "01_One", "02_Two", "Alpha", "Zeta"]);
  });

  it("falls back to the note named after the folder when nothing is tagged", () => {
    const order = legacyChapterOrder([note("Chapter B"), note("My Book"), note("Chapter A")], "My Book");

    expect(order.indexBasename).toBe("My Book");
    expect(order.order).toEqual(["My Book", "Chapter A", "Chapter B"]);
  });

  it("returns every note as a chapter when there is no index note", () => {
    const order = legacyChapterOrder([note("Chapter B"), note("Chapter A")], "Nowhere");

    expect(order.indexBasename).toBeNull();
    expect(order.order).toEqual(["Chapter A", "Chapter B"]);
  });

  it("never repeats the index note inside the chapters", () => {
    const order = legacyChapterOrder([note("Reader", ["book", "main"]), note("Alpha")], "Reader");

    expect(order.order.filter((name) => name === "Reader")).toHaveLength(1);
  });

  it("orders NN_ prefixes numerically, not as text", () => {
    // Lexicographic order would be 100_Hundred, 10_Ten, 9_Nine — so this
    // expectation can only hold if the prefixes are compared as numbers.
    const order = legacyChapterOrder([note("10_Ten"), note("9_Nine"), note("100_Hundred")], "Nowhere");

    expect(order.order).toEqual(["9_Nine", "10_Ten", "100_Hundred"]);
  });

  it("does not treat a digit prefix without the underscore as numbered", () => {
    // The convention is NN_ — the underscore is part of it. "10 Ten" is an
    // ordinary name, so it sorts alphabetically (and so before "9 Nine").
    const order = legacyChapterOrder([note("10 Ten"), note("9 Nine")], "Nowhere");

    expect(order.order).toEqual(["10 Ten", "9 Nine"]);
  });
});

describe("orderedLinkTargets: index-note link order (research R4, FR-004, FR-005)", () => {
  const link = (path: string, startOffset: number): OrderedLink => ({ path, startOffset });

  it("sorts by document offset, not by the order the cache lists them", () => {
    // The metadata cache does not promise document order, which is exactly why
    // the offsets are read at all.
    const targets = orderedLinkTargets([link("C", 30), link("A", 10), link("B", 20)], (p) => p);

    expect(targets).toEqual(["A", "B", "C"]);
  });

  it("drops a self-link ([[#heading]]) without asking the resolver", () => {
    const asked: string[] = [];
    const targets = orderedLinkTargets([link("", 5), link("Real", 10)], (p) => {
      asked.push(p);
      return p;
    });

    expect(targets).toEqual(["Real"]);
    expect(asked).toEqual(["Real"]);
  });

  it("drops whatever the resolver rejects — a missing note, or a non-Markdown file", () => {
    const targets = orderedLinkTargets([link("Note", 1), link("pic.png", 2), link("Ghost", 3)], (p) =>
      p === "Note" ? "folder/Note.md" : null
    );

    expect(targets).toEqual(["folder/Note.md"]);
  });

  it("keeps a repeated link repeated — the planner is what dedupes", () => {
    const targets = orderedLinkTargets([link("A", 1), link("A", 2)], (p) => `${p}.md`);

    expect(targets).toEqual(["A.md", "A.md"]);
  });

  it("returns [] for a note with no links", () => {
    expect(orderedLinkTargets([], () => "never")).toEqual([]);
  });
});

describe("toNavItems: position-keyed nav, parts only (FR-013, research R2)", () => {
  const position = new Map([
    ["Book.md", 0],
    ["Part I/A.md", 1],
    ["Part I/B.md", 2],
  ]);
  const titleForNote = (path: string) => `Title of ${path}`;

  it("returns undefined for a flat plan, so a flat folder keeps the flat nav", () => {
    const flat: NavPlanNode[] = [
      { kind: "chapter", path: "Book.md" },
      { kind: "chapter", path: "Part I/A.md" },
    ];

    expect(toNavItems(flat, position, titleForNote)).toBeUndefined();
  });

  it("references top-level chapters by position alongside the Parts", () => {
    const nav: NavPlanNode[] = [
      { kind: "chapter", path: "Book.md" },
      {
        kind: "part",
        folderName: "Part I",
        indexPath: null,
        children: [{ kind: "chapter", path: "Part I/A.md" }],
      },
    ];

    expect(toNavItems(nav, position, titleForNote)).toEqual([
      { kind: "chapter", chapter: 0 },
      { kind: "part", title: "Part I", indexChapter: null, children: [{ kind: "chapter", chapter: 1 }] },
    ]);
  });

  it("titles a Part with its index note's title, and gives it that chapter", () => {
    const nav: NavPlanNode[] = [
      {
        kind: "part",
        folderName: "Part I",
        indexPath: "Part I/A.md",
        children: [{ kind: "chapter", path: "Part I/B.md" }],
      },
    ];

    expect(toNavItems(nav, position, titleForNote)).toEqual([
      {
        kind: "part",
        title: "Title of Part I/A.md",
        indexChapter: 1,
        children: [{ kind: "chapter", chapter: 2 }],
      },
    ]);
  });

  it("falls back to the folder name and no entry when a Part has no index note", () => {
    const nav: NavPlanNode[] = [
      {
        kind: "part",
        folderName: "Part II",
        indexPath: null,
        children: [{ kind: "chapter", path: "Part I/A.md" }],
      },
    ];

    expect(toNavItems(nav, position, titleForNote)).toEqual([
      {
        kind: "part",
        title: "Part II",
        indexChapter: null,
        children: [{ kind: "chapter", chapter: 1 }],
      },
    ]);
  });

  it("maps nested Parts recursively", () => {
    const nav: NavPlanNode[] = [
      {
        kind: "part",
        folderName: "Outer",
        indexPath: null,
        children: [
          {
            kind: "part",
            folderName: "Inner",
            indexPath: "Book.md",
            children: [{ kind: "chapter", path: "Part I/B.md" }],
          },
        ],
      },
    ];

    expect(toNavItems(nav, position, titleForNote)).toEqual([
      {
        kind: "part",
        title: "Outer",
        indexChapter: null,
        children: [
          {
            kind: "part",
            title: "Title of Book.md",
            indexChapter: 0,
            children: [{ kind: "chapter", chapter: 2 }],
          },
        ],
      },
    ]);
  });
});

describe("planFolderOrder: plan, or degrade with a warning (Constitution II / FR-016)", () => {
  const input = (notes: { basename: string; tags?: string[] }[]): FolderInput => ({
    name: "Book",
    path: "Book",
    notes: notes.map((n) => ({
      path: `Book/${n.basename}.md`,
      basename: n.basename,
      tags: n.tags ?? [],
      linkTargets: [],
    })),
    subfolders: [],
  });

  it("returns the planner's order and no warnings for a valid folder", () => {
    const plan = planFolderOrder(input([{ basename: "B" }, { basename: "A" }]), ["fallback"], () => "t");

    expect(plan.warnings).toEqual([]);
    expect(plan.order).toEqual(["Book/A.md", "Book/B.md"]);
    expect(plan.nav).toBeUndefined(); // flat folder: no Parts
  });

  it("degrades to the fallback order with a warning when planning throws", () => {
    // planBook is total for structurally valid input, so this guard is for the
    // unexpected — here, a cache shape that is not what the types promise (a
    // tagged index note whose links are not a list). Without the guard that
    // throw would cost the whole export.
    const broken = input([{ basename: "Reader", tags: ["book", "main"] }]);
    broken.notes[0].linkTargets = 5 as unknown as string[];

    const plan = planFolderOrder(broken, ["Book/legacy.md"], () => "t");

    expect(plan.order).toEqual(["Book/legacy.md"]);
    expect(plan.nav).toBeUndefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("chapter ordering fell back to filename order");
  });
});

describe("degradedFolderPlan and its warning text", () => {
  it("keeps the pre-009 warning wording, which scripts/local-export.ts parses", () => {
    expect(chapterOrderFallbackWarning(new Error("boom"))).toBe(
      "chapter ordering fell back to filename order: boom"
    );
  });

  it("returns the fallback order, no nav, and that one warning", () => {
    const plan = degradedFolderPlan(["a.md", "b.md"], new Error("boom"));

    expect(plan).toEqual({
      order: ["a.md", "b.md"],
      nav: undefined,
      warnings: ["chapter ordering fell back to filename order: boom"],
    });
  });

  it("reads a thrown non-Error the same way the export path does", () => {
    expect(chapterOrderFallbackWarning("plain string")).toBe(
      "chapter ordering fell back to filename order: plain string"
    );
  });
});
