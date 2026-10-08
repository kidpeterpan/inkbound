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

| Command                            | What it does                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                    | Production build (`esbuild.config.mjs production`) → `main.js`.                                                                                                                                                                                                                                |
| `npm run dev`                      | Development build in watch mode (rebuilds `main.js` on save; stays running until stopped).                                                                                                                                                                                                     |
| `npm test`                         | Runs the vitest suite once.                                                                                                                                                                                                                                                                    |
| `npm run test:coverage`            | Runs the suite with coverage; enforces an 85% per-file threshold (statements, lines, functions, branches) — see "Testing and its limits" below.                                                                                                                                                |
| `npm run deploy`                   | Builds, then copies `main.js`/`manifest.json`/`styles.css` into a vault's plugin folder (see "Install for development" above).                                                                                                                                                                 |
| `npm run epubcheck`                | Builds the sample EPUB (`scripts/build-sample.ts`) and validates it against the EPUB 3 spec; takes extra `.epub` paths (`-- book.epub`). Skips with a hint when `epubcheck` is not installed locally, but is a hard failure in CI — see "The EPUB 3 spec gate" below.                          |
| `npm run local-export`             | Runs the real export orchestrator against a real vault on disk, outside Obsidian — see "The CLI harness" below.                                                                                                                                                                                |
| `npm run check-mobile-safe`        | Fails if the built `main.js` would not load on Obsidian mobile — see "The mobile load gate" below. Requires a build first; runs after `build` in CI.                                                                                                                                           |
| `npm run check-export-works`       | Runs a full export through the built `main.js` against a fixture vault; fails if the book is broken — see "The shipped-bundle export gate" below.                                                                                                                                              |
| `npm run release:check`            | Fails if tagging now would not publish a release: the two version files disagree, or `CHANGELOG.md` has no non-empty `## <version>` section (the workflow reads that section as the release description, and only finds out after the tag is public). Runs in CI — see `RELEASE-CHECKLIST.md`. |
| `npm run review-pack`              | Exports the fixture books through the shipped bundle and reports what changed since the recorded baseline in `tests/fixtures/review-baseline.json`; `-- --update` records a new baseline once the manual device pass is done — see `RELEASE-CHECKLIST.md`.                                     |
| `npm run version:check`            | Fails (exit 1) if `package.json` and `manifest.json` disagree on `version`.                                                                                                                                                                                                                    |
| `npm run version:bump -- <semver>` | Writes a new `version` to both `package.json` and `manifest.json` at once.                                                                                                                                                                                                                     |
| `npm run lint`                     | Runs ESLint (`eslint.config.mjs`) over the project, including Obsidian's own plugin-review rules over `src/` — see "Obsidian's review rules" below.                                                                                                                                            |
| `npm run lint:fix`                 | Runs ESLint with `--fix`, applying any auto-fixable findings.                                                                                                                                                                                                                                  |
| `npm run format`                   | Runs Prettier with `--write` over `src`, `tests`, `scripts`, and top-level JSON/mjs/Markdown files.                                                                                                                                                                                            |
| `npm run format:check`             | Runs Prettier with `--check` (no writes); used to verify formatting without changing files.                                                                                                                                                                                                    |

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
   but still outside Obsidian, and from a bundle it builds itself.
2. **`npm run check-export-works`** — runs the same orchestrator, but from the
   SHIPPED `main.js`, against the fixture vault in `tests/fixtures/smoke-vault`.
   The only gate that executes the artifact's export pipeline, so the only one
   that sees a break introduced by a build-time transform. See "The
   shipped-bundle export gate" below.
3. **`npm run check-mobile-safe`** — proves the built bundle would load on
   mobile at all: no node-builtin `require()` executes at load, and the bundle
   evaluates without throwing in a runtime that has a DOM but no `Buffer`, no
   `process`, and no `require`. See "The mobile load gate" below.
4. **`npm run epubcheck`** — validates finished books against the EPUB 3 spec
   with the W3C's validator: both the hand-built sample and, in CI, the book
   the shipped bundle just exported in rung 2. The only gate whose pass/fail
   criteria come from outside this repo. See "The EPUB 3 spec gate" below.
