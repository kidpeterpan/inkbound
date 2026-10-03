# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Inkbound (npm package name `inkbound`) is an Obsidian plugin that exports
notes/folders/linked-note graphs to EPUB 3, with optional wireless push to an
Onyx Boox e-ink device via the BooxDrop HTTP API. It runs on Obsidian desktop
AND mobile (iOS/Android) as of 008-mobile-support. It is listed in Obsidian's
community plugin registry and ships tagged GitHub releases (`.github/workflows/
release.yml`); building and copying output into a vault's plugins folder is the
development workflow, not the only install route.

## Commands

```bash
npm install
npm run build              # production build -> main.js (esbuild)
npm run dev                 # watch-mode build
npm test                    # vitest run, once
npm run test:coverage       # vitest with coverage; 85% per-file gate (statements/lines/functions/branches)
npx vitest run tests/naming.test.ts        # run a single test file
npx vitest run -t "test name substring"    # run tests matching a name
npx tsc --noEmit             # type-check only; CI gate, no npm script wraps it
npm run check-mobile-safe    # CI gate; requires a build first. Fails if main.js
                             # would not LOAD on Obsidian mobile (top-level node
                             # require, or a Node global like Buffer at module
                             # scope). See docs/DEVELOPMENT.md "The mobile load
                             # gate" — this is not a lint, it loads the bundle.
npm run check-export-works   # CI gate; requires a build first. Loads the SHIPPED
                             # main.js and runs a full export against
                             # tests/fixtures/smoke-vault; fails if the book is
                             # broken. The only gate that executes the artifact's
                             # export pipeline (see docs/DEVELOPMENT.md "The
                             # shipped-bundle export gate"). Set
                             # INKBOUND_KEEP_EPUB=<path> to copy the exported
                             # book out before its temp dir is deleted — that
                             # is how CI feeds it to the epubcheck gate.
npm run capture-real-render  # maintainer task, NOT a CI step: re-captures
                             # tests/fixtures/real-render/*.json from a live
                             # Obsidian (needs the `obsidian` CLI, an open
                             # vault, and dataview enabled in it). Run after
                             # an Obsidian upgrade; tests/real-render.test.ts
                             # runs the pure render passes over the result.
npm run check-obsidian-drift # weekly-workflow check, also runnable locally: are the
                             # real-render fixtures older than the newest Obsidian
                             # release? Dry run without GITHUB_TOKEN (add
                             # --dry-run to force one). See docs/DEVELOPMENT.md
                             # "The Obsidian drift canary".
npm run deploy               # build + copy main.js/manifest.json/styles.css into a vault's plugin folder
npm run epubcheck            # CI gate. Builds sample.epub and validates it (plus
                             # any extra `.epub` paths passed after `--`) against
                             # the EPUB 3 spec with --failonwarnings. Locally it
                             # SKIPS when epubcheck is absent (brew install
                             # epubcheck); in CI a missing epubcheck is a hard
                             # failure, and the version is pinned via
                             # EPUBCHECK_VERSION in both workflows. See
                             # docs/DEVELOPMENT.md "The EPUB 3 spec gate".
npm run local-export -- <note|folder|linked> <vault-relative-path>  # run the real orchestrator against a real vault, outside Obsidian
npm run release:check        # fails if tagging now would not publish a release
                             # (version files disagree, or CHANGELOG.md has no
                             # non-empty section for the current version). Runs
                             # in CI; the release workflow only finds out after
                             # the tag is public — see docs/RELEASE-CHECKLIST.md
npm run review-pack          # what changed in the fixture books since the last
                             # reviewed baseline; `-- --update` records it. The
                             # input to the manual device pass — see
                             # docs/RELEASE-CHECKLIST.md
npm run version:check        # fails if package.json and manifest.json version disagree
npm run version:bump -- <semver>  # writes version to both files at once
npm run lint / lint:fix     # includes eslint-plugin-obsidianmd (Obsidian's own
                             # plugin-review rules) over src/ ONLY, type-aware.
                             # Scope it with `ignores`, never by rewriting
                             # `files` — one entry is a package.json/JSON-language
                             # config, and overriding its `files` makes every
                             # src/*.ts parse as JSON. See docs/DEVELOPMENT.md.
npm run format / format:check
```

`npm run deploy` copies build output to `<vault>/.obsidian/plugins/inkbound/`.
Default vault is `~/Documents/pan_vault`; override with `VAULT=/path/to/vault`.

