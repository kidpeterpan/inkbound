export function slugify(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return cleaned.length > 0 ? cleaned : "export";
}

// Default rule: the filename is the title. Precedence among
// basename / frontmatter alias / first H1 is a product decision —
// revisited in Task 11 (USER CONTRIBUTION).
// MUST never throw: main.ts calls this on the export-failure path (a throwing title aborts the whole export).
export function deriveChapterTitle(
  basename: string,
  _aliases: string[] | undefined,
  _firstH1: string | undefined
): string {
  return basename;
}