5. **Manual testing inside Obsidian, on the actual Boox device — and, since
   008-mobile-support, on a real iPhone/iPad and a real Android device** — the only
   gate that exercises the real `MarkdownRenderer`, the real DOM Obsidian
   produces, and the real BooxDrop HTTP API.

See the design doc's "Risks and honest limits" section
(`docs/superpowers/specs/2026-07-29-production-grade-coverage-design.md`) for
the full reasoning.

**Covered by captured real markup (since 2026-09-29).** These used to be on
the verified-by-hand list below. They are now exercised by
`tests/real-render.test.ts` against `tests/fixtures/real-render/*.json`, which
`npm run capture-real-render` produces from a live Obsidian (the same
`obsidian … eval` + dataview `renderValue` route 011-footnote-semantics used
for `footnotes-real.html`; the header of `scripts/capture-real-render.ts`
lists the requirements). The pure passes run over the real markup and the
test says what broke. After an Obsidian upgrade, re-run the capture, commit
the fixture diff, and read that test's failures as the new manual checklist:

- The `app://` image-`src` branch (images Obsidian serves through an
  `app://` URL rather than a plain vault-relative path). The fixtures replace
  the vault's absolute path with `/VAULT`, so they carry no home directory.
- The `CHROME_SELECTORS` cleanup list in `src/core/render/dom.ts`, as far as
  `MarkdownRenderer` can show it: the code-block copy button is proven
  present and removed. The frontmatter selectors never fire in production
  (`stripFrontmatter` runs on the markdown first) and the collapse, pusher
  and metadata ones come from the full reading VIEW, so those three stay
  hand-checked safety nets.
- Non-Latin tags (e.g. Thai-language `#tags`), for the inline-tag-to-plain-text
  rewrite in `cleanupDom`.
- Math placeholder survival: the real renderer preserves the
  `<span data-inkbound-math>` inline-HTML placeholders the math pipeline
  (005-latex-math) relies on, inline and display. The missing-placeholder
  guard that degrades to a warning stays in place as a safety net.
- The shape of an unresolved wikilink and of an unresolved note embed, which
  `rewriteLinks` and `flattenEmbeds` key on.

**Bases tables (`src/core/content/bases.ts`, `src/adapters/bases-adapter.ts`) — NOT yet verified by
hand, and the fixture is hand-built.** A Bases table view is exported by
rendering the embed into a temporary off-screen element attached to the live
document (a detached one is never filled in), growing that element until
Obsidian's virtualization stops cutting rows and columns short, and reading the
cells. The structure was measured on a live Obsidian 1.13.7 (structure only:
tag and class names, counts — never cell content), but
`tests/fixtures/bases-dom.ts` is written by hand from those measurements,
because the only Bases available held real work records and this repository is
public. Two consequences:

- The drift canary above cannot see it. It reads `obsidianVersion` from
  `tests/fixtures/real-render/*.json`, and there is no such file for a Base. If
  Obsidian renames its `bases-*` classes the failure will not be a red test; it
  will be the fallback: every Base exports as `[Bases view omitted: …]` with a
  "timed out" or "unrecognised layout" reason in the report. To close the gap,
  build a small synthetic vault (a few invented notes and a `.base`), capture
  the attached, settled DOM into `tests/fixtures/real-render/`, and replace the
  hand-built builder with it.
- These need a person, on a real device, before they are trusted:
  - Desktop: a table Base exports with the same rows Obsidian shows; a Base of
    a few hundred rows is complete (the report says so if not); a wide Base
    keeps all its columns; a grouped table, a cards view and a Base with a
    broken filter each export as a marker with the right reason.
  - Mobile (iOS WKWebView, Android WebView): the off-screen attached element
    fills in at all, and the five-second wait is enough. If it is not, the
    result is safe but unhelpful: every Base exports as the marker.
  - The assumed shapes named in `bases-dom.ts` (a checkbox cell, a group
    heading) against a real Base that has them.

**The Obsidian drift canary.** Nothing in CI can tell that the fixtures have
gone stale, because CI cannot run Obsidian; each fixture records the version it
came from as `obsidianVersion`, and `.github/workflows/obsidian-drift.yml` checks
those against the newest Obsidian release every Monday. When any fixture is
older, it opens ONE issue titled `[obsidian-drift] …` telling you to re-capture,
and opens no second one while that issue is open. Close it by running the
capture and committing the fixture diff.

