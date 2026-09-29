// Stylesheet embedded in every generated EPUB. Keep e-ink friendly:
// high contrast, no color-dependent meaning, generous line height for Thai.
export const EPUB_CSS = `
body { line-height: 1.7; margin: 0 0.4em; }
h1, h2, h3 { line-height: 1.3; page-break-after: avoid; }
img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; word-wrap: break-word; font-size: 0.85em; border: 1px solid #888; padding: 0.5em; }
code { font-family: monospace; }
blockquote { border-left: 3px solid #555; margin-left: 0; padding-left: 1em; }
table { border-collapse: collapse; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; }
/* Obsidian callouts arrive as div.callout with div.callout-title / div.callout-content */
.callout { border: 1px solid #555; padding: 0.5em 0.8em; margin: 1em 0; }
.callout-title { font-weight: bold; }
.omitted { color: #555; font-style: italic; }
/* Backlink trail ("Linked from:") — reads as chrome, not prose, on e-ink:
   hairline separator, slightly smaller, roomy line height for tap targets. */
.backlinks { border-top: 1px solid #888; border-bottom: 1px solid #888; margin: 0.8em 0; padding: 0.3em 0; }
.backlinks p { font-size: 0.85em; line-height: 1.9; margin: 0.2em 0; }
/* Cover page: the first spine document when a book has cover art — the image
   fills the page, centered, with no surrounding chrome. */
.cover-page { margin: 0; text-align: center; }
.cover-page img { max-width: 100%; max-height: 100%; }
/* Math (005-latex-math): display math is a centered block on its own line;
   inline math rides the text baseline via the vertical-align style the
   rasterizer copies from the MathJax SVG (see renderMath in math.ts). */
.math-block { text-align: center; margin: 1em 0; }
.math-block img { max-width: 100%; height: auto; }
/* ── PAN (Task 11): tune the reading experience for your Boox below ── */
`;

// 011-footnote-semantics: appended to epub.css ONLY for books that carry footnotes, so a
// footnote-free book's stylesheet stays byte-identical (FR-023). Same e-ink rules as the
// rest of this file: no colour-dependent meaning, no assets, no font override (a Thai
// note keeps whatever font the book already chose).
export const FOOTNOTE_CSS = `
/* Footnotes: a raised number that leads to the note, and one section of notes at the
   chapter's end. The marker must not open up its line: line-height 0 keeps the
   superscript from pushing neighbouring lines apart. Padding gives a finger something
   to hit on e-ink without changing how the line reads. */
sup.footnote-ref { font-size: 0.75em; line-height: 0; vertical-align: super; }
sup.footnote-ref a { text-decoration: none; padding: 0 0.15em; }
.footnotes { border-top: 1px solid #888; margin-top: 2em; padding-top: 0.4em; font-size: 0.9em; }
.footnote { margin: 0.6em 0; }
.footnote p { margin: 0.25em 0; }
.footnote-num { font-weight: bold; }
.footnote-backref { text-decoration: none; padding: 0 0.4em; }
`;
