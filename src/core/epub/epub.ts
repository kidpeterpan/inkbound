import JSZip from "jszip";
import { EPUB_CSS, FOOTNOTE_CSS } from "./epub-css";
import { usesFootnoteMarkup } from "../content/footnotes";
import { thaiFontCss, THAI_FONT_META, OFL_LICENSE_HREF, type ThaiFontAsset } from "./fonts";
import type { TocEntry } from "../render";
import type { ExportMeta } from "../types";
import { escapeXml } from "../common/xml";
import { systemBookIdentity, type BookIdentity } from "./book-identity";

export function chapterHref(index: number): string {
  return `text/chapter_${String(index + 1).padStart(3, "0")}.xhtml`;
}

// 009-index-order-parts: the nested table-of-contents plan main.ts hands to
// setNavTree. Chapters are referenced by their POSITION in addChapter order
// (== job.files order), never by href or path — see the invariant comment at
// main.ts's failed-chapter placeholder for why that alignment is load-bearing.
export type NavItem =
  | { kind: "chapter"; chapter: number }
  | { kind: "part"; title: string; indexChapter: number | null; children: NavItem[] };

interface Chapter {
  id: string;
  href: string;
  title: string;
  body: string;
  hasSvg: boolean;
  toc: TocEntry[];
}
interface Asset {
  href: string;
  bytes: Uint8Array;
  mediaType: string;
}

// ── Heading sub-entries (004-heading-toc) ─────────────────────────────────
//
// Each chapter's toc entries (collected in render/toc.ts and stamped as ids on
// the chapter's heading elements) render as nested <ol> sub-entries inside
// the chapter's own <li>. Nesting mirrors the document hierarchy: every
// heading nests under the nearest PRECEDING heading of a shallower level,
// and level gaps (H2 followed directly by H4) nest without injecting empty
// levels (FR-003). When toc is empty this returns "" and the chapter <li>
// stays byte-identical to the pre-feature flat entry (FR-006/FR-010).
interface TocNode {
  entry: TocEntry;
  children: TocNode[];
}

function buildTocTree(entries: TocEntry[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const entry of entries) {
    const node: TocNode = { entry, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].entry.level >= entry.level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

// Wraps already-rendered <li> strings in the one <ol> a nav <li> may carry.
// Split out from renderTocNodes (009-index-order-parts) so a Part entry can
// merge heading sub-entries and child chapters into a SINGLE list: EPUB 3's
// nav grammar allows each <li> exactly one <a> followed by at most one <ol>,
// and epubcheck enforces it — two sibling <ol>s in one <li> is an invalid book.
function wrapOl(lis: string[]): string {
  return `<ol>\n          ${lis.join("\n        ")}\n        </ol>`;
}

function tocNodeLis(nodes: TocNode[], href: string): string[] {
  return nodes.map((n) => {
    // children already carries its own <ol> wrapper (or "" when leaf) —
    // wrapping it again would nest two <ol>s at the same level.
    const children = renderTocNodes(n.children, href);
    // Ids are sanitized by render/toc.ts to XML NCName chars — no escaping
    // needed in the href; the display text gets the same escapeXml the
    // chapter titles already get (FR-009).
    return `<li><a href="${href}#${n.entry.id}">${escapeXml(n.entry.text)}</a>${children}</li>`;
  });
}

function renderTocNodes(nodes: TocNode[], href: string): string {
  if (nodes.length === 0) return "";
  return wrapOl(tocNodeLis(nodes, href));
}

export function renderTocSubEntries(entries: TocEntry[], href: string): string {
  return renderTocNodes(buildTocTree(entries), href);
}

// ── Nested Parts (009-index-order-parts) ──────────────────────────────────
//
// Validates that a nav tree covers chapters 0..count-1 exactly once and that
// every Part can be opened (an index-less Part needs a descendant chapter to
// link to, FR-010). Throws with a message naming the problem; main.ts catches
// and falls back to the flat nav with a warning (constitution II).
export function validateNavTree(tree: NavItem[], count: number): void {
  const seen = new Set<number>();
  const take = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= count) {
      throw new Error(`nav tree entry ${i} is out of range (book has ${count} chapters)`);
    }
    if (seen.has(i)) throw new Error(`nav tree lists chapter ${i + 1} twice`);
    seen.add(i);
  };
  const walk = (items: NavItem[]) => {
    for (const item of items) {
      if (item.kind === "chapter") {
        take(item.chapter);
        continue;
      }
      if (item.indexChapter !== null) take(item.indexChapter);
      else if (firstChapterOf(item) === null) throw new Error(`Part "${item.title}" has no chapter to open`);
      walk(item.children);
    }
  };
  walk(tree);
  for (let i = 0; i < count; i++) {
    if (!seen.has(i)) throw new Error(`nav tree is missing chapter ${i + 1}`);
  }
}