- `npm run check-obsidian-drift` runs the same check locally. Without a
  `GITHUB_TOKEN` it is a dry run that changes nothing on GitHub; add
  `--dry-run` to force that even with one, `--latest 1.14.0` to skip the
  lookup. GitHub limits unauthenticated reads per IP, so if you hit that:
  `GITHUB_TOKEN=$(gh auth token) npm run check-obsidian-drift -- --dry-run`.
- What counts as "behind" is one function, `isDrifted` in
  `scripts/lib/obsidian-drift.ts`. Today ANY newer release counts, patch
  releases included. To only react to minor and major releases, change that
  function; its tests say what the current rule is.
- A run that cannot do its job (GitHub unreachable, no fixtures, a fixture
  whose `obsidianVersion` is `unknown`) FAILS rather than passing quietly, so a
  red weekly run means the canary itself needs attention.
- The `schedule` trigger only runs from the default branch, and GitHub pauses
  scheduled workflows after 60 days without repository activity.

**Verified by hand (September 2026), on a real Boox and in real Obsidian
rendering.** Each item below was at one point believed-correct-but-unchecked;
all of them have since been exercised on the device and passed. The list stays
as a record of what the manual check covers, so a change to any of these areas
knows what to re-check:

- Thai font rendering on the actual Boox (006-thai-font): the embedded Noto
  Sans Thai renders compound vowels correctly in NeoReader.

**Mobile (008-mobile-support) — verified on a real phone (September 2026).**
Everything below passed on the device. The automated gates only prove the
bundle _can_ load and that the pure logic is right; these are the things only
a device could settle, kept here as the re-check list for any change to the
mobile path:

- The plugin loads and enables. (The `check-mobile-safe` gate proves the bundle
  evaluates with no node builtin and no `Buffer` in a jsdom-backed simulation;
  a real WebView is a different runtime, so this still needs the device.)
- The vault adapter's `writeBinary` lands the book where the completion notice
  claims, and the user can reach it through the device's own file access.
- The shape of mobile `app://` image URLs. The basename fallback in
  `rewriteImages` is shape-agnostic by design (and its empty-`basePath` guard is
  now correct — see below).
- Mermaid and math rasterize. `defaultRasterizeSvg` uses `Blob` → `Image` →
  `canvas`; iOS WKWebView is strict about SVG in `<img>` — especially the
  `foreignObject` content Mermaid emits for labels — so a regression here
  would degrade to the inline SVG with a warning rather than fail the export.
- `navigator.canShare({files})` is available, so the share command is shown.
  Absence would still be a supported outcome (FR-017 — the command is hidden,
  the export still succeeds).
- Thai rendering on a phone, and Boox push from a phone over Wi-Fi.
- A **nested** mobile output folder (`Books/EPUB`) is created correctly.
  `writeBook` creates it segment by segment because Obsidian's
  `DataAdapter.mkdir` is not documented to create intermediate parents; the
  test stub is non-recursive to match.
- Memory: `lastShareTarget` holds the finished book's bytes in plugin memory
  until the next export, so the share command has something to hand over. For a
  large image-heavy book on a phone that is a real, if modest, resident cost.

**Export report (010-export-report) — not yet checked on a device.** The
feature exists precisely because mobile has no developer console, so the parts
only a phone can settle are the parts that matter:

- Whether tapping the completion notice opens the report. The affordance is a
  click listener on a `DocumentFragment` body passed to the `Notice`
  constructor (neither `Notice` element member is usable here — see
  `specs/010-export-report/research.md` R3), and a tap is not a click event
  everywhere.
- Whether `navigator.clipboard.writeText` is available in the mobile WebView on
  each OS. Absence is a supported outcome — the copy degrades to a notice
  saying the device did not allow it — so "clipboard unavailable on iOS" is a
  result worth writing down, not a bug. **Record the outcome per OS.**
- Whether a report with warnings from ~50 chapters scrolls acceptably as a
  mobile sheet.

**Footnotes (011-footnote-semantics) — not yet checked on a device.** What was
verified, and what only a reader can settle:

