import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stripFrontmatter,
  stripDynamicBlocks,
  cleanupDom,
  flattenEmbeds,
  splitEmbedTarget,
  isImageEmbedSrc,
  findHeadingSection,
  findBlockRange,
  listItemRange,
  dedentBlock,
  stripBlockMarker,
  EMBED_RENDERED_ATTR,
  normalizeMermaidSvg,
  rewriteLinks,
  rewriteImages,
  rasterizeMermaidDiagrams,
  setSvgRasterizer,
  serializeBody,
  collectHeadingToc,
} from "../src/render";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

// Builds the confirmed real-Obsidian note-embed wrapper shape (see
// render.ts's "Note-embed hardening" comment) PROGRAMMATICALLY — the way the
// real app builds it. It cannot be built via innerHTML: the HTML parser
// hoists block <div>s out of a <span> inside a <p>, silently destroying the
// exact structure under test.
function realEmbedWrapper(opts: {
  src: string;
  /** HTML for the copy populateEmbeds rendered (its stamped div is created only when set). */
  ourHtml?: string;
  /** HTML for Obsidian's own async-rendered preview inside .markdown-embed-content. */
  obsidianPreview?: string;
  /** data-embed-reason populateEmbeds stamped, if any. */
  reason?: string;
  tag?: "span" | "div";
}): HTMLElement {
  const wrapper = document.createElement(opts.tag ?? "span");
  wrapper.className = "internal-embed markdown-embed inline-embed";
  wrapper.setAttribute("src", opts.src);
  wrapper.setAttribute("alt", opts.src);
  if (opts.reason) wrapper.setAttribute("data-embed-reason", opts.reason);
  const title = document.createElement("div");
  title.className = "embed-title markdown-embed-title";
  title.textContent = opts.src;
  wrapper.appendChild(title);
  const content = document.createElement("div");
  content.className = "markdown-embed-content";
  if (opts.obsidianPreview) {
    const preview = document.createElement("div");
    preview.className = "markdown-preview-view markdown-rendered";
    preview.innerHTML = opts.obsidianPreview;
    content.appendChild(preview);
  }
  wrapper.appendChild(content);
  if (opts.ourHtml !== undefined) {
    const ours = document.createElement("div");
    ours.setAttribute("data-inkbound-embed", "");
    ours.innerHTML = opts.ourHtml;
    wrapper.appendChild(ours);
  }
  return wrapper;
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

// tests/fixtures/obsidian-stub.ts installs a bare-global `createEl` (loaded
// via tests/setup/no-network.ts for every test file) mirroring Obsidian's
// ambient global declared in node_modules/obsidian/obsidian.d.ts. src/render.ts
// calls this global directly (see its top-of-file comment) for every
// plain-HTML-element site the obsidianmd/prefer-create-el review warning
// flagged. The one behavior that differs from the Node.prototype method of
// the same name — no auto-append to a parent — is asserted here directly,
// since getting that wrong would silently change DOM structure everywhere
// render.ts uses it.
describe("global createEl polyfill (test harness)", () => {
  it("creates the requested tag without appending it to any parent", () => {
    const el = createEl("span");
    expect(el.tagName.toLowerCase()).toBe("span");
    expect(el.parentNode).toBeNull();
  });

  it("applies cls/text/attr from the DomElementInfo argument", () => {
    const el = createEl("p", { cls: "omitted", text: "hello", attr: { "data-x": "1" } });
    expect(el.className).toBe("omitted");
    expect(el.textContent).toBe("hello");
    expect(el.getAttribute("data-x")).toBe("1");
    expect(el.parentNode).toBeNull();
  });

  it("treats a bare string argument as the class name", () => {
    const el = createEl("span", "foo bar");
    expect(el.className).toBe("foo bar");
  });

  it("invokes the callback with the created element", () => {
    let seen: HTMLElement | undefined;
    const el = createEl("canvas", undefined, (c) => {
      seen = c;
    });
    expect(seen).toBe(el);
  });
});

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
  it("flattens embed wrappers as part of cleanup (delegation to flattenEmbeds)", () => {
    const el = div("<h1>Host content</h1>");
    el.appendChild(realEmbedWrapper({ src: "Other Note", ourHtml: "<h2>Section</h2><p>Body text</p>" }));
    const warnings = cleanupDom(el);
    expect(el.querySelector(".internal-embed")).toBeNull();
    expect(el.querySelector("h2")?.textContent).toBe("Section");
    expect(el.querySelector("h1")?.textContent).toBe("Host content");
    expect(warnings).toEqual([]);
  });
  it("degrades tag anchors to plain text (no dead #fragment links)", () => {
    const el = div('<p>text <a class="tag" href="#book" target="_blank" rel="noopener">#book</a></p>');
    cleanupDom(el);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("#book");
  });
});

