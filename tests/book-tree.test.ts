import { describe, it, expect } from "vitest";
import { planBook, type FolderInput, type NoteInput, type NavPlanNode } from "../src/book-tree";
import { orderChapters } from "../src/collect";

// ── fixture helpers ─────────────────────────────────────────────────────

function note(path: string, opts: { tags?: string[]; links?: string[] } = {}): NoteInput {
  const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return { path, basename, tags: opts.tags ?? [], linkTargets: opts.links ?? [] };
}

function folder(path: string, notes: NoteInput[], subfolders: FolderInput[] = []): FolderInput {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, notes, subfolders };
}

/** Every chapter path reachable from a nav tree, depth-first (the spec's reading order). */
function flatten(nav: NavPlanNode[]): string[] {
  return nav.flatMap((n) =>
    n.kind === "chapter" ? [n.path] : [...(n.indexPath ? [n.indexPath] : []), ...flatten(n.children)]
  );
}

// ── Phase 2: flat folder, no ordering links (contract G1/G2) ────────────

describe("planBook — flat folder without ordering links (G2: today's order)", () => {
  it("no index note: chapters in orderChapters order, flat nav", () => {
    const names = ["b", "10_c", "2_a", "A"];
    const plan = planBook(
      folder(
        "book",
        names.map((n) => note(`book/${n}.md`))
      )
    );
    expect(plan.order).toEqual(orderChapters(names).map((n) => `book/${n}.md`));
    expect(plan.nav).toEqual(plan.order.map((path) => ({ kind: "chapter", path })));
  });

  it("tagged index note comes first, then the rest in orderChapters order", () => {
    const plan = planBook(
      folder("book", [
        note("book/2_b.md"),
        note("book/index_note.md", { tags: ["book", "main"] }),
        note("book/1_a.md"),
        note("book/10_c.md"),
      ])
    );
    expect(plan.order).toEqual(["book/index_note.md", "book/1_a.md", "book/2_b.md", "book/10_c.md"]);
  });

  it("folder-name index note is detected the same way", () => {
    const plan = planBook(
      folder("Reading/grokking", [note("Reading/grokking/zz.md"), note("Reading/grokking/grokking.md")])
    );
    expect(plan.order[0]).toBe("Reading/grokking/grokking.md");
  });

  it("an index note whose links point nowhere useful changes nothing", () => {
    const plan = planBook(
      folder("book", [
        note("book/book.md", { links: ["elsewhere/x.md", "book/book.md", "book/missing.md"] }),
        note("book/b.md"),
        note("book/a.md"),
      ])
    );
    expect(plan.order).toEqual(["book/book.md", "book/a.md", "book/b.md"]);
  });

  it("G1: every note appears exactly once and order equals the depth-first nav", () => {
    const input = folder(
      "book",
      ["x", "3_c", "y", "1_a", "2_b"].map((n) => note(`book/${n}.md`))
    );
    const plan = planBook(input);
    expect([...plan.order].sort()).toEqual(input.notes.map((n) => n.path).sort());
    expect(new Set(plan.order).size).toBe(plan.order.length);
    expect(flatten(plan.nav)).toEqual(plan.order);
  });

  it("a folder holding only its index note yields a one-chapter book", () => {
    const plan = planBook(folder("solo", [note("solo/solo.md")]));
    expect(plan.order).toEqual(["solo/solo.md"]);
  });
});

// ── US1: the index note's link order is the chapter order (FR-001..FR-005) ──

