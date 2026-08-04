// Pure cover resolution helpers — zero "obsidian" imports so vitest loads
// this module directly, same split rationale as metadata.ts. This module
// only PARSES and SCANS; vault/network touchpoints live in main.ts's
// metaFromNote (the adapter layer).

export type CoverValue = { kind: "url"; url: string } | { kind: "path"; path: string };

// Case-insensitive http:// or https:// prefix.
const URL_SHAPE = /^https?:\/\//i;

// [[target]] or ![[target]] — capture the inner target.
const WIKILINK_SHAPE = /^!?\[\[(.+?)\]\]$/;

// Cover formats are deliberately narrower than the body-image allowlist in
// media-types.ts: gif (animated) and svg covers are unreliable as e-reader
// shelf thumbnails. All four are EPUB 3.3 core media types (research R2).
const COVER_EXTS = ["png", "jpg", "jpeg", "webp"];

function firstNonEmptyString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  return null;
}

/**
 * Parses the frontmatter `cover:` field. A URL stays a URL; wikilink/embed
 * brackets (and any `|alt` suffix) are stripped to the bare target; anything
 * else is a vault path. Arrays yield the first parseable entry.
 */
export function parseCoverValue(raw: unknown): CoverValue | null {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const parsed = parseCoverValue(entry);
      if (parsed) return parsed;
    }
    return null;
  }
  const value = firstNonEmptyString(raw);
  if (!value) return null;
  if (URL_SHAPE.test(value)) return { kind: "url", url: value };
  const wikilink = WIKILINK_SHAPE.exec(value);
  if (wikilink) {
    // Obsidian splits wikilink alt text on the FIRST pipe; a pipe inside the
    // target itself is not valid link syntax.
    const target = wikilink[1].split("|")[0].trim();
    return target === "" ? null : { kind: "path", path: target };
  }
  return { kind: "path", path: value };
}

const WIKILINK_EMBED = /!\[\[([^\]]+)\]\]/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(([^)]*)\)/g;

/**
 * Scans raw note source for image embeds (`![[…]]` or `![…](…)`) OUTSIDE
 * fenced code blocks (```…``` / ~~~…~~~), returning their targets in
 * document order. `|alt` suffixes on wikilinks are stripped; a quoted
 * markdown-image target is unquoted. Heading/block suffixes (`#part`) are
 * kept for the caller's link resolver. The returned array lets the caller
 * skip unsupported/missing files and take the first that resolves cleanly.
 */
export function findImageEmbeds(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    // Fence toggling: a line consisting of ``` or ~~~ (optionally followed
    // by a language tag) opens or closes a fence. Inside a fence, image
    // syntax is literal text and must not count.
    if (/^(```|~~~)/.test(trimmed)) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    for (const m of line.matchAll(WIKILINK_EMBED)) {
      const target = m[1].split("|")[0].trim();
      if (target !== "") out.push(target);
    }
    for (const m of line.matchAll(MARKDOWN_IMAGE)) {
      let target = m[1].trim();
      if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);
      if (target !== "") out.push(target);
    }
  }
  return out;
}

/** True for png/jpg/jpeg/webp, case-insensitive — the cover allowlist. */
export function isSupportedCoverExt(ext: string): boolean {
  return COVER_EXTS.includes(ext.toLowerCase());
}
