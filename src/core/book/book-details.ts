// 015-richer-book-metadata — what a note's properties say about its book
// beyond title, author, language and cover: description, publisher, date,
// series and subjects.
//
// Pure module: zero `obsidian` imports (constitution IV). It sits beside
// metadata.ts rather than inside it because the rules here (value shapes, the
// date grammar, warnings for values that cannot be used) are their own
// concern with their own test tables, and metadata.ts's result shape is pinned
// by its tests (research R6).
//
// Only the six named properties are read. A note's tags never become subjects:
// tags organise a vault, and `book`/`main` already mark a folder's index note
// (spec Q1, FR-008).
import type { BookDetails, SeriesMembership } from "../types";
import { parseBookDate, type FieldRead } from "./book-date";
import { replaceUnencodable } from "../common/xml";

/** One property, or one `subjects` item, that was present but could not be used. */
export interface MetaIssue {
  property: "description" | "publisher" | "date" | "series" | "series_index" | "subjects";
  /** True when the problem is one item of the `subjects` list, not the whole property. */
  item: boolean;
  /** The value as Obsidian handed it over. */
  value: unknown;
  reason: "not-text" | "not-a-date" | "not-a-position" | "not-text-or-list";
}

export interface ResolvedBookDetails {
  details: BookDetails;
  issues: MetaIssue[];
}

type Properties = Record<string, unknown>;

/** Reads the book details from a note's frontmatter. Never throws. */
export function resolveBookDetails(frontmatter: Properties | undefined): ResolvedBookDetails {
  const properties = frontmatter ?? {};
  const resolved: ResolvedBookDetails = { details: {}, issues: [] };
  readTextProperty(properties, "description", resolved);
  readTextProperty(properties, "publisher", resolved);
  readDateProperty(properties, resolved);
  readSeriesProperties(properties, resolved);
  readSubjectsProperty(properties, resolved);
  return resolved;
}

/** True when the details hold at least one field worth writing into the book. */
export function hasBookDetails(details: BookDetails): boolean {
  return Object.keys(details).length > 0;
}

function readTextProperty(
  properties: Properties,
  property: "description" | "publisher",
  resolved: ResolvedBookDetails
): void {
  const raw = properties[property];
  const read = readText(raw);
  if (read.kind === "value") resolved.details[property] = read.value;
  if (read.kind === "unusable") resolved.issues.push(propertyIssue(property, raw, "not-text"));
}

function readDateProperty(properties: Properties, resolved: ResolvedBookDetails): void {
  const read = parseBookDate(properties.date);
  if (read.kind === "value") resolved.details.date = read.value;
  if (read.kind === "unusable") resolved.issues.push(propertyIssue("date", properties.date, "not-a-date"));
}

function readSeriesProperties(properties: Properties, resolved: ResolvedBookDetails): void {
  const name = readText(properties.series);
  if (name.kind === "unusable") resolved.issues.push(propertyIssue("series", properties.series, "not-text"));
  // A position means nothing without a series, so with no usable name it is
  // not read at all, not even to warn about it (FR-007).
  if (name.kind !== "value") return;

  const series: SeriesMembership = { name: name.value };
  const position = readPosition(properties.series_index);
  if (position.kind === "value") series.position = position.value;
  if (position.kind === "unusable") {
    resolved.issues.push(propertyIssue("series_index", properties.series_index, "not-a-position"));
  }
  resolved.details.series = series;
}

function readSubjectsProperty(properties: Properties, resolved: ResolvedBookDetails): void {
  const { candidates, issues } = subjectCandidates(properties.subjects);
  resolved.issues.push(...issues);
  const subjects = normalizeSubjects(candidates);
  if (subjects.length > 0) resolved.details.subjects = subjects;
}

interface SubjectCandidates {
  candidates: string[];
  issues: MetaIssue[];
}

/** The raw subject texts: one per list item, or one for a single text or number. */
function subjectCandidates(raw: unknown): SubjectCandidates {
  if (Array.isArray(raw)) return subjectListCandidates(raw);
  const read = readScalarText(raw);
  if (read.kind === "unusable")
    return { candidates: [], issues: [propertyIssue("subjects", raw, "not-text-or-list")] };
  return { candidates: read.kind === "value" ? [read.value] : [], issues: [] };
}

// Each item through readScalarText, not readText: here a nested list is an item
// that is not text, and is reported, rather than a list whose first item is taken.
function subjectListCandidates(items: unknown[]): SubjectCandidates {
  const result: SubjectCandidates = { candidates: [], issues: [] };
  for (const item of items) {
    const read = readScalarText(item);
    if (read.kind === "value") result.candidates.push(read.value);
    if (read.kind === "unusable") result.issues.push(subjectItemIssue(item));
  }
  return result;
}

