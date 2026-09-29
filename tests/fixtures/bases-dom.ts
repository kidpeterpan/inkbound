// A HAND-BUILT stand-in for the DOM Obsidian 1.13.7 produces for an embedded
// Bases file, for tests/bases.test.ts and the adapter tests.
//
// WHY HAND-BUILT: the only Bases in the maintainer's vault hold real work and
// personal records, and this repository is public, so nothing was captured
// from them. The SHAPE below was measured on a live Obsidian (2026-09-29,
// structure only — tag names, class names and counts, never content): the
// class names and nesting are real; every word in a cell is invented here.
// Re-capture from a synthetic vault to replace it (see docs/DEVELOPMENT.md).
//
// What was measured, so a reader can tell it from what is assumed:
//   MEASURED  embed root, header/toolbar/search-row/error/view children, the
//             thead/table-container/tbody nesting, header-name elements, the
//             implicit first column, a rendered-value cell holding a
//             span.internal-link[data-href], a longtext cell, a
//             .metadata-link cell (no data-href), a multi-select pill cell,
//             the result-count label, .is-loading while unpopulated, the
//             cards container shape.
//   ASSUMED   the checkbox cell (a table Base showing a checkbox property was
//             never seen), and the group-heading shape of a grouped table.
// Anything the converter reads that is only ASSUMED must fall back safely.

const SVG_NS = "http://www.w3.org/2000/svg";

export type FixtureCell =
  | string
  | null
  // The first column: the file's name, a link to the note.
  | { file: string; href: string }
  | { pills: string[] }
  | { links: string[] }
  // ASSUMED shape.
  | { check: boolean };

