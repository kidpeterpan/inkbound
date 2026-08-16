export function slugify(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return cleaned.length > 0 ? cleaned : "export";
}

import { firstNonEmptyString } from "./metadata";

// Chapter-title precedence (007-chapter-titles, resolved from the original
// plan's Task 11): first usable H1 → first usable frontmatter alias → basename.
// "Usable" = non-empty after trimming (H1), or first non-empty trimmed element
// via the same firstNonEmptyString the book-title resolver uses.
// MUST never throw: main.ts calls this on the export-failure path (a throwing
// title aborts the whole export). Resolution is total — every input maps to a
// string, so the placeholder-chapter path can always produce a title.
export function deriveChapterTitle(basename: string, aliases: unknown, firstH1: string | undefined): string {
  const h1 = typeof firstH1 === "string" ? firstH1.trim() : "";
  if (h1 !== "") return h1;
  return firstNonEmptyString(aliases) ?? basename;
}
