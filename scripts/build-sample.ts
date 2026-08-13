import { writeFileSync } from "fs";
import { EpubBuilder } from "../src/epub";
import { renderMathToSvg } from "../src/math";

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
// Math (005-latex-math): real MathJax-rendered SVGs, exactly the shape the
// pipeline's inline-SVG fallback ships — validates properties="svg" and the
// MathJax markup against epubcheck. The merror expression (invalid command)
// exercises the red error-rendering path too.
const inlineMath = renderMathToSvg("E = mc^2", false);
const displayMath = renderMathToSvg("\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", true);
const errorMath = renderMathToSvg("\\invalidcommand", false);
b.addChapter(
  "Math",
  `<p>inline: ${inlineMath.svg} in prose</p><p class="math-block">${displayMath.svg}</p>` +
    `<p>broken: ${errorMath.svg}</p>`
);
// Thai font (006-thai-font): fixture bytes (the real TTFs are esbuild-binary
// inlined; this sample only needs non-empty font/ttf assets so epubcheck
// validates the manifest media types, @font-face rules, and the OFL
// text/plain asset the pipeline ships).
b.setThaiFont({
  regular: new Uint8Array([0x00, 0x01, 0x02]),
  bold: new Uint8Array([0x00, 0x01, 0x02]),
  license: "SIL OPEN FONT LICENSE Version 1.1 — fixture",
});
b.build().then((bytes) => {
  writeFileSync("sample.epub", bytes);
  console.log("wrote sample.epub", bytes.length, "bytes");
});
