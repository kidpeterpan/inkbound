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
b.addChapter("บทที่หนึ่ง", "<h1>บทที่หนึ่ง</h1><p>Thai + <em>English</em> mixed.</p>");
b.addChapter("Code", '<pre><code>fmt.Println("hi")</code></pre>');
b.build().then((bytes) => {
  writeFileSync("sample.epub", bytes);
  console.log("wrote sample.epub", bytes.length, "bytes");
});
