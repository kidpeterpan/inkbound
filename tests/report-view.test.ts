import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { App, MODALS, NOTICES } from "./fixtures/obsidian-stub";
import { buildReport, renderReportText, BOOK_GROUP_LABEL, type ScopedWarning } from "../src/report";
import { ExportReportModal, openExportReport } from "../src/report-view";

const w = (scope: string | null, message: string): ScopedWarning => ({ scope, message });

// tsc resolves "obsidian" to the real package's .d.ts while vitest resolves it
// to the stub, so the stub's narrowed App is not assignable to the real App
// type. Same `as never` idiom the other adapter tests use for this exact
// mismatch (see tests/main.test.ts's makePlugin).
const app = () => new App() as never;

const sample = () =>
  buildReport(
    "Deep Work",
    ["Book/Intro.md", "Book/Ch1.md"],
    [
      w("Book/Intro.md", "bases view omitted (interactive Bases have no EPUB equivalent): Links"),
      w("Book/Ch1.md", "missing image: diagram.png (referenced by Book/Ch1.md)"),
      w("Book/Ch1.md", "unsupported image type: scan.tiff (referenced by Book/Ch1.md)"),
      w(null, "Thai font unavailable — exporting without embedded font"),
    ]
  );

/** Renders a modal the way opening it would, and hands back its content root. */
function render(report = sample()): HTMLElement {
  const modal = new ExportReportModal(app(), report);
  modal.open();
  return modal.contentEl;
}

beforeEach(() => {
  MODALS.length = 0;
  NOTICES.length = 0;
});

// ── T007: what the reader sees ────────────────────────────────────────────

