import { describe, it, expect, vi } from "vitest";
import { resolveChapterAssets, type AssetVault } from "../src/core/chapter-assets";
import type { ChapterImage } from "../src/core/types";

// resolveChapterAssets is pure — no "obsidian" import — so these tests use a
// hand-rolled fake vault instead of the obsidian stub. `Ref` is a plain object
// so a test can assert the exact value locate() returned is what read() gets.
type Ref = { path: string };

function setup(opts: { files?: Record<string, Uint8Array>; readError?: unknown; addError?: unknown } = {}) {
  const files = opts.files ?? {};
  const locate = vi.fn((vaultPath: string, _from: string): Ref | null =>
    vaultPath in files ? { path: vaultPath } : null
  );
  const read = vi.fn(async (ref: Ref): Promise<ArrayBuffer> => {
    if (opts.readError !== undefined) throw opts.readError;
    const bytes = files[ref.path]!;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
  const vault: AssetVault<Ref> = { locate, read };
  const add = vi.fn((_href: string, _bytes: Uint8Array, _mediaType: string) => {
    if (opts.addError !== undefined) throw opts.addError;
  });
  const warn = vi.fn();
  return { vault, locate, read, add, warn };
}

// Called exactly once, with exactly these arguments.
function expectOnce(fn: ReturnType<typeof vi.fn>, ...args: unknown[]) {
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(...args);
}

const run = (images: ChapterImage[], s: ReturnType<typeof setup>, chapter = "notes/ch.md") =>
  resolveChapterAssets(images, chapter, s.vault, s.add, s.warn);

describe("resolveChapterAssets: images with bytes (rasterized Mermaid / math)", () => {
  it("adds the bytes under the href with its leading ../ stripped, and never touches the vault", async () => {
    const s = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    await run([{ newHref: "../images/img_001.png", bytes, mediaType: "image/png" }], s);
    expectOnce(s.add, "images/img_001.png", bytes, "image/png");
    expect(s.locate).not.toHaveBeenCalled();
    expect(s.read).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("strips only a LEADING ../, not one elsewhere in the href", async () => {
    const s = setup();
    await run([{ newHref: "images/../x.png", bytes: new Uint8Array([1]), mediaType: "image/png" }], s);
    expect(s.add.mock.calls[0]![0]).toBe("images/../x.png");
  });

  it("turns a rejecting builder into one 'could not be added' warning that names the image and the chapter", async () => {
    const s = setup({ addError: new Error("duplicate asset") });
    await run([{ newHref: "../images/img_002.png", bytes: new Uint8Array([1]), mediaType: "image/png" }], s);
    expectOnce(
      s.warn,
      "image could not be added: ../images/img_002.png — duplicate asset (referenced by notes/ch.md)"
    );
  });

  it("formats a bare thrown string the same way (anything can be thrown)", async () => {
    const s = setup({ addError: "boom" });
    await run([{ newHref: "../images/a.png", bytes: new Uint8Array([1]), mediaType: "image/png" }], s);
    expectOnce(s.warn, "image could not be added: ../images/a.png — boom (referenced by notes/ch.md)");
  });
});

describe("resolveChapterAssets: images read from the vault", () => {
  it("locates, reads and adds the file, taking the media type from the new href's extension", async () => {
    const png = new Uint8Array([9, 8, 7]);
    const s = setup({ files: { "pics/a.png": png } });
    await run([{ newHref: "../images/img_001.png", vaultPath: "pics/a.png" }], s);
    expect(s.add).toHaveBeenCalledTimes(1);
    const [href, bytes, mediaType] = s.add.mock.calls[0]!;
    expect(href).toBe("images/img_001.png");
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    expect(mediaType).toBe("image/png");
    expect(s.warn).not.toHaveBeenCalled();
  });

  it("hands read() the very object locate() returned", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) } });
    await run([{ newHref: "../images/img_001.png", vaultPath: "a.png" }], s);
    expect(s.read.mock.calls[0]![0]).toBe(s.locate.mock.results[0]!.value);
  });

  it("resolves a relative path against the image's own source note when it has one (FR-006)", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) } });
    await run([{ newHref: "../images/img_001.png", vaultPath: "a.png", sourcePath: "embedded/inner.md" }], s);
    expectOnce(s.locate, "a.png", "embedded/inner.md");
  });

  it("falls back to the chapter's own path when the image has no source note", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) } });
    await run([{ newHref: "../images/img_001.png", vaultPath: "a.png" }], s, "notes/host.md");
    expectOnce(s.locate, "a.png", "notes/host.md");
  });

  it("matches the extension case-insensitively", async () => {
    const s = setup({ files: { "a.PNG": new Uint8Array([1]) } });
    await run([{ newHref: "../images/img_001.PNG", vaultPath: "a.PNG" }], s);
    expect(s.add.mock.calls[0]![2]).toBe("image/png");
  });

  it("warns 'missing image' when the file cannot be located, and adds nothing", async () => {
    const s = setup();
    await run([{ newHref: "../images/img_001.png", vaultPath: "gone.png" }], s);
    expectOnce(s.warn, "missing image: gone.png (referenced by notes/ch.md)");
    expect(s.read).not.toHaveBeenCalled();
    expect(s.add).not.toHaveBeenCalled();
  });

  it("skips an extension outside the allowlist WITHOUT reading it, with its own warning", async () => {
    const s = setup({ files: { "pic.bmp": new Uint8Array([1]) } });
    await run([{ newHref: "../images/img_001.bmp", vaultPath: "pic.bmp" }], s);
    expectOnce(s.warn, "unsupported image type: pic.bmp (referenced by notes/ch.md)");
    expect(s.read).not.toHaveBeenCalled();
    expect(s.add).not.toHaveBeenCalled();
  });

  it("checks existence BEFORE the extension: a missing unsupported file is 'missing', not 'unsupported'", async () => {
    const s = setup();
    await run([{ newHref: "../images/img_001.bmp", vaultPath: "gone.bmp" }], s);
    expectOnce(s.warn, "missing image: gone.bmp (referenced by notes/ch.md)");
  });

  it("reports a failed read as 'missing image' (the historical wording), not a chapter failure", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) }, readError: new Error("EIO") });
    await expect(run([{ newHref: "../images/img_001.png", vaultPath: "a.png" }], s)).resolves.toBeUndefined();
    expectOnce(s.warn, "missing image: a.png (referenced by notes/ch.md)");
    expect(s.add).not.toHaveBeenCalled();
  });

  it("reports a builder that rejects a vault image as 'missing image' too", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) }, addError: new Error("nope") });
    await run([{ newHref: "../images/img_001.png", vaultPath: "a.png" }], s);
    expectOnce(s.warn, "missing image: a.png (referenced by notes/ch.md)");
  });

  it("treats an href with no extension as unsupported rather than guessing a type", async () => {
    const s = setup({ files: { a: new Uint8Array([1]) } });
    await run([{ newHref: "../images/noext", vaultPath: "a" }], s);
    expectOnce(s.warn, "unsupported image type: a (referenced by notes/ch.md)");
  });
});

