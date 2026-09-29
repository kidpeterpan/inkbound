// Pure (no "obsidian" import): the one place that turns a thrown value into
// the text a warning or notice shows. Anything can be thrown in JavaScript —
// this repo's own test fakes throw bare strings — so every catch that talks
// to the reader goes through here instead of re-deriving the same ternary.
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
