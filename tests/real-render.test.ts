// Runs the PURE render pipeline over markup captured from Obsidian's REAL
// MarkdownRenderer (tests/fixtures/real-render/*.json, produced by
// scripts/capture-real-render.ts). The stand-in renderer the other suites use
// is `marked` plus post-processing, so this is the only automated proof that
// cleanupDom, rewriteLinks, rewriteImages, renderMath and flattenEmbeds still
// fit what Obsidian actually emits. Item 3 of the 2026-09-29 review: these
// cases were on docs/DEVELOPMENT.md's "verified by hand" list.
//
// When Obsidian changes its reading-view markup, re-run the capture script,
// commit the fixture diff, and let this file say what broke.
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHROME_SELECTORS,
  cleanupDom,
  rewriteLinks,
  rewriteImages,
  rasterizeMermaidDiagrams,
  collectHeadingToc,
  serializeBody,
  setSvgRasterizer,
} from "../src/core/render";
import { renderMath, protectMath } from "../src/core/math";
import { stripDynamicBlocks, stripFrontmatter } from "../src/core/render";
import { processFootnotes } from "../src/core/footnotes";

interface RealRenderFixture {
  name: string;
  covers: string;
  obsidianVersion: string;
  basePath: string;
  /** The snippet as written, frontmatter and `$` math included. */
  sourceMarkdown: string;
  /** What the renderer was actually given: the source after strip + protectMath. */
  renderedMarkdown: string;
  html: string;
}

const FIXTURE_DIR = join(__dirname, "fixtures", "real-render");

function loadFixture(name: string): RealRenderFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as RealRenderFixture;
}

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/**
 * The same pure passes renderUnitToChapter runs after MarkdownRenderer, in
 * the same order (see src/adapters/render-adapter.ts), minus populateEmbeds, which
 * needs a live vault. Returns everything the adapter would hand to main.ts.
 */
async function runPurePipeline(fixture: RealRenderFixture) {
  // Recomputes the math spans the same way the adapter does, so the fixture
  // only has to record markup — and proves protectMath is deterministic.
  const protectedMd = protectMath(stripDynamicBlocks(stripFrontmatter(fixture.sourceMarkdown)));
  expect(protectedMd.md).toBe(fixture.renderedMarkdown);
  const spans = protectedMd.spans;
  const el = mount(fixture.html);
  const warnings: string[] = [];
  warnings.push(...cleanupDom(el));
  rewriteLinks(el, new Map(), () => null);
  const images = rewriteImages(el, fixture.basePath, 0, (w) => warnings.push(w));
  const mermaid = await rasterizeMermaidDiagrams(el, images.length);
  warnings.push(...mermaid.warnings);
  const math = await renderMath(el, spans, images.length + mermaid.images.length, "note.md");
  warnings.push(...math.warnings);
  warnings.push(...processFootnotes(el));
  const toc = collectHeadingToc(el, 3);
  return { el, warnings, images, math, toc, xhtml: serializeBody(el) };
}

/** A chapter body must be well-formed XML or epubcheck rejects the book. */
function expectWellFormedXhtml(xhtml: string): void {
  const doc = new DOMParser().parseFromString(
    `<body xmlns="http://www.w3.org/1999/xhtml">${xhtml}</body>`,
    "application/xml"
  );
  expect(doc.querySelector("parsererror")?.textContent ?? "").toBe("");
}

describe("real Obsidian markup: every captured fixture", () => {
  afterEach(() => setSvgRasterizer(null));

  it("was captured from a known Obsidian version, not a guess", () => {
    const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const n of names) {
      const f = loadFixture(n.replace(/\.json$/, ""));
      expect(f.obsidianVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(f.html.length).toBeGreaterThan(0);
    }
  });

  it("comes out of the pure pipeline as well-formed XHTML with no UI chrome left", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: 10, height: 10 }));
    for (const n of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
      const fixture = loadFixture(n.replace(/\.json$/, ""));
      const { el, xhtml } = await runPurePipeline(fixture);
      expectWellFormedXhtml(xhtml);
      for (const sel of CHROME_SELECTORS) expect(el.querySelector(sel), `${n}: ${sel}`).toBeNull();
      expect(el.querySelector("input, button"), `${n}: form control`).toBeNull();
    }
  });
});

