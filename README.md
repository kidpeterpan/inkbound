# Inkbound

An Obsidian plugin that exports notes as EPUB 3 books and, optionally, pushes
them straight to an e-ink reader over the local network.

## Installation

**From a GitHub release (recommended):**

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/kidpeterpan/inkbound/releases/latest).
2. Copy all three files into
   `<vault>/.obsidian/plugins/inkbound/` (create the folder if it doesn't
   exist).
3. In Obsidian, go to **Settings → Community plugins** and enable
   **Inkbound**.

> [!WARNING]
> If Obsidian was already running when the plugin folder was added, the new
> plugin will not appear in the Community plugins list until you click the
> **refresh** icon at the top of that list (or restart Obsidian).

**From the community plugin store:** this plugin is **not yet listed** in
Obsidian's community plugin browser — install it manually via the steps
above.

## What it does

Three export scopes, each reachable from the command palette or a right-click
context menu:

- **Export note to EPUB** — the active note becomes a single-chapter book.
- **Export folder as EPUB (active note's folder)** — every Markdown note in
  the active note's parent folder becomes one book. If the folder has a note
  tagged `book` + `main` in its frontmatter, that note is used as the index
  (and its own frontmatter supplies the book's metadata); otherwise a note
  whose filename matches the folder name is used as the index if one exists.
  Remaining notes become chapters, ordered by a leading `NN_` numeric prefix
  first, then alphabetically for anything unprefixed.
- **Export note + linked notes to EPUB** — the active note plus every note it
  links to, followed breadth-first out to a configurable depth (see
  **Default link depth** below), becomes one book.

Every scope produces a real EPUB 3 file (via a hand-rolled builder, not a
third-party EPUB library) with a chapter list, embedded images, and metadata
(`dc:title`, `dc:creator`, `dc:language`, and a cover image when one is
declared) resolved from the exporting note's own frontmatter. If **Push after
export** is enabled and a **Device URL** is set, the finished EPUB is also
uploaded to a Boox e-ink device running the BooxDrop app — the local file is
always written first, so a failed push never loses the export.

## Requirements

- Obsidian **1.5.0** or newer (`minAppVersion` in `manifest.json`).
- **Desktop only** (`isDesktopOnly: true` in `manifest.json`) — the plugin
  reads and writes files on the local filesystem (via Node's `fs`) and is not
  available on Obsidian mobile.

### Why this plugin needs filesystem access

This plugin uses Node's `fs` module directly, outside the Obsidian vault API.
That is intentional, not an oversight:

- It writes the generated `.epub` file to the output folder configured in
  **Settings → Inkbound → Output folder** (default `~/Downloads`) — a
  location outside the vault, because the whole point is producing a file an
  e-reader (or the BooxDrop app on a Boox device) can pick up directly.
- It reads image files referenced by the exported notes through Obsidian's
  vault API, not raw `fs` calls.
- It never writes anywhere else on disk.

`isDesktopOnly: true` is set in `manifest.json` for exactly this reason —
direct filesystem access has no mobile equivalent.

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

## Settings

Found under **Settings → Community plugins → Inkbound**:

| Setting                  | Default                      | Purpose                                                                                                                                                                               |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output folder            | `""` (empty → `~/Downloads`) | Absolute path or `~/…` folder the EPUB is written to. Existing files of the same name are overwritten.                                                                                |
| Default link depth       | `1`                          | How many hops of wikilinks **Export note + linked notes** follows outward from the active note (1–3, via a slider).                                                                   |
| Language (`dc:language`) | `"th"`                       | Fallback language used when a note has no usable `language` frontmatter field.                                                                                                        |
| Fallback author          | `""` (empty → `"Unknown"`)   | Used as `dc:creator` when a note/index has no usable `author` frontmatter field.                                                                                                      |
| Device URL               | `""`                         | The BooxDrop device's address as shown in the BooxDrop app, e.g. `http://192.168.1.42:8085`. Required for pushing.                                                                    |
| Push after export        | `false`                      | When enabled (and a Device URL is set), every export is uploaded to the device after being saved locally. Below this toggle is a **Test connection** button to verify the Device URL. |

## Frontmatter fields

Every export scope resolves its book metadata from the exporting note's own
frontmatter (the active note for single/linked exports, the detected index
note for folder exports — see "What it does" above). Recognised fields:

- **`aliases`** — the book title (`dc:title`). The first non-empty string, or
  first non-empty string element if `aliases` is a list, is used; otherwise
  the note's filename (without extension) is used. This is deliberately the
  _book_ title only — per-chapter titles come from a separate mechanism
  (heading/filename-based) and are unaffected by `aliases`.
- **`author`** — `dc:creator`. A non-empty string is used as-is; a list of
  strings is joined with `", "`; anything else (including an empty value)
  falls back to the **Fallback author** setting, or `"Unknown"` if that is
  also empty.
- **`language`** — `dc:language`. A value already shaped like a BCP-47 tag
  (e.g. `en`, `en-GB`, `th`) is lowercased and used as-is. Otherwise, an exact
  (case-insensitive) match against this fixed table is used:

  | Frontmatter value | `dc:language` |
  | ----------------- | ------------- |
  | `thai`            | `th`          |
  | `english`         | `en`          |
  | `japanese`        | `ja`          |
  | `chinese`         | `zh`          |
  | `korean`          | `ko`          |

  Anything else — an unrecognised name, a non-string value, or a missing
  field — falls back to the **Language** setting. Unknown names deliberately
  fall back rather than guess at a code.

- **`coverUrl`** — the book's cover image. Must be a string starting with
  `http://` or `https://`; anything else (including a vault-relative path) is
  treated as no cover. A cover that fails to download degrades the export to
  coverless rather than failing it.
- **`tags: [book, main]`** — used only for **folder** exports, to pick which
  note in the folder is the index/metadata source (see "What it does"
  above).

## Development commands

| Command                            | What it does                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | Production build (`esbuild.config.mjs production`) → `main.js`.                                                                                     |
| `npm run dev`                      | Development build in watch mode (rebuilds `main.js` on save; stays running until stopped).                                                          |
| `npm test`                         | Runs the vitest suite once.                                                                                                                         |
| `npm run test:coverage`            | Runs the suite with coverage; enforces an 85% per-file threshold (statements, lines, functions, branches) — see "Testing and its limits" below.     |
| `npm run deploy`                   | Builds, then copies `main.js`/`manifest.json`/`styles.css` into a vault's plugin folder (see "Install for development").                            |
| `npm run epubcheck`                | Builds a sample EPUB (`scripts/build-sample.ts`) and, if `epubcheck` is installed (`brew install epubcheck`), validates it against the EPUB 3 spec. |
| `npm run local-export`             | Runs the real export orchestrator against a real vault on disk, outside Obsidian — see "The CLI harness" below.                                     |
| `npm run version:check`            | Fails (exit 1) if `package.json` and `manifest.json` disagree on `version`.                                                                         |
| `npm run version:bump -- <semver>` | Writes a new `version` to both `package.json` and `manifest.json` at once.                                                                          |
| `npm run lint`                     | Runs ESLint (`eslint.config.mjs`) over the project.                                                                                                 |
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
have been checked by hand.

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

## BooxDrop

BooxDrop push is an **optional** feature for owners of Onyx Boox e-ink
devices — it uploads the finished EPUB to the device over BooxDrop's
unofficial local API. It is disabled by default (the **Push after export**
setting) and nothing else in this plugin depends on it; every export scope
works fully with it left off.

The BooxDrop upload endpoint is unofficial and firmware-versioned. What was
verified, when, how to re-probe it after a firmware update, and the client's
handling of application-level failures (a 2xx HTTP status with
`"successful": false` in the JSON body) are all documented in
`docs/booxdrop-probe.md` — read that before touching `src/booxdrop.ts`'s
`UPLOAD_PATH`.

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

## Support

Inkbound is free and MIT-licensed. If it saves you time, you can
[buy me a coffee](https://buymeacoffee.com/kidpeterpan) — entirely optional, and
it never affects the plugin's features.

## License

[MIT](./LICENSE) © 2026 kidpeterpan
