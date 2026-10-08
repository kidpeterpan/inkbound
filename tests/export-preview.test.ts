// 014-preview-before-export: the pure model behind the preview window.
//
// buildBookPreview turns a plan the planner already made (chapters in order,
// an optional nested table-of-contents tree keyed by position) into the rows a
// reader sees. The one property that matters is that it ADDS NOTHING of its own
// to the book's shape: read depth-first, the rows must be the chapters in
// reading order. `readingOrder` below states that, and every case that builds
// rows checks it.
import { describe, expect, it } from "vitest";
import {
  buildBookPreview,
  PREVIEW_INTRO,
  PREVIEW_UNKNOWNS,
  type PreviewChapter,
  type PreviewRow,
} from "../src/core/book/export-preview";
import type { CoverPlan } from "../src/core/epub/cover";
import type { NavItem } from "../src/core/epub/epub";

const chapter = (title: string, path: string): PreviewChapter => ({ title, path });
const ch = (n: number): NavItem => ({ kind: "chapter", chapter: n });
const part = (title: string, indexChapter: number | null, children: NavItem[]): NavItem => ({
  kind: "part",
  title,
  indexChapter,
  children,
});

/** The note paths in the order a reader meets them: a Part's own note, then its children. */
function readingOrder(rows: readonly PreviewRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.kind === "chapter") return [row.path];
    return [...(row.path === null ? [] : [row.path]), ...readingOrder(row.children)];
  });
}

const CHAPTERS: PreviewChapter[] = [
  chapter("The Book", "Book/Book.md"),
  chapter("Intro", "Book/Intro.md"),
  chapter("Part One", "Book/Part I/Part I.md"),
  chapter("Ch A", "Book/Part I/a.md"),
  chapter("Ch B", "Book/Part I/Deep/b.md"),
  chapter("Tail", "Book/Tail.md"),
];
const paths = (chapters: readonly PreviewChapter[]) => chapters.map((c) => c.path);

// Index, intro, a Part opened by its own index note that holds a chapter and a
// nested Part named only by its folder, then a closing chapter.
const NESTED: NavItem[] = [ch(0), ch(1), part("Part One", 2, [ch(3), part("Deep", null, [ch(4)])]), ch(5)];

const input = (over: Partial<Parameters<typeof buildBookPreview>[0]> = {}) => ({
  title: "The Book",
  author: "Pan",
  language: "th",
  cover: { kind: "none" } as CoverPlan,
  chapters: CHAPTERS,
  nav: undefined as NavItem[] | undefined,
  warnings: [] as string[],
  ...over,
});

describe("buildBookPreview: a flat plan", () => {
  it("lists every chapter once, by title and path, in the order given", () => {
    const preview = buildBookPreview(input());

    expect(preview.rows).toEqual(CHAPTERS.map((c) => ({ kind: "chapter", title: c.title, path: c.path })));
    expect(readingOrder(preview.rows)).toEqual(paths(CHAPTERS));
  });

  it("carries the book's title and the number of chapters", () => {
    const preview = buildBookPreview(input({ title: "My Book" }));

    expect(preview.title).toBe("My Book");
    expect(preview.chapterCount).toBe(6);
  });
});

describe("buildBookPreview: Parts", () => {
  it("nests Parts to any depth, as the book's table of contents will", () => {
    const preview = buildBookPreview(input({ nav: NESTED }));

    expect(preview.rows).toEqual([
      { kind: "chapter", title: "The Book", path: "Book/Book.md" },
      { kind: "chapter", title: "Intro", path: "Book/Intro.md" },
      {
        kind: "part",
        title: "Part One",
        path: "Book/Part I/Part I.md",
        children: [
          { kind: "chapter", title: "Ch A", path: "Book/Part I/a.md" },
          {
            kind: "part",
            title: "Deep",
            path: null,
            children: [{ kind: "chapter", title: "Ch B", path: "Book/Part I/Deep/b.md" }],
          },
        ],
      },
      { kind: "chapter", title: "Tail", path: "Book/Tail.md" },
    ]);
  });

  it("reads depth-first as exactly the chapters in reading order", () => {
    const preview = buildBookPreview(input({ nav: NESTED }));

    expect(readingOrder(preview.rows)).toEqual(paths(CHAPTERS));
  });

  it("takes a Part's path from its index note, and has none for a Part named only by its folder", () => {
    const preview = buildBookPreview(input({ nav: NESTED }));
    const [, , opened] = preview.rows;
    if (opened.kind !== "part") throw new Error("expected a Part");
    const named = opened.children[1];
    if (named.kind !== "part") throw new Error("expected a nested Part");

    expect(opened.path).toBe("Book/Part I/Part I.md");
    expect(named.path).toBeNull();
  });

  it("counts the Part's index note as a chapter of the book", () => {
    expect(buildBookPreview(input({ nav: NESTED })).chapterCount).toBe(6);
  });
});

