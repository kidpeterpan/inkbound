import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stripFrontmatter,
  stripDynamicBlocks,
  cleanupDom,
  normalizeMermaidSvg,
  rewriteLinks,
  rewriteImages,
  serializeBody,
} from "../src/render";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

// Real captured Obsidian mermaid output (binary-search flowchart, Grokking
// Algorithms) — 18,761 chars, 19 foreignObject (15 with real width/height, 4
// empty edge-label placeholders), 26 ids, 15 <p> inside <span>, 10 url(#…)
// references, 10 marker/clip-path attributes, 1 <style> block, 0 <text>.
// Testing against this rather than a hand-written approximation is the
// point: it can actually fail if the transform regresses.
const MERMAID_FIXTURE = readFileSync(join(__dirname, "fixtures/mermaid-real.xhtml"), "utf8");

// Collects every id/href/url(#...) reference under root and asserts each one
// resolves to an id that actually exists in the document.
function assertAllReferencesResolve(root: HTMLElement): void {
  const ids = new Set(Array.from(root.querySelectorAll("[id]")).map((el) => el.getAttribute("id")));
  root.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const urlMatch = attr.value.match(/url\(#([^)]+)\)/);
      if (urlMatch) expect(ids.has(urlMatch[1])).toBe(true);
      if ((attr.name === "href" || attr.name.endsWith(":href")) && attr.value.startsWith("#")) {
        expect(ids.has(attr.value.slice(1))).toBe(true);
      }
    });
  });
}

describe("stripFrontmatter", () => {
  it("removes a leading yaml block", () => {
    expect(stripFrontmatter("---\ntags: [x]\n---\n# Hi")).toBe("# Hi");
  });
  it("leaves body-only notes alone", () => {
    expect(stripFrontmatter("# Hi\n---\nrule")).toBe("# Hi\n---\nrule");
  });
});

describe("stripDynamicBlocks", () => {
  it("replaces dataview fences", () => {
    const md = "before\n```dataview\nLIST\n```\nafter";
    expect(stripDynamicBlocks(md)).toBe("before\n*[dynamic content omitted]*\nafter");
  });
  it("replaces dataviewjs fences too", () => {
    expect(stripDynamicBlocks("```dataviewjs\ndv.list()\n```")).toBe("*[dynamic content omitted]*");
  });
});

describe("cleanupDom", () => {
  it("strips Obsidian UI chrome", () => {
    const el = div(
      '<div class="edit-block-button">e</div><button class="copy-code-button">c</button><p>keep</p>'
    );
    cleanupDom(el);
    expect(el.querySelector(".edit-block-button")).toBeNull();
    expect(el.querySelector(".copy-code-button")).toBeNull();
    expect(el.querySelector("p")?.textContent).toBe("keep");
  });
  it("converts checkboxes to glyphs", () => {
    const el = div(
      '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>'
    );
    cleanupDom(el);
    expect(el.querySelectorAll("input").length).toBe(0);
    expect(el.textContent).toContain("☑");
    expect(el.textContent).toContain("☐");
  });
  it("unwraps rendered image embeds (preserves img)", () => {
    const el = div(
      '<span class="internal-embed image-embed is-loaded" src="pic.png"><img src="app://pic.png" alt="pic"></span>'
    );
    cleanupDom(el);
    expect(el.querySelector("span.internal-embed")).toBeNull();
    expect(el.querySelector("img")).not.toBeNull();
    expect(el.textContent).not.toContain("[embedded content omitted");
  });
  it("replaces unrendered embeds with an omission marker", () => {
    const el = div('<span class="internal-embed" src="drawing.excalidraw">x</span>');
    cleanupDom(el);
    expect(el.querySelector("span.internal-embed")).toBeNull();
    expect(el.textContent).toContain("[embedded content omitted: drawing.excalidraw]");
  });
  it("degrades tag anchors to plain text (no dead #fragment links)", () => {
    const el = div('<p>text <a class="tag" href="#book" target="_blank" rel="noopener">#book</a></p>');
    cleanupDom(el);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("#book");
  });
});

