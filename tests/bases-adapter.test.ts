import { describe, it, expect, afterEach, vi } from "vitest";
import { Component, MarkdownRenderer } from "./fixtures/obsidian-stub";
import { getBaseRenderer, renderBaseTable, setBaseRenderer } from "../src/bases-adapter";
import { DEFAULT_SETTLE, type SettleOptions } from "../src/bases";
import { buildBasesEmbed, type BasesDomOptions } from "./fixtures/bases-dom";

// renderBaseTable is the only code that needs a live Obsidian, so this mocks
// exactly one thing — MarkdownRenderer.render, which stands in for Obsidian
// filling a Base in — and lets everything else really run under jsdom: the
// host is attached to the document, sized, polled, read and removed.
//
// What jsdom cannot do is LAY OUT, so it cannot cut a view short by host size.
// The settle logic that copes with that is tested against a simulated view in
// tests/bases.test.ts; here "incomplete" is produced by a fixture whose toolbar
// claims more rows than it holds.

// Short waits so a test that expects a timeout does not spend real seconds.
const FAST: SettleOptions = { ...DEFAULT_SETTLE, pollMs: 2, timeoutMs: 40, settleMs: 12 };

const APP = {} as never;

type Fill = (el: HTMLElement) => void;

/** Makes MarkdownRenderer.render "fill in" a Base, and records how it was called. */
function fillWith(fill: Fill | null) {
  const calls: {
    md: string;
    sourcePath: string;
    attached: boolean;
    component: unknown;
    host: HTMLElement;
    widthAtRender: string;
    heightAtRender: string;
  }[] = [];
  vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, md, el, sourcePath, component) => {
    calls.push({
      md,
      sourcePath,
      attached: el.isConnected,
      component,
      host: el,
      widthAtRender: el.style.width,
      heightAtRender: el.style.height,
    });
    fill?.(el);
  });
  return calls;
}

const embed =
  (o: BasesDomOptions = {}): Fill =>
  (el) => {
    el.appendChild(buildBasesEmbed(o));
  };

const hostsLeftBehind = () => activeDocument.body.querySelectorAll(".markdown-rendered").length;

afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.body.replaceChildren();
  setBaseRenderer(null);
});

describe("renderBaseTable", () => {
  it("returns the Base's rows as a static table", async () => {
    fillWith(embed());
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warning).toBeNull();
    expect(Array.from(r.table.querySelectorAll("th")).map((n) => n.textContent)).toEqual([
      "file name",
      "status",
      "owner",
    ]);
    expect(r.table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(r.table.textContent).toContain("Alpha note");
  });

  it("renders the embed's own text, so a view suffix picks the same view Obsidian shows", async () => {
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base#Open cases", "notes/host.md", FAST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.md).toBe("![[Tasks.base#Open cases]]");
    expect(calls[0]!.sourcePath).toBe("notes/host.md");
  });

  it("renders into a host that is ATTACHED to the document but invisible, since a detached one is never filled in", async () => {
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    const host = calls[0]!.host;
    expect(calls[0]!.attached).toBe(true);
    expect(host.style.position).toBe("fixed");
    expect(host.style.opacity).toBe("0");
    expect(host.style.pointerEvents).toBe("none");
  });

  it("sizes the host generously, in both directions, before reading anything", async () => {
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    const host = calls[0]!.host;
    expect(parseInt(host.style.width, 10)).toBeGreaterThanOrEqual(FAST.startWidth);
    expect(parseInt(host.style.height, 10)).toBeGreaterThanOrEqual(FAST.startHeight);
  });

  it("has the host at full size BEFORE anything is rendered into it, since the view lays itself out on first paint", async () => {
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(calls[0]!.widthAtRender).toBe(`${FAST.startWidth}px`);
    expect(calls[0]!.heightAtRender).toBe(`${FAST.startHeight}px`);
  });

  it("removes the host from the document and unloads its Component once the rows are read", async () => {
    const unload = vi.spyOn(Component.prototype, "unload");
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(hostsLeftBehind()).toBe(0);
    expect(calls[0]!.host.isConnected).toBe(false);
    expect(unload).toHaveBeenCalledTimes(1);
  });

  it("renders with a Component of its own, not one passed in", async () => {
    const calls = fillWith(embed());
    await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(calls[0]!.component).toBeInstanceOf(Component);
  });

  it("gives a table that outlives the host it was read from", async () => {
    fillWith(embed());
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(hostsLeftBehind()).toBe(0);
    expect(r.ok && r.table.querySelectorAll("td").length).toBe(6);
  });

  it("warns, but still returns the table, when the view reports more rows than it rendered", async () => {
    fillWith(embed({ count: "500" }));
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", { ...FAST, maxHeight: 4000 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toBe("bases table incomplete (2 of 500 rows)");
    expect(r.ok && r.table.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("fails with a timeout, naming the Bases plugin, when the view is never filled in", async () => {
    fillWith(null);
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/timed out.*Bases plugin/i) });
    expect(hostsLeftBehind()).toBe(0);
  });

  it("fails with the text Obsidian shows when the Base has an error", async () => {
    fillWith(embed({ error: "Filter error: unknown function" }));
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(r).toEqual({
      ok: false,
      reason: "Obsidian reported an error for this Base: Filter error: unknown function",
    });
  });

  it("fails, saying why, for a view that is not a table", async () => {
    fillWith(embed({ view: "cards" }));
    const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/cards/i) });
  });

  it.each([
    ["an Error", new Error("renderer blew up"), "renderer blew up"],
    ["a bare string", "just text", "just text"],
  ])(
    "turns %s thrown by the renderer into a failure, and still cleans up",
    async (_label, thrown, message) => {
      const unload = vi.spyOn(Component.prototype, "unload");
      vi.spyOn(MarkdownRenderer, "render").mockRejectedValue(thrown);
      const r = await renderBaseTable(APP, "Tasks.base", "note.md", FAST);
      expect(r).toEqual({ ok: false, reason: message });
      expect(hostsLeftBehind()).toBe(0);
      expect(unload).toHaveBeenCalledTimes(1);
    }
  );

  it("leaves no host behind across several Bases in a row", async () => {
    fillWith(embed());
    for (let i = 0; i < 3; i++) await renderBaseTable(APP, `T${i}.base`, "note.md", FAST);
    expect(hostsLeftBehind()).toBe(0);
  });
});

describe("the Bases renderer seam", () => {
  it("returns whatever was set, and the real renderer again after null", async () => {
    const custom = async () => ({ ok: false as const, reason: "custom" });
    setBaseRenderer(custom);
    expect(getBaseRenderer()).toBe(custom);
    setBaseRenderer(null);
    expect(getBaseRenderer()).not.toBe(custom);
  });

  it("the real one renders through renderBaseTable", async () => {
    setBaseRenderer(null);
    const calls = fillWith(embed());
    const r = await getBaseRenderer()(APP, "Tasks.base", "note.md");
    expect(r.ok).toBe(true);
    expect(calls[0]!.md).toBe("![[Tasks.base]]");
  });
});
