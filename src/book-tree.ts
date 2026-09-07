// 009-index-order-parts — the folder-export planner.
//
// Pure module: zero `obsidian` imports (constitution IV). main.ts walks the
// TFolder, resolves each note's links to vault paths, and hands the plain
// tree below to planBook; what comes back is the book's reading order plus a
// nested table-of-contents plan. Title resolution and TFile lookups stay in
// main.ts (they need metadataCache); everything here is keyed by vault PATH,
// never by basename — two subfolders may hold same-named notes (FR-018).
//
// planBook is total: any structurally valid input produces a plan, and it
// never throws. main.ts still wraps the call (research R5) so an unexpected
// bug degrades to today's flat order with a warning instead of failing the
// export (constitution II).

import { orderByName, pickIndexNote } from "./collect";

export interface NoteInput {
  /** Vault-relative file path — the identity key for everything in this module. */
  path: string;
  /** Filename without extension; used only for index detection and name ordering within one folder. */
  basename: string;
  /** Frontmatter `tags` when it is a genuine array; `[]` otherwise. */
  tags: string[];
  /** Resolved vault paths of the note's regular links, in document order. Embeds excluded. */
  linkTargets: string[];
}

export interface FolderInput {
  name: string;
  path: string;
  notes: NoteInput[];
  subfolders: FolderInput[];
}

export type NavPlanNode =
  | { kind: "chapter"; path: string }
  | { kind: "part"; folderName: string; indexPath: string | null; children: NavPlanNode[] };

export interface BookPlan {
  /** Every note path in the tree exactly once, in reading order. */
  order: string[];
  /** Top-level TOC entries; depth-first traversal yields `order` (FR-015). */
  nav: NavPlanNode[];
}

function findIndex(folder: FolderInput): NoteInput | null {
  const name = pickIndexNote(
    folder.notes.map((n) => ({ basename: n.basename, tags: n.tags })),
    folder.name
  );
  return name === null ? null : (folder.notes.find((n) => n.basename === name) ?? null);
}

type Item = { kind: "note"; note: NoteInput } | { kind: "folder"; folder: FolderInput };

function hasNotes(folder: FolderInput): boolean {
  return folder.notes.length > 0 || folder.subfolders.some(hasNotes);
}

function planFolder(
  folder: FolderInput,
  allNotes: Set<string>
): { indexPath: string | null; children: NavPlanNode[] } {
  const index = findIndex(folder);
  const rest = folder.notes.filter((n) => n !== index);
  // A subfolder with no notes anywhere beneath it (an `assets/` folder) is
  // not a Part (FR-007). Everything else is an item to be ordered alongside
  // this folder's own notes.
  const items: Item[] = [
    ...rest.map((note): Item => ({ kind: "note", note })),
    ...folder.subfolders.filter(hasNotes).map((sub): Item => ({ kind: "folder", folder: sub })),
  ];
  const keyOf = (item: Item) => (item.kind === "note" ? item.note.path : item.folder.path);
  const nameOf = (item: Item) => (item.kind === "note" ? item.note.basename : item.folder.name);

  // Linked items first, in the index note's link order; first link wins.
  // A target that is one of this folder's notes selects that note; a target
  // that is a NOTE anywhere beneath one of its subfolders selects that whole
  // Part (FR-011). The prefix carries a trailing "/" so "book/Part I" never
  // captures "book/Part II/x" (research R4). Targets that select nothing —
  // outside the folder, missing, the index itself, non-notes such as an image
  // that happens to live inside a Part — are ignored (FR-004).
  const byNotePath = new Map(items.filter((i) => i.kind === "note").map((i) => [keyOf(i), i]));
  const folderItems = items.filter((i): i is Extract<Item, { kind: "folder" }> => i.kind === "folder");
  const selectFor = (target: string): Item | null =>
    byNotePath.get(target) ??
    (allNotes.has(target) ? (folderItems.find((f) => target.startsWith(f.folder.path + "/")) ?? null) : null);
  const linked: Item[] = [];
  const taken = new Set<string>();
  for (const target of index?.linkTargets ?? []) {
    const hit = selectFor(target);
    if (hit && !taken.has(keyOf(hit))) {
      taken.add(keyOf(hit));
      linked.push(hit);
    }
  }
  // Then everything the index never mentioned, notes and subfolders
  // together, in today's name order (FR-002, FR-012, research R6).
  const unlinked = orderByName(
    items.filter((i) => !taken.has(keyOf(i))),
    nameOf
  );

  const children: NavPlanNode[] = [...linked, ...unlinked].map((item) =>
    item.kind === "note" ? { kind: "chapter", path: item.note.path } : partNode(item.folder, allNotes)
  );
  return { indexPath: index?.path ?? null, children };
}

function partNode(folder: FolderInput, allNotes: Set<string>): NavPlanNode {
  const { indexPath, children } = planFolder(folder, allNotes);
  return { kind: "part", folderName: folder.name, indexPath, children };
}

function collectNotePaths(folder: FolderInput, into: Set<string>): Set<string> {
  for (const n of folder.notes) into.add(n.path);
  for (const sub of folder.subfolders) collectNotePaths(sub, into);
  return into;
}

function flatten(nav: NavPlanNode[]): string[] {
  const out: string[] = [];
  for (const node of nav) {
    if (node.kind === "chapter") out.push(node.path);
    else {
      if (node.indexPath !== null) out.push(node.indexPath);
      out.push(...flatten(node.children));
    }
  }
  return out;
}

export function planBook(root: FolderInput): BookPlan {
  const { indexPath, children } = planFolder(root, collectNotePaths(root, new Set()));
  const nav: NavPlanNode[] =
    indexPath === null ? children : [{ kind: "chapter", path: indexPath }, ...children];
  return { order: flatten(nav), nav };
}
