# EPUB Export Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian desktop plugin (`epub-export`) that exports a note, a book folder, or a note+linked-notes set as one `.epub`, saves it to a local folder, and optionally pushes it to an Onyx Boox device over LAN via BooxDrop.

**Architecture:** Pure core modules (`epub.ts`, `collect.ts`, `render.ts` helpers, `booxdrop.ts`, `naming.ts`) have zero `obsidian` imports and are unit-tested with vitest/jsdom. Thin adapters in `main.ts` glue them to the Obsidian API (`MarkdownRenderer`, `metadataCache`, `requestUrl`). EPUB 3 container is assembled by hand with JSZip.

**Tech Stack:** TypeScript 5, esbuild, JSZip ^3.10, vitest ^2 (jsdom environment), Obsidian plugin API (types via `obsidian` npm package), Node `fs/path/os` (desktop only).

**Spec:** `docs/superpowers/specs/2026-07-28-epub-export-design.md` (approved 2026-07-28).

## Global Constraints

- Plugin id `epub-export`, `isDesktopOnly: true`, `minAppVersion: "1.5.0"`.
- Deploy copies **only** `main.js`, `manifest.json`, `styles.css` into `pan_vault/.obsidian/plugins/epub-export/` — never `node_modules` or sources. Vault path contains `@`: always quote `"~/Documents/pan_vault"`.
- Settings defaults: output folder `~/Downloads`, link depth `1` (range 1–3), language `"th"`, fallback author `""`, push disabled until Boox URL set.
- Output filename = `slugify(title) + ".epub"`, **overwrite** existing files.
- Local save always happens **before** any BooxDrop push; push failure must not fail the export.
- EPUB: `mimetype` entry first and STORED (uncompressed); OPF requires `dc:identifier`, `dc:title`, `dc:language`, `dcterms:modified`; Thai text passes through untouched, no font embedding.
- Wikilinks to notes inside the export set become internal chapter links; outside → plain text. Dataview blocks → `*[dynamic content omitted]*`. Unrendered embeds (incl. Excalidraw) → placeholder paragraph.
- Commit after every task (conventional messages, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` footer).
- All work in `~/Documents/obsidian-epub-export/` (fresh repo, main branch — no worktree needed).

## File Structure

```
obsidian-epub-export/
├── manifest.json            # plugin manifest (deployed)
├── styles.css               # empty; deployed for completeness
├── package.json  tsconfig.json  esbuild.config.mjs  vitest.config.ts  .gitignore
├── scripts/
│   ├── deploy.sh            # build + copy 3 files into vault
│   └── build-sample.ts      # generates sample.epub for epubcheck
├── src/
│   ├── main.ts              # plugin class, commands, menus, runExport orchestrator
│   ├── settings.ts          # settings model + tab + pure path/warning helpers
│   ├── types.ts             # shared interfaces
│   ├── naming.ts            # slugify, deriveChapterTitle (USER decision point)
│   ├── epub.ts              # EpubBuilder (pure)
│   ├── epub-css.ts          # EPUB_CSS constant (USER styling point)
│   ├── collect.ts           # orderChapters, pickIndexNote, bfsLinked (pure)
│   ├── render.ts            # markdown preprocess + DOM cleanup/rewrite (pure) + render adapter
│   └── booxdrop.ts          # buildMultipart (pure) + BooxDropClient
└── tests/
    ├── naming.test.ts  epub.test.ts  collect.test.ts  render.test.ts  booxdrop.test.ts  settings.test.ts
```

---

### Task 1: Project scaffold, build toolchain, test harness, deploy script

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `.gitignore`, `manifest.json`, `styles.css`, `src/main.ts` (stub), `scripts/deploy.sh`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `npm run build` → `main.js`; `npm test` → vitest run; `npm run deploy` → copies 3 files to vault plugin dir

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "obsidian-epub-export",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run",
    "deploy": "npm run build && bash scripts/deploy.sh"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "esbuild": "^0.21.5",
    "obsidian": "^1.5.7",
    "tsx": "^4.16.0",
    "typescript": "^5.5.3",
    "vitest": "^2.0.0",
    "jsdom": "^24.1.0"
  },
  "dependencies": {
    "jszip": "^3.10.1"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["DOM", "ES2020"], "strict": true, "esModuleInterop": true,
    "skipLibCheck": true, "noEmit": true, "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

`esbuild.config.mjs`:
```js
import esbuild from "esbuild";
const prod = process.argv[2] === "production";
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "node",
  external: ["obsidian", "electron"],
  sourcemap: prod ? false : "inline",
  logLevel: "info",
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "jsdom", include: ["tests/**/*.test.ts"] },
});
```

`.gitignore`:
```
node_modules/
main.js
*.epub
```

`manifest.json`:
```json
{
  "id": "epub-export",
  "name": "EPUB Export",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Export notes, book folders, or linked-note bundles as EPUB and push them to a Boox device via BooxDrop.",
  "author": "Pan",
  "isDesktopOnly": true
}
```

`styles.css`: empty file (`touch styles.css`).

`src/main.ts` (stub — replaced in Task 7):
```ts
import { Plugin } from "obsidian";

export default class EpubExportPlugin extends Plugin {
  async onload() {
    console.log("epub-export loaded");
  }
}
```

`scripts/deploy.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
VAULT="${VAULT:-~/Documents/pan_vault}"
DEST="$VAULT/.obsidian/plugins/epub-export"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "Deployed to $DEST"
```

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("harness", () => {
  it("runs with a DOM", () => {
    const el = document.createElement("div");
    el.innerHTML = "<p>ok</p>";
    expect(el.querySelector("p")?.textContent).toBe("ok");
  });
});
```

- [ ] **Step 2: Install and verify build + tests**

Run: `cd "~/Documents/obsidian-epub-export" && npm install && npm run build && npm test`
Expected: `main.js` created; smoke test PASS.

- [ ] **Step 3: Verify deploy copies exactly 3 files**

Run: `npm run deploy && ls "~/Documents/pan_vault/.obsidian/plugins/epub-export"`
Expected: `main.js manifest.json styles.css` — nothing else.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold plugin toolchain (esbuild, vitest, deploy script)"
```

---

### Task 2: `naming.ts` — slugify + default chapter-title derivation

**Files:**
- Create: `src/naming.ts`, `tests/naming.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `slugify(title: string): string`; `deriveChapterTitle(basename: string, aliases: string[] | undefined, firstH1: string | undefined): string` (default: returns `basename`; precedence revisited by Pan in Task 11)

- [ ] **Step 1: Write failing tests**

