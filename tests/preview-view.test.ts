// 014-preview-before-export: the window that shows a planned book.
//
// Like report-view.test.ts, this reads what the reader would see by reading the
// recorded modal's DOM. What is pinned here is the SHAPE the contract promises
// (contracts/preview-window.md): the heading, the buttons above the list, the
// nested list, and that every string from the vault is shown as typed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, MODALS } from "./fixtures/obsidian-stub";
import type { BookPreview, PreviewRow } from "../src/core/book/export-preview";
import { BookPreviewModal, openBookPreview } from "../src/adapters/preview-view";

// Same `as never` idiom as report-view.test.ts: tsc resolves "obsidian" to the
// real .d.ts while vitest resolves it to the stub.
const app = () => new App() as never;

const chapterRow = (title: string, path: string): PreviewRow => ({ kind: "chapter", title, path });

const preview = (over: Partial<BookPreview> = {}): BookPreview => ({
  title: "The Book",
  chapterCount: 4,
  rows: [
    chapterRow("Intro", "Book/Intro.md"),
    {
      kind: "part",
      title: "Part One",
      path: "Book/Part I/Part I.md",
      children: [
        chapterRow("Ch A", "Book/Part I/a.md"),
        { kind: "part", title: "Deep", path: null, children: [chapterRow("Ch B", "Book/Part I/Deep/b.md")] },
      ],
    },
  ],
  warnings: [],
  summary: { author: "Pan Writer", language: "en", cover: "No cover" },
  intro: "THE INTRO",
  unknowns: "THE UNKNOWNS",
  ...over,
});

function open(model = preview(), onExport = vi.fn()) {
  const modal = new BookPreviewModal(app(), model, onExport);
  modal.open();
  return { modal, root: modal.contentEl, onExport };
}

// The stub Modal records dismissal in `closed` (see obsidian-stub.ts); the real
// type has no such field, hence the cast.
const wasClosed = (modal: unknown) => (modal as { closed: boolean }).closed;

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const buttonNamed = (root: HTMLElement, name: string) => {
  const found = buttons(root).find((b) => b.textContent === name);
  if (!found) throw new Error(`no "${name}" button`);
  return found;
};

interface Entry {
  label: string;
  children: Entry[];
}
/** The nested list as plain data: each item's own label and its nested items. */
function entriesOf(list: Element | null): Entry[] {
  if (!list) return [];
  return [...list.children].map((li) => ({
    label: li.querySelector(":scope > span")?.textContent ?? "",
    children: entriesOf(li.querySelector(":scope > ol")),
  }));
}

beforeEach(() => {
  MODALS.length = 0;
});

