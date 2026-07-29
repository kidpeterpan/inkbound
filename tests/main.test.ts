import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import EpubExportPlugin from "../src/main";
import { TFile, TFolder, Menu, NOTICES, setRequestUrlImpl, resetRequestUrlImpl } from "./fixtures/obsidian-stub";
import { createVaultStub } from "./fixtures/vault-stub";
import type { EpubExportSettings } from "../src/settings";

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
let errors: string[];
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

beforeEach(async () => {
  outDir = await fs.mkdtemp(join(tmpdir(), "epub-export-out-"));
  vaultDirs = [];
  NOTICES.length = 0;
  warnings = [];
  errors = [];
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  // Structural network safety net (not per-test discipline): every test
  // starts with a fake that THROWS on any request. A test that needs network
  // behavior (cover download, BooxDrop push) must install its own
  // `setRequestUrlImpl` — a test that forgets to do so gets a loud failure
  // instead of `resetRequestUrlImpl()`'s default silently falling through to
  // the REAL `fetch` and hitting an actual LAN/internet address.
  setRequestUrlImpl(async () => {
    throw new Error("unexpected network access in test");
  });
});

afterEach(async () => {
  console.warn = originalWarn;
  console.error = originalError;
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

// Typed as `Partial<EpubExportSettings>` (not `Partial<Record<string, unknown>>`)
// so a misspelled override key (e.g. `linkDepht`) fails `tsc --noEmit` instead
// of silently being dropped — matters once tests start flipping
// `pushAfterExport`/`booxUrl` for the push-degradation cases.
function makePlugin(app: unknown, settings: Partial<EpubExportSettings> = {}): EpubExportPlugin {
  const plugin = new EpubExportPlugin(app as never, {} as never);
  plugin.settings = {
    outputFolder: outDir,
    linkDepth: 1,
    language: "th",
    fallbackAuthor: "",
    booxUrl: "",
    pushAfterExport: false,
    ...settings,
  };
  return plugin;
}

/** Lists `outDir` for "nothing was written" assertions (readEpub throws ENOENT
 * on a missing file, which is the wrong failure mode for those cases). */
async function outDirEntries(): Promise<string[]> {
  return fs.readdir(outDir);
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
    // Finding B: metadata alone doesn't prove the note's actual body made it
    // into the EPUB — an implementation emitting perfect metadata over an
    // empty chapter would still pass every assertion above.
    expect(await epub.chapter(1)).toContain("Writing clean code matters.");
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
    // Deliberate fixture choices, each closing a specific falsifiability gap
    // a reviewer found in the original version of this test:
    //  - The index note is named "index_note.md", NOT "book" (the folder's
    //    name) — it's tagged [book, main] but NOT named after the folder, so
    //    only pickIndexNote's TAG branch can produce it as the index. If the
    //    tag check were deleted, the name-fallback branch would find nothing
    //    (no note is named "book") and this test would fail instead of
    //    silently passing.
    //  - Prefixes are UNPADDED ("2_b", "10_c", not "02_b"/"10_c") so lexical
    //    and numeric ordering disagree: lexically "10_c" < "2_b", so a
    //    regression that dropped orderChapters' numeric parsing (or replaced
    //    it with the identity function over TFolder.children's already
    //    fs.readdirSync().sort()-ed input) would produce the wrong order.
    //  - The plugin's `language` setting is set to "en" (not the default
    //    "th"), so `language: thai` in book.md's frontmatter resolving to
    //    "th" is discriminating — with the default already "th", a broken
    //    frontmatter-language resolver would still show "th" by coincidence.
    const { app, root } = await buildVault({
      "book/index_note.md": [
        "---",
        "tags: [book, main]",
        "author: Jane Doe",
        "language: thai",
        "---",
        "",
        "# Book Index",
        "",
        "This is the index chapter body, distinct from every other chapter.",
        "",
      ].join("\n"),
      "book/2_b.md": "# Chapter B\n\nSecond chapter body text B-marker.\n",
      "book/1_a.md": "# Chapter A\n\nFirst chapter body text A-marker.\n",
      "book/10_c.md": "# Chapter C\n\nTenth chapter body text C-marker.\n",
    });
    const plugin = makePlugin(app, { language: "en" });

    await plugin.exportFolder(tfolder(root, "book"));

    // Title/output filename come from the index note's own basename
    // (resolveTitle has no aliases to prefer here), not the folder's name.
    const epub = await readEpub("index_note.epub");
    expect(epub.spineCount(epub.opf)).toBe(4);
    expect(epub.opf).toContain("<dc:language>th</dc:language>");
    expect(epub.opf).toContain("<dc:creator>Jane Doe</dc:creator>");

    // Finding A fix: bind each title to its own href instead of probing the
    // nav text for a bare "<name<" substring — meta.title is also "book"-ish
    // text that shows up in <title>/<h1>, which let the old assertion match
    // the document head rather than the index chapter's actual <li>. Binding
    // title-to-href also directly encodes ordering, since hrefs are assigned
    // in job.files iteration order.
    expect(epub.nav).toContain('<a href="text/chapter_001.xhtml">index_note</a>');
    expect(epub.nav).toContain('<a href="text/chapter_002.xhtml">1_a</a>');
    expect(epub.nav).toContain('<a href="text/chapter_003.xhtml">2_b</a>');
    expect(epub.nav).toContain('<a href="text/chapter_004.xhtml">10_c</a>');

    // Finding B fix: prove each chapter's actual body text (not just its
    // title) landed in the right slot — an empty-body implementation with
    // perfect metadata/nav would fail these.
    expect(await epub.chapter(1)).toContain("This is the index chapter body");
    expect(await epub.chapter(2)).toContain("First chapter body text A-marker.");
    expect(await epub.chapter(3)).toContain("Second chapter body text B-marker.");
    expect(await epub.chapter(4)).toContain("Tenth chapter body text C-marker.");
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
