// XML text escaping, shared by every module that builds markup: the EPUB
// assembler, the backlink trail, and main.ts's failed-chapter placeholder.
//
// A leaf module on purpose. backlinks.ts is a pure renderer with zero
// "obsidian" imports, and before this file existed it had to import the EPUB
// assembler (epub.ts) just to escape an "&" — a dependency that said nothing
// true about what backlinks.ts needs.
//
// 018-xml-text-encodability: this is also where the rule for characters XML 1.0
// cannot hold lives, so that every interpolated, note-derived value — the title,
// the author, chapter titles, the table of contents, the backlink trails, and
// 015's book details — is cleaned and escaped in one call. The rule moved here
// from book-details.ts, which now imports it; docs/DEVELOPMENT.md's known-gap
// note said the fix belonged in the shared escaping.

/**
 * Replaces every character XML 1.0 cannot hold with a single space.
 *
 * Obsidian hands control characters to a plugin unchanged, and one of them in a
 * document is a FATAL epubcheck error: a form feed pasted from a PDF would break
 * the book (015 research R13). Each becomes a space, not nothing, so two words it
 * separated stay two words. Silent, because the character is invisible in the
 * note.
 *
 * Walked by code point rather than matched with a regex: spotting an unpaired
 * surrogate with a regex needs a lookbehind, which older iOS WebViews reject as
 * a syntax error at load time.
 */
export function replaceUnencodable(text: string): string {
  let cleaned = "";
  for (const character of text) cleaned += isEncodable(character) ? character : " ";
  return cleaned;
}

/** Whether XML 1.0, and so an EPUB package, can hold this character. */
function isEncodable(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  const isTabOrLineBreak = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd;
  if (isTabOrLineBreak) return true;
  if (codePoint < 0x20) return false;
  const isUnpairedSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (isUnpairedSurrogate) return false;
  return codePoint !== 0xfffe && codePoint !== 0xffff;
}

export function escapeXml(s: string): string {
  // Replacement FIRST, then escaping: what gets escaped is the clean text, so a
  // forbidden character can never be reintroduced as markup.
  return replaceUnencodable(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
