import { describe, it, expect } from "vitest";
import { createWarningCollector, buildReport, renderReportText, type ScopedWarning } from "../src/report";

// ── The collector (T002) ──────────────────────────────────────────────────
//
// The load-bearing guarantee here is FR-020: `messages()` must return exactly
// what a bare `string[]` accumulator would have held. Console output and
// `summarizeWarnings` are fed from it, and `scripts/local-export.ts` parses
// those console lines — so any reordering, de-duplication, or rewording here
// is a silent break of an existing tool, not a cosmetic difference.
describe("createWarningCollector", () => {
  it("returns empty arrays before anything is recorded", () => {
    const c = createWarningCollector();
    expect(c.messages()).toEqual([]);
    expect(c.scoped()).toEqual([]);
  });

  it("records note-scoped warnings against the note's path", () => {
    const c = createWarningCollector();
    c.forNote("Book/Intro.md")("missing image: cover.png");
    expect(c.scoped()).toEqual([{ scope: "Book/Intro.md", message: "missing image: cover.png" }]);
  });

  it("records book-scoped warnings with a null scope", () => {
    const c = createWarningCollector();
    c.forBook()("Thai font unavailable — exporting without embedded font");
    expect(c.scoped()).toEqual([
      { scope: null, message: "Thai font unavailable — exporting without embedded font" },
    ]);
  });

  it("preserves collection order across both scopes (FR-020)", () => {
    const c = createWarningCollector();
    c.forBook()("first");
    c.forNote("a.md")("second");
    c.forBook()("third");
    c.forNote("b.md")("fourth");
    expect(c.messages()).toEqual(["first", "second", "third", "fourth"]);
    expect(c.scoped().map((w) => w.scope)).toEqual([null, "a.md", null, "b.md"]);
  });

  it("never de-duplicates: the same message twice is recorded twice", () => {
    const c = createWarningCollector();
    const note = c.forNote("a.md");
    note("missing image: x.png");
    note("missing image: x.png");
    expect(c.messages()).toEqual(["missing image: x.png", "missing image: x.png"]);
  });

  it("never rewords or trims a message", () => {
    const c = createWarningCollector();
    const odd = '  spaced  message with <b>markup</b> and "quotes"  ';
    c.forBook()(odd);
    expect(c.messages()[0]).toBe(odd);
  });

  it("gives a reusable sink per note, so one call site can record many", () => {
    const c = createWarningCollector();
    const note = c.forNote("Book/Ch1.md");
    note("one");
    note("two");
    expect(c.scoped()).toEqual([
      { scope: "Book/Ch1.md", message: "one" },
      { scope: "Book/Ch1.md", message: "two" },
    ]);
  });

  it("hands back copies, so a caller cannot mutate the collector's state", () => {
    const c = createWarningCollector();
    c.forBook()("kept");
    c.messages().push("injected");
    c.scoped().push({ scope: null, message: "injected" });
    expect(c.messages()).toEqual(["kept"]);
    expect(c.scoped()).toHaveLength(1);
  });
});

// ── buildReport (T005) ────────────────────────────────────────────────────

const w = (scope: string | null, message: string): ScopedWarning => ({ scope, message });

