// ── Thai font asset loading (006-thai-font) ───────────────────────────────
//
// This module exists so the .ttf binary imports (esbuild's "binary" loader
// — esbuild.config.mjs + scripts/local-export.ts) never leak into the pure
// modules: tsx-based scripts like build-sample.ts import epub.ts → fonts.ts,
// and tsx has no .ttf loader. Everything about the fonts themselves (family
// name, manifest metadata, @font-face CSS, license text) lives in fonts.ts;
// only the BYTES and the injectable loader seam live here.

import regularBytes from "./fonts/NotoSansThai-Regular.ttf";
import boldBytes from "./fonts/NotoSansThai-Bold.ttf";
import { OFL_LICENSE_TEXT, type ThaiFontAsset } from "./fonts";

// Exported for direct testing: the empty-bytes degradation branches (FR-008)
// are unreachable through the real bundled bytes, so tests exercise them
// with empty fixtures instead of mocking the binary imports.
export function buildAsset(regular: Uint8Array, bold: Uint8Array): ThaiFontAsset | null {
  if (regular.length === 0 || bold.length === 0) return null;
  return { regular, bold, license: OFL_LICENSE_TEXT };
}

// Returns null when the bundled fonts are unusable (broken bundle) — the
// caller degrades to a fontless book with a warning, never a failure (FR-008).
export function loadThaiFontAsset(): ThaiFontAsset | null {
  try {
    return buildAsset(regularBytes, boldBytes);
  } catch {
    return null;
  }
}

// Injectable seam for the FR-008 degradation path (same discipline as
// setSvgRasterizer in render.ts): tests install a failing loader; `null`
// restores the real one.
type ThaiFontLoader = () => ThaiFontAsset | null;
let thaiFontLoader: ThaiFontLoader = loadThaiFontAsset;

export function setThaiFontLoader(fn: ThaiFontLoader | null): void {
  thaiFontLoader = fn ?? loadThaiFontAsset;
}

export function getThaiFontLoader(): ThaiFontLoader {
  return thaiFontLoader;
}
