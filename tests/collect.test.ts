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
});
