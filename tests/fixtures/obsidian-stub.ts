// Runtime stub for the "obsidian" package, used ONLY by the local integration
// harness (scripts/local-export.ts). The real "obsidian" npm package ships
// type declarations only (node_modules/obsidian/package.json has "main": ""),
// so src/main.ts has never actually been executed outside a real Obsidian
// install. This stub gives esbuild something real to bundle in obsidian's
// place (require-shimmed in scripts/local-export.ts), so the harness runs the REAL
// src/main.ts orchestrator end to end.
//
// Signatures here were read directly from node_modules/obsidian/obsidian.d.ts
// and are deliberately narrowed to what src/*.ts actually touches — this is
// a harness fixture, not a general-purpose Obsidian API shim.

import * as fsSync from "fs";
import * as pathMod from "path";
import { marked } from "marked";

// ── Notice ──────────────────────────────────────────────────────────────

export const NOTICES: string[] = [];

export class Notice {
  noticeEl: HTMLElement;
  containerEl: HTMLElement;
  messageEl: HTMLElement;

  constructor(message: string | DocumentFragment, _duration?: number) {
    const text = typeof message === "string" ? message : (message.textContent ?? "");
    NOTICES.push(text);
    this.containerEl = document.createElement("div");
    this.messageEl = document.createElement("div");
    this.messageEl.textContent = text;
    this.noticeEl = this.messageEl;
  }

  setMessage(message: string | DocumentFragment): this {
    const text = typeof message === "string" ? message : (message.textContent ?? "");
    NOTICES.push(text);
    this.messageEl.textContent = text;
    return this;
  }

  hide(): void {
    // no-op: nothing is actually rendered to a screen in the harness.
  }
}

// ── Vault file classes (real classes: main.ts uses `instanceof`) ────────

export class TAbstractFile {
  path: string;
  name: string;
  protected vaultRoot: string;

  constructor(vaultRoot: string, relPath: string) {
    this.vaultRoot = vaultRoot;
    this.path = relPath;
    this.name = relPath === "" ? pathMod.basename(vaultRoot) : pathMod.basename(relPath);
  }

  get parent(): TFolder | null {
    if (this.path === "") return null;
    const idx = this.path.lastIndexOf("/");
    const parentPath = idx === -1 ? "" : this.path.slice(0, idx);
    return new TFolder(this.vaultRoot, parentPath);
  }
}

export class TFile extends TAbstractFile {
  get basename(): string {
    const dot = this.name.lastIndexOf(".");
    return dot > 0 ? this.name.slice(0, dot) : this.name;
  }
  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  // Lazy on purpose: computed on access via a real directory listing, one
  // level deep, so nothing eagerly walks the whole vault just because a
  // TFolder object exists.
  get children(): TAbstractFile[] {
    const full = pathMod.join(this.vaultRoot, this.path);
    return fsSync
      .readdirSync(full)
      .sort()
      .map((name) => {
        const rel = this.path ? `${this.path}/${name}` : name;
        const st = fsSync.statSync(pathMod.join(this.vaultRoot, rel));
        return st.isDirectory() ? new TFolder(this.vaultRoot, rel) : new TFile(this.vaultRoot, rel);
      });
  }
  isRoot(): boolean {
    return this.path === "";
  }
}

// ── FileSystemAdapter ─────────────────────────────────────────────────────

export class FileSystemAdapter {
  constructor(private basePath: string) {}
  getName(): string {
    return "local-harness-adapter";
  }
  getBasePath(): string {
    return this.basePath;
  }
}

// ── requestUrl (real network fetch for http/https) ───────────────────────

