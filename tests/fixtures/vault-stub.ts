// Real-filesystem-backed vault + metadataCache for the local integration
// harness. Builds the `app` object src/main.ts consumes, backed by actual
// files under a vault root — no in-memory fixture data.
//
// Indexing is scoped to a "scan root" (a subtree of the vault) and is lazy:
// getAbstractFileByPath/cachedRead/readBinary/getFileCache all stat/read
// files on demand with no whole-vault walk. Only link resolution
// (getFirstLinkpathDest / resolvedLinks) needs to know every markdown
// basename in scope, so that's the one thing that does a bounded recursive
// walk of the scan root — never the whole vault.

import * as fs from "fs";
import * as path from "path";
import { App, FileSystemAdapter, TAbstractFile, TFile, TFolder } from "./obsidian-stub";

export interface FileCache {
  frontmatter: Record<string, unknown>;
  headings: { heading: string; level: number }[];
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

function parseHeadings(content: string): { heading: string; level: number }[] {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const headings: { heading: string; level: number }[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) headings.push({ level: m[1].length, heading: m[2].trim() });
  }
  return headings;
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

  // ── bounded recursive walk of the scan root, markdown files only ──
  const mdIndex: string[] = [];
  (function walk(rel: string) {
    const full = path.join(vaultRoot, rel);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.name.toLowerCase().endsWith(".md")) mdIndex.push(childRel);
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
    const target = linkpath.trim().replace(/\.md$/i, "");
    const candidates = mdIndex.filter((rel) => path.basename(rel, ".md") === target);
    if (candidates.length === 0) return null;
    const sourceDir = path.dirname(sourcePath);
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
      return { frontmatter: parseFrontmatter(content), headings: parseHeadings(content) };
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