`tests/naming.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { slugify, deriveChapterTitle } from "../src/naming";

describe("slugify", () => {
  it("lowercases and snake_cases spaces", () => {
    expect(slugify("Learn Go With Tests")).toBe("learn_go_with_tests");
  });
  it("strips filesystem-hostile characters", () => {
    expect(slugify('a/b\\c:d*e?f"g<h>i|j#k')).toBe("abcdefghijk");
  });
  it("preserves Thai characters", () => {
    expect(slugify("สรุปหนังสือ Go")).toBe("สรุปหนังสือ_go");
  });
  it("falls back to 'export' when empty", () => {
    expect(slugify("???")).toBe("export");
  });
});

describe("deriveChapterTitle (default rule: basename)", () => {
  it("returns basename by default", () => {
    expect(deriveChapterTitle("01_hello_world", ["Hello"], "Hello World")).toBe("01_hello_world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/naming.test.ts`
Expected: FAIL — cannot resolve `../src/naming`.

- [ ] **Step 3: Implement**

`src/naming.ts`:
```ts
export function slugify(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return cleaned.length > 0 ? cleaned : "export";
}

// Default rule: the filename is the title. Precedence among
// basename / frontmatter alias / first H1 is a product decision —
// revisited in Task 11 (USER CONTRIBUTION).
export function deriveChapterTitle(
  basename: string,
  _aliases: string[] | undefined,
  _firstH1: string | undefined
): string {
  return basename;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/naming.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/naming.ts tests/naming.test.ts && git commit -m "feat: slugify and default chapter-title derivation"
```

---

### Task 3: `epub.ts` — EpubBuilder (+ base `epub-css.ts`)

**Files:**
- Create: `src/types.ts`, `src/epub.ts`, `src/epub-css.ts`, `tests/epub.test.ts`

**Interfaces:**
- Consumes: `EPUB_CSS` string constant
- Produces:
  - `interface ExportMeta { title: string; author: string; language: string; coverBytes?: Uint8Array; coverExt?: "jpg" | "png"; }` (in `types.ts`)
  - `chapterHref(index: number): string` → `"text/chapter_001.xhtml"` for index 0
  - `class EpubBuilder { constructor(meta: ExportMeta); addChapter(title: string, xhtmlBody: string): string; addAsset(href: string, bytes: Uint8Array, mediaType: string): void; build(): Promise<Uint8Array>; }`
  - `escapeXml(s: string): string`

- [ ] **Step 1: Write failing tests (container invariants)**

`tests/epub.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/epub.test.ts`
Expected: FAIL — cannot resolve `../src/epub`.

- [ ] **Step 3: Implement types, base css, builder**

`src/types.ts`:
```ts
export interface ExportMeta {
  title: string;
  author: string;
  language: string;
  coverBytes?: Uint8Array;
  coverExt?: "jpg" | "png";
}

export interface ExportUnit {
  path: string;      // vault-relative path of the source note
  title: string;     // chapter title
  markdown: string;  // raw note body
}

export interface ExportJob {
  meta: ExportMeta;
  units: ExportUnit[];
  warnings: string[];
}
```

`src/epub-css.ts` (working base; Pan restyles in Task 11):
```ts
// Stylesheet embedded in every generated EPUB. Keep e-ink friendly:
// high contrast, no color-dependent meaning, generous line height for Thai.
export const EPUB_CSS = `
body { line-height: 1.7; margin: 0 0.4em; }
h1, h2, h3 { line-height: 1.3; page-break-after: avoid; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; word-wrap: break-word; font-size: 0.85em; border: 1px solid #888; padding: 0.5em; }
code { font-family: monospace; }
blockquote { border-left: 3px solid #555; margin-left: 0; padding-left: 1em; }
table { border-collapse: collapse; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; }
/* Obsidian callouts arrive as div.callout with div.callout-title / div.callout-content */
.callout { border: 1px solid #555; padding: 0.5em 0.8em; margin: 1em 0; }
.callout-title { font-weight: bold; }
.omitted { color: #555; font-style: italic; }
/* ── PAN (Task 11): tune the reading experience for your Boox below ── */
`;
```

`src/epub.ts`:
```ts
import JSZip from "jszip";
import { EPUB_CSS } from "./epub-css";
import type { ExportMeta } from "./types";

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function chapterHref(index: number): string {
  return `text/chapter_${String(index + 1).padStart(3, "0")}.xhtml`;
}

interface Chapter { id: string; href: string; title: string; body: string; }
interface Asset { href: string; bytes: Uint8Array; mediaType: string; }

export class EpubBuilder {
  private chapters: Chapter[] = [];
  private assets: Asset[] = [];

  constructor(private meta: ExportMeta) {}

  addChapter(title: string, xhtmlBody: string): string {
    const index = this.chapters.length;
    const href = chapterHref(index);
    this.chapters.push({ id: `ch_${String(index + 1).padStart(3, "0")}`, href, title, body: xhtmlBody });
    return href;
  }

  addAsset(href: string, bytes: Uint8Array, mediaType: string): void {
    this.assets.push({ href, bytes, mediaType });
  }

  async build(): Promise<Uint8Array> {
    const zip = new JSZip();
    // Spec: mimetype must be the FIRST entry and stored uncompressed.
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", this.containerXml());
    if (this.meta.coverBytes && this.meta.coverExt) {
      zip.file(`OEBPS/images/cover.${this.meta.coverExt}`, this.meta.coverBytes);
    }
    zip.file("OEBPS/package.opf", this.opf());
    zip.file("OEBPS/nav.xhtml", this.nav());
    zip.file("OEBPS/style/epub.css", EPUB_CSS);
    for (const ch of this.chapters) zip.file(`OEBPS/${ch.href}`, this.chapterDoc(ch));
    for (const a of this.assets) zip.file(`OEBPS/${a.href}`, a.bytes);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  private containerXml(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  }

  private opf(): string {
    const m = this.meta;
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const coverItem = m.coverBytes && m.coverExt
      ? `<item id="cover-image" href="images/cover.${m.coverExt}" media-type="image/${m.coverExt === "jpg" ? "jpeg" : "png"}" properties="cover-image"/>`
      : "";
    const coverMeta = coverItem ? `<meta name="cover" content="cover-image"/>` : "";
    const items = this.chapters
      .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
      .concat(this.assets.map((a, i) => `<item id="asset_${i}" href="${a.href}" media-type="${a.mediaType}"/>`))
      .join("\n    ");
    const spine = this.chapters.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ");
    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${cryptoRandomUuid()}</dc:identifier>
    <dc:title>${escapeXml(m.title)}</dc:title>
    <dc:language>${escapeXml(m.language)}</dc:language>
    <dc:creator>${escapeXml(m.author)}</dc:creator>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style/epub.css" media-type="text/css"/>
    ${coverItem}
    ${items}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  }

  private nav(): string {
    const lis = this.chapters
      .map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`)
      .join("\n        ");
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(this.meta.title)}</title></head>
  <body>
    <nav epub:type="toc">
      <h1>${escapeXml(this.meta.title)}</h1>
      <ol>
        ${lis}
      </ol>
    </nav>
  </body>
</html>`;
  }

  private chapterDoc(ch: Chapter): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(ch.title)}</title>
    <link rel="stylesheet" type="text/css" href="../style/epub.css"/>
  </head>
  <body>
${ch.body}
  </body>
</html>`;
  }
}

function cryptoRandomUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID ? g.crypto.randomUUID() : `${Date.now()}-epub-export`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/epub.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/epub.ts src/epub-css.ts tests/epub.test.ts
git commit -m "feat: hand-rolled EPUB 3 builder with cover, nav, and base e-ink css"
```

---

### Task 4: `collect.ts` — chapter ordering, index detection, link BFS

**Files:**
- Create: `src/collect.ts`, `tests/collect.test.ts`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `orderChapters(basenames: string[]): string[]` — `NN_` prefixed numerically first, rest alphabetical after
  - `pickIndexNote(candidates: { basename: string; tags: string[] }[], folderName: string): string | null`
  - `bfsLinked(links: Record<string, Record<string, number>>, start: string, depth: number): string[]` — ordered `[start, …]`, `.md` targets only, deduplicated

- [ ] **Step 1: Write failing tests**

`tests/collect.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { orderChapters, pickIndexNote, bfsLinked } from "../src/collect";

describe("orderChapters", () => {
  it("sorts NN_ prefixes numerically, then others alphabetically", () => {
    expect(orderChapters(["10_ten", "02_two", "appendix", "01_one", "afterword"]))
      .toEqual(["01_one", "02_two", "10_ten", "afterword", "appendix"]);
  });
});

describe("pickIndexNote", () => {
  it("prefers the note tagged book+main", () => {
    const c = [
      { basename: "01_intro", tags: [] },
      { basename: "my_book", tags: ["book", "main"] },
    ];
    expect(pickIndexNote(c, "other_name")).toBe("my_book");
  });
  it("falls back to basename === folder name", () => {
    const c = [{ basename: "lgwt", tags: [] }, { basename: "01_intro", tags: [] }];
    expect(pickIndexNote(c, "lgwt")).toBe("lgwt");
  });
  it("returns null when nothing matches", () => {
    expect(pickIndexNote([{ basename: "01_x", tags: [] }], "folder")).toBeNull();
  });
});