CI (`.github/workflows/ci.yml`) runs, in order: lint, format:check,
`tsc --noEmit`, test:coverage, build, check-mobile-safe, check-review-safe,
check-export-works (with `INKBOUND_KEEP_EPUB` set), epubcheck over both that
kept book and `sample.epub`, version:check, release:check.
`.github/workflows/release.yml`
runs the same gate on any pushed tag, then publishes a GitHub release: the tag
must be bare-numeric (e.g. `1.0.0`, no `v` prefix — that's what Obsidian's
installer matches against `manifest.json`'s version) and `CHANGELOG.md` must
have a matching `## <tag>` section, or the release step fails. The pre-tag
runbook is `docs/RELEASE-CHECKLIST.md`.

## Architecture

Ports-and-adapters, with a pipes-and-filters core. The directory layout IS the
rule, and a test enforces it (see below):

```
src/
  core/       PURE. No `obsidian` import, no Node builtin, no dependency on
              adapters/. vitest loads these directly, with no stub — which is
              what keeps the export pipeline unit-testable and fast.
  adapters/   May import `obsidian` (app, vault, renderer, transport, notices).
  main.ts     The plugin entry — an adapter too, and the one file esbuild
              bundles (esbuild.config.mjs's entryPoints).
```

- **`src/core/`** — `error-text`, `xml`, `metadata`, `cover`, `collect`,
  `book-tree`, `naming`, `footnote-refs`, `footnotes`, `render`, `math`, `bases`,
  `epub`, `epub-css`, `fonts`, `font-assets` (plus the `fonts/*.ttf` binaries),
  `media-types`, `chapter-assets`, `settings-core`, `output`, `book-identity`,
  `booxdrop`, `share`, `report`, `backlinks`, `types`.
- **`src/adapters/`** — `settings` (the settings tab), `render-adapter`
  (`MarkdownRenderer`), `bases-adapter`, `meta-adapter` (metadata cache, vault
  reads, cover downloads), `output-adapter` (`Platform`, the vault adapter, the
  lazy `os`/`fs` imports), `export-pipeline` (the orchestrator), `export-notice`,
  `report-view`, `http`. Only importable under vitest via the `obsidian` alias
  described below.

**This boundary is enforced by `tests/module-boundaries.test.ts`, not just
described here.** It fails if anything under `core/` imports `obsidian` or an
adapter (naming the file), and if anything outside `adapters/` + `main.ts`
imports `obsidian`. Moving a module between the two directories is therefore
the way to change its status — there is no list to update.

`core/book-identity.ts` is an adapter in the architectural sense even though it
imports no `obsidian`: it is the one module in the export path that reads
ambient globals (the clock, the RNG). Passing a fixed `BookIdentity` to
`EpubBuilder` makes a built book byte-identical — see "Export pipeline" below.

`adapters/output-adapter.ts` is the ONLY module that knows what platform it is
running on: it reads `Platform`, exposes it as a plain `"desktop" | "mobile"`
value via `platformKind()`, and passes that into `core/output.ts`, which decides
where a book goes (absolute path via a LAZY `await import("fs")` on desktop; a
vault-relative path via `vault.adapter.writeBinary` on mobile). The lazy
`os`/`fs` imports and the comment explaining why they must stay inside function
bodies live there too. Desktop and mobile have separate output settings that
neither reads from the other, so a synced `data.json` cannot relocate the other
platform's exports.

`core/types.ts` holds shared interfaces only (no runtime code) and is excluded
from coverage for that reason.

**Export pipeline** (`adapters/export-pipeline.ts`'s `runExport`, per chapter file):

1. The file list for the chosen scope: `book-tree.ts`'s `planBook` for folder
   exports (index-note link order, subfolders as nested Parts, `orderByName`/
   `pickIndexNote` from `collect.ts` as the fallback rule — fed plain data
   `main.ts` builds from the `TFolder` walk and `getFileCache(...).links`),
   `collect.ts`'s `bfsLinked` for linked-note exports. Folder exports also get
   a `NavItem[]` tree that `EpubBuilder.setNavTree` renders as nested `<ol>`s;
   it references chapters by POSITION in the file list — see the comment where
   `main.ts` builds it and the placeholder invariant below for why.
2. `render-adapter.ts`'s `renderUnitToChapter` renders each note's markdown
   through Obsidian's real `MarkdownRenderer`, then hands the DOM to the pure
   functions in `render.ts`: `stripFrontmatter`/`stripDynamicBlocks`,
   `cleanupDom`, `rewriteLinks` (retargets wikilinks to sibling chapter
   hrefs), `rewriteImages`, `rasterizeMermaidDiagrams` (Mermaid → PNG, since
   e-ink readers can't render live diagrams), `serializeBody`.
   Footnotes: `footnotes.ts`'s `processFootnotes` runs AFTER math and BEFORE
   `collectHeadingToc` — after `flattenEmbeds` so each embed's own `section.footnotes`
   is in the DOM, after links/images/math so a note's contents are processed, before
   heading ids so heading text can exclude markers. It gathers every note into one
   section of EPUB 3 footnotes with ids minted from document order (Obsidian's are
   random per render). Two facts to keep: a REAL export is never byte-identical to
   another (it mints a fresh `urn:uuid` + `dcterms:modified` in `package.opf` and
   dates every ZIP entry with the clock — `src/core/book-identity.ts` owns all three
   values, and passing a fixed `BookIdentity` makes the whole file reproducible, as
   `tests/book-identity.test.ts` asserts; for real exports compare entry by entry —
   `tests/fixtures/epub-fingerprint.ts`), and Obsidian discards orphan
   footnotes before the DOM, so real ones are found by `scanFootnoteSource` on the
   markdown, not by looking at the rendered page.
3. `main.ts` resolves each image's bytes from the vault (or takes rasterized
   Mermaid bytes directly) and feeds chapter HTML + assets to `epub.ts`'s
   `EpubBuilder`.
4. `metadata.ts`'s `resolveMeta` derives book metadata (title/author/
   language/cover) from the exporting note's own frontmatter.
5. Optionally, `booxdrop.ts`'s `BooxDropClient` (via `http.ts`'s
   `obsidianHttp`) pushes the finished EPUB to a Boox device. The local file
   is always written before any push is attempted.

