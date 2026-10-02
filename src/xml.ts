// XML text escaping, shared by every module that builds markup: the EPUB
// assembler, the backlink trail, and main.ts's failed-chapter placeholder.
//
// A leaf module on purpose. backlinks.ts is a pure renderer with zero
// "obsidian" imports, and before this file existed it had to import the EPUB
// assembler (epub.ts) just to escape an "&" — a dependency that said nothing
// true about what backlinks.ts needs.
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
