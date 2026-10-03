// The review pack's decision logic: what changed in the fixture books since the
// last recorded baseline, and what that means for the manual device pass.
//
// WHY THIS EXISTS: the plugin's worst documented failure mode is a green gate
// with a broken book (1.7.0 and 1.7.1 shipped with desktop export dead while
// every check passed), because CI renders through the marked-based stub and
// never touches real Obsidian. The manual pass in real Obsidian on a real
// e-reader is the only check that can catch that, and left to prose it is the
// step most likely to be skipped. This turns it into: "nothing changed, there
// is nothing new to look at" or "these 3 entries changed — look at these".
//
// PURE MODULE: no fs, no child processes, no network. It takes fingerprints and
// a fixture header and returns lines; scripts/review-pack.ts does the I/O.

/** Entry path ("OEBPS/text/chapter_001.xhtml") -> content hash. */
export type Fingerprints = Record<string, string>;

export interface BookDiff {
  book: string;
  /** Entries the current export has that the baseline did not. */
  added: string[];
  /** Entries the baseline had that the current export no longer has. */
  removed: string[];
  /** Entries present in both whose content hash differs. */
  changed: string[];
}

/** What the real-render fixtures say about the Obsidian they came from. */
export interface FixtureHeader {
  obsidianVersion: string | null;
  capturedAt: string | null;
}

/**
 * Reads the header of a captured real-render fixture. Tolerant on purpose: an
 * older fixture may predate a field, and a review pack that refused to run
 * because of a missing date would be worse than one that says "unknown".
 */
export function fixtureHeader(raw: unknown): FixtureHeader {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  return { obsidianVersion: text(obj.obsidianVersion), capturedAt: text(obj.capturedAt) };
}

/** Every difference in one book, in a stable order (sorted entry names). */
export function diffBook(book: string, baseline: Fingerprints, current: Fingerprints): BookDiff {
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of names) {
    const was = baseline[name];
    const is = current[name];
    if (was === undefined) added.push(name);
    else if (is === undefined) removed.push(name);
    else if (was !== is) changed.push(name);
  }
  return { book, added, removed, changed };
}

/** Every book's differences — including a book that only one side has. */
export function diffBooks(
  baseline: Record<string, Fingerprints>,
  current: Record<string, Fingerprints>
): BookDiff[] {
  const books = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  return books.map((book) => diffBook(book, baseline[book] ?? {}, current[book] ?? {}));
}

export function isClean(diff: BookDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * The lines a reviewer reads. The point of the wording is to make the next
 * step unambiguous in both directions: a clean pack says outright that there
 * is nothing new to look at (so skipping the pass is a decision, not an
 * oversight), and a dirty one names exactly which entries to check on the
 * device.
 */
export function reviewLines(diffs: BookDiff[], fixture: FixtureHeader): string[] {
  const lines: string[] = [];

  const dirty = diffs.filter((diff) => !isClean(diff));
  if (dirty.length === 0) {
    lines.push("Nothing changed in the fixture books since the recorded baseline.");
    lines.push("There is nothing NEW for the device pass to look at — re-checking the");
    lines.push("existing book is still the only way to catch a real-Obsidian regression.");
  } else {
    lines.push("These fixture books changed since the recorded baseline — device-check them:");
    for (const diff of dirty) {
      lines.push(`  ${diff.book}`);
      for (const entry of diff.changed) lines.push(`    changed: ${entry}`);
      for (const entry of diff.added) lines.push(`    added:   ${entry}`);
      for (const entry of diff.removed) lines.push(`    removed: ${entry}`);
    }
    lines.push("A changed chapter or asset is what the manual pass in real Obsidian is for.");
  }

  lines.push("");
  const version = fixture.obsidianVersion ?? "unknown";
  const captured = fixture.capturedAt ?? "an unknown date";
  lines.push(`Real-render fixtures: captured from Obsidian ${version} on ${captured}.`);
  lines.push("Run `npm run check-obsidian-drift` to see whether that is behind the newest");
  lines.push("Obsidian release; if it is, re-capture before trusting the device pass.");

  return lines;
}
