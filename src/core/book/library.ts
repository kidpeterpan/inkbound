// 016-export-all-books — which folders are books when the whole library is
// exported, and in what order (specs/016-export-all-books/spec.md FR-002, FR-004).
//
// Pure module: zero `obsidian` imports (constitution IV). The adapter in main.ts
// turns the vault into a LibraryFolder tree; everything decided about it is here.
//
// A folder is a book when one of its own notes is tagged `book` and `main`
// (hasBookIndexTags, the same check pickIndexNote uses), no folder above it is a
// book, and it is not the vault's top-level folder. The folder-name fallback of
// pickIndexNote deliberately plays no part: with nobody pointing at a folder,
// "a note named after its folder" would sweep in every folder-note in the vault.

import { slugify } from "./naming";

/** The vault's folder tree as the library rule sees it. */
export interface LibraryFolder {
  /** Vault path; "" for the top-level folder. */
  path: string;
  /** One of this folder's own notes is tagged `book` and `main`. */
  hasBookIndex: boolean;
  subfolders: LibraryFolder[];
}

/** The outermost book folders, never the top level itself, in path order. */
export function findBookFolders(root: LibraryFolder): string[] {
  // The top level is never a book: one stray tag there would otherwise make
  // the whole vault, and every book in it, a single book.
  return root.subfolders.flatMap(outermostBooks).sort(byPath);
}

// A book's own subfolders are its Parts, so nothing below a book is visited.
function outermostBooks(folder: LibraryFolder): string[] {
  if (folder.hasBookIndex) return [folder.path];
  return folder.subfolders.flatMap(outermostBooks);
}

// Plain string comparison rather than localeCompare: the run order must not
// depend on the device's language settings (FR-004).
function byPath(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// ── the run ───────────────────────────────────────────────────────────────

/** A book of a run, with the file name its export will write. */
export interface LibraryBook {
  folderPath: string;
  title: string;
  fileName: string;
}

/** A book left out of the run because an earlier book has its file name. */
export interface SkippedBook extends LibraryBook {
  /** The folder of the earlier book with the same file name. */
  clashesWith: string;
}

export interface LibraryRunPlan {
  toExport: LibraryBook[];
  skipped: SkippedBook[];
}

/**
 * Decides which books of a run are written: in the order given, the first book
 * with a file name is written and every later one with the same file name is
 * skipped, so no book of a run silently replaces another (FR-006).
 *
 * Compares file names, not titles: a book's file is named slugify(title), and
 * two different titles can name the same file ("Tidal Notes" and "tidal notes",
 * "A: B" and "A B").
 */
export function planLibraryRun(books: readonly { folderPath: string; title: string }[]): LibraryRunPlan {
  const plan: LibraryRunPlan = { toExport: [], skipped: [] };
  const folderByFileName = new Map<string, string>();
  for (const { folderPath, title } of books) {
    const book: LibraryBook = { folderPath, title, fileName: slugify(title) };
    const firstWithThisName = folderByFileName.get(book.fileName);
    if (firstWithThisName === undefined) {
      folderByFileName.set(book.fileName, folderPath);
      plan.toExport.push(book);
    } else {
      plan.skipped.push({ ...book, clashesWith: firstWithThisName });
    }
  }
  return plan;
}
