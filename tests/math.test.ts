import { describe, expect, it, afterEach } from "vitest";
import { findMathSpans, protectMath, renderMathToSvg, renderMath } from "../src/math";
import { setSvgRasterizer } from "../src/render";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("findMathSpans", () => {
  it("detects inline math with simple content", () => {
    const spans = findMathSpans("cost is $x^2$ dollars");
    expect(spans).toHaveLength(1);
    expect(spans[0].tex).toBe("x^2");
    expect(spans[0].display).toBe(false);
  });

  it("detects display math with $$ delimiters", () => {
    const spans = findMathSpans("$$e^{i\\pi}+1=0$$");
    expect(spans).toHaveLength(1);
    expect(spans[0].tex).toBe("e^{i\\pi}+1=0");
    expect(spans[0].display).toBe(true);
  });

  it("detects a display block spanning multiple lines", () => {
    const spans = findMathSpans("$$\n\\frac{a}{b}\n$$");
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].tex).toContain("frac");
  });

  it("detects multiple expressions in document order with interleaved display/inline", () => {
    const md = "first $a$ then\n$$\nb+c\n$$\nand $d$";
    const spans = findMathSpans(md);
    expect(spans.map((s) => s.display)).toEqual([false, true, false]);
    expect(spans.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("does not treat currency as math ($50, $ 50, $50.50)", () => {
    expect(findMathSpans("it costs $50")).toHaveLength(0);
    expect(findMathSpans("it costs $ 50")).toHaveLength(0);
    expect(findMathSpans("it costs $50.50")).toHaveLength(0);
    expect(findMathSpans("from $50 to $100")).toHaveLength(0);
  });

  it("does not treat a lone dollar as math", () => {
    expect(findMathSpans("just $ here")).toHaveLength(0);
    expect(findMathSpans("eof $")).toHaveLength(0);
  });

  it("rejects delimiters with whitespace against them ($ x$ and $x $)", () => {
    expect(findMathSpans("$ x$")).toHaveLength(0);
    expect(findMathSpans("$x $")).toHaveLength(0);
  });

  it("does not detect math inside fenced code blocks", () => {
    const md = "```\n$not_math$\n$$\nalso_not\n$$\n```\nbut $real$ here";
    const spans = findMathSpans(md);
    expect(spans).toHaveLength(1);
    expect(spans[0].tex).toBe("real");
  });

  it("does not detect math inside inline code spans (single or double backticks)", () => {
    const md = "use `$x$` and `` `$y$` `` for prose";
    expect(findMathSpans(md)).toHaveLength(0);
  });

  it("ignores empty $$ delimiters", () => {
    expect(findMathSpans("$$$$")).toHaveLength(0);
    expect(findMathSpans("$$ $$")).toHaveLength(0);
  });

  it("ignores unclosed delimiters", () => {
    expect(findMathSpans("$$never closed")).toHaveLength(0);
    expect(findMathSpans("$never closed")).toHaveLength(0);
  });

  it("detects math inside callouts, headings, and table cells", () => {
    const md = "> [!note] see $\\alpha$\n\n## Energy $E=mc^2$\n\n| col |\n|---|\n| $\\beta$ |";
    const spans = findMathSpans(md);
    expect(spans).toHaveLength(3);
  });

  it("detects math containing Thai inside \\text{}", () => {
    const spans = findMathSpans("$\\text{ไทย}$");
    expect(spans).toHaveLength(1);
    expect(spans[0].tex).toBe("\\text{ไทย}");
  });

  it("does not detect an escaped dollar (\\$)", () => {
    expect(findMathSpans("\\$not math$")).toHaveLength(0);
    expect(findMathSpans("price is \\$5")).toHaveLength(0);
  });

  it("detects adjacent inline expressions separately", () => {
    const spans = findMathSpans("$x$$y$");
    expect(spans).toHaveLength(2);
    expect(spans[0].tex).toBe("x");
    expect(spans[1].tex).toBe("y");
  });
});

describe("protectMath", () => {
  it("replaces each expression with a uniquely indexed placeholder span", () => {
    const md = "alpha $a$ beta $$b$$ gamma $c$";
    const { md: out, spans } = protectMath(md);
    expect(spans).toHaveLength(3);
    expect(out).toBe(
      'alpha <span data-inkbound-math="0"></span> beta <span data-inkbound-math="1"></span> gamma <span data-inkbound-math="2"></span>'
    );
  });

  it("preserves all non-math content byte-for-byte, including inline code and fences", () => {
    const md = "```\n$inside_fence$\n```\nand `$code$` stays, $math$ goes";
    const { md: out, spans } = protectMath(md);
    expect(spans).toHaveLength(1);
    expect(out).toContain("```\n$inside_fence$\n```");
    expect(out).toContain("`$code$` stays,");
    expect(out).toContain('<span data-inkbound-math="0"></span> goes');
    expect(out).not.toContain("$math$");
  });

  it("returns the input unchanged when there is no math", () => {
    const md = "plain prose with $50 and ```code```";
    const { md: out, spans } = protectMath(md);
    expect(spans).toHaveLength(0);
    expect(out).toBe(md);
  });
});

describe("renderMathToSvg", () => {
  it("returns a deterministic SVG string for valid LaTeX", () => {
    const a = renderMathToSvg("x^2", false);
    const b = renderMathToSvg("x^2", false);
    expect(a.ok).toBe(true);
    expect(a.svg).toContain("<svg");
    expect(a.svg).toContain("viewBox");
    expect(a.svg).toBe(b.svg);
  });

  it("includes a vertical-align style in the root svg (inline baseline)", () => {
    const { svg } = renderMathToSvg("\\frac{1}{2}", false);
    expect(svg).toContain("vertical-align");
  });

  it("renders display mode without error", () => {
    const { svg, ok } = renderMathToSvg("\\sum_{i=1}^{n} i", true);
    expect(ok).toBe(true);
    expect(svg).toContain("<svg");
  });

  it("marks an invalid command as not-ok with a readable error rendering", () => {
    const r = renderMathToSvg("\\invalidcommand", false);
    expect(r.ok).toBe(false);
    // MathJax draws the error text as glyph paths, so the raw command string
    // does not appear literally — the red error fill is the signal.
    expect(r.svg).toContain('fill="red"');
  });

  it("marks Thai text inside \\text{} as not-ok (unrenderable charset, empty svg)", () => {
    const r = renderMathToSvg("\\text{ไทย}", false);
    expect(r.ok).toBe(false);
    expect(r.svg).toBe("");
  });

  it("marks CJK text as not-ok", () => {
    const r = renderMathToSvg("\\text{中文}", false);
    expect(r.ok).toBe(false);
  });

  it("keeps Latin-1 accented text renderable", () => {
    const r = renderMathToSvg("\\text{caf\\'e}", false);
    expect(r.ok).toBe(true);
  });
});

describe("renderMath", () => {
  afterEach(() => {
    setSvgRasterizer(null);
  });

  it("replaces a display placeholder with a <p><img> pointing at a numbered PNG", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: 123.4, height: 50 }));
    const root = div('<p>before</p><span data-inkbound-math="0"></span><p>after</p>');
    const spans = [{ tex: "x^2", display: true, index: 0 }];
    const r = await renderMath(root, spans, 4);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].newHref).toBe("../images/img_005.png");
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("../images/img_005.png");
    expect(img.getAttribute("width")).toBe("123");
    expect(img.parentElement?.tagName.toLowerCase()).toBe("p");
    expect(root.querySelector('[data-inkbound-math="0"]')).toBeNull();
  });

  it("replaces an inline placeholder with a bare <img> (no wrapper) carrying vertical-align", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([2]), width: 30, height: 10 }));
    const root = div('<p>text <span data-inkbound-math="1"></span> more</p>');
    const spans = [{ tex: "x", display: false, index: 1 }];
    const r = await renderMath(root, spans, 0);
    expect(r.images).toHaveLength(1);
    const img = root.querySelector("img")!;
    expect(img.parentElement?.tagName.toLowerCase()).toBe("p");
    expect(img.getAttribute("src")).toBe("../images/img_001.png");
    expect(img.getAttribute("style")).toContain("vertical-align");
  });

  it("keeps the inline SVG and warns once when rasterization is unavailable", async () => {
    setSvgRasterizer(async () => null);
    const root = div('<span data-inkbound-math="0"></span>');
    const spans = [{ tex: "x", display: false, index: 0 }];
    const r = await renderMath(root, spans, 0);
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toEqual([
      "math rasterization unavailable — kept inline SVG (may not render on e-ink)",
    ]);
    expect(root.querySelector("svg")).not.toBeNull();
  });

  it("still rasterizes a parse-error expression and warns per expression", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([3]), width: 10, height: 10 }));
    const root = div('<span data-inkbound-math="0"></span>');
    const spans = [{ tex: "\\invalidcommand", display: false, index: 0 }];
    const r = await renderMath(root, spans, 0, "My Note.md");
    expect(r.images).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("math could not be rendered");
    expect(r.warnings[0]).toContain("My Note.md");
    expect(root.querySelector("img")).not.toBeNull();
  });

  it("warns when a placeholder is missing from the DOM and never throws", async () => {
    const root = div("<p>nothing here</p>");
    const spans = [{ tex: "x", display: false, index: 7 }];
    const r = await renderMath(root, spans, 0, "Note.md");
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("placeholder");
  });

  it("restores the raw source text (readable fallback) when the charset is unrenderable", async () => {
    const root = div('<p>see <span data-inkbound-math="0"></span> here</p>');
    const spans = [{ tex: "\\text{ไทย}", display: false, index: 0 }];
    const r = await renderMath(root, spans, 0, "Note.md");
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("non-Latin");
    expect(root.textContent).toContain("$\\text{ไทย}$");
    expect(root.querySelector('[data-inkbound-math="0"]')).toBeNull();
  });

  it("numbers multiple math images continuously from startIndex", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([4]), width: 10, height: 10 }));
    const root = div('<span data-inkbound-math="0"></span><span data-inkbound-math="1"></span>');
    const spans = [
      { tex: "a", display: false, index: 0 },
      { tex: "b", display: true, index: 1 },
    ];
    const r = await renderMath(root, spans, 9);
    expect(r.images.map((i) => i.newHref)).toEqual(["../images/img_010.png", "../images/img_011.png"]);
  });
});
