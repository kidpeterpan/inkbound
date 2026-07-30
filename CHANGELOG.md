# Changelog

The release workflow reads the section matching the pushed tag and uses it as
the GitHub release description, so keep the heading format `## <version>`.

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
