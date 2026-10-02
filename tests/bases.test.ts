import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTLE,
  buildStaticTable,
  extractBaseTable,
  readBaseView,
  settleBaseView,
  type BaseShape,
  type BaseViewState,
  type SettleOps,
} from "../src/core/bases";
import { serializeBody } from "../src/core/render";
import { buildBasesEmbed, hostWith, type BasesDomOptions } from "./fixtures/bases-dom";

// src/core/bases.ts is pure (no "obsidian" import). The DOM it reads is HAND-BUILT
// by tests/fixtures/bases-dom.ts from the structure measured on a live
// Obsidian 1.13.7 — see that file for what was measured and what is assumed.

const host = (o: BasesDomOptions = {}) => hostWith(buildBasesEmbed(o));
const state = (o: BasesDomOptions = {}) => readBaseView(host(o));
const ready = (s: BaseViewState) => {
  if (s.kind !== "ready") throw new Error(`expected ready, got ${s.kind}`);
  return s.shape;
};

describe("readBaseView: a populated table", () => {
  it("reports rows, columns and the count Obsidian shows in its toolbar", () => {
    expect(ready(state())).toEqual({ rows: 2, columns: 3, reportedCount: 2 });
  });

  it("reads only the digits of the count label, so a translated or formatted label still works", () => {
    expect(ready(state({ count: "1,234 results" })).reportedCount).toBe(1234);
    expect(ready(state({ count: "12" })).reportedCount).toBe(12);
  });

  it("reports the count as unknown when the label is missing or has no digits", () => {
    expect(ready(state({ count: null })).reportedCount).toBeNull();
    expect(ready(state({ count: "many" })).reportedCount).toBeNull();
  });

  it("treats a loaded base with no matches as ready with zero rows, not as still loading", () => {
    expect(ready(state({ rows: [], count: "0" }))).toEqual({ rows: 0, columns: 3, reportedCount: 0 });
  });

  it("ignores a spacer element with no text between rows", () => {
    expect(ready(state({ spacer: true })).rows).toBe(2);
  });
});

describe("readBaseView: not ready yet", () => {
  it("is loading before the view container exists", () => {
    const h = document.createElement("div");
    expect(readBaseView(h)).toEqual({ kind: "loading" });
  });

  it("is loading while the table container is marked is-loading, however much chrome is present", () => {
    expect(state({ loading: true })).toEqual({ kind: "loading" });
  });

  it("is loading when the view exists but holds nothing yet, or only its header row", () => {
    const empty = document.createElement("div");
    const root = document.createElement("span");
    const view = document.createElement("div");
    view.className = "bases-view";
    root.appendChild(view);
    empty.appendChild(root);
    expect(readBaseView(empty)).toEqual({ kind: "loading" });

    const thead = document.createElement("div");
    thead.className = "bases-thead";
    view.appendChild(thead);
    expect(readBaseView(empty)).toEqual({ kind: "loading" });
  });

  it("is loading while the container is marked is-loading even if a header and rows are already there", () => {
    const h = host();
    h.querySelector(".bases-table-container")!.classList.add("is-loading");
    expect(readBaseView(h)).toEqual({ kind: "loading" });
  });

  it("is loading when there is a table container but no header yet", () => {
    const h = host();
    h.querySelectorAll(".bases-table-header-name").forEach((n) => n.remove());
    expect(readBaseView(h)).toEqual({ kind: "loading" });
  });
});

describe("readBaseView: what cannot be exported", () => {
  it("reports the text of a Bases error, cut to a sane length", () => {
    const s = state({ error: "Filter error: unknown function" });
    expect(s).toEqual({ kind: "error", message: "Filter error: unknown function" });
    const long = state({ error: "x".repeat(500) });
    expect(long.kind === "error" && long.message.length).toBeLessThanOrEqual(200);
  });

  it("does not mistake the always-present empty error element for an error", () => {
    expect(state({ error: "   " }).kind).toBe("ready");
  });

  it("declines a cards view", () => {
    const s = state({ view: "cards" });
    expect(s.kind).toBe("unsupported");
    expect(s.kind === "unsupported" && s.reason).toMatch(/cards/i);
  });

  it("declines a layout it does not recognise, rather than guess", () => {
    const h = document.createElement("div");
    const root = document.createElement("span");
    root.className = "bases-embed";
    const view = document.createElement("div");
    view.className = "bases-view";
    const other = document.createElement("div");
    other.className = "bases-something-new";
    other.textContent = "?";
    view.appendChild(other);
    root.appendChild(view);
    h.appendChild(root);
    const s = readBaseView(h);
    expect(s.kind).toBe("unsupported");
    expect(s.kind === "unsupported" && s.reason).toMatch(/layout/i);
  });

  it("declines a grouped table (a group heading among the rows), which would silently lose the grouping", () => {
    const s = state({ groupHeading: "Group A" });
    expect(s.kind).toBe("unsupported");
    expect(s.kind === "unsupported" && s.reason).toMatch(/group/i);
  });

  it("declines a table whose rows do not line up with its header", () => {
    const h = host();
    h.querySelector(".bases-tbody .bases-tr .bases-td:last-child")?.remove();
    const s = readBaseView(h);
    expect(s.kind).toBe("unsupported");
    expect(s.kind === "unsupported" && s.reason).toMatch(/header|column/i);
  });
});

