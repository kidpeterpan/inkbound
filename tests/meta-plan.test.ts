// 014-preview-before-export: NoteMetaSource's split into plan() and
// attachCover(), tested directly against the real-file vault stub.
//
// What matters here is the line between the two halves. plan() decides which
// cover source applies and must not touch the network or read an image, because
// a preview calls it and nothing else. attachCover() carries the decision out
// with the warnings the export has always raised, and resolve() — still what
// the single-note export calls — must remain exactly plan() then attachCover().
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NoteMetaSource } from "../src/adapters/meta-adapter";
import type { ExportMeta } from "../src/core/types";
import { TFile, resetRequestUrlImpl, setRequestUrlImpl } from "./fixtures/obsidian-stub";
import { createVaultStub } from "./fixtures/vault-stub";

const DEFAULTS = { fallbackAuthor: "Fallback Author", language: "th" };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let vaultDirs: string[];
let requests: string[];

beforeEach(() => {
  vaultDirs = [];
  requests = [];
  setRequestUrlImpl(async (request) => {
    requests.push(typeof request === "string" ? request : request.url);
    return {
      status: 200,
      headers: { "content-type": "image/png" },
      arrayBuffer: PNG.buffer.slice(0) as ArrayBuffer,
      text: "",
      json: null,
    };
  });
});

