// Markdown SOURCE-text operations for the rendering pipeline: stripping
// blocks that must not ship, parsing an embed wrapper's linktext into its
// note path + scope suffix, and locating the heading/block line range a
// scoped embed selects.
//
// Part of the pure rendering library (see render.ts for the module map and
// the zero-"obsidian"-import constraint): this module has no imports beyond
// the shared regex helper.
import { escapeRegExp } from "./regex";

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function stripDynamicBlocks(md: string): string {
  return md.replace(/```dataview(js)?\r?\n[\s\S]*?```/g, "*[dynamic content omitted]*");
}

// Known-image extensions Obsidian embeds inline as `<img>` rather than as a
// note transclusion — mirrors media-types.ts's allowlist scope, kept as its
// own narrow regex here so this pure module doesn't need to import from it.
const EMBED_IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|avif)$/i;

export interface EmbedTarget {
  /** The full linktext as written, e.g. "Note#Heading" or "Note^blockid". */
  raw: string;
  /** Just the note-name portion, with any "#..."/"^..." suffix stripped. */
  linkpath: string;
  /** Heading name after a "#" suffix (not a "^" block ref), if present. */
  heading: string | null;
  /** Block ID after a "^" suffix, if present. */
  block: string | null;
}

// Splits an embed wrapper's `src` linktext (the authoritative target — real
// Obsidian stamps the exact linkpath the user wrote, alias excluded, onto the
// wrapper's src attribute) into its note path and optional heading/block
// scope suffix. Replaces the old raw-markdown positional scan
// (parseNoteEmbeds): with the src attribute available on every wrapper there
// is nothing positional left to reconstruct.
export function splitEmbedTarget(src: string): EmbedTarget {
  const raw = src.trim();

  const headingIndex = raw.indexOf("#");
  const blockIndex = raw.indexOf("^");
  const suffixIndices = [headingIndex, blockIndex].filter((index) => index !== -1);

  // Whichever suffix appears FIRST in the linktext is the one that scopes the
  // embed ("Note#Heading" scopes by heading, "Note^blockid" by block); a
  // second suffix, if any, is just part of that scope's name.
  const firstSuffixIndex = suffixIndices.length === 0 ? null : Math.min(...suffixIndices);
  const hasHeadingSuffix = headingIndex !== -1 && headingIndex === firstSuffixIndex;
  const hasBlockSuffix = blockIndex !== -1 && blockIndex === firstSuffixIndex;

  return {
    raw,
    linkpath: firstSuffixIndex === null ? raw : raw.slice(0, firstSuffixIndex),
    heading: hasHeadingSuffix ? raw.slice(headingIndex + 1) : null,
    block: hasBlockSuffix ? raw.slice(blockIndex + 1) : null,
  };
}

/** True when an embed wrapper's src targets an image, not a note. */
export function isImageEmbedSrc(src: string): boolean {
  return EMBED_IMAGE_EXT.test(src.trim());
}

