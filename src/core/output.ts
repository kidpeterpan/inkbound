// ── Export destination resolution (008-mobile-support) ────────────────────
//
// Pure module — zero `obsidian` imports, so vitest loads it directly and every
// placement rule below is a unit test with no stub at all.
//
// This is the ONE place platform changes the outcome of an export. It does not
// DETECT the platform: src/main.ts (an adapter, already allowed to import
// `obsidian`) reads `Platform` and passes a plain PlatformKind in. Detecting
// here would drag an `obsidian` import into the pure core and break the
// module-split invariant the constitution calls load-bearing (principle IV) —
// same discipline as setSvgRasterizer injecting the rasterizer in render.ts.

import { coerceMobileOutputFolder, resolveOutputPath, DEFAULT_MOBILE_OUTPUT_FOLDER } from "./settings-core";

export type PlatformKind = "desktop" | "mobile";

export interface ExportDestination {
  kind: PlatformKind;
  /** Where the bytes go: absolute filesystem path on desktop, vault-relative on mobile. */
  path: string;
  /** What the completion notice shows the user — must be something they can act on. */
  displayPath: string;
  /** The file's own name. BooxDrop uploads under this, identically on both platforms. */
  fileName: string;
}

/**
 * Vault-relative path for a mobile export.
 *
 * Containment is enforced HERE rather than at the call site, so that no future
 * caller can bypass it: the result is handed straight to the vault adapter, and
 * a `..` segment or an absolute path would mean writing outside the vault.
 */
export function resolveMobileOutputPath(mobileOutputFolder: string, slug: string): string {
  const folder = coerceMobileOutputFolder(mobileOutputFolder);
  return `${folder}/${slug}.epub`;
}

export function resolveDestination(
  kind: PlatformKind,
  settings: { outputFolder: string; mobileOutputFolder: string },
  slug: string,
  // Desktop-only input. Mobile never consults it, so passing "" on mobile is
  // harmless — a mobile resolution that depended on homedir would be a bug.
  homedir: string
): ExportDestination {
  if (kind === "mobile") {
    // settings.outputFolder is deliberately NOT read here, not even as a
    // fallback: a synced data.json carries the desktop's absolute path onto the
    // phone, and honoring it would both fail and violate FR-004's isolation.
    const path = resolveMobileOutputPath(settings.mobileOutputFolder, slug);
    return {
      kind,
      path,
      // Vault-relative is what the user can act on: it is what they see in
      // Obsidian's own file list and in the device's file access (FR-018).
      displayPath: path,
      fileName: fileNameOf(path),
    };
  }

  // Desktop keeps the pre-feature resolver verbatim. FR-006 is asserted against
  // it directly in tests/output.test.ts (C1–C3).
  const path = resolveOutputPath(settings.outputFolder, slug, homedir);
  return { kind, path, displayPath: path, fileName: fileNameOf(path) };
}

function fileNameOf(path: string): string {
  // No `?? path` fallback: split() always yields at least one element, so the
  // guard would be unreachable code masquerading as caution.
  const parts = path.split("/");
  return parts[parts.length - 1];
}

export { DEFAULT_MOBILE_OUTPUT_FOLDER };