describe("flattenEmbeds (wrapper-based — the confirmed real-Obsidian shape)", () => {
  it("replaces the wrapper with OUR rendered copy, discarding the title and Obsidian's own async preview", () => {
    const el = document.createElement("div");
    el.appendChild(
      realEmbedWrapper({
        src: "Other Note",
        ourHtml: "<h2>Section</h2><p>Body text</p>",
        obsidianPreview: "<p>obsidian's own late copy</p>",
      })
    );
    const warnings = flattenEmbeds(el);
    expect(warnings).toEqual([]);
    expect(el.querySelector(".internal-embed")).toBeNull();
    expect(el.querySelector(".markdown-embed-title")).toBeNull();
    expect(el.querySelector("h2")?.textContent).toBe("Section");
    // Race immunity: whatever Obsidian's async loader put in the content
    // div is discarded, never duplicated alongside our copy.
    expect(el.textContent).not.toContain("obsidian's own late copy");
    expect(el.textContent).not.toContain("[embedded content omitted");
  });

  it("unwraps the enclosing <p> when the embed span is its only child (real shape: <p><span.internal-embed/></p>)", () => {
    // An embed on its own line renders inside a <p>; leaving the embedded
    // note's block content inside that <p> would be invalid XHTML.
    const el = document.createElement("div");
    const p = document.createElement("p");
    p.setAttribute("dir", "auto");
    p.appendChild(realEmbedWrapper({ src: "Other Note", ourHtml: "<h2>Section</h2>", tag: "span" }));
    el.appendChild(p);
    flattenEmbeds(el);
    expect(el.querySelector("p h2")).toBeNull();
    expect(el.querySelector("h2")?.textContent).toBe("Section");
    expect(el.querySelector("p")).toBeNull(); // the wrapper-only <p> itself is gone
  });

  it("replaces just the wrapper (not the enclosing <p>) when the embed has a real inline text sibling", () => {
    // The onlyChild check in embedReplaceTarget's false branch: an embed
    // wrapper sharing its <p> with real surrounding text can't have that
    // whole <p> replaced without losing the text, so only the wrapper itself
    // is swapped out — accepting the (rare) resulting block-inside-<p> shape
    // as a known trade-off over destroying sibling content.
    const el = document.createElement("div");
    const p = document.createElement("p");
    p.appendChild(document.createTextNode("See also: "));
    p.appendChild(realEmbedWrapper({ src: "Other Note", ourHtml: "<h2>Section</h2>", tag: "span" }));
    el.appendChild(p);
    flattenEmbeds(el);
    expect(el.querySelector("p")).not.toBeNull();
    expect(el.textContent).toContain("See also:");
    expect(el.querySelector("h2")?.textContent).toBe("Section");
  });

  it("replaces an unresolved loaded embed (file-embed mod-empty) with the placeholder — no leaked 'Click to create.' text", () => {
    const el = document.createElement("div");
    const wrapper = document.createElement("span");
    wrapper.className = "internal-embed is-loaded file-embed mod-empty";
    wrapper.setAttribute("src", "Does Not Exist");
    wrapper.setAttribute("data-embed-reason", "unresolved");
    wrapper.textContent = '"Does Not Exist" is not created yet. Click to create.';
    el.appendChild(wrapper);
    const warnings = flattenEmbeds(el);
    expect(warnings).toEqual(["missing embed: Does Not Exist"]);
    expect(el.textContent).toContain("[embedded content omitted: Does Not Exist]");
    expect(el.textContent).not.toContain("Click to create");
  });

  it("surfaces a distinct warning for a circular embed", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "Self", reason: "circular" }));
    const warnings = flattenEmbeds(el);
    expect(warnings).toEqual(["circular embed skipped: Self"]);
    expect(el.textContent).toContain("[embedded content omitted: Self]");
  });

  it("surfaces a distinct warning for a heading-scoped embed whose heading wasn't found", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "Note#Heading", reason: "heading-not-found" }));
    expect(flattenEmbeds(el)).toEqual(["heading not found: Note#Heading"]);
  });

  it("surfaces a distinct warning for a block-scoped embed whose block wasn't found", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "Note^blockid", reason: "block-not-found" }));
    expect(flattenEmbeds(el)).toEqual(["block not found: Note^blockid"]);
  });

  it("surfaces a distinct warning for a non-note embed (unsupported type)", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "doc.pdf", reason: "unsupported-type" }));
    expect(flattenEmbeds(el)).toEqual(["unsupported embed type (not a note): doc.pdf"]);
  });

  it("degrades a wrapper with neither rendered copy nor reason to the missing-embed placeholder", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "drawing.excalidraw" }));
    expect(flattenEmbeds(el)).toEqual(["missing embed: drawing.excalidraw"]);
    expect(el.textContent).toContain("[embedded content omitted: drawing.excalidraw]");
  });

  it("unwraps an image embed to its bare <img>, moving the wrapper's alt caption onto it", () => {
    // The wrapper span's own alt/src attributes are invalid XHTML on a span
    // (epubcheck RSC-005, observed on a real export) — only the img ships.
    const el = div(
      '<span alt="Figure 2-1: hover info" src="pic.png" class="internal-embed media-embed image-embed is-loaded"><img src="app://x/pic.png"></span>'
    );
    expect(flattenEmbeds(el)).toEqual([]);
    expect(el.querySelector(".internal-embed")).toBeNull();
    const img = el.querySelector("img");
    expect(img?.getAttribute("src")).toBe("app://x/pic.png");
    expect(img?.getAttribute("alt")).toBe("Figure 2-1: hover info");
  });

  it("keeps the img's own alt when it already has one (wrapper caption does not overwrite)", () => {
    const el = div(
      '<span alt="caption" src="pic.png" class="internal-embed image-embed"><img src="x.png" alt="original"></span>'
    );
    flattenEmbeds(el);
    expect(el.querySelector("img")?.getAttribute("alt")).toBe("original");
  });

  it("degrades an unresolved image embed (no <img> child) to the placeholder", () => {
    const el = div('<span alt="gone.png" src="gone.png" class="internal-embed image-embed"></span>');
    expect(flattenEmbeds(el)).toEqual(["missing embed: gone.png"]);
    expect(el.textContent).toContain("[embedded content omitted: gone.png]");
  });

  it("flattens a nested embed inside our own rendered copy (innermost first)", () => {
    const el = document.createElement("div");
    const outer = realEmbedWrapper({ src: "Outer", ourHtml: "<p>outer top</p>" });
    const ourDiv = outer.querySelector(`[${EMBED_RENDERED_ATTR}]`)!;
    ourDiv.appendChild(realEmbedWrapper({ src: "Inner", ourHtml: "<p>inner body</p>" }));
    el.appendChild(outer);
    const warnings = flattenEmbeds(el);
    expect(warnings).toEqual([]);
    expect(el.querySelector(".internal-embed")).toBeNull();
    expect(el.textContent).toContain("outer top");
    expect(el.textContent).toContain("inner body");
  });

  it("does not warn for (or flatten) wrappers inside Obsidian's own discarded preview copy", () => {
    // Obsidian's async preview of an embed can itself contain nested embed
    // wrappers; they vanish with the preview and must not double-count.
    const el = document.createElement("div");
    const wrapper = realEmbedWrapper({
      src: "Other Note",
      ourHtml: "<p>our copy</p>",
      obsidianPreview: '<span class="internal-embed" src="Nested Broken"></span>',
    });
    el.appendChild(wrapper);
    const warnings = flattenEmbeds(el);
    expect(warnings).toEqual([]);
    expect(el.textContent).toContain("our copy");
    expect(el.textContent).not.toContain("[embedded content omitted");
  });

  it("is idempotent: a second call finds nothing left to do", () => {
    const el = document.createElement("div");
    el.appendChild(realEmbedWrapper({ src: "Other Note", ourHtml: "<p>Body.</p>" }));
    expect(flattenEmbeds(el)).toEqual([]);
    expect(flattenEmbeds(el)).toEqual([]);
    expect(el.querySelector("p")?.textContent).toBe("Body.");
  });

  describe("fallback pass: bare title/content pair with no wrapper (renderer-variant safety net)", () => {
    it("unwraps a populated pair, dropping the bare title text", () => {
      const el = div(
        '<div class="embed-title markdown-embed-title">Other Note</div>' +
          '<div class="markdown-embed-content"><h2>Section</h2><p>Body text</p></div>'
      );
      const warnings = flattenEmbeds(el);
      expect(el.querySelector(".markdown-embed-title")).toBeNull();
      expect(el.querySelector(".markdown-embed-content")).toBeNull();
      expect(el.querySelector("h2")?.textContent).toBe("Section");
      expect(warnings).toEqual([]);
    });

    it("replaces a still-empty pair with an omission marker", () => {
      const el = div(
        '<div class="embed-title markdown-embed-title">drawing.excalidraw</div>' +
          '<div class="markdown-embed-content"></div>'
      );
      const warnings = flattenEmbeds(el);
      expect(el.textContent).toContain("[embedded content omitted: drawing.excalidraw]");
      expect(warnings).toEqual(["missing embed: drawing.excalidraw"]);
    });

    it("leaves a title with no next sibling at all alone (malformed/unexpected shape)", () => {
      const el = div('<div class="embed-title markdown-embed-title">Alone</div>');
      expect(flattenEmbeds(el)).toEqual([]);
      expect(el.querySelector(".markdown-embed-title")).not.toBeNull();
    });

    it("leaves a title alone when its next sibling isn't a markdown-embed-content div", () => {
      const el = div(
        '<div class="embed-title markdown-embed-title">Not Paired</div><p>unrelated content</p>'
      );
      expect(flattenEmbeds(el)).toEqual([]);
      expect(el.querySelector(".markdown-embed-title")).not.toBeNull();
      expect(el.querySelector("p")?.textContent).toBe("unrelated content");
    });
  });
});

