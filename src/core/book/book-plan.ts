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
//   - tocFallbackWarning:   the flat-TOC warning text, shared with the preview
//
// PURE MODULE — no `obsidian` import (constitution IV), so vitest loads it
// directly. Path-keyed throughout, never basename, because two subfolders may
// hold same-named notes (FR-018).
import { orderChapters, pickIndexNote } from "./collect";
import { planBook, leftOutPaths, type FolderInput, type NavPlanNode } from "./book-tree";
import { errorMessage } from "../common/error-text";
import type { NavItem } from "../epub/epub";

/** A note as the index-detection rules see it: its name, and its tags. */
export interface IndexCandidate {
  basename: string;
  tags: string[];
  /**
   * 017-note-exclusion: true when the note is left out of the book. Optional,
   * and absent means "in the book" — the shape the library and Part rules pass,
   * which never need it. A left-out note is still an index CANDIDATE (FR-006):
   * the marker removes its page, not its role.
   */
  leftOut?: boolean;
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
 * 017-note-exclusion: the marker a reader puts in a note's own properties,
 * `export: false`, means "leave this note out of the book".
 *
 * Only the BOOLEAN false counts. A missing property, `true`, the string
 * "false" (a quoted value is text), a number, a list — every other shape means
 * "in the book", because the safe direction of a misread is to ship a note
 * rather than silently drop one (FR-002). Obsidian parses frontmatter as YAML,
 * so an unquoted `false` arrives here as a boolean; the test stub is taught the
 * same shape (tests/fixtures/vault-stub.ts, research R1).
 */
export function isLeftOut(frontmatter: Record<string, unknown> | undefined): boolean {
  return frontmatter?.export === false;
}

/**
 * Pre-009 folder collection, direct children only: the index note (tagged
 * `book`+`main`, else the one named after the folder) leads, then NN_-prefixed
 * notes by number, then the rest alphabetically. Kept as the shape the
 * planner degrades to (research R5) and as the reference for FR-013 ("flat
 * folders export identically"). Basenames are unique within one folder, so
 * this is safe to key by name — unlike everything else, which is path-keyed.
 *
 * 017-note-exclusion: a left-out note is never in `order`. The index note is
 * still RETURNED as `indexBasename` when it is left out — the degraded path is
 * what resolves the book's metadata from it — but it is not printed either
 * (FR-006). This path is reachable when planning throws, so it must honour the
 * marker or a planning bug would silently put a left-out note back in the book
 * (research R8).
 */
export function legacyChapterOrder(
  notes: readonly IndexCandidate[],
  folderName: string
): { indexBasename: string | null; order: string[] } {
  const indexBasename = pickIndexNote(notes, folderName);
  const chapterNames = orderChapters(
    notes.filter((note) => note.basename !== indexBasename && !note.leftOut).map((note) => note.basename)
  );
  const indexLeftOut =
    indexBasename !== null && (notes.find((note) => note.basename === indexBasename)?.leftOut ?? false);
  const order = indexBasename === null || indexLeftOut ? chapterNames : [indexBasename, ...chapterNames];
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
 *
 * 017-note-exclusion: a Part whose index note is left out keeps its title (the
 * note still names it) but has no chapter to open, so its `indexChapter` is
 * null — the shape a Part with no index note already has, and 009's rule for it
 * ("open the first chapter inside that Part"). Hence the null-safe lookup: the
 * index path is in `navPlan` whether or not it is in the reading order.
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
          indexChapter: node.indexPath ? (positionByPath.get(node.indexPath) ?? null) : null,
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

// 017-note-exclusion: how many left-out notes the line names before it counts
// the rest. The report is meant to be read and pasted by a human, and a folder
// can hold a whole `drafts/` folder of marked notes.
const LEFT_OUT_NAMED = 5;

/**
 * 017-note-exclusion FR-007: the one line that says what a plan left out. It is
 * a planning warning, so it reaches the preview and the export report's "book
 * as a whole" group through the channel both already use — no second channel,
 * and no wording in two places.
 *
 * `null` when nothing was left out, so a book with no marker produces no line
 * at all. The property name is in the line because the line is where a reader
 * meets the rule: someone reading a shared report can find it from there.
 */
export function leftOutWarning(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const named = paths.slice(0, LEFT_OUT_NAMED).join(", ");
  const rest = paths.length - LEFT_OUT_NAMED;
  const more = rest > 0 ? ` and ${rest} more` : "";
  const notes = paths.length === 1 ? "note" : "notes";
  return `${paths.length} ${notes} left out of the book (export: false): ${named}${more}`;
}

/** The one warning text for a table-of-contents tree the book builder rejects.
 *  Shared by the export (which falls back to a flat list) and the preview
 *  (which shows the same flat list), so the two cannot word it differently;
 *  scripts/local-export.ts parses the export's console line, so keep it. */
export function tocFallbackWarning(error: unknown): string {
  return `table of contents fell back to a flat list: ${errorMessage(error)}`;
}

/**
 * The degradation itself, in one testable place: Constitution II / FR-016 —
 * ordering is structure, not content, so a bug here degrades to the pre-009
 * flat order and says so, never aborts an export.
 *
 * `leftOut` is passed in because there is no plan to read it from on this path;
 * the line still has to be said, or the one path that already admits something
 * went wrong would also silently omit notes (research R8).
 */
export function degradedFolderPlan(
  fallbackOrder: string[],
  error: unknown,
  leftOut: readonly string[] = []
): FolderPlan {
  return {
    order: fallbackOrder,
    nav: undefined,
    warnings: withLeftOutWarning([chapterOrderFallbackWarning(error)], leftOut),
  };
}

/** The left-out line first — the reader's own scope decision comes before a
 *  notice about a degradation — or the warnings untouched when there is none. */
function withLeftOutWarning(warnings: string[], leftOut: readonly string[]): string[] {
  const line = leftOutWarning(leftOut);
  return line === null ? warnings : [line, ...warnings];
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
      warnings: withLeftOutWarning([], plan.leftOut),
    };
  } catch (e) {
    return degradedFolderPlan(fallbackOrder, e, leftOutPaths(input));
  }
}
