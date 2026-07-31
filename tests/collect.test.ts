import { describe, it, expect } from "vitest";
import { orderChapters, pickIndexNote, bfsLinked } from "../src/collect";

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

describe("bfsLinked", () => {
  const links = {
    "a.md": { "b.md": 1, "c.md": 2, "img.png": 1 },
    "b.md": { "d.md": 1, "a.md": 1 },
    "c.md": { "e.md": 1 },
  };
  it("depth 1 returns start plus direct md links, sorted per level", () => {
    expect(bfsLinked(links, "a.md", 1)).toEqual(["a.md", "b.md", "c.md"]);
  });
  it("depth 2 adds the next ring without revisiting", () => {
    expect(bfsLinked(links, "a.md", 2)).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
  });
  it("depth 0 or missing start yields just the start", () => {
    expect(bfsLinked(links, "z.md", 3)).toEqual(["z.md"]);
    expect(bfsLinked(links, "a.md", 0)).toEqual(["a.md"]);
  });

  it("sorts a ring whose links appear in non-alphabetical key order (comparator's a > b branch)", () => {
    // Every ring in the describe block's shared `links` fixture happens to
    // already be alphabetical before its sort, which a sort may special-case
    // and never actually compare a pair needing a swap. "start"'s own links
    // are declared zebra-before-apple, forcing a real out-of-order compare.
    const reversedLinks = { "start.md": { "zebra.md": 1, "apple.md": 1 } };
    expect(bfsLinked(reversedLinks, "start.md", 1)).toEqual(["start.md", "apple.md", "zebra.md"]);
  });
});
