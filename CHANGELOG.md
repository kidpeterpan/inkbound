# Changelog

The release workflow reads the section matching the pushed tag and uses it as
the GitHub release description, so keep the heading format `## <version>`.

## 1.5.1

Fixes every finding from the Obsidian community-plugin review.

- **Review blocker fixed** — MathJax SVG parsing no longer assigns
  function-parameter strings to `innerHTML`; it parses through `DOMParser`
  with an `instanceof SVGSVGElement` guard instead (same behavior, lint-clean).
- **Code-masking sentinel** — the math detector's code-region sentinel is now
  a private-use-area character instead of an ASCII control char, which the
  review's regex lint rejects.
- **createEl shortcuts** — `createDiv()`/`createSpan()` replace the
  `createEl("div")`/`createEl("span")` forms the review's lint prefers; the
  embed-flattening path drops its document fragment for multi-node
  `replaceWith`.
- **Typed MathJax boundary** — explicit casts over mathjax-full's
  loosely-typed adaptor surface (no more `no-unsafe-assignment` /
  `no-unsafe-argument` warnings).
- **Settings action contract** — the declarative "Test connection" action
  returns `void` as `SettingDefinitionAction` requires.
- The local-export harness installs the `DOMParser`/`SVGSVGElement` globals
  the new parsing path uses, so the harness keeps exercising real SVG
  parsing.

## 1.5.0

Math in notes now exports as typeset pictures, so technical notes read
properly on e-ink.

- **Inline and display math** — `$...$` and `$$...$$` LaTeX renders at export
  time (MathJax, bundled and offline) and embeds as PNG images, the same
  strategy Mermaid uses, so it displays identically on readers that cannot
  draw inline SVG (verified: Boox Neo Reader).
- **Graceful degradation** — broken LaTeX renders as MathJax's red error
  output with an export warning; non-Latin text inside math (e.g. Thai)
  restores the original source text with a warning; rasterization failure
  keeps a spec-valid inline SVG. Math never blocks an export.
- **Code-aware detection** — `$` inside fenced code blocks, inline code
  spans, escaped `\$`, currency (`$50`), and empty/unclosed delimiters are
  never treated as math, matching Obsidian's own rules.
- Deterministic rendering (identical exports from identical notes) is
  enforced by tests; the epubcheck sample now includes real MathJax SVG
  chapters.

Thai books now carry their own font, so Thai renders consistently on e-ink
regardless of the device's font coverage.

- **Noto Sans Thai embedded automatically** — books whose chapters contain
  Thai get Regular + Bold (static instances, SIL OFL 1.1) written into the
  EPUB with `@font-face` rules and a `font-family` chain that keeps Latin in
  the reader's default font. The OFL license ships inside the book.
- **`Embed Thai font` setting** (default ON) — OFF keeps every book
  fontless; books without Thai are structurally identical to pre-feature
  exports.
- Fonts are bundled in the plugin (offline); a broken bundle degrades to a
  valid fontless book with a warning, never a failed export. epubcheck
  validates the font-bearing sample every CI run.

## 1.4.0

The table of contents now reaches inside chapters, so long notes are
navigable on an e-ink reader without scrolling.

- **Heading sub-entries** — every chapter's headings appear as nested links
  under its title in the EPUB's TOC (`nav.xhtml`), mirroring the document's
  heading hierarchy. Tapping one jumps straight to that section in the
  chapter.
- **`TOC heading depth` setting** — a dropdown (default level 3) controls how
  deep the sub-entries go, from level 1 through level 6; `Off` restores the
  plain chapter-only TOC byte-for-byte.
- **First-heading rules** — a chapter's leading `#` heading is its title and
  is not duplicated as a sub-entry; duplicate heading texts get unique
  anchors (`-2`, `-3`), and heading text with quotes, ampersands, or Thai
  characters displays correctly with valid, resolvable anchors.
- Sub-entries link to anchors stamped into the chapter documents, keeping
  every book epubcheck-clean under EPUB 3.3 rules (verified with epubcheck
  5.3.0), including on books with duplicate or exotic heading text.