Chapter/image href numbering (`chapterHref`, `imageCount` in `main.ts`) is
stamped into chapter HTML as each chapter renders — it must track what's
already been burned into earlier chapters' HTML, not what later succeeds or
fails to load, or hrefs silently desync. See the comments around
`imageCount` and the failed-chapter placeholder in `main.ts`'s `runExport`
before changing chapter/asset ordering.

## Testing and its limits — read before changing test infra

Full rationale lives in `docs/DEVELOPMENT.md`'s "Testing and its limits"
section; the rules that must not be violated:

- Never alias `obsidian` in `esbuild.config.mjs`. `vitest.config.ts` aliases
  it to `tests/fixtures/obsidian-stub.ts` (the npm `obsidian` package ships
  only `.d.ts`, no runtime JS) so the adapter modules (the ones listed under
  Architecture above) are importable under vitest — **vitest only**. Aliasing
  it in esbuild too would give `main.ts` a second, differently-identified
  `TFile`, breaking `instanceof` checks in the real build.
- The `immediate`/`setimmediate` aliases (JSZip's IE-era polyfills, flagged
  by Obsidian's plugin review as dynamic code execution) must stay aliased
  to `shims/*.cjs` in **both** `vitest.config.ts` and `esbuild.config.mjs`,
  or the two environments diverge.
- Green coverage is _not_ evidence the plugin works in real Obsidian — the
  stub's `MarkdownRenderer` is `marked` + post-processing, not Obsidian's
  real renderer. Realism ladder, low to high: `test:coverage` (stub-backed)
  → `npm run local-export` (real vault, real EPUB zip, still stub-rendered)
  → `npm run check-export-works` (same, but through the SHIPPED main.js)
  → `npm run epubcheck` (EPUB-3 spec validation — the only gate whose rules
  come from outside this repo; runs in CI over both sample.epub and the book
  the shipped bundle just exported) → manual test in real Obsidian on the
  actual Boox device. `docs/DEVELOPMENT.md` keeps the list of
  areas only a real device/render can check (all verified by hand as of
  September 2026) — a change touching any of them needs that manual re-check.

`tests/setup/no-live-bases.ts` does the same for the Bases renderer: it installs
a stand-in that fails at once before every test, so a test that embeds a `.base`
and forgets `setBaseRenderer` cannot wait on the real five-second timeout. The
Bases DOM in `tests/fixtures/bases-dom.ts` is HAND-BUILT from measured structure,
not captured (see docs/DEVELOPMENT.md, "Bases tables").

`tests/setup/no-network.ts` is a vitest `setupFiles` global guard that
re-installs a throwing `requestUrl` stub before every single test in every
file, so a test that forgets to call `setRequestUrlImpl` can't silently hit
real network I/O in CI. It only applies under vitest — `scripts/local-export.ts` runs under `tsx` and is unaffected.

Before touching `src/core/booxdrop.ts`'s `UPLOAD_PATH`, read
`docs/booxdrop-probe.md` — BooxDrop's upload API is unofficial and
firmware-versioned; that doc records what was verified, when, and how to
re-probe it after a firmware update.

## Repo-specific conventions

- `docs/superpowers/{specs,plans}/` and, as of this session, `specs/` (a
  full speckit spec → plan → tasks → implement bundle per feature, e.g.
  `specs/001-note-embed-hardening/`) hold design docs from spec-driven
  workflows — real project history, not scaffolding. Note: an earlier
  version of this file said `.claude/`/`.specify/` were gitignored local
  tooling untracked by a past commit ("chore: untrack local tooling
  scaffolding") — `.gitignore` no longer excludes them as of this session
  (removed outside of any of these documented tasks), so that's no longer
  accurate; confirm the current `.gitignore` before assuming either way.
- Don't strip the invariant/why comments in files like `main.ts` (chapter/
  image href numbering), `vitest.config.ts`/`esbuild.config.mjs` (alias
  rationale), and `render-adapter.ts` (module-split rationale) as if they
  were routine restatements — they document constraints that aren't
  otherwise visible in the code.
