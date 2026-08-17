import { describe, it, expect, afterEach, vi } from "vitest";
import { canShareEpub, shareEpub, setShareHost, type ShareTarget } from "../src/share";

const target = (): ShareTarget => ({
  fileName: "deep-work.epub",
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: "application/epub+zip",
});

afterEach(() => {
  setShareHost(null); // module state discipline, same as setSvgRasterizer/setThaiFontLoader
});

// ── H1–H3: capability detection ───────────────────────────────────────────
//
// FR-017 makes sharing a bonus, not a dependency. These assert the plugin only
// PROMISES what the device can actually do — Obsidian exposes no sharing API of
// its own, and mobile WebView support for the Web Share API varies by platform
// and version, so "unavailable" must be an ordinary, silent outcome.
describe("canShareEpub", () => {
  it("H1: false when the device has no share host at all (desktop, or an older WebView)", () => {
    setShareHost({});
    expect(canShareEpub()).toBe(false);
  });

  it("H2: false when the host can share but cannot confirm it handles FILES", () => {
    // share() without canShare() cannot tell us files are supported, and a
    // share offer that fails on tap is worse than no offer at all.
    setShareHost({ share: async () => undefined });
    expect(canShareEpub()).toBe(false);
  });

  it("H3: false when the host reports that it cannot share this payload", () => {
    setShareHost({ canShare: () => false, share: async () => undefined });
    expect(canShareEpub()).toBe(false);
  });

  it("true only when the host confirms both capabilities", () => {
    setShareHost({ canShare: () => true, share: async () => undefined });
    expect(canShareEpub()).toBe(true);
  });
});

// ── H4–H6: sharing never turns a successful export into a failure ─────────
describe("shareEpub", () => {
  it("H4: resolves true and hands the file to the host", async () => {
    const share = vi.fn(async () => undefined);
    setShareHost({ canShare: () => true, share });
    await expect(shareEpub(target())).resolves.toBe(true);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("H5: a dismissed share sheet resolves false — it does not throw", async () => {
    // Cancelling is the single most likely outcome of tapping share, and the
    // Web Share API reports it by REJECTING. Treating that as an error would
    // report a perfectly good export as failed.
    setShareHost({
      canShare: () => true,
      share: async () => {
        throw new DOMException("Share canceled", "AbortError");
      },
    });
    await expect(shareEpub(target())).resolves.toBe(false);
  });

  it("H6: an unexpected host failure resolves false rather than propagating", async () => {
    setShareHost({
      canShare: () => true,
      share: async () => {
        throw new Error("WebView exploded");
      },
    });
    await expect(shareEpub(target())).resolves.toBe(false);
  });

  it("resolves false without calling the host when sharing is unavailable", async () => {
    const share = vi.fn(async () => undefined);
    setShareHost({ canShare: () => false, share });
    await expect(shareEpub(target())).resolves.toBe(false);
    expect(share).not.toHaveBeenCalled();
  });

  it("never throws for any host shape, including a host that throws synchronously", async () => {
    setShareHost({
      canShare: () => true,
      share: () => {
        throw new Error("sync throw");
      },
    });
    await expect(shareEpub(target())).resolves.toBe(false);
  });
});

// ── Degradation paths that only a hostile or unusual runtime reaches ───────
describe("share host degradation", () => {
  it("falls back to the real navigator when no host is installed, and reports no capability", () => {
    // jsdom's navigator has no canShare/share, which is exactly the shape of a
    // desktop Electron renderer and of older mobile WebViews.
    setShareHost(null);
    expect(canShareEpub()).toBe(false);
  });

  it("treats a canShare() that throws as 'cannot share' rather than propagating", () => {
    setShareHost({
      canShare: () => {
        throw new TypeError("bad payload");
      },
      share: async () => undefined,
    });
    expect(canShareEpub()).toBe(false);
    return expect(shareEpub(target())).resolves.toBe(false);
  });

  it("probes without constructing a File when the runtime has no File constructor", async () => {
    const RealFile = globalThis.File;
    // Some WebViews expose share() but not the File constructor; probing must
    // degrade rather than throw a ReferenceError mid-export.
    (globalThis as { File?: unknown }).File = undefined;
    try {
      const share = vi.fn(async () => undefined);
      setShareHost({ canShare: (d) => Array.isArray((d as { files: unknown[] }).files), share });
      expect(canShareEpub()).toBe(true);
      await expect(shareEpub(target())).resolves.toBe(true);
    } finally {
      (globalThis as { File?: unknown }).File = RealFile;
    }
  });
});