describe("resolveChapterAssets: several images", () => {
  it("does nothing for an empty list", async () => {
    const s = setup();
    await run([], s);
    expect(s.add).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    expect(s.locate).not.toHaveBeenCalled();
  });

  it("one failing image never stops the later ones, and warnings stay in image order", async () => {
    const s = setup({ files: { "ok1.png": new Uint8Array([1]), "ok2.jpg": new Uint8Array([2]) } });
    await run(
      [
        { newHref: "../images/img_001.png", vaultPath: "ok1.png" },
        { newHref: "../images/img_002.png", vaultPath: "gone.png" },
        { newHref: "../images/img_003.bmp", bytes: undefined, vaultPath: "x.bmp" },
        { newHref: "../images/img_004.jpg", vaultPath: "ok2.jpg" },
        { newHref: "../images/img_005.png", bytes: new Uint8Array([5]), mediaType: "image/png" },
      ],
      s
    );
    expect(s.add.mock.calls.map((c) => c[0])).toEqual([
      "images/img_001.png",
      "images/img_004.jpg",
      "images/img_005.png",
    ]);
    expect(s.warn.mock.calls.map((c) => c[0])).toEqual([
      "missing image: gone.png (referenced by notes/ch.md)",
      "missing image: x.bmp (referenced by notes/ch.md)",
    ]);
  });

  it("mixes bytes-images and vault images in one chapter", async () => {
    const s = setup({ files: { "a.png": new Uint8Array([1]) } });
    await run(
      [
        { newHref: "../images/img_001.png", bytes: new Uint8Array([7]), mediaType: "image/png" },
        { newHref: "../images/img_002.png", vaultPath: "a.png" },
      ],
      s
    );
    expect(s.add).toHaveBeenCalledTimes(2);
    expect(s.locate).toHaveBeenCalledTimes(1);
  });
});
