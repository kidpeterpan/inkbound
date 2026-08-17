# Development

This file covers building Inkbound from source, the test suite and what it
does and does not prove, the CLI harness, and the codebase's architecture.
It is aimed at contributors, not at users of the plugin — see the main
[`README.md`](../README.md) for how to install and use Inkbound.

## Install for development

There is no packaged release; this plugin is installed by building it and
copying the build output into a vault's plugins folder.

```bash
npm install
npm run deploy
```

`npm run deploy` runs a production build (`npm run build`) and then
`scripts/deploy.sh`, which copies `main.js`, `manifest.json`, and `styles.css`
into `<vault>/.obsidian/plugins/inkbound/`. The destination vault defaults
to `~/Documents/pan_vault`; override it by setting
the `VAULT` environment variable, e.g. `VAULT=/path/to/vault npm run deploy`.

Then, in Obsidian: **Settings → Community plugins** and enable **Inkbound**.

> [!WARNING]
> If Obsidian was already running when the plugin folder was copied in, the
> new plugin will not appear in the Community plugins list until you click
> the **refresh** icon at the top of that list (or restart Obsidian).
> Community plugins must also be enabled overall (not in Restricted Mode) for
> the toggle to be available at all.

## Development commands

| Command                            | What it does                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | Production build (`esbuild.config.mjs production`) → `main.js`.                                                                                      |
| `npm run dev`                      | Development build in watch mode (rebuilds `main.js` on save; stays running until stopped).                                                           |
| `npm test`                         | Runs the vitest suite once.                                                                                                                          |
| `npm run test:coverage`            | Runs the suite with coverage; enforces an 85% per-file threshold (statements, lines, functions, branches) — see "Testing and its limits" below.      |
| `npm run deploy`                   | Builds, then copies `main.js`/`manifest.json`/`styles.css` into a vault's plugin folder (see "Install for development" above).                       |
| `npm run epubcheck`                | Builds a sample EPUB (`scripts/build-sample.ts`) and, if `epubcheck` is installed (`brew install epubcheck`), validates it against the EPUB 3 spec.  |
| `npm run local-export`             | Runs the real export orchestrator against a real vault on disk, outside Obsidian — see "The CLI harness" below.                                      |
| `npm run check-mobile-safe`        | Fails if the built `main.js` would not load on Obsidian mobile — see "The mobile load gate" below. Requires a build first; runs after `build` in CI. |
| `npm run version:check`            | Fails (exit 1) if `package.json` and `manifest.json` disagree on `version`.                                                                          |
| `npm run version:bump -- <semver>` | Writes a new `version` to both `package.json` and `manifest.json` at once.                                                                           |
| `npm run lint`                     | Runs ESLint (`eslint.config.mjs`) over the project.                                                                                                  |
| `npm run lint:fix`                 | Runs ESLint with `--fix`, applying any auto-fixable findings.                                                                                        |
| `npm run format`                   | Runs Prettier with `--write` over `src`, `tests`, `scripts`, and top-level JSON/mjs/Markdown files.                                                  |
| `npm run format:check`             | Runs Prettier with `--check` (no writes); used to verify formatting without changing files.                                                          |

## Testing and its limits

The 85%-per-file coverage gate (`npm run test:coverage`) is real, but it is
important to understand what it does and does not prove. The `obsidian`
npm package ships only TypeScript type declarations — no runtime
JavaScript — so it cannot be imported by a test runner. To make the
Obsidian-facing modules (`main.ts`, `settings.ts`, `render-adapter.ts`,
`http.ts`) importable and measurable at all, `vitest.config.ts` aliases the
`obsidian` import to a hand-written stub at
`tests/fixtures/obsidian-stub.ts` — **for vitest only**; the real build
(`esbuild.config.mjs`) keeps `obsidian` external and untouched, so what ships
to Obsidian is not affected by the stub.

