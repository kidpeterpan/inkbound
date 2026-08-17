// ── Thai font asset loading (006-thai-font) ───────────────────────────────
//
// This module exists so the .ttf binary imports (esbuild's "binary" loader
// — esbuild.config.mjs + scripts/local-export.ts) never leak into the pure
// modules: tsx-based scripts like build-sample.ts import epub.ts → fonts.ts,
// and tsx has no .ttf loader. Everything about the fonts themselves (family
// name, manifest metadata, @font-face CSS, license text) lives in fonts.ts;
// only the BYTES and the injectable loader seam live here.

import regularBase64 from "./fonts/NotoSansThai-Regular.ttf";
import boldBase64 from "./fonts/NotoSansThai-Bold.ttf";
import { OFL_LICENSE_TEXT, type ThaiFontAsset } from "./fonts";

// 008-mobile-support — INVARIANT: the fonts are inlined as base64 and decoded
// here, NOT inlined as raw bytes by esbuild's "binary" loader. Under
// `platform: "node"` that loader emits a `__toBinaryNode` helper built on
// `Buffer.from(base64, "base64")`, and it runs at module top level to decode
// these two fonts. `Buffer` is a Node global that does not exist in Obsidian
// mobile's WebView, so the binary loader killed the plugin at load on mobile
// exactly as a top-level require("fs") did — with no require() anywhere for a
// static check to notice. Keep this decode to APIs that exist on BOTH
// platforms (atob is in Electron, in mobile WebViews, and in Node 16+).
// esbuild.config.mjs and scripts/local-export.ts must both stay on
// `loader: { ".ttf": "base64" }` for this to hold.
export function decodeBase64(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // Malformed base64 (corrupt bundle): degrade to empty, which buildAsset
    // turns into a fontless book with a warning (constitution II).
    return new Uint8Array(0);
  }
}

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
    return buildAsset(decodeBase64(regularBase64), decodeBase64(boldBase64));
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
