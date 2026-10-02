// Characterization test for 011-footnote-semantics (FR-023, SC-004).
//
// Written and its constants captured BEFORE any footnote code existed, against the
// unmodified tree. It must stay green for the whole feature: it is the unit-level
// proof that a book with no footnotes is byte-for-byte what it was before the feature.
// If a constant here changes, that is a defect in the feature — never a reason to
// re-capture. (See specs/011-footnote-semantics/spec.md, "Byte-identical" assumption,
// for why the package identifier and modified date are normalised.)

import { describe, it, expect, afterEach } from "vitest";
import { Component, TFile } from "./fixtures/obsidian-stub";
import { renderUnitToChapter, setSvgRasterizer } from "../src/adapters/render-adapter";
import { EpubBuilder } from "../src/core/epub";
import { epubEntryFingerprints, sha256 } from "./fixtures/epub-fingerprint";

// A real 1x1 transparent PNG, same bytes scripts/build-sample.ts uses.
const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  )
);

async function buildFootnoteFreeBook(): Promise<Uint8Array> {
  const b = new EpubBuilder({
    title: "ตัวอย่าง Identity",
    author: "Pan",
    language: "th",
    coverBytes: TINY_PNG,
    coverExt: "png",
  });
  b.addChapter(
    "บทที่หนึ่ง",
    '<h1>บทที่หนึ่ง</h1><p>Thai + <em>English</em> mixed.</p><h2 id="หัวข้อแรก">หัวข้อแรก</h2><p>a</p><h3 id="sub-section">Sub section</h3><p>b</p>',
    [
      { level: 2, text: "หัวข้อแรก", id: "หัวข้อแรก" },
      { level: 3, text: "Sub section", id: "sub-section" },
    ]
  );
  b.addChapter(
    "Blocks",
    '<div class="callout"><div class="callout-title">Note</div><div class="callout-content"><p>c</p></div></div>' +
      "<table><tr><th>h</th></tr><tr><td>d</td></tr></table>" +
      '<p><img src="../images/img_001.png" alt="pixel"/></p><pre><code>x = 1</code></pre>' +
      '<p class="omitted">[embedded content omitted: gone]</p>'
  );
  b.addAsset("images/img_001.png", TINY_PNG, "image/png");
  b.addChapter("Headings", '<h2 id="usage">Usage</h2><p>x</p><h2 id="usage-2">Usage</h2><p>y</p>', [
    { level: 2, text: "Usage", id: "usage" },
    { level: 2, text: "Usage", id: "usage-2" },
  ]);
  b.setThaiFont({
    regular: new Uint8Array([0, 1, 2]),
    bold: new Uint8Array([0, 1, 2]),
    license: "SIL OPEN FONT LICENSE Version 1.1 — fixture",
  });
  b.setNavTree([
    { kind: "chapter", chapter: 0 },
    {
      kind: "part",
      title: "Part A",
      indexChapter: null,
      children: [
        { kind: "chapter", chapter: 1 },
        { kind: "chapter", chapter: 2 },
      ],
    },
  ]);
  return b.build();
}

const EXPECTED_BOOK_ENTRIES: Record<string, string> = {
  "META-INF/container.xml": "bcc0d597a725325618e4552c38a2673a515a3c204f8834ad836930c35c1b6a06",
  "OEBPS/fonts/NotoSansThai-Bold.ttf": "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
  "OEBPS/fonts/NotoSansThai-Regular.ttf": "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
  "OEBPS/fonts/OFL.txt": "f5ed70c1c44c5d1d9a7bf797624920dba60d8929658a8351b20a53964d89d1a5",
  "OEBPS/images/cover.png": "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
  "OEBPS/images/img_001.png": "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
  "OEBPS/nav.xhtml": "b99bd7180ac1c401dbcc07b51dee41e40690341c61035bad4c44a1c48b2b71d7",
  "OEBPS/package.opf": "4e2e1224b921027c295dd02510739f04725e5c340bc86656b6bd5e0f9bea0a43",
  "OEBPS/style/epub.css": "b03d84f8580a8424a5076e86582645424cf1f26664eeaea4523ef924e16d9ee0",
  "OEBPS/text/chapter_001.xhtml": "565a2ef82600ac96e431e8ca2744a2e542985f7c190a692ed0bda08d33f59280",
  "OEBPS/text/chapter_002.xhtml": "72e0c196503ff231852316d79bced4270e89d8d074b44cf86d922103d3a3a9fa",
  "OEBPS/text/chapter_003.xhtml": "9afaf2be1b1944643d6d501d528ce4ba97cb48ada38aedd33b69defc68612032",
  "OEBPS/text/cover.xhtml": "dd40bece09610d558dd0f06232b977ab42abedf940add4fff79578eb0fb8a12f",
  mimetype: "e468e350d1143eb648f60c7b0bd6031101ec0544a361ca74ecef256ac901f48b",
};

describe("footnote-free book identity (FR-023)", () => {
  it("EpubBuilder produces the same bytes for every entry as before the feature", async () => {
    const actual = await epubEntryFingerprints(await buildFootnoteFreeBook());
    expect(actual).toEqual(EXPECTED_BOOK_ENTRIES);
  });
});

function appWith(dest: TFile | null) {
  return {
    metadataCache: { getFirstLinkpathDest: () => dest, getFileCache: () => null },
    vault: { adapter: { getBasePath: () => "/vault" }, cachedRead: () => Promise.resolve("") },
  } as never;
}

const FOOTNOTE_FREE_MD = [
  "# Title",
  "",
  "Intro with [a link](https://example.com) and a caret a^b and [brackets] and **bold**.",
  "",
  "## Usage",
  "",
  "- item one",
  "- item two",
  "",
  "> [!note] A callout",
  "> body",
  "",
  "## Usage",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
].join("\n");

const EXPECTED_CHAPTER = {
  bodyHash: "e41b84a2880a6da2572f1ed37cf93e1e0358179931b5b235948c0264ec7113bb",
  tocHash: "6443030ef67d840b918e5c534e08de3ff73c3880912397aaaf033fef1b455fa7",
};

describe("footnote-free chapter identity (FR-023)", () => {
  afterEach(() => setSvgRasterizer(null));

  it("renderUnitToChapter yields the same body and TOC as before the feature", async () => {
    const r = await renderUnitToChapter(
      appWith(null),
      new Component() as never,
      FOOTNOTE_FREE_MD,
      "note.md",
      new Map(),
      "/vault",
      0,
      3
    );
    expect({ bodyHash: sha256(r.xhtmlBody), tocHash: sha256(JSON.stringify(r.toc)) }).toEqual(
      EXPECTED_CHAPTER
    );
    expect(r.warnings).toEqual([]);
  });
});