describe("extractBaseTable", () => {
  it("reads the header names and every cell, in order", () => {
    const t = extractBaseTable(host());
    expect(t.headers).toEqual(["file name", "status", "owner"]);
    expect(t.rows.map((r) => r.map((c) => c.map((p) => p.text).join("")))).toEqual([
      ["Alpha note", "open", "Dana"],
      ["Beta note", "done", "Eli"],
    ]);
  });

  it("keeps a link to a note as a link, with its target, so it can point at the chapter", () => {
    const t = extractBaseTable(host());
    expect(t.rows[0]![0]).toEqual([{ text: "Alpha note", href: "Alpha note" }]);
  });

  it("joins a multi-value (pill) cell with commas, without the remove buttons' icons", () => {
    const t = extractBaseTable(
      host({ rows: [[{ file: "N", href: "N" }, { pills: ["red", "green", "blue"] }, null]] })
    );
    expect(t.rows[0]![1]).toEqual([{ text: "red, green, blue" }]);
  });

  it("joins several linked values with commas, as plain text (they carry no target)", () => {
    const t = extractBaseTable(
      host({ rows: [[{ file: "N", href: "N" }, { links: ["Dana", "Eli"] }, null]] })
    );
    expect(t.rows[0]![1]).toEqual([{ text: "Dana, Eli" }]);
  });

  it("turns a checkbox into the same glyphs the rest of the export uses (assumed shape)", () => {
    const t = extractBaseTable(
      host({ rows: [[{ file: "N", href: "N" }, { check: true }, { check: false }]] })
    );
    expect(t.rows[0]![1]).toEqual([{ text: "☑" }]);
    expect(t.rows[0]![2]).toEqual([{ text: "☐" }]);
  });

  it("gives an empty cell no parts at all", () => {
    const t = extractBaseTable(host({ rows: [[{ file: "N", href: "N" }, null, ""]] }));
    expect(t.rows[0]![1]).toEqual([]);
    expect(t.rows[0]![2]).toEqual([]);
  });

  it("collapses runs of whitespace and trims the ends of a cell", () => {
    const t = extractBaseTable(host({ rows: [[{ file: "N", href: "N" }, "  a \n\n  b  ", null]] }));
    expect(t.rows[0]![1]).toEqual([{ text: "a b" }]);
  });

  it("reads nothing, rather than throwing, from a host that holds no table", () => {
    expect(extractBaseTable(document.createElement("div"))).toEqual({
      viewName: null,
      headers: [],
      rows: [],
    });
  });

  it("returns no rows for an empty result, keeping the header", () => {
    const t = extractBaseTable(host({ rows: [], count: "0" }));
    expect(t.headers).toHaveLength(3);
    expect(t.rows).toEqual([]);
  });

  it("names the view from the toolbar", () => {
    expect(extractBaseTable(host({ viewName: "Open cases" })).viewName).toBe("Open cases");
  });

  it("leaves the DOM it read untouched", () => {
    const h = host({ rows: [[{ file: "N", href: "N" }, { pills: ["a", "b"] }, { check: true }]] });
    const before = h.innerHTML;
    extractBaseTable(h);
    expect(h.innerHTML).toBe(before);
  });
});

