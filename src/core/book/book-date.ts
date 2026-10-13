// 015-richer-book-metadata — reads a note's `date` property as the date of the
// book's content (specs/015-richer-book-metadata/research.md R4).
//
// Pure module: zero `obsidian` imports (constitution IV). The book always gets
// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; anything that is not clearly one of those
// is left out, never guessed (spec FR-005).
//
// Deliberately NOT Date.parse: it reads `01/02/2024` by locale and rolls
// `2024-02-30` over to 1 March, which is exactly the guessing FR-005 forbids.
// Obsidian hands dates over as the text typed (research R1), so the text is
// checked as written.

/** What reading one property gave: a usable value, nothing at all, or something unusable. */
export type FieldRead<T> = { kind: "value"; value: T } | { kind: "absent" } | { kind: "unusable" };

const ABSENT: FieldRead<never> = { kind: "absent" };
const UNUSABLE: FieldRead<never> = { kind: "unusable" };

// YYYY, YYYY-MM or YYYY-MM-DD, the last optionally followed by `T` or one
// space and a time of day, which is checked and then dropped.
const DATE_TEXT = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](.+))?)?)?$/;

// HH:MM, optional :SS and fraction, optional Z or ±HH:MM.
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)?$/;

export function parseBookDate(raw: unknown): FieldRead<string> {
  if (Array.isArray(raw)) return dateFromFirstListItem(raw);
  return dateFromScalar(raw);
}

// The first item that says anything decides, the way a list of `aliases`
// gives the title; a later good item does not rescue an unusable first one.
function dateFromFirstListItem(items: unknown[]): FieldRead<string> {
  for (const item of items) {
    if (Array.isArray(item)) return UNUSABLE;
    const read = dateFromScalar(item);
    if (read.kind !== "absent") return read;
  }
  return ABSENT;
}

function dateFromScalar(raw: unknown): FieldRead<string> {
  if (raw === null || raw === undefined) return ABSENT;
  if (typeof raw === "number") return yearFromNumber(raw);
  if (typeof raw !== "string") return UNUSABLE;
  const text = raw.trim();
  if (text === "") return ABSENT;
  return dateFromText(text);
}

// YAML gives `date: 2024` as a number. Only a four-digit year counts: `24`
// could mean 2024 as easily as the year 24 (research R4).
function yearFromNumber(value: number): FieldRead<string> {
  if (!Number.isInteger(value) || value < 1000 || value > 9999) return UNUSABLE;
  return { kind: "value", value: String(value) };
}

function dateFromText(text: string): FieldRead<string> {
  const match = DATE_TEXT.exec(text);
  if (!match) return UNUSABLE;
  const [, yearText, monthText, dayText, timeText] = match;
  if (timeText !== undefined && !TIME_OF_DAY.test(timeText)) return UNUSABLE;
  if (!isCalendarDate(Number(yearText), toNumber(monthText), toNumber(dayText))) return UNUSABLE;

  const calendarDate = [yearText, monthText, dayText].filter((part) => part !== undefined).join("-");
  return { kind: "value", value: calendarDate };
}

function toNumber(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number(text);
}

/** A year, a year and month, or a full date that the EPUB 3 spec gate accepts. */
function isCalendarDate(year: number, month: number | undefined, day: number | undefined): boolean {
  if (year === 0) return false; // epubcheck rejects year 0000 (research R2)
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return !isInCalendarGap(year, month, day);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

// Proleptic Gregorian. Before 1582 epubcheck validates with the Julian rule,
// whose leap years include every Gregorian one, so a date accepted here is
// never one it rejects.
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// epubcheck's calendar switches from Julian to Gregorian on 1582-10-15, so
// the ten days before it do not exist there and a book carrying one fails
// validation (research R2). They are refused rather than shifted.
function isInCalendarGap(year: number, month: number, day: number): boolean {
  return year === 1582 && month === 10 && day >= 5 && day <= 14;
}