describe("buildBookPreview: notes with the same title", () => {
  it("keeps them as separate rows that differ by path", () => {
    const twins = [chapter("Overview", "A/Overview.md"), chapter("Overview", "B/Overview.md")];

    const preview = buildBookPreview(input({ chapters: twins }));

    expect(preview.rows).toEqual([
      { kind: "chapter", title: "Overview", path: "A/Overview.md" },
      { kind: "chapter", title: "Overview", path: "B/Overview.md" },
    ]);
  });
});

describe("buildBookPreview: warnings", () => {
  it("carries the planning warnings through, as a copy", () => {
    const given = ["chapter ordering fell back to filename order: boom"];

    const preview = buildBookPreview(input({ warnings: given }));

    expect(preview.warnings).toEqual(given);
    expect(preview.warnings).not.toBe(given);
  });

  it("has none when nothing went wrong", () => {
    expect(buildBookPreview(input({ nav: NESTED })).warnings).toEqual([]);
  });
});

describe("buildBookPreview: a table of contents the book would reject", () => {
  it("falls back to the flat list the export falls back to, and says so in the export's words", () => {
    const outsideTheBook: NavItem[] = [ch(0), ch(1), ch(2), ch(3), ch(4), ch(9)];

    const preview = buildBookPreview(input({ nav: outsideTheBook }));

    expect(readingOrder(preview.rows)).toEqual(paths(CHAPTERS));
    expect(preview.rows.every((row) => row.kind === "chapter")).toBe(true);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toMatch(/^table of contents fell back to a flat list: .*9/);
  });

  it("keeps the planning warnings ahead of the fallback warning", () => {
    const listedTwice: NavItem[] = [ch(0), ch(0), ch(1), ch(2), ch(3), ch(4), ch(5)];

    const preview = buildBookPreview(input({ nav: listedTwice, warnings: ["planning warning"] }));

    expect(preview.warnings[0]).toBe("planning warning");
    expect(preview.warnings[1]).toMatch(/^table of contents fell back to a flat list: /);
  });
});

describe("buildBookPreview: nothing to list", () => {
  it("returns an empty preview rather than throwing", () => {
    const preview = buildBookPreview(input({ chapters: [] }));

    expect(preview.rows).toEqual([]);
    expect(preview.chapterCount).toBe(0);
  });
});

// The two sentences that keep a tidy list from being read as a promise. They
// are exported constants so the wording lives once and the window test can
// compare against it rather than against a copy.
describe("what the preview says about itself (FR-010)", () => {
  it("says this is the plan, made before anything is rendered", () => {
    expect(PREVIEW_INTRO).toBe(
      "This is the plan for the book, made before anything is rendered. The chapters, their order and the Parts below are what the export will use."
    );
  });

  it("names the five things only a built book can reveal", () => {
    expect(PREVIEW_UNKNOWNS).toBe(
      "Only known when the book is built: warnings about images, links and math, chapters that fail to render, whether the Thai font is embedded, and the backlink trails added to each chapter."
    );
  });

  it("is part of every built preview", () => {
    const preview = buildBookPreview(input());

    expect(preview.intro).toBe(PREVIEW_INTRO);
    expect(preview.unknowns).toBe(PREVIEW_UNKNOWNS);
  });
});

// US5: who the book says it is, above the list.
describe("buildBookPreview: the book's identity (FR-011)", () => {
  it("carries the author and language, and describes the cover source in words", () => {
    const preview = buildBookPreview(
      input({ author: "Pan Writer", language: "en", cover: { kind: "url", url: "https://x.example/c.png" } })
    );

    expect(preview.summary).toEqual({
      author: "Pan Writer",
      language: "en",
      cover: "Downloaded from https://x.example/c.png when the book is built",
    });
  });

  it("says there is no cover when the plan has none", () => {
    expect(buildBookPreview(input()).summary.cover).toBe("No cover");
  });

  it("keeps the title where the window heading reads it", () => {
    expect(buildBookPreview(input({ title: "My Book" })).title).toBe("My Book");
  });
});
