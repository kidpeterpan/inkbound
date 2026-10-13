// 015-richer-book-metadata: what a note's properties say about its book, and
// the warning text for a value that cannot be used
// (specs/015-richer-book-metadata/contracts/note-properties.md).
//
// Inputs follow research R1: the shapes real Obsidian 1.14.4 hands a plugin
// (numbers, null, booleans, maps, mixed lists), not the vault stub's strings.
import { describe, expect, it } from "vitest";
import { detailsWarning, resolveBookDetails, type MetaIssue } from "../src/core/book/book-details";
import { UNUSABLE_DATES } from "./fixtures/date-cases";

const NOTE = "Books/Tidal Notes.md";

describe("resolveBookDetails: a note without the book-detail properties", () => {
  it("finds no details and no issues when there is no frontmatter", () => {
    expect(resolveBookDetails(undefined)).toEqual({ details: {}, issues: [] });
  });

  it("ignores the properties it does not own, tags included", () => {
    const frontmatter = { aliases: ["T"], author: "A", language: "th", tags: ["book", "main"] };

    expect(resolveBookDetails(frontmatter)).toEqual({ details: {}, issues: [] });
  });
});

describe("detailsWarning: one warning per unusable value", () => {
  const issue = (overrides: Partial<MetaIssue>): MetaIssue => ({
    property: "description",
    item: false,
    value: "x",
    reason: "not-text",
    ...overrides,
  });

  it("says a description, publisher or series is not text", () => {
    expect(detailsWarning(issue({ property: "description", value: { a: 1 } }), NOTE)).toBe(
      'description left out: {"a":1} is not text (Books/Tidal Notes.md)'
    );
    expect(detailsWarning(issue({ property: "publisher", value: true }), NOTE)).toBe(
      "publisher left out: true is not text (Books/Tidal Notes.md)"
    );
  });

  it("says a date is not a real date in an accepted form", () => {
    expect(
      detailsWarning(issue({ property: "date", value: "next spring", reason: "not-a-date" }), NOTE)
    ).toBe(
      'date left out: "next spring" is not a real date written as YYYY, YYYY-MM or YYYY-MM-DD (Books/Tidal Notes.md)'
    );
  });

  it("says a series position is not a number of 0 or more", () => {
    expect(
      detailsWarning(issue({ property: "series_index", value: "third", reason: "not-a-position" }), NOTE)
    ).toBe('series_index left out: "third" is not a number of 0 or more (Books/Tidal Notes.md)');
  });

  it("names one subjects item that is not text", () => {
    expect(detailsWarning(issue({ property: "subjects", item: true, value: true }), NOTE)).toBe(
      "subjects item left out: true is not text (Books/Tidal Notes.md)"
    );
  });

  it("says a whole subjects value is neither text nor a list", () => {
    expect(
      detailsWarning(issue({ property: "subjects", value: { a: 1 }, reason: "not-text-or-list" }), NOTE)
    ).toBe('subjects left out: {"a":1} is not text or a list (Books/Tidal Notes.md)');
  });

  it("cuts a long value to 60 characters so it cannot flood the report", () => {
    const longValue = "x".repeat(200);
    const json = JSON.stringify(longValue);

    const warning = detailsWarning(issue({ value: longValue }), NOTE);

    expect(warning).toBe(`description left out: ${json.slice(0, 59)}… is not text (Books/Tidal Notes.md)`);
  });

  it("shows a value of exactly 60 characters whole", () => {
    const value = "y".repeat(58); // 58 characters + 2 quotes = 60
    const warning = detailsWarning(issue({ value }), NOTE);

    expect(warning).toBe(`description left out: "${value}" is not text (Books/Tidal Notes.md)`);
  });
});

