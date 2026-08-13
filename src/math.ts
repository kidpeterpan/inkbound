// ── LaTeX math (005-latex-math) ───────────────────────────────────────────
//
// Pure module: zero "obsidian" imports (constitution IV). Detection and
// protection run on the markdown SOURCE before MarkdownRenderer sees it,
// because Obsidian's own math output is MathJax CHTML (needs MathJax
// fonts/CSS, e-ink-hostile) and the vitest stub's marked renderer leaves
// raw $...$ text — neither is a deterministic, self-contained basis for
// static image math (FR-007). Instead:
//
//   1. protectMath() swaps each $...$ / $$...$$ span for a placeholder
//      <span data-inkbound-math="N"></span> that both the real renderer and
//      the marked stub pass through untouched (inline HTML).
//   2. After cleanupDom/rewrite*/mermaid, renderMath() replaces each
//      placeholder with a MathJax-rendered SVG rasterized to PNG through the
//      shared rasterizer (setSvgRasterizer in render.ts — same mechanism the
//      Mermaid feature uses, and the same fallback ladder: rasterization
//      failure keeps the inline SVG, which epub.ts already makes spec-valid
//      via properties="svg").
//
// MathJax 3 headless (liteAdaptor — no DOM) renders identically in vitest,
// the local-export harness, and real Obsidian, with glyphs embedded as
// paths (self-contained SVG, no font assets). merror output = parse error.
// Chars outside MathJax's font coverage (Thai/CJK/Hangul/Arabic/surrogates)
// are silently DROPPED by MathJax, so they are rejected up front and the
// original source text is restored as the readable fallback (constitution
// II). KaTeX was evaluated first and rejected: the versions available to
// this repo ignore output:"svg" and return HTML+CSS, which cannot be
// rasterized — see plan.md Technical Context.

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { getSvgRasterizer } from "./render";

// One shared headless document: convert() creates a fresh math tree per
// call, and output is deterministic (verified: byte-identical repeats).
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const mathDocument = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: new SVG({ fontCache: "none" }),
});

// Scripts outside MathJax's SVG font coverage — glyphs would vanish
// silently, so expressions containing them are unrenderable by design.
const UNRENDERABLE_CHARSET_RE =
  /[\u0E00-\u0E7F\u0600-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uD800-\uDFFF]/;

export interface MathSpan {
  tex: string;
  display: boolean;
  index: number;
}

export interface ProtectResult {
  md: string;
  spans: MathSpan[];
}

interface ScanMatch {
  start: number;
  end: number;
  tex: string;
  display: boolean;
}

// A single "$" inside math content (but not a second delimiter).
const DISPLAY_MATH_RE = /\$\$((?:(?!\x01)[\s\S])+?)\$\$/g;
const INLINE_MATH_RE = /\$([^\s$\x01](?:[^$\r\n\x01]*[^\s$\x01])?)\$/g;
const COMBINED_MATH_RE = new RegExp(`${DISPLAY_MATH_RE.source}|${INLINE_MATH_RE.source}`, "g");