describe("planBook — index link order (US1)", () => {
  const book = (links: string[], extra: NoteInput[] = []) =>
    folder("book", [
      note("book/introduction.md"),
      note("book/recursion.md"),
      note("book/selection_sort.md"),
      note("book/appendix.md"),
      note("book/book.md", { tags: ["book", "main"], links }),
      ...extra,
    ]);

  it("follows the index note's links, then appends unlinked notes in today's order", () => {
    const plan = planBook(book(["book/recursion.md", "book/introduction.md", "book/selection_sort.md"]));
    expect(plan.order).toEqual([
      "book/book.md",
      "book/recursion.md",
      "book/introduction.md",
      "book/selection_sort.md",
      "book/appendix.md",
    ]);
  });

  it("unlinked notes keep the NN_-then-alphabetical rule after the linked ones", () => {
    const plan = planBook(
      book(["book/recursion.md"], [note("book/10_z.md"), note("book/2_y.md"), note("book/Zed.md")])
    );
    expect(plan.order).toEqual([
      "book/book.md",
      "book/recursion.md",
      "book/2_y.md",
      "book/10_z.md",
      "book/Zed.md",
      "book/appendix.md",
      "book/introduction.md",
      "book/selection_sort.md",
    ]);
  });

  it("a note linked twice appears once, at its first link", () => {
    const plan = planBook(book(["book/selection_sort.md", "book/recursion.md", "book/selection_sort.md"]));
    expect(plan.order.slice(0, 3)).toEqual(["book/book.md", "book/selection_sort.md", "book/recursion.md"]);
    expect(plan.order.filter((p) => p === "book/selection_sort.md")).toHaveLength(1);
  });

  it("G3: links outside the folder, to missing notes, or to the index itself are ignored", () => {
    const plan = planBook(
      book(["elsewhere/other.md", "book/nope.md", "book/book.md", "book/recursion.md", "book/assets/pic.png"])
    );
    expect(plan.order).toEqual([
      "book/book.md",
      "book/recursion.md",
      "book/appendix.md",
      "book/introduction.md",
      "book/selection_sort.md",
    ]);
    expect(plan.order).not.toContain("elsewhere/other.md");
  });

  it("an index note with no links leaves today's order untouched (G2)", () => {
    expect(planBook(book([])).order).toEqual([
      "book/book.md",
      "book/appendix.md",
      "book/introduction.md",
      "book/recursion.md",
      "book/selection_sort.md",
    ]);
  });

  it("links from non-index notes never influence the order", () => {
    const plan = planBook(
      folder("book", [
        note("book/book.md", { tags: ["book", "main"] }),
        note("book/a.md", { links: ["book/c.md"] }),
        note("book/c.md", { links: ["book/a.md"] }),
        note("book/b.md"),
      ])
    );
    expect(plan.order).toEqual(["book/book.md", "book/a.md", "book/b.md", "book/c.md"]);
  });
});

// ── US2: subfolders become Parts (FR-006..FR-010, FR-015, FR-018) ────────