export interface RequestUrlParamLike {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

// Only real caller in the harness's default scenarios is main.ts's cover
// download (BooxDrop push goes through this too, but only when
// pushAfterExport/booxUrl are set, which the harness leaves off) — so the
// branch log below is labeled "cover:" rather than generically. Without this,
// an offline run silently exercises the cover-FAILURE path (fetch() throws)
// instead of the success path, and the operator can't tell from the harness
// output which one actually ran.
async function realRequestUrl(request: RequestUrlParamLike | string): Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: unknown;
}> {
  const req = typeof request === "string" ? { url: request } : request;
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body as BodyInit | undefined,
    });
  } catch (e) {
    console.log(`[local-export] cover: fetch failed — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  const arrayBuffer = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const status = res.status;
  console.log(
    `[local-export] cover: fetched ${arrayBuffer.byteLength} bytes (${headers["content-type"] ?? "unknown"}, status ${status})`
  );
  if (status >= 400 && req.throw !== false) {
    throw new Error(`Request failed, status ${status}`);
  }
  let text = "";
  try {
    text = new TextDecoder().decode(arrayBuffer);
  } catch {
    // binary body: leave text empty
  }
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: leave undefined
  }
  return { status, headers, arrayBuffer, text, json };
}

export type RequestUrlImpl = (request: RequestUrlParamLike | string) => Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: unknown;
}>;

let requestUrlImpl: RequestUrlImpl | null = null;

/** Install a deterministic requestUrl for tests. */
export function setRequestUrlImpl(impl: RequestUrlImpl): void {
  requestUrlImpl = impl;
}

/** Restore the default real-network implementation (used by the CLI harness). */
export function resetRequestUrlImpl(): void {
  requestUrlImpl = null;
}

export async function requestUrl(request: RequestUrlParamLike | string) {
  return (requestUrlImpl ?? realRequestUrl)(request);
}

// ── Component / Plugin ────────────────────────────────────────────────────

export class Component {
  private children: Component[] = [];
  load(): void {
    this.onload();
  }
  onload(): void {}
  unload(): void {
    this.onunload();
  }
  onunload(): void {}
  addChild<T extends Component>(c: T): T {
    this.children.push(c);
    return c;
  }
  removeChild<T extends Component>(c: T): T {
    return c;
  }
  register(_cb: () => unknown): void {}
  registerEvent(_ref: unknown): void {}
  registerDomEvent(): void {}
  registerInterval(id: number): number {
    return id;
  }
}

export class App {
  vault!: unknown;
  workspace!: unknown;
  metadataCache!: unknown;
}

export class Plugin extends Component {
  app: App;
  manifest: unknown;
  settings?: unknown;
  private _data: unknown = {};

  constructor(app: App, manifest: unknown) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(cmd: unknown): unknown {
    return cmd; // no-op: nothing registers a command palette in the harness
  }
  addRibbonIcon(): HTMLElement {
    return document.createElement("div");
  }
  addStatusBarItem(): HTMLElement {
    return document.createElement("div");
  }
  addSettingTab(_tab: unknown): void {}

  async loadData(): Promise<unknown> {
    return this._data ?? {};
  }
  async saveData(data: unknown): Promise<void> {
    this._data = data;
  }
}

// ── PluginSettingTab / Setting (not exercised by the harness's direct
// exportSingle/exportFolder/exportLinked calls — onload() and display() are
// never invoked — but must exist as real classes so `class X extends Y`
// declarations in settings.ts don't throw at module-load time). ─────────────

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  display(): void {}
  hide(): void {}
}

class ChainableControl {
  setValue(_v: unknown): this {
    return this;
  }
  onChange(_fn: (v: unknown) => unknown): this {
    return this;
  }
  setPlaceholder(_p: string): this {
    return this;
  }
  setLimits(_min: number, _max: number, _step: number): this {
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  setButtonText(_t: string): this {
    return this;
  }
  onClick(_fn: (evt: MouseEvent) => unknown): this {
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.infoEl = document.createElement("div");
    this.nameEl = document.createElement("div");
    this.descEl = document.createElement("div");
    this.controlEl = document.createElement("div");
    this.settingEl.appendChild(this.infoEl);
    this.settingEl.appendChild(this.controlEl);
    containerEl.appendChild(this.settingEl);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }
  addText(cb: (c: ChainableControl) => unknown): this {
    cb(new ChainableControl());
    return this;
  }
  addToggle(cb: (c: ChainableControl) => unknown): this {
    cb(new ChainableControl());
    return this;
  }
  addSlider(cb: (c: ChainableControl) => unknown): this {
    cb(new ChainableControl());
    return this;
  }
  addButton(cb: (c: ChainableControl) => unknown): this {
    cb(new ChainableControl());
    return this;
  }
}

// ── Menu ───────────────────────────────────────────────────────────────

export class MenuItem {
  setTitle(_t: string): this {
    return this;
  }
  setIcon(_i: string | null): this {
    return this;
  }
  setChecked(_c: boolean | null): this {
    return this;
  }
  onClick(_fn: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    return this;
  }
}

export class Menu extends Component {
  addItem(cb: (item: MenuItem) => unknown): this {
    cb(new MenuItem());
    return this;
  }
  addSeparator(): this {
    return this;
  }
  setNoIcon(): this {
    return this;
  }
}

// ── MarkdownRenderer ─────────────────────────────────────────────────────
//
// Converts markdown to Obsidian-shaped HTML via `marked`, then hand-rolls
// the handful of Obsidian-specific constructs `marked` doesn't know about:
// wikilinks, image embeds, inline tags, and callouts. Everything else
// (headings, paragraphs, tables, code fences, blockquotes, task lists,
// standard markdown images) is left to `marked`'s normal GFM rendering.

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface RenderApp {
  metadataCache: {
    getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
  };
}

// Transforms wikilinks / embeds / inline tags on a single line of raw
// markdown, protecting inline code spans from the substitution. Uses
// Private-Use-Area token wrappers (never produced by real note text) so the
// later passes (tag detection, marked itself) can't accidentally re-mangle
// already-substituted HTML.
function transformLine(line: string, app: RenderApp, sourcePath: string, basePath: string): string {
  const codeParts: string[] = [];
  const withCodeTokens = line.replace(/`[^`]*`/g, (m) => {
    const token = `C${codeParts.length}`;
    codeParts.push(m);
    return token;
  });

  const tokens: string[] = [];
  const storeToken = (html: string): string => {
    const token = `T${tokens.length}`;
    tokens.push(html);
    return token;
  };

  // 1. Image / note embeds: ![[name]] or ![[name|alias]]
  let out = withCodeTokens.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, rawName: string) => {
    const name = rawName.trim();
    let html: string;
    if (IMAGE_EXT.test(name)) {
      const dest = app.metadataCache.getFirstLinkpathDest(name, sourcePath);
      if (dest) {
        const src = `app://localstub${encodeURI(basePath)}/${encodeURI(dest.path)}`;
        html = `<span class="internal-embed image-embed is-loaded" src="${escapeAttr(name)}"><img src="${src}"></span>`;
      } else {
        // Unresolved image embed: no <img> child, so cleanupDom's
        // has-rendered-content check degrades it to an omission marker —
        // mirrors a broken embed in real Obsidian.
        html = `<span class="internal-embed image-embed" src="${escapeAttr(name)}"></span>`;
      }
    } else {
      html = `<span class="internal-embed" src="${escapeAttr(name)}"></span>`;
    }
    return storeToken(html);
  });

  // 2. Wikilinks (embeds already consumed above, so no `!` prefix remains)
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, rawName: string, rawAlias?: string) => {
    const name = rawName.trim();
    const text = rawAlias ? rawAlias.trim() : name;
    const html = `<a data-href="${escapeAttr(name)}" href="${escapeAttr(name)}" class="internal-link">${escapeHtml(text)}</a>`;
    return storeToken(html);
  });

  // 3. Inline #tags (require a non-space char right after '#', so headings
  // like "# Heading" — which always have a space — are never matched).
  out = out.replace(/(^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)/g, (_m, pre: string, tag: string) => {
    const html = `<a href="#${tag}" class="tag" target="_blank" rel="noopener">#${tag}</a>`;
    return pre + storeToken(html);
  });

  out = out.replace(/T(\d+)/g, (_m, n: string) => tokens[Number(n)]);
  out = out.replace(/C(\d+)/g, (_m, n: string) => codeParts[Number(n)]);
  return out;
}

