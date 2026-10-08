// The reproducibility contract for a built book (src/core/epub/book-identity.ts).
//
// Why this exists: an export used to embed a fresh `urn:uuid`, a fresh
// `dcterms:modified` AND a fresh ZIP-entry timestamp per entry, so the best
// documented guarantee was "no book is byte-identical between two exports —
// compare entry by entry" (CLAUDE.md, tests/fixtures/epub-fingerprint.ts).
// Injecting the identity makes the artifact reproducible, which is what lets
// these tests compare the actual bytes instead of fingerprinting around them.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { EpubBuilder } from "../src/core/epub/epub";
import { systemBookIdentity, type BookIdentity } from "../src/core/epub/book-identity";

const META = { title: "ทดสอบ & Book", author: "Pan", language: "th" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Fixed, and deliberately far from "now": an entry stamped with the current
// clock cannot accidentally match these values, so the ZIP-date assertion
// below fails loudly if anyone ever adds a ZIP entry that bypasses addEntry.
const FIXED_IDENTITY: BookIdentity = {
  uuid: "00000000-1111-4222-8333-444444444444",
  modifiedAt: "2001-01-01T00:00:00Z",
  zipDate: new Date("2001-01-01T00:00:00Z"),
};

async function buildBook(identity: BookIdentity): Promise<Uint8Array> {
  const builder = new EpubBuilder(META, identity);
  builder.addChapter("Intro", "<p>hello</p>");
  builder.addChapter("Second", "<p>world</p>");
  builder.addAsset("images/img_001.png", new Uint8Array([1, 2, 3]), "image/png");
  return builder.build();
}

/** Runs `body` with globalThis.crypto replaced, then restores it exactly. */
function withCryptoReplaced<T>(value: unknown, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value, configurable: true });
  try {
    return body();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

describe("a fixed identity makes the built book byte-identical", () => {
  it("produces the same bytes twice", async () => {
    const first = await buildBook(FIXED_IDENTITY);
    const second = await buildBook(FIXED_IDENTITY);
    expect(second).toEqual(first);
  });

  it("produces different bytes once any part of the identity changes", async () => {
    const base = await buildBook(FIXED_IDENTITY);
    const otherUuid = await buildBook({
      ...FIXED_IDENTITY,
      uuid: "11111111-1111-4111-8111-111111111111",
    });
    const otherDate = await buildBook({
      ...FIXED_IDENTITY,
      zipDate: new Date("2002-02-02T00:00:00Z"),
    });
    expect(otherUuid).not.toEqual(base);
    expect(otherDate).not.toEqual(base);
  });

  it("stamps every ZIP entry with the identity's date, not the current clock", async () => {
    const zip = await JSZip.loadAsync(await buildBook(FIXED_IDENTITY));
    // Directory entries carry no date of their own, so assert over files only.
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    expect(entries.length).toBeGreaterThan(5); // mimetype, container, opf, nav, css, 2 chapters, 1 asset

    for (const entry of entries) {
      // ZIP stores timestamps in 2-second DOS units, hence the slack.
      const drift = Math.abs((entry.date?.getTime() ?? 0) - FIXED_IDENTITY.zipDate.getTime());
      expect(drift, `${entry.name} entry timestamp`).toBeLessThan(2000);
    }
  });

  it("writes the injected uuid and modified timestamp into package.opf", async () => {
    const zip = await JSZip.loadAsync(await buildBook(FIXED_IDENTITY));
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(opf).toContain(`urn:uuid:${FIXED_IDENTITY.uuid}`);
    expect(opf).toContain(`<meta property="dcterms:modified">${FIXED_IDENTITY.modifiedAt}</meta>`);
  });
});

describe("systemBookIdentity", () => {
  it("mints a v4 UUID, a fractional-second-free EPUB timestamp, and one date for the ZIP", () => {
    const identity = systemBookIdentity();
    expect(identity.uuid).toMatch(UUID_V4);
    // EPUB 3 requires CCYY-MM-DDThh:mm:ssZ.
    expect(identity.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(identity.modifiedAt).toBe(identity.zipDate.toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("falls back to a local v4 UUID when Web Crypto is absent", () => {
    const uuid = withCryptoReplaced(undefined, () => systemBookIdentity().uuid);
    expect(uuid).toMatch(UUID_V4);
  });

  it("falls back to a local v4 UUID when Web Crypto has no randomUUID", () => {
    const uuid = withCryptoReplaced({ getRandomValues: () => undefined }, () => systemBookIdentity().uuid);
    expect(uuid).toMatch(UUID_V4);
  });
});
