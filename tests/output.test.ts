import { describe, it, expect } from "vitest";
import { resolveDestination, resolveMobileOutputPath } from "../src/output";
import { resolveOutputPath, DEFAULT_MOBILE_OUTPUT_FOLDER } from "../src/settings-core";

const HOME = "/Users/pan";
const settings = (outputFolder: string, mobileOutputFolder: string) => ({
  outputFolder,
  mobileOutputFolder,
});

// ── C1–C3, C5: the FR-006 desktop-regression guard ────────────────────────
//
// These are the tests that must never be relaxed. They assert that desktop
// resolution is exactly what it was before mobile support existed, and that a
// phone's setting cannot reach it. If one of these ever needs "updating" to
// accommodate a change, desktop output has moved and that is a defect.
describe("resolveDestination — desktop is unchanged (FR-006)", () => {
  it("C1: an empty output folder still resolves to ~/Downloads", () => {
    const dest = resolveDestination("desktop", settings("", "Exports"), "deep-work", HOME);
    expect(dest.path).toBe("/Users/pan/Downloads/deep-work.epub");
    // Identical to the pre-feature resolver, which still exists and is still used.
    expect(dest.path).toBe(resolveOutputPath("", "deep-work", HOME));
  });

  it("C2: ~ still expands against the home directory", () => {
    const dest = resolveDestination("desktop", settings("~/Books", "Exports"), "deep-work", HOME);
    expect(dest.path).toBe("/Users/pan/Books/deep-work.epub");
    expect(dest.path).toBe(resolveOutputPath("~/Books", "deep-work", HOME));
  });

  it("C2b: an absolute path and trailing slashes behave exactly as before", () => {
    expect(resolveDestination("desktop", settings("/tmp/out//", "Exports"), "b", HOME).path).toBe(
      resolveOutputPath("/tmp/out//", "b", HOME)
    );
  });

  it("C3: the mobile setting is never read on desktop", () => {
    const a = resolveDestination("desktop", settings("~/Books", "Exports"), "x", HOME);
    const b = resolveDestination("desktop", settings("~/Books", "SomethingElse/Deep"), "x", HOME);
    expect(a.path).toBe(b.path);
  });

  it("C5: the desktop setting is never read on mobile — not even as a fallback", () => {
    const a = resolveDestination("mobile", settings("~/Downloads", "Exports"), "x", HOME);
    const b = resolveDestination("mobile", settings("/somewhere/else", "Exports"), "x", HOME);
    expect(a.path).toBe(b.path);
    expect(a.path).not.toContain("Downloads");
  });

  it("C5b: mobile resolution never consults homedir, so an empty homedir is harmless", () => {
    const withHome = resolveDestination("mobile", settings("", "Exports"), "x", HOME);
    const withoutHome = resolveDestination("mobile", settings("", "Exports"), "x", "");
    expect(withHome.path).toBe(withoutHome.path);
  });
});

// ── C4, C6–C8: mobile resolution ──────────────────────────────────────────
describe("resolveDestination — mobile", () => {
  it("C4: resolves to a vault-relative path inside the configured folder", () => {
    const dest = resolveDestination("mobile", settings("", "Exports"), "deep-work", "");
    expect(dest.path).toBe("Exports/deep-work.epub");
    expect(dest.kind).toBe("mobile");
  });

  it("C4b: supports a nested folder", () => {
    expect(resolveDestination("mobile", settings("", "Books/EPUB"), "x", "").path).toBe("Books/EPUB/x.epub");
  });

  it("C6: a folder that tries to escape the vault degrades to the default", () => {
    const dest = resolveDestination("mobile", settings("", "../../etc"), "x", "");
    expect(dest.path).toBe(`${DEFAULT_MOBILE_OUTPUT_FOLDER}/x.epub`);
  });

  it("C6b: the resolved mobile path is always vault-relative — never absolute, never ..", () => {
    for (const folder of ["../secrets", "/etc", "~/Downloads", "", "   ", "a/../../b"]) {
      const path = resolveDestination("mobile", settings("", folder), "x", "").path;
      expect(path.startsWith("/")).toBe(false);
      expect(path.includes("..")).toBe(false);
      expect(path).toMatch(/\.epub$/);
    }
  });

  it("C7: fileName is the last path segment, on both platforms", () => {
    const m = resolveDestination("mobile", settings("", "Exports"), "deep-work", "");
    const d = resolveDestination("desktop", settings("~/Books", "Exports"), "deep-work", HOME);
    expect(m.fileName).toBe("deep-work.epub");
    expect(d.fileName).toBe("deep-work.epub");
    expect(m.fileName).toBe(m.path.split("/").pop());
    expect(d.fileName).toBe(d.path.split("/").pop());
  });

  it("C8: displayPath is non-empty and actionable on both platforms", () => {
    const m = resolveDestination("mobile", settings("", "Exports"), "x", "");
    const d = resolveDestination("desktop", settings("", "Exports"), "x", HOME);
    expect(m.displayPath.length).toBeGreaterThan(0);
    expect(d.displayPath.length).toBeGreaterThan(0);
    expect(d.displayPath).toBe(d.path);
  });
});

describe("resolveMobileOutputPath", () => {
  it("joins a coerced folder with the slug", () => {
    expect(resolveMobileOutputPath("Exports", "a-book")).toBe("Exports/a-book.epub");
  });

  it("coerces hostile folders before joining", () => {
    expect(resolveMobileOutputPath("../x", "a")).toBe(`${DEFAULT_MOBILE_OUTPUT_FOLDER}/a.epub`);
    expect(resolveMobileOutputPath("/Exports/", "a")).toBe("Exports/a.epub");
  });
});