describe("real Obsidian markup: chrome", () => {
  it("really does contain the chrome CHROME_SELECTORS exists to strip", () => {
    // If this fails after a re-capture, Obsidian stopped emitting the chrome —
    // the selector list may be dead weight, or the capture went wrong. Only
    // the code-block copy button can be proven this way: the frontmatter
    // selectors never fire in production because stripFrontmatter runs on
    // the markdown first, and the collapse/pusher/metadata ones come from
    // the full reading VIEW, not from MarkdownRenderer.
    const raw = mount(loadFixture("chrome").html);
    expect(raw.querySelector(".copy-code-button")).not.toBeNull();
    expect(raw.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("keeps the content and turns task checkboxes into glyphs", async () => {
    const { el, toc } = await runPurePipeline(loadFixture("chrome"));
    expect(el.textContent).not.toContain("Frontmatter block");
    expect(el.textContent).toContain("Intro paragraph.");
    expect(el.textContent).toContain("const x = 1;");
    expect(el.textContent).toContain("Callout body.");
    expect(el.textContent).toContain("☐ open task");
    expect(el.textContent).toContain("☑ done task");
    // A leading H1 is the chapter's own title, which collectHeadingToc skips.
    expect(toc.map((t) => t.text)).toEqual(["Heading two"]);
  });
});

describe("real Obsidian markup: an inline base block", () => {
  it("really does put the Bases toolbar into a detached render", () => {
    // If this fails after a re-capture, Obsidian stopped emitting the toolbar
    // (or renamed the wrapper class) and omitBasesBlocks may be dead code.
    const raw = mount(loadFixture("base-block").html);
    expect(raw.querySelector(".block-language-base")).not.toBeNull();
    expect(raw.querySelector(".block-language-base input")).not.toBeNull();
    expect(raw.querySelector(".block-language-base svg")).not.toBeNull();
  });

  it("becomes one omission marker and one warning, with none of the toolbar left in the book", async () => {
    const { el, warnings, xhtml } = await runPurePipeline(loadFixture("base-block"));
    expect(el.textContent).toContain("Before.");
    expect(el.textContent).toContain("After.");
    expect(el.textContent).toContain("[Bases view omitted: inline base block]");
    expect(el.textContent).not.toMatch(/Sort|Filter|Properties|Search|results/);
    expect(xhtml).not.toMatch(/bases-|<input|<svg/);
    expect(warnings).toEqual([
      "bases view omitted (interactive Bases have no EPUB equivalent): inline base block",
    ]);
  });
});

describe("real Obsidian markup: tags", () => {
  it("renders #tags as a.tag without data-href, which rewriteLinks would otherwise miss", () => {
    const raw = mount(loadFixture("tags").html);
    const tags = Array.from(raw.querySelectorAll("a.tag"));
    expect(tags.map((a) => a.textContent)).toEqual(["#alpha", "#alpha/nested", "#แท็ก"]);
    for (const a of tags) expect(a.getAttribute("data-href")).toBeNull();
  });

  it("Latin, nested and Thai tags all become plain text with no link left", async () => {
    const { el } = await runPurePipeline(loadFixture("tags"));
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("Tagged #alpha and #alpha/nested and Thai #แท็ก here.");
  });
});

describe("real Obsidian markup: math placeholders", () => {
  afterEach(() => setSvgRasterizer(null));

  it("survive the real renderer with their indices intact, inline and display", () => {
    const raw = mount(loadFixture("math-placeholders").html);
    const spans = Array.from(raw.querySelectorAll("[data-inkbound-math]"));
    expect(spans.map((s) => s.getAttribute("data-inkbound-math"))).toEqual(["0", "1"]);
  });

  it("both expressions rasterize into numbered images, the display one in its own block", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1]), width: 10, height: 10 }));
    const { el, math, warnings } = await runPurePipeline(loadFixture("math-placeholders"));
    expect(warnings).toEqual([]);
    expect(math.images.map((i) => i.newHref)).toEqual(["../images/img_001.png", "../images/img_002.png"]);
    expect(el.querySelector("p.math-block img")?.getAttribute("src")).toBe("../images/img_002.png");
    expect(el.querySelector("[data-inkbound-math]")).toBeNull();
  });
});

describe("real Obsidian markup: app:// images", () => {
  it("serves a vault image through an app:// URL that carries the vault's absolute path", () => {
    const raw = mount(loadFixture("app-image").html);
    const srcs = Array.from(raw.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "");
    expect(srcs).toHaveLength(2);
    for (const src of srcs) expect(src).toMatch(/^app:\/\/[0-9a-f]+\/VAULT\//);
  });

  it("both the wikilink embed and the markdown image resolve to the same vault path and get numbered", async () => {
    const fixture = loadFixture("app-image");
    const pngPath = /!\[\[([^\]]+)\]\]/.exec(fixture.renderedMarkdown)?.[1];
    expect(pngPath).toBeTruthy();
    const { el, images, warnings } = await runPurePipeline(fixture);
    expect(warnings).toEqual([]);
    expect(images).toEqual([
      { vaultPath: pngPath, newHref: "../images/img_001.png" },
      { vaultPath: pngPath, newHref: "../images/img_002.png" },
    ]);
    // The image-embed wrapper span (invalid alt/src attributes on a span in
    // XHTML) is gone; the bare <img> remains.
    expect(el.querySelector(".internal-embed")).toBeNull();
    expect(Array.from(el.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual([
      "../images/img_001.png",
      "../images/img_002.png",
    ]);
  });
});

describe("real Obsidian markup: unresolved links and embeds", () => {
  it("an unresolved wikilink is a.internal-link with data-href, and an unresolved embed carries Obsidian's 'Click to create' text", () => {
    const raw = mount(loadFixture("links-and-embeds").html);
    expect(raw.querySelector("a.internal-link")?.getAttribute("data-href")).toBe("No Such Note Zzz");
    const embed = raw.querySelector(".internal-embed");
    expect(embed?.getAttribute("src")).toBe("No Such Embed Zzz");
    expect(embed?.textContent).toContain("Click to create");
  });

  it("the link becomes plain text and the embed becomes the omission placeholder with one warning", async () => {
    const { el, warnings } = await runPurePipeline(loadFixture("links-and-embeds"));
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("See No Such Note Zzz and:");
    expect(el.textContent).toContain("[embedded content omitted: No Such Embed Zzz]");
    expect(el.textContent).not.toContain("Click to create");
    expect(warnings).toEqual(["missing embed: No Such Embed Zzz"]);
  });
});