describe("normalizeMermaidSvg (via cleanupDom, real fixture)", () => {
  it("removes every foreignObject and every p-inside-span (the 186-error root cause)", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    expect(el.querySelectorAll("foreignObject").length).toBe(0);
    expect(el.querySelectorAll("span p").length).toBe(0);
  });

  it("creates real SVG <text> elements with the actual fixture label content", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const texts = Array.from(el.querySelectorAll("text"));
    expect(texts.length).toBeGreaterThanOrEqual(15);
    const combined = texts.map((t) => t.textContent).join(" | ");
    // Real label strings read off the fixture's <p> elements, not invented.
    expect(combined).toContain("low <= high?");
    expect(combined).toContain("return None");
    expect(combined).toContain("guess == item?");
  });

  it("preserves a multi-line label (mermaid's <br/>-joined <p>) as two tspans", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const texts = Array.from(el.querySelectorAll("text"));
    const multiLine = texts.find((t) => (t.textContent ?? "").includes("mid = (low + high)"));
    expect(multiLine).toBeDefined();
    const tspans = multiLine!.querySelectorAll("tspan");
    expect(tspans.length).toBe(2);
    expect(tspans[0].textContent).toBe("mid = (low + high) // 2");
    expect(tspans[1].textContent).toBe("guess = list[mid]");
    expect(tspans[1].getAttribute("dy")).toBe("1.2em");
  });

  it("created <text>/<tspan> nodes are in the SVG namespace", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const text = el.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    const tspan = el.querySelector("tspan");
    expect(tspan).not.toBeNull();
    expect(tspan!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("every id in the document is unique after normalization", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const ids = Array.from(el.querySelectorAll("[id]")).map((n) => n.getAttribute("id"));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every url(#X) / href=#X reference resolves to an existing id", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    assertAllReferencesResolve(el);
  });

  it("gives a second, separately-indexed diagram in the same root a different id prefix", () => {
    const el = div(MERMAID_FIXTURE + MERMAID_FIXTURE);
    normalizeMermaidSvg(el);
    const ids = Array.from(el.querySelectorAll("[id]")).map((n) => n.getAttribute("id")!);
    // Every id is still globally unique across both diagrams...
    expect(new Set(ids).size).toBe(ids.length);
    // ...because the two copies were prefixed distinctly (m1_ / m2_).
    expect(ids.some((id) => id.startsWith("m1_"))).toBe(true);
    expect(ids.some((id) => id.startsWith("m2_"))).toBe(true);
    assertAllReferencesResolve(el);
  });

  it('rewrites a plain href="#id" reference (e.g. <use>) to the prefixed id', () => {
    const el = div(
      '<svg xmlns="http://www.w3.org/2000/svg" id="root"><defs><path id="shape" d="M0 0"/></defs>' +
        '<use href="#shape"/></svg>'
    );
    normalizeMermaidSvg(el);
    expect(el.querySelector("use")?.getAttribute("href")).toBe("#m1_shape");
    assertAllReferencesResolve(el);
  });

  it('rewrites an xlink:href="#id" reference to the prefixed id', () => {
    const el = div(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="root">' +
        '<defs><path id="shape" d="M0 0"/></defs><use xlink:href="#shape"/></svg>'
    );
    normalizeMermaidSvg(el);
    expect(el.querySelector("use")?.getAttribute("xlink:href")).toBe("#m1_shape");
  });

  it('leaves a dangling href="#id" untouched when the id isn\'t present in this svg', () => {
    const el = div('<svg xmlns="http://www.w3.org/2000/svg" id="root"><use href="#missing"/></svg>');
    normalizeMermaidSvg(el);
    expect(el.querySelector("use")?.getAttribute("href")).toBe("#missing");
  });

  it("removes an empty edge-label foreignObject (height=0 width=0, no text) instead of creating an empty <text>", () => {
    const el = div(
      '<svg xmlns="http://www.w3.org/2000/svg" id="x"><g><foreignObject height="0" width="0">' +
        '<div xmlns="http://www.w3.org/1999/xhtml"><span class="edgeLabel"></span></div></foreignObject></g></svg>'
    );
    normalizeMermaidSvg(el);
    expect(el.querySelectorAll("foreignObject").length).toBe(0);
    expect(el.querySelectorAll("text").length).toBe(0);
  });

  it("rewrites the <style> element's selectors to the new prefixed svg id (leaves no bare-old-id selector)", () => {
    const original = div(MERMAID_FIXTURE);
    const oldId = original.querySelector("svg")!.id;
    expect(oldId).toBeTruthy();

    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const style = el.querySelector("style");
    expect(style).not.toBeNull();
    const newId = el.querySelector("svg")!.id;
    expect(newId).not.toBe(oldId);
    expect(newId.endsWith(oldId)).toBe(true);

    // The style now targets the new id...
    expect(style!.textContent).toContain(`#${newId}`);
    // ...and no longer contains the bare old id as a selector (a plain
    // substring match would be a false negative if newId simply extends
    // oldId, so this checks specifically for "#OLD" not followed by an
    // id-continuation character).
    const bareOldIdSelector = new RegExp(`#${oldId}(?![A-Za-z0-9_-])`);
    expect(bareOldIdSelector.test(style!.textContent ?? "")).toBe(false);
  });

  it("gives each of two duplicated diagrams a <style> block scoped to its OWN prefix", () => {
    const el = div(MERMAID_FIXTURE + MERMAID_FIXTURE);
    normalizeMermaidSvg(el);
    const svgs = Array.from(el.querySelectorAll("svg"));
    expect(svgs.length).toBe(2);
    const [svg1, svg2] = svgs;
    expect(svg1.id.startsWith("m1_")).toBe(true);
    expect(svg2.id.startsWith("m2_")).toBe(true);

    const style1 = svg1.querySelector("style")!.textContent ?? "";
    const style2 = svg2.querySelector("style")!.textContent ?? "";
    expect(style1).toContain(`#${svg1.id}`);
    expect(style2).toContain(`#${svg2.id}`);
    // Cross-contamination check: the m1_-prefixed style must not reference
    // any m2_ id and vice versa.
    expect(style1.includes(svg2.id)).toBe(false);
    expect(style2.includes(svg1.id)).toBe(false);
  });

  it("adds a sans-serif fallback to the mermaid font-family CSS variable (which only resolves inside Obsidian)", () => {
    const el = div(MERMAID_FIXTURE);
    cleanupDom(el);
    const style = el.querySelector("style");
    expect(style!.textContent).toContain("var(--font-mermaid, sans-serif)");
    expect(style!.textContent).not.toContain("var(--font-mermaid)");
  });
});

