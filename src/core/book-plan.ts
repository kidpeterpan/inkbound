// The scope-planning decisions: turning what Obsidian knows about a folder's
// notes into the data and structure the pure planner consumes.
//
// These rules used to live inside main.ts's plugin class, interleaved with
// TFile walks and Notice calls, which meant the only way to test any of them
// was to run a whole export through the stubbed plugin. Here they are plain
// functions over plain data, with the Obsidian reads left to the thin
// adapter in main.ts. The rules they encode:
//
//   - normalizeTags:        frontmatter tags shape (009 Fix 3)
//   - legacyChapterOrder:   pre-009 direct-children order (research R5)
//   - orderedLinkTargets:   index-note link ordering (009 research R4)
//   - toNavItems:           position-keyed nav, parts only (009 FR-013/R2)
//   - planFolderOrder:      plan, or degrade to flat order with a warning
//                           (Constitution II / FR-016)
//
// PURE MODULE — no `obsidian` import (constitution IV), so vitest loads it
// directly. Path-keyed throughout, never basename, because two subfolders may
// hold same-named notes (FR-018).
import { orderChapters, pickIndexNote } from "./collect";
import { planBook, type FolderInput, type NavPlanNode } from "./book-tree";
import { errorMessage } from "./error-text";
import type { NavItem } from "./epub";

/** A note as the index-detection rules see it: its name, and its tags. */
export interface IndexCandidate {
  basename: string;
  tags: string[];
}

/**
 * Frontmatter `tags` can be a scalar string (e.g. `tags: handbook`) rather
 * than a list. pickIndexNote's `.includes(...)` checks are Array.prototype
 * .includes for list-shaped tags, but a string scalar would silently fall
 * through to String.prototype.includes — substring matching, which can
 * misfire ("notebook mainframe" contains both "book" and "main"). Only
 * genuine arrays count.
 */
export function normalizeTags(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * Pre-009 folder collection, direct children only: the index note (tagged
 * `book`+`main`, else the one named after the folder) leads, then NN_-prefixed
 * notes by number, then the rest alphabetically. Kept as the shape the
 * planner degrades to (research R5) and as the reference for FR-013 ("flat
 * folders export identically"). Basenames are unique within one folder, so
 * this is safe to key by name — unlike everything else, which is path-keyed.
 */
export function legacyChapterOrder(
  notes: readonly IndexCandidate[],
  folderName: string
): { indexBasename: string | null; order: string[] } {
  const indexBasename = pickIndexNote(notes, folderName);
  const chapterNames = orderChapters(
    notes.filter((note) => note.basename !== indexBasename).map((note) => note.basename)
  );
  const order = indexBasename === null ? chapterNames : [indexBasename, ...chapterNames];
  return { indexBasename, order };
}

/** One regular link of a note: its target path portion, and where it starts. */
export interface OrderedLink {
  /** The linktext's path portion — empty for `[[#heading]]` self-links. */
  path: string;
  /** Position in the note's source, used for document order. */
  startOffset: number;
}

/**
 * 009-index-order-parts (research R4): an index note's REGULAR links, in
 * document order, resolved to vault paths. The adapter passes links already
 * parsed (Obsidian's `parseLinktext`) and a resolver that returns the target
 * path only when the linktext resolves to a Markdown NOTE — embeds live in
 * `embeds` and frontmatter links in `frontmatterLinks`, so reading `links`
 * alone is what makes FR-005 ("embeds never order") hold, and the notes-only
 * filter is FR-004 (a plain link to an image inside `Part I/` would otherwise
 * resolve to a path under that folder and drag the Part with it). A link
 * repeated in the note repeats here; the planner keeps only the first.
 */
export function orderedLinkTargets(
  links: readonly OrderedLink[],
  resolveNote: (linkpath: string) => string | null
): string[] {
  const inDocumentOrder = [...links].sort((a, b) => a.startOffset - b.startOffset);
  const targets: string[] = [];
  for (const link of inDocumentOrder) {
    if (link.path === "") continue; // [[#heading]] — a link to the note itself
    const resolved = resolveNote(link.path);
    if (resolved !== null) targets.push(resolved);
  }
  return targets;
}

/**
 * Converts the planner's path-keyed nav plan into the builder's NavItem tree.
 * The result references chapters by POSITION in the chapter list (research
 * R2): runExport's hrefByPath and the failed-chapter placeholder are both
 * position-derived, so an index-keyed tree stays aligned with them for free.
 *
 * Returns undefined when the plan has no Parts at all — a flat folder keeps
 * today's flat nav, byte for byte (FR-013). A Part's title is its index
 * note's title when it has one (via `titleForNote`, which the adapter wires
 * to the metadata cache), else the folder's name.
 */
export function toNavItems(
  navPlan: readonly NavPlanNode[],
  positionByPath: ReadonlyMap<string, number>,
  titleForNote: (indexPath: string) => string
): NavItem[] | undefined {
  if (!navPlan.some((node) => node.kind === "part")) return undefined;

  const toNavItem = (node: NavPlanNode): NavItem =>
    node.kind === "chapter"
      ? { kind: "chapter", chapter: positionByPath.get(node.path)! }
      : {
          kind: "part",
          title: node.indexPath ? titleForNote(node.indexPath) : node.folderName,
          indexChapter: node.indexPath ? positionByPath.get(node.indexPath)! : null,
          children: node.children.map(toNavItem),
        };

  return navPlan.map(toNavItem);
}

/** A folder export's planned reading order, ready to map to files. */
export interface FolderPlan {
  /** Every note path in reading order — the fallback order when degraded. */
  order: string[];
  /** The nav tree, or undefined: flat folders (and fallbacks) keep flat nav. */
  nav: NavItem[] | undefined;
  warnings: string[];
}

/** The one warning text for a planning or walk failure (kept identical to
 *  what pre-009 exports emitted, because scripts/local-export.ts parses the
 *  warning console lines). */
export function chapterOrderFallbackWarning(error: unknown): string {
  return `chapter ordering fell back to filename order: ${errorMessage(error)}`;
}

/**
 * The degradation itself, in one testable place: Constitution II / FR-016 —
 * ordering is structure, not content, so a bug here degrades to the pre-009
 * flat order and says so, never aborts an export.
 */
export function degradedFolderPlan(fallbackOrder: string[], error: unknown): FolderPlan {
  return {
    order: fallbackOrder,
    nav: undefined,
    warnings: [chapterOrderFallbackWarning(error)],
  };
}

/**
 * Plans a folder export: the pure planner's order and nav, or the legacy flat
 * order with a warning if anything in the planning throws. planBook is written
 * to be total and never throw (research R5), so this guard exists for the
 * bug that has not been found yet — an unexpected throw must cost the book
 * its ordering, never the export itself.
 */
export function planFolderOrder(
  input: FolderInput,
  fallbackOrder: string[],
  titleForNote: (indexPath: string) => string
): FolderPlan {
  try {
    const plan = planBook(input);
    const positionByPath = new Map(plan.order.map((path, index) => [path, index]));
    return {
      order: plan.order,
      nav: toNavItems(plan.nav, positionByPath, titleForNote),
      warnings: [],
    };
  } catch (e) {
    return degradedFolderPlan(fallbackOrder, e);
  }
}