## 1.3.0

Books can now carry cover art, and they show it off properly on an e-reader.

- **`cover:` frontmatter field** — point it at an image in the vault (a
  path, a bare filename, a `[[wikilink]]`, or an `![[embed]]`) or at a remote
  URL, and the export embeds it as the EPUB 3 cover (`properties="cover-image"`
  - `<meta name="cover">`), so the Boox library shelf shows the artwork
    instead of a placeholder.
- **First-image fallback** — no `cover:` (or legacy `coverUrl:`) at all? The
  first image embed in the metadata note (outside code fences) becomes the
  cover, so existing vaults gain covers with zero frontmatter changes.
- **Cover page** — books with a cover open on a full-page, centered cover
  document as the first spine item. The cover page never appears in the table
  of contents; a `landmarks` entry keeps it reachable (epubcheck-clean under
  EPUB 3.3 rules, verified with epubcheck 5.3.0).
- **Formats** — `png`, `jpg`/`jpeg`, and `webp` are accepted as covers (all
  EPUB 3.3 core media types); anything else degrades with a warning, and a
  broken `cover:` reference never fails an export — the book still builds,
  coverless, with a warning naming the file.
- `cover:` takes precedence over the legacy `coverUrl:` when both are
  present; `coverUrl:` alone keeps working exactly as before.

## 1.2.0

Block-scoped embeds (`![[Note^blockid]]`) now work for every kind of block
Obsidian lets you label, instead of only paragraphs and headings.

- Tables, code blocks, callouts and blockquotes, and whole lists render their
  real content where they used to degrade to an "[embedded content omitted]"
  placeholder.
- A block ID on a single **list item** now works too, and brings that item's
  nested sub-items along with it — matching how Obsidian itself displays a
  block reference to a list item. Sibling items are not included, and an
  embedded numbered item keeps its original number (embedding step 3 shows
  "3.", not "1.").
- An indented block renders as the kind of thing it is: a nested bullet comes
  out as a bullet rather than a grey code box, while an indented-style code
  block keeps the indentation that makes it code.
- The `^blockid` marker itself is now guaranteed never to appear as stray text
  in an exported book, for every block type — including the paragraph and
  heading embeds that already worked. A caret inside embedded code (a regex, an
  exponent) is left untouched.
- Individual table _rows_ remain un-embeddable: Obsidian exposes a table as one
  whole block, so a `^id` typed inside a cell is ordinary cell text. Such a
  reference degrades with the same "block not found" warning as any other
  unresolvable block ID.

## 1.1.0

Chapters now carry a backlink trail: a "Linked from:" line listing every other
chapter in the same book that links to them, so a knowledge graph of
interconnected notes can be navigated backwards on an e-reader (#1).

- Every export mode gets it (single note, folder, note + linked notes); a
  chapter nothing links to shows no line at all, and a single-note book never
  shows one.
- Entries appear in the book's own chapter order, once per linking chapter,
  no matter how many times or in which form (alias, heading, block link,
  embed) it links.
- A new **Backlink listing position** setting controls placement: start of
  chapter (default), end, both, or none — none restores the previous
  behavior exactly.
- Works with any content language; the label itself is fixed English.

## 1.0.8

Heading- and block-scoped note embeds (`![[Note#Heading]]`, `![[Note^blockid]]`)
now render, instead of always degrading to a placeholder.

- A heading-scoped embed shows that heading plus everything under it, down to
  the next heading of equal or higher level — matching how Obsidian itself
  scopes a heading link. Nested embeds inside the extracted section resolve
  the same way they do inside a whole-note embed.
- A block-scoped embed shows just the single paragraph or heading carrying
  that block ID. A block ID on a list item, table row, or other block type
  still degrades to the placeholder — extracting those would require
  synthesizing a wrapping list/table around a single item just to keep the
  output valid, which isn't attempted here.
- An embed whose note exists but whose heading or block can't be found
  degrades to the existing placeholder with a warning that specifically says
  so ("heading not found" / "block not found"), distinct from a missing note.

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
