import { writeFileSync } from "fs";
import { EpubBuilder } from "../src/epub";

// A real 1×1 transparent PNG (base64) so the sample's cover page and
// manifest cover get validated against the EPUB 3.3 spec by epubcheck.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const b = new EpubBuilder({
  title: "ตัวอย่าง Sample",
  author: "Pan",
  language: "th",
  coverBytes: new Uint8Array(TINY_PNG),
  coverExt: "png",
});
b.addChapter(
  "บทที่หนึ่ง",
  // The heading ids mirror what collectHeadingToc stamps before
  // serialization in the real pipeline — nav fragment links MUST resolve
  // into the body (epubcheck RSC-012).
  '<h1>บทที่หนึ่ง</h1><p>Thai + <em>English</em> mixed.</p><h2 id="หัวข้อแรก">หัวข้อแรก</h2><p>a</p><h3 id="sub-section">Sub section</h3><p>b</p><h2 id="หัวข้อสอง">หัวข้อสอง</h2>',
  // Heading sub-entries (004-heading-toc): exercise nested nav ol + a Thai
  // fragment id against epubcheck's RSC-012 link-resolution check.
  [
    { level: 2, text: "หัวข้อแรก", id: "หัวข้อแรก" },
    { level: 3, text: "Sub section", id: "sub-section" },
    { level: 2, text: "หัวข้อสอง", id: "หัวข้อสอง" },
  ]
);
b.addChapter("Code", '<pre><code>fmt.Println("hi")</code></pre>');
b.addChapter("Headings", '<h2 id="usage">Usage</h2><p>x</p><h2 id="usage-2">Usage</h2><p>y</p>', [
  { level: 2, text: "Usage", id: "usage" },
  { level: 2, text: "Usage", id: "usage-2" },
]);
b.build().then((bytes) => {
  writeFileSync("sample.epub", bytes);
  console.log("wrote sample.epub", bytes.length, "bytes");
});