afterEach(async () => {
  resetRequestUrlImpl();
  await Promise.all(vaultDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

interface Probe {
  source: NoteMetaSource;
  vault: Record<string, (f: { path: string }) => Promise<unknown>>;
  // `never`, the idiom tests/main.test.ts uses for this: tsc resolves "obsidian"
  // to the real .d.ts (whose TFile has stat and vault) while vitest resolves it
  // to the stub, so the stub's TFile is nominally a different type.
  file: (path: string) => never;
  /** vault.readBinary calls, i.e. image reads. */
  binaryReads: string[];
  /** vault.cachedRead calls, i.e. the note's own text. */
  textReads: string[];
}

async function probe(files: Record<string, string | Uint8Array>): Promise<Probe> {
  const root = await fs.mkdtemp(join(tmpdir(), "epub-meta-plan-"));
  vaultDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  const { app } = createVaultStub(root, "");
  const vault = app.vault as unknown as Record<string, (f: { path: string }) => Promise<unknown>>;
  const binaryReads: string[] = [];
  const textReads: string[] = [];
  const readBinary = vault.readBinary.bind(vault);
  const cachedRead = vault.cachedRead.bind(vault);
  vault.readBinary = (f) => (binaryReads.push(f.path), readBinary(f));
  vault.cachedRead = (f) => (textReads.push(f.path), cachedRead(f));
  return {
    source: new NoteMetaSource(app as never, DEFAULTS),
    vault,
    file: (path) => new TFile(root, path) as never,
    binaryReads,
    textReads,
  };
}

const note = (frontmatter: string[], body = "Body text.") =>
  ["---", ...frontmatter, "---", "", body, ""].join("\n");

/** Every cover situation the export handles, each as a vault plus the note to read. */
const SITUATIONS: Record<string, { files: Record<string, string | Uint8Array>; expectedKind: string }> = {
  "cover: URL": {
    files: { "n.md": note(['cover: "https://example.com/c.png"']) },
    expectedKind: "url",
  },
  "cover: path": {
    files: { "n.md": note(["cover: assets/c.png"]), "assets/c.png": PNG },
    expectedKind: "path",
  },
  "cover: wikilink": {
    files: { "n.md": note(['cover: "[[c.png]]"']), "assets/c.png": PNG },
    expectedKind: "path",
  },
  "legacy coverUrl:": {
    files: { "n.md": note(['coverUrl: "https://example.com/legacy.jpg"']) },
    expectedKind: "url",
  },
  "cover: winning over coverUrl:": {
    files: {
      "n.md": note(["cover: c.png", 'coverUrl: "https://example.com/legacy.jpg"']),
      "c.png": PNG,
    },
    expectedKind: "path",
  },
  "an image embedded in the note": {
    files: { "n.md": note([], "![[pic.png]]"), "pic.png": PNG },
    expectedKind: "embeds",
  },
  "no cover anywhere": {
    files: { "n.md": note(["author: Someone"]) },
    expectedKind: "none",
  },
};

describe("NoteMetaSource.plan: decides the cover without carrying it out", () => {
  it("returns the text fields and no cover bytes", async () => {
    const { source, file } = await probe({
      "n.md": note([
        "aliases: [My Book]",
        "author: Pan",
        "language: english",
        'cover: "https://example.com/c.png"',
      ]),
    });

    const { meta } = await source.plan(file("n.md"), "n");

    expect(meta).toEqual({ title: "My Book", author: "Pan", language: "en" });
    expect(meta.coverBytes).toBeUndefined();
    expect(meta.coverExt).toBeUndefined();
  });

  it.each(Object.entries(SITUATIONS))(
    "%s: picks the right source",
    async (_name, { files, expectedKind }) => {
      const { source, file } = await probe(files);

      const { cover } = await source.plan(file("n.md"), "n");

      expect(cover.kind).toBe(expectedKind);
    }
  );

  it.each(Object.entries(SITUATIONS))(
    "%s: makes no network request and reads no image",
    async (_name, { files }) => {
      const { source, file, binaryReads } = await probe(files);

      await source.plan(file("n.md"), "n");

      expect(requests).toEqual([]);
      expect(binaryReads).toEqual([]);
    }
  );

  it("names the declared URL and path as written", async () => {
    const url = await probe(SITUATIONS["cover: URL"].files);
    expect((await url.source.plan(url.file("n.md"), "n")).cover).toEqual({
      kind: "url",
      url: "https://example.com/c.png",
    });

    const wikilink = await probe(SITUATIONS["cover: wikilink"].files);
    expect((await wikilink.source.plan(wikilink.file("n.md"), "n")).cover).toEqual({
      kind: "path",
      path: "c.png",
    });
  });

  it("names the note and its embeds when the first-image fallback applies", async () => {
    const { source, file } = await probe({
      "n.md": note([], "![[one.png]] and ![alt](two.jpg)"),
    });

    const { cover } = await source.plan(file("n.md"), "n");

    expect(cover).toEqual({ kind: "embeds", notePath: "n.md", targets: ["one.png", "two.jpg"] });
  });

  it("reads the note's own text only when no cover is declared", async () => {
    const declared = await probe(SITUATIONS["cover: URL"].files);
    await declared.source.plan(declared.file("n.md"), "n");
    expect(declared.textReads).toEqual([]);

    const undeclared = await probe(SITUATIONS["an image embedded in the note"].files);
    await undeclared.source.plan(undeclared.file("n.md"), "n");
    expect(undeclared.textReads).toEqual(["n.md"]);
  });

  it("treats a note whose text cannot be read as having no cover, not as an error", async () => {
    const { source, file, vault } = await probe({ "n.md": note(["author: Someone"]) });
    vault.cachedRead = () => Promise.reject(new Error("disk gone"));

    const { cover } = await source.plan(file("n.md"), "n");

    expect(cover).toEqual({ kind: "none" });
  });

  it("with no note at all, falls back to the given name, the default author and no cover", async () => {
    const { source, textReads } = await probe({});

    const plan = await source.plan(null, "My Folder");

    expect(plan.meta).toEqual({ title: "My Folder", author: "Fallback Author", language: "th" });
    expect(plan.cover).toEqual({ kind: "none" });
    expect(textReads).toEqual([]);
  });
});

describe("NoteMetaSource.attachCover: carries the decision out", () => {
  const baseMeta = (): ExportMeta => ({ title: "T", author: "A", language: "th" });

  it("downloads a url plan and takes the extension from the content type", async () => {
    const { source, file } = await probe({ "n.md": note([]) });
    const meta = baseMeta();
    const warnings: string[] = [];

    await source.attachCover(meta, { kind: "url", url: "https://example.com/c.png" }, file("n.md"), (m) =>
      warnings.push(m)
    );

    expect(requests).toEqual(["https://example.com/c.png"]);
    expect(meta.coverBytes).toEqual(PNG);
    expect(meta.coverExt).toBe("png");
    expect(warnings).toEqual([]);
  });

  it("warns, and leaves the book coverless, when the download is refused", async () => {
    const { source, file } = await probe({ "n.md": note([]) });
    setRequestUrlImpl(async () => ({
      status: 404,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: null,
    }));
    const meta = baseMeta();
    const warnings: string[] = [];

    await source.attachCover(meta, { kind: "url", url: "https://example.com/gone.png" }, file("n.md"), (m) =>
      warnings.push(m)
    );

    expect(meta.coverBytes).toBeUndefined();
    expect(warnings).toEqual(["cover download failed: https://example.com/gone.png (status 404)"]);
  });

  it("reads a path plan from the vault", async () => {
    const { source, file, binaryReads } = await probe({ "n.md": note([]), "assets/c.png": PNG });
    const meta = baseMeta();

    await source.attachCover(meta, { kind: "path", path: "assets/c.png" }, file("n.md"), () => {});

    expect(binaryReads).toEqual(["assets/c.png"]);
    expect(meta.coverBytes).toEqual(PNG);
    expect(meta.coverExt).toBe("png");
  });

  it("warns by name for a path that is missing or of an unsupported type", async () => {
    const { source, file } = await probe({ "n.md": note([]), "c.bmp": PNG });
    const warnings: string[] = [];

    await source.attachCover(baseMeta(), { kind: "path", path: "nope.png" }, file("n.md"), (m) =>
      warnings.push(m)
    );
    await source.attachCover(baseMeta(), { kind: "path", path: "c.bmp" }, file("n.md"), (m) =>
      warnings.push(m)
    );

    expect(warnings).toEqual([
      "cover not found: nope.png (cover: nope.png)",
      "unsupported cover type: c.bmp (cover: c.bmp)",
    ]);
  });

  it("uses the first usable embed and skips unusable ones without a word", async () => {
    const { source, file } = await probe({
      "n.md": note([], "![[missing.png]] ![[anim.gif]] ![[good.png]]"),
      "anim.gif": PNG,
      "good.png": PNG,
    });
    const meta = baseMeta();
    const warnings: string[] = [];

    await source.attachCover(
      meta,
      { kind: "embeds", notePath: "n.md", targets: ["missing.png", "anim.gif", "good.png"] },
      file("n.md"),
      (m) => warnings.push(m)
    );

    expect(meta.coverBytes).toEqual(PNG);
    expect(warnings).toEqual([]);
  });

  it("does nothing for a none plan", async () => {
    const { source, file, binaryReads } = await probe({ "n.md": note([]) });
    const meta = baseMeta();

    await source.attachCover(meta, { kind: "none" }, file("n.md"), () => {});

    expect(meta).toEqual(baseMeta());
    expect(requests).toEqual([]);
    expect(binaryReads).toEqual([]);
  });
});

describe("NoteMetaSource.resolve: still plan() then attachCover()", () => {
  it.each(Object.entries(SITUATIONS))(
    "%s: gives the same book metadata and warnings as the two steps",
    async (_name, { files }) => {
      const whole = await probe(files);
      const wholeWarnings: string[] = [];
      const resolved = await whole.source.resolve(whole.file("n.md"), "n", (m) => wholeWarnings.push(m));

      const split = await probe(files);
      const splitWarnings: string[] = [];
      const plan = await split.source.plan(split.file("n.md"), "n");
      await split.source.attachCover(plan.meta, plan.cover, split.file("n.md"), (m) => splitWarnings.push(m));

      expect(resolved).toEqual(plan.meta);
      expect(wholeWarnings).toEqual(splitWarnings);
    }
  );
});
