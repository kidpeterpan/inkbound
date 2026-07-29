# Production-Grade Hardening: Frontmatter Metadata + 85% Coverage — Design

**Date:** 2026-07-29
**Status:** Approved by user (design conversation, 2026-07-29)
**Project:** `obsidian-epub-export` (`~/ProjectG/obsidian-epub-export`), at commit `0b29ad5`
**Predecessor spec:** `docs/superpowers/specs/2026-07-28-epub-export-design.md`

## Problem

Two problems, one cause.

**1. Metadata is only mined in folder mode.** `exportFolder` reads `author` and
`coverUrl` from the index note's frontmatter inline; `exportSingle` and
`exportLinked` read nothing. Exporting the `clean_code` index note on 2026-07-29
produced `dc:creator = "Unknown"` even though the note carries
`author: Robert C. Martin`. No mode reads `language`, so the vault's per-book
`language: thai` / `language: english` fields are dead data and every export is
labelled with the global setting. A latent crash also lives here: an `author`
that is a YAML *list* reaches `escapeXml`, which calls `.replace` on an array →
`TypeError` → the entire export fails with an opaque message.

**2. 41% of the code cannot be measured or tested at all.** `main.ts` (236
lines), `settings.ts` (64), `render-adapter.ts` (52) and `http.ts` (24) import
the `obsidian` package, which ships type declarations with no runtime JS, so
vitest cannot import them. 376 of 911 source lines are unreachable by the test
suite. Even 100% coverage of every pure module caps total line coverage at
**58.7%** — the 85% target is arithmetically impossible without changing this.
The consequence is not theoretical: the orchestrator is the riskiest code in the
project (per-task review found four real defects in it) and has zero tests.

## Requirements

1. All three export scopes honour the source note's own frontmatter: `author`,
   `language`, `coverUrl`, and `aliases` (as the book title). Folder mode gains
   `language` and keeps its existing `author`/`coverUrl` behaviour, via the same
   shared code path.
2. `@vitest/coverage-v8` wired up, enforcing **85% per file** across
   statements, lines, functions and branches.
3. Everything in `src/` is measured, including the Obsidian-importing modules.
4. Tooling: ESLint + Prettier, a GitHub Actions workflow, a README, and a
   release script keeping `package.json` and `manifest.json` versions in step.

## Approach decision

**Chosen: C — Hybrid.** Extract the genuinely pure decision logic out of
`main.ts` into a new `src/metadata.ts`, which is work the metadata feature
requires anyway rather than refactoring for its own sake; then alias `obsidian`
to the existing test stub inside the vitest config so the remaining
orchestration code becomes importable and measurable.

**Rejected:**
- **A — alias stub only.** Touches no existing code, but leaves every
  multi-branch decision (language mapping, author coercion, alias fallbacks)
  inside a 236-line orchestrator, making per-file 85% far harder to reach and
  the branches harder to test directly.
- **B — hexagonal refactor** (extract a core taking injected ports). The best
  design in the abstract, but it would rewrite code that has already survived
  four review rounds, risking the invariants those rounds established
  (placeholder chapters keeping link numbering stable, image-counter ordering,
  save-before-push).

## Component: `src/metadata.ts` (pure, zero obsidian imports)

```ts
export interface MetaDefaults { fallbackAuthor: string; language: string; }
export interface ResolvedMeta { title: string; author: string; language: string; coverUrl: string | null; }

export function normalizeLanguage(raw: unknown, fallback: string): string;
export function resolveAuthor(raw: unknown, fallback: string): string;
export function resolveTitle(basename: string, aliases: unknown): string;
export function resolveCoverUrl(raw: unknown): string | null;
export function resolveMeta(
  frontmatter: Record<string, unknown> | undefined,
  basename: string,
  defaults: MetaDefaults
): ResolvedMeta;
```

Resolution rules, each a tested branch:

| Field | Rule |
|---|---|
| `title` | First non-empty entry of `aliases` (string, or first usable element of an array) → else `basename`. This is the **book title** (`dc:title`), deliberately distinct from per-chapter titles, which remain `deriveChapterTitle`'s job (reserved for the user in plan Task 11). |
| `author` | Non-empty string → trimmed. Array → non-empty string elements joined with `", "`. Anything else, or empty → `defaults.fallbackAuthor` → `"Unknown"` when that is also empty. |
| `language` | A string matching `/^[a-z]{2,3}(-[a-z0-9]+)*$/i` → lowercased and used as-is. Otherwise a known language name, case-insensitive, from exactly this table: `thai→th`, `english→en`, `japanese→ja`, `chinese→zh`, `korean→ko`. Anything else (including non-strings) → `defaults.language`. Unknown names deliberately fall back rather than guess. |
| `coverUrl` | String starting `http://` or `https://` (case-insensitive) → returned trimmed. Anything else → `null`. Vault-relative cover images are out of scope. |

## Changes to `src/main.ts`

- All three of `exportSingle`, `exportLinked` and `exportFolder` build their
  `ExportMeta` from `resolveMeta(...)`, fed by the source note's frontmatter —
  the root note for single/linked, the index note for folder. When a folder has
  no detectable index note, `resolveMeta` is called with no frontmatter and the
  folder's own name as `basename`, preserving today's behaviour (title = folder
  name, author = fallback, no cover).
- The cover download becomes one private helper used by all three modes, keeping
  the existing behaviour: non-200 or a thrown request logs
  `console.warn("[epub-export] cover download failed", …)` and the export
  proceeds without a cover; content-type decides `png` vs `jpg`.
- The inline frontmatter reads in `exportFolder` are deleted. `titleFor()`
  continues to supply *chapter* titles and is unchanged.