describe("rewriteLinks", () => {
  const resolve = (lp: string) => (lp === "Chapter Two" ? "book/02_two.md" : null);
  it("links inside the export set become chapter hrefs", () => {
    const el = div('<a class="internal-link" data-href="Chapter Two" href="Chapter Two">next</a>');
    const map = new Map([["book/02_two.md", "text/chapter_002.xhtml"]]);
    const warnings = rewriteLinks(el, map, resolve);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("chapter_002.xhtml");
    expect(warnings).toEqual([]);
  });
  it("links outside the set degrade to spans keeping text", () => {
    const el = div('<a class="internal-link" data-href="Elsewhere" href="Elsewhere">see this</a>');
    const warnings = rewriteLinks(el, new Map(), resolve);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("see this");
    expect(warnings.length).toBe(0);
  });
  it("external links are left untouched", () => {
    const el = div('<a href="https://example.com">ext</a>');
    rewriteLinks(el, new Map(), resolve);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });
});

describe("rewriteImages", () => {
  it("maps app:// resource srcs to sequential internal hrefs", () => {
    const base = "/Users/pan/vault";
    const el = div(
      `<img src="app://abc123${base}/05.%20assets/pic%20one.png?1699"><img src="https://x.com/y.jpg">`
    );
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "05. assets/pic one.png", newHref: "../images/img_001.png" }]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("../images/img_001.png");
    expect(imgs[1].getAttribute("src")).toBe("https://x.com/y.jpg");
  });
  it("tolerates malformed image URIs with literal percent", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="app://abc123${base}/100%off.png">`);
    const found = rewriteImages(el, base);
    // Malformed URI is skipped: src unchanged, not in found list.
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(`app://abc123${base}/100%off.png`);
  });
  it("offsets numbering with startIndex to avoid collisions across chapters", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="app://abc123${base}/pic.png">`);
    const found = rewriteImages(el, base, 2);
    expect(found[0].newHref).toBe("../images/img_003.png");
  });

  it("rewrites a bare relative markdown image src", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="fig03-1_nested_boxes.png">`);
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "fig03-1_nested_boxes.png", newHref: "../images/img_001.png" }]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("../images/img_001.png");
    expect(el.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("rewrites a nested relative markdown image src", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="assets/pic.png">`);
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "assets/pic.png", newHref: "../images/img_001.png" }]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("../images/img_001.png");
  });

  it("leaves remote and self-contained srcs completely untouched", () => {
    const base = "/Users/pan/vault";
    const el = div(
      '<img src="https://x.com/y.jpg">' +
        '<img src="data:image/png;base64,AAAA">' +
        '<img src="//cdn.example.com/z.png">'
    );
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("https://x.com/y.jpg");
    expect(imgs[1].getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(imgs[2].getAttribute("src")).toBe("//cdn.example.com/z.png");
  });

  it("leaves an already-rewritten src untouched (idempotence)", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="../images/img_001.png">`);
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("../images/img_001.png");
  });

  // ── A: generic, case-insensitive scheme classification ────────────────

  it("leaves an uppercase HTTPS scheme untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="HTTPS://x.com/y.jpg">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("HTTPS://x.com/y.jpg");
  });

  it("leaves an uppercase DATA scheme untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="DATA:image/png;base64,AAAA">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("DATA:image/png;base64,AAAA");
  });

  it("leaves a blob: scheme untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="blob:https://x.com/abc-123">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:https://x.com/abc-123");
  });

  it("leaves a file:// scheme untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="file:///Users/pan/pic.png">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("file:///Users/pan/pic.png");
  });

  it("leaves a mailto: scheme untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="mailto:x@y.z">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("mailto:x@y.z");
  });

  it("leaves a protocol-relative src untouched", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="//host/x.png">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("//host/x.png");
  });

  // ── B: tighter idempotence sentinel ────────────────────────────────────

  it("does not treat a sibling-folder relative reference as already rewritten", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="../images/fig.png">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "../images/fig.png", newHref: "../images/img_001.png" }]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("../images/img_001.png");
  });

  // ── C: empty src ────────────────────────────────────────────────────────

  it("skips an empty src without allocating an image number or warning", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src=""><img src="pic.png">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "pic.png", newHref: "../images/img_001.png" }]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("");
    expect(imgs[1].getAttribute("src")).toBe("../images/img_001.png");
  });

  it("skips an img with no src attribute at all", () => {
    const base = "/Users/pan/vault";
    const el = div("<img>");
    const found = rewriteImages(el, base);
    expect(found).toEqual([]);
  });

  // ── D: app:// src whose path doesn't contain basePath ──────────────────

  it("falls through to basename resolution when app:// path lacks basePath", () => {
    const base = "/Users/pan/vault";
    const el = div('<img src="app://abc123/some/other/place/fig.png">');
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "fig.png", newHref: "../images/img_001.png" }]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("../images/img_001.png");
  });

  // ── E: strip #fragment in the app:// branch too ────────────────────────

  it("strips a #fragment from an app:// src so the extension match succeeds", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="app://abc123${base}/fig.jpg#anchor">`);
    const found = rewriteImages(el, base);
    expect(found).toEqual([{ vaultPath: "fig.jpg", newHref: "../images/img_001.jpg" }]);
  });

  it("numbers sequentially across app://, relative and remote srcs in one document, skipping remote", () => {
    const base = "/Users/pan/vault";
    const el = div(
      `<img src="app://abc123${base}/first.png">` +
        '<img src="https://x.com/skip.jpg">' +
        '<img src="second.png">'
    );
    const found = rewriteImages(el, base);
    expect(found).toEqual([
      { vaultPath: "first.png", newHref: "../images/img_001.png" },
      { vaultPath: "second.png", newHref: "../images/img_002.png" },
    ]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("../images/img_001.png");
    expect(imgs[1].getAttribute("src")).toBe("https://x.com/skip.jpg");
    expect(imgs[2].getAttribute("src")).toBe("../images/img_002.png");
  });

  it("preserves extension for a relative .jpg src and applies startIndex offset", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="photo.jpg">`);
    const found = rewriteImages(el, base, 5);
    expect(found).toEqual([{ vaultPath: "photo.jpg", newHref: "../images/img_006.jpg" }]);
  });
});

describe("serializeBody", () => {
  it("returns bare children fragment (no wrapper, no xmlns)", () => {
    const el = div("<p>a<br>b</p>");
    expect(serializeBody(el)).toBe("<p>a<br/>b</p>");
  });
  it("serializes multiple children", () => {
    const el = div("<h1>t</h1><p>x</p>");
    expect(serializeBody(el)).toBe("<h1>t</h1><p>x</p>");
  });
  it("returns empty string for empty root", () => {
    const el = div("");
    expect(serializeBody(el)).toBe("");
  });
});
