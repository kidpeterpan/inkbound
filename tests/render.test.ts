import { describe, it, expect } from "vitest";
import {
  stripFrontmatter, stripDynamicBlocks, cleanupDom,
  rewriteLinks, rewriteImages, serializeBody,
} from "../src/render";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
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
    const el = div('<div class="edit-block-button">e</div><button class="copy-code-button">c</button><p>keep</p>');
    cleanupDom(el);
    expect(el.querySelector(".edit-block-button")).toBeNull();
    expect(el.querySelector(".copy-code-button")).toBeNull();
    expect(el.querySelector("p")?.textContent).toBe("keep");
  });
  it("converts checkboxes to glyphs", () => {
    const el = div('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>');
    cleanupDom(el);
    expect(el.querySelectorAll("input").length).toBe(0);
    expect(el.textContent).toContain("☑");
    expect(el.textContent).toContain("☐");
  });
  it("unwraps rendered image embeds (preserves img)", () => {
    const el = div('<span class="internal-embed image-embed is-loaded" src="pic.png"><img src="app://pic.png" alt="pic"></span>');
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
    expect(found).toEqual([
      { vaultPath: "05. assets/pic one.png", newHref: "../images/img_001.png" },
    ]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("../images/img_001.png");
    expect(imgs[1].getAttribute("src")).toBe("https://x.com/y.jpg");
  });
  it("tolerates malformed image URIs with literal percent", () => {
    const base = "/Users/pan/vault";
    const el = div(
      `<img src="app://abc123${base}/100%off.png">`
    );
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