describe("splitEmbedTarget / isImageEmbedSrc", () => {
  it("passes a plain note target through", () => {
    expect(splitEmbedTarget("Other Note")).toEqual({
      raw: "Other Note",
      linkpath: "Other Note",
      heading: null,
      block: null,
    });
  });

  it("splits a heading-scoped target into linkpath + heading", () => {
    expect(splitEmbedTarget("Note#Some Heading")).toEqual({
      raw: "Note#Some Heading",
      linkpath: "Note",
      heading: "Some Heading",
      block: null,
    });
  });

  it("splits a block-scoped target into linkpath + block", () => {
    expect(splitEmbedTarget("Note^abc123")).toEqual({
      raw: "Note^abc123",
      linkpath: "Note",
      heading: null,
      block: "abc123",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(splitEmbedTarget("  Note  ").linkpath).toBe("Note");
  });

  it("detects image srcs case-insensitively and rejects note names", () => {
    expect(isImageEmbedSrc("pic.PNG")).toBe(true);
    expect(isImageEmbedSrc("diagram.jpeg")).toBe(true);
    expect(isImageEmbedSrc("Other Note")).toBe(false);
    expect(isImageEmbedSrc("doc.pdf")).toBe(false);
  });
});

describe("findHeadingSection", () => {
  it("ends the section before the next heading of the same level", () => {
    const headings = [
      { heading: "Heading A", level: 2, line: 0 },
      { heading: "Heading B", level: 2, line: 4 },
    ];
    expect(findHeadingSection(headings, "Heading A", 8)).toEqual({ startLine: 0, endLine: 3 });
  });

  it("includes a deeper sub-heading before the next same-level heading ends it", () => {
    const headings = [
      { heading: "Heading A", level: 2, line: 0 },
      { heading: "Sub A", level: 3, line: 4 },
      { heading: "Heading B", level: 2, line: 8 },
    ];
    expect(findHeadingSection(headings, "Heading A", 12)).toEqual({ startLine: 0, endLine: 7 });
  });

  it("ends at the next heading of a HIGHER level even if a same-level one never follows", () => {
    const headings = [
      { heading: "Title", level: 1, line: 0 },
      { heading: "Section", level: 2, line: 2 },
      { heading: "Next Title", level: 1, line: 6 },
    ];
    expect(findHeadingSection(headings, "Section", 10)).toEqual({ startLine: 2, endLine: 5 });
  });

  it("runs to the note's last line when no following heading ends it", () => {
    const headings = [{ heading: "Only Heading", level: 2, line: 3 }];
    expect(findHeadingSection(headings, "Only Heading", 10)).toEqual({ startLine: 3, endLine: 9 });
  });

  it("uses the first match, in document order, when duplicate heading text exists", () => {
    const headings = [
      { heading: "Repeated", level: 2, line: 0 },
      { heading: "Repeated", level: 2, line: 5 },
    ];
    expect(findHeadingSection(headings, "Repeated", 10)).toEqual({ startLine: 0, endLine: 4 });
  });

  it("matches case-insensitively and ignores leading/trailing whitespace (FR-002)", () => {
    const headings = [{ heading: "  Some Heading  ", level: 2, line: 0 }];
    expect(findHeadingSection(headings, "some heading", 5)).toEqual({ startLine: 0, endLine: 4 });
  });

  it("returns null when no heading matches", () => {
    const headings = [{ heading: "Heading A", level: 2, line: 0 }];
    expect(findHeadingSection(headings, "Nonexistent", 5)).toBeNull();
  });
});

describe("findBlockRange", () => {
  const section = (id: string | undefined, type: string, startLine: number, endLine: number) => ({
    id,
    type,
    startLine,
    endLine,
  });
  const item = (id: string | undefined, parent: number, startLine: number, endLine = startLine) => ({
    id,
    parent,
    startLine,
    endLine,
  });

  it("finds a block ID attached to a paragraph", () => {
    const sections = [section("abc123", "paragraph", 2, 3)];
    expect(findBlockRange(sections, [], "abc123")).toEqual({
      startLine: 2,
      endLine: 3,
      fromListItem: false,
    });
  });

  it("finds a block ID attached to a heading (single line, not its section)", () => {
    const sections = [section("abc123", "heading", 4, 4), section(undefined, "paragraph", 5, 6)];
    expect(findBlockRange(sections, [], "abc123")).toEqual({
      startLine: 4,
      endLine: 4,
      fromListItem: false,
    });
  });

  // US1/FR-001..FR-004: this is the inversion of the previous behavior — every
  // one of these types used to return null and degrade to a placeholder.
  it.each([
    ["table", 2, 5],
    ["code", 7, 11],
    ["blockquote", 13, 15],
    ["callout", 17, 20],
    ["list", 22, 26],
    ["html", 28, 30],
  ])("resolves a block ID attached to a %s section, which previously degraded", (type, s, e) => {
    const sections = [section("abc123", type, s, e)];
    expect(findBlockRange(sections, [], "abc123")).toEqual({
      startLine: s,
      endLine: e,
      fromListItem: false,
    });
  });

  it("resolves a section type Obsidian has not documented (the type list is non-exhaustive)", () => {
    const sections = [section("abc123", "someFutureType", 1, 2)];
    expect(findBlockRange(sections, [], "abc123")).toEqual({
      startLine: 1,
      endLine: 2,
      fromListItem: false,
    });
  });

  it("returns null for a block ID that doesn't exist in the note", () => {
    const sections = [section("other", "paragraph", 0, 1)];
    expect(findBlockRange(sections, [], "abc123")).toBeNull();
  });

  it("returns null (rather than throwing) for empty inputs", () => {
    expect(findBlockRange([], [], "abc123")).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const sections = [section("abc123", "list", 0, 4)];
    const listItems = [item("deep", 0, 2)];
    const sectionsSnapshot = JSON.parse(JSON.stringify(sections));
    const listItemsSnapshot = JSON.parse(JSON.stringify(listItems));
    findBlockRange(sections, listItems, "abc123");
    findBlockRange(sections, listItems, "deep");
    expect(sections).toEqual(sectionsSnapshot);
    expect(listItems).toEqual(listItemsSnapshot);
  });

  // US2/FR-005: an ID present only in listItems.
  it("finds a block ID attached to a list item, flagged as coming from a list item", () => {
    const listItems = [item(undefined, -0, 0), item("abc123", -0, 1), item(undefined, -0, 2)];
    expect(findBlockRange([], listItems, "abc123")).toEqual({
      startLine: 1,
      endLine: 1,
      fromListItem: true,
    });
  });

  // Contract guarantee 2: sections are consulted first, so an ID on the list
  // as a whole can never be mistaken for an item inside it.
  it("prefers a matching section over a matching list item for the same ID", () => {
    const sections = [section("abc123", "list", 0, 9)];
    const listItems = [item("abc123", -0, 4)];
    expect(findBlockRange(sections, listItems, "abc123")).toEqual({
      startLine: 0,
      endLine: 9,
      fromListItem: false,
    });
  });
});

describe("listItemRange", () => {
  const item = (id: string | undefined, parent: number, startLine: number, endLine = startLine) => ({
    id,
    parent,
    startLine,
    endLine,
  });

  it("spans only itself when the item has no children", () => {
    const seed = item("x", -0, 3);
    expect(listItemRange([item(undefined, -0, 2), seed, item(undefined, -0, 4)], seed)).toEqual({
      startLine: 3,
      endLine: 3,
    });
  });

  // FR-006
  it("extends through the item's nested children", () => {
    const seed = item("x", -0, 1);
    const listItems = [item(undefined, -0, 0), seed, item(undefined, 1, 2), item(undefined, 1, 3)];
    expect(listItemRange(listItems, seed)).toEqual({ startLine: 1, endLine: 3 });
  });

  it("extends through transitive grandchildren", () => {
    const seed = item("x", -0, 1);
    const child = item(undefined, 1, 2);
    const grandchild = item(undefined, 2, 3);
    expect(listItemRange([seed, child, grandchild], seed)).toEqual({ startLine: 1, endLine: 3 });
  });

  // FR-005: a sibling's parent is the seed's PARENT, never the seed's own
  // start line, so widening must not swallow it.
  it("excludes sibling items that follow the seed", () => {
    const seed = item("x", -0, 1);
    const child = item(undefined, 1, 2);
    const sibling = item(undefined, -0, 3);
    expect(listItemRange([seed, child, sibling], seed)).toEqual({ startLine: 1, endLine: 2 });
  });

  it("uses the maximum descendant endLine, not document order", () => {
    const seed = item("x", -0, 1);
    const laterButShorter = item(undefined, 1, 5, 5);
    const earlierButLonger = item(undefined, 1, 2, 8);
    expect(listItemRange([seed, earlierButLonger, laterButShorter], seed)).toEqual({
      startLine: 1,
      endLine: 8,
    });
  });

  it("respects a multi-line item's own endLine", () => {
    const seed = item("x", -0, 1, 4);
    expect(listItemRange([seed], seed)).toEqual({ startLine: 1, endLine: 4 });
  });

  it("terminates on a self-parenting item rather than looping forever", () => {
    const seed = item("x", -0, 1);
    const selfParent = { id: undefined, parent: 2, startLine: 2, endLine: 2 };
    expect(listItemRange([seed, selfParent], seed)).toEqual({ startLine: 1, endLine: 1 });
  });

  it("terminates on a cyclic parent chain", () => {
    const seed = item("x", -0, 1);
    const a = { id: undefined, parent: 1, startLine: 2, endLine: 2 };
    const b = { id: undefined, parent: 2, startLine: 3, endLine: 3 };
    const cyclic = { id: undefined, parent: 3, startLine: 2, endLine: 9 };
    expect(listItemRange([seed, a, b, cyclic], seed).endLine).toBeGreaterThanOrEqual(3);
  });
});

describe("dedentBlock", () => {
  // FR-007: without this, a sliced nested item starts with 4+ spaces and
  // CommonMark reads it as an INDENTED CODE BLOCK — the reader gets a grey box
  // instead of a bullet.
  it("removes the first line's indentation so a nested item renders as a list item", () => {
    expect(dedentBlock("    - child item")).toBe("- child item");
  });

  // FR-006: sub-items must stay nested relative to their parent.
  it("preserves relative nesting of deeper lines", () => {
    const md = ["    - parent", "        - child", "            - grandchild"].join("\n");
    expect(dedentBlock(md)).toBe(["- parent", "    - child", "        - grandchild"].join("\n"));
  });

  it("returns input unchanged when the first line has no indentation", () => {
    const md = ["- root item", "    - child"].join("\n");
    expect(dedentBlock(md)).toBe(md);
  });

  it("leaves lines that do not start with the prefix untouched, including blanks", () => {
    const md = ["    - parent", "", "  stray", "    - sibling"].join("\n");
    expect(dedentBlock(md)).toBe(["- parent", "", "  stray", "- sibling"].join("\n"));
  });

  it("handles tab indentation the same way, since the literal prefix is removed", () => {
    expect(dedentBlock("\t- tabbed\n\t\t- deeper")).toBe("- tabbed\n\t- deeper");
  });

  it("returns an empty string unchanged", () => {
    expect(dedentBlock("")).toBe("");
  });
});

describe("stripBlockMarker", () => {
  it("removes a trailing marker and the whitespace before it", () => {
    expect(stripBlockMarker("Some paragraph text. ^abc123", "abc123")).toBe("Some paragraph text.");
  });

  it("removes a marker-only line entirely, leaving no blank artifact", () => {
    const md = ["| a | b |", "| - | - |", "^tbl"].join("\n");
    expect(stripBlockMarker(md, "tbl")).toBe(["| a | b |", "| - | - |"].join("\n"));
  });

  it("removes an indented marker-only line", () => {
    expect(stripBlockMarker("- item\n  ^myid", "myid")).toBe("- item");
  });

  // Contract guarantee 3 — the reason the strip is scoped to the resolved ID
  // rather than a generic caret pattern: silently editing a reader's code
  // would be a worse defect than the stray marker this fixes.
  it("leaves a DIFFERENT caret token untouched, e.g. a regex inside embedded code", () => {
    const md = ["```js", "const re = /^start/;", "```", "^code"].join("\n");
    expect(stripBlockMarker(md, "code")).toBe(["```js", "const re = /^start/;", "```"].join("\n"));
  });

  it("does not strip a marker belonging to a different block", () => {
    expect(stripBlockMarker("Text ^other", "abc123")).toBe("Text ^other");
  });

  it("escapes regex-special characters in the block ID rather than corrupting the pattern", () => {
    expect(stripBlockMarker("Text ^a.c", "a.c")).toBe("Text");
    // A literal "a.c" ID must not match "abc" via an unescaped dot.
    expect(stripBlockMarker("Text ^abc", "a.c")).toBe("Text ^abc");
  });

  it("returns markdown without the marker unchanged", () => {
    const md = "Just a paragraph.\n\nAnd another.";
    expect(stripBlockMarker(md, "abc123")).toBe(md);
  });

  it("does not strip a caret token that merely starts with the block ID", () => {
    expect(stripBlockMarker("Text ^abc123456", "abc123")).toBe("Text ^abc123456");
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
  // 008-mobile-support: on mobile the vault adapter is not a FileSystemAdapter,
  // so main.ts passes basePath: "". `"anything".indexOf("")` is 0, NOT -1, so
  // the `at === -1` guard below it never fired and the else-branch sliced off
  // nothing — yielding the whole app:// URL as a "vault path". That silently
  // disabled the basename fallback these very tests describe, for EVERY image
  // on EVERY mobile export.
  it("falls back to the basename when basePath is empty (mobile)", () => {
    const el = div('<img src="app://abc123/Users/pan/vault/05.%20assets/pic.png">');
    const found = rewriteImages(el, "");
    expect(found).toEqual([{ vaultPath: "pic.png", newHref: "../images/img_001.png" }]);
  });

  it("never returns an app:// URL as a vault path, whatever the basePath", () => {
    for (const base of ["", "/wrong/vault", "/Users/pan/vault"]) {
      const el = div('<img src="app://abc123/Users/pan/vault/images/pic.png">');
      const found = rewriteImages(el, base);
      expect(found[0].vaultPath).not.toContain("app://");
      expect(found[0].vaultPath.startsWith("/")).toBe(false);
    }
  });

  it("tolerates malformed image URIs with literal percent", () => {
    const base = "/Users/pan/vault";
    const el = div(`<img src="app://abc123${base}/100%off.png">`);
    const found = rewriteImages(el, base);
    // Malformed URI is skipped: src unchanged, not in found list.
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(`app://abc123${base}/100%off.png`);
  });
  it("tolerates a malformed relative (non-app://) image URI with a literal percent", () => {
    const el = div(`<img src="100%off.png">`);
    const found = rewriteImages(el, "/vault");
    // Malformed URI is skipped: src unchanged, not in found list.
    expect(found).toEqual([]);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("100%off.png");
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

describe("rasterizeMermaidDiagrams", () => {
  afterEach(() => {
    setSvgRasterizer(null); // module state discipline, same reason as setRequestUrlImpl elsewhere
  });

  it("replaces Obsidian's Mermaid vault-trust guard with its source fence and warns (no 'Allow' button ships)", async () => {
    // Exact structure captured from a real 2026-07-31 export where the vault
    // hadn't allowed Mermaid rendering yet.
    const root = div(
      '<div><div class="mermaid-wrapper is-guarded">' +
        '<div class="mermaid-guard-header"><div class="mermaid-guard-text">' +
        '<div class="mermaid-guard-title">Display Mermaid diagrams in this vault?</div>' +
        '<div class="mermaid-guard-description">Only allow if you trust this vault\'s contents.</div>' +
        '</div><div class="mermaid-guard-actions"><button>Allow</button></div></div>' +
        '<div class="mermaid-guard-source"><pre class="language-mermaid"><code class="language-mermaid is-loaded">graph LR</code></pre></div>' +
        "</div></div>"
    );
    const r = await rasterizeMermaidDiagrams(root, 0);
    expect(root.querySelector("button")).toBeNull();
    expect(root.textContent).not.toContain("Display Mermaid diagrams");
    expect(root.querySelector("pre.language-mermaid")?.textContent).toBe("graph LR");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("click Allow on the diagram, then re-export");
  });

  it("removes a guarded Mermaid wrapper outright if it's missing the expected source fence", async () => {
    // Defensive branch: every real guarded wrapper has a
    // .mermaid-guard-source pre (asserted in the fixture-based test above);
    // this covers the else-remove path for a malformed/future-Obsidian shape
    // that doesn't.
    const root = div('<div><div class="mermaid-wrapper is-guarded"><p>no source fence here</p></div></div>');
    const r = await rasterizeMermaidDiagrams(root, 0);
    expect(root.querySelector(".mermaid-wrapper")).toBeNull();
    expect(root.textContent).not.toContain("no source fence here");
    expect(r.warnings).toHaveLength(1);
  });

  it("falls back (with a warning) when the svg has no usable width/height", async () => {
    const root = div('<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>');
    const r = await rasterizeMermaidDiagrams(root, 0);
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toEqual([
      "mermaid rasterization unavailable — kept inline SVG (may not render on e-ink)",
    ]);
    expect(root.querySelector("svg")).not.toBeNull();
  });

  it("computes a reduced scale for an oversized svg instead of exceeding the canvas dimension cap", async () => {
    // 3000 * the normal 2x scale would be 6000, over the 4096 cap — exercises
    // the downscale branch. Still falls back overall: jsdom has neither
    // URL.createObjectURL nor a real canvas 2d context, so this can't reach a
    // real Electron canvas — only the scale arithmetic itself is under test.
    const root = div(
      '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000"></svg></div>'
    );
    const r = await rasterizeMermaidDiagrams(root, 0);
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
  });

  it("rounds a fractional rasterizer-reported width to an integer <img width> attribute", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: 200.6, height: 100 }));
    const root = div(
      '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="200.6" height="100"></svg></div>'
    );
    await rasterizeMermaidDiagrams(root, 0);
    const img = root.querySelector("img")!;
    expect(img.getAttribute("width")).toBe("201");
  });

  it("omits the width attribute rather than writing 'NaN' when the rasterizer reports a non-finite width", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: NaN, height: 100 }));
    const root = div(
      '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg></div>'
    );
    await rasterizeMermaidDiagrams(root, 0);
    const img = root.querySelector("img")!;
    expect(img.hasAttribute("width")).toBe(false);
  });

  it("does not double-process a wrapped svg.mermaid, and still picks up a bare (unwrapped) one", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: 10, height: 10 }));
    const root = div(
      '<div class="mermaid"><svg class="mermaid" xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg></div>' +
        '<svg class="mermaid" xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'
    );
    const r = await rasterizeMermaidDiagrams(root, 0);
    // Two hosts, not three: the wrapped svg.mermaid must be attributed to its
    // div.mermaid exactly once, not counted again via the bare-svg query.
    expect(r.images).toHaveLength(2);
  });

  it("skips a div.mermaid with no svg inside it at all", async () => {
    const root = div('<div class="mermaid">not rendered yet</div>');
    const r = await rasterizeMermaidDiagrams(root, 0);
    expect(r.images).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  describe("default (real) rasterizer, browser APIs mocked", () => {
    // render.ts's default rasterizer drives real browser APIs (Image, canvas,
    // Blob, URL.createObjectURL) that jsdom either doesn't implement at all
    // (URL.createObjectURL) or implements as a stub that always returns null
    // (canvas 2d context) — see the module comment in src/render.ts. These
    // tests stub just enough of that surface to walk the rest of the
    // function's branches deterministically; they do NOT prove the real
    // Electron/Chromium canvas pipeline draws correctly (that needs a real
    // browser — see the round-3 report's "unprovable outside Electron" note).
    const originalImage = globalThis.Image;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

    afterEach(() => {
      globalThis.Image = originalImage;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    });

    function stubObjectUrl(): void {
      URL.createObjectURL = (() => "blob:fake") as typeof URL.createObjectURL;
      URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    }

    function stubImage(outcome: "load" | "error"): void {
      class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => (outcome === "load" ? this.onload?.() : this.onerror?.()));
        }
      }
      globalThis.Image = FakeImage as unknown as typeof Image;
    }

    it("rasterizes end-to-end when Image load + canvas + toDataURL all succeed", async () => {
      stubObjectUrl();
      stubImage("load");
      HTMLCanvasElement.prototype.getContext = (() => ({
        fillStyle: "",
        fillRect() {},
        drawImage() {},
      })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.toDataURL = (() =>
        "data:image/png;base64,AAECAw==") as unknown as typeof HTMLCanvasElement.prototype.toDataURL;

      // Fractional width (774.8046875 is the real mermaid fixture's actual
      // svg width — see tests/fixtures/mermaid-real.xhtml) is deliberate:
      // XHTML's `width` attribute must be an integer (epubcheck RSC-005), so
      // this fixture is discriminating against a regression that writes the
      // raw fractional value straight through instead of rounding it.
      const root = div(
        '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="774.8046875" height="80"><rect width="10" height="10"/></svg></div>'
      );
      const r = await rasterizeMermaidDiagrams(root, 2);
      expect(r.warnings).toHaveLength(0);
      expect(r.images).toEqual([
        { newHref: "../images/img_003.png", bytes: new Uint8Array([0, 1, 2, 3]), mediaType: "image/png" },
      ]);
      expect(root.querySelector("div.mermaid")).toBeNull();
      const img = root.querySelector("p > img")!;
      expect(img.getAttribute("src")).toBe("../images/img_003.png");
      expect(img.getAttribute("alt")).toBe("diagram");
      expect(img.getAttribute("width")).toMatch(/^\d+$/);
      expect(img.getAttribute("width")).toBe("775");
    });

    it("falls back when the Image element fails to load", async () => {
      stubObjectUrl();
      stubImage("error");
      const root = div(
        '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg></div>'
      );
      const r = await rasterizeMermaidDiagrams(root, 0);
      expect(r.images).toHaveLength(0);
      expect(r.warnings).toHaveLength(1);
      expect(root.querySelector("svg")).not.toBeNull();
    });

    // Expect "Not implemented: HTMLCanvasElement.prototype.getContext" plus a
    // stack on stderr while this passes: jsdom reports a missing canvas through
    // its virtual console instead of throwing, and vitest forwards that. It is
    // not a failure, and silencing it would mean mocking away the exact
    // behavior under test.
    it("falls back when the canvas has no 2d context (real jsdom behavior, left un-mocked here)", async () => {
      stubObjectUrl();
      stubImage("load");
      // getContext deliberately left as jsdom's real implementation, which
      // returns null (no "canvas" npm package installed).
      const root = div(
        '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg></div>'
      );
      const r = await rasterizeMermaidDiagrams(root, 0);
      expect(r.images).toHaveLength(0);
      expect(r.warnings).toHaveLength(1);
    });

    it("falls back when toDataURL returns a string with no comma (malformed data URL guard)", async () => {
      stubObjectUrl();
      stubImage("load");
      HTMLCanvasElement.prototype.getContext = (() => ({
        fillStyle: "",
        fillRect() {},
        drawImage() {},
      })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.toDataURL = (() =>
        "not-a-data-url") as unknown as typeof HTMLCanvasElement.prototype.toDataURL;

      const root = div(
        '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg></div>'
      );
      const r = await rasterizeMermaidDiagrams(root, 0);
      expect(r.images).toHaveLength(0);
      expect(r.warnings).toHaveLength(1);
    });
  });
});

