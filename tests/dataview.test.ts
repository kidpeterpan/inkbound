import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { protectDataview, resolveDataviewPlaceholders, type SinkBlock } from "../src/core/content/dataview";

const placeholder = (index: number): string => `<span data-inkbound-dataview="${index}"></span>`;

function blockSummary(md: string) {
  return protectDataview(md).blocks.map(({ kind, startLine, endLine, prefix }) => ({
    kind,
    startLine,
    endLine,
    prefix,
  }));
}

describe("protectDataview — fence recognition", () => {
  it("F1: a backtick dataview fence is a query block", () => {
    const md = "Before.\n\n```dataview\nLIST\n```\n\nAfter.\n";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 2, endLine: 4, prefix: "" }]);
    expect(protectDataview(md).md).toBe(`Before.\n\n${placeholder(0)}\n\nAfter.\n`);
  });

  it("F2: a dataviewjs fence is a js block", () => {
    const md = '```dataviewjs\ndv.paragraph("x")\n```';
    expect(blockSummary(md)).toEqual([{ kind: "js", startLine: 0, endLine: 2, prefix: "" }]);
    expect(protectDataview(md).md).toBe(placeholder(0));
  });

  it("F3: a tilde fence is recognised", () => {
    const md = "~~~dataview\nLIST\n~~~\nafter";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 2, prefix: "" }]);
    expect(protectDataview(md).md).toBe(`${placeholder(0)}\nafter`);
  });

  it("F4: a four-backtick fence is recognised and leaves no stray backticks", () => {
    const md = "a\n````dataview\nLIST\n````\nb";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "" }]);
    expect(protectDataview(md).md).toBe(`a\n${placeholder(0)}\nb`);
  });

  it("F5: trailing spaces after the language are allowed", () => {
    expect(blockSummary("```dataview   \nLIST\n```")).toEqual([
      { kind: "query", startLine: 0, endLine: 2, prefix: "" },
    ]);
  });

  it("F6: the language is the first word of the info string", () => {
    expect(blockSummary("```dataview extra words\nLIST\n```")).toEqual([
      { kind: "query", startLine: 0, endLine: 2, prefix: "" },
    ]);
  });

  it("F7: the language is case-sensitive, so ```Dataview stays a code block", () => {
    const md = "```Dataview\nLIST\n```\n\n```DATAVIEW\nLIST\n```";
    expect(protectDataview(md).blocks).toEqual([]);
    expect(protectDataview(md).md).toBe(md);
  });

  it("F8: other languages that merely start with dataview are not Dataview", () => {
    expect(protectDataview("```dataviewx\nLIST\n```").blocks).toEqual([]);
    expect(protectDataview("```data view\nLIST\n```").blocks).toEqual([]);
  });

  it("F9: up to three spaces of indentation still open a fence", () => {
    const md = "   ```dataview\nLIST\n   ```";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 2, prefix: "   " }]);
    expect(protectDataview(md).md).toBe(`   ${placeholder(0)}`);
  });

  it("F10: four spaces at top level is an indented code block, not a fence", () => {
    const md = "Para.\n\n    ```dataview\n    LIST\n    ```";
    expect(protectDataview(md).blocks).toEqual([]);
    expect(protectDataview(md).md).toBe(md);
  });

  it("F11: a fence inside a callout keeps the callout prefix", () => {
    const md = "> [!note]\n> ```dataview\n> LIST\n> ```\nafter";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "> " }]);
    expect(protectDataview(md).md).toBe(`> [!note]\n> ${placeholder(0)}\nafter`);
  });

  it("F11: a quoted fence ends where its blockquote ends", () => {
    const md = "> ```dataview\n> LIST\nafter";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 1, prefix: "> " }]);
    expect(protectDataview(md).md).toBe(`> ${placeholder(0)}\nafter`);
  });

  it("F12: a fence inside a nested quote keeps both markers", () => {
    const md = "> [!note]\n> > ```dataview\n> > LIST\n> > ```";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "> > " }]);
    expect(protectDataview(md).md).toBe(`> [!note]\n> ${"> "}${placeholder(0)}`);
  });

  it("F13: a fence indented to a list item's content belongs to the item", () => {
    const afterBlank = "- item\n\n    ```dataview\n    LIST\n    ```";
    expect(blockSummary(afterBlank)).toEqual([{ kind: "query", startLine: 2, endLine: 4, prefix: "    " }]);
    expect(protectDataview(afterBlank).md).toBe(`- item\n\n    ${placeholder(0)}`);

    const twoSpaces = "- item\n  ```dataview\n  LIST\n  ```";
    expect(blockSummary(twoSpaces)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "  " }]);

    const ordered = "1. item\n   ```dataview\n   LIST\n   ```";
    expect(blockSummary(ordered)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "   " }]);
  });

  it("F14: a Dataview query shown inside another fenced block is code, not a block", () => {
    const md = "````markdown\n```dataview\nLIST\n```\n````";
    expect(protectDataview(md).blocks).toEqual([]);
    expect(protectDataview(md).md).toBe(md);

    const tildeSample = "~~~\n```dataviewjs\ndv.x()\n```\n~~~";
    expect(protectDataview(tildeSample).blocks).toEqual([]);
  });

  it("F15: an unclosed fence runs to the end of the source", () => {
    const md = "Text\n\n```dataview\nLIST\nmore";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 2, endLine: 4, prefix: "" }]);
    expect(protectDataview(md).md).toBe(`Text\n\n${placeholder(0)}`);
  });

  it("F16: a shorter fence does not close a block", () => {
    const md = "```dataview\nLIST\n``\nmore\n```\nafter";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 4, prefix: "" }]);
  });

  it("F17: a three-backtick line does not close a four-backtick block", () => {
    const md = "````dataview\nLIST\n```\n````\nafter";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 3, prefix: "" }]);
  });

  it("F17: a tilde line does not close a backtick block", () => {
    const md = "```dataview\nLIST\n~~~\n```";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 3, prefix: "" }]);
  });

  it("F18: a backtick info string containing a backtick is not a fence", () => {
    const md = "```dataview `x`\nLIST\n```";
    expect(protectDataview(md).blocks).toEqual([]);
  });

  it("F19: CRLF sources are recognised and keep their line breaks", () => {
    const md = "a\r\n```dataview\r\nLIST\r\n```\r\nb\r\n";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 1, endLine: 3, prefix: "" }]);
    expect(protectDataview(md).md).toBe(`a\r\n${placeholder(0)}\r\nb\r\n`);
  });

  it("a fence on a list item's own line is recognised", () => {
    const md = "- ```dataview\n  LIST\n  ```";
    expect(blockSummary(md)).toEqual([{ kind: "query", startLine: 0, endLine: 2, prefix: "- " }]);
  });
});

function markdownFilesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) return markdownFilesUnder(full);
    return name.endsWith(".md") ? [full] : [];
  });
}

describe("protectDataview — identity", () => {
  it("returns the very same string when there is no Dataview block", () => {
    const md = "# Title\n\n```ts\nconst x = 1;\n```\n\n> quote\n";
    expect(protectDataview(md).md).toBe(md);
    expect(protectDataview(md).blocks).toEqual([]);
  });

  it("leaves every existing fixture note untouched", () => {
    const smokeVault = path.join(__dirname, "fixtures", "smoke-vault");
    const notes = [
      ...markdownFilesUnder(path.join(smokeVault, "Book")),
      ...markdownFilesUnder(path.join(smokeVault, "Footnotes")),
    ];
    expect(notes.length).toBeGreaterThan(5);
    for (const note of notes) {
      const source = readFileSync(note, "utf8");
      expect(protectDataview(source).md).toBe(source);
    }
  });

  it("keeps CRLF on every untouched line", () => {
    const md = "one\r\ntwo\r\n```dataview\r\nLIST\r\n```\r\nthree\r\nfour";
    expect(protectDataview(md).md).toBe(`one\r\ntwo\r\n${placeholder(0)}\r\nthree\r\nfour`);
  });

  it("numbers blocks from zero in source order", () => {
    const md = "```dataview\nA\n```\ntext\n```dataviewjs\nB\n```\ntext\n~~~dataview\nC\n~~~";
    const result = protectDataview(md);
    expect(result.blocks.map((block) => block.kind)).toEqual(["query", "js", "query"]);
    expect(result.md).toBe(`${placeholder(0)}\ntext\n${placeholder(1)}\ntext\n${placeholder(2)}`);
  });
});

describe("protectDataview — numbering from a chapter offset", () => {
  it("starts placeholder numbers at the given first index", () => {
    const md = "```dataview\nA\n```\n\n```dataviewjs\nB\n```";
    expect(protectDataview(md, 5).md).toBe(`${placeholder(5)}\n\n${placeholder(6)}`);
  });
});

describe("protectDataview — fence field", () => {
  it("is the block's own fenced markdown without its container prefix", () => {
    const md = "> [!note]\n> ```dataview\n> LIST\n> ```";
    expect(protectDataview(md).blocks[0].fence).toBe("```dataview\nLIST\n```");
  });

  it("removes a list item's indentation from every line", () => {
    const md = "- item\n\n    ```dataview\n    TABLE x\n      FROM y\n    ```";
    expect(protectDataview(md).blocks[0].fence).toBe("```dataview\nTABLE x\n  FROM y\n```");
  });

  it("keeps the opener's fence characters and info string", () => {
    const md = "~~~~dataview extra\nLIST\n~~~~";
    expect(protectDataview(md).blocks[0].fence).toBe("~~~~dataview extra\nLIST\n~~~~");
  });

  it("gets a closing fence of the opener's kind and length when the source has none", () => {
    const md = "````dataview\nLIST\nmore";
    expect(protectDataview(md).blocks[0].fence).toBe("````dataview\nLIST\nmore\n````");
  });
});