// Masks fenced code blocks and inline code spans with \x01 sentinels of the
// SAME length as the original, so math-match positions in the masked copy
// are valid positions in the source. Fences: ```/~~~ line-start openers and
// closers (up to 3 leading spaces). Code spans: single or double backtick
// runs (the same run closes).
function maskCodeRegions(md: string): string {
  const out = md.split("");
  const lines = md.split(/\r?\n/);
  let lineStart = 0;
  let inFence = false;
  let fenceChar = "";
  for (const line of lines) {
    let isFenceLine = false;
    const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inFence && fenceOpen) {
      inFence = true;
      fenceChar = fenceOpen[1][0];
      isFenceLine = true;
    } else if (inFence) {
      const close = new RegExp(`^[ \\t]{0,3}${fenceChar}{3,}\\s*$`).test(line);
      if (close) {
        inFence = false;
        // Mask the closing fence line too: an unmasked stray backtick run
        // (e.g. the 3rd ``` backtick) can pair with a later code-span
        // backtick and mask real content between them.
        isFenceLine = true;
      }
    }
    if (inFence || isFenceLine) {
      const lineLen = line.length;
      for (let i = 0; i < lineLen; i++) {
        const abs = lineStart + i;
        if (out[abs] !== "\n") out[abs] = "\x01";
      }
    }
    lineStart += line.length + 1; // +1 for the \n the split consumed
  }
  // Inline code spans — only meaningful outside fences (fenced chars are
  // already \x01, so spans there cannot match). The backreference form
  // handles single and double backtick runs (CommonMark: the same-length run
  // closes the span, so `` `$y$` `` masks the inner $y$ too).
  const masked = out.join("");
  return masked.replace(/(`+)([\s\S]*?)\1/g, (_m, ticks: string, body: string) => {
    return ticks + "\x01".repeat(body.length) + ticks;
  });
}

function scanMath(md: string): ScanMatch[] {
  const masked = maskCodeRegions(md);
  const matches: ScanMatch[] = [];
  COMBINED_MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMBINED_MATH_RE.exec(masked)) !== null) {
    // An escaped \$ (or \$$) is literal text, not math.
    if (m.index > 0 && masked[m.index - 1] === "\\") continue;
    if (m[1] !== undefined) {
      // Display math: reject whitespace-only content (e.g. "$$ $$").
      if (m[1].trim() === "") continue;
      matches.push({ start: m.index, end: m.index + m[0].length, tex: m[1], display: true });
    } else if (m[2] !== undefined) {
      matches.push({ start: m.index, end: m.index + m[0].length, tex: m[2], display: false });
    }
  }
  return matches;
}

export function findMathSpans(md: string): MathSpan[] {
  return scanMath(md).map((m, i) => ({ tex: m.tex, display: m.display, index: i }));
}

export function protectMath(md: string): ProtectResult {
  const matches = scanMath(md);
  if (matches.length === 0) return { md, spans: [] };
  let out = "";
  let cursor = 0;
  const spans: MathSpan[] = [];
  matches.forEach((m, i) => {
    out += md.slice(cursor, m.start);
    out += `<span data-inkbound-math="${i}"></span>`;
    spans.push({ tex: m.tex, display: m.display, index: i });
    cursor = m.end;
  });
  out += md.slice(cursor);
  return { md: out, spans };
}

export interface MathRenderResult {
  svg: string;
  ok: boolean;
}

export function renderMathToSvg(tex: string, display: boolean): MathRenderResult {
  if (UNRENDERABLE_CHARSET_RE.test(tex)) return { svg: "", ok: false };
  try {
    // containerWidth huge = never line-break (single-line SVG math).
    const node = mathDocument.convert(tex, { display, em: 16, ex: 8, containerWidth: 1_000_000 });
    const svg = adaptor.outerHTML(node);
    // MathJax's SVG error rendering: unknown commands/broken syntax come out
    // as red text (fill="red"), not as merror markup in this version.
    return { svg, ok: !svg.includes("merror") && !svg.includes('fill="red"') };
  } catch {
    return { svg: "", ok: false };
  }
}

export interface RenderedMathImage {
  newHref: string;
  bytes: Uint8Array;
  mediaType: string;
}

// 16px per em: math images are typeset at body-text scale so they sit
// naturally next to prose; readers can still scale the PNG via CSS.
const EM_PX = 16;

// MathJax SVG width/height are in ex units; pixel dims for the rasterizer
// come from the viewBox (1000 units = 1 em).
function normalizeMathSvg(svgEl: SVGSVGElement): void {
  const vb = (svgEl.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return;
  svgEl.setAttribute("width", String((vb[2] / 1000) * EM_PX));
  svgEl.setAttribute("height", String((vb[3] / 1000) * EM_PX));
}

function svgStringToElement(svgString: string): SVGSVGElement | null {
  try {
    // Template-based parsing instead of DOMParser: the local-export harness
    // installs jsdom globals by hand and does not expose DOMParser, while
    // a <template> works in real Obsidian, vitest, and the harness alike.
    // The HTML parser's foreign-content rules give the inner <svg> its SVG
    // namespace and adjust attribute case (viewBox etc.) automatically.
    const template = document.createElement("template");
    template.innerHTML = svgString;
    const svg = template.content.querySelector("svg");
    return svg ? (svg as unknown as SVGSVGElement) : null;
  } catch {
    return null;
  }
}

export async function renderMath(
  root: HTMLElement,
  spans: MathSpan[],
  startIndex: number,
  sourcePath = ""
): Promise<{ images: RenderedMathImage[]; warnings: string[] }> {
  const images: RenderedMathImage[] = [];
  const warnings: string[] = [];
  let warnedFallback = false;

  for (const span of spans) {
    const placeholder = root.querySelector(`[data-inkbound-math="${span.index}"]`);
    if (!placeholder) {
      warnings.push(
        `math placeholder ${span.index} missing after render — expression skipped (referenced by ${sourcePath})`
      );
      continue;
    }

    const { svg, ok } = renderMathToSvg(span.tex, span.display);

    // Unrenderable charset: restore the original source text — the readable
    // fallback per constitution II.
    if (!ok && svg === "") {
      const source = span.display ? `$$${span.tex}$$` : `$${span.tex}$`;
      placeholder.replaceWith(createTextNodeSafe(source));
      warnings.push(
        `math contains non-Latin characters that cannot be rendered — kept as source text (referenced by ${sourcePath})`
      );
      continue;
    }

    if (!ok) {
      warnings.push(`math could not be rendered: ${span.tex} (referenced by ${sourcePath})`);
    }

    const svgEl = svgStringToElement(svg);
    if (!svgEl) {
      placeholder.remove();
      warnings.push(`math SVG could not be parsed — expression removed (referenced by ${sourcePath})`);
      continue;
    }
    normalizeMathSvg(svgEl);

    const result = await getSvgRasterizer()(svgEl);
    if (result) {
      const index = startIndex + images.length + 1;
      const newHref = `../images/img_${String(index).padStart(3, "0")}.png`;
      const img = createEl("img");
      img.setAttribute("src", newHref);
      img.setAttribute("alt", span.tex);
      // XHTML width must be an integer (epubcheck RSC-005), same rule the
      // Mermaid rasterization applies — round it.
      if (Number.isFinite(result.width)) {
        img.setAttribute("width", String(Math.round(result.width)));
      }
      // MathJax computes the baseline offset relative to its own ex unit;
      // CSS ex on the img resolves against the inherited font size, which
      // matches at the 16px typesetting scale.
      const style = svgEl.getAttribute("style");
      if (style) img.setAttribute("style", style);
      if (span.display) {
        const p = createEl("p");
        p.classList.add("math-block");
        p.appendChild(img);
        placeholder.replaceWith(p);
      } else {
        placeholder.replaceWith(img);
      }
      images.push({ newHref, bytes: result.bytes, mediaType: "image/png" });
    } else {
      // Keep the (normalized, px-sized) inline SVG — epub.ts stamps
      // properties="svg" on chapters whose body contains <svg>, so this is
      // still a spec-valid book.
      placeholder.replaceWith(svgEl);
      if (!warnedFallback) {
        warnings.push("math rasterization unavailable — kept inline SVG (may not render on e-ink)");
        warnedFallback = true;
      }
    }
  }

  return { images, warnings };
}

function createTextNodeSafe(text: string): Text {
  return document.createTextNode(text);
}
