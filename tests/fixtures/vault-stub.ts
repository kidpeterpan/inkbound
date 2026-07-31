// Real-filesystem-backed vault + metadataCache for the local integration
// harness. Builds the `app` object src/main.ts consumes, backed by actual
// files under a vault root — no in-memory fixture data.
//
// Indexing is scoped to a "scan root" (a subtree of the vault) and is lazy:
// getAbstractFileByPath/cachedRead/readBinary/getFileCache all stat/read
// files on demand with no whole-vault walk. Only link resolution
// (getFirstLinkpathDest / resolvedLinks) needs to know every file's
// basename in scope, so that's the one thing that does a bounded recursive
// walk of the scan root — never the whole vault. Real Obsidian's
// `getFirstLinkpathDest` resolves ANY file type (it's the same resolver
// used for `![[image.png]]` embeds and bare-filename markdown image links,
// not just note wikilinks), so this stub indexes every file under the scan
// root, not only `.md` — markdown wikilink resolution (basename, ".md"
// implied) and non-markdown fuzzy-filename resolution (e.g. images
// referenced from a sibling `assets/` folder) share the same fallback path.

import * as fs from "fs";
import * as path from "path";
import { App, FileSystemAdapter, TAbstractFile, TFile, TFolder } from "./obsidian-stub";

// position shape matches node_modules/obsidian/obsidian.d.ts's HeadingCache/
// SectionCache — real Obsidian's own Pos type has more fields (col, offset)
// this harness never reads, so only start.line/end.line are populated here;
// render-adapter.ts's toHeadingInfo/toSectionInfo only ever read those two.
interface StubPos {
  start: { line: number };
  end: { line: number };
}
export interface FileCache {
  frontmatter: Record<string, unknown>;
  headings: { heading: string; level: number; position: StubPos }[];
  sections: { id?: string; type: string; position: StubPos }[];
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Deliberately simple, per the brief: scalars, `key:` followed by `- item`
// lists, and inline `[a, b]` lists. That covers everything the vault's
// reading notes actually use (tags, author, coverUrl, language, aliases).
function parseFrontmatter(content: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const fm: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const line of lines) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      (fm[currentListKey] as unknown[]).push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1];
      const rest = kv[2].trim();
      if (rest === "") {
        fm[key] = [];
        currentListKey = key;
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        fm[key] = rest
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
        currentListKey = null;
      } else {
        fm[key] = stripQuotes(rest);
        currentListKey = null;
      }
    } else {
      currentListKey = null;
    }
  }
  return fm;
}

// Computed against the FULL content (frontmatter included, no stripping) —
// real Obsidian's own line numbers are relative to the whole file, and
// render-adapter.ts's scoped-embed slicing reads raw `cachedRead()` content
// the same way (see specs/002-scoped-note-embeds/research.md's Unknown 2).
// Deliberately narrower than a full CommonMark parser: paragraphs are "one
// or more non-blank, non-fence, non-heading, non-list lines" — enough to
// exercise heading-scoped and paragraph/heading block-scoped embeds via
// `npm run local-export`; list-item block IDs are recognized only so
// they're correctly classified as unsupported, not extracted as if they
// were a paragraph.
const BLOCK_ID_RE = /\^([A-Za-z0-9-]+)\s*$/;
const LIST_LINE_RE = /^\s*([-*+]|\d+\.)\s+/;

function pos(startLine: number, endLine: number): StubPos {
  return { start: { line: startLine }, end: { line: endLine } };
}

function parseHeadingsAndSections(content: string): {
  headings: FileCache["headings"];
  sections: FileCache["sections"];
} {
  const lines = content.split(/\r?\n/);
  const headings: FileCache["headings"] = [];
  const sections: FileCache["sections"] = [];
  let inFence = false;
  let paraStart: number | null = null;

  const flushParagraph = (endLine: number): void => {
    if (paraStart === null || endLine < paraStart) return;
    const m = BLOCK_ID_RE.exec(lines[endLine]);
    sections.push({ id: m?.[1], type: "paragraph", position: pos(paraStart, endLine) });
    paraStart = null;
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      flushParagraph(i - 1);
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(i - 1);
      const text = heading[2].trim();
      const idMatch = BLOCK_ID_RE.exec(text);
      const headingText = idMatch ? text.slice(0, idMatch.index).trim() : text;
      headings.push({ heading: headingText, level: heading[1].length, position: pos(i, i) });
      sections.push({ id: idMatch?.[1], type: "heading", position: pos(i, i) });
      return;
    }

    if (LIST_LINE_RE.test(line)) {
      flushParagraph(i - 1);
      const m = BLOCK_ID_RE.exec(line);
      sections.push({ id: m?.[1], type: "list", position: pos(i, i) });
      return;
    }

    if (line.trim() === "") {
      flushParagraph(i - 1);
      return;
    }
    if (paraStart === null) paraStart = i;
  });
  flushParagraph(lines.length - 1);

  return { headings, sections };
}

