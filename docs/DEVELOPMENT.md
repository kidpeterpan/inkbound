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

| Command                            | What it does                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | Production build (`esbuild.config.mjs production`) → `main.js`.                                                                                     |
| `npm run dev`                      | Development build in watch mode (rebuilds `main.js` on save; stays running until stopped).                                                          |
| `npm test`                         | Runs the vitest suite once.                                                                                                                         |
| `npm run test:coverage`            | Runs the suite with coverage; enforces an 85% per-file threshold (statements, lines, functions, branches) — see "Testing and its limits" below.     |
| `npm run deploy`                   | Builds, then copies `main.js`/`manifest.json`/`styles.css` into a vault's plugin folder (see "Install for development" above).                      |
| `npm run epubcheck`                | Builds a sample EPUB (`scripts/build-sample.ts`) and, if `epubcheck` is installed (`brew install epubcheck`), validates it against the EPUB 3 spec. |
| `npm run local-export`             | Runs the real export orchestrator against a real vault on disk, outside Obsidian — see "The CLI harness" below.                                     |
| `npm run version:check`            | Fails (exit 1) if `package.json` and `manifest.json` disagree on `version`.                                                                         |
| `npm run version:bump -- <semver>` | Writes a new `version` to both `package.json` and `manifest.json` at once.                                                                          |
| `npm run lint`                     | Runs ESLint (`eslint.config.mjs`) over the project.                                                                                                  |
| `npm run lint:fix`                 | Runs ESLint with `--fix`, applying any auto-fixable findings.                                                                                       |
| `npm run format`                   | Runs Prettier with `--write` over `src`, `tests`, `scripts`, and top-level JSON/mjs/Markdown files.                                                 |
| `npm run format:check`             | Runs Prettier with `--check` (no writes); used to verify formatting without changing files.                                                         |

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
2. **`npm run epubcheck`** — validates a built EPUB against the EPUB 3 spec
   with the industry-standard validator.
3. **Manual testing inside Obsidian, on the actual Boox device** — the only
   gate that exercises the real `MarkdownRenderer`, the real DOM Obsidian
   produces, and the real BooxDrop HTTP API.

See the design doc's "Risks and honest limits" section
(`docs/superpowers/specs/2026-07-29-production-grade-coverage-design.md`) for
the full reasoning.

**Not yet verified on a real device or in real Obsidian rendering**, as of
this writing:

- The `app://` image-`src` branch (images Obsidian serves through an
  `app://` URL rather than a plain vault-relative path).
- `$$` display-math blocks.
- Note transclusion (`![[note]]` embeds).
- The `CHROME_SELECTORS` cleanup list in `src/render.ts` (UI chrome elements
  stripped from rendered HTML) — its selectors are believed correct but have
  not been confirmed against a live Obsidian render.
- Non-Latin tags (e.g. Thai-language `#tags`), for the inline-tag-to-plain-text
  rewrite in `cleanupDom`.

Treat exports that exercise any of the above with extra scrutiny until they
have been checked by hand. (The user-facing subset of this list — the parts
that affect whether an export will look right on a device — is summarized in
the README's "Known limitations" section.)

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
  `epub-css.ts`, `media-types.ts`, `settings-core.ts` — have zero imports of
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