This means coverage measures how much of _our own logic_ the test suite
exercises against that stub's behaviour. **It does not prove the plugin
behaves correctly inside real Obsidian** — the stub's `MarkdownRenderer`, for
instance, is `marked` plus post-processing, which is not what Obsidian itself
renders. A green coverage gate is a necessary check, not a sufficient one.

The gates that actually touch real artifacts, in increasing order of realism:

1. **`npm run local-export`** (the CLI harness, below) — runs the real
   orchestrator against a real vault on disk and inspects the real EPUB zip,
   but still outside Obsidian.
2. **`npm run check-mobile-safe`** — proves the built bundle would load on
   mobile at all: no node-builtin `require()` executes at load, and the bundle
   evaluates without throwing in a runtime that has a DOM but no `Buffer`, no
   `process`, and no `require`. See "The mobile load gate" below.
3. **`npm run epubcheck`** — validates a built EPUB against the EPUB 3 spec
   with the industry-standard validator.
4. **Manual testing inside Obsidian, on the actual Boox device — and, since
   008-mobile-support, on a real iPhone/iPad and a real Android device** — the only
   gate that exercises the real `MarkdownRenderer`, the real DOM Obsidian
   produces, and the real BooxDrop HTTP API.

See the design doc's "Risks and honest limits" section
(`docs/superpowers/specs/2026-07-29-production-grade-coverage-design.md`) for
the full reasoning.

**Not yet verified on a real device or in real Obsidian rendering**, as of
this writing:

- The `app://` image-`src` branch (images Obsidian serves through an
  `app://` URL rather than a plain vault-relative path).
- The `CHROME_SELECTORS` cleanup list in `src/render.ts` (UI chrome elements
  stripped from rendered HTML) — its selectors are believed correct but have
  not been confirmed against a live Obsidian render.
- Non-Latin tags (e.g. Thai-language `#tags`), for the inline-tag-to-plain-text
  rewrite in `cleanupDom`.
