// 015-richer-book-metadata: the book details' lines in package.opf
// (specs/015-richer-book-metadata/contracts/package-metadata.md).
import { describe, expect, it } from "vitest";
import { detailsMetadataXml } from "../src/core/epub/package-details";

describe("detailsMetadataXml: a book with no details", () => {
  it("writes nothing when there are no details at all", () => {
    expect(detailsMetadataXml(undefined)).toBe("");
  });

  it("writes nothing for an empty set of details", () => {
    expect(detailsMetadataXml({})).toBe("");
  });
});

describe("detailsMetadataXml: description, publisher, date (US1)", () => {
  it("writes one line per field, in contract order, each on its own indented line", () => {
    const xml = detailsMetadataXml({
      description: "A field guide to tidal pools",
      publisher: "Tide Press",
      date: "2024-01-15",
    });

    expect(xml).toBe(
      "\n    <dc:description>A field guide to tidal pools</dc:description>" +
        "\n    <dc:publisher>Tide Press</dc:publisher>" +
        "\n    <dc:date>2024-01-15</dc:date>"
    );
  });

  it("escapes markup characters and apostrophes", () => {
    const xml = detailsMetadataXml({ description: "<b>bold</b> & **stars**", publisher: "Pan's Press" });

    expect(xml).toContain("<dc:description>&lt;b&gt;bold&lt;/b&gt; &amp; **stars**</dc:description>");
    expect(xml).toContain("<dc:publisher>Pan&apos;s Press</dc:publisher>");
  });

  it("writes a line break and Thai text as they are", () => {
    expect(detailsMetadataXml({ description: "บรรทัดแรก\nบรรทัดสอง" })).toBe(
      "\n    <dc:description>บรรทัดแรก\nบรรทัดสอง</dc:description>"
    );
  });

  it("writes no line for a field that is absent", () => {
    expect(detailsMetadataXml({ date: "2024" })).toBe("\n    <dc:date>2024</dc:date>");
  });
});

describe("detailsMetadataXml: series (US3)", () => {
  it("writes both series forms with the position", () => {
    expect(detailsMetadataXml({ series: { name: "Tidal Notes", position: 2 } })).toBe(
      '\n    <meta property="belongs-to-collection" id="book-series">Tidal Notes</meta>' +
        '\n    <meta refines="#book-series" property="collection-type">series</meta>' +
        '\n    <meta refines="#book-series" property="group-position">2</meta>' +
        '\n    <meta name="calibre:series" content="Tidal Notes"/>' +
        '\n    <meta name="calibre:series_index" content="2"/>'
    );
  });

  it("writes a series without a position as three lines", () => {
    expect(detailsMetadataXml({ series: { name: "Tidal Notes" } })).toBe(
      '\n    <meta property="belongs-to-collection" id="book-series">Tidal Notes</meta>' +
        '\n    <meta refines="#book-series" property="collection-type">series</meta>' +
        '\n    <meta name="calibre:series" content="Tidal Notes"/>'
    );
  });

  it.each([
    [2.5, "2.5"],
    [0, "0"],
  ])("writes the position %j as %s", (position, text) => {
    const xml = detailsMetadataXml({ series: { name: "S", position } });

    expect(xml).toContain(`property="group-position">${text}</meta>`);
    expect(xml).toContain(`<meta name="calibre:series_index" content="${text}"/>`);
  });

  it("escapes the name in the element text and in the content attribute", () => {
    const xml = detailsMetadataXml({ series: { name: 'A "B" & C' } });

    expect(xml).toContain('id="book-series">A &quot;B&quot; &amp; C</meta>');
    expect(xml).toContain('<meta name="calibre:series" content="A &quot;B&quot; &amp; C"/>');
  });

  it("puts the series after the date", () => {
    const xml = detailsMetadataXml({ date: "2024", series: { name: "S" } });

    expect(xml.indexOf("<dc:date>")).toBeLessThan(xml.indexOf("belongs-to-collection"));
  });
});

describe("detailsMetadataXml: subjects (US4)", () => {
  it("writes one escaped dc:subject per subject, in order", () => {
    expect(detailsMetadataXml({ subjects: ["history", "R&D <lab>"] })).toBe(
      "\n    <dc:subject>history</dc:subject>\n    <dc:subject>R&amp;D &lt;lab&gt;</dc:subject>"
    );
  });

  it("puts the subjects after the date and before the series", () => {
    const xml = detailsMetadataXml({ date: "2024", subjects: ["s"], series: { name: "S" } });

    expect(xml.indexOf("<dc:date>")).toBeLessThan(xml.indexOf("<dc:subject>"));
    expect(xml.indexOf("<dc:subject>")).toBeLessThan(xml.indexOf("belongs-to-collection"));
  });
});
