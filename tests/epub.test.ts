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

  it("chapterHref pads to 3 digits", () => {
    expect(chapterHref(0)).toBe("text/chapter_001.xhtml");
    expect(chapterHref(11)).toBe("text/chapter_012.xhtml");
  });

  it("escapeXml handles the five specials", () => {
    expect(escapeXml(`<a b="c">&'`)).toBe("&lt;a b=&quot;c&quot;&gt;&amp;&apos;");
  });
});