// The chapter a Part entry opens: its index chapter, else the first chapter
// reached by depth-first descent (null only for a malformed, empty Part).
function firstChapterOf(item: NavItem): number | null {
  if (item.kind === "chapter") return item.chapter;
  if (item.indexChapter !== null) return item.indexChapter;
  for (const child of item.children) {
    const found = firstChapterOf(child);
    if (found !== null) return found;
  }
  return null;
}

export class EpubBuilder {
  private chapters: Chapter[] = [];
  private assets: Asset[] = [];
  // 006-thai-font: set only when the exporter detected Thai AND the setting
  // is ON. Absent = this feature's code paths are all no-ops and the built
  // book keeps today's exact structure (FR-003/SC-002).
  private thaiFont: ThaiFontAsset | null = null;
  // 009-index-order-parts: null ⇒ nav() renders today's flat list, byte for
  // byte (FR-013/FR-014). Set only by folder exports that produced Parts.
  private navTree: NavItem[] | null = null;

  // A real export passes nothing and gets the system's time + a random UUID;
  // a caller that wants a reproducible artifact passes a fixed identity (see
  // book-identity.ts), which is the only thing that has to change.
  constructor(
    private meta: ExportMeta,
    private identity: BookIdentity = systemBookIdentity()
  ) {}

  /**
   * Adds one ZIP entry, stamped with this book's identity date. Every entry
   * goes through here so two builds of the same book are byte-identical —
   * JSZip would otherwise date each entry with the current clock.
   */
  private addEntry(
    zip: JSZip,
    path: string,
    data: string | Uint8Array,
    options: JSZip.JSZipFileOptions = {}
  ): void {
    zip.file(path, data, { ...options, date: this.identity.zipDate });
  }

  setNavTree(tree: NavItem[]): void {
    validateNavTree(tree, this.chapters.length);
    this.navTree = tree;
  }

  setThaiFont(asset: ThaiFontAsset): void {
    this.thaiFont = asset;
  }

  addChapter(title: string, xhtmlBody: string, toc: TocEntry[] = []): string {
    const index = this.chapters.length;
    const href = chapterHref(index);
    // EPUB 3 (OPF-014) requires the manifest item for any XHTML document
    // containing inline SVG to declare properties="svg". A plain substring
    // check is sufficient — this only decides a manifest attribute, not
    // markup correctness.
    const hasSvg = xhtmlBody.includes("<svg");
    this.chapters.push({
      id: `ch_${String(index + 1).padStart(3, "0")}`,
      href,
      title,
      body: xhtmlBody,
      hasSvg,
      toc,
    });
    return href;
  }

  addAsset(href: string, bytes: Uint8Array, mediaType: string): void {
    this.assets.push({ href, bytes, mediaType });
  }

