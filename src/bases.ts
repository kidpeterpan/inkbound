// Pure (no "obsidian" import): turns the DOM Obsidian builds for a Bases TABLE
// view into a plain static <table> for the book.
//
// WHY THIS IS NOT A ONE-LINER: Obsidian renders a Base as a grid of
// `div.bases-*` elements, not a <table>, and only fills it in when its host is
// attached to the live document. It also VIRTUALIZES by host size in both
// directions — measured on Obsidian 1.13.7: a 700px-tall host showed 12 of 12
// rows, 150px showed 3, 40px showed 0, and a 250px-wide host showed 1 of 6
// columns — while its toolbar keeps reporting the true row count. So there are
// three separate jobs here, all pure so they can be tested without Obsidian:
//
//   readBaseView      what state is the view in? (loading / ready / error /
//                     something we cannot export)
//   settleBaseView    grow the host until nothing is cut short, and say so when
//                     that cannot be achieved — never return half a table as if
//                     it were the whole thing
//   extractBaseTable + buildStaticTable
//                     read the cells, write the table
//
// EVERY class name below (bases-*, multi-select-pill-*, metadata-*) is
// undocumented Obsidian markup, measured on 1.13.7 (docs/DEVELOPMENT.md, "The
// Obsidian drift canary", is the guard against it moving). The rule that makes
// that tolerable: anything not recognised is reported as `unsupported`, and the
// caller falls back to the omission marker — the worst outcome is the
// behaviour the export had before this file existed.

export interface BaseShape {
  rows: number;
  columns: number;
  // The row count Obsidian's own toolbar shows, or null when it could not be read.
  reportedCount: number | null;
}

export type BaseViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "ready"; shape: BaseShape };

export interface BaseCellPart {
  text: string;
  // Set for a link to a note; the link's target as Obsidian recorded it.
  href?: string;
}

export interface BaseTable {
  viewName: string | null;
  headers: string[];
  rows: BaseCellPart[][][];
}

const MAX_ERROR_LENGTH = 200;

function firstCount(label: string | null | undefined): number | null {
  // The first run of digits, thousands separators dropped: "1,234 results" → 1234.
  const m = /\d[\d,.]*/.exec(label ?? "");
  return m ? Number(m[0].replace(/\D/g, "")) : null;
}

const hasText = (e: Element): boolean => (e.textContent ?? "").trim() !== "";

// Not `instanceof Element`: a node from a popout window belongs to that
// window's Element class, and Obsidian's own guidance is to test the type
// without naming a window's constructor.
const isElement = (n: Node): n is Element => n.nodeType === Node.ELEMENT_NODE;

/** The rows of a table view's body, without any footer row. */
function bodyRows(container: Element): Element[] {
  const tbody = container.querySelector(".bases-tbody");
  return Array.from(tbody?.children ?? []).filter(
    (c) => c.classList.contains("bases-tr") && !c.classList.contains("bases-table-footer")
  );
}

export function readBaseView(host: Element): BaseViewState {
  const message = (host.querySelector(".bases-error")?.textContent ?? "").trim();
  if (message) return { kind: "error", message: message.slice(0, MAX_ERROR_LENGTH) };

  const view = host.querySelector(".bases-view");
  if (!view) return { kind: "loading" };
  if (view.querySelector(".bases-cards-container")) {
    return { kind: "unsupported", reason: "cards views are not exported, only table views" };
  }

  const container = view.querySelector(".bases-table-container");
  if (!container) {
    // Nothing recognisable yet. Chrome alone (the header row) is just "not
    // filled in"; anything else in the view is a layout this code has not seen.
    const strangers = Array.from(view.children).filter((c) => !c.classList.contains("bases-thead"));
    return strangers.length > 0
      ? { kind: "unsupported", reason: "unrecognised Bases view layout" }
      : { kind: "loading" };
  }
  if (container.classList.contains("is-loading")) return { kind: "loading" };

  const headers = view.querySelectorAll(".bases-thead .bases-table-header-name");
  if (headers.length === 0) return { kind: "loading" };

  const tbody = container.querySelector(".bases-tbody");
  if (!tbody) return { kind: "loading" };
  // A group heading between rows carries text; a spacer a virtualized list might
  // leave does not. Exporting a grouped table as a flat one would silently lose
  // the grouping, so it is declined instead. (The heading's shape is an
  // assumption: a grouped TABLE was never observed.)
  const strangers = Array.from(tbody.children).filter((c) => !c.classList.contains("bases-tr") && hasText(c));
  if (strangers.length > 0) {
    return { kind: "unsupported", reason: "grouped tables are not exported" };
  }

  const rows = bodyRows(container);
  if (rows.some((r) => r.querySelectorAll(":scope > .bases-td").length !== headers.length)) {
    return { kind: "unsupported", reason: "table rows do not line up with the header columns" };
  }

  return {
    kind: "ready",
    shape: {
      rows: rows.length,
      columns: headers.length,
      reportedCount: firstCount(
        host.querySelector(".bases-toolbar-result-count .text-button-label")?.textContent
      ),
    },
  };
}

