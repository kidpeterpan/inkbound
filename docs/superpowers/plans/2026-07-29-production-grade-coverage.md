# Production-Grade Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All three export scopes honour their note's frontmatter (author, language, coverUrl, alias-as-title), and every file in `src/` is measured at ≥85% coverage on statements/lines/functions/branches, with lint, CI, README and version tooling around it.

**Architecture:** Extract the pure metadata-resolution logic out of `main.ts` into `src/metadata.ts` (approach C from the spec), then alias `obsidian` → the existing test stub inside vitest only, which makes `main.ts`/`settings.ts`/`render-adapter.ts`/`http.ts` importable and measurable for the first time. Coverage thresholds are enabled LAST, once the tests that satisfy them exist.

**Tech Stack:** TypeScript 5.5, esbuild 0.21 (`external: ["obsidian","electron"]`, unchanged), vitest 2 + jsdom + `@vitest/coverage-v8`, ESLint 9 flat config + typescript-eslint, Prettier 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-29-production-grade-coverage-design.md` (approved 2026-07-29).

## Global Constraints

- Repo: `~/ProjectG/obsidian-epub-export` (quote all paths — they contain `@`). Work on `main`. Baseline commit `5299e36`.
- `esbuild.config.mjs` MUST keep `external: ["obsidian", "electron"]`. The obsidian alias is a **vitest-only** `resolve.alias`. Never add an esbuild alias — it creates a second class identity and breaks `instanceof` plus the shared `NOTICES` array.
- `src/types.ts` is excluded from coverage (interfaces only, emits no JS). No other file gets excluded without a comment in `vitest.config.ts` justifying it.
- Coverage thresholds: `perFile: true`, 85 for statements, lines, functions, branches. Enabled in Task 9, not before.
- Never lower a threshold to make a build green. A file that genuinely cannot reach 85% gets an explicit per-file override with a written reason.
- Tests must not hit the network and must never write inside `~/Documents/pan_vault`. `main.ts` tests use `fs.mkdtemp` and clean up in `afterEach`.
- Do NOT change `deriveChapterTitle` in `src/naming.ts` or `src/epub-css.ts` — both are reserved for the user (Task 11 of the previous plan).
- Preserve every reviewed orchestrator invariant: `hrefByPath` built before the render loop, placeholder chapter on render failure, `imageCount` advanced before the asset loop, per-image failures non-fatal, local save before push, single warnings-summary Notice.
- Every task ends with `npm test` green, `npm run build` clean, `npx tsc --noEmit` clean, and one commit with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

## File Structure

```
src/
├── metadata.ts          NEW — pure frontmatter → ResolvedMeta
├── main.ts              MODIFIED — all 3 modes use resolveMeta; one shared cover helper
├── (unchanged) epub.ts render.ts render-adapter.ts collect.ts booxdrop.ts
│              http.ts naming.ts settings.ts settings-core.ts media-types.ts
│              epub-css.ts types.ts
tests/
├── metadata.test.ts     NEW
├── main.test.ts         NEW — integration via alias + temp dirs
├── http.test.ts         NEW
├── render-adapter.test.ts NEW
├── settings.test.ts     EXTENDED — settings tab UI
├── fixtures/obsidian-stub.ts  MODIFIED — injectable requestUrl
└── fixtures/vault-stub.ts     possibly extended
vitest.config.ts         MODIFIED — alias + coverage
eslint.config.mjs        NEW
.prettierrc              NEW (repo root; distinct from the vault's own)
.github/workflows/ci.yml NEW
scripts/version.ts       NEW
README.md                NEW
```

---

### Task 1: `src/metadata.ts` — pure frontmatter resolution

**Files:**
- Create: `src/metadata.ts`, `tests/metadata.test.ts`

**Interfaces:**
- Consumes: nothing (pure, zero imports)
- Produces: `MetaDefaults`, `ResolvedMeta`, `normalizeLanguage`, `resolveAuthor`, `resolveTitle`, `resolveCoverUrl`, `resolveMeta` — Task 2 imports all of these from `./metadata`.

- [ ] **Step 1: Write the failing tests**

`tests/metadata.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  normalizeLanguage, resolveAuthor, resolveTitle, resolveCoverUrl, resolveMeta,
} from "../src/metadata";

describe("normalizeLanguage", () => {
  it("passes through BCP-47-shaped codes, lowercased", () => {
    expect(normalizeLanguage("en", "th")).toBe("en");
    expect(normalizeLanguage("EN-GB", "th")).toBe("en-gb");
    expect(normalizeLanguage("tha", "en")).toBe("tha");
  });
  it("maps known language names case-insensitively", () => {
    expect(normalizeLanguage("thai", "en")).toBe("th");
    expect(normalizeLanguage("ENGLISH", "th")).toBe("en");
    expect(normalizeLanguage("Japanese", "th")).toBe("ja");
    expect(normalizeLanguage("chinese", "th")).toBe("zh");
    expect(normalizeLanguage("korean", "th")).toBe("ko");
  });
  it("falls back for unknown names rather than guessing", () => {
    expect(normalizeLanguage("klingon", "th")).toBe("th");
  });
  it("falls back for non-strings and blanks", () => {
    expect(normalizeLanguage(undefined, "th")).toBe("th");
    expect(normalizeLanguage(42, "th")).toBe("th");
    expect(normalizeLanguage(["en"], "th")).toBe("th");
    expect(normalizeLanguage("   ", "th")).toBe("th");
  });
});