describe("buildReport", () => {
  it("counts every warning, and the groups account for all of them (FR-005, FR-009)", () => {
    const report = buildReport(
      "My Book",
      ["a.md", "b.md"],
      [w("a.md", "one"), w("b.md", "two"), w(null, "three")]
    );
    expect(report.total).toBe(3);
    expect(report.groups.reduce((n, g) => n + g.messages.length, 0)).toBe(3);
  });

  it("copies the title through verbatim (FR-008)", () => {
    expect(buildReport("ตำราเล่มหนึ่ง", [], []).title).toBe("ตำราเล่มหนึ่ง");
  });

  it("puts note-scoped warnings in that note's group (FR-006)", () => {
    const report = buildReport("B", ["a.md"], [w("a.md", "one")]);
    expect(report.groups).toEqual([{ kind: "note", notePath: "a.md", messages: ["one"] }]);
  });

  it("puts every book-scoped warning in one book group (FR-007)", () => {
    const report = buildReport("B", [], [w(null, "one"), w(null, "two")]);
    expect(report.groups).toEqual([{ kind: "book", notePath: null, messages: ["one", "two"] }]);
  });

  it("makes one group per note however many warnings it has", () => {
    const report = buildReport("B", ["a.md"], [w("a.md", "one"), w("a.md", "two"), w("a.md", "three")]);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].messages).toEqual(["one", "two", "three"]);
  });

  it("orders note groups by the book's chapter order, not by first warning (FR-010)", () => {
    // "c.md" warns first, but the book presents a, b, c — the report follows
    // the book so a reader can walk it the way they read.
    const report = buildReport(
      "B",
      ["a.md", "b.md", "c.md"],
      [w("c.md", "from c"), w("a.md", "from a"), w("b.md", "from b")]
    );
    expect(report.groups.map((g) => g.notePath)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("produces no group for a chapter that warned about nothing", () => {
    const report = buildReport("B", ["a.md", "quiet.md", "c.md"], [w("a.md", "x"), w("c.md", "y")]);
    expect(report.groups.map((g) => g.notePath)).toEqual(["a.md", "c.md"]);
    expect(report.groups.every((g) => g.messages.length > 0)).toBe(true);
  });

  it("still reports a scope missing from the chapter order, after the known ones", () => {
    // Should not happen — but dropping a warning to keep the ordering tidy
    // would violate FR-005, so an unknown scope sorts last rather than away.
    const report = buildReport("B", ["a.md"], [w("ghost.md", "orphan"), w("a.md", "known")]);
    expect(report.groups.map((g) => g.notePath)).toEqual(["a.md", "ghost.md"]);
    expect(report.total).toBe(2);
  });

  it("orders several unknown scopes by first appearance", () => {
    const report = buildReport("B", [], [w("z.md", "one"), w("y.md", "two"), w("z.md", "three")]);
    expect(report.groups.map((g) => g.notePath)).toEqual(["z.md", "y.md"]);
  });

  it("always puts the book group last", () => {
    const report = buildReport(
      "B",
      ["a.md", "b.md"],
      [w(null, "book-level"), w("a.md", "from a"), w("b.md", "from b")]
    );
    expect(report.groups.map((g) => g.kind)).toEqual(["note", "note", "book"]);
  });

  it("treats no warnings as a valid, empty report (FR-015)", () => {
    const report = buildReport("B", ["a.md"], []);
    expect(report.total).toBe(0);
    expect(report.groups).toEqual([]);
  });

  it("mutates neither input array", () => {
    const order = ["a.md"];
    const warnings = [w("a.md", "one")];
    buildReport("B", order, warnings);
    expect(order).toEqual(["a.md"]);
    expect(warnings).toEqual([{ scope: "a.md", message: "one" }]);
  });

  it("is deterministic: same inputs, same output", () => {
    const args = () =>
      buildReport("B", ["a.md", "b.md"], [w("b.md", "one"), w(null, "two"), w("a.md", "three")]);
    expect(args()).toEqual(args());
  });
});

// ── renderReportText (T006) ───────────────────────────────────────────────

describe("renderReportText", () => {
  const report = buildReport(
    "Deep Work",
    ["Book/Intro.md", "Book/Ch1.md"],
    [
      w("Book/Ch1.md", "missing image: diagram.png (referenced by Book/Ch1.md)"),
      w("Book/Intro.md", "bases view omitted (interactive Bases have no EPUB equivalent): Links"),
      w(null, "Thai font unavailable — exporting without embedded font"),
    ]
  );

  it("names the book and the total", () => {
    const text = renderReportText(report);
    expect(text).toContain("Deep Work");
    expect(text).toContain("3");
  });

  it("contains every message verbatim", () => {
    const text = renderReportText(report);
    for (const g of report.groups) {
      for (const m of g.messages) expect(text).toContain(m);
    }
  });

  it("shows each note path as a heading", () => {
    const text = renderReportText(report);
    expect(text).toContain("Book/Intro.md");
    expect(text).toContain("Book/Ch1.md");
  });

  it("keeps each message under its own group's heading (FR-022)", () => {
    const text = renderReportText(report);
    const introAt = text.indexOf("Book/Intro.md");
    const ch1At = text.indexOf("Book/Ch1.md:"); // the heading, not the message suffix
    const basesAt = text.indexOf("bases view omitted");
    const fontAt = text.indexOf("Thai font unavailable");
    // Intro's heading comes before its message, which comes before Ch1's heading.
    expect(introAt).toBeLessThan(basesAt);
    expect(basesAt).toBeLessThan(ch1At);
    // The book-level warning is last of all.
    expect(fontAt).toBeGreaterThan(ch1At);
  });

  it("preserves within-group order", () => {
    const many = buildReport("B", ["a.md"], [w("a.md", "first"), w("a.md", "second")]);
    const text = renderReportText(many);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  it("emits plain text with no markup", () => {
    expect(renderReportText(report)).not.toMatch(/<[a-z/]/i);
  });

  it("uses singular wording for exactly one warning", () => {
    const one = buildReport("Solo", ["a.md"], [w("a.md", "missing image: x.png")]);
    const text = renderReportText(one);
    expect(text).toContain("1 warning");
    expect(text).not.toContain("1 warnings");
  });

  it("says so plainly when there were no warnings (FR-015)", () => {
    const text = renderReportText(buildReport("Clean Book", ["a.md"], []));
    expect(text).toContain("Clean Book");
    expect(text.toLowerCase()).toContain("no warnings");
  });
});
