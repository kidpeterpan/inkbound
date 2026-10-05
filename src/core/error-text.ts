// Pure (no "obsidian" import): the one place that turns a thrown value into
// the text a warning or notice shows. Anything can be thrown in JavaScript —
// this repo's own test fakes throw bare strings — so every catch that talks
// to the reader goes through here instead of re-deriving the same ternary.
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The "(referenced by X)" suffix that attributes a warning to the note/chapter
// that produced it. footnotes.ts, chapter-assets.ts, math.ts and
// render-adapter.ts each report their own warnings and were independently
// re-deriving this same string template — one copy here instead of four.
export function attributedTo(sourcePath: string): (message: string) => string {
  return (message) => `${message} (referenced by ${sourcePath})`;
}
