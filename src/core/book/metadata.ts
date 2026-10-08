// Pure frontmatter → EPUB metadata resolution. Zero "obsidian" imports so
// vitest loads it directly. Shared by all three export scopes in main.ts, which
// previously mined frontmatter inline for folder exports only.

export interface MetaDefaults {
  fallbackAuthor: string;
  language: string;
}

export interface ResolvedMeta {
  title: string;
  author: string;
  language: string;
  coverUrl: string | null;
}

// Deliberately small: an unrecognised name falls back rather than guessing at a
// code the reader would then be stuck with.
const LANGUAGE_NAMES: Record<string, string> = {
  thai: "th",
  english: "en",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
};

const BCP47_SHAPE = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

// Shared by resolveTitle (book title) and deriveChapterTitle (chapter titles,
// 007-chapter-titles): "usable alias" must mean the same thing everywhere
// (plain string, or first non-empty trimmed list element).
export function firstNonEmptyString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim() !== "") return item.trim();
    }
  }
  return null;
}

export function normalizeLanguage(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return fallback;
  if (BCP47_SHAPE.test(value)) return value.toLowerCase();
  return LANGUAGE_NAMES[value.toLowerCase()] ?? fallback;
}

export function resolveAuthor(raw: unknown, fallback: string): string {
  if (Array.isArray(raw)) {
    const names = raw
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .map((n) => n.trim());
    if (names.length > 0) return names.join(", ");
  } else {
    const single = firstNonEmptyString(raw);
    if (single) return single;
  }
  const fb = fallback.trim();
  return fb === "" ? "Unknown" : fb;
}

export function resolveTitle(basename: string, aliases: unknown): string {
  return firstNonEmptyString(aliases) ?? basename;
}

export function resolveCoverUrl(raw: unknown): string | null {
  const value = firstNonEmptyString(typeof raw === "string" ? raw : null);
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

export function resolveMeta(
  frontmatter: Record<string, unknown> | undefined,
  basename: string,
  defaults: MetaDefaults
): ResolvedMeta {
  const fm = frontmatter ?? {};
  return {
    title: resolveTitle(basename, fm.aliases),
    author: resolveAuthor(fm.author, defaults.fallbackAuthor),
    language: normalizeLanguage(fm.language, defaults.language),
    coverUrl: resolveCoverUrl(fm.coverUrl),
  };
}
