// Pure settings helpers — zero "obsidian" imports so vitest can load this
// module directly (the "obsidian" npm package ships type declarations only,
// no runtime JS, and would blow up any test file that imports it transitively).
// src/settings.ts re-exports everything from here and adds the obsidian-facing
// EpubExportSettingTab class.

export type BacklinkPosition = "start" | "end" | "both" | "none";

// 008-mobile-support FR-003: where mobile writes finished books, vault-relative.
export const DEFAULT_MOBILE_OUTPUT_FOLDER = "Exports";

export interface EpubExportSettings {
  // Desktop only — an absolute (or ~-prefixed) filesystem path. Mobile never
  // reads it, and never writes it (008-mobile-support FR-004).
  outputFolder: string;
  // Mobile only — a vault-relative folder. Desktop never reads or writes it.
  // Two independent settings, not one reinterpreted per platform, because vault
  // sync shares a single data.json across devices: this is what makes FR-006's
  // "mobile must not change desktop output" structural rather than careful —
  // there is no code path by which a phone could relocate desktop exports.
  mobileOutputFolder: string;
  linkDepth: number;
  language: string;
  fallbackAuthor: string;
  booxUrl: string;
  pushAfterExport: boolean;
  backlinkPosition: BacklinkPosition;
  // Deepest heading level included in the nav TOC sub-entries (0 = off,
  // flat TOC — 004-heading-toc FR-005).
  tocHeadingDepth: number;
  // 006-thai-font FR-009: when ON (default), books whose chapters contain
  // Thai text get Noto Sans Thai embedded; OFF never embeds.
  embedThaiFont: boolean;
}

export const DEFAULT_SETTINGS: EpubExportSettings = {
  outputFolder: "",
  mobileOutputFolder: DEFAULT_MOBILE_OUTPUT_FOLDER,
  linkDepth: 1,
  language: "th",
  fallbackAuthor: "",
  booxUrl: "",
  pushAfterExport: false,
  backlinkPosition: "start",
  tocHeadingDepth: 3,
  embedThaiFont: true,
};

// Persisted data.json can hold anything (hand-edits, downgrades) — an
// unrecognized value must degrade to the default, never crash or disable
// the listing (spec FR-006/FR-008).
export function coerceBacklinkPosition(value: unknown): BacklinkPosition {
  return value === "end" || value === "both" || value === "none" ? value : "start";
}

// Persisted data.json can hold anything — an out-of-range or non-integer
// tocHeadingDepth degrades to the default (3), never crashes the settings
// tab (same rationale as coerceBacklinkPosition).
export function coerceTocHeadingDepth(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6
    ? value
    : DEFAULT_SETTINGS.tocHeadingDepth;
}

// 006-thai-font: booleans pass through; anything else (hand-edited data.json,
// older plugin versions) degrades to the default ON.
export function coerceEmbedThaiFont(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.embedThaiFont;
}

// 008-mobile-support: same house contract as the coerce* functions above —
// persisted data.json can hold anything, and must degrade to the default rather
// than crash. This one additionally enforces vault containment: the value is
// handed to the vault adapter, so a `..` segment or an absolute/desktop-shaped
// path must never survive to become a write outside the vault.
export function coerceMobileOutputFolder(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_MOBILE_OUTPUT_FOLDER;
  const trimmed = value.trim();
  // Desktop-shaped paths are meaningless on mobile — a synced data.json is the
  // normal way one arrives here.
  if (trimmed.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.includes("\\")) {
    return DEFAULT_MOBILE_OUTPUT_FOLDER;
  }
  const cleaned = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned === "") return DEFAULT_MOBILE_OUTPUT_FOLDER;
  // Any parent-directory segment, anywhere, disqualifies the whole value.
  // Rejecting rather than normalizing keeps the rule one line to verify.
  if (cleaned.split("/").some((segment) => segment === "..")) {
    return DEFAULT_MOBILE_OUTPUT_FOLDER;
  }
  return cleaned;
}

export function resolveOutputPath(outputFolder: string, slug: string, homedir: string): string {
  let folder = outputFolder.trim();
  if (folder === "") folder = `${homedir}/Downloads`;
  else if (folder.startsWith("~/")) folder = homedir + folder.slice(1);
  return `${folder.replace(/\/+$/, "")}/${slug}.epub`;
}

export function summarizeWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  return `Exported with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — details in developer console.`;
}
