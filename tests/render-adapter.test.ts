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
    vault: {
      adapter: { getBasePath: () => "/vault" },
      cachedRead: () => Promise.resolve(""),
    },
  } as never;
}

// Builds an app whose vault.cachedRead resolves note content from a plain
// path -> raw-markdown map, so a test can register what a target note
// "contains" as real markdown (not pre-rendered HTML) and let the real,
// unmodified MarkdownRenderer.render()/populateEmbeds recursion produce its
// content — exercising the same code path a real vault export does, rather
// than a second, parallel simulation.
function appWithNotes(
  notes: Record<string, string>,
  resolve: (linkpath: string, sourcePath: string) => TFile | null
) {
  return {
    metadataCache: { getFirstLinkpathDest: resolve },
    vault: {
      adapter: { getBasePath: () => "/vault" },
      cachedRead: (file: TFile) => Promise.resolve(notes[file.path] ?? ""),
    },
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
    // Fractional width (a real mermaid svg's width, e.g. "774.8046875") is
    // deliberate: XHTML's `width` attribute must be an integer (epubcheck
    // RSC-005), so this is discriminating against a regression that writes
    // the raw fractional value straight through.
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), width: 200.6, height: 100 }));
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
    const widthMatch = /width="(\d+)"/.exec(r.xhtmlBody);
    expect(widthMatch?.[1]).toMatch(/^\d+$/);
    expect(widthMatch?.[1]).toBe("201");
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

  it("still flattens correctly when an embed sits alongside a mermaid diagram in the same chapter", async () => {
    // Composition regression for the exact shape of the real vault export
    // that surfaced the original bug: one resolved embed plus one mermaid
    // diagram in the same chapter, exercising populateEmbeds -> cleanupDom's
    // flattenEmbeds -> rasterizeMermaidDiagrams ordering end-to-end.
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes({ "Other Note.md": "## Other Note\n\nIts own content." }, () => dest);
    setSvgRasterizer(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), width: 200, height: 100 }));
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note]]\n\n```mermaid\ngraph TD; A-->B;\n```\n",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Its own content.");
    expect(r.xhtmlBody).not.toContain("markdown-embed");
    expect(r.xhtmlBody).not.toContain("embedded content omitted");
    expect(r.xhtmlBody).toContain('src="../images/img_001.png"');
  });

  it("renders a note embed's real content by reading and rendering the target note itself, not a placeholder", async () => {
    // Proves the P1 bug fix end-to-end against the CONFIRMED real DOM shape
    // (a `.internal-embed` wrapper whose `src` names the target, which
    // Obsidian's own loader may or may not populate in time — see render.ts's
    // "Note-embed hardening" comment): registers the embedded note's RAW
    // MARKDOWN (not pre-rendered HTML) and lets the real populateEmbeds ->
    // MarkdownRenderer.render recursion do the work.
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes({ "Other Note.md": "## Other Note\n\nIts own content." }, () => dest);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Its own content.");
    expect(r.xhtmlBody).not.toContain("embedded content omitted");
    // Race immunity: the stub deterministically fills the content div with
    // Obsidian's own preview copy — exactly one copy of the content (ours)
    // may survive, and none of Obsidian's preview chrome.
    expect(r.xhtmlBody.match(/Its own content\./g)).toHaveLength(1);
    expect(r.xhtmlBody).not.toContain("markdown-preview-view");
    expect(r.warnings).toHaveLength(0);
  });

  it("degrades an embed of a non-markdown file (e.g. a PDF) instead of dumping its bytes", async () => {
    const r = await renderUnitToChapter(
      appWith(new TFile("/vault", "doc.pdf")),
      newComponent(),
      "![[doc]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: doc]");
    expect(r.warnings).toEqual(["unsupported embed type (not a note): doc (referenced by note.md)"]);
  });

  it("does not leak Obsidian's 'Click to create.' text for an unresolved embed", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![[Ghost Note]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Ghost Note]");
    expect(r.xhtmlBody).not.toContain("Click to create");
  });

  it("degrades a heading-scoped embed to the placeholder with a distinct warning (unsupported scope)", async () => {
    // Heading/block-scoped embeds are a deliberate scope cut (spec.md
    // Assumptions): populating just a SECTION of a note would require this
    // plugin to parse and extract it itself, which is out of scope here.
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes({ "Other Note.md": "## Some Heading\n\nJust this part." }, () => dest);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note#Some Heading]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Other Note#Some Heading]");
    expect(r.warnings).toEqual([
      "unsupported embed scope (heading/block): Other Note#Some Heading (referenced by note.md)",
    ]);
  });

  it("FR-006: a link inside embedded content resolves relative to the embedded note, not the host", async () => {
    // A probe during implementation showed this was NOT true before the
    // embed-scoped resolution existed: every link under the chapter root
    // resolved against the host's sourcePath, regardless of which note (if
    // any) it actually came from.
    const destEmbedded = new TFile("/vault", "folder-b/Embedded Note.md");
    const destSibling = new TFile("/vault", "folder-b/Sibling.md");
    const resolutionCalls: string[] = [];
    const app = appWithNotes({ "folder-b/Embedded Note.md": "[[Sibling]]" }, (linkpath, sourcePath) => {
      resolutionCalls.push(`${linkpath}@${sourcePath}`);
      if (linkpath === "Embedded Note") return destEmbedded;
      if (linkpath === "Sibling") return destSibling;
      return null;
    });
    const hrefByPath = new Map([["folder-b/Sibling.md", "text/chapter_005.xhtml"]]);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Embedded Note]]",
      "folder-a/Host.md",
      hrefByPath,
      "/vault",
      0
    );
    expect(resolutionCalls).toContain("Sibling@folder-b/Embedded Note.md");
    expect(resolutionCalls).not.toContain("Sibling@folder-a/Host.md");
    expect(r.xhtmlBody).toContain('href="chapter_005.xhtml"');
  });

  it("FR-006: an unresolvable link inside embedded content degrades to plain text, scoped to the embedded note", async () => {
    const destEmbedded = new TFile("/vault", "folder-b/Embedded Note.md");
    const app = appWithNotes({ "folder-b/Embedded Note.md": "[[Nowhere]]" }, (linkpath) =>
      linkpath === "Embedded Note" ? destEmbedded : null
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Embedded Note]]",
      "folder-a/Host.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).not.toContain("<a ");
    expect(r.xhtmlBody).toContain("Nowhere");
  });

  it("FR-006: a relative image inside embedded content resolves relative to the embedded note, not the host", async () => {
    const destEmbedded = new TFile("/vault", "folder-b/Embedded Note.md");
    const app = appWithNotes({ "folder-b/Embedded Note.md": "![fig](assets/fig.png)" }, (linkpath) =>
      linkpath === "Embedded Note" ? destEmbedded : null
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Embedded Note]]",
      "folder-a/Host.md",
      new Map(),
      "/vault",
      0
    );
    // render-adapter.ts itself can't resolve a relative image path (that's
    // main.ts's job) — it can only tag the image with the CONTEXT main.ts
    // must use. Confirms the image is tagged with the embed's own resolved
    // path, not left to default to the host chapter's path.
    expect(r.images).toEqual([
      {
        vaultPath: "assets/fig.png",
        newHref: "../images/img_001.png",
        sourcePath: "folder-b/Embedded Note.md",
      },
    ]);
  });

  it("resolves two independent embeds in the same chapter to their own content, without interference", async () => {
    const destA = new TFile("/vault", "A.md");
    const destB = new TFile("/vault", "B.md");
    const app = appWithNotes({ "A.md": "Content A", "B.md": "Content B" }, (linkpath) =>
      linkpath === "A" ? destA : linkpath === "B" ? destB : null
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[A]]\n\n![[B]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Content A");
    expect(r.xhtmlBody).toContain("Content B");
    expect(r.warnings).toHaveLength(0);
  });

  it("degrades a nonexistent note embed to a placeholder and records a warning", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![[Does Not Exist]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Does Not Exist]");
    expect(r.warnings).toEqual(["missing embed: Does Not Exist (referenced by note.md)"]);
  });

  it("does not hang on a circular embed pair (A embeds B, B embeds A), and surfaces a circular-embed warning", async () => {
    const destA = new TFile("/vault", "A.md");
    const destB = new TFile("/vault", "B.md");
    const app = appWithNotes({ "A.md": "Inside A\n\n![[B]]", "B.md": "Inside B\n\n![[A]]" }, (linkpath) =>
      linkpath === "A" ? destA : linkpath === "B" ? destB : null
    );
    // "note.md" embeds B, B's own content embeds A back, and A's own content
    // embeds B again — a genuine cycle. populateEmbeds' per-chain `visited`
    // set must cut this off (one level unrolls, then the repeated B is
    // skipped as circular) rather than recurse forever.
    const r = await renderUnitToChapter(app, newComponent(), "![[B]]", "note.md", new Map(), "/vault", 0);
    expect(r.xhtmlBody).toContain("Inside B");
    expect(r.xhtmlBody).toContain("Inside A");
    expect(r.warnings).toEqual(["circular embed skipped: B (referenced by note.md)"]);
  });

  it("resolves a deeply nested chain of embeds (3+ levels) without hanging", async () => {
    const destL1 = new TFile("/vault", "L1.md");
    const destL2 = new TFile("/vault", "L2.md");
    const destL3 = new TFile("/vault", "L3.md");
    const app = appWithNotes(
      { "L1.md": "Level 1\n\n![[L2]]", "L2.md": "Level 2\n\n![[L3]]", "L3.md": "Level 3" },
      (linkpath) =>
        linkpath === "L1" ? destL1 : linkpath === "L2" ? destL2 : linkpath === "L3" ? destL3 : null
    );
    const r = await renderUnitToChapter(app, newComponent(), "![[L1]]", "note.md", new Map(), "/vault", 0);
    expect(r.xhtmlBody).toContain("Level 1");
    expect(r.xhtmlBody).toContain("Level 2");
    expect(r.xhtmlBody).toContain("Level 3");
  });
});