// US1: description, publisher and date reach the details. An unusable value is
// simply absent here; the warning for it is asserted under US2.
describe("resolveBookDetails: description and publisher (text values)", () => {
  const descriptionOf = (raw: unknown) => resolveBookDetails({ description: raw }).details.description;

  it("trims the text and keeps inner line breaks and markup characters as typed", () => {
    expect(descriptionOf("  <b>bold</b> & **stars**\nsecond line  ")).toBe(
      "<b>bold</b> & **stars**\nsecond line"
    );
  });

  it("uses a number as its text (FR-004a)", () => {
    expect(descriptionOf(1.5)).toBe("1.5");
    expect(descriptionOf(1)).toBe("1");
  });

  it("takes the first list item that has text", () => {
    expect(descriptionOf(["", "A", "B"])).toBe("A");
    expect(descriptionOf([2, "x"])).toBe("2");
    expect(descriptionOf([null, "  ", "C"])).toBe("C");
  });

  it.each([null, "", "   ", []])("leaves the description out for an empty value: %j", (raw) => {
    expect(descriptionOf(raw)).toBeUndefined();
  });

  it.each([{ a: 1 }, true])("leaves the description out for a value that is not text: %j", (raw) => {
    expect(descriptionOf(raw)).toBeUndefined();
  });

  it("replaces each character an EPUB cannot hold with a space (research R13)", () => {
    expect(descriptionOf("copied\u000Cfrom a PDF")).toBe("copied from a PDF");
    expect(descriptionOf("a\u0007b")).toBe("a b");
    expect(descriptionOf("a\uFFFFb")).toBe("a b");
    expect(descriptionOf("a\uD800b")).toBe("a b");
  });

  it("keeps a tab and line breaks, which an EPUB can hold", () => {
    expect(descriptionOf("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
  });

  it("keeps a character outside the basic plane whole", () => {
    expect(descriptionOf("tide 🌊 pools")).toBe("tide 🌊 pools");
  });

  it("treats a value made only of unencodable characters as empty", () => {
    expect(descriptionOf("\u0007")).toBeUndefined();
  });

  it("reads the publisher by the same rules", () => {
    expect(resolveBookDetails({ publisher: "  Pan's Press " }).details.publisher).toBe("Pan's Press");
    expect(resolveBookDetails({ publisher: 42 }).details.publisher).toBe("42");
    expect(resolveBookDetails({ publisher: true }).details.publisher).toBeUndefined();
  });
});

describe("resolveBookDetails: date", () => {
  it("carries a valid date as the date grammar gives it", () => {
    expect(resolveBookDetails({ date: "2024-01-15T09:30" }).details.date).toBe("2024-01-15");
    expect(resolveBookDetails({ date: 2024 }).details.date).toBe("2024");
  });

  it("leaves an unusable date out", () => {
    expect(resolveBookDetails({ date: "next spring" }).details.date).toBeUndefined();
  });

  it("puts only the fields that have a value into the details", () => {
    const { details } = resolveBookDetails({ description: "D", publisher: "", date: "2024-01" });

    expect(details).toEqual({ description: "D", date: "2024-01" });
  });
});

// US2: a value that is present but unusable is recorded as an issue, which
// becomes a warning in the report and the preview (FR-010). An empty one is not.
describe("resolveBookDetails: issues for values that cannot be used (US2)", () => {
  const issuesOf = (frontmatter: Record<string, unknown>) => resolveBookDetails(frontmatter).issues;

  it("records a description or publisher that is not text", () => {
    expect(issuesOf({ description: { a: 1 } })).toEqual([
      { property: "description", item: false, value: { a: 1 }, reason: "not-text" },
    ]);
    expect(issuesOf({ publisher: true })).toEqual([
      { property: "publisher", item: false, value: true, reason: "not-text" },
    ]);
  });

  it.each(["next spring", "01/02/2024", "2024-02-30", 800])(
    "records a date that is not a date: %j",
    (value) => {
      expect(issuesOf({ date: value })).toEqual([
        { property: "date", item: false, value, reason: "not-a-date" },
      ]);
    }
  );

  it.each([null, "", []])("records nothing for an empty value: %j", (value) => {
    expect(issuesOf({ description: value, publisher: value, date: value })).toEqual([]);
  });

  it("lists the issues in property order: description, publisher, date", () => {
    const properties = issuesOf({ date: "soon", publisher: true, description: { a: 1 } }).map(
      (issue) => issue.property
    );

    expect(properties).toEqual(["description", "publisher", "date"]);
  });

  it.each(UNUSABLE_DATES.map((value) => [JSON.stringify(value), value] as const))(
    "gives exactly one warning and no date for every unusable date (SC-004): %s",
    (_label, value) => {
      const { details, issues } = resolveBookDetails({ date: value });

      expect(details.date).toBeUndefined();
      expect(issues).toEqual([{ property: "date", item: false, value, reason: "not-a-date" }]);
    }
  );
});

// US3: a series and the book's position in it (FR-007, research R5).
describe("resolveBookDetails: series (US3)", () => {
  const seriesOf = (frontmatter: Record<string, unknown>) => resolveBookDetails(frontmatter).details.series;
  const issuesOf = (frontmatter: Record<string, unknown>) => resolveBookDetails(frontmatter).issues;

  it.each([
    [2, 2],
    [2.5, 2.5],
    ["3", 3],
    [" 4.25 ", 4.25],
    [0, 0],
    [["", 4], 4],
  ])("reads the position %j as %j", (raw, position) => {
    expect(seriesOf({ series: "Tidal Notes", series_index: raw })).toEqual({ name: "Tidal Notes", position });
  });

  it.each([undefined, null, "", []])("keeps the series without a position for an empty index: %j", (raw) => {
    const frontmatter = { series: "Tidal Notes", series_index: raw };

    expect(seriesOf(frontmatter)).toEqual({ name: "Tidal Notes" });
    expect(issuesOf(frontmatter)).toEqual([]);
  });

  it("uses a number as the series name (FR-004a)", () => {
    expect(seriesOf({ series: 1 })).toEqual({ name: "1" });
  });

  it.each(["third", -1, "-2", "1e3", "2.", ".5", { a: 1 }, true, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the series but drops an unusable position, with a warning: %j",
    (raw) => {
      const frontmatter = { series: "Tidal Notes", series_index: raw };

      expect(seriesOf(frontmatter)).toEqual({ name: "Tidal Notes" });
      expect(issuesOf(frontmatter)).toEqual([
        { property: "series_index", item: false, value: raw, reason: "not-a-position" },
      ]);
    }
  );

  it("treats a list inside the position's list as unusable", () => {
    const frontmatter = { series: "S", series_index: [[2]] };

    expect(seriesOf(frontmatter)).toEqual({ name: "S" });
    expect(issuesOf(frontmatter)).toEqual([
      { property: "series_index", item: false, value: [[2]], reason: "not-a-position" },
    ]);
  });

  it("ignores a position with no series, silently, even a malformed one", () => {
    expect(resolveBookDetails({ series_index: "third" })).toEqual({ details: {}, issues: [] });
    expect(resolveBookDetails({ series_index: 2 })).toEqual({ details: {}, issues: [] });
  });

  it("drops an unusable series name, and does not read its position at all", () => {
    expect(resolveBookDetails({ series: { a: 1 }, series_index: "third" })).toEqual({
      details: {},
      issues: [{ property: "series", item: false, value: { a: 1 }, reason: "not-text" }],
    });
  });

  it("lists series issues after the date's", () => {
    const properties = issuesOf({ series: "S", series_index: "x", date: "soon" }).map(
      (issue) => issue.property
    );

    expect(properties).toEqual(["date", "series_index"]);
  });
});

// US4: subjects come from the `subjects` property only, never from tags
// (spec Q1, FR-008). Rows follow contracts/note-properties.md "Subjects".
describe("resolveBookDetails: subjects (US4)", () => {
  const subjectsOf = (raw: unknown) => resolveBookDetails({ subjects: raw }).details.subjects;
  const issuesOf = (raw: unknown) => resolveBookDetails({ subjects: raw }).issues;

  it.each([
    [
      ["history", "maritime"],
      ["history", "maritime"],
    ],
    ["history", ["history"]],
    ["history, maritime", ["history, maritime"]],
    [["#reading/sci-fi"], ["reading/sci-fi"]],
    [["History", "history"], ["History"]],
    [
      [1984, "history", "#reading/sci-fi"],
      ["1984", "history", "reading/sci-fi"],
    ],
    [["history", "", "#", null, " # "], ["history"]],
    [["his\u000Btory"], ["his tory"]],
    [1984, ["1984"]],
  ])("reads %j as %j, silently", (raw, expected) => {
    expect(subjectsOf(raw)).toEqual(expected);
    expect(issuesOf(raw)).toEqual([]);
  });

  it.each([null, [], "", [null, ""]])("gives no subjects and no warning for an empty value: %j", (raw) => {
    expect(subjectsOf(raw)).toBeUndefined();
    expect(issuesOf(raw)).toEqual([]);
  });

  it("skips one item that is not text, names it, and keeps the rest", () => {
    expect(subjectsOf(["history", true])).toEqual(["history"]);
    expect(issuesOf(["history", true])).toEqual([
      { property: "subjects", item: true, value: true, reason: "not-text" },
    ]);
  });

  it("treats a nested list item as not text, unlike a top-level list for description", () => {
    expect(subjectsOf(["history", ["a"]])).toEqual(["history"]);
    expect(issuesOf(["history", ["a"]])).toEqual([
      { property: "subjects", item: true, value: ["a"], reason: "not-text" },
    ]);
  });

  it.each([{ a: 1 }, true])("leaves out a whole value that is neither text nor a list: %j", (raw) => {
    expect(subjectsOf(raw)).toBeUndefined();
    expect(issuesOf(raw)).toEqual([
      { property: "subjects", item: false, value: raw, reason: "not-text-or-list" },
    ]);
  });

  it("never reads tags", () => {
    expect(resolveBookDetails({ tags: ["history", "book", "main"] })).toEqual({ details: {}, issues: [] });
  });

  it("lists subject issues last", () => {
    const properties = resolveBookDetails({ subjects: [true], description: { a: 1 } }).issues.map(
      (issue) => issue.property
    );

    expect(properties).toEqual(["description", "subjects"]);
  });

  it("gives no details and one issue per unusable property when every one is unusable (analysis G2)", () => {
    const { details, issues } = resolveBookDetails({
      description: { a: 1 },
      publisher: true,
      date: "next spring",
      series: { a: 1 },
      series_index: "third",
      subjects: true,
    });

    expect(details).toEqual({});
    expect(issues.map((issue) => issue.property)).toEqual([
      "description",
      "publisher",
      "date",
      "series",
      "subjects",
    ]);
  });
});
