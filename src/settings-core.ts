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
}

export const DEFAULT_SETTINGS: EpubExportSettings = {
  outputFolder: "",
  linkDepth: 1,
  language: "th",
  fallbackAuthor: "",
  booxUrl: "",
  pushAfterExport: false,
  backlinkPosition: "start",
};

// Persisted data.json can hold anything (hand-edits, downgrades) — an
// unrecognized value must degrade to the default, never crash or disable
// the listing (spec FR-006/FR-008).
export function coerceBacklinkPosition(value: unknown): BacklinkPosition {
  return value === "end" || value === "both" || value === "none" ? value : "start";
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