// One leading `#` comes off (a subject pasted from a tag), nesting stays as
// written, and a repeat that differs only in case keeps the first spelling.
function normalizeSubjects(candidates: string[]): string[] {
  const seenLowerCase = new Set<string>();
  const subjects: string[] = [];
  for (const candidate of candidates) {
    const subject = withoutLeadingHash(candidate).trim();
    const lowerCase = subject.toLowerCase();
    if (subject === "" || seenLowerCase.has(lowerCase)) continue;
    seenLowerCase.add(lowerCase);
    subjects.push(subject);
  }
  return subjects;
}

function withoutLeadingHash(text: string): string {
  return text.startsWith("#") ? text.slice(1) : text;
}

function propertyIssue(
  property: MetaIssue["property"],
  value: unknown,
  reason: MetaIssue["reason"]
): MetaIssue {
  return { property, item: false, value, reason };
}

function subjectItemIssue(value: unknown): MetaIssue {
  return { property: "subjects", item: true, value, reason: "not-text" };
}

// ── reading one value ────────────────────────────────────────────────────

const ABSENT: FieldRead<never> = { kind: "absent" };
const UNUSABLE: FieldRead<never> = { kind: "unusable" };

/**
 * A text property (research R5): text is cleaned and trimmed, a number is
 * used as its text (FR-004a), a list gives its first item that has text, and
 * a map or a boolean cannot be used.
 */
function readText(raw: unknown): FieldRead<string> {
  if (Array.isArray(raw)) return firstTextInList(raw);
  return readScalarText(raw);
}

function firstTextInList(items: unknown[]): FieldRead<string> {
  for (const item of items) {
    const read = readText(item);
    if (read.kind === "value") return read;
  }
  return ABSENT;
}

function readScalarText(raw: unknown): FieldRead<string> {
  if (raw === null || raw === undefined) return ABSENT;
  if (typeof raw === "number") return textValue(String(raw));
  if (typeof raw !== "string") return UNUSABLE;
  return textValue(raw);
}

function textValue(text: string): FieldRead<string> {
  const cleaned = replaceUnencodable(text).trim();
  return cleaned === "" ? ABSENT : { kind: "value", value: cleaned };
}

// A whole or decimal number written out plainly: `2`, `2.5`. Not `1e3`, `-2`
// or `.5`, which name a position only by accident.
const POSITION_TEXT = /^\d+(\.\d+)?$/;

/**
 * A series position: a number zero or greater, written as a number or as
 * text. A list gives its first item that says anything (research R5).
 */
function readPosition(raw: unknown): FieldRead<number> {
  if (!Array.isArray(raw)) return readScalarPosition(raw);
  for (const item of raw) {
    if (Array.isArray(item)) return UNUSABLE;
    const read = readScalarPosition(item);
    if (read.kind !== "absent") return read;
  }
  return ABSENT;
}

function readScalarPosition(raw: unknown): FieldRead<number> {
  if (raw === null || raw === undefined) return ABSENT;
  if (typeof raw === "number") return positionValue(raw);
  if (typeof raw !== "string") return UNUSABLE;
  const text = raw.trim();
  if (text === "") return ABSENT;
  if (!POSITION_TEXT.test(text)) return UNUSABLE;
  return positionValue(Number(text));
}

function positionValue(position: number): FieldRead<number> {
  const isUsable = Number.isFinite(position) && position >= 0;
  return isUsable ? { kind: "value", value: position } : UNUSABLE;
}

// 018-xml-text-encodability: the rule for characters XML 1.0 cannot hold now
// lives in the shared XML text module (it is what the escaper applies too), and
// is applied here as well so the PREVIEW and the REPORT show the same text the
// book carries — 015's decision, unchanged. It is idempotent, so the escaper
// applying it a second time costs nothing.

const REASON_TEXT: Record<MetaIssue["reason"], string> = {
  "not-text": "is not text",
  "not-a-date": "is not a real date written as YYYY, YYYY-MM or YYYY-MM-DD",
  "not-a-position": "is not a number of 0 or more",
  "not-text-or-list": "is not text or a list",
};

/**
 * The warning a reader sees for one unusable value, in the export report and in
 * the preview alike. Shaped like the cover warnings beside it in the report
 * (`cover not found: <target> (<ref>)`).
 */
export function detailsWarning(issue: MetaIssue, notePath: string): string {
  const field = issue.item ? `${issue.property} item` : issue.property;
  return `${field} left out: ${shownValue(issue.value)} ${REASON_TEXT[issue.reason]} (${notePath})`;
}

// A value is shown as JSON so its type is visible ("2024" vs 2024, a map as
// {"a":1}), and cut so that one huge property cannot flood the report.
const MAX_SHOWN_LENGTH = 60;

function shownValue(value: unknown): string {
  // JSON.stringify gives undefined for a value it cannot encode; YAML never
  // produces one, but a warning must not be the thing that throws.
  const json = JSON.stringify(value) ?? String(value);
  if (json.length <= MAX_SHOWN_LENGTH) return json;
  return `${json.slice(0, MAX_SHOWN_LENGTH - 1)}…`;
}
