import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import EpubExportPlugin from "../src/main";
import { setSvgRasterizer } from "../src/render-adapter";
import {
  TFile,
  TFolder,
  Menu,
  NOTICES,
  setRequestUrlImpl,
  resetRequestUrlImpl,
} from "./fixtures/obsidian-stub";
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
  setSvgRasterizer(null); // module state discipline, same reason as resetRequestUrlImpl above
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

// ── Task 6 fixture additions ──────────────────────────────────────────────

/** Typed accessor for the stub Plugin's `commands` introspection field (see
 * tests/fixtures/obsidian-stub.ts) — `EpubExportPlugin` is typed through the
 * REAL "obsidian" .d.ts under tsc, which has no `commands` property. */
function commandsOf(
  plugin: EpubExportPlugin
): Record<string, { id: string; name: string; callback?: () => unknown }> {
  return (
    plugin as unknown as { commands: Record<string, { id: string; name: string; callback?: () => unknown }> }
  ).commands;
}

/**
 * Builds a plugin the way real Obsidian does at startup — seed `loadData()`
 * via `saveData()`, then call the real `onload()` — instead of the
 * `makePlugin()` shortcut of assigning `.settings` directly. `onload()`
 * itself calls `loadSettings()` (`Object.assign({}, DEFAULT_SETTINGS, await
 * this.loadData())`), which would otherwise silently STOMP any settings
 * `makePlugin()` had assigned, resetting `outputFolder` to `""` and sending
 * a real write to the machine's actual home directory. Seeding through
 * `saveData()` first makes `loadSettings()` merge to exactly what's asked
 * for, `outputFolder: outDir` included.
 *
 * Also ensures `app.workspace.on` exists (createVaultStub's workspace has no
 * event-emitter methods — onload() registers a "file-menu" listener on it
 * unconditionally) unless a caller has already installed one (e.g. via
 * `captureFileMenu`, which must run BEFORE this).
 */
async function makeOnloadedPlugin(
  app: unknown,
  settings: Partial<EpubExportSettings> = {}
): Promise<EpubExportPlugin> {
  const workspace = (app as { workspace: Record<string, unknown> }).workspace;
  if (typeof workspace.on !== "function") {
    workspace.on = () => ({});
  }
  const plugin = new EpubExportPlugin(app as never, {} as never);
  await plugin.saveData({
    outputFolder: outDir,
    linkDepth: 1,
    language: "th",
    fallbackAuthor: "",
    booxUrl: "",
    pushAfterExport: false,
    ...settings,
  });
  await plugin.onload();
  return plugin;
}

/**
 * Installs a `workspace.on` that records the "file-menu" handler main.ts's
 * `onload()` registers, and returns a function to fire it later (once
 * `onload()` has actually run) with a fresh `Menu` and a target file/folder.
 * Must be called BEFORE `makeOnloadedPlugin`.
 */
function captureFileMenu(app: unknown): (menu: unknown, file: unknown) => void {
  let handler: ((menu: unknown, file: unknown) => void) | undefined;
  (app as { workspace: Record<string, unknown> }).workspace.on = (
    event: string,
    cb: (...a: unknown[]) => void
  ) => {
    if (event === "file-menu") handler = cb as (menu: unknown, file: unknown) => void;
    return {};
  };
  return (menu, file) => {
    if (!handler) throw new Error("file-menu handler was never registered — call this after onload()");
    handler(menu, file);
  };
}

/**
 * `main.ts`'s command callbacks and menu-item onClick handlers are
 * deliberately fire-and-forget (`callback: () => this.withActiveFile(...)`
 * returns `void`, mirroring real Obsidian) — there's nothing for a caller to
 * `await`. To assert on the export's actual result, this temporarily
 * replaces `plugin[method]` so it can capture the promise the real
 * implementation returns, fires the (otherwise-unawaitable) trigger, awaits
 * the capture, then restores the original method.
 */