// Line-based preprocessor: tracks fenced-code state (fenced lines pass
// through verbatim, untouched by wikilink/tag substitution) and Obsidian
// callout blocks (`> [!type] Title` + continuation `>` lines), which get
// replaced with a fully-rendered `div.callout` HTML block before the rest
// of the document is handed to `marked`.
function preprocessMarkdown(md: string, app: RenderApp, sourcePath: string, basePath: string): string {
  const lines = md.split(/\r?\n/);
  const output: string[] = [];
  let inFence = false;
  let calloutLines: string[] | null = null;
  let calloutType = "";
  let calloutTitle = "";

  const flushCallout = () => {
    if (calloutLines === null) return;
    const bodyHtml = marked.parse(calloutLines.join("\n"), { async: false }) as string;
    const titleHtml = escapeHtml(calloutTitle || calloutType);
    output.push("");
    output.push(
      `<div class="callout" data-callout="${calloutType.toLowerCase()}"><div class="callout-title">${titleHtml}</div><div class="callout-content">${bodyHtml}</div></div>`
    );
    output.push("");
    calloutLines = null;
    calloutType = "";
    calloutTitle = "";
  };

  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      flushCallout();
      inFence = !inFence;
      output.push(rawLine);
      continue;
    }
    if (inFence) {
      output.push(rawLine);
      continue;
    }

    if (calloutLines !== null) {
      const cont = /^>\s?(.*)$/.exec(rawLine);
      if (cont) {
        calloutLines.push(transformLine(cont[1], app, sourcePath, basePath));
        continue;
      }
      flushCallout();
      // fall through: rawLine is processed normally below
    }

    const start = /^>\s?\[!(\w+)\]\s*(.*)$/.exec(rawLine);
    if (start) {
      calloutType = start[1];
      calloutTitle = start[2].trim();
      calloutLines = [];
      continue;
    }

    output.push(transformLine(rawLine, app, sourcePath, basePath));
  }
  flushCallout();
  return output.join("\n");
}

export class MarkdownRenderer {
  static async render(
    app: RenderApp & { vault: { adapter: FileSystemAdapter } },
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    _component: Component
  ): Promise<void> {
    const basePath = app.vault.adapter.getBasePath();
    const processed = preprocessMarkdown(markdown, app, sourcePath, basePath);
    const html = marked.parse(processed, { async: false }) as string;
    el.innerHTML = html;
  }
}
