// 015-richer-book-metadata: every `date:` value the contract names, as Obsidian
// hands it to a plugin (research R1: dates arrive as the text typed; a bare
// year as a number). Shared by tests/book-date.test.ts (what the book carries)
// and tests/book-details.test.ts (one warning per unusable value, SC-004), so
// the two cannot drift apart. Source: contracts/note-properties.md "Dates" and
// research R4.

/** Values the book carries, paired with the date it carries. */
export const ACCEPTED_DATES: [raw: unknown, expected: string][] = [
  ["2024-01-15", "2024-01-15"],
  ["2024-01", "2024-01"],
  [2024, "2024"],
  ["2024", "2024"],
  ["0800", "0800"],
  ["2024-01-15T09:30", "2024-01-15"],
  ["2024-01-15 09:30", "2024-01-15"],
  ["2024-01-15T09:30:00Z", "2024-01-15"],
  ["2024-01-15T09:30:15.5+07:00", "2024-01-15"],
  ["2024-01-15T23:59:59-05:00", "2024-01-15"],
  ["2024-02-29", "2024-02-29"],
  ["2000-02-29", "2000-02-29"],
  ["1582-10-04", "1582-10-04"],
  ["1582-10-15", "1582-10-15"],
  ["0001-01-01", "0001-01-01"],
  ["  2024-01-15  ", "2024-01-15"],
  [["", "2024-01-15", "2025-01-01"], "2024-01-15"],
  [[2024], "2024"],
];

/** Values that mean "no date", silently (FR-009). */
export const ABSENT_DATES: unknown[] = [undefined, null, "", "   ", [], [null, ""]];

/** Values that are left out with one warning (FR-005, FR-010). */
export const UNUSABLE_DATES: unknown[] = [
  "2023-02-29",
  "1900-02-29",
  "2024-02-30",
  "2024-04-31",
  "2024-13",
  "2024-00",
  "2024-01-00",
  "0000",
  "0000-01-01",
  "1582-10-05",
  "1582-10-10",
  "1582-10-14",
  "2024-01-15T25:00",
  "2024-01-15T09:60",
  "2024-01-15T09:30:60",
  "2024-01-15Tnoon",
  "2024-01-15T09:30+7",
  "2024-01-15  09:30",
  "24-01-15",
  "2024-1-5",
  "01/02/2024",
  "15/01/2024",
  "January 2024",
  "next spring",
  24,
  800,
  1.5,
  20240115,
  0,
  -3,
  "24",
  "800",
  { a: 1 },
  true,
  // The first non-empty item of a list decides; a later good one does not rescue it.
  ["next spring", "2024-01-15"],
  // A list inside the list is not a date.
  [["2024-01-15"]],
];