describe("resolveAuthor", () => {
  it("trims a string author", () => {
    expect(resolveAuthor("  Robert C. Martin ", "Pan")).toBe("Robert C. Martin");
  });
  it("joins a YAML list author", () => {
    expect(resolveAuthor(["Kent Beck", "Martin Fowler"], "Pan")).toBe("Kent Beck, Martin Fowler");
  });
  it("drops empty entries when joining", () => {
    expect(resolveAuthor(["Kent Beck", "", "  "], "Pan")).toBe("Kent Beck");
  });
  it("falls back for blank, wrong-typed, or empty-array authors", () => {
    expect(resolveAuthor("", "Pan")).toBe("Pan");
    expect(resolveAuthor("   ", "Pan")).toBe("Pan");
    expect(resolveAuthor(undefined, "Pan")).toBe("Pan");
    expect(resolveAuthor(99, "Pan")).toBe("Pan");
    expect(resolveAuthor([], "Pan")).toBe("Pan");
    expect(resolveAuthor([1, 2], "Pan")).toBe("Pan");
  });
  it("uses Unknown when the fallback is itself empty", () => {
    expect(resolveAuthor(undefined, "")).toBe("Unknown");
    expect(resolveAuthor(undefined, "   ")).toBe("Unknown");
  });
});

describe("resolveTitle", () => {
  it("prefers a string alias", () => {
    expect(resolveTitle("clean_code", "Clean Code")).toBe("Clean Code");
  });
  it("prefers the first non-empty array alias", () => {
    expect(resolveTitle("clean_code", ["", "  ", "Clean Code", "CC"])).toBe("Clean Code");
  });
  it("falls back to basename for empty, absent, or wrong-typed aliases", () => {
    expect(resolveTitle("clean_code", undefined)).toBe("clean_code");
    expect(resolveTitle("clean_code", "")).toBe("clean_code");
    expect(resolveTitle("clean_code", [])).toBe("clean_code");
    expect(resolveTitle("clean_code", ["", "   "])).toBe("clean_code");
    expect(resolveTitle("clean_code", 7)).toBe("clean_code");
  });
});

describe("resolveCoverUrl", () => {
  it("accepts http and https, trimmed", () => {
    expect(resolveCoverUrl(" https://x.com/c.jpg ")).toBe("https://x.com/c.jpg");
    expect(resolveCoverUrl("HTTP://x.com/c.png")).toBe("HTTP://x.com/c.png");
  });
  it("rejects anything else", () => {
    expect(resolveCoverUrl("assets/cover.png")).toBeNull();
    expect(resolveCoverUrl("file:///c.png")).toBeNull();
    expect(resolveCoverUrl(undefined)).toBeNull();
    expect(resolveCoverUrl(["https://x.com/c.jpg"])).toBeNull();
    expect(resolveCoverUrl("")).toBeNull();
  });
});

describe("resolveMeta", () => {
  const defaults = { fallbackAuthor: "Pan", language: "th" };

  it("resolves every field from real vault-shaped frontmatter", () => {
    expect(
      resolveMeta(
        {
          aliases: ["Clean Code"],
          author: "Robert C. Martin",
          language: "english",
          coverUrl: "https://m.media-amazon.com/images/I/71T7aD3EOTL.jpg",
          tags: ["book", "main"],
        },
        "clean_code",
        defaults
      )
    ).toEqual({
      title: "Clean Code",
      author: "Robert C. Martin",
      language: "en",
      coverUrl: "https://m.media-amazon.com/images/I/71T7aD3EOTL.jpg",
    });
  });

  it("falls back on every field when frontmatter is absent", () => {
    expect(resolveMeta(undefined, "grokking_algorithms", defaults)).toEqual({
      title: "grokking_algorithms",
      author: "Pan",
      language: "th",
      coverUrl: null,
    });
  });

  it("handles the Thai book shape", () => {
    const m = resolveMeta({ language: "thai", author: "Aditya Y. Bhargava" }, "grokking_algorithms", defaults);
    expect(m.language).toBe("th");
    expect(m.author).toBe("Aditya Y. Bhargava");
    expect(m.title).toBe("grokking_algorithms");
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run tests/metadata.test.ts`
Expected: FAIL — cannot resolve `../src/metadata`.

- [ ] **Step 3: Implement**

`src/metadata.ts`:
```ts
// Pure frontmatter → EPUB metadata resolution. Zero "obsidian" imports so
// vitest loads it directly. Shared by all three export scopes in main.ts, which
// previously mined frontmatter inline for folder exports only.

export interface MetaDefaults {
  fallbackAuthor: string;
  language: string;
}

export interface ResolvedMeta {
  title: string;
  author: string;
  language: string;
  coverUrl: string | null;
}

// Deliberately small: an unrecognised name falls back rather than guessing at a
// code the reader would then be stuck with.
const LANGUAGE_NAMES: Record<string, string> = {
  thai: "th",
  english: "en",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
};

const BCP47_SHAPE = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

function firstNonEmptyString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim() !== "") return item.trim();
    }
  }
  return null;
}

export function normalizeLanguage(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return fallback;
  if (BCP47_SHAPE.test(value)) return value.toLowerCase();
  return LANGUAGE_NAMES[value.toLowerCase()] ?? fallback;
}

export function resolveAuthor(raw: unknown, fallback: string): string {
  if (Array.isArray(raw)) {
    const names = raw.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim());
    if (names.length > 0) return names.join(", ");
  } else {
    const single = firstNonEmptyString(raw);
    if (single) return single;
  }
  const fb = fallback.trim();
  return fb === "" ? "Unknown" : fb;
}

