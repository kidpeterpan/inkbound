// 015-richer-book-metadata — the book details as lines of package.opf
// (specs/015-richer-book-metadata/contracts/package-metadata.md).
//
// Pure module: zero `obsidian` imports (constitution IV). EpubBuilder.opf()
// appends what this returns to its `dc:creator` line, so a book with no
// details gets "" and its package stays byte-identical to what it was before
// this feature (research R8).
import type { BookDetails, SeriesMembership } from "../types";
import { escapeXml } from "../common/xml";

/** Each entry is written on its own line, indented to match the rest of `<metadata>`. */
const ENTRY_PREFIX = "\n    ";

export function detailsMetadataXml(details: BookDetails | undefined): string {
  if (!details) return "";
  return metadataEntries(details)
    .map((entry) => ENTRY_PREFIX + entry)
    .join("");
}

// Contract order: description, publisher, date, subjects, series.
function metadataEntries(details: BookDetails): string[] {
  return [
    ...optionalElement("dc:description", details.description),
    ...optionalElement("dc:publisher", details.publisher),
    ...optionalElement("dc:date", details.date),
    ...(details.subjects ?? []).map((subject) => element("dc:subject", subject)),
    ...seriesEntries(details.series),
  ];
}

function optionalElement(name: string, text: string | undefined): string[] {
  return text === undefined ? [] : [element(name, text)];
}

function element(name: string, text: string): string {
  return `<${name}>${escapeXml(text)}</${name}>`;
}

// Fixed: a book belongs to at most one series, and no other package entry uses
// this id (research R3).
const SERIES_ID = "book-series";

// Written twice (plan D1, research R3): the EPUB 3 collection, which is the
// standard, and Calibre's older `calibre:series` entries, which some reader
// apps read instead. epubcheck accepts the two together.
function seriesEntries(series: SeriesMembership | undefined): string[] {
  if (!series) return [];
  return [...epub3SeriesEntries(series), ...calibreSeriesEntries(series)];
}

function epub3SeriesEntries({ name, position }: SeriesMembership): string[] {
  const entries = [
    `<meta property="belongs-to-collection" id="${SERIES_ID}">${escapeXml(name)}</meta>`,
    `<meta refines="#${SERIES_ID}" property="collection-type">series</meta>`,
  ];
  if (position !== undefined) {
    entries.push(`<meta refines="#${SERIES_ID}" property="group-position">${position}</meta>`);
  }
  return entries;
}

function calibreSeriesEntries({ name, position }: SeriesMembership): string[] {
  const entries = [`<meta name="calibre:series" content="${escapeXml(name)}"/>`];
  if (position !== undefined) entries.push(`<meta name="calibre:series_index" content="${position}"/>`);
  return entries;
}