describe("planBook — subfolders become Parts (US2)", () => {
  const partI = () => folder("book/Part I", [note("book/Part I/ch1.md"), note("book/Part I/ch2.md")]);
  const partII = () => folder("book/Part II", [note("book/Part II/ch3.md")]);
  const assets = () => folder("book/assets", []);
  const root = (subs: FolderInput[], rootNotes: NoteInput[] = []) =>
    folder(
      "book",
      [note("book/book.md", { tags: ["book", "main"] }), note("book/01_preface.md"), ...rootNotes],
      subs
    );

  it("includes notes at any depth; reading order is the depth-first nav; empty subfolders vanish", () => {
    const plan = planBook(root([partI(), partII(), assets()]));
    expect(plan.order).toEqual([
      "book/book.md",
      "book/01_preface.md",
      "book/Part I/ch1.md",
      "book/Part I/ch2.md",
      "book/Part II/ch3.md",
    ]);
    expect(flatten(plan.nav)).toEqual(plan.order);
    expect(plan.nav).toEqual([
      { kind: "chapter", path: "book/book.md" },
      { kind: "chapter", path: "book/01_preface.md" },
      {
        kind: "part",
        folderName: "Part I",
        indexPath: null,
        children: [
          { kind: "chapter", path: "book/Part I/ch1.md" },
          { kind: "chapter", path: "book/Part I/ch2.md" },
        ],
      },
      {
        kind: "part",
        folderName: "Part II",
        indexPath: null,
        children: [{ kind: "chapter", path: "book/Part II/ch3.md" }],
      },
    ]);
  });

  it("a sub-index (tags or folder-name match) titles the Part, comes first, and its links order the Part", () => {
    const tagged = folder("book/Part I", [
      note("book/Part I/ch1.md"),
      note("book/Part I/ch2.md"),
      note("book/Part I/overview.md", { tags: ["book", "main"], links: ["book/Part I/ch2.md"] }),
    ]);
    const named = folder("book/Part II", [
      note("book/Part II/ch4.md"),
      note("book/Part II/ch3.md"),
      note("book/Part II/Part II.md", { links: ["book/Part II/ch4.md", "book/Part I/ch1.md"] }),
    ]);
    const plan = planBook(root([tagged, named]));
    const parts = plan.nav.filter((n) => n.kind === "part");
    expect(parts).toEqual([
      {
        kind: "part",
        folderName: "Part I",
        indexPath: "book/Part I/overview.md",
        children: [
          { kind: "chapter", path: "book/Part I/ch2.md" },
          { kind: "chapter", path: "book/Part I/ch1.md" },
        ],
      },
      {
        kind: "part",
        folderName: "Part II",
        indexPath: "book/Part II/Part II.md",
        // A sub-index link that points into ANOTHER Part is ignored here.
        children: [
          { kind: "chapter", path: "book/Part II/ch4.md" },
          { kind: "chapter", path: "book/Part II/ch3.md" },
        ],
      },
    ]);
    expect(plan.order).toEqual([
      "book/book.md",
      "book/01_preface.md",
      "book/Part I/overview.md",
      "book/Part I/ch2.md",
      "book/Part I/ch1.md",
      "book/Part II/Part II.md",
      "book/Part II/ch4.md",
      "book/Part II/ch3.md",
    ]);
  });

  it("unlinked notes and subfolders are ordered together by name (NN_ first, then code-point order)", () => {
    const plan = planBook(
      folder(
        "book",
        [note("book/appendix.md"), note("book/02_middle.md"), note("book/Zeta.md")],
        [
          folder("book/01_opening", [note("book/01_opening/a.md")]),
          folder("book/Part X", [note("book/Part X/b.md")]),
        ]
      )
    );
    expect(plan.order).toEqual([
      "book/01_opening/a.md",
      "book/02_middle.md",
      "book/Part X/b.md",
      "book/Zeta.md",
      "book/appendix.md",
    ]);
  });

  it("flat folder: identical to the pre-Parts result", () => {
    const flat = folder("book", [
      note("book/book.md", { tags: ["book", "main"] }),
      note("book/2_b.md"),
      note("book/1_a.md"),
    ]);
    expect(planBook(flat).order).toEqual(["book/book.md", "book/1_a.md", "book/2_b.md"]);
    expect(planBook(flat).nav.every((n) => n.kind === "chapter")).toBe(true);
  });

  it("a subfolder holding only deeper subfolders is still a Part, with only Parts beneath it", () => {
    const plan = planBook(
      folder(
        "book",
        [],
        [folder("book/Outer", [], [folder("book/Outer/Inner", [note("book/Outer/Inner/deep.md")])])]
      )
    );
    expect(plan.nav).toEqual([
      {
        kind: "part",
        folderName: "Outer",
        indexPath: null,
        children: [
          {
            kind: "part",
            folderName: "Inner",
            indexPath: null,
            children: [{ kind: "chapter", path: "book/Outer/Inner/deep.md" }],
          },
        ],
      },
    ]);
    expect(plan.order).toEqual(["book/Outer/Inner/deep.md"]);
  });

  it("G5: same basenames in different folders, and same-named folders at different depths, stay distinct", () => {
    const plan = planBook(
      folder(
        "book",
        [],
        [
          folder("book/A", [note("book/A/notes.md")], [folder("book/A/Intro", [note("book/A/Intro/x.md")])]),
          folder("book/B", [note("book/B/notes.md")], [folder("book/B/Intro", [note("book/B/Intro/x.md")])]),
        ]
      )
    );
    // Within each folder the name rule interleaves note and subfolder:
    // "Intro" < "notes" in code-point order, so the Part comes first.
    expect(plan.order).toEqual([
      "book/A/Intro/x.md",
      "book/A/notes.md",
      "book/B/Intro/x.md",
      "book/B/notes.md",
    ]);
    expect(new Set(plan.order).size).toBe(4);
    const parts = plan.nav.filter((n) => n.kind === "part");
    expect(parts.map((p) => (p.kind === "part" ? p.folderName : ""))).toEqual(["A", "B"]);
  });

  it("three levels of nesting are preserved, not flattened", () => {
    const plan = planBook(
      folder(
        "book",
        [note("book/top.md")],
        [
          folder(
            "book/L1",
            [note("book/L1/a.md")],
            [
              folder(
                "book/L1/L2",
                [note("book/L1/L2/b.md")],
                [folder("book/L1/L2/L3", [note("book/L1/L2/L3/c.md")])]
              ),
            ]
          ),
        ]
      )
    );
    // Uppercase folder names sort before lowercase note names (code-point
    // order), so each level's Part precedes its sibling note.
    expect(plan.order).toEqual(["book/L1/L2/L3/c.md", "book/L1/L2/b.md", "book/L1/a.md", "book/top.md"]);
    const l1 = plan.nav[0];
    expect(l1.kind).toBe("part");
    const l2 = l1.kind === "part" ? l1.children[0] : undefined;
    expect(l2?.kind).toBe("part");
    const l3 = l2?.kind === "part" ? l2.children[0] : undefined;
    expect(l3?.kind).toBe("part");
    expect(flatten(plan.nav)).toEqual(plan.order);
  });
});

// ── US3: the root index places Parts (FR-011, FR-012) ────────────────────