export function resolveTitle(basename: string, aliases: unknown): string {
  return firstNonEmptyString(aliases) ?? basename;
}

export function resolveCoverUrl(raw: unknown): string | null {
  const value = firstNonEmptyString(typeof raw === "string" ? raw : null);
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

export function resolveMeta(
  frontmatter: Record<string, unknown> | undefined,
  basename: string,
  defaults: MetaDefaults
): ResolvedMeta {
  const fm = frontmatter ?? {};
  return {
    title: resolveTitle(basename, fm.aliases),
    author: resolveAuthor(fm.author, defaults.fallbackAuthor),
    language: normalizeLanguage(fm.language, defaults.language),
    coverUrl: resolveCoverUrl(fm.coverUrl),
  };
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run tests/metadata.test.ts` → all pass. Then `npm test` (full suite) and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/metadata.ts tests/metadata.test.ts
git commit -m "feat: pure frontmatter metadata resolution shared by every export scope"
```

---

### Task 2: Wire `metadata.ts` into `main.ts` for all three scopes

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `resolveMeta`, `MetaDefaults` from `./metadata`; existing `ExportMeta` from `./types`
- Produces: no new exports. Behaviour change only: every scope's `ExportMeta` now derives from frontmatter, and cover fetching is one private helper.

- [ ] **Step 1: Replace `baseMeta` with a frontmatter-driven builder**

Delete the existing `baseMeta(title, author?)` helper and the inline frontmatter reads inside `exportFolder`. Add these two private methods (keep `titleFor()` untouched — it supplies *chapter* titles):

```ts
  private metaDefaults(): MetaDefaults {
    return {
      fallbackAuthor: this.settings.fallbackAuthor,
      language: this.settings.language || "th",
    };
  }

  // Resolves EPUB metadata from a note's own frontmatter, then downloads the
  // cover if one is declared. A cover failure degrades to a coverless export
  // (spec: never fail an export over artwork).
  private async metaFromNote(file: TFile | null, fallbackBasename: string): Promise<ExportMeta> {
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const resolved = resolveMeta(
      fm as Record<string, unknown> | undefined,
      file ? file.basename : fallbackBasename,
      this.metaDefaults()
    );
    const meta: ExportMeta = {
      title: resolved.title,
      author: resolved.author,
      language: resolved.language,
    };
    if (resolved.coverUrl) {
      try {
        const res = await requestUrl({ url: resolved.coverUrl, throw: false });
        if (res.status === 200) {
          const isPng = (res.headers["content-type"] ?? "").includes("png");
          meta.coverBytes = new Uint8Array(res.arrayBuffer);
          meta.coverExt = isPng ? "png" : "jpg";
        } else {
          console.warn("[epub-export] cover download failed", resolved.coverUrl, `status ${res.status}`);
        }
      } catch (e) {
        console.warn("[epub-export] cover download failed", resolved.coverUrl, e);
      }
    }
    return meta;
  }
```

- [ ] **Step 2: Point all three scopes at it**

```ts
  async exportSingle(file: TFile) {
    await this.runExport({ meta: await this.metaFromNote(file, file.basename), files: [file] });
  }

  async exportLinked(file: TFile) {
    const paths = bfsLinked(this.app.metadataCache.resolvedLinks, file.path, this.settings.linkDepth);
    const files = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
    await this.runExport({ meta: await this.metaFromNote(file, file.basename), files });
  }
```

In `exportFolder`, keep the existing md-file discovery, `pickIndexNote` detection and `orderChapters` ordering exactly as they are, then replace the whole meta/cover block with:

```ts
    const meta = await this.metaFromNote(index, folder.name);
    await this.runExport({ meta, files });
  }
```

Remove the now-unused `fm` variable and the old cover-fetch block from `exportFolder`. Keep the `mdFiles.length === 0` guard and the `files.unshift(index)` ordering.

- [ ] **Step 3: Verify the whole pipeline still builds and behaves**

Run: `npm test` (74 tests + Task 1's new ones), `npx tsc --noEmit`, `npm run build` — all clean. Then prove behaviour against the real vault with the CLI harness (this is the only executable check of `main.ts` until Task 4):

```bash
npm run local-export -- folder "02. areas/03. reading/grokking_algorithms"
```
Expected: still 102/102 images and all invariants PASS, and now `language` resolved from the index note's `language: thai` → `th`, `author: Aditya Y. Bhargava`, cover fetched. Then:

```bash
npm run local-export -- note "02. areas/03. reading/clean_code/clean_code.md"
```
Expected — this is the bug being fixed: `author` is now `Robert C. Martin` (was `Unknown`), `language` is `en` (from `language: english`, was `th`), and a cover is embedded. Confirm by inspecting the OPF of the produced file.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: every export scope resolves metadata from its note's frontmatter"
```

---

### Task 3: Coverage tooling + vitest obsidian alias + injectable stub `requestUrl`

**Files:**
- Modify: `vitest.config.ts`, `package.json`, `tests/fixtures/obsidian-stub.ts`, `scripts/local-export.ts` (only if the stub change requires it)

**Interfaces:**
- Produces: `npm run test:coverage`; a working `obsidian` alias so later tasks can import `src/main.ts` in vitest; `setRequestUrlImpl(fn)` / `resetRequestUrlImpl()` exported from the stub.

- [ ] **Step 1: Install the coverage provider**

Run: `npm i -D @vitest/coverage-v8@^2` (must match vitest 2.x).

- [ ] **Step 2: Rewrite `vitest.config.ts`** (thresholds deliberately absent — Task 9 adds them)

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // VITEST ONLY. The npm "obsidian" package ships .d.ts with no runtime JS,
      // so anything importing it is otherwise unloadable in tests. esbuild keeps
      // it external — never add an alias there: a second transpiled copy of the
      // stub would give main.ts a different TFile identity and break instanceof.
      obsidian: fileURLToPath(new URL("./tests/fixtures/obsidian-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Interfaces only — emits no JS, so v8 reports 0/0 and would fail any threshold.
      exclude: ["src/types.ts"],
      reporter: ["text", "html", "lcov"],
    },
  },
});
```

- [ ] **Step 3: Make the stub's `requestUrl` injectable**

The stub currently fetches for real, which would make unit tests network-dependent. Keep real fetch as the default (`scripts/local-export.ts` relies on it) and add an override. In `tests/fixtures/obsidian-stub.ts`, rename the existing implementation to `realRequestUrl` and add:

```ts
export type RequestUrlImpl = (request: RequestUrlParamLike | string) => Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: unknown;
}>;

let requestUrlImpl: RequestUrlImpl | null = null;

/** Install a deterministic requestUrl for tests. */
export function setRequestUrlImpl(impl: RequestUrlImpl): void {
  requestUrlImpl = impl;
}

/** Restore the default real-network implementation (used by the CLI harness). */
export function resetRequestUrlImpl(): void {
  requestUrlImpl = null;
}

export async function requestUrl(request: RequestUrlParamLike | string) {
  return (requestUrlImpl ?? realRequestUrl)(request);
}
```

Keep the returned object's shape identical to what the existing implementation returns (`status`, lowercase `headers`, `arrayBuffer`, `text`, `json`) so `src/http.ts` and `main.ts`'s cover fetch are unaffected.

- [ ] **Step 4: Add the script and capture the baseline**

Add to `package.json` scripts: `"test:coverage": "vitest run --coverage"`.

Run: `npm run test:coverage`
Expected: all tests pass; a coverage table prints. **Record the per-file numbers in your report** — that table is the work-list for Tasks 5-9. `main.ts` and `settings.ts` will be near 0% at this point; that is expected.

Also re-run `npm run local-export -- note "02. areas/03. reading/clean_code/clean_code.md"` to confirm the stub refactor did not break the harness's real-fetch path (the cover must still download).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: coverage provider, vitest obsidian alias, injectable stub requestUrl"
```

---

### Task 4: `tests/http.test.ts` + `tests/render-adapter.test.ts`

**Files:**
- Create: `tests/http.test.ts`, `tests/render-adapter.test.ts`

**Interfaces:**
- Consumes: the Task 3 alias; `setRequestUrlImpl`/`resetRequestUrlImpl`; `obsidianHttp` from `src/http`; `renderUnitToChapter` from `src/render-adapter`
- Produces: proof the alias works end to end — if these two suites pass, `src/main.ts` is importable in Task 5.

- [ ] **Step 1: Write `tests/http.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { setRequestUrlImpl, resetRequestUrlImpl } from "./fixtures/obsidian-stub";
import { obsidianHttp } from "../src/http";

afterEach(() => resetRequestUrlImpl());

describe("obsidianHttp", () => {
  it("forwards url, method, headers and body to requestUrl", async () => {
    const seen: unknown[] = [];
    setRequestUrlImpl(async (req) => {
      seen.push(req);
      return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json: null };
    });
    const body = new Uint8Array([1, 2]).buffer;
    const res = await obsidianHttp({ url: "http://d/x", method: "POST", headers: { A: "b" }, body });
    expect(res.status).toBe(204);
    expect(seen[0]).toMatchObject({ url: "http://d/x", method: "POST", headers: { A: "b" } });
  });

  it("defaults the method to GET", async () => {
    let method: string | undefined;
    setRequestUrlImpl(async (req) => {
      method = typeof req === "string" ? undefined : req.method;
      return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json: null };
    });
    await obsidianHttp({ url: "http://d/" });
    expect(method).toBe("GET");
  });

  it("returns the response text so booxdrop can inspect the envelope", async () => {
    setRequestUrlImpl(async () => ({
      status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
      text: '{"successful":true}', json: null,
    }));
    expect((await obsidianHttp({ url: "http://d/" })).text).toBe('{"successful":true}');
  });

  it("survives a text getter that throws", async () => {
    setRequestUrlImpl(async () => {
      const res = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: null };
      Object.defineProperty(res, "text", {
        get() { throw new Error("binary body"); },
      });
      return res as never;
    });
    const res = await obsidianHttp({ url: "http://d/" });
    expect(res.status).toBe(200);
    expect(res.text).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write `tests/render-adapter.test.ts`**

Build a minimal `app` object with just what `renderUnitToChapter` touches (`metadataCache.getFirstLinkpathDest`) and a `Component` from the stub. Cases, each asserted on observable output:

```ts
import { describe, it, expect } from "vitest";
import { Component, TFile } from "./fixtures/obsidian-stub";
import { renderUnitToChapter } from "../src/render-adapter";

function appWith(dest: TFile | null) {
  return { metadataCache: { getFirstLinkpathDest: () => dest } } as never;
}

describe("renderUnitToChapter", () => {
  it("strips frontmatter and dataview, returning a bare XHTML fragment", async () => {
    const r = await renderUnitToChapter(
      appWith(null), new Component(),
      "---\ntags: [x]\n---\n# Hi\n\n```dataview\nLIST\n```\n",
      "note.md", new Map(), "/vault", 0
    );
    expect(r.xhtmlBody).toContain("Hi");
    expect(r.xhtmlBody).not.toContain("tags:");
    expect(r.xhtmlBody).toContain("dynamic content omitted");
    expect(r.xhtmlBody).not.toContain("xmlns");
  });

  it("threads startImageIndex into image numbering", async () => {
    const r = await renderUnitToChapter(
      appWith(null), new Component(),
      "![cap](fig.png)", "note.md", new Map(), "/vault", 4
    );
    expect(r.images).toEqual([{ vaultPath: "fig.png", newHref: "../images/img_005.png" }]);
    expect(r.xhtmlBody).toContain("../images/img_005.png");
  });

  it("removes its scratch element even when rendering throws", async () => {
    const before = document.body.childElementCount;
    // A component whose render path fails: pass a null app so the resolve
    // callback explodes mid-pipeline.
    await expect(
      renderUnitToChapter(null as never, new Component(), "[[x]]", "n.md", new Map(), "/v", 0)
    ).rejects.toBeTruthy();
    expect(document.body.childElementCount).toBe(before);
  });
});
```

If the third case cannot be made to throw through the stub, replace it with a case that asserts `document.body.childElementCount` returns to its starting value after a *successful* render (the `finally` cleanup) and note in your report why the throwing variant was not viable.

- [ ] **Step 3: Verify**

Run: `npx vitest run tests/http.test.ts tests/render-adapter.test.ts`, then `npm test`, then `npm run test:coverage` and report the new `http.ts` / `render-adapter.ts` percentages.

- [ ] **Step 4: Commit**

```bash
git add tests/http.test.ts tests/render-adapter.test.ts
git commit -m "test: cover the http and render adapters through the vitest obsidian alias"
```

---

### Task 5: `tests/main.test.ts` — orchestrator happy paths

**Files:**
- Create: `tests/main.test.ts`

**Interfaces:**
- Consumes: the alias; the stub's `Plugin`/`TFile`/`TFolder`/`NOTICES`/`setRequestUrlImpl`; `tests/fixtures/vault-stub.ts` if it helps
- Produces: a reusable in-test fixture (`makePlugin`, `readOpf`, `entries`) that Task 6 extends. Export nothing — Task 6 appends to this same file.

- [ ] **Step 1: Build the fixture**

The plugin writes with node `fs` to `settings.outputFolder`, so tests use a real temp dir. Construct the vault entirely in memory so no vault files are touched:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import EpubExportPlugin from "../src/main";
import {
  TFile, TFolder, FileSystemAdapter, NOTICES,
  setRequestUrlImpl, resetRequestUrlImpl,
} from "./fixtures/obsidian-stub";

interface NoteSpec { path: string; content: string; frontmatter?: Record<string, unknown>; }

let outDir: string;
let warnings: string[];
let originalWarn: typeof console.warn;

beforeEach(async () => {
  outDir = await fs.mkdtemp(join(tmpdir(), "epub-export-test-"));
  NOTICES.length = 0;
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
});

afterEach(async () => {
  console.warn = originalWarn;
  resetRequestUrlImpl();
  await fs.rm(outDir, { recursive: true, force: true });
});

function makeVault(notes: NoteSpec[], binaries: Record<string, Uint8Array> = {}) {
  const files = new Map<string, TFile>();
  const meta = new Map<string, { frontmatter?: Record<string, unknown> }>();
  for (const n of notes) {
    const f = new TFile(n.path);
    files.set(n.path, f);
    meta.set(n.path, { frontmatter: n.frontmatter });
  }
  for (const p of Object.keys(binaries)) files.set(p, new TFile(p));

  const app = {
    vault: {
      adapter: new FileSystemAdapter("/vault"),
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      cachedRead: async (f: TFile) => notes.find((n) => n.path === f.path)?.content ?? "",
      readBinary: async (f: TFile) => {
        const b = binaries[f.path];
        if (!b) throw new Error(`no binary ${f.path}`);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    },
    metadataCache: {
      getFileCache: (f: TFile) => meta.get(f.path) ?? {},
      getFirstLinkpathDest: (linkpath: string) =>
        [...files.values()].find((f) => f.basename === linkpath || f.path === linkpath) ?? null,
      resolvedLinks: {} as Record<string, Record<string, number>>,
    },
    workspace: { getActiveFile: () => null, on: () => ({}) },
  };
  return { app, files };
}

function makePlugin(app: unknown, settings: Partial<Record<string, unknown>> = {}) {
  const plugin = new EpubExportPlugin(app as never, {} as never);
  plugin.settings = {
    outputFolder: outDir, linkDepth: 1, language: "th",
    fallbackAuthor: "", booxUrl: "", pushAfterExport: false, ...settings,
  } as never;
  return plugin;
}

async function readEpub(name: string) {
  const bytes = await fs.readFile(join(outDir, name));
  const zip = await JSZip.loadAsync(bytes);
  return {
    zip,
    names: Object.keys(zip.files),
    opf: await zip.file("OEBPS/package.opf")!.async("string"),
    nav: await zip.file("OEBPS/nav.xhtml")!.async("string"),
    chapter: (n: number) => zip.file(`OEBPS/text/chapter_${String(n).padStart(3, "0")}.xhtml`)!.async("string"),
  };
}
```

Adjust the `new EpubExportPlugin(...)` call and the `TFile`/`FileSystemAdapter` constructor arguments to match the stub's actual signatures — read `tests/fixtures/obsidian-stub.ts` first and follow what it defines rather than these illustrative shapes. If the stub's `Plugin` constructor or `TFile` cannot be driven this way, extend the stub to mirror the real Obsidian API (never to a convenient fake shape) and say so in your report.

- [ ] **Step 2: Write the happy-path tests**

Cases, all asserting on the produced EPUB bytes / Notices / disk state:

1. **Single note** — one note with `aliases: ["Clean Code"]`, `author: "Robert C. Martin"`, `language: "english"`. Assert: file `clean_code.epub` exists in `outDir`; OPF contains `<dc:title>Clean Code</dc:title>`, `<dc:creator>Robert C. Martin</dc:creator>`, `<dc:language>en</dc:language>`; exactly one chapter in the spine; the success Notice names the output path. **This is the regression test for the reported bug.**
2. **Fallback metadata** — a note with no frontmatter and `fallbackAuthor: "Pan"`: OPF has `<dc:creator>Pan</dc:creator>`, `<dc:language>th</dc:language>`, title = basename.
3. **Folder export ordering** — a `TFolder` containing `book.md` (tags `[book, main]`, `author`, `language: thai`) plus `02_b.md`, `01_a.md`, `10_c.md`. Assert: 4 chapters; nav order is index, `01_a`, `02_b`, `10_c`; `<dc:language>th</dc:language>`.
4. **Folder with no index note** — no note tagged book+main and none named after the folder: title falls back to the folder name, author to the fallback, no cover.
5. **Linked export at depth 1** — `resolvedLinks` where `a.md → b.md, c.md` and `c.md → d.md`: 3 chapters (a, b, c), `d.md` absent; then with `linkDepth: 2`, 4 chapters.
6. **Cover embedded** — frontmatter `coverUrl: "https://x/c.jpg"`, `setRequestUrlImpl` returning status 200 with `content-type: image/jpeg` and 4 bytes. Assert `OEBPS/images/cover.jpg` present and the OPF declares `properties="cover-image"`; repeat with `image/png` → `cover.png`.
7. **Image embedded from a relative markdown path** — note body `![cap](fig.png)` with a binary registered at `fig.png`. Assert the chapter body references `../images/img_001.png` and `OEBPS/images/img_001.png` exists.
8. **Overwrite** — run the same export twice; assert it succeeds both times and the file is the second run's bytes (write a sentinel first, e.g. pre-create the target with 1 byte and assert size grows).

- [ ] **Step 3: Verify**

Run: `npx vitest run tests/main.test.ts`, then `npm test`, then `npm run test:coverage` and report `main.ts`'s new percentage.

- [ ] **Step 4: Commit**

```bash
git add tests/main.test.ts
git commit -m "test: orchestrator happy paths for single, folder and linked exports"
```

---

### Task 6: `tests/main.test.ts` — orchestrator failure paths

**Files:**
- Modify: `tests/main.test.ts`

**Interfaces:**
- Consumes: the Task 5 fixture in the same file
- Produces: coverage of every degradation branch the spec's error table promises

- [ ] **Step 1: Add the failure-path tests**

Each asserts the promised degradation, not just that nothing threw:

1. **Chapter read throws → placeholder, later chapters survive.** Make `cachedRead` reject for the middle file of three. Assert: still 3 chapters; chapter 2 contains `chapter failed to render`; chapter 3 contains the third note's content (proving numbering stayed aligned); a warning line contains `chapter skipped`; the warnings-summary Notice says `Exported with 1 warning`.
2. **Cross-chapter link still resolves after a skip.** In the same shape, note 1 links `[[third]]`; assert chapter 1's body links to `chapter_003.xhtml`.
3. **Missing image → warning, export continues.** Body references `![](gone.png)` with no binary registered. Assert: export succeeds, a warning matches `missing image: gone.png`, and no `OEBPS/images/` entry was added.
4. **Unsupported image type → warning + skipped.** Register a binary at `pic.bmp` and reference it. Assert a warning matches `unsupported image type` and no asset entry exists.
5. **`readBinary` throws mid-chapter → chapter still exported.** Assert the chapter is present (not a placeholder) and a `missing image` warning was recorded.
6. **Cover fetch non-200 → coverless + console.warn.** Assert no `cover.` entry, a warning containing `cover download failed`, and a successful export Notice.
7. **Cover fetch throws → same degradation.** `setRequestUrlImpl` that rejects.
8. **Push success.** `pushAfterExport: true`, `booxUrl: "http://boox:8085"`, `setRequestUrlImpl` returning 200 with `{"successful":true}`. Assert a Notice contains `pushed to Boox` and the request URL ended with `/api/library/upload`.
9. **Push failure leaves the local file intact.** Same setup, impl returns 500. Assert the file still exists in `outDir` and a Notice matches `saved locally, push failed`.
10. **Push disabled** — `pushAfterExport: false` with a `booxUrl` set: assert `requestUrl` was never called for the upload path.
11. **Empty folder** — a `TFolder` with no markdown children: assert a Notice matches `no markdown notes` and no file was written.
12. **Fatal export error** — make `EpubBuilder` fail by injecting an unwritable `outputFolder` (e.g. a path under a file, not a directory). Assert a Notice matches `EPUB export failed` and the error was logged.

- [ ] **Step 2: Verify and report the gap list**

Run: `npm test` then `npm run test:coverage`. If `main.ts` is still under 85%, list in your report the exact uncovered line ranges from the HTML/text report — do not add contrived tests purely to move the number; instead name which real behaviours they represent so the controller can decide.

- [ ] **Step 3: Commit**

```bash
git add tests/main.test.ts
git commit -m "test: orchestrator failure paths — placeholders, warnings, push and cover degradation"
```

---

### Task 7: `tests/settings.test.ts` — settings tab UI

**Files:**
- Modify: `tests/settings.test.ts`, and `tests/fixtures/obsidian-stub.ts` only if `Setting`'s fluent API needs filling in

**Interfaces:**
- Consumes: `EpubExportSettingTab` from `src/settings`; the stub's `Setting`/`PluginSettingTab`/`Notice`
- Produces: coverage of every `onChange` closure and the Test-connection button

- [ ] **Step 1: Read the stub's `Setting` implementation first**

Open `tests/fixtures/obsidian-stub.ts` around the `Setting` class. To reach 85% of `settings.ts`, every `addText`/`addToggle`/`addSlider`/`addButton` callback must run and each registered `onChange`/`onClick` must be invocable. If the stub records the controls, drive them through whatever it exposes; if it does not, extend it to capture the created controls (mirroring the real `Setting` API — `setName`, `setDesc`, `addText`, `addToggle`, `addSlider`, `addButton`, each returning `this`) and expose a way to fetch them by setting name.

- [ ] **Step 2: Write the tests**

Keep the existing `settings-core` tests untouched and add a `EpubExportSettingTab` block covering:

1. `display()` renders a setting for each of the six fields plus the Test-connection button (assert by name).
2. Changing the output folder, language, fallback author and Boox URL each write to `plugin.settings` and trigger `saveSettings` (spy by replacing the method).
3. The language field falling back: setting it to `""` stores `"th"`.
4. The Boox URL is trimmed.
5. The link-depth slider stores a number and is limited to 1–3 (assert the limits passed to `setLimits`).
6. The push toggle flips `pushAfterExport`.
7. Test connection with no URL set → Notice matches `Set the device URL first`.
8. Test connection reachable (`setRequestUrlImpl` → 200) → Notice matches `reachable`.
9. Test connection unreachable (impl rejects) → Notice matches `NOT reachable`.

- [ ] **Step 3: Verify**

Run: `npm test`, `npm run test:coverage`; report `settings.ts`'s percentage.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: settings tab controls and the BooxDrop connection test"
```

---

### Task 8: Close remaining per-file coverage gaps

**Files:**
- Modify: whichever `tests/*.test.ts` the coverage report indicts

**Interfaces:**
- Consumes: the `npm run test:coverage` table
- Produces: every non-excluded file in `src/` at ≥85% on all four metrics

- [ ] **Step 1: Get the exact gap list**

Run: `npm run test:coverage` and read `coverage/index.html` (or the text report's uncovered-line column). Write the per-file list of uncovered lines into your report BEFORE writing tests.

- [ ] **Step 2: Add tests for real uncovered behaviour, file by file**

Rules for this task:
- Every new test must assert an observable behaviour that a user or caller could depend on. No test may exist purely to execute a line.
- If a line is genuinely unreachable (a defensive branch that cannot occur given the callers), do NOT contort a test to reach it — record it in your report as a candidate for either a code simplification or a documented per-file threshold exception.
- Likely candidates based on the code: `epub.ts` (the `cryptoRandomUuid` fallback branch when `crypto.randomUUID` is absent; cover with a `webp`/`svg` asset), `render.ts` (the scheme classifications — `blob:`, `file:`, `mailto:`, uppercase, protocol-relative, empty src, `app://` outside basePath, `#fragment` stripping), `booxdrop.ts` (`push` when the injected http throws), `collect.ts` (same-level cross-source BFS dedup), `settings-core.ts` (the singular "1 warning" wording; the trailing-slash strip in `resolveOutputPath`), `naming.ts` (already high), `media-types.ts`, `epub-css.ts` (covered by import).

- [ ] **Step 3: Verify**

Run: `npm run test:coverage` — every file at ≥85% on statements, lines, functions and branches. Paste the final table into your report.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: close per-file coverage gaps to the 85% bar"
```

---

### Task 9: Enable the 85% per-file thresholds

**Files:**
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: the coverage state Task 8 reached
- Produces: a failing build when any file regresses below 85%

- [ ] **Step 1: Add the thresholds**

In `vitest.config.ts`'s `coverage` block:

```ts
      thresholds: {
        perFile: true,
        statements: 85,
        lines: 85,
        functions: 85,
        branches: 85,
      },
```

- [ ] **Step 2: Prove the gate works in both directions**

Run: `npm run test:coverage` → must exit 0.

Then prove it actually fails: temporarily add an uncovered exported function to a small file (e.g. `src/media-types.ts`), re-run, and confirm a non-zero exit naming that file. Revert the temporary change and re-run to confirm green. Include both outputs in your report — a gate never observed failing is not a gate.

- [ ] **Step 3: If a file cannot reach 85%**

Add a per-file override in the same config with a comment stating the file, the number, and why (e.g. an untestable Electron-only branch). Do NOT lower the global numbers.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts
git commit -m "test: enforce 85% per-file coverage thresholds"
```

---

### Task 10: ESLint + Prettier

**Files:**
- Create: `eslint.config.mjs`, `.prettierrc`, `.prettierignore`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run lint`, `npm run lint:fix`, `npm run format`, `npm run format:check`

- [ ] **Step 1: Install**

Run: `npm i -D eslint@^9 typescript-eslint@^8 prettier@^3`

- [ ] **Step 2: Write the configs**

`eslint.config.mjs`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "coverage/**", "local-out/**", "node_modules/**", ".local-export-bundle.cjs"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
```

`.prettierrc`:
```json
{
  "printWidth": 110,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5"
}
```

`.prettierignore`:
```
main.js
coverage
local-out
node_modules
*.epub
```

Scripts to add:
```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write \"{src,tests,scripts}/**/*.ts\" \"*.{json,mjs,md}\"",
"format:check": "prettier --check \"{src,tests,scripts}/**/*.ts\" \"*.{json,mjs,md}\""
```

- [ ] **Step 3: Run and fix**

Run: `npm run lint`. Fix real findings in source. If a rule proves inappropriate for this codebase, disable it in the config with a comment rather than sprinkling inline disables. Then `npm run format` and re-run `npm test`, `npx tsc --noEmit`, `npm run build` — formatting must not change behaviour.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: ESLint and Prettier configuration"
```

---

### Task 11: README + version tooling

**Files:**
- Create: `README.md`, `scripts/version.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run version:check`, `npm run version:bump -- <semver>`

- [ ] **Step 1: Write `scripts/version.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";

const pkgPath = "package.json";
const manifestPath = "manifest.json";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const write = (p: string, o: unknown) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");

const mode = process.argv[2];

if (mode === "check") {
  const pkg = read(pkgPath), manifest = read(manifestPath);
  if (pkg.version !== manifest.version) {
    console.error(`version mismatch: package.json ${pkg.version} != manifest.json ${manifest.version}`);
    process.exit(1);
  }
  console.log(`versions match: ${pkg.version}`);
} else if (mode === "bump") {
  const next = process.argv[3];
  if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
    console.error("usage: npm run version:bump -- <major.minor.patch>");
    process.exit(1);
  }
  const pkg = read(pkgPath), manifest = read(manifestPath);
  pkg.version = next;
  manifest.version = next;
  write(pkgPath, pkg);
  write(manifestPath, manifest);
  console.log(`bumped to ${next} in package.json and manifest.json`);
} else {
  console.error("usage: version.ts check | bump <semver>");
  process.exit(1);
}
```

Scripts: `"version:check": "tsx scripts/version.ts check"`, `"version:bump": "tsx scripts/version.ts bump"`.

Run `npm run version:check` → must print a match. Then verify the failure path: temporarily edit `manifest.json`'s version, re-run, confirm exit 1 and the message, revert.

- [ ] **Step 2: Write `README.md`**

Sections, each written out (no placeholders): what the plugin does (three export scopes, EPUB 3, BooxDrop push); requirements (Obsidian 1.5+, desktop only); install for development (`npm install`, `npm run deploy`, enable in Obsidian's Community plugins, noting the reload icon is needed when the folder is added while Obsidian runs); the settings reference (all six settings and their defaults); how frontmatter is used (`aliases`, `author`, `language` with the five-name mapping, `coverUrl`, and `tags: [book, main]` for index-note detection); development commands table (`build`, `dev`, `test`, `test:coverage`, `lint`, `format`, `epubcheck`, `local-export`, `version:check`); the CLI harness and what it can and cannot prove (link to the spec's risk section); a pointer to `docs/booxdrop-probe.md` for re-probing the device API; and the architecture note that `src/` splits into pure modules (unit-tested) and Obsidian adapters (tested through the vitest alias).

- [ ] **Step 3: Verify**

Run: `npm run lint`, `npm run format:check`, `npm test`, `npm run build`. Read the README once as if new to the project and fix anything that would not actually work when followed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: README and version-parity tooling for package.json/manifest.json"
```

---

### Task 12: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every script added above
- Produces: a workflow that runs the full gate on push and pull request

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npx tsc --noEmit
      - run: npm run test:coverage
      - run: npm run build
      - run: npm run version:check
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/
```

- [ ] **Step 2: Verify locally, since the repo has no remote**

The workflow cannot run here, so prove the pipeline it encodes passes by running the same sequence in order and pasting the results:

```bash
npm ci && npm run lint && npm run format:check && npx tsc --noEmit && npm run test:coverage && npm run build && npm run version:check
```

Note in your report that CI is inert until the repo gains a remote and is pushed.

- [ ] **Step 3: Commit**

```bash
git add .github
git commit -m "ci: run lint, typecheck, coverage gate and build on push"
```

---

## Self-Review Notes

- **Spec coverage:** metadata feature (Tasks 1-2, incl. the array-author crash and folder-mode language); coverage infra + alias + injectable requestUrl (Task 3); measuring the previously unmeasurable adapters (Tasks 4-7); per-file gaps (Task 8); the 85% gate itself, proven to fail (Task 9); ESLint/Prettier (10); README + version parity (11); CI (12). Spec out-of-scope items get no tasks — correct.
- **Deliberate ordering choice:** thresholds land in Task 9, not Task 3, so Tasks 4-8 are not blocked by a gate that cannot yet pass. This is called out in the Global Constraints so it is not mistaken for an oversight.
- **Type consistency:** `resolveMeta(frontmatter, basename, defaults)` in Task 1 is called exactly that way in Task 2's `metaFromNote`; `ResolvedMeta.coverUrl` is `string | null` and Task 2 guards with `if (resolved.coverUrl)`; `MetaDefaults` field names (`fallbackAuthor`, `language`) match `metaDefaults()`.
- **Known judgment call:** Task 5's fixture code is illustrative of shape, not verbatim-correct against the stub's constructors — the task explicitly instructs the implementer to read the stub first and follow its real signatures, and to extend the stub toward the real Obsidian API if needed. This is the one place the plan cannot be literal, because the stub was written by an earlier task and its constructor arity is not recorded here.
