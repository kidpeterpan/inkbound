// ── Mermaid rasterization (Round 3) ───────────────────────────────────────
//
// The prior rounds (normalizeMermaidSvg in render-svg.ts) made mermaid SVGs
// spec-valid (epubcheck: 0 errors). That's not enough for every device: at
// least one e-ink reader (Onyx Boox / Neo Reader 3) doesn't render inline SVG
// inside EPUB XHTML at all, while plain raster <img> assets are proven to work
// on it. The fix is to rasterize each normalized mermaid SVG to a PNG at export
// time and embed it as a normal image, falling back to the (still
// spec-valid) inline SVG when rasterization isn't possible.
//
// This lives in core/ rather than in src/adapters/render-adapter.ts (where an
// earlier draft of this feature placed it) for the same reason rewriteImages
// leaves vault-path resolution to its caller: render-adapter.ts imports real
// VALUES from "obsidian" (App, Component, MarkdownRenderer, TFile), and
// "obsidian" ships type declarations only, no runtime JS. Anything that
// imports render-adapter.ts outside vitest's "obsidian" alias crashes with
// "Cannot find module 'obsidian'" (verified directly: a plain `tsx` run of a
// one-line script importing renderUnitToChapter throws exactly that).
// scripts/verify-real-mermaid.ts needs to exercise the DEFAULT rasterizer's
// fallback behavior (no canvas under jsdom) without going through Obsidian,
// so the rasterizer plumbing stays in this obsidian-free module.
// render-adapter.ts re-exports `setSvgRasterizer`/`SvgRasterizer` and wires
// `rasterizeMermaidDiagrams` into `renderUnitToChapter`.
//
// Part of the pure rendering library (see render.ts for the module map and
// the zero-"obsidian"-import constraint).
import { numberedImageHref } from "./render-links";

export type SvgRasterizer = (
  svg: SVGSVGElement
) => Promise<{ bytes: Uint8Array; width: number; height: number } | null>;

const RASTER_SCALE = 2;
const MAX_CANVAS_DIM = 4096;

