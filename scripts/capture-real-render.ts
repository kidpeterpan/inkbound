// Captures what Obsidian's REAL MarkdownRenderer emits for a fixed set of
// markdown snippets, and writes each capture to tests/fixtures/real-render/
// as JSON. tests/real-render.test.ts then runs the pure render pipeline
// (the src/core/render-*.ts modules, src/core/math.ts, src/core/footnotes.ts) over that markup.
//
// WHY: the vitest stand-in for MarkdownRenderer is `marked` plus
// post-processing, not Obsidian's renderer (docs/DEVELOPMENT.md, "Testing and
// its limits"). Until 011-footnote-semantics every claim about real markup —
// which UI chrome to strip, how #tags render, whether the math placeholders
// survive, what an app:// image src looks like — was checked by hand. 011
// showed a cheaper route: capture the real markup once, through the same
// `obsidian … eval` + dataview `renderValue` call documented in
// specs/011-footnote-semantics/research.md, and test against that.
//
// HOW TO RUN (a maintainer task, not a CI step — it needs a running Obsidian):
//   npm run capture-real-render                # vault "pan_vault"
//   npm run capture-real-render -- --vault=X   # another vault
// Requirements: the `obsidian` CLI on PATH, that vault open, and the
// dataview community plugin enabled in it (`require("obsidian")` is not
// available inside `eval`, which is why dataview is the route to the real
// renderer). Nothing is written to the vault: each snippet renders into a
// detached element. Re-run after an Obsidian upgrade and commit the diff.
//
// FAITHFULNESS: the renderer is handed what renderUnitToChapter hands it —
// the source after stripFrontmatter, stripDynamicBlocks and protectMath — so
// the captured markup is what the pure passes see in production. Both the
// original (`sourceMarkdown`) and what was rendered (`renderedMarkdown`) are
// recorded. Two dataview artefacts are undone or noted: its bare wrapper
// <span> around the render is removed, and a single-paragraph render comes
// back without its <p> (dataview unwraps lone paragraphs), which does not
// matter to any pass under test.
//
// PORTABILITY of the output: the vault's absolute path appears inside every
// app:// image URL, so it is replaced with the token /VAULT in both the
// captured HTML and the recorded basePath — the fixtures carry no home
// directory. The image snippet references whichever .png the vault holds
// first; its path is recorded in the fixture's markdown fields.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { protectMath } from "../src/core/math";
import { stripDynamicBlocks, stripFrontmatter } from "../src/core/render";

export const BASE_PATH_TOKEN = "/VAULT";

interface Snippet {
  name: string;
  /** What the snippet exists to prove; copied into the fixture. */
  covers: string;
  markdown: string;
}

// {{PNG}} is replaced inside Obsidian with the first .png the vault has;
// {{PNG_URL}} with the same path percent-encoded, as a markdown image needs.
const SNIPPETS: Snippet[] = [
  {
    name: "chrome",
    covers:
      "UI chrome Obsidian adds to reading-view markup (CHROME_SELECTORS in src/core/render-dom.ts) and task-list checkboxes",
    markdown: [
      "---",
      "title: Frontmatter block",
      "tags: [alpha]",
      "---",
      "",
      "# Heading one",
      "",
      "Intro paragraph.",
      "",
      "## Heading two",
      "",
      "- item one",
      "  - nested item",
      "- item two",
      "",
      "- [ ] open task",
      "- [x] done task",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "> [!note] A callout",
      "> Callout body.",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
    ].join("\n"),
  },
  {
    name: "tags",
    covers: "inline #tags, Latin, nested and Thai, for the tag-to-plain-text rewrite in cleanupDom",
    markdown: "Tagged #alpha and #alpha/nested and Thai #แท็ก here.\n",
  },
  {
    name: "math-placeholders",
    covers:
      "the <span data-inkbound-math> placeholders protectMath writes before rendering survive the real renderer, inline and display",
    markdown: "Euler: $e^{i\\pi} + 1 = 0$ inline.\n\n$$\\int_0^1 x\\,dx$$\n\nAfter.\n",
  },
  {
    name: "app-image",
    covers: "the app:// image src branch of rewriteImages, for a wikilink embed and a markdown image",
    markdown: "![[{{PNG}}]]\n\n![caption]({{PNG_URL}})\n",
  },
  {
    name: "links-and-embeds",
    covers:
      "an unresolved wikilink (rewriteLinks) and an unresolved note embed (flattenEmbeds' placeholder path)",
    markdown: "See [[No Such Note Zzz]] and:\n\n![[No Such Embed Zzz]]\n\nAfter.\n",
  },
  {
    name: "base-block",
    covers:
      "an inline ```base code block: Obsidian puts the Bases toolbar (inputs, icons) into even a DETACHED render, which is what the export sees, and none of it may reach the book. The filter matches nothing, so the capture holds no vault content",
    markdown:
      'Before.\n\n```base\nfilters:\n  and:\n    - file.name == "zzz-no-such-file-zzz"\nviews:\n  - type: table\n    name: T\n```\n\nAfter.\n',
  },
];