_Verified (2026-09-29)._ Obsidian's real footnote markup was captured from a live
**1.13.7** and is kept as a fixture — `tests/fixtures/footnotes-real.html` and
`footnotes-real-contexts.html`, each with its provenance in a header comment. The
test stand-in renderer now reproduces that markup, including the per-render random
id suffix that makes Obsidian's own output non-reproducible, and
`tests/obsidian-stub.test.ts` holds it to the capture so it cannot drift into a
fiction. The markup the pass emits was chosen by running candidates through
epubcheck 5.3.0 `--failonwarnings`: `role="doc-endnote"` is a deprecation warning,
`doc-footnote` on an `li` is an error, and `epub:type` without `xmlns:epub` is
fatal. Both fixture books validate with 0 fatals, 0 errors, 0 warnings, and the
exported chapter and stylesheet were viewed in Chrome.

_Not verified — record the outcome, whatever it is:_

- **Does a Boox show a note as a popup when its marker is tapped?** The markup
  is the standard `noteref` / `footnote` pair, and the fallback on a reader with
  no popup is an ordinary link with a way back — but which of those a given
  reader does is only visible on the reader. Note the reader, firmware, and
  whether the back-link returns to the same place.
- **Other readers.** Some hide an `aside[epub:type=footnote]` from the text flow;
  a reader that hid it without offering a popup would strand the note.
- **Other Obsidian versions.** The plugin supports 1.5.0+; only 1.13.7 was
  captured. The pass tolerates an older shape (proved with synthetic markup) and
  refuses to guess when a fragment matches several notes, but neither has been
  seen against those versions. To re-capture: render the markdown in the fixture
  header through `app.plugins.plugins.dataview.api.renderValue(md, div, plugin,
"", false)` and return `div.innerHTML` — `obsidian vault=<name> eval
code="$(cat script.js)"` runs it (`require("obsidian")` is not available in that
  context, which is why dataview is the route).
- **Thai text inside a note**, on a real e-ink screen. The fixture is English.

How "unchanged" is checked: **a real book is never byte-identical to another
export** — every export writes a fresh package `urn:uuid`, a fresh
`dcterms:modified` into `package.opf`, and dates each ZIP entry with the clock.
All three come from the `BookIdentity` in `src/core/epub/book-identity.ts`, so injecting a
fixed one makes the artifact reproducible byte for byte
(`tests/book-identity.test.ts`); with the real system identity in play, identity
is judged entry by entry with those values normalised
(`tests/fixtures/epub-fingerprint.ts`), and `tests/footnote-free-identity.test.ts`
pins the exact hashes a footnote-free book had before footnotes existed.

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

**Unverified — 009-index-order-parts (nested Parts in the TOC).** Not yet
checked on a device as of 2026-09-07; `epubcheck` accepts the nested nav and
the shipped-bundle gate exports a fixture with a Part, but how a reader
_presents_ it is the device's call:

- NeoReader's TOC panel rendering of nested `<ol>` Part entries (collapsed,
  indented, or flattened?), and the same in Obsidian's own reading view of the
  exported book on mobile.
- What tapping a Part entry opens on the device — it links to the Part's first
  chapter (the sub-index note when there is one), so it should open that
  chapter rather than do nothing.

**Image optimization (013-eink-image-optimization) — NOT yet verified by
hand.** What to keep, what to shrink, what to give up on, and never making a
book bigger are pure decisions, tested with a scripted codec. Only
`src/core/epub/image-codec.ts` touches a browser (it decodes into a canvas,
scales once and encodes), and jsdom cannot run it: the tests stub the canvas
surface, as they do for the SVG rasterizer.

One real-engine check has been done, in desktop Chrome (Chromium) on 2026-10-08:
the real `createImageOptimizer`, codec and header reader, bundled and run on
pictures drawn on a canvas. A 3200×1800 PNG (4.6 MB) became a 1200×675 PNG
(435 KB) in about 1.3 s; a 4000×3000 JPEG (927 KB) became a 1200×900 JPEG
(157 KB); with grayscale on, all 405,000 opaque pixels had R = G = B and the
transparent half stayed transparent; an 800×600 PNG was kept; a JPEG stored
3000×2000 with EXIF orientation 6 (shown 2000×3000) became 1200×1800, sized
from the decoded picture. A PNG cut off after 300 bytes is decoded by Chrome as
far as it goes, so it is not reported as damaged: the result is kept only
because it is not smaller than the 300-byte original. That check says nothing
about Obsidian itself, the Electron version it ships, iOS or Android WebViews,
or an e-ink screen. These still need a person, on a real device:

