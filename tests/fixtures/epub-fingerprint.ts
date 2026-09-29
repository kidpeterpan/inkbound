// Per-entry fingerprints of a finished EPUB, for "is this book identical?" checks.
//
// Whole-file comparison cannot work: every export writes a fresh urn:uuid package
// identifier and a fresh dcterms:modified date into OEBPS/package.opf, so two
// exports of the SAME vault by UNCHANGED code differ as files (found while recording
// the 011 baseline — package.opf was the only entry that differed). Those two values
// are normalised before hashing; every other entry is hashed as decompressed bytes.
// Zip container details (timestamps, ordering) are deliberately not part of the
// fingerprint either.

import { createHash } from "node:crypto";
import JSZip from "jszip";

const IDENTIFIER = /(<dc:identifier id="uid">)urn:uuid:[^<]*(<\/dc:identifier>)/;
const MODIFIED = /(<meta property="dcterms:modified">)[^<]*(<\/meta>)/;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Normalises the two values every export sets afresh; a no-op for other entries. */
export function normalisePackageDocument(opf: string): string {
  return opf.replace(IDENTIFIER, "$1urn:uuid:<normalised>$2").replace(MODIFIED, "$1<normalised>$2");
}

/** entry name -> sha256 of its (normalised) decompressed content, directories skipped. */
export async function epubEntryFingerprints(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (name.endsWith("package.opf")) {
      out[name] = sha256(normalisePackageDocument(await entry.async("string")));
    } else {
      out[name] = sha256(await entry.async("uint8array"));
    }
  }
  return out;
}
