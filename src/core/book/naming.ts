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
  return cleaned.length > 0 ? cleaned : "export";
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
