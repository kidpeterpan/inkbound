import { describe, it, expect, afterEach } from "vitest";
import { Component, TFile } from "./fixtures/obsidian-stub";
import { renderUnitToChapter, setSvgRasterizer } from "../src/render-adapter";

// Deviation from the brief's illustrative `appWith`: the real
// MarkdownRenderer.render() (see tests/fixtures/obsidian-stub.ts) reads
// `app.vault.adapter.getBasePath()` unconditionally on every call, before it
// even looks at metadataCache. An app object with only `metadataCache` (as
// the brief sketches it) throws immediately on every non-null-app case, so
// `vault.adapter.getBasePath` must be present here for cases 1 and 2 to
// reach their actual render path at all.
function appWith(dest: TFile | null) {
  return {
    metadataCache: { getFirstLinkpathDest: () => dest },
    vault: { adapter: { getBasePath: () => "/vault" } },
  } as never;
}

// The stub's Component (tests/fixtures/obsidian-stub.ts) declares a
// `children` field that the real "obsidian" package's `Component` (its
// .d.ts, which is what tsc sees here — there's no vitest alias for plain
// tsc) does not have. It is NOT the field's `private` visibility that
// causes the incompatibility (removing `private` doesn't fix it): the real
// cause is that `children` is an extra property at all, combined with the
// self-referential generic bounds on `addChild<T extends Component>` /
// `removeChild<T extends Component>` in obsidian's real .d.ts, which make
// the assignability check between the two `Component` types bidirectional
// regardless of visibility. A plain `new Component()` passed where
// render-adapter.ts expects "obsidian"'s `Component` fails `tsc --noEmit`
// even though it's fine at runtime under vitest's alias (both sides are the
// stub there). Cast through `never` at the single construction site instead
// of peppering every call with an inline cast.
function newComponent(): never {
  return new Component() as never;
}

describe("renderUnitToChapter", () => {
  afterEach(() => {
    // Module state discipline — same reason as setRequestUrlImpl in
    // tests/fixtures/obsidian-stub.ts: a fake left installed would leak into
    // an unrelated later test.
    setSvgRasterizer(null);
  });

  it("strips frontmatter and dataview, returning a bare XHTML fragment", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "---\ntags: [x]\n---\n# Hi\n\n```dataview\nLIST\n```\n",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Hi");
    expect(r.xhtmlBody).not.toContain("tags:");
    expect(r.xhtmlBody).toContain("dynamic content omitted");
    expect(r.xhtmlBody).not.toContain("xmlns");
  });

  it("threads startImageIndex into image numbering", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![cap](fig.png)",
      "note.md",
      new Map(),
      "/vault",
      4
    );
    expect(r.images).toEqual([{ vaultPath: "fig.png", newHref: "../images/img_005.png" }]);
    expect(r.xhtmlBody).toContain("../images/img_005.png");
  });

  it("removes its scratch element even when rendering throws", async () => {
    const before = document.body.childElementCount;
    // A null app: MarkdownRenderer.render's very first line reads
    // `app.vault.adapter.getBasePath()`, which throws on a null app before
    // any resolve/link logic runs — that's enough to exercise the `finally`
    // cleanup path without needing a more elaborate failure rig. (The
    // brief's throwing case turned out viable as-is; no fallback needed.)
    await expect(
      renderUnitToChapter(null as never, newComponent(), "[[x]]", "n.md", new Map(), "/v", 0)
    ).rejects.toBeTruthy();
    expect(document.body.childElementCount).toBe(before);
  });

  it("resolves a wikilink inside the export set to its chapter href", async () => {
    const dest = new TFile("/vault", "book/02_two.md");
    const hrefByPath = new Map([["book/02_two.md", "text/chapter_002.xhtml"]]);
    const r = await renderUnitToChapter(
      appWith(dest),
      newComponent(),
      "[[Chapter Two]]",
      "note.md",
      hrefByPath,
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain('href="chapter_002.xhtml"');
    expect(r.xhtmlBody).not.toContain("data-href");
  });

  it("degrades a wikilink resolving outside the export set to plain text", async () => {
    const dest = new TFile("/vault", "book/99_other.md");
    const r = await renderUnitToChapter(
      appWith(dest),
      newComponent(),
      "[[Elsewhere]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).not.toContain("<a ");
    expect(r.xhtmlBody).toContain("Elsewhere");
  });

  it("degrades a wikilink to plain text when getFirstLinkpathDest finds nothing", async () => {
    // Exercises the `f instanceof TFile ? ... : null` false branch in the
    // resolve() closure directly (as opposed to the previous case, which
    // hits a real TFile that just isn't in hrefByPath).
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "[[Nowhere]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).not.toContain("<a ");
    expect(r.xhtmlBody).toContain("Nowhere");
  });

  it("rasterizes a mermaid diagram to a PNG <img>, composing numbering with a regular image in the same doc", async () => {
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), width: 200, height: 100 }));
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![cap](pic.png)\n\n```mermaid\ngraph TD; A-->B;\n```\n",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).not.toContain("<svg");
    expect(r.xhtmlBody).toContain('src="../images/img_002.png"');
    expect(r.xhtmlBody).toContain('alt="diagram"');
    expect(r.xhtmlBody).toContain('width="200"');
    expect(r.xhtmlBody).toMatch(/<p><img[^>]*\/><\/p>/);
    expect(r.images).toEqual([
      { vaultPath: "pic.png", newHref: "../images/img_001.png" },
      { newHref: "../images/img_002.png", bytes: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" },
    ]);
    expect(r.warnings).toHaveLength(0);
  });

  it("keeps the inline SVG fallback and emits exactly one warning when the rasterizer returns null, even with two mermaid diagrams", async () => {
    setSvgRasterizer(async () => null);
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "```mermaid\ngraph TD; A-->B;\n```\n\n```mermaid\ngraph TD; C-->D;\n```\n",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect((r.xhtmlBody.match(/<svg/g) ?? []).length).toBe(2);
    expect(r.images).toHaveLength(0);
    expect(r.warnings.filter((w) => w.includes("mermaid rasterization unavailable"))).toHaveLength(1);
  });
});