describe("collectHeadingToc", () => {
  const HEADED = "<h1>Title</h1><h2>Part A</h2><h3>Detail</h3><h2>Part B</h2>";

  it("collects h2/h3 in document order, skipping a leading h1 (the chapter title)", () => {
    const root = div(HEADED);
    const toc = collectHeadingToc(root, 3);
    expect(toc).toEqual([
      { level: 2, text: "Part A", id: "part-a" },
      { level: 3, text: "Detail", id: "detail" },
      { level: 2, text: "Part B", id: "part-b" },
    ]);
  });

  it("stamps the id onto each eligible heading element (anchors nav links into the body)", () => {
    const root = div(HEADED);
    collectHeadingToc(root, 3);
    expect(root.querySelector("h1")!.hasAttribute("id")).toBe(false);
    const h2s = root.querySelectorAll("h2");
    expect(h2s[0].id).toBe("part-a");
    expect(h2s[1].id).toBe("part-b");
    expect(root.querySelector("h3")!.id).toBe("detail");
  });

  it("excludes levels above maxDepth and does not stamp them", () => {
    const root = div(HEADED);
    const toc = collectHeadingToc(root, 2);
    expect(toc).toEqual([
      { level: 2, text: "Part A", id: "part-a" },
      { level: 2, text: "Part B", id: "part-b" },
    ]);
    expect(root.querySelector("h3")!.hasAttribute("id")).toBe(false);
  });

  it("collects normally when the first heading is not an h1", () => {
    const root = div("<h2>A</h2><h3>B</h3>");
    const toc = collectHeadingToc(root, 3);
    expect(toc).toEqual([
      { level: 2, text: "A", id: "a" },
      { level: 3, text: "B", id: "b" },
    ]);
  });

  it("skips empty or whitespace-only heading text", () => {
    const root = div("<h2></h2><h2>   </h2><h2>Real</h2>");
    const toc = collectHeadingToc(root, 3);
    expect(toc).toEqual([{ level: 2, text: "Real", id: "real" }]);
  });

  it("maxDepth 0 collects nothing and stamps nothing (depth-0 identity)", () => {
    const root = div(HEADED);
    const toc = collectHeadingToc(root, 0);
    expect(toc).toEqual([]);
    root.querySelectorAll("h1,h2,h3").forEach((h) => expect(h.hasAttribute("id")).toBe(false));
  });
});