function chapter(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function sinkBlock(index: number, kind: SinkBlock["kind"], notePath = "Note.md"): SinkBlock {
  return { index, kind, notePath, fence: "```dataview\nLIST\n```" };
}

const QUERY_MARKER = '<p class="omitted">[Dataview query omitted]</p>';
const JS_MARKER = '<p class="omitted">[DataviewJS omitted]</p>';

describe("resolveDataviewPlaceholders — placement", () => {
  it("replaces a paragraph that holds only the placeholder", () => {
    const root = chapter(`<p>Before.</p><p dir="auto">${placeholder(0)}</p><p>After.</p>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query")]);
    expect(root.innerHTML).toBe(`<p>Before.</p>${QUERY_MARKER}<p>After.</p>`);
  });

  it("ignores whitespace beside the placeholder when deciding the paragraph is its own", () => {
    const root = chapter(`<p>\n${placeholder(0)}\n</p>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query")]);
    expect(root.innerHTML).toBe(QUERY_MARKER);
  });

  it("puts the marker after a paragraph that also holds text, keeping the text", () => {
    const root = chapter(`<p>Text ${placeholder(0)}</p><p>Next.</p>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query")]);
    expect(root.innerHTML).toBe(`<p>Text </p>${QUERY_MARKER}<p>Next.</p>`);
  });

  it("replaces a placeholder sitting directly in a list item", () => {
    const root = chapter(`<ul><li>item\n${placeholder(0)}</li></ul>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query")]);
    expect(root.innerHTML).toBe(`<ul><li>item\n${QUERY_MARKER}</li></ul>`);
  });

  it("replaces the paragraph inside a callout's content", () => {
    const root = chapter(`<div class="callout-content"><p dir="auto">${placeholder(0)}</p></div>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query")]);
    expect(root.innerHTML).toBe(`<div class="callout-content">${QUERY_MARKER}</div>`);
  });

  it("names DataviewJS in the marker of a js block", () => {
    const root = chapter(`<p>${placeholder(0)}</p>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "js")]);
    expect(root.innerHTML).toBe(JS_MARKER);
  });

  it("resolves each placeholder by its own index", () => {
    const root = chapter(`<p>${placeholder(1)}</p><p>${placeholder(0)}</p>`);
    resolveDataviewPlaceholders(root, [sinkBlock(0, "query"), sinkBlock(1, "js")]);
    expect(root.innerHTML).toBe(`${JS_MARKER}${QUERY_MARKER}`);
  });
});

describe("resolveDataviewPlaceholders — warnings", () => {
  it("returns one line per block, in index order, attributed to the note it is written in", () => {
    const root = chapter(`<p>${placeholder(0)}</p><p>${placeholder(1)}</p>`);
    const warnings = resolveDataviewPlaceholders(root, [
      sinkBlock(0, "query", "A.md"),
      sinkBlock(1, "js", "B.md"),
    ]);
    expect(warnings).toEqual([
      "Dataview query omitted: Dataview results are not exported (referenced by A.md)",
      "DataviewJS omitted: Inkbound never runs DataviewJS (referenced by B.md)",
    ]);
  });

  it("reports a block whose placeholder is gone instead of dropping it silently", () => {
    const root = chapter("<p>No placeholder survived.</p>");
    expect(() => resolveDataviewPlaceholders(root, [sinkBlock(0, "query", "A.md")])).not.toThrow();
    expect(resolveDataviewPlaceholders(chapter("<p>x</p>"), [sinkBlock(0, "query", "A.md")])).toEqual([
      "Dataview query omitted: it could not be rendered — placeholder lost (referenced by A.md)",
    ]);
  });

  it("touches nothing and says nothing when the chapter has no Dataview block", () => {
    const html = "<p>Plain chapter.</p><pre><code>```dataview</code></pre>";
    const root = chapter(html);
    expect(resolveDataviewPlaceholders(root, [])).toEqual([]);
    expect(root.innerHTML).toBe(html);
  });
});

describe("protectDataview — the cases stripDynamicBlocks used to cover", () => {
  it("replaces a dataview fence between two lines", () => {
    expect(protectDataview("before\n```dataview\nLIST\n```\nafter").md).toBe(
      `before\n${placeholder(0)}\nafter`
    );
  });

  it("replaces a dataviewjs fence too", () => {
    expect(protectDataview("```dataviewjs\ndv.list()\n```").md).toBe(placeholder(0));
  });
});