  async build(): Promise<Uint8Array> {
    const zip = new JSZip();
    // Spec: mimetype must be the FIRST entry and stored uncompressed.
    this.addEntry(zip, "mimetype", "application/epub+zip", { compression: "STORE" });
    this.addEntry(zip, "META-INF/container.xml", this.containerXml());
    if (this.meta.coverBytes && this.meta.coverExt) {
      this.addEntry(zip, `OEBPS/images/cover.${this.meta.coverExt}`, this.meta.coverBytes);
    }
    this.addEntry(zip, "OEBPS/package.opf", this.opf());
    this.addEntry(zip, "OEBPS/nav.xhtml", this.nav());
    // The stylesheet only GAINS things a book actually uses, so a book that uses
    // neither stays byte-stable: 006-thai-font adds @font-face + body chain when the font
    // is embedded, 011-footnote-semantics adds the footnote rules when any chapter
    // carries footnotes. Fixed order: base, footnotes, Thai.
    const css = [EPUB_CSS];
    if (this.chapters.some((c) => usesFootnoteMarkup(c.body))) css.push(FOOTNOTE_CSS);
    if (this.thaiFont) css.push(thaiFontCss());
    this.addEntry(zip, "OEBPS/style/epub.css", css.join("\n"));
    if (this.thaiFont) {
      // Font binaries + the OFL license that must travel with them (FR-005).
      for (const f of THAI_FONT_META) {
        this.addEntry(zip, `OEBPS/${f.href}`, f.weight === 400 ? this.thaiFont.regular : this.thaiFont.bold);
      }
      this.addEntry(zip, `OEBPS/${OFL_LICENSE_HREF}`, this.thaiFont.license);
    }
    // Cover page: a real first spine document (not a chapter) so readers
    // open onto the artwork. Only when cover art exists — coverless books
    // keep today's exact structure (FR-004).
    if (this.hasCover()) {
      this.addEntry(zip, "OEBPS/text/cover.xhtml", this.coverDoc());
    }
    for (const ch of this.chapters) this.addEntry(zip, `OEBPS/${ch.href}`, this.chapterDoc(ch));
    for (const a of this.assets) this.addEntry(zip, `OEBPS/${a.href}`, a.bytes);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  private hasCover(): boolean {
    return !!this.meta.coverBytes && !!this.meta.coverExt;
  }

  private containerXml(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  }

  // The optional cover's manifest pieces — image item, its spine page, and the
  // <meta name="cover"> — all empty when the book is coverless.
  private coverManifestItems(): { image: string; page: string; meta: string } {
    if (!this.hasCover()) return { image: "", page: "", meta: "" };
    const ext = this.meta.coverExt!;
    return {
      image: `<item id="cover-image" href="images/cover.${ext}" media-type="image/${ext === "jpg" ? "jpeg" : ext}" properties="cover-image"/>`,
      page: `<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`,
      meta: `<meta name="cover" content="cover-image"/>`,
    };
  }

  // Manifest items for the chapters, their assets, and the optional font.
  private contentManifestItems(): string[] {
    const chapters = this.chapters.map(
      (c) =>
        `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"${c.hasSvg ? ' properties="svg"' : ""}/>`
    );
    const assets = this.assets.map(
      (a, i) => `<item id="asset_${i}" href="${a.href}" media-type="${a.mediaType}"/>`
    );
    // 006-thai-font: stable manifest ids (font-regular/font-bold/
    // font-license), only present when the font was embedded.
    const fonts = this.thaiFont
      ? THAI_FONT_META.map(
          (f) => `<item id="${f.manifestId}" href="${f.href}" media-type="${f.mediaType}"/>`
        ).concat([`<item id="font-license" href="${OFL_LICENSE_HREF}" media-type="text/plain"/>`])
      : [];
    return [...chapters, ...assets, ...fonts];
  }

  private spineItems(): string[] {
    const cover = this.hasCover() ? [`<itemref idref="cover-page"/>`] : [];
    return [...cover, ...this.chapters.map((c) => `<itemref idref="${c.id}"/>`)];
  }

  private opf(): string {
    const cover = this.coverManifestItems();
    const items = this.contentManifestItems().join("\n    ");
    const spine = this.spineItems().join("\n    ");
    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${this.identity.uuid}</dc:identifier>
    <dc:title>${escapeXml(this.meta.title)}</dc:title>
    <dc:language>${escapeXml(this.meta.language)}</dc:language>
    <dc:creator>${escapeXml(this.meta.author)}</dc:creator>
    <meta property="dcterms:modified">${this.identity.modifiedAt}</meta>
    ${cover.meta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style/epub.css" media-type="text/css"/>
    ${cover.image}
    ${cover.page}
    ${items}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  }

  private chapterLi(c: Chapter): string {
    return `<li><a href="${c.href}">${escapeXml(c.title)}</a>${renderTocSubEntries(c.toc, c.href)}</li>`;
  }

  // A Part with an index chapter IS that chapter's entry: same <a> as the
  // flat renderer, then ONE <ol> holding the index chapter's heading
  // sub-entries followed by the Part's children (research R1). Without an
  // index the entry links to the first descendant chapter and nests every
  // child. Either way: one <a>, at most one <ol> — see wrapOl.
  private renderNavItem(item: NavItem): string {
    if (item.kind === "chapter") return this.chapterLi(this.chapters[item.chapter]);
    return this.renderPartNavItem(item);
  }

  private renderPartNavItem(item: Extract<NavItem, { kind: "part" }>): string {
    const childListItems = item.children.map((child) => this.renderNavItem(child));
    if (item.indexChapter !== null) {
      const indexChapter = this.chapters[item.indexChapter];
      const nestedListItems = [
        ...tocNodeLis(buildTocTree(indexChapter.toc), indexChapter.href),
        ...childListItems,
      ];
      return `<li><a href="${indexChapter.href}">${escapeXml(indexChapter.title)}</a>${
        nestedListItems.length ? wrapOl(nestedListItems) : ""
      }</li>`;
    }
    const firstChapter = this.chapters[firstChapterOf(item)!];
    return `<li><a href="${firstChapter.href}">${escapeXml(item.title)}</a>${wrapOl(childListItems)}</li>`;
  }

  private nav(): string {
    // Re-validate at build time: addChapter may have run after setNavTree.
    if (this.navTree) validateNavTree(this.navTree, this.chapters.length);
    const lis = (
      this.navTree
        ? this.navTree.map((i) => this.renderNavItem(i))
        : this.chapters.map((c) => this.chapterLi(c))
    ).join("\n        ");
    // Landmarks: the cover page must stay OUT of the TOC (it is not a
    // chapter, FR-005), but a spine document must be reachable from a
    // hyperlink for epubcheck's OPF-096 check (research R1). A landmarks
    // entry satisfies that and lets readers jump to the cover.
    const landmarks = this.hasCover()
      ? `\n    <nav epub:type="landmarks">\n      <ol>\n        <li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>\n      </ol>\n    </nav>`
      : "";
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(this.meta.title)}</title></head>
  <body>
    <nav epub:type="toc">
      <h1>${escapeXml(this.meta.title)}</h1>
      <ol>
        ${lis}
      </ol>
    </nav>${landmarks}
  </body>
</html>`;
  }

  private coverDoc(): string {
    const ext = this.meta.coverExt!;
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Cover</title>
    <link rel="stylesheet" type="text/css" href="../style/epub.css"/>
  </head>
  <body class="cover-page">
    <img src="../images/cover.${ext}" alt="Cover"/>
  </body>
</html>`;
  }

  private chapterDoc(ch: Chapter): string {
    // 011-footnote-semantics: `epub:type` needs the EPUB structural-semantics namespace
    // (epubcheck: an unbound prefix is FATAL RSC-016). Declared ONLY on a chapter whose
    // markup uses it — matching an attribute inside a tag, not prose that mentions one —
    // so every other chapter stays byte-identical (FR-023/FR-024).
    const epubNs = /<[^<>]*\sepub:type=/.test(ch.body) ? ' xmlns:epub="http://www.idpf.org/2007/ops"' : "";
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"${epubNs}>
  <head>
    <title>${escapeXml(ch.title)}</title>
    <link rel="stylesheet" type="text/css" href="../style/epub.css"/>
  </head>
  <body>
${ch.body}
  </body>
</html>`;
  }
}
