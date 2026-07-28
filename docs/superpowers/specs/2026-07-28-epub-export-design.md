# EPUB Export Plugin for Obsidian — Design

**Date:** 2026-07-28
**Status:** Approved by user (design conversation, 2026-07-28)
**Project:** `obsidian-epub-export` — a custom Obsidian plugin that exports vault notes as `.epub` files and pushes them to an Onyx Boox e-ink device via BooxDrop.

## Problem

Pan reads notes from the `pan_vault` Obsidian vault (notably Thai-language book summaries under `02. areas/03. reading/{book_slug}/`) and wants to read them on a Boox e-ink device. Markdown files are awkward on e-readers; EPUB is the native format. Today there is no installed plugin that exports EPUB, and no automated path from vault to device.

## Requirements

1. **Three export scopes**, each producing one `.epub`:
   - **Single note** — the active/right-clicked note.
   - **Book folder** — a folder (e.g. `02. areas/03. reading/{book_slug}/`) becomes a chaptered EPUB: chapters ordered by the `NN_` filename prefix, book metadata mined from the index note's frontmatter (`author` → `dc:creator`, `coverUrl` → downloaded and embedded as cover, title from index note name/alias).
   - **Note + linked notes** — the note plus notes reachable via `[[wikilinks]]`, breadth-first, to a **configurable depth (default 1, max 3)**, deduplicated.