describe("collectHeadingToc validity hardening (004-heading-toc US4)", () => {
  it("dedupes duplicate heading text with -2, -3 suffixes in document order", () => {
    const root = div("<h2>Usage</h2><p>x</p><h2>Usage</h2><p>y</p><h2>Usage</h2>");
    const toc = collectHeadingToc(root, 3);
    expect(toc.map((t) => t.id)).toEqual(["usage", "usage-2", "usage-3"]);
    expect(toc.map((t) => t.text)).toEqual(["Usage", "Usage", "Usage"]);
  });

  it("prefixes h- when the sanitized id would start with an illegal character", () => {
    const root = div("<h2>123 ABC</h2><h2>-dash</h2>");
    const toc = collectHeadingToc(root, 3);
    expect(toc.map((t) => t.id)).toEqual(["h-123-abc", "dash"]);
  });

  it("keeps Unicode (Thai) heading text as a valid id", () => {
    const root = div("<h2>บทที่ 1</h2><h2>สรุป</h2>");
    const toc = collectHeadingToc(root, 3);
    expect(toc.map((t) => t.id)).toEqual(["บทที่-1", "สรุป"]);
    // Stamped ids round-trip through serialization.
    expect(serializeBody(root)).toContain('id="บทที่-1"');
  });

  it("strips ASCII punctuation from ids but keeps the display text intact", () => {
    const root = div('<h2>What? "Really" &amp; Such!</h2>');
    const toc = collectHeadingToc(root, 3);
    expect(toc[0].id).toBe("what-really-such");
    expect(toc[0].text).toBe('What? "Really" & Such!');
  });
});
