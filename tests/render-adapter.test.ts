import { describe, it, expect } from "vitest";
import { Component, TFile } from "./fixtures/obsidian-stub";
import { renderUnitToChapter } from "../src/render-adapter";

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

// The stub's Component (tests/fixtures/obsidian-stub.ts) has a private
// `children` field, which under tsc's real "obsidian" package types (no
// vitest alias there) makes it nominally incompatible with the `Component`
// type render-adapter.ts imports from "obsidian" — a plain `newComponent()`
// fails `tsc --noEmit` even though it's fine at runtime under vitest's
// alias. Cast through `never` at the single construction site instead of
// peppering every call with an inline cast.
function newComponent(): never {
  return new Component() as never;
}

describe("renderUnitToChapter", () => {
  it("strips frontmatter and dataview, returning a bare XHTML fragment", async () => {
    const r = await renderUnitToChapter(
      appWith(null), newComponent(),
      "---\ntags: [x]\n---\n# Hi\n\n```dataview\nLIST\n```\n",
      "note.md", new Map(), "/vault", 0
    );
    expect(r.xhtmlBody).toContain("Hi");
    expect(r.xhtmlBody).not.toContain("tags:");
    expect(r.xhtmlBody).toContain("dynamic content omitted");
    expect(r.xhtmlBody).not.toContain("xmlns");
  });

  it("threads startImageIndex into image numbering", async () => {
    const r = await renderUnitToChapter(
      appWith(null), newComponent(),
      "![cap](fig.png)", "note.md", new Map(), "/vault", 4
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
      appWith(dest), newComponent(),
      "[[Chapter Two]]", "note.md", hrefByPath, "/vault", 0
    );
    expect(r.xhtmlBody).toContain('href="chapter_002.xhtml"');
    expect(r.xhtmlBody).not.toContain("data-href");
  });

  it("degrades a wikilink resolving outside the export set to plain text", async () => {
    const dest = new TFile("/vault", "book/99_other.md");
    const r = await renderUnitToChapter(
      appWith(dest), newComponent(),
      "[[Elsewhere]]", "note.md", new Map(), "/vault", 0
    );
    expect(r.xhtmlBody).not.toContain("<a ");
    expect(r.xhtmlBody).toContain("Elsewhere");
  });

  it("degrades a wikilink to plain text when getFirstLinkpathDest finds nothing", async () => {
    // Exercises the `f instanceof TFile ? ... : null` false branch in the
    // resolve() closure directly (as opposed to the previous case, which
    // hits a real TFile that just isn't in hrefByPath).
    const r = await renderUnitToChapter(
      appWith(null), newComponent(),
      "[[Nowhere]]", "note.md", new Map(), "/vault", 0
    );
    expect(r.xhtmlBody).not.toContain("<a ");
    expect(r.xhtmlBody).toContain("Nowhere");
  });
});
