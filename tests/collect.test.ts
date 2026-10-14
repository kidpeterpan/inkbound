import { describe, it, expect } from "vitest";
import {
  orderChapters,
  orderByName,
  pickIndexNote,
  walkLinkedNotes,
  hasBookIndexTags,
} from "../src/core/book/collect";

describe("orderChapters", () => {
  it("sorts NN_ prefixes numerically, then others alphabetically", () => {
    expect(orderChapters(["10_ten", "02_two", "appendix", "01_one", "afterword"])).toEqual([
      "01_one",
      "02_two",
      "10_ten",
      "afterword",
      "appendix",
    ]);
  });

  it("swaps a reversed pair of non-numbered basenames into alphabetical order", () => {
    // Exercises the comparator's a > b branch: with input already alphabetical
    // (as in the case above), a sort may never need to compare a pair where
    // the first arg sorts after the second.
    expect(orderChapters(["zebra", "apple"])).toEqual(["apple", "zebra"]);
  });

  it("keeps a duplicate non-numbered basename's relative position (comparator's equal branch)", () => {
    // orderChapters doesn't dedupe its input, so two identical basenames are
    // a real (if unusual) input, exercising the comparator's a === b -> 0
    // branch.
    expect(orderChapters(["repeat", "repeat", "apple"])).toEqual(["apple", "repeat", "repeat"]);
  });
});

describe("pickIndexNote", () => {
  it("prefers the note tagged book+main", () => {
    const c = [
      { basename: "01_intro", tags: [] },
      { basename: "my_book", tags: ["book", "main"] },
    ];
    expect(pickIndexNote(c, "other_name")).toBe("my_book");
  });
  it("falls back to basename === folder name", () => {
    const c = [
      { basename: "lgwt", tags: [] },
      { basename: "01_intro", tags: [] },
    ];
    expect(pickIndexNote(c, "lgwt")).toBe("lgwt");
  });
  it("returns null when nothing matches", () => {
    expect(pickIndexNote([{ basename: "01_x", tags: [] }], "folder")).toBeNull();
  });
});