/** What renderUnitToChapter does to the source before MarkdownRenderer sees it. */
function preRender(source: string): string {
  return protectMath(stripDynamicBlocks(stripFrontmatter(source))).md;
}

// Runs inside Obsidian. Kept as a plain string so nothing here is bundled.
function program(snippets: { name: string; covers: string; source: string; rendered: string }[]): string {
  return `(async () => {
  const dv = app.plugins.plugins.dataview;
  if (!dv) throw new Error("the dataview plugin must be enabled in this vault");
  const png = app.vault.getFiles().find((f) => f.extension === "png");
  const pngPath = png ? png.path : "missing.png";
  const fill = (s) => s.replace(/\\{\\{PNG\\}\\}/g, pngPath).replace(/\\{\\{PNG_URL\\}\\}/g, pngPath.replace(/ /g, "%20"));
  const results = [];
  for (const s of ${JSON.stringify(snippets)}) {
    const div = document.createElement("div");
    await dv.api.renderValue(fill(s.rendered), div, dv, "", false);
    // dataview wraps the render in a bare <span>; drop it so the fixture is
    // what Obsidian's renderer put into the container.
    const only = div.children.length === 1 ? div.children[0] : null;
    const html = only && only.tagName === "SPAN" && only.attributes.length === 0 ? only.innerHTML : div.innerHTML;
    results.push({ name: s.name, covers: s.covers, sourceMarkdown: fill(s.source), renderedMarkdown: fill(s.rendered), html });
  }
  return JSON.stringify({
    basePath: app.vault.adapter.getBasePath(),
    userAgent: navigator.userAgent,
    results,
  });
})()`;
}

function main(): void {
  const vaultArg = process.argv.find((a) => a.startsWith("--vault="));
  const vault = vaultArg ? vaultArg.slice("--vault=".length) : "pan_vault";
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const outDir = outArg ? outArg.slice("--out=".length) : join("tests", "fixtures", "real-render");

  const version = spawnSync("obsidian", ["version"], { encoding: "utf8" });
  // "1.13.7 (installer 1.12.7)" — the first token is the app; the user agent
  // only ever shows the installer, so it is not used.
  const obsidianVersion = /^\s*([\d.]+)/.exec(version.stdout ?? "")?.[1] ?? "unknown";

  const prepared = SNIPPETS.map((s) => ({
    name: s.name,
    covers: s.covers,
    source: s.markdown,
    rendered: preRender(s.markdown),
  }));
  const run = spawnSync("obsidian", [`vault=${vault}`, "eval", `code=${program(prepared)}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const stdout = run.stdout.trim();
  if (run.status !== 0 || !stdout.startsWith("=> ")) {
    throw new Error(`obsidian eval failed (status ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  const payload = JSON.parse(stdout.slice("=> ".length)) as {
    basePath: string;
    userAgent: string;
    results: {
      name: string;
      covers: string;
      sourceMarkdown: string;
      renderedMarkdown: string;
      html: string;
    }[];
  };
  const capturedAt = new Date().toISOString().slice(0, 10);

  mkdirSync(outDir, { recursive: true });
  for (const r of payload.results) {
    const fixture = {
      name: r.name,
      covers: r.covers,
      method:
        "obsidian vault=<name> eval → dataview api.renderValue (Obsidian's real MarkdownRenderer), " +
        "detached element, nothing written to the vault; the vault's absolute path is replaced by " +
        BASE_PATH_TOKEN,
      obsidianVersion,
      capturedAt,
      basePath: BASE_PATH_TOKEN,
      sourceMarkdown: r.sourceMarkdown,
      renderedMarkdown: r.renderedMarkdown,
      html: r.html.split(payload.basePath).join(BASE_PATH_TOKEN),
    };
    const file = join(outDir, `${r.name}.json`);
    writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`captured ${r.name} → ${file} (${fixture.html.length} chars, Obsidian ${obsidianVersion})`);
  }
}

main();