describe("planBook — root index links place whole Parts (US3)", () => {
  const fixture = (rootLinks: string[]) =>
    folder(
      "book",
      [note("book/book.md", { tags: ["book", "main"], links: rootLinks }), note("book/01_preface.md")],
      [
        folder("book/Part I", [note("book/Part I/ch1.md"), note("book/Part I/ch2.md")]),
        folder("book/Part II", [note("book/Part II/ch3.md")]),
      ]
    );

  it("a link to a note inside a subfolder places that whole Part at the link's position", () => {
    const plan = planBook(fixture(["book/Part II/ch3.md", "book/01_preface.md"]));
    expect(plan.order).toEqual([
      "book/book.md",
      "book/Part II/ch3.md",
      "book/01_preface.md",
      "book/Part I/ch1.md",
      "book/Part I/ch2.md",
    ]);
    expect(plan.nav.map((n) => (n.kind === "part" ? `part:${n.folderName}` : n.path))).toEqual([
      "book/book.md",
      "part:Part II",
      "book/01_preface.md",
      "part:Part I",
    ]);
  });

  it("several links into one Part place it once; the Part's internal order is its own, not the root's", () => {
    const plan = planBook(fixture(["book/Part I/ch2.md", "book/Part I/ch1.md", "book/Part I/ch2.md"]));
    const parts = plan.nav.filter((n) => n.kind === "part" && n.folderName === "Part I");
    expect(parts).toHaveLength(1);
    // Part I has no sub-index, so its chapters follow the name rule (ch1, ch2)
    // even though the root linked ch2 first.
    expect(plan.order).toEqual([
      "book/book.md",
      "book/Part I/ch1.md",
      "book/Part I/ch2.md",
      "book/01_preface.md",
      "book/Part II/ch3.md",
    ]);
  });

  it("a root link to a sub-index note places the Part and does not duplicate the note", () => {
    const plan = planBook(
      folder(
        "book",
        [
          note("book/book.md", { tags: ["book", "main"], links: ["book/Part I/Part I.md"] }),
          note("book/00_first.md"),
        ],
        [
          folder("book/Part I", [
            note("book/Part I/Part I.md", { links: ["book/Part I/ch2.md"] }),
            note("book/Part I/ch1.md"),
            note("book/Part I/ch2.md"),
          ]),
        ]
      )
    );
    expect(plan.order).toEqual([
      "book/book.md",
      "book/Part I/Part I.md",
      "book/Part I/ch2.md",
      "book/Part I/ch1.md",
      "book/00_first.md",
    ]);
    expect(plan.order.filter((p) => p === "book/Part I/Part I.md")).toHaveLength(1);
  });

  it("prefix matching is per path segment: a link into `Part II/` never selects `Part I`", () => {
    const plan = planBook(
      folder(
        "book",
        [note("book/book.md", { tags: ["book", "main"], links: ["book/Part II/ch3.md"] })],
        [
          folder("book/Part I", [note("book/Part I/ch1.md")]),
          folder("book/Part II", [note("book/Part II/ch3.md")]),
        ]
      )
    );
    expect(plan.order).toEqual(["book/book.md", "book/Part II/ch3.md", "book/Part I/ch1.md"]);
    const plan2 = planBook(
      folder(
        "book",
        [note("book/book.md", { tags: ["book", "main"], links: ["book/Part I/ch1.md"] })],
        [
          folder("book/Part I", [note("book/Part I/ch1.md")]),
          folder("book/Part IX", [note("book/Part IX/z.md")]),
        ]
      )
    );
    expect(plan2.order).toEqual(["book/book.md", "book/Part I/ch1.md", "book/Part IX/z.md"]);
  });

  it("links deep inside a nested Part select the top-level Part they live under", () => {
    const plan = planBook(
      folder(
        "book",
        [
          note("book/book.md", { tags: ["book", "main"], links: ["book/Outer/Inner/deep.md"] }),
          note("book/01_a.md"),
        ],
        [
          folder(
            "book/Outer",
            [note("book/Outer/o.md")],
            [folder("book/Outer/Inner", [note("book/Outer/Inner/deep.md")])]
          ),
        ]
      )
    );
    expect(plan.order).toEqual([
      "book/book.md",
      "book/Outer/Inner/deep.md",
      "book/Outer/o.md",
      "book/01_a.md",
    ]);
  });
});

// ── FR-004 hardening: a target under a Part must be a NOTE in the tree ────

describe("planBook — non-note or phantom targets under a Part never place it (FR-004)", () => {
  it("an image path or a missing note inside `Part I/` does not select Part I", () => {
    const plan = planBook(
      folder(
        "book",
        [
          note("book/book.md", {
            tags: ["book", "main"],
            links: ["book/Part I/fig.png", "book/Part I/nope.md", "book/01_preface.md"],
          }),
          note("book/01_preface.md"),
        ],
        [folder("book/Part I", [note("book/Part I/ch1.md")])]
      )
    );
    expect(plan.order).toEqual(["book/book.md", "book/01_preface.md", "book/Part I/ch1.md"]);
  });
});
