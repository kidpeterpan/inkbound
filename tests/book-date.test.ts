// 015-richer-book-metadata: the date grammar (research R4). Every value the
// book writes must be one the EPUB 3 spec gate accepts (research R2), and a
// value that is not clearly a date is left out, never guessed.
import { describe, expect, it } from "vitest";
import { parseBookDate } from "../src/core/book/book-date";
import { ABSENT_DATES, ACCEPTED_DATES, UNUSABLE_DATES } from "./fixtures/date-cases";

const label = (raw: unknown) => JSON.stringify(raw) ?? String(raw);

describe("parseBookDate: values the book carries", () => {
  it.each(ACCEPTED_DATES.map(([raw, expected]) => [label(raw), raw, expected] as const))(
    "%s → its calendar date",
    (_label, raw, expected) => {
      expect(parseBookDate(raw)).toEqual({ kind: "value", value: expected });
    }
  );
});

describe("parseBookDate: values that mean no date", () => {
  it.each(ABSENT_DATES.map((raw) => [label(raw), raw] as const))("%s → absent", (_label, raw) => {
    expect(parseBookDate(raw)).toEqual({ kind: "absent" });
  });
});

describe("parseBookDate: values that are not clearly a date", () => {
  it.each(UNUSABLE_DATES.map((raw) => [label(raw), raw] as const))("%s → unusable", (_label, raw) => {
    expect(parseBookDate(raw)).toEqual({ kind: "unusable" });
  });
});