- Math placeholder survival in real Obsidian: `<span data-inkbound-math>`
  inline-HTML placeholders are relied on by the math pipeline (005-latex-math)
  and verified to pass through the marked stub; a live-Obsidian export should
  confirm the real renderer preserves them (the pipeline's missing-placeholder
  guard degrades gracefully with a warning if it ever doesn't).
- Thai font rendering on the actual Boox (006-thai-font): the embedded Noto
  Sans Thai is valid per epubcheck and NeoReader is documented to support
  `@font-face` embedded fonts, but the compound-vowel rendering has not been
  eye-checked on the device yet.

**Mobile (008-mobile-support) — nothing below has run on a real phone.** The
whole feature is unverified in the only sense that counts; the automated gates
prove the bundle _can_ load and that the pure logic is right, not that Obsidian
mobile does what we expect:

- That the plugin loads and enables at all, on iOS and on Android. The
  `check-mobile-safe` gate proves the bundle evaluates with no node builtin and
  no `Buffer` in a jsdom-backed simulation — a real WebView is still a
  different runtime.
- Whether the vault adapter's `writeBinary` lands the book where the completion
  notice claims, and whether the user can reach it through the device's own
  file access.
- The shape of mobile `app://` image URLs. The basename fallback in
  `rewriteImages` is shape-agnostic by design (and its empty-`basePath` guard is
  now correct — see below), but no real mobile URL has been observed.
- Whether Mermaid and math rasterize at all. `defaultRasterizeSvg` uses
  `Blob` → `Image` → `canvas`, which exist in mobile WebViews, but iOS
  WKWebView is strict about SVG in `<img>` — especially the `foreignObject`
  content Mermaid emits for labels. Failure already degrades to the inline SVG
  with a warning, so this is a fidelity question, not a safety one. **Record
  the outcome per OS.**
- Whether `navigator.canShare({files})` is available in the mobile WebView on
  either platform. Absence is a supported outcome (FR-017 — the command is
  hidden, the export still succeeds), so "not available on iOS" is a result
  worth writing down, not a bug.
- Thai rendering on a phone, and Boox push from a phone over Wi-Fi.
- Whether a **nested** mobile output folder (`Books/EPUB`) is created correctly.
  `writeBook` creates it segment by segment because Obsidian's
  `DataAdapter.mkdir` is not documented to create intermediate parents; the
  test stub is non-recursive to match, but only a device settles it.
- Memory: `lastShareTarget` holds the finished book's bytes in plugin memory
  until the next export, so the share command has something to hand over. For a
  large image-heavy book on a phone that is a real, if modest, resident cost —
  worth watching during the 50-note check below.

Note two things that WERE fixed rather than merely being listed, because they
were provably broken:

- `rewriteImages`' `app://` branch computed `decoded.indexOf(basePath)` and
  treated `-1` as "fall back to the basename". With an empty `basePath` —
  which is every mobile export, since the mobile adapter is not a
  `FileSystemAdapter` — `indexOf("")` returns `0`, so the fallback never ran and
  the whole `app://` URL was returned as a vault path. This was a latent desktop
  bug too, for any non-`FileSystemAdapter` vault.
- The `.ttf` binary loader emitted `Buffer.from(...)` at module top level under
  esbuild's `platform: "node"`. `Buffer` does not exist in a mobile WebView, so
  the plugin would have failed to load even with the `fs`/`os` imports fixed.
  Fonts are now inlined as base64 and decoded with `atob`.

Treat exports that exercise any of the above with extra scrutiny until they
have been checked by hand. (The user-facing subset of this list — the parts
that affect whether an export will look right on a device — is summarized in
the README's "Known limitations" section.)

## Bundled fonts (.ttf loader trio)

`src/fonts/NotoSansThai-{Regular,Bold}.ttf` are static wght 400/700 instances
instantiated from the official Noto Sans Thai variable font (google/fonts
`ofl/notosansthai/NotoSansThai[wdth,wght].ttf`) via
`fontTools.varLib.instancer.instantiateVariableFont(f, {"wght": w, "wdth": 100})`.
The trio that keeps them working in all three environments:

1. `esbuild.config.mjs` + `scripts/local-export.ts` set `loader: { ".ttf": "binary" }`
   → the bytes are inlined as base64 `Uint8Array` default exports.
2. `src/fonts/fonts.d.ts` declares `module "*.ttf"` for `tsc`.
3. `vitest.config.ts` aliases the exact `.ttf` paths to
   `tests/fixtures/font-bytes.ts` (vitest has no binary loader).

The binary imports live ONLY in `src/font-assets.ts` (plus the injectable
`setThaiFontLoader` seam), so pure modules and tsx-run scripts
(`build-sample.ts`) never have to load a `.ttf`.

## Obsidian plugin-review lint

Before (re)submitting to the community plugin registry, reproduce the
review's lint locally:

```bash
npm i -D eslint-plugin-obsidianmd
# config: flat config with parser @typescript-eslint/parser + parserOptions.project,
# rule "obsidianmd/prefer-create-el" — then:
npx eslint --config eslint.obsidian-review.mjs "src/**/*.ts"
```

Known requirements the review enforces beyond repo lint: no `innerHTML`
assignment from function parameters (use DOMParser — see math.ts), no
control chars in regex literals (PUA sentinel instead of `\x01`), no
`document.createElement` for tags with Obsidian shortcuts (prefer
`createDiv()`/`createSpan()` over `createEl("div")`/`createEl("span")`),
no Promise-returning `SettingDefinitionAction`s (return `void`), and
explicit casts over mathjax-full's `any`-typed adaptor surface.

## The CLI harness

`npm run local-export -- <note|folder|linked> <vault-relative-path>` (via
`scripts/local-export.ts`) runs the _real_ `src/main.ts` orchestrator —
`exportSingle`/`exportFolder`/`exportLinked`, unmodified — against a real
vault on disk, with no Obsidian installation involved. It bundles `main.ts`
with esbuild and redirects its `require("obsidian")` at runtime to the same
`tests/fixtures/obsidian-stub.ts` instance the harness itself loads, so
`instanceof TFile`-style checks inside the orchestrator work correctly. It
then reports: every Notice the plugin raised, every `console.warn` line, the
output file's path and size, a manifest/zip inventory check on the produced
EPUB, per-chapter image counts, and a "dangling image" invariant (every
`../images/X` reference actually present in the zip).

This is more real than the vitest suite (it runs against actual vault files
and produces an actual EPUB zip) but is still not Obsidian: it uses the same
stub-backed `MarkdownRenderer`, so it cannot validate real Obsidian rendering
either. Its value is catching orchestration/wiring bugs (missing chapters,
broken image paths, wrong ordering) against real content, cheaply and
repeatedly, before a manual device test.

## Architecture

`src/` splits into two kinds of modules:

- **Pure modules** — `metadata.ts`, `collect.ts`, `naming.ts`, `epub.ts`,
  `epub-css.ts`, `media-types.ts`, `settings-core.ts`, `math.ts`, `fonts.ts` — have zero imports of
  the `obsidian` package, so vitest loads and unit-tests them directly.
- **Obsidian adapters** — `main.ts`, `settings.ts`, `render-adapter.ts`,
  `http.ts` — import `obsidian` for its types and runtime globals (`Plugin`,
  `Notice`, `TFile`, `requestUrl`, etc.) and are only importable in tests
  through the `vitest.config.ts` alias to `tests/fixtures/obsidian-stub.ts`
  described above under "Testing and its limits".

`types.ts` holds shared interfaces only (no runtime code) and is excluded
from the coverage report for that reason.

## BooxDrop endpoint notes

BooxDrop's upload API is unofficial and firmware-versioned. What was
verified, when, how to re-probe it after a firmware update, and how the
client handles application-level failures (a 2xx HTTP status with
`"successful": false` in the JSON body) are documented in
[`booxdrop-probe.md`](./booxdrop-probe.md) — read that before touching
`src/booxdrop.ts`'s `UPLOAD_PATH`.

## The mobile load gate (`scripts/check-mobile-safe.mjs`)

Mobile support has one failure mode that dwarfs the rest: the plugin does not
misbehave on a phone, it **fails to load at all**, before `onload()` runs and
before any `Platform.isDesktopApp` guard could execute. Nothing in `src/` looks
wrong when this happens, because the cause is in how the bundle is built.

`esbuild.config.mjs` sets `platform: "node"`. That has two consequences a
reader of `src/` cannot see:

1. Node builtins are externalized, so a **static** `import ... from "fs"`
   becomes a `require("fs")` at the top of `main.js`. Mobile has no `require`.
   A **dynamic** `await import("fs")` inside a function body becomes a
   `require()` inside that body, which mobile never reaches — that is the
   permitted form, and `src/main.ts` uses it for its desktop-only write path.
2. esbuild emits the _Node_ variants of its runtime helpers. The `binary`
   loader's helper is `__toBinaryNode`, built on `Buffer.from(...)` — a Node
   global absent from mobile WebViews, executed at module top level. This is
   why the bundled fonts use the `base64` loader and are decoded with `atob`
   in `src/font-assets.ts`.

The gate checks both, and the second check is the important one: it **loads the
bundle** in a jsdom-backed context with no `Buffer`, no `process`, and a
`require` that throws for node builtins. Simulating the failing environment
catches hazards that scanning for known symptoms cannot — hazard (2) above was
found this way, with no `require()` anywhere in it for a scan to notice.

It is not a substitute for a real device. It proves the bundle _evaluates_; it
says nothing about whether Obsidian mobile then behaves as expected.