// Obsidian Bases (.base) render an interactive, filtered view of note
// properties — an EPUB reader has no way to reproduce that, so the embed
// degrades with a message naming the feature rather than the generic
// "not a note" wording (GitHub issue #2: read as a failed export).
// The suffix may carry a `#`/`^` scope (the wrapper's src is the raw
// linktext), so the extension need not sit at the very end.
export function isBasesSrc(src: string): boolean {
  return /\.base([#^].*)?$/i.test(src.trim());
}

// ── Scoped (heading/block) embed extraction ────────────────────────────────
//
// A heading-scoped (`![[Note#Heading]]`) or block-scoped (`![[Note^blockid]]`)
// embed needs to know WHERE in the target note's raw markdown its section or
// block starts and ends. Obsidian's own `app.metadataCache.getFileCache()`
// already computes exactly this (line-numbered headings and root-level
// sections) — render-adapter.ts adapts that real, Obsidian-specific cache
// shape into the plain `HeadingInfo`/`SectionInfo` arrays below, so the
// matching and boundary math here stays pure and independently testable
// (see research.md's Unknown 4 for why this doesn't reuse Obsidian's own
// `stripHeading()`/`stripHeadingForLink()` normalization functions).

export interface HeadingInfo {
  heading: string;
  level: number;
  /** 0-based line number in the note's raw markdown. */
  line: number;
}

export interface HeadingSection {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

// Finds the heading matching `target` (case-insensitive, leading/trailing
// whitespace ignored — FR-002) and computes its section's line range: from
// the heading's own line through the line before the next heading whose
// level is equal to or higher (numerically lower or equal) than the matched
// heading's, or through the note's last line if no such heading follows.
// When more than one heading shares the same text, the first in document
// order wins, matching how Obsidian itself resolves a duplicate heading link.
export function findHeadingSection(
  headings: HeadingInfo[],
  target: string,
  totalLines: number
): HeadingSection | null {
  const normalizedTarget = target.trim().toLowerCase();
  const matchedIndex = headings.findIndex(
    (heading) => heading.heading.trim().toLowerCase() === normalizedTarget
  );
  if (matchedIndex === -1) return null;

  const matchedHeading = headings[matchedIndex];
  // The section runs until the next heading at the same level or higher.
  const nextHeading = headings
    .slice(matchedIndex + 1)
    .find((heading) => heading.level <= matchedHeading.level);
  const endLine = nextHeading ? nextHeading.line - 1 : totalLines - 1;
  return { startLine: matchedHeading.line, endLine };
}

export interface SectionInfo {
  id: string | undefined;
  /** e.g. "paragraph" | "heading" | "list" | "table" | ... (non-exhaustive). */
  type: string;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

// One entry per list item, mirroring Obsidian's ListItemCache. `parent` is the
// mechanism its own docs point at for reconstructing hierarchy, which is what
// an embedded item's descendant range needs (spec 002 FR-006).
export interface ListItemInfo {
  id: string | undefined;
  /**
   * Start line of this item's parent item. NEGATIVE for a root-level item,
   * where its magnitude is the list's first line (Obsidian's own convention).
   */
  parent: number;
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

export interface BlockRange extends HeadingSection {
  /**
   * True when this range came from a list item rather than a root-level
   * section. The caller dedents ONLY these: a root-level section either starts
   * at column 0 (dedent is a no-op) or is an indented-style code block, whose
   * leading whitespace IS what makes it code — dedenting that would silently
   * demote it to a paragraph (spec 002 research R3a).
   */
  fromListItem: boolean;
}

// Finds the block matching `blockId` across BOTH structures Obsidian exposes
// at block granularity: root-level `sections` (any type — table, code,
// blockquote, callout, list, html, paragraph, heading, or one Obsidian adds
// later) and per-item `listItems`. There is deliberately no type allowlist:
// SectionCache["type"] is documented as non-exhaustive, so absence of a
// resolvable RANGE — not absence from a hand-maintained list — is the
// rejection criterion. An ID in neither structure returns null and
// render-adapter.ts degrades it exactly as before (spec 002 FR-009).
//
// Sections are checked first so an ID on a whole list can never be mistaken
// for one on an item inside it.
export function findBlockRange(
  sections: SectionInfo[],
  listItems: ListItemInfo[],
  blockId: string
): BlockRange | null {
  const section = sections.find((s) => s.id === blockId);
  if (section) {
    return { startLine: section.startLine, endLine: section.endLine, fromListItem: false };
  }
  const item = listItems.find((i) => i.id === blockId);
  if (!item) return null;
  return { ...listItemRange(listItems, item), fromListItem: true };
}

// Widens a list item's own range to cover its nested descendants (spec 002
// FR-006 — Obsidian shows a block reference to an item together with what's
// under it). Descendants come from `parent`, which Obsidian's own docs point
// at for exactly this: an item's `parent` is its parent's start line (negative
// for a root-level item), so a sibling's `parent` is the seed's parent, never
// the seed's start line — which is what keeps siblings out (FR-005).
//
// `seen` guards against malformed input (a self-parenting or cyclic chain)
// making this loop forever.
export function listItemRange(listItems: ListItemInfo[], seed: ListItemInfo): HeadingSection {
  const descendantStarts = new Set<number>([seed.startLine]);
  const visitedItems = new Set<ListItemInfo>([seed]);
  let endLine = seed.endLine;

  // Repeat until no further item joins: a child may appear before its parent
  // in the array, so a single pass could miss part of the chain.
  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    for (const candidate of listItems) {
      if (visitedItems.has(candidate) || !descendantStarts.has(candidate.parent)) continue;
      visitedItems.add(candidate);
      descendantStarts.add(candidate.startLine);
      if (candidate.endLine > endLine) endLine = candidate.endLine;
      addedDescendant = true;
    }
  }
  return { startLine: seed.startLine, endLine };
}

// Removes the block's own leading indentation so it re-renders as the kind of
// thing it is. Without this a sliced nested item (`    - child`) begins with
// four spaces, which CommonMark reads as an INDENTED CODE BLOCK — the reader
// would get a grey box of literal text instead of a bullet (spec 002 FR-007).
//
// Only the first line's exact prefix is removed, so relative nesting survives
// (FR-006). Callers apply this to LIST-ITEM ranges only: a root-level section
// either starts at column 0 or is an indented-style code block whose
// indentation is its meaning (research R3a).
export function dedentBlock(md: string): string {
  const lines = md.split("\n");
  const leadingWhitespace = /^[ \t]*/.exec(lines[0])?.[0] ?? "";
  if (leadingWhitespace === "") return md;
  return lines
    .map((line) => (line.startsWith(leadingWhitespace) ? line.slice(leadingWhitespace.length) : line))
    .join("\n");
}

// Removes the `^id` marker the author wrote to label this block, so it can't
// surface as stray text in the finished book (spec 002 FR-013). Whether real
// Obsidian's renderer would have hidden it is exactly the kind of behavior the
// stub can't model (docs/DEVELOPMENT.md), so this makes it unconditional.
//
// Scoped to the ONE resolved id, never a generic caret pattern: an embedded
// code block can legitimately contain `^` tokens (regex, exponent, Vim
// notation) and silently editing a reader's code would be a worse defect than
// the stray marker being fixed.
export function stripBlockMarker(md: string, blockId: string): string {
  const escapedId = escapeRegExp(blockId);
  const markerAloneOnLine = new RegExp(`^[ \\t]*\\^${escapedId}[ \\t]*$`);
  const markerAtEndOfLine = new RegExp(`[ \\t]*\\^${escapedId}[ \\t]*$`);

  const keptLines: string[] = [];
  for (const line of md.split("\n")) {
    // A marker sitting alone on its line (how Obsidian labels tables, lists
    // and code blocks) takes the line with it — leaving a blank would split
    // the block it belongs to.
    if (markerAloneOnLine.test(line)) continue;
    // Otherwise it trails the block's own last line (paragraphs, headings).
    keptLines.push(line.replace(markerAtEndOfLine, ""));
  }
  return keptLines.join("\n");
}
