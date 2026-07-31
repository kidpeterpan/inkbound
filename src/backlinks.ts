// Backlink trail ("Linked from:") for exported chapters — pure module, zero
// "obsidian" imports, so vitest loads it directly (same rule as collect.ts).
// Contract: specs/001-breadcrumb-trail/contracts/backlinks-fragment.md.
import { escapeXml } from "./epub";

// Inverts Obsidian's resolvedLinks graph (source path → {target path → count})
// into target → ordered linking sources, restricted to the chapters actually
// in this export. Ordering follows orderedPaths — the book's chapter/TOC
// order — not discovery or alphabetical order. resolvedLinks is already keyed
// by resolved target path, so alias/heading/block link forms and repeated
// links collapse to one entry per (source, target) pair by construction.
export function computeBacklinks(
  links: Record<string, Record<string, number>>,
  orderedPaths: string[]
): Map<string, string[]> {
  const inBook = new Set(orderedPaths);
  const result = new Map<string, string[]>();
  for (const source of orderedPaths) {
    for (const target of Object.keys(links[source] ?? {})) {
      if (target === source || !inBook.has(target)) continue;
      const sources = result.get(target);
      if (sources) sources.push(source);
      else result.set(target, [source]);
    }
  }
  return result;
}

export interface BacklinkEntry {
  /** Display title, same one the TOC shows (alias > H1 > basename). */
  title: string;
  /** Sibling-relative chapter filename, e.g. "chapter_001.xhtml". */
  href: string;
}

// Chapter docs declare only the XHTML namespace, so this fragment must stay
// free of epub:/other-namespace attributes or the chapter becomes ill-formed
// XML (epubcheck RSC-005). No id attributes either: position "both" places
// the fragment twice in one chapter.
export function renderBacklinksFragment(entries: BacklinkEntry[]): string {
  if (entries.length === 0) return "";
  const anchors = entries.map((e) => `<a href="${escapeXml(e.href)}">${escapeXml(e.title)}</a>`).join(", ");
  return `<div class="backlinks"><p>Linked from: ${anchors}</p></div>`;
}
