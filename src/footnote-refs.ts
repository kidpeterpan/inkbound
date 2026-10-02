// Footnote-reference TEXT handling — the marker syntax only, with no DOM and
// no renderer involved. Split out of footnotes.ts so that naming.ts (chapter
// titles) can strip "[^1]" from a heading without depending on the whole
// footnote subsystem; the two must agree on the syntax, so they share this
// one definition of it.
//
// The DOM half (processFootnotes) and the source-level scan live in
// footnotes.ts; see that file's header for the full picture.
//
// PURE MODULE — no `obsidian` import, so vitest loads it directly.

// [^label] (no whitespace or ']' in the label) and simple, non-nested ^[inline note].
const FOOTNOTE_REF_SOURCE = /\[\^[^\]\s]+\]|\^\[[^\]]*\]/;

// Obsidian's metadata cache keeps a heading's SOURCE text, so "Title[^h]" would reach the
// book as a literal title. Returns the input untouched unless a reference was present —
// the byte-identical path for every ordinary heading.
export function stripFootnoteRefs(text: string): string {
  if (!FOOTNOTE_REF_SOURCE.test(text)) return text;
  return text
    .replace(new RegExp(FOOTNOTE_REF_SOURCE.source, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
