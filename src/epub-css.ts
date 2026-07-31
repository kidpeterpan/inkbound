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
/* ── PAN (Task 11): tune the reading experience for your Boox below ── */
`;
