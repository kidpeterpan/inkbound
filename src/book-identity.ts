// The book's identity: the one place the export pipeline reads the system
// clock and the RNG.
//
// Everything downstream takes a BookIdentity as an argument, so a caller that
// needs a reproducible artifact can hand over a fixed one — which is what
// makes "export the same vault twice, get the same bytes" testable
// (tests/book-identity.test.ts). Without this, every export embedded a fresh
// `urn:uuid` and `dcterms:modified`, and the best a test could do was compare
// two books entry by entry.
//
// PURE MODULE by this repo's rule (no `obsidian` import), though note it is an
// ADAPTER in the architectural sense: it is the only module in the export path
// that touches ambient globals. Split out of epub.ts so the assembler itself
// stays free of them.
export interface BookIdentity {
  /** The `urn:uuid` identifier's UUID, with no scheme prefix. */
  readonly uuid: string;
  /** `dcterms:modified`, formatted as EPUB 3 requires (e.g. "2026-10-02T12:00:00Z"). */
  readonly modifiedAt: string;
  /**
   * Timestamp stamped onto every ZIP entry. JSZip would otherwise date each
   * entry with the current clock, which alone is enough to make two builds of
   * the same book differ.
   */
  readonly zipDate: Date;
}

/** A fresh identity for a real export: current time, random UUID. */
export function systemBookIdentity(): BookIdentity {
  const now = new Date();
  return {
    uuid: cryptoRandomUuid(),
    modifiedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    zipDate: now,
  };
}

function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // RFC-4122 v4 UUID fallback: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