describe("BookPreviewModal: what the reader sees", () => {
  it("heads the window with the book's title", () => {
    expect(open().root.querySelector("h2")?.textContent).toBe("Preview: The Book");
  });

  it("lists chapters and Parts as a nested list, each row with its path", () => {
    const { root } = open();

    expect(entriesOf(root.querySelector("ol"))).toEqual([
      { label: "Intro — Book/Intro.md", children: [] },
      {
        label: "Part One — Book/Part I/Part I.md",
        children: [
          { label: "Ch A — Book/Part I/a.md", children: [] },
          {
            label: "Deep",
            children: [{ label: "Ch B — Book/Part I/Deep/b.md", children: [] }],
          },
        ],
      },
    ]);
  });

  it("says how many chapters the book has", () => {
    const heading = (n: number) =>
      [...open(preview({ chapterCount: n })).root.querySelectorAll("h3")].map((h) => h.textContent);

    expect(heading(4)).toContain("4 chapters");
    expect(heading(1)).toContain("1 chapter");
  });

  it("shows known warnings under their own heading, and nothing when there are none", () => {
    const withWarning = open(
      preview({ warnings: ["chapter ordering fell back to filename order: boom"] })
    ).root;
    const headings = [...withWarning.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain("Known before building");
    expect(withWarning.textContent).toContain("chapter ordering fell back to filename order: boom");

    const clean = open().root;
    expect([...clean.querySelectorAll("h3")].map((h) => h.textContent)).not.toContain(
      "Known before building"
    );
  });

  it("offers Export and Cancel above the chapter list, so they stay in reach on a long book", () => {
    const { root } = open();
    const list = root.querySelector("ol")!;

    expect(buttons(root).map((b) => b.textContent)).toEqual(["Export", "Cancel"]);
    for (const button of buttons(root)) {
      expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("BookPreviewModal: the book's identity (FR-011)", () => {
  /** The four lines under the intro, as the reader reads them. */
  const summaryLines = (root: HTMLElement) =>
    [...root.querySelector("h2")!.nextElementSibling!.nextElementSibling!.querySelectorAll("li")].map(
      (li) => li.textContent
    );

  it("lists title, author, language and cover source, in that order, under the intro", () => {
    const { root } = open();

    expect(summaryLines(root)).toEqual([
      "Title: The Book",
      "Author: Pan Writer",
      "Language: en",
      "Cover: No cover",
    ]);
  });

  it("shows them as text: an author with markup is shown as typed", () => {
    const { root } = open(
      preview({ summary: { author: "<i>A</i> & B", language: "en", cover: "No cover" } })
    );

    expect(root.querySelector("i")).toBeNull();
    expect(summaryLines(root)[1]).toBe("Author: <i>A</i> & B");
  });
});

describe("BookPreviewModal: what it says about itself (FR-010)", () => {
  it("puts the intro directly under the heading", () => {
    const { root } = open();

    const next = root.querySelector("h2")!.nextElementSibling!;
    expect(next.tagName).toBe("P");
    expect(next.textContent).toBe("THE INTRO");
  });

  it("puts what it cannot know between the chapter count and the chapter list", () => {
    const { root } = open();

    const unknowns = [...root.querySelectorAll("p")].find((p) => p.textContent === "THE UNKNOWNS")!;
    const countHeading = [...root.querySelectorAll("h3")].find((h) => h.textContent === "4 chapters")!;
    const list = root.querySelector("ol")!;
    expect(countHeading.compareDocumentPosition(unknowns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(unknowns.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows both as text, however they are worded", () => {
    const { root } = open(preview({ intro: "<i>plan</i>", unknowns: "<u>unknown</u>" }));

    expect(root.querySelector("i")).toBeNull();
    expect(root.querySelector("u")).toBeNull();
    expect(root.textContent).toContain("<i>plan</i>");
    expect(root.textContent).toContain("<u>unknown</u>");
  });
});

describe("BookPreviewModal: leaving", () => {
  it("Export runs the export once and closes the window", () => {
    const { modal, root, onExport } = open();

    buttonNamed(root, "Export").click();

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(wasClosed(modal)).toBe(true);
  });

  it("Cancel closes the window and exports nothing", () => {
    const { modal, root, onExport } = open();

    buttonNamed(root, "Cancel").click();

    expect(wasClosed(modal)).toBe(true);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("closing it any other way (Escape, a tap outside) exports nothing either", () => {
    const { modal, onExport } = open();

    modal.close();

    expect(onExport).not.toHaveBeenCalled();
  });

  it("opening the same window twice does not double its content", () => {
    const { modal, root } = open();

    modal.open();

    expect(root.querySelectorAll("h2")).toHaveLength(1);
    // Parts nest their own lists, so count only the top-level one.
    expect(root.querySelectorAll(":scope > ol")).toHaveLength(1);
    expect(buttons(root)).toHaveLength(2);
  });

  it("empties itself when closed", () => {
    const { modal, root } = open();

    modal.close();

    expect(root.childNodes).toHaveLength(0);
  });
});

describe("BookPreviewModal: one export per window (FR-016)", () => {
  it("starts one export however many times Export is activated", () => {
    const { root, onExport } = open();
    const button = buttonNamed(root, "Export");

    button.click();
    button.click();

    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("disables the button the first time it is used", () => {
    const { root } = open();
    const button = buttonNamed(root, "Export");

    button.click();

    expect(button.disabled).toBe(true);
  });
});

describe("BookPreviewModal: strings from the vault are shown as typed (FR-014)", () => {
  const hostile = `<b>x</b> & "y"`;

  it("does not interpret markup in a title, a chapter or a path", () => {
    const { root } = open(
      preview({
        title: hostile,
        rows: [
          chapterRow(hostile, `Folder/${hostile}.md`),
          { kind: "part", title: hostile, path: null, children: [] },
        ],
        warnings: [hostile],
      })
    );

    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe(`Preview: ${hostile}`);
    expect(root.textContent).toContain(`${hostile} — Folder/${hostile}.md`);
  });
});

describe("openBookPreview", () => {
  it("opens the window and hands back nothing to wait for", () => {
    openBookPreview(app(), preview(), vi.fn());

    expect(MODALS).toHaveLength(1);
    expect(MODALS[0]).toBeInstanceOf(BookPreviewModal);
  });
});
