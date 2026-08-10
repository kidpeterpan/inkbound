// Pure settings helpers — zero "obsidian" imports so vitest can load this
// module directly (the "obsidian" npm package ships type declarations only,
// no runtime JS, and would blow up any test file that imports it transitively).
// src/settings.ts re-exports everything from here and adds the obsidian-facing
// EpubExportSettingTab class.

export type BacklinkPosition = "start" | "end" | "both" | "none";

export interface EpubExportSettings {
  outputFolder: string;
  linkDepth: number;
  language: string;
  fallbackAuthor: string;
  booxUrl: string;
  pushAfterExport: boolean;
  backlinkPosition: BacklinkPosition;
  // Deepest heading level included in the nav TOC sub-entries (0 = off,
  // flat TOC — 004-heading-toc FR-005).
  tocHeadingDepth: number;
}

export const DEFAULT_SETTINGS: EpubExportSettings = {
  outputFolder: "",
  linkDepth: 1,
  language: "th",
  fallbackAuthor: "",
  booxUrl: "",
  pushAfterExport: false,
  backlinkPosition: "start",
  tocHeadingDepth: 3,
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
