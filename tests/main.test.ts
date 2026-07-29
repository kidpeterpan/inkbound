import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import EpubExportPlugin from "../src/main";
import { TFile, TFolder, NOTICES, setRequestUrlImpl, resetRequestUrlImpl } from "./fixtures/obsidian-stub";
import { createVaultStub } from "./fixtures/vault-stub";

// ── fixture ─────────────────────────────────────────────────────────────
//
// Reused by Task 6 (failure-path tests appended to this same file).
//
// The plugin writes with real node `fs` to `settings.outputFolder`, so every
// test uses a real temp dir for output. The vault side reuses
// tests/fixtures/vault-stub.ts's `createVaultStub`, which is itself
// real-filesystem-backed (TFolder.children in obsidian-stub.ts calls
// fs.readdirSync — a purely in-memory vault can't back a real TFolder), so
// each test also gets a fresh temp dir standing in for the vault root. Both
// kinds of temp dirs are tracked and removed in afterEach; neither ever
// touches the actual Obsidian vault this repo's notes live in.

let outDir: string;
let vaultDirs: string[];
let warnings: string[];
let originalWarn: typeof console.warn;

beforeEach(async () => {
  outDir = await fs.mkdtemp(join(tmpdir(), "epub-export-out-"));
  vaultDirs = [];
  NOTICES.length = 0;
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.warn = originalWarn;
  resetRequestUrlImpl();
  await fs.rm(outDir, { recursive: true, force: true });
  await Promise.all(vaultDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/**
 * Writes `files` (note bodies incl. their own frontmatter, or raw binary
 * bytes) to a fresh temp dir and wraps it in the real vault-stub app object
 * (real fs reads/writes, real frontmatter parsing, real wikilink resolution
 * via resolvedLinks) — the same fixture the local integration harness uses.
 */
async function buildVault(files: Record<string, string | Uint8Array>) {
  const root = await fs.mkdtemp(join(tmpdir(), "epub-export-vault-"));
  vaultDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  const { app } = createVaultStub(root, "");
  return { app, root };
}

// The stub's TFile/TFolder (tests/fixtures/obsidian-stub.ts) are missing
// `stat`/`vault`, which the REAL "obsidian" package's .d.ts declares (only
// vitest aliases "obsidian" to the stub — tsc still resolves the real
// node_modules/obsidian types). That makes them nominally incompatible with
// the `TFile`/`TFolder` parameter types main.ts imports from "obsidian",
// even though they're exactly what runs under the vitest alias. Cast through
// `never` at construction, mirroring tests/render-adapter.test.ts's
// `newComponent()` for the same reason.
function tfile(root: string, path: string): never {
  return new TFile(root, path) as never;
}
function tfolder(root: string, path: string): never {
  return new TFolder(root, path) as never;
}

function makePlugin(app: unknown, settings: Partial<Record<string, unknown>> = {}) {
  const plugin = new EpubExportPlugin(app as never, {} as never);
  plugin.settings = {
    outputFolder: outDir,
    linkDepth: 1,
    language: "th",
    fallbackAuthor: "",
    booxUrl: "",
    pushAfterExport: false,
    ...settings,
  } as never;
  return plugin;
}

async function readEpub(name: string) {
  const bytes = await fs.readFile(join(outDir, name));
  const zip = await JSZip.loadAsync(bytes);
  const text = async (p: string) => zip.file(p)!.async("string");
  return {
    zip,
    bytes,
    names: Object.keys(zip.files),
    opf: await text("OEBPS/package.opf"),
    nav: await text("OEBPS/nav.xhtml"),
    chapter: (n: number) => text(`OEBPS/text/chapter_${String(n).padStart(3, "0")}.xhtml`),
    spineCount: (opf: string) => (opf.match(/<itemref/g) ?? []).length,
  };
}

function successNotices(): string[] {
  return NOTICES.filter((n) => n.startsWith("EPUB saved to"));
}

// ── happy paths ─────────────────────────────────────────────────────────

describe("exportSingle", () => {
  it("case 1: resolves title/author/language from frontmatter (regression: Task 2 bug)", async () => {
    const { app, root } = await buildVault({
      "clean_code.md": [
        "---",
        "aliases: [Clean Code]",
        "author: Robert C. Martin",
        "language: english",
        "---",
        "",
        "# Clean Code",
        "",
        "Writing clean code matters.",
        "",
      ].join("\n"),
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "clean_code.md"));

    expect(await fs.readdir(outDir)).toContain("clean_code.epub");
    const epub = await readEpub("clean_code.epub");
    expect(epub.opf).toContain("<dc:title>Clean Code</dc:title>");
    expect(epub.opf).toContain("<dc:creator>Robert C. Martin</dc:creator>");
    expect(epub.opf).toContain("<dc:language>en</dc:language>");
    expect(epub.spineCount(epub.opf)).toBe(1);
    expect(successNotices().some((n) => n.includes("clean_code.epub"))).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("case 2: falls back to fallbackAuthor/settings language/basename when frontmatter is absent", async () => {
    const { app, root } = await buildVault({
      "untitled_note.md": "Just a plain note with no frontmatter.\n",
    });
    const plugin = makePlugin(app, { fallbackAuthor: "Pan", language: "th" });

    await plugin.exportSingle(tfile(root, "untitled_note.md"));

    const epub = await readEpub("untitled_note.epub");
    expect(epub.opf).toContain("<dc:creator>Pan</dc:creator>");
    expect(epub.opf).toContain("<dc:language>th</dc:language>");
    expect(epub.opf).toContain("<dc:title>untitled_note</dc:title>");
  });
});

describe("exportFolder", () => {
  it("case 3: places the tagged index first, then chapters in numeric-prefix order", async () => {
    const { app, root } = await buildVault({
      "book/book.md": [
        "---",
        "tags: [book, main]",
        "author: Jane Doe",
        "language: thai",
        "---",
        "",
        "# Book Index",
        "",
      ].join("\n"),
      "book/02_b.md": "# Chapter B\n\nSecond chapter.\n",
      "book/01_a.md": "# Chapter A\n\nFirst chapter.\n",
      "book/10_c.md": "# Chapter C\n\nTenth chapter.\n",
    });
    const plugin = makePlugin(app);

    await plugin.exportFolder(tfolder(root, "book"));

    const epub = await readEpub("book.epub");
    expect(epub.spineCount(epub.opf)).toBe(4);
    expect(epub.opf).toContain("<dc:language>th</dc:language>");
    expect(epub.opf).toContain("<dc:creator>Jane Doe</dc:creator>");

    const order = ["book", "01_a", "02_b", "10_c"];
    const positions = order.map((name) => epub.nav.indexOf(`>${name}<`));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("case 4: falls back to the folder name and settings author when no index note is found", async () => {
    const { app, root } = await buildVault({
      "misc/one.md": "First note, nothing tagged book+main.\n",
      "misc/two.md": "Second note, no note named after the folder either.\n",
    });
    const plugin = makePlugin(app, { fallbackAuthor: "Pan" });

    await plugin.exportFolder(tfolder(root, "misc"));

    const epub = await readEpub("misc.epub");
    expect(epub.opf).toContain("<dc:title>misc</dc:title>");
    expect(epub.opf).toContain("<dc:creator>Pan</dc:creator>");
    expect(epub.names).not.toContain("OEBPS/images/cover.jpg");
    expect(epub.names).not.toContain("OEBPS/images/cover.png");
    expect(epub.opf).not.toContain("cover-image");
  });
});

describe("exportLinked", () => {
  it("case 5: follows wikilinks to the configured depth", async () => {
    const { app, root } = await buildVault({
      "linked/a.md": "Start note linking to [[b]] and [[c]].\n",
      "linked/b.md": "Leaf note b.\n",
      "linked/c.md": "Note c links onward to [[d]].\n",
      "linked/d.md": "Leaf note d.\n",
    });
    const start = tfile(root, "linked/a.md");

    const depth1 = makePlugin(app, { linkDepth: 1 });
    await depth1.exportLinked(start);
    const epub1 = await readEpub("a.epub");
    expect(epub1.spineCount(epub1.opf)).toBe(3);
    expect(epub1.nav).not.toContain(">d<");

    const depth2 = makePlugin(app, { linkDepth: 2 });
    await depth2.exportLinked(start);
    const epub2 = await readEpub("a.epub");
    expect(epub2.spineCount(epub2.opf)).toBe(4);
    expect(epub2.nav).toContain(">d<");
  });
});

describe("cover art", () => {
  it("case 6: embeds a downloaded cover with the extension matching its content-type", async () => {
    const { app, root } = await buildVault({
      "cover_note.md": ['---', 'coverUrl: "https://example.com/cover.jpg"', "---", "", "Body text.", ""].join("\n"),
    });
    const file = tfile(root, "cover_note.md");

    setRequestUrlImpl(async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
      text: "",
      json: null,
    }));
    await makePlugin(app).exportSingle(file);
    const jpegEpub = await readEpub("cover_note.epub");
    expect(jpegEpub.names).toContain("OEBPS/images/cover.jpg");
    expect(jpegEpub.opf).toContain('properties="cover-image"');

    setRequestUrlImpl(async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      arrayBuffer: new Uint8Array([5, 6, 7, 8]).buffer,
      text: "",
      json: null,
    }));
    await makePlugin(app).exportSingle(file);
    const pngEpub = await readEpub("cover_note.epub");
    expect(pngEpub.names).toContain("OEBPS/images/cover.png");
    expect(pngEpub.opf).toContain('properties="cover-image"');
  });
});

describe("images", () => {
  it("case 7: embeds an image referenced by a relative markdown path", async () => {
    const { app, root } = await buildVault({
      "with_image.md": "![cap](fig.png)\n",
      "fig.png": new Uint8Array([137, 80, 78, 71]),
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_image.md"));

    const epub = await readEpub("with_image.epub");
    const chapter1 = await epub.chapter(1);
    expect(chapter1).toContain("../images/img_001.png");
    expect(epub.names).toContain("OEBPS/images/img_001.png");
    expect(warnings).toHaveLength(0);
  });
});

describe("overwrite", () => {
  it("case 8: overwrites an existing output file with the freshly built epub", async () => {
    const { app, root } = await buildVault({
      "again.md": "# Again\n\nBody.\n",
    });
    const plugin = makePlugin(app);
    const target = join(outDir, "again.epub");
    // Sentinel: a 1-byte file that is definitely not a valid zip, standing in
    // for a stale export left over from an earlier run.
    await fs.writeFile(target, new Uint8Array([0]));

    await plugin.exportSingle(tfile(root, "again.md"));
    expect((await fs.stat(target)).size).toBeGreaterThan(1);
    expect((await readEpub("again.epub")).opf).toContain("<dc:title>again</dc:title>");

    await plugin.exportSingle(tfile(root, "again.md"));
    expect((await fs.stat(target)).size).toBeGreaterThan(1);
    expect((await readEpub("again.epub")).opf).toContain("<dc:title>again</dc:title>");

    expect(successNotices()).toHaveLength(2);
  });
});
