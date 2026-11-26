import { describe, it, expect } from "vitest";
import { planBook, type FolderInput, type NoteInput, type NavPlanNode } from "../src/core/book/book-tree";

// planBook's documented guarantees (book-tree.ts), checked over many random
// folder trees instead of the handful the example-based suite builds by hand:
//   1. `order` holds every note that is not left out exactly once;
//   2. `leftOut` is exactly the left-out notes, and disjoint from `order`;
//   3. a depth-first walk of `nav` yields `order`;
//   4. it is total — any structurally valid tree gives a plan.
// The generator is seeded, so a failure names a seed that replays.

function makeRng(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

const NAMES = [
  "intro",
  "Intro",
  "01_a",
  "02_b",
  "10_c",
  "2_d",
  "book",
  "main",
  "zeta",
  "alpha",
  "ข้อ",
  "a b",
];

function randomFolder(
  rand: (n: number) => number,
  path: string,
  name: string,
  depth: number,
  all: NoteInput[]
): FolderInput {
  const notes: NoteInput[] = [];
  const used = new Set<string>();
  for (let i = rand(5); i > 0; i--) {
    const basename = NAMES[rand(NAMES.length)];
    if (used.has(basename)) continue;
    used.add(basename);
    notes.push({
      path: `${path}/${basename}.md`,
      basename,
      tags: rand(6) === 0 ? ["book", "main"] : [],
      linkTargets: [],
      leftOut: rand(5) === 0,
    });
  }
  const subfolders: FolderInput[] = [];
  if (depth < 3) {
    const subNames = new Set<string>();
    for (let i = rand(3); i > 0; i--) {
      const sub = NAMES[rand(NAMES.length)];
      if (subNames.has(sub)) continue;
      subNames.add(sub);
      subfolders.push(randomFolder(rand, `${path}/${sub}`, sub, depth + 1, all));
    }
  }
  all.push(...notes);
  return { name, path, notes, subfolders };
}

function allFolderNotes(folder: FolderInput): NoteInput[] {
  return [...folder.notes, ...folder.subfolders.flatMap(allFolderNotes)];
}

function walk(nav: NavPlanNode[]): string[] {
  return nav.flatMap((node) =>
    node.kind === "chapter"
      ? [node.path]
      : [...(node.indexPath ? [node.indexPath] : []), ...walk(node.children)]
  );
}

describe("planBook invariants over random trees", () => {
  for (let seed = 1; seed <= 300; seed++) {
    it(`seed ${seed}`, () => {
      const rand = makeRng(seed);
      const root = randomFolder(rand, "book", "book", 0, []);
      const notes = allFolderNotes(root);
      // Links: each note links to a random few notes anywhere in the tree (and sometimes to itself or nowhere).
      for (const note of notes) {
        for (let i = rand(4); i > 0; i--) {
          note.linkTargets.push(
            rand(5) === 0 ? "outside/x.md" : (notes[rand(notes.length)]?.path ?? "none.md")
          );
        }
      }

      const plan = planBook(root);

      const kept = notes.filter((n) => !n.leftOut).map((n) => n.path);
      expect([...plan.order].sort()).toEqual([...kept].sort()); // 1: each kept note exactly once
      expect(new Set(plan.order).size).toBe(plan.order.length);
      expect([...plan.leftOut].sort()).toEqual(
        notes
          .filter((n) => n.leftOut)
          .map((n) => n.path)
          .sort()
      ); // 2
      for (const path of plan.leftOut) expect(plan.order).not.toContain(path);
      // 3: reading the nav depth-first gives the order. A left-out Part index stays on its
      // Part (it names it) but is not a page, so it drops out of the walk.
      const leftOutPaths = new Set(plan.leftOut);
      expect(walk(plan.nav).filter((path) => !leftOutPaths.has(path))).toEqual(plan.order);
    });
  }
});