describe("bfsLinked", () => {
  const links = {
    "a.md": { "b.md": 1, "c.md": 2, "img.png": 1 },
    "b.md": { "d.md": 1, "a.md": 1 },
    "c.md": { "e.md": 1 },
  };
  it("depth 1 returns start plus direct md links, sorted per level", () => {
    expect(bfsLinked(links, "a.md", 1)).toEqual(["a.md", "b.md", "c.md"]);
  });
  it("depth 2 adds the next ring without revisiting", () => {
    expect(bfsLinked(links, "a.md", 2)).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
  });
  it("depth 0 or missing start yields just the start", () => {
    expect(bfsLinked(links, "z.md", 3)).toEqual(["z.md"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/collect.test.ts`
Expected: FAIL — cannot resolve `../src/collect`.

- [ ] **Step 3: Implement**

`src/collect.ts`:
```ts
const NN = /^(\d+)_/;

export function orderChapters(basenames: string[]): string[] {
  const numbered = basenames.filter((b) => NN.test(b));
  const rest = basenames.filter((b) => !NN.test(b));
  numbered.sort((a, b) => parseInt(NN.exec(a)![1], 10) - parseInt(NN.exec(b)![1], 10));
  rest.sort((a, b) => a.localeCompare(b));
  return [...numbered, ...rest];
}

export function pickIndexNote(
  candidates: { basename: string; tags: string[] }[],
  folderName: string
): string | null {
  const tagged = candidates.find((c) => c.tags.includes("book") && c.tags.includes("main"));
  if (tagged) return tagged.basename;
  const named = candidates.find((c) => c.basename === folderName);
  return named ? named.basename : null;
}

export function bfsLinked(
  links: Record<string, Record<string, number>>,
  start: string,
  depth: number
): string[] {
  const seen = new Set<string>([start]);
  const out: string[] = [start];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of Object.keys(links[node] ?? {})) {
        if (!target.endsWith(".md") || seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    next.sort((a, b) => a.localeCompare(b));
    out.push(...next);
    frontier = next;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/collect.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/collect.ts tests/collect.test.ts && git commit -m "feat: chapter ordering, index-note detection, depth-limited link BFS"
```

---

### Task 5: `render.ts` — markdown preprocess + DOM cleanup/rewrite pipeline

**Files:**
- Create: `src/render.ts`, `tests/render.test.ts`

**Interfaces:**
- Consumes: nothing for the pure helpers; Obsidian API only inside `renderUnitToChapter` (not unit-tested)
- Produces (pure, all exported):
  - `stripFrontmatter(md: string): string`
  - `stripDynamicBlocks(md: string): string` — dataview/dataviewjs fences → `*[dynamic content omitted]*`
  - `cleanupDom(root: HTMLElement): void` — removes Obsidian UI chrome, converts checkboxes to ☐/☑ text, replaces unrendered `span.internal-embed`/`div.internal-embed` with `<p class="omitted">[embedded content omitted: NAME]</p>`
  - `rewriteLinks(root: HTMLElement, hrefByPath: Map<string, string>, resolve: (linkpath: string) => string | null): string[]` — returns warnings
  - `rewriteImages(root: HTMLElement, basePath: string): { vaultPath: string; newHref: string }[]` — rewrites `<img src>` from `app://…` resource URLs to `../images/img_NNN.<ext>`, returns what to load
  - `serializeBody(root: HTMLElement): string` — XMLSerializer output of children
  - `renderUnitToChapter(...)` adapter added in Task 7 (needs the plugin instance)

- [ ] **Step 1: Write failing tests**

`tests/render.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  stripFrontmatter, stripDynamicBlocks, cleanupDom,
  rewriteLinks, rewriteImages, serializeBody,
} from "../src/render";

function div(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("stripFrontmatter", () => {
  it("removes a leading yaml block", () => {
    expect(stripFrontmatter("---\ntags: [x]\n---\n# Hi")).toBe("# Hi");
  });
  it("leaves body-only notes alone", () => {
    expect(stripFrontmatter("# Hi\n---\nrule")).toBe("# Hi\n---\nrule");
  });
});

describe("stripDynamicBlocks", () => {
  it("replaces dataview fences", () => {
    const md = "before\n```dataview\nLIST\n```\nafter";
    expect(stripDynamicBlocks(md)).toBe("before\n*[dynamic content omitted]*\nafter");
  });
  it("replaces dataviewjs fences too", () => {
    expect(stripDynamicBlocks("```dataviewjs\ndv.list()\n```")).toBe("*[dynamic content omitted]*");
  });
});

describe("cleanupDom", () => {
  it("strips Obsidian UI chrome", () => {
    const el = div('<div class="edit-block-button">e</div><button class="copy-code-button">c</button><p>keep</p>');
    cleanupDom(el);
    expect(el.querySelector(".edit-block-button")).toBeNull();
    expect(el.querySelector(".copy-code-button")).toBeNull();
    expect(el.querySelector("p")?.textContent).toBe("keep");
  });
  it("converts checkboxes to glyphs", () => {
    const el = div('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>');
    cleanupDom(el);
    expect(el.querySelectorAll("input").length).toBe(0);
    expect(el.textContent).toContain("☑");
    expect(el.textContent).toContain("☐");
  });
  it("replaces unrendered embeds with an omission marker", () => {
    const el = div('<span class="internal-embed" src="drawing.excalidraw">x</span>');
    cleanupDom(el);
    expect(el.querySelector("span.internal-embed")).toBeNull();
    expect(el.textContent).toContain("[embedded content omitted: drawing.excalidraw]");
  });
});

describe("rewriteLinks", () => {
  const resolve = (lp: string) => (lp === "Chapter Two" ? "book/02_two.md" : null);
  it("links inside the export set become chapter hrefs", () => {
    const el = div('<a class="internal-link" data-href="Chapter Two" href="Chapter Two">next</a>');
    const map = new Map([["book/02_two.md", "text/chapter_002.xhtml"]]);
    const warnings = rewriteLinks(el, map, resolve);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("chapter_002.xhtml");
    expect(warnings).toEqual([]);
  });
  it("links outside the set degrade to spans keeping text", () => {
    const el = div('<a class="internal-link" data-href="Elsewhere" href="Elsewhere">see this</a>');
    const warnings = rewriteLinks(el, new Map(), resolve);
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("see this");
    expect(warnings.length).toBe(0);
  });
  it("external links are left untouched", () => {
    const el = div('<a href="https://example.com">ext</a>');
    rewriteLinks(el, new Map(), resolve);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });
});

describe("rewriteImages", () => {
  it("maps app:// resource srcs to sequential internal hrefs", () => {
    const base = "/Users/pan/vault";
    const el = div(
      `<img src="app://abc123${base}/05.%20assets/pic%20one.png?1699"><img src="https://x.com/y.jpg">`
    );
    const found = rewriteImages(el, base);
    expect(found).toEqual([
      { vaultPath: "05. assets/pic one.png", newHref: "../images/img_001.png" },
    ]);
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("../images/img_001.png");
    expect(imgs[1].getAttribute("src")).toBe("https://x.com/y.jpg");
  });
});

describe("serializeBody", () => {
  it("emits self-closed XHTML", () => {
    const el = div("<p>a<br>b</p>");
    expect(serializeBody(el)).toContain("<br/>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — cannot resolve `../src/render`.

- [ ] **Step 3: Implement**

`src/render.ts`:
```ts
const CHROME_SELECTORS = [
  ".edit-block-button", ".copy-code-button", ".collapse-indicator",
  ".markdown-preview-pusher", ".mod-frontmatter", ".frontmatter",
  ".metadata-container",
];

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function stripDynamicBlocks(md: string): string {
  return md.replace(/```dataview(js)?\r?\n[\s\S]*?```/g, "*[dynamic content omitted]*");
}

export function cleanupDom(root: HTMLElement): void {
  for (const sel of CHROME_SELECTORS) root.querySelectorAll(sel).forEach((n) => n.remove());
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const glyph = (input as HTMLInputElement).checked ? "☑ " : "☐ ";
    input.replaceWith(document.createTextNode(glyph));
  });
  root.querySelectorAll("span.internal-embed, div.internal-embed").forEach((embed) => {
    const name = embed.getAttribute("src") ?? "unknown";
    const p = document.createElement("p");
    p.className = "omitted";
    p.textContent = `[embedded content omitted: ${name}]`;
    embed.replaceWith(p);
  });
}

export function rewriteLinks(
  root: HTMLElement,
  hrefByPath: Map<string, string>,
  resolve: (linkpath: string) => string | null
): string[] {
  const warnings: string[] = [];
  root.querySelectorAll("a").forEach((a) => {
    const dataHref = a.getAttribute("data-href");
    const isInternal = a.classList.contains("internal-link") || dataHref !== null;
    if (!isInternal) return; // external link: leave untouched
    const targetPath = dataHref ? resolve(dataHref) : null;
    const chapter = targetPath ? hrefByPath.get(targetPath) : undefined;
    if (chapter) {
      // Chapters live side by side in text/, so link by filename only.
      a.setAttribute("href", chapter.replace(/^text\//, ""));
      a.removeAttribute("data-href");
      a.removeAttribute("class");
      a.removeAttribute("target");
      a.removeAttribute("rel");
    } else {
      const span = document.createElement("span");
      span.textContent = a.textContent ?? "";
      a.replaceWith(span);
    }
  });
  return warnings;
}

export function rewriteImages(
  root: HTMLElement,
  basePath: string
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("app://")) return; // remote or already-rewritten images pass through
    const noQuery = src.split("?")[0];
    const decoded = decodeURIComponent(noQuery);
    const at = decoded.indexOf(basePath);
    if (at === -1) return;
    const vaultPath = decoded.slice(at + basePath.length).replace(/^\//, "");
    const extMatch = /\.(\w+)$/.exec(vaultPath);
    const ext = extMatch ? extMatch[1].toLowerCase() : "png";
    const newHref = `../images/img_${String(found.length + 1).padStart(3, "0")}.${ext}`;
    found.push({ vaultPath, newHref });
    img.setAttribute("src", newHref);
    if (!img.getAttribute("alt")) img.setAttribute("alt", "");
  });
  return found;
}

export function serializeBody(root: HTMLElement): string {
  const s = new XMLSerializer();
  return Array.from(root.childNodes).map((n) => s.serializeToString(n)).join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render.ts tests/render.test.ts && git commit -m "feat: markdown preprocess and DOM cleanup/rewrite pipeline for XHTML chapters"
```

---

### Task 6: `booxdrop.ts` — multipart builder + LAN client

**Files:**
- Create: `src/booxdrop.ts`, `tests/booxdrop.test.ts`

**Interfaces:**
- Consumes: nothing (HTTP function injected)
- Produces:
  - `buildMultipart(boundary: string, filename: string, data: Uint8Array): Uint8Array`
  - `type HttpFn = (req: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer; throw?: boolean }) => Promise<{ status: number }>`
  - `class BooxDropClient { constructor(baseUrl: string, http: HttpFn); testConnection(): Promise<boolean>; push(filename: string, data: Uint8Array): Promise<void>; }`
  - `UPLOAD_PATH` constant — ships as `"/api/std/upload"` (community-documented default); **verified against the real device in Task 10 and corrected there if the probe disagrees**

- [ ] **Step 1: Write failing tests**

`tests/booxdrop.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildMultipart, BooxDropClient, UPLOAD_PATH } from "../src/booxdrop";

describe("buildMultipart", () => {
  it("lays out headers, binary payload, and closing boundary", () => {
    const data = new Uint8Array([1, 2, 3]);
    const bytes = buildMultipart("BB", "b.epub", data);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("--BB\r\n")).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="b.epub"');
    expect(text).toContain("Content-Type: application/epub+zip\r\n\r\n");
    expect(text.endsWith("\r\n--BB--\r\n")).toBe(true);
    expect(Array.from(bytes).join(",")).toContain("1,2,3");
  });
});

describe("BooxDropClient", () => {
  it("testConnection is true on 200 and false on network error", async () => {
    const ok = new BooxDropClient("http://boox:8085", async () => ({ status: 200 }));
    const bad = new BooxDropClient("http://boox:8085", async () => { throw new Error("refused"); });
    expect(await ok.testConnection()).toBe(true);
    expect(await bad.testConnection()).toBe(false);
  });

  it("push POSTs multipart bytes to the upload path", async () => {
    const calls: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }[] = [];
    const client = new BooxDropClient("http://boox:8085/", async (req) => {
      calls.push(req);
      return { status: 200 };
    });
    await client.push("x.epub", new Uint8Array([9]));
    expect(calls[0].url).toBe(`http://boox:8085${UPLOAD_PATH}`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers?.["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(new Uint8Array(calls[0].body!).length).toBeGreaterThan(50);
  });

  it("push throws with status text on non-2xx", async () => {
    const client = new BooxDropClient("http://boox:8085", async () => ({ status: 500 }));
    await expect(client.push("x.epub", new Uint8Array([9]))).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/booxdrop.test.ts`
Expected: FAIL — cannot resolve `../src/booxdrop`.

- [ ] **Step 3: Implement**

`src/booxdrop.ts`:
```ts
// The ONLY module that knows BooxDrop's unofficial HTTP API.
// Default path is the community-documented endpoint; Task 10 verifies it
// against the real device (firmware differences land here and only here).
export const UPLOAD_PATH = "/api/std/upload";

export type HttpFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}) => Promise<{ status: number }>;

export function buildMultipart(boundary: string, filename: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/epub+zip\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

export class BooxDropClient {
  private base: string;

  constructor(baseUrl: string, private http: HttpFn) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await this.http({ url: this.base + "/", method: "GET", throw: false });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  async push(filename: string, data: Uint8Array): Promise<void> {
    const boundary = "----epubexport" + Math.random().toString(36).slice(2);
    const body = buildMultipart(boundary, filename, data);
    const res = await this.http({
      url: this.base + UPLOAD_PATH,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`BooxDrop upload failed with status ${res.status}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/booxdrop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/booxdrop.ts tests/booxdrop.test.ts && git commit -m "feat: BooxDrop LAN client with hand-built multipart upload"
```

---

### Task 7: `settings.ts` + `main.ts` — settings tab, commands, menus, orchestrator

**Files:**
- Create: `src/settings.ts`, `tests/settings.test.ts`
- Modify: `src/main.ts` (replace the Task 1 stub entirely)
- Modify: `src/render.ts` (append the `renderUnitToChapter` adapter at the end)

**Interfaces:**
- Consumes: everything produced by Tasks 2–6
- Produces:
  - `interface EpubExportSettings { outputFolder: string; linkDepth: number; language: string; fallbackAuthor: string; booxUrl: string; pushAfterExport: boolean; }` + `DEFAULT_SETTINGS`
  - `resolveOutputPath(outputFolder: string, slug: string, homedir: string): string` (pure)
  - `summarizeWarnings(warnings: string[]): string | null` (pure)
  - Commands: `export-note`, `export-folder`, `export-linked`; file & folder context-menu items

- [ ] **Step 1: Write failing tests for the pure helpers**

`tests/settings.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveOutputPath, summarizeWarnings, DEFAULT_SETTINGS } from "../src/settings";

describe("resolveOutputPath", () => {
  it("expands empty folder to ~/Downloads", () => {
    expect(resolveOutputPath("", "my_book", "/Users/pan")).toBe("/Users/pan/Downloads/my_book.epub");
  });
  it("expands leading tilde", () => {
    expect(resolveOutputPath("~/books", "x", "/Users/pan")).toBe("/Users/pan/books/x.epub");
  });
  it("keeps absolute paths", () => {
    expect(resolveOutputPath("/tmp/out", "x", "/Users/pan")).toBe("/tmp/out/x.epub");
  });
});

describe("summarizeWarnings", () => {
  it("is null when there are no warnings", () => {
    expect(summarizeWarnings([])).toBeNull();
  });
  it("counts warnings and points at the console", () => {
    expect(summarizeWarnings(["a", "b"])).toBe("Exported with 2 warnings — details in developer console.");
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("matches the spec defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      outputFolder: "", linkDepth: 1, language: "th",
      fallbackAuthor: "", booxUrl: "", pushAfterExport: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — cannot resolve `../src/settings`.

- [ ] **Step 3: Implement settings module**

`src/settings.ts`:
```ts
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type EpubExportPlugin from "./main";
import { BooxDropClient } from "./booxdrop";
import { obsidianHttp } from "./main";

export interface EpubExportSettings {
  outputFolder: string;
  linkDepth: number;
  language: string;
  fallbackAuthor: string;
  booxUrl: string;
  pushAfterExport: boolean;
}

export const DEFAULT_SETTINGS: EpubExportSettings = {
  outputFolder: "",
  linkDepth: 1,
  language: "th",
  fallbackAuthor: "",
  booxUrl: "",
  pushAfterExport: false,
};

export function resolveOutputPath(outputFolder: string, slug: string, homedir: string): string {
  let folder = outputFolder.trim();
  if (folder === "") folder = `${homedir}/Downloads`;
  else if (folder.startsWith("~/")) folder = homedir + folder.slice(1);
  return `${folder.replace(/\/+$/, "")}/${slug}.epub`;
}

export function summarizeWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  return `Exported with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — details in developer console.`;
}

export class EpubExportSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: EpubExportPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Absolute path or ~/…; empty = ~/Downloads. Existing .epub files are overwritten.")
      .addText((t) => t.setValue(s.outputFolder).onChange((v) => { s.outputFolder = v; save(); }));

    new Setting(containerEl)
      .setName("Default link depth")
      .setDesc("How far 'note + linked notes' follows wikilinks (1–3).")
      .addSlider((sl) => sl.setLimits(1, 3, 1).setValue(s.linkDepth).setDynamicTooltip()
        .onChange((v) => { s.linkDepth = v; save(); }));

    new Setting(containerEl)
      .setName("Language (dc:language)")
      .addText((t) => t.setValue(s.language).onChange((v) => { s.language = v || "th"; save(); }));

    new Setting(containerEl)
      .setName("Fallback author")
      .setDesc("Used when a note/folder has no author frontmatter.")
      .addText((t) => t.setValue(s.fallbackAuthor).onChange((v) => { s.fallbackAuthor = v; save(); }));

    containerEl.createEl("h3", { text: "BooxDrop" });

    new Setting(containerEl)
      .setName("Device URL")
      .setDesc("Shown on the Boox in the BooxDrop app, e.g. http://192.168.1.42:8085")
      .addText((t) => t.setPlaceholder("http://192.168.1.42:8085")
        .setValue(s.booxUrl).onChange((v) => { s.booxUrl = v.trim(); save(); }));

    new Setting(containerEl)
      .setName("Push after export")
      .addToggle((tg) => tg.setValue(s.pushAfterExport).onChange((v) => { s.pushAfterExport = v; save(); }));

    new Setting(containerEl)
      .setName("Test connection")
      .addButton((b) => b.setButtonText("Test").onClick(async () => {
        if (!s.booxUrl) { new Notice("Set the device URL first."); return; }
        const ok = await new BooxDropClient(s.booxUrl, obsidianHttp).testConnection();
        new Notice(ok ? "BooxDrop reachable ✓" : "BooxDrop NOT reachable — check Wi-Fi, IP, and that BooxDrop is open on the device.");
      }));
  }
}
```

- [ ] **Step 4: Run settings tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS (6 tests). (The obsidian imports are fine: vitest never loads them because the tested helpers live above the class, but if module resolution complains, move `resolveOutputPath`/`summarizeWarnings`/`DEFAULT_SETTINGS`/the interface into `src/settings-core.ts` with `settings.ts` re-exporting them, and update the test import to `../src/settings-core`.)

- [ ] **Step 5: Append the render adapter to `src/render.ts`**

```ts
// ── Obsidian adapter (exercised via manual smoke tests, not unit tests) ──
import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { stripFrontmatter as _sf } from "./render";

export interface ChapterRender {
  xhtmlBody: string;
  images: { vaultPath: string; newHref: string }[];
  warnings: string[];
}

export async function renderUnitToChapter(
  app: App,
  component: Component,
  markdown: string,
  sourcePath: string,
  hrefByPath: Map<string, string>,
  basePath: string
): Promise<ChapterRender> {
  const warnings: string[] = [];
  const md = stripDynamicBlocks(stripFrontmatter(markdown));
  const el = document.createElement("div");
  document.body.appendChild(el);
  try {
    await MarkdownRenderer.render(app, md, el, sourcePath, component);
    cleanupDom(el);
    const resolve = (linkpath: string): string | null => {
      const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      return f instanceof TFile ? f.path : null;
    };
    warnings.push(...rewriteLinks(el, hrefByPath, resolve));
    const images = rewriteImages(el, basePath);
    return { xhtmlBody: serializeBody(el), images, warnings };
  } finally {
    el.remove();
  }
}
```
(Note: the adapter calls the pure functions defined earlier in the same file — no self-import needed; drop the `import { stripFrontmatter as _sf }` line, it is shown only to flag that these are the same-file functions.)

- [ ] **Step 6: Replace `src/main.ts` with the full plugin**

```ts
import {
  FileSystemAdapter, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl,
} from "obsidian";
import { promises as fs } from "fs";
import { homedir } from "os";
import { EpubBuilder, chapterHref } from "./epub";
import { orderChapters, pickIndexNote, bfsLinked } from "./collect";
import { renderUnitToChapter } from "./render";
import { slugify, deriveChapterTitle } from "./naming";
import { BooxDropClient, HttpFn } from "./booxdrop";
import {
  DEFAULT_SETTINGS, EpubExportSettings, EpubExportSettingTab,
  resolveOutputPath, summarizeWarnings,
} from "./settings";
import type { ExportMeta } from "./types";

export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  return { status: res.status };
};

interface Job {
  meta: ExportMeta;
  files: TFile[]; // chapter order
}

export default class EpubExportPlugin extends Plugin {
  settings: EpubExportSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new EpubExportSettingTab(this.app, this));

    this.addCommand({
      id: "export-note", name: "Export note to EPUB",
      callback: () => this.withActiveFile((f) => this.exportSingle(f)),
    });
    this.addCommand({
      id: "export-folder", name: "Export folder as EPUB (active note's folder)",
      callback: () => this.withActiveFile((f) => f.parent instanceof TFolder
        ? this.exportFolder(f.parent)
        : new Notice("Active note has no parent folder.")),
    });
    this.addCommand({
      id: "export-linked", name: "Export note + linked notes to EPUB",
      callback: () => this.withActiveFile((f) => this.exportLinked(f)),
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === "md") {
        menu.addItem((i) => i.setTitle("Export note to EPUB").setIcon("book")
          .onClick(() => this.exportSingle(file)));
        menu.addItem((i) => i.setTitle("Export note + linked notes to EPUB").setIcon("book")
          .onClick(() => this.exportLinked(file)));
      }
      if (file instanceof TFolder) {
        menu.addItem((i) => i.setTitle("Export folder as EPUB").setIcon("book")
          .onClick(() => this.exportFolder(file)));
      }
    }));
  }

  private withActiveFile(fn: (f: TFile) => void) {
    const f = this.app.workspace.getActiveFile();
    if (f) fn(f); else new Notice("No active note.");
  }

  // ── scope builders ──────────────────────────────────────────────

  private titleFor(f: TFile): string {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const aliases: string[] | undefined = Array.isArray(fm?.aliases) ? fm.aliases : undefined;
    const h1 = this.app.metadataCache.getFileCache(f)?.headings?.find((h) => h.level === 1)?.heading;
    return deriveChapterTitle(f.basename, aliases, h1);
  }

  private baseMeta(title: string, author?: string): ExportMeta {
    return {
      title,
      author: author || this.settings.fallbackAuthor || "Unknown",
      language: this.settings.language || "th",
    };
  }

  async exportSingle(file: TFile) {
    await this.runExport({ meta: this.baseMeta(this.titleFor(file)), files: [file] });
  }

  async exportLinked(file: TFile) {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    await this.runExport({ meta: this.baseMeta(this.titleFor(file)), files });
  }

  async exportFolder(folder: TFolder) {
    const mdFiles = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
    if (mdFiles.length === 0) { new Notice("Folder has no markdown notes."); return; }

    const candidates = mdFiles.map((f) => ({
      basename: f.basename,
      tags: (this.app.metadataCache.getFileCache(f)?.frontmatter?.tags ?? []) as string[],
    }));
    const indexName = pickIndexNote(candidates, folder.name);
    const index = mdFiles.find((f) => f.basename === indexName) ?? null;

    const chapterNames = orderChapters(mdFiles.filter((f) => f !== index).map((f) => f.basename));
    const files = chapterNames.map((n) => mdFiles.find((f) => f.basename === n)!);
    if (index) files.unshift(index);

    const fm = index ? this.app.metadataCache.getFileCache(index)?.frontmatter : undefined;
    const meta = this.baseMeta(index ? this.titleFor(index) : folder.name, fm?.author);
    if (typeof fm?.coverUrl === "string" && fm.coverUrl.startsWith("http")) {
      try {
        const res = await requestUrl({ url: fm.coverUrl, throw: false });
        if (res.status === 200) {
          const isPng = (res.headers["content-type"] ?? "").includes("png");
          meta.coverBytes = new Uint8Array(res.arrayBuffer);
          meta.coverExt = isPng ? "png" : "jpg";
        }
      } catch { /* cover failure degrades to coverless export (spec) */ }
    }
    await this.runExport({ meta, files });
  }

  // ── orchestrator ────────────────────────────────────────────────

  async runExport(job: Job) {
    const warnings: string[] = [];
    try {
      const notice = new Notice(`Exporting "${job.meta.title}"…`, 0);
      const adapter = this.app.vault.adapter;
      const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

      const hrefByPath = new Map(job.files.map((f, i) => [f.path, chapterHref(i)]));
      const builder = new EpubBuilder(job.meta);
      let imageCount = 0;

      for (const file of job.files) {
        try {
          const md = await this.app.vault.cachedRead(file);
          const r = await renderUnitToChapter(this.app, this, md, file.path, hrefByPath, basePath);
          warnings.push(...r.warnings);
          for (const img of r.images) {
            const af = this.app.vault.getAbstractFileByPath(img.vaultPath);
            if (af instanceof TFile) {
              const bytes = new Uint8Array(await this.app.vault.readBinary(af));
              const ext = img.newHref.split(".").pop()!;
              const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
                : ext === "svg" ? "image/svg+xml" : ext === "gif" ? "image/gif"
                : ext === "webp" ? "image/webp" : "image/png";
              builder.addAsset(img.newHref.replace(/^\.\.\//, ""), bytes, mediaType);
              imageCount++;
            } else {
              warnings.push(`missing image: ${img.vaultPath} (referenced by ${file.path})`);
            }
          }
          builder.addChapter(this.titleFor(file), r.xhtmlBody);
        } catch (e) {
          warnings.push(`chapter skipped: ${file.path} — ${String(e)}`);
        }
      }

      const bytes = await builder.build();
      const outPath = resolveOutputPath(this.settings.outputFolder, slugify(job.meta.title), homedir());
      await fs.mkdir(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(outPath, bytes); // save ALWAYS precedes push (spec)
      notice.hide();

      let pushMsg = "";
      if (this.settings.pushAfterExport && this.settings.booxUrl) {
        try {
          await new BooxDropClient(this.settings.booxUrl, obsidianHttp)
            .push(outPath.split("/").pop()!, bytes);
          pushMsg = " and pushed to Boox ✓";
        } catch (e) {
          pushMsg = ` — saved locally, push failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      warnings.forEach((w) => console.warn("[epub-export]", w));
      const warnMsg = summarizeWarnings(warnings);
      new Notice(`EPUB saved to ${outPath}${pushMsg}${warnMsg ? `\n${warnMsg}` : ""}`, 8000);
    } catch (e) {
      console.error("[epub-export] export failed", e);
      new Notice(`EPUB export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}
```

- [ ] **Step 7: Full test suite + build**

Run: `npm test && npm run build`
Expected: all suites PASS; `main.js` builds with no TypeScript/esbuild errors.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: settings tab, commands, context menus, and export orchestrator"
```

---

### Task 8: Deploy + manual smoke test in the real vault

**Files:** none created — verification task.

**Interfaces:**
- Consumes: `npm run deploy` from Task 1; full plugin from Task 7
- Produces: a confirmed-working single-note export on this machine

- [ ] **Step 1: Deploy and enable**

Run: `npm run deploy`
Then in Obsidian: Settings → Community plugins → refresh installed list → enable **EPUB Export**. (First time only: community plugins must already be enabled — they are, 17 are active.)

- [ ] **Step 2: Manual smoke checklist (single note)**

- Open any mid-sized note with an image and a wikilink.
- Run command palette → "Export note to EPUB".
- Expected Notice: `EPUB saved to ~/Downloads/<slug>.epub`.
- Open the file in macOS Books.app: title correct, Thai text renders, image visible, external links clickable, no raw HTML artifacts.
- Developer console (Cmd-Opt-I): no `[epub-export]` errors; warnings only where expected.

- [ ] **Step 3: Fix-and-redeploy loop**

Any rendering defect found → reproduce it as a jsdom unit test in `tests/render.test.ts` first, fix, `npm test`, `npm run deploy`, re-check. Commit each fix as `fix: <symptom>`.

- [ ] **Step 4: Commit (if fixes were made) and tag the milestone**

```bash
git add -A && git commit -m "fix: smoke-test findings from first vault deploy" || true
```

---

### Task 9: epubcheck validation script

**Files:**
- Create: `scripts/build-sample.ts`

**Interfaces:**
- Consumes: `EpubBuilder` from Task 3
- Produces: `npm run epubcheck` (script added to package.json) generating `sample.epub` and validating it when epubcheck is installed

- [ ] **Step 1: Write the sample generator**

`scripts/build-sample.ts`:
```ts
import { writeFileSync } from "fs";
import { EpubBuilder } from "../src/epub";

const b = new EpubBuilder({ title: "ตัวอย่าง Sample", author: "Pan", language: "th" });
b.addChapter("บทที่หนึ่ง", "<h1>บทที่หนึ่ง</h1><p>Thai + <em>English</em> mixed.</p>");
b.addChapter("Code", "<pre><code>fmt.Println(\"hi\")</code></pre>");
b.build().then((bytes) => {
  writeFileSync("sample.epub", bytes);
  console.log("wrote sample.epub", bytes.length, "bytes");
});
```

Add to `package.json` scripts:
```json
"epubcheck": "tsx scripts/build-sample.ts && (command -v epubcheck >/dev/null && epubcheck sample.epub || echo 'epubcheck not installed — brew install epubcheck to validate')"
```

- [ ] **Step 2: Run it**

Run: `brew install epubcheck` (once; requires Java — if Java is unavailable, the script's fallback message is acceptable and Books.app + Boox rendering remain the practical gates), then `npm run epubcheck`
Expected: `No errors or warnings detected.` If epubcheck reports errors, fix `epub.ts` templates, re-run `npm test`, re-run epubcheck.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: epubcheck validation script with generated sample"
```

---

### Task 10: BooxDrop device probe + live push (interactive — needs Pan + the Boox)

**Files:**
- Modify: `src/booxdrop.ts` (only if the probe contradicts `UPLOAD_PATH` or the field layout)
- Create: `docs/booxdrop-probe.md` (findings record)

**Interfaces:**
- Consumes: `BooxDropClient`, `UPLOAD_PATH` from Task 6
- Produces: verified endpoint constants + a documented probe procedure for future firmware updates

- [ ] **Step 1: Probe the device (Pan assists)**

With the Boox on the same Wi-Fi and BooxDrop open (it shows a URL like `http://192.168.x.x:8085`):

```bash
curl -sv "http://<device-ip>:8085/" -o /dev/null 2>&1 | grep "HTTP/"
printf 'probe' > /tmp/probe.txt
curl -sv -F "file=@/tmp/probe.txt" "http://<device-ip>:8085/api/std/upload"
```

If the upload 404s: open `http://<device-ip>:8085` in a desktop browser, upload a file through the web UI with DevTools → Network open, and record the real request (path, method, form field names, any auth header/cookie).

- [ ] **Step 2: Record findings and align the client**

Write `docs/booxdrop-probe.md`: firmware version, working endpoint, field names, sample response body. Update `UPLOAD_PATH`/`buildMultipart` field name if needed; update `tests/booxdrop.test.ts` expectations to match reality; `npm test`.

- [ ] **Step 3: Live round-trip**

In Obsidian settings: set device URL → **Test connection** → expect "reachable ✓". Enable "Push after export", export a note, expect Notice `…and pushed to Boox ✓`, and the file to appear in the Boox BooxDrop/Downloads library.

- [ ] **Step 4: Also verify the failure path**

Turn off BooxDrop on the device, export again. Expected Notice: `…saved locally, push failed: …` and the local file still exists. This is the spec's never-lose-an-export guarantee.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: verify BooxDrop endpoint against device and record probe findings"
```

---

### Task 11: USER CONTRIBUTIONS — e-ink stylesheet + chapter-title precedence

**Files:**
- Modify: `src/epub-css.ts` (Pan), `src/naming.ts` + `tests/naming.test.ts` (Pan)

**Interfaces:**
- Consumes: base css from Task 3, default `deriveChapterTitle` from Task 2
- Produces: Pan's final styling and title-precedence rule, with tests updated to match

> **STOP — do not implement this task for the user.** Prepare nothing new; both files already contain marked decision points. Present the two decisions below to Pan, wait for their edits (or their dictated choices), then help verify.

- [ ] **Step 1 (Pan): style `src/epub-css.ts` below the `PAN (Task 11)` marker**

Decision that matters: how callouts, blockquotes, and code should look in 16-shades-of-gray. Trade-offs: borders survive e-ink better than background tints; font-size bumps beat bold for emphasis; Thai line-height below 1.6 clips diacritics on some Boox renderers.

- [ ] **Step 2 (Pan): choose title precedence in `src/naming.ts`**

Replace the body of `deriveChapterTitle` with the chosen precedence (e.g. first-H1 → alias → basename, or alias first?). Trade-offs: H1s read best on a TOC but your `NN_` files may repeat the book title in H1s; aliases are curated but sparse; basename always exists but shows `01_` prefixes on the device TOC. Update the `deriveChapterTitle` test block in `tests/naming.test.ts` to assert the chosen precedence with three cases: (basename only), (basename+H1), (basename+alias+H1).

- [ ] **Step 3: Verify and redeploy**

Run: `npm test && npm run deploy`
Expected: PASS; re-export a book folder and eyeball the TOC + styling in Books.app.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: e-ink stylesheet and chapter-title precedence (Pan)"
```

---

### Task 12: End-to-end acceptance on the real vault + Boox

**Files:** none — final acceptance gate.

**Interfaces:**
- Consumes: the whole plugin
- Produces: checked acceptance list mirroring the spec's requirements

- [ ] **Step 1: Book-folder export**

Right-click a real book folder under `02. areas/03. reading/` → "Export folder as EPUB". Verify: chapters in `NN_` order with the index note first, EPUB title/author from the index note's frontmatter, cover image present (that note has `coverUrl`), wikilinks between chapters jump correctly **on the Boox**.

- [ ] **Step 2: Linked export**

On a note with several wikilinks, run "Export note + linked notes". Verify depth-1 set matches expectation; bump the depth slider to 2 and confirm the ring grows; links to notes outside the set appear as plain text.

- [ ] **Step 3: Boox reading pass (Pan)**

On the device: Thai body text renders with correct diacritics, images legible, code blocks wrap (no horizontal scroll), TOC navigates, file arrived via push without cable.

- [ ] **Step 4: Close out**

Fix anything found (unit test first where reproducible). Final commit:
```bash
git add -A && git commit -m "chore: v0.1.0 acceptance pass complete"
```

---

## Self-Review Notes

- **Spec coverage:** three scopes (Tasks 7's three builders + 12), always-save-before-push (Task 7 orchestrator + Task 10 step 4), BooxDrop isolation & probe (Tasks 6, 10), frontmatter→metadata+cover (Task 7 `exportFolder`), content rules table (Tasks 5, 7), warnings/Notices (Task 7), epubcheck (Task 9), TDD throughout, user-contribution points (Task 11), overwrite+slug filenames (Tasks 2, 7). Out-of-scope items from the spec have no tasks — correct.
- **Type consistency:** `chapterHref` map built in `runExport` feeds `renderUnitToChapter`'s `hrefByPath`; `rewriteImages` returns `newHref` with `../images/` prefix which `runExport` strips to `images/…` before `addAsset` — asserted in Task 3 test (`images/img_001.png` manifest entry) and Task 5 test (`../images/img_001.png` in src).
- **Known judgment call:** `rewriteLinks` returns a warnings array that is currently always empty (outside-set links degrade silently by design); kept as the return type so adapters can add warning cases without a signature change.