Everything else about the orchestrator — the ordered chapter list, `hrefByPath`
built before rendering, placeholder chapters for failed renders, the image
counter advancing before the asset loop, per-image failures being non-fatal,
save-before-push, and the warnings summary — stays exactly as reviewed.

## Coverage architecture

`vitest.config.ts` gains:

- `resolve.alias`: `obsidian` → `tests/fixtures/obsidian-stub.ts`. **vitest only**
  — `esbuild.config.mjs` keeps `external: ["obsidian", "electron"]`, so the
  shipped `main.js` is unaffected.
- `test.coverage`: provider `v8`; `include: ["src/**/*.ts"]`;
  `exclude: ["src/types.ts"]` (interfaces only — emits no JS, so v8 reports
  0/0); `thresholds: { perFile: true, statements: 85, lines: 85, functions: 85, branches: 85 }`;
  reporters `text`, `html`, `lcov`.
- New script: `"test:coverage": "vitest run --coverage"`.

**Stub change required.** `tests/fixtures/obsidian-stub.ts` currently implements
`requestUrl` with a real `fetch`, which would make unit tests hit the network and
turn them flaky and environment-dependent. The stub gains
`setRequestUrlImpl(fn)` plus `resetRequestUrlImpl()`: the default stays real
`fetch` (the CLI harness depends on it), and tests install deterministic fakes.

Because a single vitest module graph resolves the alias once, `main.ts` and the
test file share one stub instance — so `instanceof TFile` works and the
`NOTICES` array is shared. This is the same identity requirement the CLI harness
solves with a `Module._cache` shim; do **not** replace the alias with an esbuild
alias, which would create a second transpiled copy and silently break both.

## Test plan

New and extended suites, each targeting ≥85% of its file:

- **`tests/metadata.test.ts`** — every rule in the table above, including: array
  author joined; empty/whitespace author → fallback → `"Unknown"`; `thai`,
  `ENGLISH`, `th`, `en-GB`, an unknown name, and a non-string language; alias as
  string, as array, as empty array, absent; `http`/`https`/relative/non-string
  cover.
- **`tests/main.test.ts`** (new, uses the alias + real temp dirs via
  `fs.mkdtemp`) — single, folder and linked exports end to end; frontmatter
  metadata landing in the OPF; chapter order with the index note first; a
  chapter whose read throws producing a placeholder while later chapters
  survive; a missing image warning without aborting; an unsupported image type
  skipped with a warning; cover success and cover failure; push success, push
  failure leaving the local file intact, and push disabled; the warnings-summary
  Notice; overwriting an existing output file.
- **`tests/settings.test.ts`** — extended to construct the settings tab, call
  `display()`, and invoke every control's `onChange`, plus the *Test connection*
  button with a reachable and an unreachable device.
- **`tests/render-adapter.test.ts`** (new) — `renderUnitToChapter` returning
  body/images/warnings, `startImageIndex` threading, and the detached element
  being removed even when rendering throws.
- **`tests/http.test.ts`** (new) — `obsidianHttp` mapping status and text, and
  surviving a `text` getter that throws.
- Existing pure-module suites extended only where a real branch is uncovered.

Tests assert observable behaviour — the bytes of the produced EPUB, the OPF
contents, captured Notices and `console.warn` lines, files on disk — not
internal call sequences.

## Tooling

- **ESLint** flat config with `typescript-eslint` (recommended + a small set of
  correctness rules), **Prettier** for formatting; scripts `lint`, `lint:fix`,
  `format`, `format:check`.
- **GitHub Actions** (`.github/workflows/ci.yml`): Node 20, `npm ci`, then
  `lint` → `tsc --noEmit` → `test:coverage` → `build` → `version:check`. The
  repo has no remote yet, so this file is inert until it is pushed — stated here
  so its absence from any run is not mistaken for a failure.
- **README.md** — what the plugin does, install/build/deploy, how to run the
  tests and the coverage gate, how to run the CLI harness, and a pointer to
  `docs/booxdrop-probe.md`.
- **`scripts/version.ts`** — `npm run version:bump -- <semver>` writes the
  version to both `package.json` and `manifest.json`; `npm run version:check`
  exits non-zero when they disagree (Obsidian reads the manifest, npm reads the
  package file, and a mismatch ships a plugin whose reported version is wrong).

## Risks and honest limits

- **85% through a stub is not proof the plugin works on the device.** The stub
  is our own construction: its `MarkdownRenderer` is `marked` plus
  post-processing, so it cannot demonstrate what real Obsidian emits. Coverage
  measures how much of *our* logic is exercised, nothing more. The real-artifact
  gates remain the CLI harness, `epubcheck`, and testing on the Boox. The
  known-unverified list stays: the `app://` image branch, mermaid, `$$` display
  math, note transclusion, `CHROME_SELECTORS`, and non-Latin tags.
- **Per-file thresholds can be genuinely unreasonable for one file.** If so, add
  a per-file override in `vitest.config.ts` with a comment stating why. Never
  lower the global threshold to make a red build green.
- **Aliasing `obsidian` in vitest means tests can pass against stub behaviour
  that diverges from Obsidian.** Divergences the earlier review catalogued are
  recorded in the ledger; new stub behaviour added for a test must mirror the
  real API, not the convenient shape.
- **`main.ts` tests touch the real filesystem** via `fs.mkdtemp`, so they must
  clean up in `afterEach` and must never write inside the user's vault.

## Out of scope

- Changing `deriveChapterTitle`'s precedence (reserved for the user, plan Task 11)
- The e-ink stylesheet (also Task 11)
- Vault-relative cover images
- Deduplicating identical images across chapters
- Mobile support, mermaid/math rendering, BooxDrop push beyond the verified endpoint
- Publishing to the Obsidian community plugin store
