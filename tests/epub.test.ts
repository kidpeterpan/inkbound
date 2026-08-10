import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { EpubBuilder, chapterHref, escapeXml } from "../src/epub";

const META = { title: "ทดสอบ & Book", author: "Pan", language: "th" };

async function buildSample() {
  const b = new EpubBuilder(META);
  b.addChapter("Intro <1>", "<p>สวัสดี</p>");
  b.addChapter("Ch 2", '<p><img src="../images/img_001.png" alt=""/></p>');
  b.addAsset("images/img_001.png", new Uint8Array([137, 80, 78, 71]), "image/png");
  return b.build();
}

describe("EpubBuilder container", () => {
  it("puts uncompressed mimetype first", async () => {
    const bytes = await buildSample();
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 60));
    expect(head.includes("mimetypeapplication/epub+zip")).toBe(true);
  });

  it("falls back to a manual RFC-4122 v4 UUID when crypto.randomUUID is unavailable", async () => {
    // Node/vitest always has crypto.randomUUID, so the manual fallback in
    // cryptoRandomUuid() (not exported — only reachable through a built OPF's
    // dc:identifier) never runs unless it's temporarily removed here.
    // `randomUUID` lives on Crypto.prototype, not as an own property of the
    // `crypto` instance — `delete crypto.randomUUID` on the untouched object
    // is a silent no-op (the inherited method remains reachable), so shadow
    // it with a non-writable own property instead to actually hide it;
    // `delete` on THAT own property (not plain reassignment, which throws
    // against a non-writable property) cleanly restores the inherited one.
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      const zip = await JSZip.loadAsync(await buildSample());
      const opf = await zip.file("OEBPS/package.opf")!.async("string");
      // The fallback always sets the version/variant nibbles ("4" and one of
      // 8/9/a/b) even though the rest is random, matching the real
      // crypto.randomUUID()'s v4 shape.
      expect(opf).toMatch(
        /<dc:identifier id="uid">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/
      );
    } finally {
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("has container.xml pointing at the OPF", async () => {
    const zip = await JSZip.loadAsync(await buildSample());
    const xml = await zip.file("META-INF/container.xml")!.async("string");
    expect(xml).toContain('full-path="OEBPS/package.opf"');
  });

  it("OPF lists metadata, all items, and spine in order", async () => {
    const zip = await JSZip.loadAsync(await buildSample());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(opf).toContain('<dc:identifier id="uid">urn:uuid:');
    expect(opf).toMatch(
      /<dc:identifier id="uid">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/dc:identifier>/
    );
    expect(opf).toContain("<dc:title>ทดสอบ &amp; Book</dc:title>");
    expect(opf).toContain("<dc:creator>Pan</dc:creator>");
    expect(opf).toContain("<dc:language>th</dc:language>");
    expect(opf).toMatch(/dcterms:modified/);
    expect(opf).toContain('href="text/chapter_001.xhtml"');
    expect(opf).toContain('href="images/img_001.png" media-type="image/png"');
    const spine = opf.slice(opf.indexOf("<spine"));
    expect(spine.indexOf("ch_001")).toBeLessThan(spine.indexOf("ch_002"));
  });

  it("nav.xhtml links every chapter with escaped titles", async () => {
    const zip = await JSZip.loadAsync(await buildSample());
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('<a href="text/chapter_001.xhtml">Intro &lt;1&gt;</a>');
    expect(nav).toContain('<a href="text/chapter_002.xhtml">Ch 2</a>');
  });

  it("wraps chapter bodies in XHTML docs that reference the css", async () => {
    const zip = await JSZip.loadAsync(await buildSample());
    const ch = await zip.file("OEBPS/text/chapter_001.xhtml")!.async("string");
    expect(ch).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(ch).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(ch).toContain('href="../style/epub.css"');
    expect(ch).toContain("<p>สวัสดี</p>");
    expect(zip.file("OEBPS/style/epub.css")).not.toBeNull();
  });

  it("embeds a cover when provided", async () => {
    const b = new EpubBuilder({ ...META, coverBytes: new Uint8Array([255, 216]), coverExt: "jpg" });
    b.addChapter("One", "<p>x</p>");
    const zip = await JSZip.loadAsync(await b.build());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(zip.file("OEBPS/images/cover.jpg")).not.toBeNull();
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
  });

  it("adds a cover page as the first spine item when a cover exists", async () => {
    const b = new EpubBuilder({ ...META, coverBytes: new Uint8Array([137, 80, 78, 71]), coverExt: "png" });
    b.addChapter("One", "<p>x</p>");
    b.addChapter("Two", "<p>y</p>");
    const zip = await JSZip.loadAsync(await b.build());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    const coverDoc = await zip.file("OEBPS/text/cover.xhtml")!.async("string");

    // Document exists and displays the image full-page (CSS class applied).
    expect(zip.file("OEBPS/text/cover.xhtml")).not.toBeNull();
    expect(coverDoc).toContain('class="cover-page"');
    expect(coverDoc).toContain('src="../images/cover.png"');

    // Manifest declares the page; the spine starts with it, before ch_001.
    expect(opf).toContain(
      '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>'
    );
    const spine = opf.slice(opf.indexOf("<spine"));
    expect(spine.indexOf("cover-page")).toBeLessThan(spine.indexOf("ch_001"));

    // Not in the TOC, but reachable via a landmarks entry (epubcheck OPF-096).
    const toc = nav.match(/<nav epub:type="toc">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    expect(toc).not.toContain("text/cover.xhtml");
    expect(toc).toContain("text/chapter_001.xhtml");
    const landmarks = nav.match(/<nav epub:type="landmarks">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    // epubcheck RSC-005: in a landmarks nav the epub:type belongs on the
    // ANCHOR, not the li (EPUB 3.3 §nav-landmarks).
    expect(landmarks).toContain('<a epub:type="cover" href="text/cover.xhtml">Cover</a>');
  });

  it("never adds a cover page, landmarks, or cover-page item without a cover", async () => {
    const zip = await JSZip.loadAsync(await buildSample());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(zip.file("OEBPS/text/cover.xhtml")).toBeNull();
    expect(opf).not.toContain('id="cover-page"');
    expect(nav).not.toContain('epub:type="landmarks"');
  });

  it("declares image/webp for a webp cover in the manifest", async () => {
    const b = new EpubBuilder({ ...META, coverBytes: new Uint8Array([82, 73, 70, 70]), coverExt: "webp" });
    b.addChapter("One", "<p>x</p>");
    const zip = await JSZip.loadAsync(await b.build());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(zip.file("OEBPS/images/cover.webp")).not.toBeNull();
    expect(opf).toContain('href="images/cover.webp" media-type="image/webp"');
    expect(opf).toContain('properties="cover-image"');
  });

  it("ships .cover-page CSS rules in the embedded stylesheet", async () => {
    const { EPUB_CSS } = await import("../src/epub-css");
    expect(EPUB_CSS).toContain(".cover-page");
    expect(EPUB_CSS).toMatch(/\.cover-page\s*\{[^}]*text-align:\s*center/);
  });

  it('declares properties="svg" on the manifest item for a chapter containing inline SVG', async () => {
    const b = new EpubBuilder(META);
    b.addChapter(
      "Diagram",
      '<div class="mermaid"><svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg></div>'
    );
    b.addChapter("No Diagram", "<p>plain text</p>");
    const zip = await JSZip.loadAsync(await b.build());
    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    const ch1Item = opf.match(/<item id="ch_001".*?\/>/)?.[0];
    const ch2Item = opf.match(/<item id="ch_002".*?\/>/)?.[0];
    expect(ch1Item).toContain('properties="svg"');
    expect(ch2Item).not.toContain('properties="svg"');
  });

  it("chapterHref pads to 3 digits", () => {
    expect(chapterHref(0)).toBe("text/chapter_001.xhtml");
    expect(chapterHref(11)).toBe("text/chapter_012.xhtml");
  });

  it("escapeXml handles the five specials", () => {
    expect(escapeXml(`<a b="c">&'`)).toBe("&lt;a b=&quot;c&quot;&gt;&amp;&apos;");
  });
});

describe("heading sub-entries in nav.xhtml", () => {
  const TOC = [
    { level: 2, text: "Part A", id: "part-a" },
    { level: 3, text: "Detail 1", id: "detail-1" },
    { level: 2, text: "Part B", id: "part-b" },
  ];

  async function navFor(chapters: { title: string; body: string; toc?: typeof TOC }[]): Promise<string> {
    const b = new EpubBuilder(META);
    for (const c of chapters) b.addChapter(c.title, c.body, c.toc ?? []);
    const zip = await JSZip.loadAsync(await b.build());
    return zip.file("OEBPS/nav.xhtml")!.async("string");
  }

  it("lists headings as nested sub-entries under the chapter li", async () => {
    const nav = await navFor([{ title: "Ch", body: "<p>x</p>", toc: TOC }]);
    expect(nav).toContain('<a href="text/chapter_001.xhtml">Ch</a>');
    expect(nav).toContain('<a href="text/chapter_001.xhtml#part-a">Part A</a>');
    expect(nav).toContain('<a href="text/chapter_001.xhtml#detail-1">Detail 1</a>');
    expect(nav).toContain('<a href="text/chapter_001.xhtml#part-b">Part B</a>');
  });

  it("escapes heading text and does not escape the id in the href", async () => {
    const nav = await navFor([
      { title: "Ch", body: "<p>x</p>", toc: [{ level: 2, text: 'A "Q" & <B>', id: "a-q-b" }] },
    ]);
    expect(nav).toContain('<a href="text/chapter_001.xhtml#a-q-b">A &quot;Q&quot; &amp; &lt;B&gt;</a>');
  });

  it("keeps the exact flat chapter li when toc is empty", async () => {
    const nav = await navFor([{ title: "Plain", body: "<p>x</p>", toc: [] }]);
    expect(nav).toContain('<li><a href="text/chapter_001.xhtml">Plain</a></li>');
  });

  it("nests sub-entries inside the chapter's own li, not globally", async () => {
    const nav = await navFor([
      { title: "A", body: "<p>x</p>", toc: TOC },
      { title: "B", body: "<p>y</p>", toc: [] },
    ]);
    const toc = nav.match(/<nav epub:type="toc">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    const firstLi = toc.slice(toc.indexOf("<li>"), toc.indexOf("</li>") + 5);
    expect(firstLi).toContain("chapter_001.xhtml");
    expect(firstLi).toContain("<ol>");
    expect(firstLi).toContain("chapter_001.xhtml#part-a");
    // The second chapter's flat li sits after the first chapter's li (and its
    // nested ol) — its entry must not be swallowed into the nested list.
    expect(toc.indexOf("chapter_002.xhtml")).toBeGreaterThan(toc.indexOf("</li>") + 1);
  });
});

describe("TOC nesting mirrors heading hierarchy (004-heading-toc US3)", () => {
  async function navTocFor(entries: { level: number; text: string; id: string }[]): Promise<string> {
    const b = new EpubBuilder(META);
    b.addChapter("Ch", "<p>x</p>", entries);
    const zip = await JSZip.loadAsync(await b.build());
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    return nav.match(/<nav epub:type="toc">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  }

  it("groups interleaved H3s under the H2 that precedes them", async () => {
    const toc = await navTocFor([
      { level: 2, text: "Part A", id: "part-a" },
      { level: 3, text: "Detail 1", id: "detail-1" },
      { level: 3, text: "Detail 2", id: "detail-2" },
      { level: 2, text: "Part B", id: "part-b" },
    ]);
    const partA = toc.slice(toc.indexOf("Part A"), toc.indexOf("Part B"));
    expect(partA).toContain("Detail 1");
    expect(partA).toContain("Detail 2");
    // Detail entries live inside Part A's nested ol — they appear AFTER the
    // Part A anchor and BEFORE Part B's anchor, in document order.
    expect(partA.indexOf("Detail 1")).toBeLessThan(partA.indexOf("Detail 2"));
    expect(partA.indexOf("detail-1")).toBeGreaterThan(partA.indexOf("Part A"));
  });

  it("skips level gaps without injecting empty levels (H2 then H4)", async () => {
    const toc = await navTocFor([
      { level: 2, text: "Part A", id: "part-a" },
      { level: 4, text: "Deep", id: "deep" },
      { level: 2, text: "Part B", id: "part-b" },
    ]);
    const partA = toc.slice(toc.indexOf("Part A"), toc.indexOf("Part B"));
    expect(partA).toContain("#deep");
    expect(partA).toContain("Deep");
    // No empty intermediate level: nav root <ol> + Part A's <ol> only.
    expect((toc.match(/<ol>/g) ?? []).length).toBe(3);
  });

  it("nests three-level H2/H3/H4 chains recursively", async () => {
    const toc = await navTocFor([
      { level: 2, text: "A", id: "a" },
      { level: 3, text: "B", id: "b" },
      { level: 4, text: "C", id: "c" },
    ]);
    expect(toc.indexOf("#a")).toBeLessThan(toc.indexOf("#b"));
    expect(toc.indexOf("#b")).toBeLessThan(toc.indexOf("#c"));
    // nav root <ol> + one nested <ol> per parent heading (A and B).
    expect((toc.match(/<ol>/g) ?? []).length).toBe(4);
  });
});
