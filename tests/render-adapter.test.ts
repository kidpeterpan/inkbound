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
    metadataCache: { getFirstLinkpathDest: () => dest, getFileCache: () => null },
    vault: {
      adapter: { getBasePath: () => "/vault" },
      cachedRead: () => Promise.resolve(""),
    },
  } as never;
}

// Derives a real-Obsidian-shaped CachedMetadata (`headings`/`sections`, each
// with a `position.start.line`/`position.end.line` — matching
// node_modules/obsidian/obsidian.d.ts's HeadingCache/SectionCache, which is
// what render-adapter.ts's toHeadingInfo/toSectionInfo actually consume)
// computed directly from a test's own registered markdown, so a heading/
// block-scoped embed test's expectations stay in sync with the fixture text
// by construction, never a hand-maintained, separately-drifting line-number
// map.
//
// specs/002-extend-block-embeds widened this from "paragraphs, headings and
// one throwaway list line" to the block shapes Obsidian actually reports,
// because that feature makes EVERY block type embeddable and tests asserting
// against a fiction would prove nothing:
//   - a run of list lines is ONE `list` section (not one per line, which is
//     what this fixture used to emit and real Obsidian never does), plus a
//     `listItems` entry per item carrying `parent` for hierarchy;
//   - fenced code, tables and blockquote/callouts get their own section
//     spanning the whole run;
//   - a `^id` alone on a line attaches to the block ABOVE it, which is how
//     Obsidian labels tables, lists and code blocks.
// Still deliberately narrower than CommonMark — it models what these tests
// exercise, not every markdown construct.
const BLOCK_ID_RE = /\^([A-Za-z0-9-]+)\s*$/;
const LIST_LINE_RE = /^\s*([-*+]|\d+\.)\s+/;
const MARKER_ONLY_RE = /^\s*\^([A-Za-z0-9-]+)\s*$/;

interface StubHeadingCache {
  heading: string;
  level: number;
  position: { start: { line: number }; end: { line: number } };
}
interface StubSectionCache {
  id: string | undefined;
  type: string;
  position: { start: { line: number }; end: { line: number } };
}
interface StubListItemCache {
  id: string | undefined;
  parent: number;
  position: { start: { line: number }; end: { line: number } };
}

function pos(startLine: number, endLine: number): StubHeadingCache["position"] {
  return { start: { line: startLine }, end: { line: endLine } };
}

function parseFileCache(content: string): {
  headings: StubHeadingCache[];
  sections: StubSectionCache[];
  listItems: StubListItemCache[];
} {
  const lines = content.split(/\r?\n/);
  const headings: StubHeadingCache[] = [];
  const sections: StubSectionCache[] = [];
  const listItems: StubListItemCache[] = [];

  // Classifies a line so contiguous lines of the same kind group into one
  // section, matching Obsidian's root-level-block granularity.
  const kindOf = (line: string): string | null => {
    if (line.trim() === "") return null;
    if (LIST_LINE_RE.test(line)) return "list";
    if (/^\s*\|/.test(line)) return "table";
    if (/^\s*>/.test(line)) return "blockquote";
    if (/^ {4,}\S/.test(line)) return "code"; // indented-style code block
    return "paragraph";
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A standalone ^id labels the block above it (Obsidian's convention for
    // tables, lists and code blocks).
    const markerOnly = MARKER_ONLY_RE.exec(line);
    if (markerOnly) {
      const last = sections[sections.length - 1];
      if (last) last.id = markerOnly[1];
      i++;
      continue;
    }

    // Fenced code block: spans to its closing fence.
    if (/^\s*```/.test(line)) {
      let end = i + 1;
      while (end < lines.length && !/^\s*```/.test(lines[end])) end++;
      if (end < lines.length) end++; // include the closing fence
      sections.push({ id: undefined, type: "code", position: pos(i, end - 1) });
      i = end;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      const idMatch = BLOCK_ID_RE.exec(text);
      const headingText = idMatch ? text.slice(0, idMatch.index).trim() : text;
      headings.push({ heading: headingText, level: heading[1].length, position: pos(i, i) });
      sections.push({ id: idMatch?.[1], type: "heading", position: pos(i, i) });
      i++;
      continue;
    }

    // A run of same-kind lines becomes one section.
    const kind = kindOf(line)!;
    let end = i;
    while (end + 1 < lines.length && kindOf(lines[end + 1]) === kind) end++;

    if (kind === "list") {
      // One section for the whole list, plus per-item entries. `parent` is the
      // start line of the nearest preceding item with less indentation, or the
      // negated list start for a root-level item (Obsidian's own convention).
      const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].length;
      const stack: { indent: number; line: number }[] = [];
      for (let n = i; n <= end; n++) {
        const indent = indentOf(lines[n]);
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].line : -i;
        const m = BLOCK_ID_RE.exec(lines[n]);
        listItems.push({ id: m?.[1], parent, position: pos(n, n) });
        stack.push({ indent, line: n });
      }
      sections.push({ id: undefined, type: "list", position: pos(i, end) });
    } else {
      const m = BLOCK_ID_RE.exec(lines[end]);
      sections.push({ id: m?.[1], type: kind, position: pos(i, end) });
    }
    i = end + 1;
  }

  return { headings, sections, listItems };
}