export interface BasesDomOptions {
  view?: "table" | "cards";
  viewName?: string;
  headers?: string[];
  rows?: FixtureCell[][];
  /** The toolbar's result-count text; defaults to the number of rows. null omits the label. */
  count?: string | null;
  /** Renders the unpopulated state Obsidian shows before the view fills in. */
  loading?: boolean;
  /** Text of the .bases-error element. */
  error?: string;
  /** ASSUMED: put a group heading (with text) between rows. */
  groupHeading?: string;
  /** Inserts an empty spacer element with no text between rows, as a virtualized list might. */
  spacer?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
  attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const svg = (): SVGElement => document.createElementNS(SVG_NS, "svg");

function toolbarItem(cls: string, label?: string): HTMLElement {
  const item = el("div", `bases-toolbar-item ${cls}`);
  const btn = el("div", "text-icon-button", undefined, { tabindex: "0" });
  const icon = el("span", "text-button-icon");
  icon.appendChild(svg());
  btn.appendChild(icon);
  if (label !== undefined) btn.appendChild(el("span", "text-button-label", label));
  item.appendChild(btn);
  return item;
}

function cell(spec: FixtureCell, property: string): HTMLElement {
  const td = el("div", "bases-td", undefined, {
    "data-property": property,
    draggable: "false",
    style: "width: 200px",
  });
  if (spec !== null && typeof spec === "object" && "file" in spec) {
    const box = el("div", "bases-table-cell bases-rendered-value markdown-rendered");
    box.appendChild(el("span", "internal-link", spec.file, { "data-href": spec.href, draggable: "true" }));
    td.appendChild(box);
    return td;
  }
  const box = el("div", "bases-table-cell bases-metadata-value metadata-property-value");
  if (typeof spec === "string" || spec === null) {
    box.appendChild(el("div", "metadata-input-longtext", spec ?? "", { contenteditable: "true" }));
  } else if ("pills" in spec) {
    const wrap = el("div", "multi-select-container");
    for (const p of spec.pills) {
      const pill = el("div", "multi-select-pill");
      pill.appendChild(el("div", "multi-select-pill-content", p));
      const rm = el("div", "multi-select-pill-remove-button");
      rm.appendChild(svg());
      pill.appendChild(rm);
      wrap.appendChild(pill);
    }
    wrap.appendChild(el("div", "multi-select-input", undefined, { contenteditable: "true" }));
    box.appendChild(wrap);
  } else if ("links" in spec) {
    for (const l of spec.links) {
      const link = el("div", "metadata-link");
      link.appendChild(el("div", "metadata-link-inner internal-link", l));
      const flair = el("div", "metadata-link-flair");
      flair.appendChild(svg());
      link.appendChild(flair);
      box.appendChild(link);
    }
  } else {
    const input = el("input", undefined, undefined, { type: "checkbox" });
    if (spec.check) input.setAttribute("checked", "");
    (input as HTMLInputElement).checked = spec.check;
    box.appendChild(input);
  }
  td.appendChild(box);
  return td;
}

function headerCell(name: string, implicit: boolean): HTMLElement {
  const td = el("div", implicit ? "bases-td mod-implicit" : "bases-td");
  const header = el("div", "bases-table-header");
  const label = el("div", "bases-table-header-label");
  const icon = el("div", "bases-table-header-icon");
  icon.appendChild(svg());
  label.appendChild(icon);
  label.appendChild(el("div", "bases-table-header-name", name));
  header.appendChild(label);
  header.appendChild(el("div", "bases-table-header-sort"));
  header.appendChild(el("div", "bases-table-header-resizer"));
  td.appendChild(header);
  return td;
}

/** The whole embed, rooted like the real one: span.internal-embed.bases-embed. */
export function buildBasesEmbed(opts: BasesDomOptions = {}): HTMLElement {
  const headers = opts.headers ?? ["file name", "status", "owner"];
  const rows = opts.rows ?? [
    [{ file: "Alpha note", href: "Alpha note" }, "open", { links: ["Dana"] }],
    [{ file: "Beta note", href: "Beta note" }, "done", { links: ["Eli"] }],
  ];
  const count = opts.count === undefined ? String(rows.length) : opts.count;

  const root = el("span", "internal-embed bases-embed interactive-child is-loaded", undefined, {
    alt: "Tasks.base",
    src: "Tasks.base",
  });

  const header = el("div", "bases-header");
  const toolbar = el("div", "bases-toolbar");
  toolbar.appendChild(toolbarItem("bases-toolbar-views-menu", opts.viewName ?? "Table"));
  toolbar.appendChild(
    toolbarItem("bases-toolbar-results-menu bases-toolbar-result-count", count === null ? undefined : count)
  );
  for (const c of ["sort-menu", "filter-menu", "properties-menu", "search", "new-item-menu"]) {
    toolbar.appendChild(toolbarItem(`bases-toolbar-${c}`));
  }
  header.appendChild(toolbar);
  root.appendChild(header);

  const search = el("div", "bases-search-row");
  const box = el("div", "search-input-container document-search-input");
  box.appendChild(el("input", undefined, undefined, { type: "text", placeholder: "Search..." }));
  search.appendChild(box);
  root.appendChild(search);

  root.appendChild(el("div", "bases-error", opts.error ?? ""));

  const view = el("div", "bases-view");
  if (opts.view === "cards") {
    const cards = el("div", "bases-cards-container node-insert-event");
    const group = el("div", "bases-cards-group");
    const item = el("div", "bases-cards-item");
    item.appendChild(el("div", "bases-cards-property mod-title", "Alpha note"));
    group.appendChild(item);
    cards.appendChild(group);
    view.appendChild(cards);
    root.appendChild(view);
    return root;
  }

  const thead = el("div", "bases-thead");
  if (!opts.loading) {
    const htr = el("div", "bases-tr");
    headers.forEach((h, i) => htr.appendChild(headerCell(h, i === 0)));
    thead.appendChild(htr);
  } else {
    thead.appendChild(el("div", "bases-tr"));
  }
  view.appendChild(thead);

  const container = el(
    "div",
    opts.loading
      ? "bases-table-container is-loading node-insert-event"
      : "bases-table-container node-insert-event"
  );
  if (!opts.loading) {
    const table = el("div", "bases-table");
    const tbody = el("div", "bases-tbody");
    rows.forEach((r, ri) => {
      if (opts.groupHeading && ri === 1)
        tbody.appendChild(el("div", "bases-group-heading", opts.groupHeading));
      if (opts.spacer && ri === 1) tbody.appendChild(el("div", "bases-spacer"));
      const tr = el("div", "bases-tr");
      r.forEach((c, ci) => tr.appendChild(cell(c, ci === 0 ? "file.name" : `note.${headers[ci] ?? ci}`)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }
  view.appendChild(container);
  root.appendChild(view);
  return root;
}

/** Wraps an embed the way a render host holds it. */
export function hostWith(embed: HTMLElement): HTMLElement {
  const host = document.createElement("div");
  const span = document.createElement("span");
  span.appendChild(embed);
  host.appendChild(span);
  return host;
}
