// 016-export-all-books: the windows of "Export all books", read through the
// stub Modal's DOM as tests/preview-view.test.ts reads the preview
// (specs/016-export-all-books/contracts/library-export.md).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, MODALS, NOTICES } from "./fixtures/obsidian-stub";
import {
  LibraryListModal,
  LibraryReportModal,
  openLibraryList,
  openLibraryReport,
} from "../src/adapters/library-view";
import { renderLibraryReportText, type LibraryReport } from "../src/core/delivery/library-report";

const app = () => new App() as never;

const ROWS = [
  "Dune — Library/Dune",
  "Tide — Library/Tide",
  "tide — Old/Tide (skipped: same file name as Library/Tide)",
];

function openList(rows: readonly string[] = ROWS, onExportAll = vi.fn()) {
  const modal = new LibraryListModal(app(), rows, onExportAll);
  modal.open();
  return { modal, root: modal.contentEl, onExportAll };
}

const wasClosed = (modal: unknown) => (modal as { closed: boolean }).closed;
const buttonNamed = (root: HTMLElement, name: string) => {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === name);
  if (!found) throw new Error(`no "${name}" button`);
  return found;
};

beforeEach(() => {
  MODALS.length = 0;
  NOTICES.length = 0;
});

describe("LibraryListModal: what the reader sees", () => {
  it("heads the window, says nothing happens until Export all, and counts every row", () => {
    const { root } = openList();

    expect(root.querySelector("h2")?.textContent).toBe("Export all books");
    expect(root.querySelector("p")?.textContent).toBe(
      "These books will be exported one after another, each as exporting its folder would. Nothing is written or pushed until you choose Export all."
    );
    expect(root.querySelector("h3")?.textContent).toBe("3 books");
    expect(openList(["Solo — Solo"]).root.querySelector("h3")?.textContent).toBe("1 book");
  });

  it("puts Export all and Cancel above the list, in that order", () => {
    const { root } = openList();
    const [first, second] = [...root.querySelectorAll("button")];
    const list = root.querySelector("ol")!;

    expect([first.textContent, second.textContent]).toEqual(["Export all", "Cancel"]);
    expect(first.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists every row as text, markup shown as typed", () => {
    const { root } = openList(["<b>x</b> & y — Folder"]);

    expect([...root.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["<b>x</b> & y — Folder"]);
    expect(root.querySelector("b")).toBeNull();
  });
});

describe("LibraryListModal: leaving", () => {
  it("Export all closes the window and starts the run once, however often it is pressed", () => {
    const { modal, root, onExportAll } = openList();
    const exportAll = buttonNamed(root, "Export all");

    exportAll.click();
    exportAll.click();

    expect(onExportAll).toHaveBeenCalledTimes(1);
    expect(wasClosed(modal)).toBe(true);
    expect(exportAll.disabled).toBe(true);
  });

  it("Cancel closes the window and starts nothing", () => {
    const { modal, root, onExportAll } = openList();

    buttonNamed(root, "Cancel").click();

    expect(onExportAll).not.toHaveBeenCalled();
    expect(wasClosed(modal)).toBe(true);
  });

  it("closing it any other way starts nothing either", () => {
    const { modal, onExportAll } = openList();

    modal.close();

    expect(onExportAll).not.toHaveBeenCalled();
  });

  it("does not double its content when opened twice, and empties itself when closed", () => {
    const { modal, root } = openList();
    modal.open();

    expect(root.querySelectorAll("h2")).toHaveLength(1);
    modal.close();
    expect(root.children).toHaveLength(0);
  });
});

describe("openLibraryList", () => {
  it("opens the list window", () => {
    openLibraryList(app(), ROWS, () => {});

    expect(MODALS).toHaveLength(1);
  });
});

// US4: the report of a whole run.
const RUN: LibraryReport = {
  books: [
    { folderPath: "Library/Dune", title: "Dune", outcome: "exported", messages: [], reason: null },
    {
      folderPath: "Library/Tide",
      title: "<b>Tide</b>",
      outcome: "warnings",
      messages: ["missing image: a.png", "date left out"],
      reason: null,
    },
    { folderPath: "Drafts/Broken", title: "Broken", outcome: "failed", messages: [], reason: "disk full" },
  ],
};

describe("LibraryReportModal: the account of the run", () => {
  it("shows the summary, then each book with its outcome and its warnings", () => {
    const modal = new LibraryReportModal(app(), RUN);
    modal.open();
    const root = modal.contentEl;

    expect(root.querySelector("h2")?.textContent).toBe("Export all books");
    expect(root.querySelector("p")?.textContent).toBe("3 books: 1 exported, 1 with warnings, 1 failed");
    expect([...root.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Dune — Library/Dune",
      "<b>Tide</b> — Library/Tide",
      "Broken — Drafts/Broken",
    ]);
    expect([...root.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "missing image: a.png",
      "date left out",
    ]);
    expect(root.textContent).toContain("Exported with 2 warnings");
    expect(root.textContent).toContain("Failed: disk full");
    expect(root.querySelector("b")).toBeNull();
  });

  it("copies the report as plain text", async () => {
    let copied = "";
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: async (text: string) => void (copied = text) },
      configurable: true,
      writable: true,
    });
    const modal = new LibraryReportModal(app(), RUN);
    modal.open();

    buttonNamed(modal.contentEl, "Copy report").click();

    await vi.waitFor(() => expect(copied).toBe(renderLibraryReportText(RUN)));
    expect(NOTICES).toContain("Export report copied");
  });

  it("does not double its content when opened twice", () => {
    const modal = new LibraryReportModal(app(), RUN);
    modal.open();
    modal.open();

    expect(modal.contentEl.querySelectorAll("h2")).toHaveLength(1);
  });

  it("says so when the clipboard refuses, and never throws", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
      writable: true,
    });
    const modal = new LibraryReportModal(app(), RUN);
    modal.open();

    expect(() => buttonNamed(modal.contentEl, "Copy report").click()).not.toThrow();
    await vi.waitFor(() =>
      expect(NOTICES).toContain("Could not copy the report — this device did not allow it")
    );
  });

  it("empties itself when closed", () => {
    const modal = new LibraryReportModal(app(), RUN);
    modal.open();
    modal.close();

    expect(modal.contentEl.children).toHaveLength(0);
  });

  it("openLibraryReport opens it", () => {
    openLibraryReport(app(), RUN);

    expect(MODALS).toHaveLength(1);
  });
});