// The canvas size to rasterize at: RASTER_SCALE, unless that would push either
// axis past MAX_CANVAS_DIM, in which case the diagram is scaled down just far
// enough to fit. Never below 1px, so a degenerate svg can't produce a
// zero-width canvas that throws on drawImage.
function canvasSizeForDiagram(cssWidth: number, cssHeight: number): { width: number; height: number } {
  let scale = RASTER_SCALE;
  if (cssWidth * scale > MAX_CANVAS_DIM || cssHeight * scale > MAX_CANVAS_DIM) {
    scale = Math.min(MAX_CANVAS_DIM / cssWidth, MAX_CANVAS_DIM / cssHeight);
  }
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

// Resolves true once the image has decoded, false when the browser refuses it.
// Never rejects: to the caller this is a fallback, not an error.
function loadImageFromUrl(image: HTMLImageElement, url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

// PNG data URL -> raw PNG bytes; null when the URL carries no base64 payload.
function pngBytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const payloadStart = dataUrl.indexOf(",");
  if (payloadStart === -1) return null;

  const binary = atob(dataUrl.slice(payloadStart + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Real (Electron-renderer) rasterizer: serialize -> Blob URL -> Image ->
// canvas -> PNG bytes. Returns null on ANY failure instead of throwing —
// callers treat null as "keep the inline SVG fallback", not an export error.
async function defaultRasterizeSvg(
  svg: SVGSVGElement
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const cssWidth = parseFloat(svg.getAttribute("width") ?? "") || 0;
  const cssHeight = parseFloat(svg.getAttribute("height") ?? "") || 0;
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  const canvasSize = canvasSizeForDiagram(cssWidth, cssHeight);

  let blobUrl: string | null = null;
  try {
    const serializedSvg = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([serializedSvg], { type: "image/svg+xml" });
    blobUrl = URL.createObjectURL(blob);

    const image = new Image();
    const loaded = await loadImageFromUrl(image, blobUrl);
    if (!loaded) return null;

    const canvas = createEl("canvas");
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;
    const context = canvas.getContext("2d");
    if (!context) return null; // jsdom (no "canvas" package installed): no 2d context

    // Fill white first: e-ink readers, and PNG would otherwise be transparent.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);
    context.drawImage(image, 0, 0, canvasSize.width, canvasSize.height);

    const bytes = pngBytesFromDataUrl(canvas.toDataURL("image/png"));
    if (bytes === null) return null;

    // Report the CSS size, not the canvas size: the PNG is embedded at the
    // size the diagram was authored at (its own scale is carried by the file).
    return { bytes, width: cssWidth, height: cssHeight };
  } catch {
    return null;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

let svgRasterizer: SvgRasterizer = defaultRasterizeSvg;

/**
 * The contract is "null on failure", but an injected rasterizer (or a browser
 * API under it) may throw instead. Either way the caller keeps the inline SVG
 * and warns — a diagram must never cost the chapter it sits in.
 */
export async function rasterizeOrNull(
  rasterize: SvgRasterizer,
  svg: SVGSVGElement
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    return await rasterize(svg);
  } catch {
    return null;
  }
}

/** Install a deterministic rasterizer for tests. `null` restores the default (real) one. */
export function setSvgRasterizer(rasterizer: SvgRasterizer | null): void {
  svgRasterizer = rasterizer ?? defaultRasterizeSvg;
}

/** Read the currently-installed rasterizer (used by math.ts's renderMath). */
export function getSvgRasterizer(): SvgRasterizer {
  return svgRasterizer;
}

export interface RasterizedMermaidImage {
  newHref: string;
  bytes: Uint8Array;
  mediaType: string;
}

// Finds every mermaid diagram in `root` (div.mermaid > svg — the shape a
// real Obsidian export produces, see tests/fixtures/mermaid-real.xhtml —
// plus a defensive svg.mermaid-with-no-wrapper-div variant) and rasterizes
// each one via the currently-installed rasterizer. A diagram that rasterizes
// successfully has its whole div.mermaid replaced with a <p><img></p>
// (numbered starting at startIndex+1, continuing rewriteImages's numbering
// so the two compose); one that doesn't is left exactly as-is (the
// spec-valid inline-SVG fallback), and a single warning is emitted per
// chapter no matter how many diagrams in it fell back.
// Obsidian's vault-trust gate for Mermaid (observed on a real 2026-07
// export): when the vault hasn't been allowed to render Mermaid, the
// diagram renders as guard UI instead of an svg —
//   <div class="mermaid-wrapper is-guarded">
//     <div class="mermaid-guard-header">…"Display Mermaid diagrams in this
//       vault?" text and an <button>Allow</button>…</div>
//     <div class="mermaid-guard-source"><pre class="language-mermaid">…</pre></div>
//   </div>
// Serializing that verbatim ships an inert "Allow" button into the book. Keep
// the readable part (the highlighted source fence), drop the UI chrome, and
// return the warning telling the user how to get the real diagram — or null
// when there was no guarded wrapper.
function unguardMermaidWrappers(root: HTMLElement): string | null {
  const guarded = root.querySelectorAll(".mermaid-wrapper.is-guarded");
  if (guarded.length === 0) return null;
  guarded.forEach((wrapper) => {
    const source = wrapper.querySelector(".mermaid-guard-source pre");
    if (source) wrapper.replaceWith(source);
    else wrapper.remove();
  });
  return "mermaid diagram not rendered: Obsidian hasn't been allowed to display Mermaid in this vault — open the note in reading view, click Allow on the diagram, then re-export";
}

// Every mermaid diagram in the chapter: div.mermaid (the shape a real Obsidian
// export produces, see tests/fixtures/mermaid-real.xhtml) plus a defensive
// svg.mermaid-with-no-wrapper-div variant.
function mermaidHosts(root: HTMLElement): Element[] {
  const hosts: Element[] = [];
  root.querySelectorAll("div.mermaid").forEach((div) => hosts.push(div));
  root.querySelectorAll("svg.mermaid").forEach((svg) => {
    if (!svg.closest("div.mermaid")) hosts.push(svg);
  });
  return hosts;
}

// Replaces a rasterized diagram's host with its PNG and returns the image the
// caller numbers into the chapter.
function embedRasterizedDiagram(
  host: Element,
  imageNumber: number,
  rasterized: { bytes: Uint8Array; width: number; height: number }
): RasterizedMermaidImage {
  const newHref = numberedImageHref(imageNumber, "png");
  const image = createEl("img");
  image.setAttribute("src", newHref);
  image.setAttribute("alt", "diagram");
  // XHTML's `width` attribute must be an integer (epubcheck RSC-005: "must
  // be a decimal number without any significant digits after the decimal
  // point") — a real mermaid svg's width is fractional (e.g.
  // "774.8046875"), so round it. Omit the attribute entirely rather than
  // writing "NaN" if the width is missing/non-finite.
  if (Number.isFinite(rasterized.width)) {
    image.setAttribute("width", String(Math.round(rasterized.width)));
  }
  const paragraph = createEl("p");
  paragraph.appendChild(image);
  host.replaceWith(paragraph);
  return { newHref, bytes: rasterized.bytes, mediaType: "image/png" };
}

// Finds every mermaid diagram in `root` and rasterizes each one via the
// currently-installed rasterizer. A diagram that rasterizes successfully has
// its whole host replaced with a <p><img></p> (numbered starting at
// startIndex+1, continuing rewriteImages's numbering so the two compose); one
// that doesn't is left exactly as-is (the spec-valid inline-SVG fallback), and
// a single warning is emitted per chapter no matter how many diagrams in it
// fell back.
export async function rasterizeMermaidDiagrams(
  root: HTMLElement,
  startIndex: number
): Promise<{ images: RasterizedMermaidImage[]; warnings: string[] }> {
  const images: RasterizedMermaidImage[] = [];
  const warnings: string[] = [];
  let fallbackWarned = false;

  const guardWarning = unguardMermaidWrappers(root);
  if (guardWarning) warnings.push(guardWarning);

  for (const host of mermaidHosts(root)) {
    const svg = mermaidSvgIn(host);
    if (!svg) continue;

    const rasterized = await rasterizeOrNull(svgRasterizer, svg);
    if (rasterized) {
      images.push(embedRasterizedDiagram(host, startIndex + images.length + 1, rasterized));
      continue;
    }

    // ONE warning per chapter, however many of its diagrams fell back.
    if (!fallbackWarned) {
      warnings.push("mermaid rasterization unavailable — kept inline SVG (may not render on e-ink)");
      fallbackWarned = true;
    }
  }

  return { images, warnings };
}

// The diagram's own <svg>: the host itself for the defensive svg.mermaid
// variant, otherwise the svg inside the div.mermaid wrapper.
function mermaidSvgIn(host: Element): SVGSVGElement | null {
  const svg = host.tagName.toLowerCase() === "svg" ? host : host.querySelector("svg");
  return svg as SVGSVGElement | null;
}
