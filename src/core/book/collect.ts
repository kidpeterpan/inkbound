const NN = /^(\d+)_/;

export function orderChapters(basenames: string[]): string[] {
  const numbered = basenames.filter((b) => NN.test(b));
  const rest = basenames.filter((b) => !NN.test(b));
  numbered.sort((a, b) => parseInt(NN.exec(a)![1], 10) - parseInt(NN.exec(b)![1], 10));
  rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...numbered, ...rest];
}

// 009-index-order-parts (research R6): orderChapters' rule over items that
// carry a name, so a folder's unlinked notes AND unlinked subfolders can be
// ordered together (FR-012) — a subfolder participates under its folder name.
// Same comparison as orderChapters on purpose (plain code-point order, so
// uppercase sorts before lowercase): "today's order" is defined by that
// function, and this must agree with it for every list of plain strings.
// Array.prototype.sort is stable, so equal names keep input order.
export function orderByName<T>(items: T[], key: (item: T) => string): T[] {
  const numbered = items.filter((i) => NN.test(key(i)));
  const rest = items.filter((i) => !NN.test(key(i)));
  numbered.sort((a, b) => parseInt(NN.exec(key(a))![1], 10) - parseInt(NN.exec(key(b))![1], 10));
  rest.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return [...numbered, ...rest];
}

/**
 * Whether a note's tags mark it as a book's index note. Shared by pickIndexNote
 * and by the rule that decides which folders are books when the whole library
 * is exported (016), so "a book" means the same thing in both.
 */
export function hasBookIndexTags(tags: readonly string[]): boolean {
  return tags.includes("book") && tags.includes("main");
}

export function pickIndexNote(
  candidates: readonly { basename: string; tags: string[] }[],
  folderName: string
): string | null {
  const tagged = candidates.find((c) => hasBookIndexTags(c.tags));
  if (tagged) return tagged.basename;
  const named = candidates.find((c) => c.basename === folderName);
  return named ? named.basename : null;
}

/** What one link walk reached: the book's chapters, and what the marker kept out. */
export interface LinkedWalk {
  /** The notes the book will contain: the start note first, then level by level, each level sorted. */
  chapters: string[];
  /**
   * 017-note-exclusion FR-007: the left-out notes the walk REACHED — the ones
   * this book would otherwise have contained — in the order it reached them. A
   * marked note the walk never touched is not named, because it was never going
   * to be in this book.
   */
  leftOut: string[];
}

/**
 * The notes a note + linked notes export will use, in reading order, out to
 * `depth` hops (was `bfsLinked`; renamed in 017 because it answers two questions
 * now, and because a walk that cannot pass through a left-out note is a
 * different traversal rather than a filter applied afterwards).
 *
 * `isLeftOut` is REQUIRED and consulted only for notes the walk actually
 * reaches: pruning the graph up front instead would mean asking about every
 * note in the vault, since `links` is the whole vault's link graph (research
 * R5). It is required rather than defaulted because every caller has a marker
 * concept — a caller that has none passes `() => false`, which says so at the
 * call site instead of hiding it in this module. The START note is never tested:
 * the reader asked for it by name, and its own links are still followed (FR-005).
 */
export function walkLinkedNotes(
  links: Record<string, Record<string, number>>,
  start: string,
  depth: number,
  isLeftOut: (path: string) => boolean
): LinkedWalk {
  const seen = new Set<string>([start]);
  const chapters: string[] = [start];
  const leftOut: string[] = [];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of Object.keys(links[node] ?? {})) {
        if (!target.endsWith(".md") || seen.has(target)) continue;
        seen.add(target);
        // Recorded, and deliberately NOT added to the frontier: a left-out note
        // is never walked through, so a note reachable only through one is not
        // pulled into the book (FR-004).
        if (isLeftOut(target)) leftOut.push(target);
        else next.push(target);
      }
    }
    next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    chapters.push(...next);
    frontier = next;
  }
  return { chapters, leftOut };
}