async function invokeAndWait(
  plugin: EpubExportPlugin,
  method: "exportSingle" | "exportFolder" | "exportLinked",
  trigger: () => void
): Promise<void> {
  const target = plugin as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
  const original = target[method].bind(plugin);
  let captured: Promise<void> | undefined;
  target[method] = (...args: unknown[]) => {
    captured = original(...args);
    return captured;
  };
  trigger();
  await captured;
  target[method] = original;
}

/**
 * Monkeypatches one async method of a vault-stub object (`app.vault`) so it
 * rejects for a single file path, passing every other call through to the
 * real (disk-backed) implementation unchanged. Used to simulate I/O failures
 * (a rejecting `cachedRead`/`readBinary`) the real fixture never produces on
 * its own — a file that genuinely exists on disk never fails to read.
 */
function failFor(obj: unknown, method: string, path: string, error: Error): void {
  const target = obj as Record<string, (f: { path: string }) => unknown>;
  const original = target[method].bind(target);
  target[method] = (f: { path: string }) => (f.path === path ? Promise.reject(error) : original(f));
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
    // language: "" (not "th") exercises metaDefaults()'s own
    // `this.settings.language || "th"` fallback for real, rather than
    // coincidentally landing on "th" because that's also the literal value
    // passed in.
    const plugin = makePlugin(app, { fallbackAuthor: "Pan", language: "" });

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

  it("a scalar `tags` frontmatter string is not substring-matched into index-note election (Fix 3)", async () => {
    // Regression test: exportFolder used to pass `(fm?.tags ?? []) as string[]`
    // straight through with no runtime check. A scalar `tags: "notebook
    // mainframe"` string would reach pickIndexNote, whose `.includes("book")`
    // / `.includes("main")` checks (src/collect.ts) are Array.prototype.includes
    // for genuine arrays but silently fall through to
    // String.prototype.includes — SUBSTRING matching — for a scalar string.
    // "notebook mainframe" contains both "book" and "main", so without the
    // `Array.isArray` guard this note would be wrongly elected as the index.
    const { app, root } = await buildVault({
      "scalarbook/scalar_tags_note.md": [
        "---",
        'tags: "notebook mainframe"',
        "---",
        "",
        "Not the real index — must NOT be elected via substring-matched scalar tags.",
      ].join("\n"),
      "scalarbook/other.md": "Second note, no tags at all.\n",
    });
    const plugin = makePlugin(app, { fallbackAuthor: "Pan" });

    await plugin.exportFolder(tfolder(root, "scalarbook"));

    // No note is named "scalarbook" and no note carries genuine list-shaped
    // [book, main] tags, so pickIndexNote finds no index and this falls back
    // to the folder name / settings author — exactly like case 4's "misc".
    const epub = await readEpub("scalarbook.epub");
    expect(epub.opf).toContain("<dc:title>scalarbook</dc:title>");
    expect(epub.opf).toContain("<dc:creator>Pan</dc:creator>");
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
      "cover_note.md": ["---", 'coverUrl: "https://example.com/cover.jpg"', "---", "", "Body text.", ""].join(
        "\n"
      ),
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

// ── Task 6: onload / command & menu wiring, withActiveFile, settings I/O ──
//
// Covers src/main.ts lines 29-64 and 247-251 — outside the twelve failure
// cases the Task 6 brief enumerates, but needed for main.ts to clear the
// project's 85%-per-file coverage bar, since nothing before this reached
// onload() at all.

describe("onload: command and menu registration", () => {
  it("registers the three export commands under their exact ids", async () => {
    const { app } = await buildVault({ "note.md": "Body.\n" });
    const plugin = await makeOnloadedPlugin(app);
    expect(Object.keys(commandsOf(plugin)).sort()).toEqual(["export-folder", "export-linked", "export-note"]);
  });

  it("each command's callback runs the corresponding export against the active file", async () => {
    // "sub/note.md" links to "sub/other.md" so the export-linked assertion
    // below can prove something export-linked-SPECIFIC happened (2 chapters
    // via bfsLinked), not just "a third export ran" — the review finding
    // pointed out the old fixture had no links at all, so `exportLinked`
    // produced the exact same 1-chapter "note.epub" as `exportSingle` (same
    // title, same filename, no way to tell them apart from the assertion).
    const { app, root } = await buildVault({
      "sub/note.md": "# Note\n\nBody text, links to [[other]].\n",
      "sub/other.md": "# Other\n\nA second note in the same folder.\n",
    });
    const plugin = await makeOnloadedPlugin(app);
    const activeFile = tfile(root, "sub/note.md");
    (app as { workspace: { getActiveFile: () => unknown } }).workspace.getActiveFile = () => activeFile;
    const commands = commandsOf(plugin);

    await invokeAndWait(plugin, "exportSingle", () => commands["export-note"].callback?.());
    expect(await outDirEntries()).toContain("note.epub");

    // f.parent instanceof TFolder: TAbstractFile.parent (obsidian-stub.ts) is
    // only null for the vault root itself, never for a file, so the
    // ternary's "Active note has no parent folder." branch is unreachable
    // via any real file in this fixture (and arguably in real Obsidian too).
    await invokeAndWait(plugin, "exportFolder", () => commands["export-folder"].callback?.());
    expect(await outDirEntries()).toContain("sub.epub");

    // Overwrites the "note.epub" exportSingle just produced — that's fine
    // since we read it immediately after, before anything else writes to it
    // again, so it reflects exportLinked's own result.
    await invokeAndWait(plugin, "exportLinked", () => commands["export-linked"].callback?.());
    const linkedEpub = await readEpub("note.epub");
    expect(linkedEpub.spineCount(linkedEpub.opf)).toBe(2);
  });

  it("a markdown file's context menu offers working note-export and linked-export items", async () => {
    const { app, root } = await buildVault({ "note.md": "# Note\n\nBody text.\n" });
    const fireFileMenu = captureFileMenu(app);
    const plugin = await makeOnloadedPlugin(app);

    const menu = new Menu();
    fireFileMenu(menu as never, tfile(root, "note.md"));
    expect(menu.items.map((i) => i.title)).toEqual([
      "Export note to EPUB",
      "Export note + linked notes to EPUB",
    ]);

    const noteItem = menu.items[0];
    await invokeAndWait(plugin, "exportSingle", () => noteItem.onClickFn?.(new MouseEvent("click")));
    expect(await outDirEntries()).toContain("note.epub");
  });

  it("a folder's context menu offers a working folder-export item", async () => {
    const { app, root } = await buildVault({ "sub/note.md": "Body.\n" });
    const fireFileMenu = captureFileMenu(app);
    const plugin = await makeOnloadedPlugin(app);

    const menu = new Menu();
    fireFileMenu(menu as never, tfolder(root, "sub"));
    expect(menu.items.map((i) => i.title)).toEqual(["Export folder as EPUB"]);

    await invokeAndWait(plugin, "exportFolder", () => menu.items[0].onClickFn?.(new MouseEvent("click")));
    expect(await outDirEntries()).toContain("sub.epub");
  });

  it("a non-markdown file's context menu offers no export items (pins the extension guard)", async () => {
    // Nothing else fires file-menu with anything but a .md TFile or a
    // TFolder, so main.ts:48's `file.extension === "md"` guard was unpinned —
    // a regression offering "Export note to EPUB" on, say, a PNG would have
    // passed every other test here.
    const { app, root } = await buildVault({ "picture.png": new Uint8Array([1, 2, 3]) });
    const fireFileMenu = captureFileMenu(app);
    await makeOnloadedPlugin(app);

    const menu = new Menu();
    fireFileMenu(menu as never, tfile(root, "picture.png"));

    expect(menu.items).toEqual([]);
  });
});

describe("withActiveFile", () => {
  it("shows 'No active note.' and never calls the export when there is no active file", async () => {
    const { app } = await buildVault({});
    const plugin = makePlugin(app);

    (plugin as unknown as { withActiveFile: (fn: (f: unknown) => void) => void }).withActiveFile(() => {
      throw new Error("fn must not be called when there is no active file");
    });

    expect(NOTICES).toContain("No active note.");
  });

  it("invokes the callback with the active file and runs a real export", async () => {
    const { app, root } = await buildVault({ "solo.md": "# Solo\n\nActive file body.\n" });
    const plugin = makePlugin(app);
    const activeFile = tfile(root, "solo.md");
    (app as { workspace: { getActiveFile: () => unknown } }).workspace.getActiveFile = () => activeFile;

    let pending: Promise<void> | undefined;
    (plugin as unknown as { withActiveFile: (fn: (f: unknown) => void) => void }).withActiveFile((f) => {
      expect(f).toBe(activeFile);
      pending = plugin.exportSingle(f as never);
    });
    await pending;

    expect(await outDirEntries()).toContain("solo.epub");
  });

  it("shows a distinct wrong-type Notice and never calls the export for a non-markdown active file (Fix 4)", async () => {
    // Regression test: unlike the file-menu handler (which gates on
    // `extension === "md"`), withActiveFile previously only checked that a
    // file was active at all, so a palette command run with a .png (or
    // .canvas/.pdf) active file would run `cachedRead` on it and produce a
    // garbage chapter.
    const { app, root } = await buildVault({ "picture.png": new Uint8Array([1, 2, 3]) });
    const plugin = makePlugin(app);
    const activeFile = tfile(root, "picture.png");
    (app as { workspace: { getActiveFile: () => unknown } }).workspace.getActiveFile = () => activeFile;

    (plugin as unknown as { withActiveFile: (fn: (f: unknown) => void) => void }).withActiveFile(() => {
      throw new Error("fn must not be called for a non-markdown active file");
    });

    expect(NOTICES).toContain("Active file is not a markdown note.");
    expect(NOTICES).not.toContain("No active note.");
    expect(await outDirEntries()).toEqual([]);
  });
});

describe("settings persistence", () => {
  it("loadSettings merges saved data over the defaults; saveSettings persists the result", async () => {
    const plugin = new EpubExportPlugin({} as never, {} as never);

    await plugin.saveData({ language: "en", fallbackAuthor: "Pan" });
    await plugin.loadSettings();
    expect(plugin.settings).toEqual({
      outputFolder: "",
      linkDepth: 1,
      language: "en",
      fallbackAuthor: "Pan",
      booxUrl: "",
      pushAfterExport: false,
    });

    plugin.settings.outputFolder = outDir;
    plugin.settings.pushAfterExport = true;
    await plugin.saveSettings();

    expect(await plugin.loadData()).toEqual({
      outputFolder: outDir,
      linkDepth: 1,
      language: "en",
      fallbackAuthor: "Pan",
      booxUrl: "",
      pushAfterExport: true,
    });
  });
});

// ── Task 6: failure paths (brief items F1-F12) ────────────────────────────
//
// Each asserts the promised DEGRADATION (a specific warning/Notice/on-disk
// effect), not just "nothing threw" — an implementation that silently
// swallowed the failure with no warning would fail these.

describe("failure paths", () => {
  it("F1: a chapter read failure produces a placeholder chapter without disturbing numbering", async () => {
    const { app, root } = await buildVault({
      "three/1_first.md": "# First\n\nFirst body text.\n",
      "three/2_second.md": "# Second\n\nSecond body text.\n",
      "three/3_third.md": "# Third\n\nThird body text, unique-marker-C.\n",
    });
    failFor(app.vault, "cachedRead", "three/2_second.md", new Error("disk read failed"));
    const plugin = makePlugin(app);

    await plugin.exportFolder(tfolder(root, "three"));

    const epub = await readEpub("three.epub");
    expect(epub.spineCount(epub.opf)).toBe(3);
    expect(await epub.chapter(2)).toContain("chapter failed to render");
    expect(await epub.chapter(3)).toContain("unique-marker-C");
    expect(warnings.some((w) => w.includes("chapter skipped"))).toBe(true);
    expect(successNotices().some((n) => n.includes("Exported with 1 warning"))).toBe(true);
  });

  it("F2: a cross-chapter link still resolves to the correct chapter after an earlier chapter is skipped", async () => {
    // Review finding: `href="chapter_003.xhtml"` alone is emitted whether or
    // not chapter 2 was actually skipped — hrefByPath (src/main.ts:155) is
    // built from job.files BEFORE any chapter is read, so the href a link
    // resolves to is invariant to whether the read later fails. The missing
    // half of the promise is that chapter 3 itself — the thing the link
    // actually points at — genuinely exists with its real content, not a
    // placeholder and not shifted out of position by the skip.
    const { app, root } = await buildVault({
      "three/1_first.md": "# First\n\nSee [[3_third]] for the ending.\n",
      "three/2_second.md": "# Second\n\nSecond body text.\n",
      "three/3_third.md": "# Third\n\nThird body text.\n",
    });
    failFor(app.vault, "cachedRead", "three/2_second.md", new Error("disk read failed"));
    const plugin = makePlugin(app);

    await plugin.exportFolder(tfolder(root, "three"));

    const epub = await readEpub("three.epub");
    expect(epub.spineCount(epub.opf)).toBe(3);
    const chapter1 = await epub.chapter(1);
    expect(chapter1).toContain('href="chapter_003.xhtml"');
    expect(await epub.chapter(3)).toContain("Third body text");
  });

  it("F3: a missing image produces a warning and the export still succeeds", async () => {
    const { app, root } = await buildVault({
      "with_missing.md": "# Note\n\n![](gone.png)\n",
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_missing.md"));

    const epub = await readEpub("with_missing.epub");
    expect(epub.spineCount(epub.opf)).toBe(1);
    expect(warnings.some((w) => /missing image: gone\.png/.test(w))).toBe(true);
    expect(epub.names.some((n) => n.startsWith("OEBPS/images/"))).toBe(false);
    expect(successNotices()).toHaveLength(1);
  });

  it("F4: an unsupported image extension is skipped with a warning, not embedded", async () => {
    const { app, root } = await buildVault({
      "with_bmp.md": "# Note\n\n![](pic.bmp)\n",
      "pic.bmp": new Uint8Array([1, 2, 3, 4]),
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_bmp.md"));

    const epub = await readEpub("with_bmp.epub");
    expect(warnings.some((w) => /unsupported image type: pic\.bmp/.test(w))).toBe(true);
    expect(epub.names.some((n) => n.startsWith("OEBPS/images/"))).toBe(false);
  });

  it("F5: a readBinary failure still exports the chapter body, just without that image", async () => {
    const { app, root } = await buildVault({
      "with_photo.md": "# Note\n\nBody text survives. ![](photo.png)\n",
      "photo.png": new Uint8Array([137, 80, 78, 71]),
    });
    failFor(app.vault, "readBinary", "photo.png", new Error("simulated read failure"));
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_photo.md"));

    const epub = await readEpub("with_photo.epub");
    const chapter1 = await epub.chapter(1);
    expect(chapter1).not.toContain("chapter failed to render");
    expect(chapter1).toContain("Body text survives.");
    expect(warnings.some((w) => /missing image: photo\.png/.test(w))).toBe(true);
  });

  it("F6: a non-200 cover response degrades to a coverless, still-successful export", async () => {
    const { app, root } = await buildVault({
      "cover_fail.md": ["---", 'coverUrl: "https://example.com/cover.jpg"', "---", "", "Body.", ""].join(
        "\n"
      ),
    });
    setRequestUrlImpl(async () => ({
      status: 404,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "cover_fail.md"));

    const epub = await readEpub("cover_fail.epub");
    expect(epub.names.some((n) => n.startsWith("OEBPS/images/cover."))).toBe(false);
    expect(warnings.some((w) => w.includes("cover download failed"))).toBe(true);
    expect(successNotices()).toHaveLength(1);
  });

  it("F7: a cover request that throws degrades the same way as a non-200 response", async () => {
    const { app, root } = await buildVault({
      "cover_throw.md": ["---", 'coverUrl: "https://example.com/cover.jpg"', "---", "", "Body.", ""].join(
        "\n"
      ),
    });
    setRequestUrlImpl(async () => {
      throw new Error("network down");
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "cover_throw.md"));

    const epub = await readEpub("cover_throw.epub");
    expect(epub.names.some((n) => n.startsWith("OEBPS/images/cover."))).toBe(false);
    expect(warnings.some((w) => w.includes("cover download failed"))).toBe(true);
    expect(successNotices()).toHaveLength(1);
  });

  it("a cover response with no content-type header at all still embeds, defaulting to jpg", async () => {
    // Exercises `(res.headers["content-type"] ?? "").includes("png")`'s own
    // `?? ""` fallback for real (a server that omits the header entirely),
    // rather than every cover test so far which always sets one.
    const { app, root } = await buildVault({
      "cover_no_header.md": ["---", 'coverUrl: "https://example.com/cover"', "---", "", "Body.", ""].join(
        "\n"
      ),
    });
    setRequestUrlImpl(async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
      text: "",
      json: null,
    }));
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "cover_no_header.md"));

    const epub = await readEpub("cover_no_header.epub");
    expect(epub.names).toContain("OEBPS/images/cover.jpg");
  });

  it("F8: a successful push notifies and posts to the real upload endpoint", async () => {
    const { app, root } = await buildVault({ "push_ok.md": "Body.\n" });
    const seenUrls: string[] = [];
    setRequestUrlImpl(async (req) => {
      seenUrls.push(typeof req === "string" ? req : req.url);
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: '{"successful":true}',
        json: null,
      };
    });
    const plugin = makePlugin(app, { pushAfterExport: true, booxUrl: "http://boox:8085" });

    await plugin.exportSingle(tfile(root, "push_ok.md"));

    expect(successNotices().some((n) => n.includes("pushed to Boox"))).toBe(true);
    expect(seenUrls.some((u) => u.endsWith("/api/library/upload"))).toBe(true);
  });

  it("F9: a failed push leaves the local epub in place and reports the failure", async () => {
    const { app, root } = await buildVault({ "push_fail.md": "Body.\n" });
    setRequestUrlImpl(async () => ({
      status: 500,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
    const plugin = makePlugin(app, { pushAfterExport: true, booxUrl: "http://boox:8085" });

    await plugin.exportSingle(tfile(root, "push_fail.md"));

    expect(await outDirEntries()).toContain("push_fail.epub");
    expect(successNotices().some((n) => /saved locally, push failed/.test(n))).toBe(true);
  });

  it("a push that rejects with a non-Error value still reports a readable failure", async () => {
    // Review finding: `e instanceof Error ? e.message : String(e)` (src/main.ts:232)
    // has a real, reachable non-Error branch — the throw site is this
    // suite's OWN injected network fake. `setRequestUrlImpl` rejecting with a
    // bare string propagates unchanged through obsidianHttp (no try/catch
    // around its `await requestUrl(...)`) and through BooxDropClient.push
    // (same), landing in main.ts's catch as a string, not an Error.
    const { app, root } = await buildVault({ "push_throw.md": "Body.\n" });
    setRequestUrlImpl(async () => {
      throw "boom";
    });
    const plugin = makePlugin(app, { pushAfterExport: true, booxUrl: "http://boox:8085" });

    await plugin.exportSingle(tfile(root, "push_throw.md"));

    expect(await outDirEntries()).toContain("push_throw.epub");
    expect(successNotices().some((n) => n.includes("push failed: boom"))).toBe(true);
  });

  it("F10: push disabled means the upload endpoint is never contacted", async () => {
    // Note filename deliberately avoids the word "push" — it ends up in the
    // success Notice's own text ("EPUB saved to .../<slug>.epub"), which
    // would otherwise give the "no push" assertion below a false positive.
    const { app, root } = await buildVault({ "toggle_off.md": "Body.\n" });
    // No setRequestUrlImpl override here: beforeEach's default THROWS on any
    // request, so a regression that attempted a push anyway would surface as
    // a "push failed: unexpected network access in test" suffix below.
    const plugin = makePlugin(app, { pushAfterExport: false, booxUrl: "http://boox:8085" });

    await plugin.exportSingle(tfile(root, "toggle_off.md"));

    const notices = successNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("pushed to Boox");
    expect(notices[0]).not.toContain("push failed");
  });

  it("F11: an empty folder shows a notice and writes nothing", async () => {
    const { app, root } = await buildVault({ "empty/.keep": "" });
    const plugin = makePlugin(app);

    await plugin.exportFolder(tfolder(root, "empty"));

    expect(NOTICES.some((n) => /no markdown notes/i.test(n))).toBe(true);
    expect(await outDirEntries()).toHaveLength(0);
  });

  it("F12: a fatal export error (unwritable outputFolder) shows a failure notice and logs it", async () => {
    const { app, root } = await buildVault({ "solo.md": "# Solo\n\nBody.\n" });
    const blockerFile = join(outDir, "blocker");
    await fs.writeFile(blockerFile, "not a directory\n");
    const plugin = makePlugin(app, { outputFolder: join(blockerFile, "nested") });

    await plugin.exportSingle(tfile(root, "solo.md"));

    expect(NOTICES.some((n) => n.startsWith("EPUB export failed"))).toBe(true);
    expect(errors.some((e) => e.includes("export failed"))).toBe(true);
  });
});

describe("mermaid rasterization (Round 3)", () => {
  it("case 13: an injected rasterizer turns a mermaid diagram into a PNG asset — no inline svg, no svg property left", async () => {
    const fakeBytes = new Uint8Array([9, 9, 9, 9]);
    // Fractional width (a real mermaid svg's width, e.g. "774.8046875") is
    // deliberate: XHTML's `width` attribute must be an integer (epubcheck
    // RSC-005 — a real device re-export caught exactly this regression), so
    // this test is discriminating against writing the raw fractional value.
    setSvgRasterizer(async () => ({ bytes: fakeBytes, width: 200.6, height: 100 }));
    const { app, root } = await buildVault({
      "with_diagram.md": "# Diagram\n\n```mermaid\ngraph TD; A-->B;\n```\n",
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_diagram.md"));

    const epub = await readEpub("with_diagram.epub");
    const chapter1 = await epub.chapter(1);
    expect(epub.names).toContain("OEBPS/images/img_001.png");
    expect(chapter1).toContain("../images/img_001.png");
    expect(chapter1).not.toContain("<svg");
    expect(epub.opf).toContain('href="images/img_001.png" media-type="image/png"');
    expect(epub.opf).not.toContain('properties="svg"');
    const widthMatch = /width="([^"]*)"/.exec(chapter1);
    expect(widthMatch?.[1]).toMatch(/^\d+$/);
    expect(widthMatch?.[1]).toBe("201");
    const assetBytes = await epub.zip.file("OEBPS/images/img_001.png")!.async("uint8array");
    expect(Array.from(assetBytes)).toEqual(Array.from(fakeBytes));
    expect(warnings.filter((w) => w.includes("mermaid rasterization"))).toHaveLength(0);
  });

  it("case 14: with no rasterizer injected, jsdom has no canvas so the real default falls back to inline svg (properties=svg, warning surfaced)", async () => {
    const { app, root } = await buildVault({
      "with_diagram.md": "# Diagram\n\n```mermaid\ngraph TD; A-->B;\n```\n",
    });
    const plugin = makePlugin(app);

    await plugin.exportSingle(tfile(root, "with_diagram.md"));

    const epub = await readEpub("with_diagram.epub");
    const chapter1 = await epub.chapter(1);
    expect(chapter1).toContain("<svg");
    expect(epub.opf).toMatch(
      /id="ch_001" href="text\/chapter_001\.xhtml" media-type="application\/xhtml\+xml" properties="svg"/
    );
    const notices = successNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Exported with 1 warning");
  });
});