describe("ExportReportModal — rendering", () => {
  it("shows the book title, so two books cannot be confused (FR-008)", () => {
    expect(render().textContent).toContain("Deep Work");
  });

  it("shows the total warning count (FR-009)", () => {
    expect(render().textContent).toContain("4");
  });

  it("gives each note its own heading, named by its path (FR-006)", () => {
    const headings = [...render().querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain("Book/Intro.md");
    expect(headings).toContain("Book/Ch1.md");
  });

  it("labels the book-level group as belonging to the book, not to a note (FR-007)", () => {
    const headings = [...render().querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toContain(BOOK_GROUP_LABEL);
  });

  it("renders every message, verbatim (FR-005)", () => {
    const el = render();
    const shown = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(shown).toEqual([
      "bases view omitted (interactive Bases have no EPUB equivalent): Links",
      "missing image: diagram.png (referenced by Book/Ch1.md)",
      "unsupported image type: scan.tiff (referenced by Book/Ch1.md)",
      "Thai font unavailable — exporting without embedded font",
    ]);
  });

  it("keeps groups in the order buildReport produced, book last (FR-010)", () => {
    const headings = [...render().querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Book/Intro.md", "Book/Ch1.md", BOOK_GROUP_LABEL]);
  });

  it("groups a note's several warnings under one heading, not several", () => {
    const el = render();
    const ch1 = [...el.querySelectorAll("h3")].filter((h) => h.textContent === "Book/Ch1.md");
    expect(ch1).toHaveLength(1);
  });

  // FR-011. A warning names a vault path the reader chose, and a path can
  // contain anything a filename can. Setting it as text content means markup
  // in a message is shown, never interpreted.
  it("cannot have its structure altered by markup inside a warning (FR-011)", () => {
    const nasty = '<img src=x onerror="boom"> & "quoted" <b>bold</b>';
    const el = render(buildReport("B", ["a.md"], [w("a.md", nasty)]));
    expect(el.querySelector("li")?.textContent).toBe(nasty);
    // The markup was shown, not built: no element came from the message.
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
  });

  it("shows a note path containing angle brackets as written", () => {
    const el = render(buildReport("B", ["<odd>.md"], [w("<odd>.md", "missing image: x.png")]));
    expect([...el.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["<odd>.md"]);
  });

  it("uses singular wording for exactly one warning", () => {
    const el = render(buildReport("Solo", ["a.md"], [w("a.md", "missing image: x.png")]));
    expect(el.textContent).toContain("1 warning ");
    expect(el.textContent).not.toContain("1 warnings");
  });

  it("says plainly that there were no warnings, for an empty report (FR-015)", () => {
    const el = render(buildReport("Clean Book", ["a.md"], []));
    expect(el.textContent).toContain("Clean Book");
    expect(el.textContent?.toLowerCase()).toContain("no warnings");
    expect(el.querySelectorAll("li")).toHaveLength(0);
  });

  it("re-renders cleanly if opened twice, rather than doubling its content", () => {
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    modal.open();
    expect(modal.contentEl.querySelectorAll("li")).toHaveLength(4);
  });

  it("empties its content when dismissed (FR-017)", () => {
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    modal.close();
    expect(modal.contentEl.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("openExportReport", () => {
  it("opens a modal showing that report", () => {
    openExportReport(app(), sample());
    expect(MODALS).toHaveLength(1);
    expect(MODALS[0].contentEl.textContent).toContain("Deep Work");
  });
});

// ── T021: the copy action ─────────────────────────────────────────────────

/** Finds the copy control without depending on where it sits in the tree. */
function copyButton(el: HTMLElement): HTMLButtonElement {
  const btn = [...el.querySelectorAll("button")].find((b) => /copy/i.test(b.textContent ?? ""));
  if (!btn) throw new Error("no copy button rendered");
  return btn as HTMLButtonElement;
}

function stubClipboard(impl: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: impl ? { writeText: impl } : undefined,
    configurable: true,
    writable: true,
  });
}

describe("ExportReportModal — copy action", () => {
  afterEach(() => stubClipboard(null));

  it("copies exactly the plain-text rendering of the report (FR-022)", async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const report = sample();
    const modal = new ExportReportModal(app(), report);
    modal.open();
    copyButton(modal.contentEl).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toBe(renderReportText(report));
  });

  it("copies text that keeps every warning under its own note (FR-022)", async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    copyButton(modal.contentEl).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const text = writeText.mock.calls[0][0];
    expect(text).toContain("Book/Intro.md:");
    expect(text).toContain("missing image: diagram.png (referenced by Book/Ch1.md)");
    expect(text).toContain(BOOK_GROUP_LABEL);
  });

  it("tells the reader the copy succeeded (FR-022)", async () => {
    stubClipboard(() => Promise.resolve());
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    copyButton(modal.contentEl).click();
    await vi.waitFor(() => expect(NOTICES.length).toBeGreaterThan(0));
    expect(NOTICES[0].toLowerCase()).toContain("copied");
  });

  // Constitution II: a diagnostic view must never throw at the reader. A
  // clipboard can refuse (denied permission, insecure context) or be absent
  // entirely, and neither is the reader's problem to debug.
  it("degrades to a notice when the clipboard refuses, and never throws", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    expect(() => copyButton(modal.contentEl).click()).not.toThrow();
    await vi.waitFor(() => expect(NOTICES.length).toBeGreaterThan(0));
    expect(NOTICES[0].toLowerCase()).toContain("could not");
  });

  it("degrades to a notice when there is no clipboard at all", async () => {
    stubClipboard(null);
    const modal = new ExportReportModal(app(), sample());
    modal.open();
    expect(() => copyButton(modal.contentEl).click()).not.toThrow();
    await vi.waitFor(() => expect(NOTICES.length).toBeGreaterThan(0));
    expect(NOTICES[0].toLowerCase()).toContain("could not");
  });

  it("offers no copy control on an empty report — there is nothing to copy", () => {
    const el = render(buildReport("Clean Book", ["a.md"], []));
    expect([...el.querySelectorAll("button")].filter((b) => /copy/i.test(b.textContent ?? ""))).toEqual([]);
  });
});
