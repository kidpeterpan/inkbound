# Changelog

The release workflow reads the section matching the pushed tag and uses it as
the GitHub release description, so keep the heading format `## <version>`.

## 1.0.7

Note embeds (`![[note]]`) now actually work in exported books.

- Embedded notes render their real content into the chapter, exactly once,
  where the embed appears. Previously an embed could come out as a bare note
  name with no content, or duplicated — Obsidian fills embeds in asynchronously
  on its own schedule, and the export raced it. The exporter now renders its
  own copy of each embedded note and ignores whatever Obsidian's loader did or
  didn't produce in the meantime, so the result no longer depends on timing.
- Nested embeds render recursively; circular embeds are cut off safely with a
  warning instead of hanging the export.
- A broken embed (renamed or deleted note) degrades to a readable
  `[embedded content omitted: ...]` placeholder plus an export warning —
  Obsidian's "is not created yet. Click to create." text no longer leaks into
  the book. Heading- and block-scoped embeds (`![[Note#Heading]]`) degrade the
  same way with an "unsupported embed scope" warning; rendering just the
  referenced section is not supported yet.
- Image embeds (`![[figure.png]]`) are unwrapped to a plain image tag with the
  caption as its alt text — the wrapper markup Obsidian emits is not valid in
  EPUB XHTML and was failing epubcheck.
- If the vault hasn't allowed Mermaid rendering (Obsidian's per-vault trust
  prompt), the export keeps the diagram's source as a code block and warns,
  instead of shipping the trust prompt's UI — including its inert "Allow"
  button — into the book.

## 1.0.6

- Added a worked example to the README: a real folder layout, the index note's
  frontmatter, and exactly what comes out the other side. It also spells out the
  two things people get wrong first — that `10_` sorts after `02_` because the
  prefix is read as a number, and that chapter titles come from filenames.

## 1.0.5

- Rewrote the README for people deciding whether to install the plugin. The
  Obsidian directory renders it as the plugin's page, and it previously opened
  with build tooling and test-strategy notes before saying what the plugin does.
- Clearer store description, and the developer documentation moved to
  `docs/DEVELOPMENT.md` where it no longer crowds the plugin page. Nothing was
  removed — the honest account of what the tests can and cannot prove moved with
  it.

## 1.0.4

- Added an optional `fundingUrl` so Obsidian can show a support link on the
  plugin's page. The plugin stays free and MIT-licensed, and no feature depends
  on it.

## 1.0.3

Clears the remaining advisories from the plugin directory's review.

- DOM creation now uses Obsidian's `createEl` helper. It is an ambient global,
  so the pure render module keeps its zero-`obsidian`-imports property and stays
  unit-testable; SVG nodes still use `createElementNS`, which `createEl` cannot
  express.
- The settings tab now implements `getSettingDefinitions()`, so its settings are
  indexed by Obsidian's settings search on 1.13.0 and later. The existing
  settings UI is unchanged, and `minAppVersion` stays at 1.5.0 — older versions
  simply ignore the new method.

## 1.0.2

Addresses feedback from the plugin directory's automated review.

- Replaced JSZip's IE-era `setImmediate`/`immediate` polyfills with small
  Chromium-native shims. Those packages contained `new Function()` and injected
  `<script>` elements, which prevented static analysis of the plugin bundle.
- The BooxDrop settings heading now uses Obsidian's `Setting().setHeading()`
  instead of a raw heading element, for a consistent settings UI.
- Fire-and-forget promises in command, menu and settings callbacks are now
  explicitly marked with `void`.
- Tightened typing around caught errors, parsed JSON and frontmatter tags, and
  removed a deprecated `setDynamicTooltip()` call.
- Releases now carry notes generated from this changelog, and `main.js` and
  `manifest.json` are published with build provenance attestations.

## 1.0.1

First published release.

### Export scopes

- **Single note** — the active or right-clicked note becomes a one-chapter EPUB.
- **Book folder** — a folder of chapter notes becomes one EPUB, ordered by the
  `NN_` filename prefix, with the title, author and cover taken from the
  folder's index note (the note tagged `book` + `main`, or named after the
  folder).
- **Note plus linked notes** — follows `[[wikilinks]]` breadth-first to a
  configurable depth (1–3). Links between notes inside the same export become
  real internal EPUB links; links pointing outside it degrade to plain text.

### Reading on e-ink

- Mermaid diagrams are rasterized to PNG at export time, because e-ink EPUB
  readers generally do not render inline SVG. Diagram labels are converted to
  real SVG text first, so they survive rasterization with the fonts available
  on your computer rather than the reader's.
- Images referenced from notes are embedded, whether written as `![[embeds]]`
  or as standard Markdown image links.
- Output is validated against `epubcheck`.

### Frontmatter

`aliases` sets the book title, `author` sets `dc:creator` (a YAML list is
joined), `language` sets `dc:language` (accepts a language code, or the names
Thai, English, Japanese, Chinese and Korean), and `coverUrl` is downloaded and
embedded as the cover.

### Delivery

The file is always written to your configured output folder first. Optionally
it is then sent over the local network to an Onyx Boox running BooxDrop; a
failed transfer never loses the export, and the notice reports why.