// 017-note-exclusion: the link walk, with the marker in it. Renamed from
// `bfsLinked` because it now answers two questions at once — which notes are in
// the book, and which the marker kept out — and because a walk that cannot pass
// through a left-out note is a different traversal, not a filter applied
// afterwards (research R5). The old expectations are reused verbatim as the
// `chapters` expectations: a book with no marker takes exactly the path it did
// before (FR-011).
describe("walkLinkedNotes", () => {
  const links = {
    "a.md": { "b.md": 1, "c.md": 2, "img.png": 1 },
    "b.md": { "d.md": 1, "a.md": 1 },
    "c.md": { "e.md": 1 },
  };
  const nothingLeftOut = () => false;

  it("depth 1 returns start plus direct md links, sorted per level", () => {
    expect(walkLinkedNotes(links, "a.md", 1, nothingLeftOut).chapters).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("depth 2 adds the next ring without revisiting", () => {
    expect(walkLinkedNotes(links, "a.md", 2, nothingLeftOut).chapters).toEqual([
      "a.md",
      "b.md",
      "c.md",
      "d.md",
      "e.md",
    ]);
  });

  it("depth 0 or missing start yields just the start", () => {
    expect(walkLinkedNotes(links, "z.md", 3, nothingLeftOut).chapters).toEqual(["z.md"]);
    expect(walkLinkedNotes(links, "a.md", 0, nothingLeftOut).chapters).toEqual(["a.md"]);
  });

  it("sorts a ring whose links appear in non-alphabetical key order (comparator's a > b branch)", () => {
    // Every ring in the describe block's shared `links` fixture happens to
    // already be alphabetical before its sort, which a sort may special-case
    // and never actually compare a pair needing a swap. "start"'s own links
    // are declared zebra-before-apple, forcing a real out-of-order compare.
    const reversedLinks = { "start.md": { "zebra.md": 1, "apple.md": 1 } };
    expect(walkLinkedNotes(reversedLinks, "start.md", 1, nothingLeftOut).chapters).toEqual([
      "start.md",
      "apple.md",
      "zebra.md",
    ]);
  });

  it("leaves a marked target out of the chapters and records it once", () => {
    const marked = new Set(["c.md"]);
    const walk = walkLinkedNotes(links, "a.md", 1, (p) => marked.has(p));

    expect(walk.chapters).toEqual(["a.md", "b.md"]);
    expect(walk.leftOut).toEqual(["c.md"]);
  });

  it("does not walk THROUGH a marked note: a note only it links to is not reached", () => {
    // e.md is linked only by c.md, which is marked — so e.md is in neither list.
    const walk = walkLinkedNotes(links, "a.md", 2, (p) => p === "c.md");

    expect(walk.chapters).toEqual(["a.md", "b.md", "d.md"]);
    expect(walk.leftOut).toEqual(["c.md"]);
  });

  it("records a marked note once even when two notes link to it", () => {
    const twoLinks = {
      "start.md": { "x.md": 1, "y.md": 2 },
      "x.md": { "gone.md": 1 },
      "y.md": { "gone.md": 1 },
    };
    const walk = walkLinkedNotes(twoLinks, "start.md", 2, (p) => p === "gone.md");

    expect(walk.chapters).toEqual(["start.md", "x.md", "y.md"]);
    expect(walk.leftOut).toEqual(["gone.md"]);
  });

  it("keeps a marked START note, and still follows its links (FR-005)", () => {
    // The note the reader asked for by name is always in the book, marker or
    // not — and the walk still goes through it, or "export this note + its
    // links" would mean nothing.
    const walk = walkLinkedNotes(links, "a.md", 1, (p) => p === "a.md");

    expect(walk.chapters).toEqual(["a.md", "b.md", "c.md"]);
    expect(walk.leftOut).toEqual([]);
  });

  it("ignores a non-Markdown target, as the walk always has (pin)", () => {
    expect(walkLinkedNotes(links, "a.md", 1, nothingLeftOut).chapters).not.toContain("img.png");
  });

  it("walks exactly what it walked before when nothing is marked (pin, FR-011)", () => {
    for (const depth of [0, 1, 2, 3]) {
      expect(walkLinkedNotes(links, "a.md", depth, nothingLeftOut)).toEqual({
        chapters: bfsLinkedExpectation(links, "a.md", depth),
        leftOut: [],
      });
    }
  });
});

/** The pre-017 walk, kept here as the expectation the new one must match: the
 *  same two-level loop, written the way this file used to assert it. */
function bfsLinkedExpectation(
  links: Record<string, Record<string, number>>,
  start: string,
  depth: number
): string[] {
  const seen = new Set<string>([start]);
  const out: string[] = [start];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of Object.keys(links[node] ?? {})) {
        if (!target.endsWith(".md") || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push(...next);
    frontier = next;
  }
  return out;
}

// 009-index-order-parts (research R6): the same rule as orderChapters, over
// items that carry a name — so unlinked notes and unlinked subfolders can be
// ordered together (FR-012) without duplicating the numeric-prefix logic.
describe("orderByName", () => {
  const byName = (names: string[]) =>
    orderByName(
      names.map((n) => ({ n })),
      (x) => x.n
    ).map((x) => x.n);

  it("matches orderChapters exactly for plain strings", () => {
    const input = ["zeta", "10_c", "Alpha", "2_a", "beta", "1_x"];
    expect(byName(input)).toEqual(orderChapters(input));
    expect(orderByName(input, (s) => s)).toEqual(orderChapters(input));
  });

  it("puts numeric NN_ prefixes first ascending, then the rest by plain string comparison", () => {
    expect(byName(["b", "10_c", "A", "2_a"])).toEqual(["2_a", "10_c", "A", "b"]);
  });

  it("is stable for equal names, so notes listed before folders stay before them", () => {
    const items = [
      { n: "ch1", kind: "note" },
      { n: "ch1", kind: "folder" },
      { n: "1_intro", kind: "folder" },
      { n: "1_intro", kind: "note" },
    ];
    expect(orderByName(items, (x) => x.n).map((x) => x.kind)).toEqual(["folder", "note", "note", "folder"]);
  });
});

// 016-export-all-books: the tag half of pickIndexNote, shared with the rule
// that decides which folders are books when the whole library is exported.
describe("hasBookIndexTags", () => {
  it.each([[["book", "main"]], [["main", "x", "book"]]])("is true when both tags are present: %j", (tags) => {
    expect(hasBookIndexTags(tags)).toBe(true);
  });

  it.each([[["book"]], [["main"]], [[]], [["Book", "main"]]])("is false otherwise: %j", (tags) => {
    expect(hasBookIndexTags(tags)).toBe(false);
  });
});