- **SC-001, the saving.** Export a book of oversize screenshots and photos with
  the switch on and off and compare the two `.epub` files: it should be at least
  50% smaller when every image is at least twice the target width.
- **SC-006, how it looks.** On a Boox every image fits the page width, nothing
  scrolls sideways, and the text in a screenshot is still readable at the default
  1200 px.
- **Phone and tablet.** A large (12 megapixels or more) phone photo is either
  shrunk or kept with a "too large to process" warning, and the export finishes
  either way; note how long it takes.
- **The pixel ceilings** (`MAX_SOURCE_PIXELS` 100 million and
  `MAX_OUTPUT_PIXELS` 16,777,216, in `image-optimizer.ts`) are conservative
  guesses from memory of WebKit's canvas limit, not measurements. A canvas over
  the platform's limit can come back blank instead of throwing, and a blank
  picture is smaller than the original, which is the whole reason the limits
  exist.
- **The output-size estimate assumes a JPEG is not rotated.** A rotated JPEG whose
  stored width is more than about 11 times its height, and which is under the
  source ceiling, can slip past the output ceiling.
- **EXIF orientation.** A portrait phone photo appears upright and not squashed.
  Chromium applies the rotation when an image is drawn to a canvas; WebKit was
  not checked.
- **Canvas PNG color type.** The encoder writes full-color RGBA files (checked in
  Chromium on 2026-10-08, not in WebKit). That is why grayscale never touches an
  image that is not being shrunk: converting a small PNG would usually make it
  larger.
- **Timing.** 20 seconds per image and three timeouts in a row before a book gives
  up (`IMAGE_TIMEOUT_MS`, `MAX_CONSECUTIVE_TIMEOUTS`) are guesses: check that a slow
  device is neither stopped too early nor kept waiting.
- **Grayscale** on a black-and-white device: the image is gray and not larger than
  the original.
- **The settings tab in real Obsidian.** Both rendering paths (the classic one and
  the 1.13+ declarative one) show the switch, the width slider and the grayscale
  toggle, and the values persist across a restart.
- **The width slider on Obsidian before 1.13.** Obsidian 1.13 shows a slider's value
  beside it; older versions show no number, and `setDynamicTooltip`, which would,
  is deprecated and cannot be used here (the lint forbids disabling that rule). The
  description therefore states the range and the default, and the link-depth slider
  has always behaved this way. Check how it reads on Obsidian 1.5–1.12 if those
  versions matter.

**Preview before export (014-preview-before-export) — NOT yet verified by
hand.** What a preview contains is pure (`src/core/book/export-preview.ts`) and
the window is a thin adapter (`src/adapters/preview-view.ts`); the tests read the
window's DOM through the stub `Modal`, and the shipped-bundle gate opens one in
`main.js`. None of that shows how it reads on a real screen. These still need a
person, on a real device:

- **A phone, a long book.** A three-level, several-hundred-note folder reads
  without sideways scrolling, the nested list is indented enough to follow, and
  Export and Cancel are reachable without scrolling (they sit above the list on
  purpose, because with no CSS there is no sticky footer).
- **Nested lists with no stylesheet of ours.** Whether Obsidian 1.5–1.12 indents a
  nested `<ol>` inside a modal usably. The export report window is the only other
  stylesheet-free modal, and it has no nesting.
- **Timing.** A 300-note folder: under 2 seconds to open on desktop (SC-005, with
  no note rendered to get there); record the phone's time separately, there is no
  target for it.
- **No request.** With the developer tools' Network tab open, a preview of a book
  whose index note has a remote `cover:` makes no request until Export is pressed.