describe("buildStaticTable", () => {
  const build = (o: BasesDomOptions = {}) => buildStaticTable(extractBaseTable(host(o)));

  it("is a plain table with a header row and one body row per result", () => {
    const t = build();
    expect(t.tagName).toBe("TABLE");
    expect(Array.from(t.querySelectorAll("thead th")).map((n) => n.textContent)).toEqual([
      "file name",
      "status",
      "owner",
    ]);
    expect(t.querySelectorAll("thead th[scope='col']")).toHaveLength(3);
    expect(t.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(Array.from(t.querySelectorAll("tbody tr:first-child td")).map((n) => n.textContent)).toEqual([
      "Alpha note",
      "open",
      "Dana",
    ]);
  });

  it("captions the table with the view's name", () => {
    expect(build({ viewName: "Open cases" }).querySelector("caption")?.textContent).toBe("Open cases");
  });

  it("emits a link part as an internal link that rewriteLinks can point at a chapter", () => {
    const a = build().querySelector("tbody td a");
    expect(a?.getAttribute("data-href")).toBe("Alpha note");
    expect(a?.classList.contains("internal-link")).toBe(true);
    expect(a?.textContent).toBe("Alpha note");
  });

  it("says so, in one row, when the base matched nothing", () => {
    const t = build({ rows: [], count: "0" });
    const rows = t.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toBe("No results");
    expect(rows[0]!.querySelector("td")?.getAttribute("colspan")).toBe("3");
  });

  it("carries no Bases markup, form controls or icons into the book", () => {
    const html = serializeBody(
      build({ rows: [[{ file: "N", href: "N" }, { pills: ["a"] }, { check: true }]] })
    );
    expect(html).not.toMatch(/bases-|<input|<svg|contenteditable|draggable|style=/);
  });

  it("serializes to well-formed XHTML, with awkward text escaped", () => {
    const t = build({ rows: [[{ file: "A & B <c>", href: "A & B" }, 'say "hi" & <go>', null]] });
    const xhtml = serializeBody(t);
    const doc = new DOMParser().parseFromString(
      `<body xmlns="http://www.w3.org/1999/xhtml">${xhtml}</body>`,
      "application/xml"
    );
    expect(doc.querySelector("parsererror")?.textContent ?? "").toBe("");
    expect(t.querySelector("tbody td:nth-child(2)")?.textContent).toBe('say "hi" & <go>');
  });
});

// ── settleBaseView ──────────────────────────────────────────────────────────
//
// A simulated Bases view that cuts itself to the host's size, the way the real
// one was measured to (700px tall showed 12 of 12 rows, 150px showed 3, 40px
// showed 0; a 250px-wide host showed 1 of 6 columns), on a fake clock so no
// test waits for real time.

interface SimOptions {
  rows: number;
  columns: number;
  rowPx?: number;
  columnPx?: number;
  /** How long after the start the view stays "loading". Infinity = never loads. */
  loadsAfterMs?: number;
  reportedCount?: number | null;
  final?: BaseViewState;
}

function simulate(o: SimOptions) {
  const rowPx = o.rowPx ?? 40;
  const columnPx = o.columnPx ?? 200;
  let width = 0;
  let height = 0;
  let clock = 0;
  const sizes: [number, number][] = [];
  let reads = 0;
  const ops: SettleOps = {
    setSize(w, h) {
      width = w;
      height = h;
      sizes.push([w, h]);
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    read() {
      reads++;
      if (o.final) return o.final;
      if (clock < (o.loadsAfterMs ?? 0)) return { kind: "loading" };
      return {
        kind: "ready",
        shape: {
          rows: Math.min(o.rows, Math.floor(height / rowPx)),
          columns: Math.min(o.columns, Math.max(1, Math.floor(width / columnPx))),
          reportedCount: o.reportedCount === undefined ? o.rows : o.reportedCount,
        },
      };
    },
  };
  return { ops, sizes, clock: () => clock, reads: () => reads };
}

const readyShape = (r: Awaited<ReturnType<typeof settleBaseView>>): BaseShape => {
  if (r.kind !== "ready") throw new Error(`expected ready, got ${r.kind}`);
  return r.shape;
};

describe("settleBaseView", () => {
  it("sizes the host before looking at anything", async () => {
    const sim = simulate({ rows: 3, columns: 3 });
    await settleBaseView(sim.ops);
    expect(sim.sizes[0]).toEqual([DEFAULT_SETTLE.startWidth, DEFAULT_SETTLE.startHeight]);
  });

  it("returns a small base complete, with all its rows and columns", async () => {
    const sim = simulate({ rows: 12, columns: 6 });
    const r = await settleBaseView(sim.ops);
    expect(r).toMatchObject({ kind: "ready", incomplete: null });
    expect(readyShape(r)).toMatchObject({ rows: 12, columns: 6 });
  });

  it("waits out the loading state", async () => {
    const sim = simulate({ rows: 5, columns: 3, loadsAfterMs: 300 });
    const r = await settleBaseView(sim.ops);
    expect(readyShape(r).rows).toBe(5);
    expect(sim.clock()).toBeGreaterThanOrEqual(300);
  });

  it("grows the host until every row is rendered when the view is cut short by height", async () => {
    const sim = simulate({ rows: 500, columns: 4, rowPx: 45 });
    const r = await settleBaseView(sim.ops);
    expect(r).toMatchObject({ kind: "ready", incomplete: null });
    expect(readyShape(r).rows).toBe(500);
    const finalHeight = sim.sizes[sim.sizes.length - 1]![1];
    expect(finalHeight).toBeGreaterThanOrEqual(500 * 45);
  });

  it("stops widening as soon as a wider host adds no columns: one probe, not a climb to the maximum", async () => {
    const sim = simulate({ rows: 3, columns: 3 });
    await settleBaseView(sim.ops);
    expect(sim.sizes).toEqual([
      [DEFAULT_SETTLE.startWidth, DEFAULT_SETTLE.startHeight],
      [DEFAULT_SETTLE.startWidth * 2, DEFAULT_SETTLE.startHeight],
    ]);
  });

  it("grows the host until every column is rendered when the view is cut short by width", async () => {
    const sim = simulate({ rows: 3, columns: 30, columnPx: 200 });
    const r = await settleBaseView(sim.ops);
    expect(r).toMatchObject({ kind: "ready", incomplete: null });
    expect(readyShape(r).columns).toBe(30);
  });

  it("says how many rows are missing when the cap is reached, instead of pretending it is complete", async () => {
    const sim = simulate({ rows: 5000, columns: 3, rowPx: 45 });
    const r = await settleBaseView(sim.ops, { ...DEFAULT_SETTLE, maxHeight: 10_000 });
    expect(r.kind).toBe("ready");
    expect(r.kind === "ready" && r.incomplete).toMatch(/^\d+ of 5000 rows/);
    expect(sim.sizes.every(([, h]) => h <= 10_000)).toBe(true);
  });

  it("flags possibly missing columns when the widest host still gained columns", async () => {
    const sim = simulate({ rows: 2, columns: 500, columnPx: 200 });
    const r = await settleBaseView(sim.ops, { ...DEFAULT_SETTLE, maxWidth: 6000 });
    expect(r.kind === "ready" && r.incomplete).toMatch(/column/i);
    expect(sim.sizes.every(([w]) => w <= 6000)).toBe(true);
  });

  it("does not grow the host for an empty base", async () => {
    const sim = simulate({ rows: 0, columns: 3, reportedCount: 0 });
    const r = await settleBaseView(sim.ops);
    expect(r).toMatchObject({ kind: "ready", incomplete: null });
    expect(readyShape(r).rows).toBe(0);
    expect(sim.sizes.every(([, h]) => h === DEFAULT_SETTLE.startHeight)).toBe(true);
  });

  it("cannot check row completeness without a reported count, and does not try to grow for it", async () => {
    const sim = simulate({ rows: 3, columns: 3, reportedCount: null });
    const r = await settleBaseView(sim.ops);
    expect(r).toMatchObject({ kind: "ready", incomplete: null });
    expect(sim.sizes.every(([, h]) => h === DEFAULT_SETTLE.startHeight)).toBe(true);
  });

  it("gives up with a timeout when the view never loads, within the time budget", async () => {
    const sim = simulate({ rows: 3, columns: 3, loadsAfterMs: Infinity });
    const r = await settleBaseView(sim.ops);
    expect(r).toEqual({ kind: "timeout" });
    expect(sim.clock()).toBeLessThanOrEqual(DEFAULT_SETTLE.timeoutMs + DEFAULT_SETTLE.pollMs);
  });

  it("returns an error straight away, without resizing further", async () => {
    const sim = simulate({ rows: 1, columns: 1, final: { kind: "error", message: "bad filter" } });
    const r = await settleBaseView(sim.ops);
    expect(r).toEqual({ kind: "error", message: "bad filter" });
    expect(sim.sizes).toHaveLength(1);
  });

  it("returns an unsupported view straight away", async () => {
    const sim = simulate({ rows: 1, columns: 1, final: { kind: "unsupported", reason: "cards view" } });
    expect(await settleBaseView(sim.ops)).toEqual({ kind: "unsupported", reason: "cards view" });
  });

  it("stops asking even if the view never settles, bounded by its round limit", async () => {
    let n = 0;
    const ops: SettleOps = {
      setSize() {},
      sleep: async () => {},
      now: () => 0,
      // A shape that changes on every single read.
      read: () => ({ kind: "ready", shape: { rows: ++n, columns: 1, reportedCount: null } }),
    };
    const r = await settleBaseView(ops);
    expect(r.kind).toBe("ready");
    expect(n).toBeLessThan(1000);
  });
});