// ── reading the cells ───────────────────────────────────────────────────────

// Inside a cell: icons, the pills' remove buttons, the link flair, and the
// empty text box a multi-select widget carries. None is content.
const NOT_CONTENT = "svg, .multi-select-pill-remove-button, .metadata-link-flair, .multi-select-input";

// Merges neighbouring plain-text parts so whitespace can be collapsed across
// the seams, collapses each part's whitespace, and drops empties.
function normalizeCellParts(raw: BaseCellPart[]): BaseCellPart[] {
  const merged: BaseCellPart[] = [];
  for (const part of raw) {
    const last = merged[merged.length - 1];
    if (last && last.href === undefined && part.href === undefined) last.text += part.text;
    else merged.push({ ...part });
  }
  for (const part of merged) part.text = part.text.replace(/\s+/g, " ");
  if (merged.length > 0) {
    merged[0].text = merged[0].text.trimStart();
    merged[merged.length - 1].text = merged[merged.length - 1].text.trimEnd();
  }
  return merged.filter((p) => p.text !== "");
}

function cellParts(td: Element): BaseCellPart[] {
  const raw: BaseCellPart[] = [];
  const push = (text: string, href?: string) => raw.push(href === undefined ? { text } : { text, href });

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      push(node.textContent ?? "");
      return;
    }
    if (!isElement(node) || node.matches(NOT_CONTENT)) return;

    if (node.matches('input[type="checkbox"]')) {
      // The same glyphs cleanupDom uses for task-list checkboxes.
      push((node as HTMLInputElement).checked ? "☑" : "☐");
      return;
    }
    const href = node.getAttribute("data-href");
    if (href !== null && node.classList.contains("internal-link")) {
      push(node.textContent ?? "", href);
      return;
    }
    if (node.matches(".multi-select-container")) {
      const pills = Array.from(node.querySelectorAll(".multi-select-pill-content")).map(
        (p) => p.textContent ?? ""
      );
      push(pills.join(", "));
      return;
    }
    let previousWasLink = false;
    for (const child of Array.from(node.childNodes)) {
      const isValueLink = isElement(child) && child.classList.contains("metadata-link");
      // Several linked values sit side by side with nothing between them.
      if (isValueLink && previousWasLink) push(", ");
      walk(child);
      if (isElement(child)) previousWasLink = isValueLink;
    }
  };
  walk(td);
  return normalizeCellParts(raw);
}

/** Reads a table view that readBaseView reported `ready`. Does not touch the DOM. */
export function extractBaseTable(host: Element): BaseTable {
  const view = host.querySelector(".bases-view");
  const headers = Array.from(view?.querySelectorAll(".bases-thead .bases-table-header-name") ?? []).map((h) =>
    (h.textContent ?? "").trim()
  );
  const container = view?.querySelector(".bases-table-container");
  const rows = container
    ? bodyRows(container).map((tr) => Array.from(tr.querySelectorAll(":scope > .bases-td")).map(cellParts))
    : [];
  const name = (host.querySelector(".bases-toolbar-views-menu .text-button-label")?.textContent ?? "").trim();
  return { viewName: name || null, headers, rows };
}

// ── writing the table ───────────────────────────────────────────────────────

/**
 * A plain table for the book. A link to a note is emitted as an internal link,
 * so rewriteLinks points it at that note's chapter if the note is in the book
 * and degrades it to plain text if not — exactly what it does for a link in
 * any other cell of prose.
 */
export function buildStaticTable(t: BaseTable): HTMLElement {
  const table = createEl("table");
  table.className = "base-table";
  if (t.viewName) table.createEl("caption").textContent = t.viewName;

  const headRow = table.createEl("thead").createEl("tr");
  for (const h of t.headers) {
    const th = headRow.createEl("th");
    th.setAttribute("scope", "col");
    th.textContent = h;
  }

  const body = table.createEl("tbody");
  if (t.rows.length === 0) {
    const td = body.createEl("tr").createEl("td");
    td.setAttribute("colspan", String(Math.max(1, t.headers.length)));
    td.textContent = "No results";
    return table;
  }
  for (const row of t.rows) {
    const tr = body.createEl("tr");
    for (const parts of row) {
      const td = tr.createEl("td");
      for (const part of parts) {
        if (part.href === undefined) {
          td.appendChild(document.createTextNode(part.text));
        } else {
          const a = td.createEl("a");
          a.className = "internal-link";
          a.setAttribute("data-href", part.href);
          a.textContent = part.text;
        }
      }
    }
  }
  return table;
}