A change to any of the areas above should be re-checked by hand before it
ships; the automated gates cannot see these. (The user-facing limits that
remain by design — not by lack of verification — are summarized in the
README's "Known limitations" section.)

**The image codec seam (013).** `src/core/epub/image-codec.ts` is the only file in
the image-optimization path that touches the browser, and it is installed with
`setImageCodec` like the other injection points. Tests give the pure optimizer a
scripted fake (`tests/fixtures/fake-image-codec.ts`) and give the default codec a
stubbed `Image`, `URL.createObjectURL` and canvas (`tests/image-codec.test.ts`).
That proves the decisions, the wiring and the cleanup; it does not prove a real
canvas draws a sharp picture (see the unverified list). Under jsdom and under the
Node gates `available()` is false, because they lack `URL.createObjectURL` or
`Image`, so neither ever tries to resize.

**The plan seam (014).** `exportFolder` and `exportLinked` are "plan, then run":
`planFolder` / `planLinked` in `src/main.ts` decide which notes, in what order, under
which Parts, with which title, author, language and cover source (a `PlannedExport`;
nothing is rendered, read from an image or fetched), and `exportPlanned` builds the book
one describes. The preview shows a `PlannedExport` and runs it only if the reader chooses
Export, so the book a preview describes is the book the export writes: there is no second
copy of the ordering rules. Two things keep that true. `NoteMetaSource.resolve` is
`plan()` then `attachCover()`, and `plan()` never touches the network or an image (a
remote cover used to be downloaded before the pipeline started, which a preview must not
do); and the preview applies the book builder's own `validateNavTree` and the shared
`tocFallbackWarning`, rather than copies of them. A preview must never gain a side effect:
`tests/main.test.ts`'s "preview: a dry run" cases instrument the network, the renderer,
image reads and the output folder, and `check-export-works` opens one in the shipped bundle.

## Bundled fonts (.ttf loader trio)

`src/core/epub/fonts/NotoSansThai-{Regular,Bold}.ttf` are static wght 400/700 instances
instantiated from the official Noto Sans Thai variable font (google/fonts
`ofl/notosansthai/NotoSansThai[wdth,wght].ttf`) via
`fontTools.varLib.instancer.instantiateVariableFont(f, {"wght": w, "wdth": 100})`.
The trio that keeps them working in all three environments:

1. `esbuild.config.mjs` + `scripts/local-export.ts` set `loader: { ".ttf": "base64" }`
   → the bytes are inlined as base64 `Uint8Array` default exports.
2. `src/core/epub/fonts/fonts.d.ts` declares `module "*.ttf"` for `tsc`.
3. `vitest.config.ts` aliases the exact `.ttf` paths to
   `tests/fixtures/font-bytes.ts` (vitest has no binary loader).

The binary imports live ONLY in `src/core/epub/font-assets.ts` (plus the injectable
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
`instanceof TFile`-style checks inside the orchestrator work correctly (the
jsdom globals, the require shim, and the zip inspection live in
`scripts/lib/harness.ts`, shared with `check-export-works`). It
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

`src/` splits into two kinds of modules, and the directory is the rule:

- **`src/core/`** — pure: zero imports of the `obsidian` package, so vitest
  loads and unit-tests them directly, with no stub. It is grouped into six
  concern folders (`common/`, `render/`, `content/`, `book/`, `epub/`,
  `delivery/`) plus `types.ts` in the root; CLAUDE.md's architecture list says
  what each holds.
- **`src/adapters/`** — import `obsidian` for its types and runtime globals
  (`Plugin`, `Notice`, `TFile`, `requestUrl`, `MarkdownRenderer`, `Modal`,
  `Platform`, etc.) and are only importable in tests through the
  `vitest.config.ts` alias to `tests/fixtures/obsidian-stub.ts` described above
  under "Testing and its limits". `src/main.ts` is the plugin entry — esbuild's
  `entryPoints` — and is an adapter too.

`tests/module-boundaries.test.ts` enforces the split in both directions —
nothing under `core/` may import `obsidian` or reach into `adapters/`, and
nothing outside `adapters/` + `main.ts` may import `obsidian` — so moving a
module between the two directories is how its status changes. There is no list
to keep in sync.

`core/types.ts` holds shared interfaces only (no runtime code) and is excluded
from the coverage report for that reason.

## BooxDrop endpoint notes

BooxDrop's upload API is unofficial and firmware-versioned. What was
verified, when, how to re-probe it after a firmware update, and how the
client handles application-level failures (a 2xx HTTP status with
`"successful": false` in the JSON body) are documented in
[`booxdrop-probe.md`](./booxdrop-probe.md) — read that before touching
`src/core/delivery/booxdrop.ts`'s `UPLOAD_PATH`.

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
   in `src/core/epub/font-assets.ts`.

The gate checks both, and the second check is the important one: it **loads the
bundle** in a jsdom-backed context with no `Buffer`, no `process`, and a
`require` that throws for node builtins. Simulating the failing environment
catches hazards that scanning for known symptoms cannot — hazard (2) above was
found this way, with no `require()` anywhere in it for a scan to notice.

It is not a substitute for a real device. It proves the bundle _evaluates_; it
says nothing about whether Obsidian mobile then behaves as expected.

## The shipped-bundle export gate (`scripts/check-export-works.ts`)

Every other automated check runs something other than the file users install.
vitest imports `src/**/*.ts` (the modules directly, and the adapters through the
`obsidian` alias); `local-export` re-bundles `src/main.ts` with its own
esbuild options; `check-mobile-safe` evaluates `main.js` but only its module
top level; `check-review-safe` greps it. Nothing asked `main.js` to export a
book — which is how 1.7.0 and 1.7.1 shipped with desktop export completely
broken while every gate was green, and why the MathJax source rewrite in
`esbuild.config.mjs` (which exists ONLY in the shipped bundle) had no test
executing it at all.

`npm run check-export-works` closes that gap. It `require()`s the built
`main.js` the way Obsidian does (CommonJS, `obsidian` supplied from outside via
the same require shim as the CLI harness), points it at the two-note fixture
vault in `tests/fixtures/smoke-vault/Book`, runs `exportFolder`, and fails
(exit 1) unless the resulting EPUB has: the container skeleton, both chapters,
a manifest that agrees with the zip, the frontmatter title/author, the
embedded image's bytes, a wikilink rewritten to `chapter_002.xhtml`, typeset
math with no leaked placeholder, and both Noto Sans Thai TTFs decoded from
their base64 inlining. Exit 2 means `main.js` is missing — build first. It
runs in CI and in the release workflow right after `build`.

It also opens a preview of that folder (014) and cancels it, and fails unless exactly one
window opened with a "Preview: …" heading and a list, and the output folder and the notices
are exactly as they were.

Verified to fail on two deliberately broken bundles: a MathJax `FunctionList`
rename left inconsistent (throws at load), and the font `atob` decode broken
(book exports without fonts).

What it cannot see: Node resolves a native `import("os")` fine, so the exact
1.7.0 symptom does not reproduce here (verified: a bundle built without
`supported: { "dynamic-import": false }` passes this gate) —
`check-mobile-safe` check 1b covers that by scanning the bundle. Rendering still goes through the marked-based
stub. This gate proves the artifact can run its own export pipeline; it does
not replace the manual check in real Obsidian.

Image optimization defaults to ON and this gate runs on the default settings, yet
it shows no change: the fixture's only image is small, so the optimizer keeps it
without consulting the codec, and the harness has no `Image` or canvas anyway
(the default codec's `available()` is false). So the gate proves the bundle loads
and exports with the optimizer built in; it does not prove an image gets shrunk.
That is what the unit tests (a scripted codec) and the unverified list above are
for.

The fixture vault is deliberately tiny and every note in it exists to trip a
specific assertion (the index note's `tags: [book, main]` and `aliases` drive
`pickIndexNote`/`resolveMeta`; the Thai text turns font embedding on; the
math note is the one thing that drives the rewritten MathJax code). Add to it
when a new export feature has a shipped-bundle-only dependency, not for
general coverage — that belongs in vitest.

## The EPUB 3 spec gate (`npm run epubcheck`)

Every other gate in this repo checks the export against what this code believes
a book should be, so they agree with themselves by construction. epubcheck —
the W3C's validator for the format (originally the IDPF's) — is the only one
whose rules come from outside: a malformed OPF manifest, a nav
fragment that resolves nowhere, a wrong media type, a font declared but not
listed. All of those produce a zip that `check-export-works` happily passes and
a reader then refuses to open.

It validates **two** books:

1. `sample.epub`, built by `scripts/build-sample.ts` — hand-assembled and
   deliberately packed with the edge cases nothing else reaches: three levels of
   nested nav Parts, Thai heading fragment ids, real MathJax SVG (including the
   `merror` red-error path), embedded font assets with their OFL text file, and
   a cover image. The comments in that file name the epubcheck rules each piece
   exists to exercise (RSC-012, NAV-011) — keep them when adding to it.
2. In CI, the book the shipped `main.js` exported in the previous step.
   `check-export-works` builds it inside a temp dir it deletes on the way out,
   so CI sets `INKBOUND_KEEP_EPUB=<path>` to have it copied out first. The copy
   happens before that gate's own assertions run, so a book that fails them is
   still on disk to inspect — and CI uploads it as an artifact when the job
   fails.

Two things about `scripts/epubcheck.ts` that are deliberate:

- **Missing epubcheck is a skip locally and a failure in CI.** The script used
  to be a shell `if command -v epubcheck; then ...; else echo ...; fi`, which
  exits 0 when the tool is absent. That is right on a laptop and useless as a
  gate: a runner without epubcheck would have reported a pass. The script keys
  off `CI` (or `--require`).
- **`--failonwarnings`.** Both books are at 0 errors and 0 warnings today, and
  CI pins the epubcheck version (`EPUBCHECK_VERSION` in both workflows), so a
  new warning can only come from a change in this repo. Bumping the pin is a
  deliberate act — expect to fix whatever the new version newly objects to in
  the same commit.

Locally: `brew install epubcheck`, then `npm run epubcheck`. To validate a real
book end to end the way CI does:

```bash
npm run build
INKBOUND_KEEP_EPUB=/tmp/real.epub npm run check-export-works
npm run epubcheck -- /tmp/real.epub
```

Point `EPUBCHECK_JAR` at an unpacked `epubcheck.jar` to use a specific version
instead of the one on `PATH` (that is what CI does). The jar loads its
dependencies from a sibling `lib/` through its manifest classpath, so run it
where it was unpacked rather than copying the jar out.

## Obsidian's review rules

`eslint.config.mjs` runs `eslint-plugin-obsidianmd` — the same rule set Obsidian's
reviewers run against a submitted plugin — so a review finding fails the build
instead of arriving after a release has shipped. That is not hypothetical: 1.7.0
went out carrying three of them.

Two deliberate choices in that config, both easy to get wrong:

- **Scoped by `ignores`, never by rewriting `files`.** One entry in the plugin's
  recommended set is `{ files: ["package.json"], language: "json/json" }`.
  Forcing a blanket `files: ["src/**/*.ts"]` onto every entry applies the JSON
  language to TypeScript, and every file in `src/` then fails to parse at its
  first `//`. Narrow with `ignores`.
- **Only `src/` is linted by these rules.** It is the only thing bundled into
  `main.js` and seen by a reviewer. `tests/` and `scripts/` are dev-only Node
  code that legitimately imports `fs`, touches `globalThis`, and assigns
  `innerHTML` in fixtures; including them produced ~200 findings that were all
  correct as written.

`obsidianmd/no-nodejs-modules` is promoted from warning to **error**, because at
its default severity it does not fail `npm run lint` — and its failure mode is
total: a top-level node import stops the plugin loading on mobile entirely. It
overlaps `check-mobile-safe` by design; this catches the mistake in the source,
that one catches it in the built bundle.

`obsidianmd/ui/sentence-case` is **off**. It lowercases everything after the
first word, which is wrong for every acronym and proper noun in this plugin's UI
— it wants "Export note to epub", "Toc heading depth", "Embed thai font",
"Booxdrop", and rewrites the example URL `http://192.168.1.42:8085` to
`HTTP://...`. Of its 17 findings, 15 were false; the 2 real ones (capitalizing
"Markdown") are fixed. Revisit if the rule gains an exception list.

Note the Obsidian rule set is **type-aware**, which is how it catches things the
project's own syntax-only pass structurally cannot — such as a redundant
`as string` on an expression that is already a string.
