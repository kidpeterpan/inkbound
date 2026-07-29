import { writeFileSync } from "fs";
import { EpubBuilder } from "../src/epub";

const b = new EpubBuilder({ title: "ตัวอย่าง Sample", author: "Pan", language: "th" });
b.addChapter("บทที่หนึ่ง", "<h1>บทที่หนึ่ง</h1><p>Thai + <em>English</em> mixed.</p>");
b.addChapter("Code", '<pre><code>fmt.Println("hi")</code></pre>');
b.build().then((bytes) => {
  writeFileSync("sample.epub", bytes);
  console.log("wrote sample.epub", bytes.length, "bytes");
});