// ── sizing the host ─────────────────────────────────────────────────────────

/** What settleBaseView needs from the outside. Injected so no test waits in real time. */
export interface SettleOps {
  read(): BaseViewState;
  setSize(width: number, height: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SettleOptions {
  pollMs: number;
  // How long the view may take to leave the loading state.
  timeoutMs: number;
  // How long to wait, after a resize, for the view to stop changing.
  settleMs: number;
  startWidth: number;
  startHeight: number;
  maxWidth: number;
  maxHeight: number;
  // A generous height per row, used to jump straight to a host tall enough.
  rowHeightPx: number;
  maxRounds: number;
}

export const DEFAULT_SETTLE: SettleOptions = {
  pollMs: 50,
  timeoutMs: 5000,
  settleMs: 400,
  startWidth: 3000,
  startHeight: 1500,
  maxWidth: 24_000,
  maxHeight: 60_000,
  rowHeightPx: 96,
  maxRounds: 8,
};

export type SettleResult =
  // `incomplete` says what could not be rendered (rows or columns cut short even
  // at the largest host); null means nothing is known to be missing.
  | { kind: "ready"; shape: BaseShape; incomplete: string | null }
  | { kind: "error"; message: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "timeout" };

const sameShape = (a: BaseShape, b: BaseShape) =>
  a.rows === b.rows && a.columns === b.columns && a.reportedCount === b.reportedCount;

export async function settleBaseView(
  ops: SettleOps,
  o: SettleOptions = DEFAULT_SETTLE
): Promise<SettleResult> {
  let width = o.startWidth;
  let height = o.startHeight;
  ops.setSize(width, height);

  // Both waits are bounded by the clock AND by a poll count, so a clock that
  // never advances cannot make either loop run forever.
  const loadPolls = Math.ceil(o.timeoutMs / o.pollMs) + 1;
  const deadline = ops.now() + o.timeoutMs;
  let s = ops.read();
  for (let i = 0; s.kind === "loading"; i++) {
    if (i >= loadPolls || ops.now() >= deadline) return { kind: "timeout" };
    await ops.sleep(o.pollMs);
    s = ops.read();
  }
  if (s.kind !== "ready") return s;

  // After a resize the view re-renders; wait until two reads in a row agree.
  const settle = async (): Promise<BaseViewState> => {
    const polls = Math.ceil(o.settleMs / o.pollMs) + 1;
    let previous: BaseShape | null = null;
    let latest: BaseViewState = ops.read();
    for (let i = 0; i < polls; i++) {
      if (latest.kind === "error" || latest.kind === "unsupported") return latest;
      if (latest.kind === "ready") {
        if (previous && sameShape(previous, latest.shape)) return latest;
        previous = latest.shape;
      }
      await ops.sleep(o.pollMs);
      latest = ops.read();
    }
    return latest;
  };

  let shape = s.shape;
  let columnsMayBeCut = false;

  // Columns: widen until the header stops gaining columns. There is no count to
  // compare against, so "stopped growing" is the only evidence of completeness.
  for (let round = 0; round < o.maxRounds && width < o.maxWidth; round++) {
    width = Math.min(width * 2, o.maxWidth);
    ops.setSize(width, height);
    const next = await settle();
    if (next.kind !== "ready") return next.kind === "loading" ? { kind: "timeout" } : next;
    const grew = next.shape.columns > shape.columns;
    shape = next.shape;
    columnsMayBeCut = grew && width >= o.maxWidth;
    if (!grew) break;
  }

  // Rows: the toolbar's count is the truth; grow the host until that many render.
  for (let round = 0; round < o.maxRounds && height < o.maxHeight; round++) {
    if (shape.reportedCount === null || shape.rows >= shape.reportedCount) break;
    height = Math.min(o.maxHeight, Math.max(height * 2, (shape.reportedCount + 2) * o.rowHeightPx));
    ops.setSize(width, height);
    const next = await settle();
    if (next.kind !== "ready") return next.kind === "loading" ? { kind: "timeout" } : next;
    shape = next.shape;
  }

  const rowsCut = shape.reportedCount !== null && shape.rows < shape.reportedCount;
  const problems = [
    rowsCut ? `${shape.rows} of ${shape.reportedCount} rows` : null,
    columnsMayBeCut ? "some columns may be missing" : null,
  ].filter((p): p is string => p !== null);
  return { kind: "ready", shape, incomplete: problems.length > 0 ? problems.join("; ") : null };
}