2. **Delivery**: always save the `.epub` to a configurable local output folder first; then, if enabled, **push to the Boox device over LAN via BooxDrop** (the device's local HTTP server, typically `http://<device-ip>:8085`). Push failure must never lose the export.
3. Thai content must render correctly (`dc:language` configurable, default `th`); rely on Boox system fonts, no font embedding.
4. Images referenced by notes (including `05. assets/`) are embedded in the EPUB.

## Approach decision

**Chosen: A — self-contained custom plugin.**
- Markdown → HTML via Obsidian's own `MarkdownRenderer.render()` (identical rendering to the app: callouts, highlights, Thai text), then DOM post-processing to valid XHTML.
- EPUB 3 container assembled in-plugin with JSZip (hand-rolled `mimetype`, `container.xml`, OPF package, nav doc, chapters).
- BooxDrop push via Obsidian's `requestUrl()` (bypasses CORS; works against LAN devices).

**Rejected:**
- **B — Pandoc-based** (best typography, but external binary dependency, and wikilinks/callouts/folder-chaptering would still need custom code).
- **C — existing tools only** (`obsidian-enhancing-export` + manual BooxDrop web upload: no chaptered folders, no link bundling, manual pushes).

## Where the code lives

- Source: `~/Documents/obsidian-epub-export/` — own git repo, TypeScript + esbuild (standard Obsidian plugin toolchain).
- Deploy: build script copies **only** `main.js`, `manifest.json`, `styles.css` into `pan_vault/.obsidian/plugins/epub-export/`. No `node_modules` in the vault (protects Obsidian Sync and any future vault git).
- `manifest.json`: id `epub-export`, `isDesktopOnly: true` for v1.

## UX

Commands (palette) + matching context-menu items:

| Trigger | Result |
|---|---|
| Command / note right-click → "Export note to EPUB" | Single-note EPUB |
| Folder right-click (or command, which uses the active note's parent folder) → "Export folder as EPUB" | Chaptered EPUB |
| Command / note right-click → "Export note + linked notes to EPUB" | Bundled EPUB at configured depth |

**Settings tab:**
- Output folder (absolute path, default `~/Downloads`)
- Default link depth (1; range 1–3)
- Default language (`th`)
- Fallback author name
- BooxDrop: device URL, "push after export" toggle, **Test connection** button

## Components

| Module | Single job |
|---|---|
| `main.ts` | Thin entry: registers commands, menus, settings tab |
| `settings.ts` | Settings model + tab UI |
| `collect.ts` | Trigger → ordered `ExportUnit[]`: `single(file)`, `folder(dir)` (sort by `NN_` prefix; locate index note), `linked(file, depth)` (BFS over `metadataCache.resolvedLinks`, dedup) + export-level metadata (title/author/cover) |
| `render.ts` | Per note: `MarkdownRenderer.render()` → DOM cleanup → valid XHTML string + referenced-asset list |
| `epub.ts` | `EpubBuilder`: chapters/assets/metadata in → spec-compliant `.epub` bytes out (JSZip; `mimetype` first entry, stored uncompressed) |
| `booxdrop.ts` | The only module aware of BooxDrop's unofficial API: `push(name, bytes)`, `testConnection()` via `requestUrl` — anti-corruption layer for firmware changes |
| `epub.css` | Stylesheet shipped inside every EPUB, tuned for e-ink: high contrast, quiet callout styling, wrapped code blocks, Thai-friendly line height |

## Data flow

```
command → collect (ordered notes + metadata)
        → render each note (XHTML + assets)
        → EpubBuilder (embed images, cover, internal TOC/nav)
        → save to output folder            ← unconditional
        → BooxDrop push (if enabled)
        → Notice: success | "saved locally, push failed: <reason>"
```

**Output filename:** slugified export title + `.epub` (e.g. `learn_go_with_tests.epub`). Existing files are overwritten — exports are regenerable, and stable names keep the Boox library from accumulating duplicates.

## Content handling rules

| In the note | In the EPUB |
|---|---|
| YAML frontmatter | Stripped from body; mined for metadata in folder mode |
| `[[wikilink]]` to note **inside** export set | Internal link to that chapter file |
| `[[wikilink]]` to note **outside** export set | Plain text (display title kept) |
| `![[image]]` / vault images | Embedded asset; `<img src>` rewritten to internal path |
| Callouts `> [!note]` | Rendered by Obsidian renderer; styled by `epub.css` |
| Code fences | Monospace, verbatim, soft-wrapped for narrow screens |
| Dataview blocks | Replaced with "*[dynamic content omitted]*" (v1) |
| Excalidraw embeds | Placeholder marker (v1) |
| Thai text | Untouched; `dc:language` from settings |
| `#tags` | Plain de-styled text |

## Error handling

- **Never lose an export:** local save happens before push; push failure → Notice with reason + saved path.
- Missing image / unresolvable link / skipped block → export continues; warnings accumulate; one summary Notice ("Exported with N warnings — details in developer console").
- Folder without `NN_` prefixes → alphabetical fallback; index note detected by `book` + `main` tags, else name == folder name.
- A note that throws during render → skipped with warning; remaining chapters still export.
- `coverUrl` download failure → warning; export proceeds without a cover.
- Rendering happens in a detached DOM element; per-note failures are isolated.

## BooxDrop integration risk

BooxDrop's HTTP API is **unofficial and firmware-versioned**. Mitigations:
- Verify the real endpoint against the user's device during implementation (curl probe first, then implement `booxdrop.ts` to match).
- All BooxDrop knowledge isolated in one module.
- *Test connection* button in settings for post-firmware-update sanity checks.
- Local save is the unconditional baseline, so a broken push never blocks reading (manual BooxDrop web upload remains possible).

## Testing

- **Unit (vitest, in plugin repo):** EPUB container structure (mimetype ordering, OPF manifest completeness, nav correctness), `NN_` chapter ordering + index-note detection, link-rewrite rules (inside vs outside set), depth-limited BFS dedup. Thin Obsidian API mocks; jsdom for DOM.
- **Spec compliance:** dev script runs `epubcheck` on a generated sample EPUB.
- **Integration (manual):** deploy to vault → export a real book folder from `02. areas/03. reading/` → verify structure in macOS Books.app → verify rendering + BooxDrop push on the Boox device itself.
- Implementation follows TDD: tests first per pure module.

## Out of scope (v1)

- Rendering Dataview query results or Excalidraw drawings into the EPUB
- Mobile support (`isDesktopOnly: true`)
- Font embedding
- Onyx cloud push (`push.boox.com`) — LAN BooxDrop only
- Community-plugin-store release engineering (can follow later)

## Learning-mode contribution points (for the implementation plan)

Two decisions reserved for Pan to implement by hand (~10 lines each):
1. **`epub.css` e-ink styling choices** — how callouts/quotes/code look on the Boox.
2. **Chapter-title derivation rule** — precedence among filename, first `# H1`, frontmatter alias.
