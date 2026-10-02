// Obsidian adapter for exporting a Bases TABLE view as a static table.
//
// Deliberately apart from render-adapter.ts and from the pure src/bases.ts: it
// is the only place that needs Obsidian's runtime (MarkdownRenderer, Component,
// the live document), and the only part that cannot run under vitest for real —
// so it stays small, and everything it decides lives in bases.ts.
//
// HOW IT WORKS: Obsidian fills in a Base only when the element holding it is
// attached to the live document (measured: rendered into a DETACHED element,
// which is how the export renders a chapter, a Base shows its toolbar and no
// rows). So each Base embed gets its OWN temporary host — never the whole
// chapter, so a book without Bases never touches the live document — sized and
// resized by settleBaseView, read, and removed again in `finally`.
//
// The render uses a short-lived Component, unloaded as soon as the rows are
// read. Rendering with the plugin as the Component would leave a live Base view
// subscribed to vault changes after every export.
//
// Nothing here throws: every failure is a `{ ok: false, reason }` for the caller
// to turn into the omission marker plus a warning (the 1.9.1 rule: one bad
// embed costs that embed, never the chapter).
import { App, Component, MarkdownRenderer } from "obsidian";
import {
  DEFAULT_SETTLE,
  buildStaticTable,
  extractBaseTable,
  readBaseView,
  settleBaseView,
  type SettleOps,
  type SettleOptions,
} from "../core/bases";
import { errorMessage } from "../core/error-text";

export type BaseRenderOutcome =
  // `warning`: something is known to be missing from the table (rows or columns
  // cut short even at the largest host), or null.
  { ok: true; table: HTMLElement; warning: string | null } | { ok: false; reason: string };

export type BaseRenderer = (app: App, src: string, sourcePath: string) => Promise<BaseRenderOutcome>;

export async function renderBaseTable(
  app: App,
  src: string,
  sourcePath: string,
  options: SettleOptions = DEFAULT_SETTLE
): Promise<BaseRenderOutcome> {
  const host = activeDocument.body.createDiv({ cls: "markdown-rendered" });
  // Invisible and out of the way, but LAID OUT: Obsidian sizes the view from the
  // host, so it must have real dimensions (measured: a 40px-tall host renders no
  // rows at all). These are layout requirements of a transient measurement
  // element, not theming, and they change together with the size on every resize
  // — so they are set here in one call rather than in a stylesheet, which would
  // make styles.css (empty today, and so not shipped) a release asset for the
  // sake of a div that lives for a fraction of a second.
  const size = (width: number, height: number): void =>
    host.setCssStyles({
      position: "fixed",
      left: "0",
      top: "0",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
      overflow: "auto",
      width: `${width}px`,
      height: `${height}px`,
    });
  // Sized before anything is rendered into it, as the view lays itself out on first paint.
  size(options.startWidth, options.startHeight);
  const component = new Component();
  component.load();
  try {
    // `src` is the embed's own linktext, view suffix included (`Tasks.base#Open`),
    // so Obsidian picks the same view it shows in reading mode.
    await MarkdownRenderer.render(app, `![[${src}]]`, host, sourcePath, component);

    const ops: SettleOps = {
      read: () => readBaseView(host),
      setSize: size,
      sleep: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    const settled = await settleBaseView(ops, options);

    if (settled.kind === "timeout") {
      // Also what a disabled Bases core plugin looks like: the embed never fills in.
      return {
        ok: false,
        reason: "timed out waiting for Obsidian to render the Base (is the Bases plugin enabled?)",
      };
    }
    if (settled.kind === "error") {
      return { ok: false, reason: `Obsidian reported an error for this Base: ${settled.message}` };
    }
    if (settled.kind === "unsupported") return { ok: false, reason: settled.reason };
    return {
      ok: true,
      table: buildStaticTable(extractBaseTable(host)),
      warning: settled.incomplete === null ? null : `bases table incomplete (${settled.incomplete})`,
    };
  } catch (e) {
    return { ok: false, reason: errorMessage(e) };
  } finally {
    component.unload();
    host.remove();
  }
}

// The renderer populateEmbeds calls, replaceable so tests never need a live
// Obsidian — same pattern as setSvgRasterizer in render.ts. tests/setup installs
// a stand-in before every test, so a test that forgets cannot wait on a real
// timeout.
const realRenderer: BaseRenderer = (app, src, sourcePath) => renderBaseTable(app, src, sourcePath);
let current: BaseRenderer = realRenderer;

export function setBaseRenderer(fn: BaseRenderer | null): void {
  current = fn ?? realRenderer;
}

export function getBaseRenderer(): BaseRenderer {
  return current;
}