function normalizeRel(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface VaultStubHandle {
  app: App;
  setActiveFile(f: TFile | null): void;
}

export function createVaultStub(vaultRoot: string, scanRootRel: string): VaultStubHandle {
  const normalizedScanRoot = normalizeRel(scanRootRel);

  // ── bounded recursive walk of the scan root: every file, plus a
  //    markdown-only subset for wikilink-specific logic (resolvedLinks) ──
  const mdIndex: string[] = [];
  const fileIndex: string[] = [];
  (function walk(rel: string) {
    const full = path.join(vaultRoot, rel);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRel);
      } else {
        fileIndex.push(childRel);
        if (entry.name.toLowerCase().endsWith(".md")) mdIndex.push(childRel);
      }
    }
  })(normalizedScanRoot);

  function getAbstractFileByPath(p: string): TAbstractFile | null {
    const norm = normalizeRel(p);
    const full = path.join(vaultRoot, norm);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return null;
    }
    return st.isDirectory() ? new TFolder(vaultRoot, norm) : new TFile(vaultRoot, norm);
  }

  function getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const raw = linkpath.trim();
    const sourceDir = path.dirname(sourcePath);

    // 1. Direct path resolution: try the linkpath as written relative to
    //    the source note's folder, then as a vault-root-relative path.
    //    Mirrors real Obsidian trying a literal path before fuzzy fallback.
    for (const cand of [normalizeRel(path.join(sourceDir, raw)), normalizeRel(raw)]) {
      if (fileIndex.includes(cand)) return new TFile(vaultRoot, cand);
    }

    // 2. Fuzzy fallback: match by basename across every indexed file.
    //    Note wikilinks omit the extension (assume ".md"); markdown image
    //    syntax and embeds always carry the real extension.
    const hasExt = /\.[^./\\]+$/.test(raw) && !/\.md$/i.test(raw);
    const target = hasExt ? path.basename(raw) : path.basename(raw).replace(/\.md$/i, "");
    const pool = hasExt ? fileIndex : mdIndex;
    const candidates = pool.filter((rel) => {
      const base = path.basename(rel);
      return hasExt ? base === target : base.replace(/\.md$/i, "") === target;
    });
    if (candidates.length === 0) return null;
    const sameFolder = candidates.find((c) => path.dirname(c) === sourceDir);
    const chosen = sameFolder ?? [...candidates].sort()[0];
    return new TFile(vaultRoot, chosen);
  }

  let resolvedLinksCache: Record<string, Record<string, number>> | null = null;
  function buildResolvedLinks(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    const linkRe = /!?\[\[([^\]|#]+)[^\]]*\]\]/g;
    for (const relPath of mdIndex) {
      const content = fs.readFileSync(path.join(vaultRoot, relPath), "utf8");
      const counts: Record<string, number> = {};
      let m: RegExpExecArray | null;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(content))) {
        const dest = getFirstLinkpathDest(m[1], relPath);
        if (dest) counts[dest.path] = (counts[dest.path] ?? 0) + 1;
      }
      if (Object.keys(counts).length > 0) out[relPath] = counts;
    }
    return out;
  }

  let activeFile: TFile | null = null;

  const vault = {
    getAbstractFileByPath,
    async cachedRead(file: TFile): Promise<string> {
      return fs.promises.readFile(path.join(vaultRoot, file.path), "utf8");
    },
    async readBinary(file: TFile): Promise<ArrayBuffer> {
      const buf = await fs.promises.readFile(path.join(vaultRoot, file.path));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    adapter: new FileSystemAdapter(vaultRoot),
  };

  const metadataCache = {
    getFileCache(file: TFile): FileCache | null {
      let content: string;
      try {
        content = fs.readFileSync(path.join(vaultRoot, file.path), "utf8");
      } catch {
        return null;
      }
      const { headings, sections } = parseHeadingsAndSections(content);
      return { frontmatter: parseFrontmatter(content), headings, sections };
    },
    getFirstLinkpathDest,
    get resolvedLinks(): Record<string, Record<string, number>> {
      if (!resolvedLinksCache) resolvedLinksCache = buildResolvedLinks();
      return resolvedLinksCache;
    },
    unresolvedLinks: {} as Record<string, Record<string, number>>,
  };

  const workspace = {
    getActiveFile(): TFile | null {
      return activeFile;
    },
  };

  const app = new App();
  Object.assign(app, { vault, metadataCache, workspace });

  return {
    app,
    setActiveFile(f: TFile | null) {
      activeFile = f;
    },
  };
}