// Builds an app whose vault.cachedRead resolves note content from a plain
// path -> raw-markdown map, so a test can register what a target note
// "contains" as real markdown (not pre-rendered HTML) and let the real,
// unmodified MarkdownRenderer.render()/populateEmbeds recursion produce its
// content — exercising the same code path a real vault export does, rather
// than a second, parallel simulation. getFileCache derives heading/section
// positions from that same registered markdown (see parseFileCache above),
// so a heading-scoped or block-scoped embed test needs only write the
// markdown once.
function appWithNotes(
  notes: Record<string, string>,
  resolve: (linkpath: string, sourcePath: string) => TFile | null
) {
  return {
    metadataCache: {
      getFirstLinkpathDest: resolve,
      getFileCache: (file: TFile) => {
        const content = notes[file.path];
        return content === undefined ? null : parseFileCache(content);
      },
    },
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

  it("renders just a heading-scoped embed's own section, not the whole target note (specs/002-scoped-note-embeds US1)", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      {
        "Other Note.md":
          "# Other Note\n\nIntro, not part of any section.\n\n## Some Heading\n\nJust this part.\n\n## Another Heading\n\nMust not appear.",
      },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note#Some Heading]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Some Heading");
    expect(r.xhtmlBody).toContain("Just this part.");
    expect(r.xhtmlBody).not.toContain("Intro, not part");
    expect(r.xhtmlBody).not.toContain("Another Heading");
    expect(r.xhtmlBody).not.toContain("Must not appear");
    expect(r.warnings).toHaveLength(0);
  });

  it("includes a deeper sub-heading before the next same-level heading ends the section", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      {
        "Other Note.md":
          "## Heading A\n\nBody A.\n\n### Sub A\n\nSub body — should be included.\n\n## Heading B\n\nMust not appear.",
      },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note#Heading A]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Sub A");
    expect(r.xhtmlBody).toContain("Sub body");
    expect(r.xhtmlBody).not.toContain("Heading B");
    expect(r.xhtmlBody).not.toContain("Must not appear");
  });

  it("runs to the end of the note when the matched heading has no following heading", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": "# Title\n\n## Last Heading\n\nFinal content, runs to the end." },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note#Last Heading]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Final content, runs to the end.");
  });

  it("resolves a nested embed inside an extracted heading section the same way a whole-note embed's nested embeds resolve (FR-004)", async () => {
    const destOuter = new TFile("/vault", "Outer.md");
    const destInner = new TFile("/vault", "Inner.md");
    const app = appWithNotes(
      {
        "Outer.md": "## Section\n\n![[Inner]]\n\n## Next Section\n\nMust not appear.",
        "Inner.md": "Inner note's own content.",
      },
      (linkpath) => (linkpath === "Outer" ? destOuter : linkpath === "Inner" ? destInner : null)
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Outer#Section]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Inner note's own content.");
    expect(r.xhtmlBody).not.toContain("Next Section");
    expect(r.xhtmlBody).not.toContain("Must not appear");
    expect(r.warnings).toHaveLength(0);
  });

  it("degrades a heading-scoped embed to the placeholder with a distinct 'heading not found' warning when the note resolves but the heading doesn't (US3)", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes({ "Other Note.md": "## Some Heading\n\nJust this part." }, () => dest);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note#Does Not Exist]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Other Note#Does Not Exist]");
    expect(r.warnings).toEqual(["heading not found: Other Note#Does Not Exist (referenced by note.md)"]);
  });

  it("degrades a heading-scoped embed to 'heading not found' when the note resolves but getFileCache itself returns null", async () => {
    // Real Obsidian's getFileCache() can return null even for a valid TFile
    // (e.g. not yet indexed) — toHeadingInfo/toSectionInfo's `?? []`
    // fallback must degrade gracefully rather than throw.
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWith(dest);
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
    expect(r.warnings).toEqual(["heading not found: Other Note#Some Heading (referenced by note.md)"]);
  });

  it("degrades a block-scoped embed to 'block not found' when the note resolves but getFileCache itself returns null", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWith(dest);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^blockid]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Other Note^blockid]");
    expect(r.warnings).toEqual(["block not found: Other Note^blockid (referenced by note.md)"]);
  });

  it("renders just a block-scoped embed's paragraph, not the surrounding content (specs/002-scoped-note-embeds US2)", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      {
        "Other Note.md":
          "Intro paragraph, not part of the embed.\n\nThis is the quoted paragraph. ^quote1\n\nOutro paragraph, also not part of it.",
      },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^quote1]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("This is the quoted paragraph.");
    expect(r.xhtmlBody).not.toContain("^quote1"); // block-ID marker is addressing syntax, not content
    expect(r.xhtmlBody).not.toContain("Intro paragraph");
    expect(r.xhtmlBody).not.toContain("Outro paragraph");
    expect(r.warnings).toHaveLength(0);
  });

  it("renders just a block-scoped embed's heading line when the block ID is attached to a heading", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": "## A Heading ^head1\n\nBody content, not part of the block embed." },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^head1]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("A Heading");
    expect(r.xhtmlBody).not.toContain("Body content");
  });

  // ── specs/002-extend-block-embeds ────────────────────────────────────────
  //
  // This case is the INVERSION of the previous feature's behavior: a block ID
  // on a list item used to degrade to a placeholder. It rendering real content
  // is the primary evidence 002 took effect (that feature's research R6).
  it("US2/FR-005: renders just the referenced list item, not its siblings", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": "- First item.\n- A list item. ^listblock\n- Another item." },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^listblock]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("A list item.");
    expect(r.xhtmlBody).not.toContain("[embedded content omitted");
    expect(r.xhtmlBody).not.toContain("First item.");
    expect(r.xhtmlBody).not.toContain("Another item.");
    expect(r.xhtmlBody).not.toContain("^listblock");
    expect(r.warnings).toHaveLength(0);
  });

  it("US2/FR-006: an embedded list item brings its nested sub-items with it", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      {
        "Other Note.md": [
          "- Untouched sibling.",
          "- Parent item ^parent",
          "    - First child",
          "    - Second child",
          "- Later sibling.",
        ].join("\n"),
      },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^parent]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Parent item");
    expect(r.xhtmlBody).toContain("First child");
    expect(r.xhtmlBody).toContain("Second child");
    expect(r.xhtmlBody).not.toContain("Untouched sibling");
    expect(r.xhtmlBody).not.toContain("Later sibling");
    expect(r.warnings).toHaveLength(0);
  });

  it("US1/FR-001: renders a whole table referenced by a block ID on its own line", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      {
        "Other Note.md": ["| Feature | State |", "| ------- | ----- |", "| Tables  | works |", "^tbl"].join(
          "\n"
        ),
      },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^tbl]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("<table");
    expect(r.xhtmlBody).toContain("works");
    expect(r.xhtmlBody).not.toContain("[embedded content omitted");
    expect(r.xhtmlBody).not.toContain("^tbl");
    expect(r.warnings).toHaveLength(0);
  });

  it("US1/FR-002: renders a fenced code block, leaving a caret inside the code intact", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": ["```js", "const re = /^start/;", "```", "^code"].join("\n") },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^code]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("<code");
    // The marker is gone but the regex's own caret survives — the reason
    // stripBlockMarker is scoped to the resolved ID (002 research R5).
    expect(r.xhtmlBody).not.toContain("^code");
    expect(r.xhtmlBody).toContain("/^start/");
    expect(r.warnings).toHaveLength(0);
  });

  it("US1/FR-003: renders a blockquote referenced by block ID", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": ["> Quoted wisdom.", "> Second line.", "^quoteblock"].join("\n") },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^quoteblock]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("<blockquote");
    expect(r.xhtmlBody).toContain("Quoted wisdom.");
    expect(r.warnings).toHaveLength(0);
  });

  it("FR-014: an embedded numbered-list item keeps its original number", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": ["1. Step one", "2. Step two", "3. Step three ^step3"].join("\n") },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^step3]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain('start="3"');
    expect(r.xhtmlBody).toContain("Step three");
    expect(r.xhtmlBody).not.toContain("Step one");
  });

  it("US3/FR-007: an indented list item renders as a list item, not as a code block", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": ["- Parent", "    - Nested child ^deep", "- Sibling"].join("\n") },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^deep]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    // Without dedenting, the 4-space slice would parse as an indented code
    // block and the reader would get a grey box instead of a bullet.
    expect(r.xhtmlBody).toContain("Nested child");
    expect(r.xhtmlBody).toContain("<li>");
    expect(r.xhtmlBody).not.toContain("<pre>");
    expect(r.warnings).toHaveLength(0);
  });

  // The mirror image of the case above (002 research R3a): an indented-style
  // code block's leading spaces ARE its meaning, so the dedent must NOT run
  // for a section-sourced range or the block silently becomes a paragraph.
  it("FR-002/R3a: an indented-style code block keeps its indentation and stays code", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes(
      { "Other Note.md": ["    indented code line", "    second code line", "^indented"].join("\n") },
      () => dest
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^indented]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("<pre>");
    expect(r.xhtmlBody).toContain("indented code line");
    expect(r.warnings).toHaveLength(0);
  });

  it("FR-010: a nested embed inside block-extracted content still resolves", async () => {
    const outer = new TFile("/vault", "Outer.md");
    const inner = new TFile("/vault", "Inner.md");
    const app = appWithNotes(
      {
        "Outer.md": "Intro.\n\nHosts an embed: ![[Inner]] ^host\n\nOutro.",
        "Inner.md": "Content pulled in from the inner note.",
      },
      (linkpath: string) => (linkpath === "Inner" ? inner : outer)
    );
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Outer^host]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("Content pulled in from the inner note.");
    expect(r.xhtmlBody).not.toContain("Intro.");
    expect(r.xhtmlBody).not.toContain("Outro.");
    expect(r.xhtmlBody).not.toContain("^host");
  });

  it("degrades a block-scoped embed to the placeholder with a distinct 'block not found' warning when the note resolves but the block doesn't (US3)", async () => {
    const dest = new TFile("/vault", "Other Note.md");
    const app = appWithNotes({ "Other Note.md": "Just a paragraph, no block ID here." }, () => dest);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[Other Note^nonexistent]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.xhtmlBody).toContain("[embedded content omitted: Other Note^nonexistent]");
    expect(r.warnings).toEqual(["block not found: Other Note^nonexistent (referenced by note.md)"]);
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

  it("US3 acceptance scenario 3: a heading/block suffix on a nonexistent NOTE still produces the plain 'missing embed' message, not a heading/block-specific one", async () => {
    // Confirms dest resolution runs first: the heading/block lookup is never
    // reached (and never gets a chance to produce a different message) when
    // the note itself doesn't resolve at all.
    const r1 = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![[Does Not Exist#Some Heading]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r1.warnings).toEqual(["missing embed: Does Not Exist#Some Heading (referenced by note.md)"]);

    const r2 = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      "![[Does Not Exist^blockid]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r2.warnings).toEqual(["missing embed: Does Not Exist^blockid (referenced by note.md)"]);
  });

  it("US3/FR-005/FR-006: heading-not-found, block-not-found, missing-embed, circular, and unsupported-type warnings are all textually distinct", async () => {
    const destOther = new TFile("/vault", "Other Note.md");
    const destSelf = new TFile("/vault", "note.md");
    const app = appWithNotes({ "Other Note.md": "## Some Heading\n\nBody.", "note.md": "" }, (linkpath) =>
      linkpath === "Other Note" ? destOther : linkpath === "note" ? destSelf : null
    );
    const [heading, block, missing, circular] = await Promise.all([
      renderUnitToChapter(app, newComponent(), "![[Other Note#Nope]]", "note.md", new Map(), "/vault", 0),
      renderUnitToChapter(app, newComponent(), "![[Other Note^nope]]", "note.md", new Map(), "/vault", 0),
      renderUnitToChapter(app, newComponent(), "![[Nope]]", "note.md", new Map(), "/vault", 0),
      renderUnitToChapter(app, newComponent(), "![[note]]", "note.md", new Map(), "/vault", 0),
    ]);
    const messages = [heading.warnings[0], block.warnings[0], missing.warnings[0], circular.warnings[0]];
    expect(new Set(messages).size).toBe(messages.length); // all four distinct, no message collisions
    expect(messages[0]).toContain("heading not found");
    expect(messages[1]).toContain("block not found");
    expect(messages[2]).toContain("missing embed");
    expect(messages[3]).toContain("circular embed skipped");
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

  it("treats a scoped embed of the host's own note as circular, not as a heading/block lookup (FR-008)", async () => {
    // The dest/circular check runs BEFORE any heading/block resolution (see
    // src/render-adapter.ts's populateEmbeds), so a note embedding a section
    // of itself never reaches findHeadingSection/findSupportedBlock at all —
    // it degrades exactly like any other self-referencing embed already
    // would, with no new self-reference-specific code path.
    const self = new TFile("/vault", "note.md");
    const app = appWithNotes({ "note.md": "## Section\n\n![[note#Section]]" }, () => self);
    const r = await renderUnitToChapter(
      app,
      newComponent(),
      "![[note#Section]]",
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.warnings).toEqual(["circular embed skipped: note#Section (referenced by note.md)"]);
    expect(r.xhtmlBody).not.toContain("heading not found");
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

describe("renderUnitToChapter heading TOC (004-heading-toc)", () => {
  const HEADED = "# Title\n\n## Part A\n\n### Detail\n\n## Part B\n";

  it("returns toc entries and stamps matching ids into the serialized body", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      HEADED,
      "note.md",
      new Map(),
      "/vault",
      0,
      3
    );
    expect(r.toc).toEqual([
      { level: 2, text: "Part A", id: "part-a" },
      { level: 3, text: "Detail", id: "detail" },
      { level: 2, text: "Part B", id: "part-b" },
    ]);
    expect(r.xhtmlBody).toContain('<h2 id="part-a">Part A</h2>');
    expect(r.xhtmlBody).toContain('<h3 id="detail">Detail</h3>');
    expect(r.xhtmlBody).toContain('<h2 id="part-b">Part B</h2>');
  });

  it("tocDepth 0 returns an empty toc and a body with no id stamps (depth-0 identity)", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      HEADED,
      "note.md",
      new Map(),
      "/vault",
      0,
      0
    );
    expect(r.toc).toEqual([]);
    expect(r.xhtmlBody).not.toContain('id="');
    expect(r.xhtmlBody).toContain("<h2>Part A</h2>");
  });

  it("omitting tocDepth behaves like 0 (default off)", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      newComponent(),
      HEADED,
      "note.md",
      new Map(),
      "/vault",
      0
    );
    expect(r.toc).toEqual([]);
    expect(r.xhtmlBody).not.toContain('id="');
  });
});
