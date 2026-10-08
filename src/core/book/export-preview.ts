// 014-preview-before-export — what a preview of a planned book contains.
//
// Pure module: zero `obsidian` imports (constitution IV). The adapter in main.ts
// hands over what the planner already decided — the chapters in order with their
// resolved titles, and the nested table-of-contents plan keyed by POSITION in
// that list — and what comes back is the rows a reader is shown.
//
// This module must never grow a copy of an ordering or nesting rule. It renders
// a decision; it does not make one. That is what keeps "the book the preview
// describes" and "the book the export writes" from drifting apart: both come
// from the same plan, and the only check made here is the one the book builder
// itself makes (validateNavTree), with the same warning text (tocFallbackWarning).
import { describeCover, type CoverPlan } from "../epub/cover";
import { validateNavTree, type NavItem } from "../epub/epub";
import { tocFallbackWarning } from "./book-plan";

/** One chapter of the planned book: the title it will carry and the note it comes from. */
export interface PreviewChapter {
  title: string;
  path: string;
}

export interface PreviewInput {
  title: string;
  author: string;
  language: string;
  /** Where the cover will come from: named in the preview, never fetched. */
  cover: CoverPlan;
  /** In reading order — the order of the files the export will use. */
  chapters: readonly PreviewChapter[];
  /** Nested table-of-contents plan by position in `chapters`; undefined = a flat book. */
  nav: NavItem[] | undefined;
  /** Planning warnings known before anything renders. */
  warnings: readonly string[];
}

/**
 * A line of the preview. A Part's `path` is its index note's (the Part opens on
 * that chapter), or null for a Part named only by its folder.
 */
export type PreviewRow =
  | { kind: "chapter"; title: string; path: string }
  | { kind: "part"; title: string; path: string | null; children: PreviewRow[] };

export interface BookPreview {
  title: string;
  /** The rest of who the book says it is, as the reader reads it. */
  summary: { author: string; language: string; cover: string };
  chapterCount: number;
  rows: PreviewRow[];
  warnings: string[];
  intro: string;
  unknowns: string;
}

// What the preview says about itself. A tidy list of chapters can be mistaken
// for a promise that the export will be clean, so the window states what it is
// (a plan, made before anything is rendered) and names what only a built book
// can reveal. Exported so the wording lives once and tests compare against it.
export const PREVIEW_INTRO =
  "This is the plan for the book, made before anything is rendered. The chapters, their order and the Parts below are what the export will use.";
export const PREVIEW_UNKNOWNS =
  "Only known when the book is built: warnings about images, links and math, chapters that fail to render, whether the Thai font is embedded, and the backlink trails added to each chapter.";

export function buildBookPreview(input: PreviewInput): BookPreview {
  const contents = tableOfContents(input.chapters, input.nav);
  return {
    title: input.title,
    summary: { author: input.author, language: input.language, cover: describeCover(input.cover) },
    chapterCount: input.chapters.length,
    rows: contents.rows,
    warnings: [...input.warnings, ...contents.warnings],
    intro: PREVIEW_INTRO,
    unknowns: PREVIEW_UNKNOWNS,
  };
}

// The rows, and the warning that explains them when the book builder would
// have refused the nested plan and fallen back to a flat list: the preview
// shows that same flat list rather than a nesting the book will not have.
function tableOfContents(
  chapters: readonly PreviewChapter[],
  nav: NavItem[] | undefined
): { rows: PreviewRow[]; warnings: string[] } {
  if (nav === undefined) return { rows: flatRows(chapters), warnings: [] };
  try {
    validateNavTree(nav, chapters.length);
  } catch (error) {
    return { rows: flatRows(chapters), warnings: [tocFallbackWarning(error)] };
  }
  return { rows: nestedRows(nav, chapters), warnings: [] };
}

function flatRows(chapters: readonly PreviewChapter[]): PreviewRow[] {
  return chapters.map(chapterRow);
}

function nestedRows(nav: readonly NavItem[], chapters: readonly PreviewChapter[]): PreviewRow[] {
  return nav.map((item) => rowFor(item, chapters));
}

function rowFor(item: NavItem, chapters: readonly PreviewChapter[]): PreviewRow {
  if (item.kind === "chapter") return chapterRow(chapters[item.chapter]);
  return {
    kind: "part",
    title: item.title,
    path: item.indexChapter === null ? null : chapters[item.indexChapter].path,
    children: nestedRows(item.children, chapters),
  };
}

function chapterRow(chapter: PreviewChapter): PreviewRow {
  return { kind: "chapter", title: chapter.title, path: chapter.path };
}
