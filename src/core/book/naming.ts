import { firstNonEmptyString } from "./metadata";
import { stripFootnoteRefs } from "../content/footnote-refs";
import { replaceUnencodable } from "../common/xml";

/**
 * A book's file name, from its title.
 *
 * 018-xml-text-encodability: a file name is a boundary of its own — Windows
 * forbids 0x00–0x1F in one, so a character pasted from a PDF could make an
 * export FAIL rather than merely spoil a name (Constitution II). The replacement
 * runs FIRST, so the space it becomes folds into the `_` the rest of a name
 * already uses; and because `library.ts` compares the books of a run by this
 * function's output, two titles that differ only by such a character are
 * detected as the same file name.
 */
export function slugify(title: string): string {
  const cleaned = replaceUnencodable(title)
    .toLowerCase()
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  const fitted = truncateToBytes(cleaned, MAX_SLUG_BYTES).replace(/_+$/, "");
  if (fitted.length === 0) return "export";
  return WINDOWS_DEVICE_NAME.test(fitted) ? `_${fitted}` : fitted;
}

// The slug plus ".epub" must fit the 255-BYTE name limit of ext4/f2fs (Linux and
// Android; macOS and NTFS count characters, which is looser). Thai is three
// bytes a character, so a title of ~85 Thai characters used to be enough to make
// the write fail. 200 leaves room for ".epub" and for a suffix a caller adds to
// keep two books apart.
const MAX_SLUG_BYTES = 200;

// Windows reserves these device names with ANY extension ("con.epub", and also
// "con.txt.epub"), so a book titled "Con" could not be written there at all.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/;

// Cuts between code points, never inside a surrogate pair, so the result is always
// valid text. (It can separate a Thai base letter from its combining mark; the
// name stays legal, and a title that long is already being shortened.)
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let used = 0;
  let kept = "";
  for (const character of text) {
    used += encoder.encode(character).length;
    if (used > maxBytes) break;
    kept += character;
  }
  return kept;
}

// Chapter-title precedence (007-chapter-titles, resolved from the original
// plan's Task 11): first usable H1 → first usable frontmatter alias → basename.
// "Usable" = non-empty after trimming (H1), or first non-empty trimmed element
// via the same firstNonEmptyString the book-title resolver uses.
// MUST never throw: main.ts calls this on the export-failure path (a throwing
// title aborts the whole export). Resolution is total — every input maps to a
// string, so the placeholder-chapter path can always produce a title.
export function deriveChapterTitle(basename: string, aliases: unknown, firstH1: string | undefined): string {
  // 011-footnote-semantics: the H1 comes from Obsidian's metadata cache, which keeps the
  // heading's SOURCE text, so a footnote reference in it ("Title[^h]") is stripped here.
  // A heading that was only a reference falls through to the alias, then the basename.
  const h1 = typeof firstH1 === "string" ? stripFootnoteRefs(firstH1).trim() : "";
  if (h1 !== "") return h1;
  return firstNonEmptyString(aliases) ?? basename;
}
