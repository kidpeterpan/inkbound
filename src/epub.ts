import JSZip from "jszip";
import { EPUB_CSS } from "./epub-css";
import { thaiFontCss, THAI_FONT_META, OFL_LICENSE_HREF, type ThaiFontAsset } from "./fonts";
import type { TocEntry } from "./render";
import type { ExportMeta } from "./types";

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function chapterHref(index: number): string {
  return `text/chapter_${String(index + 1).padStart(3, "0")}.xhtml`;
}

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
// Each chapter's toc entries (collected in render.ts and stamped as ids on
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

function renderTocNodes(nodes: TocNode[], href: string): string {
  if (nodes.length === 0) return "";
  const lis = nodes
    .map((n) => {
      // children already carries its own <ol> wrapper (or "" when leaf) —
      // wrapping it again would nest two <ol>s at the same level.
      const children = renderTocNodes(n.children, href);
      // Ids are sanitized by render.ts to XML NCName chars — no escaping
      // needed in the href; the display text gets the same escapeXml the
      // chapter titles already get (FR-009).
      return `<li><a href="${href}#${n.entry.id}">${escapeXml(n.entry.text)}</a>${children}</li>`;
    })
    .join("\n        ");
  return `<ol>\n          ${lis}\n        </ol>`;
}

export function renderTocSubEntries(entries: TocEntry[], href: string): string {
  return renderTocNodes(buildTocTree(entries), href);
}

export class EpubBuilder {
  private chapters: Chapter[] = [];
  private assets: Asset[] = [];
  // 006-thai-font: set only when the exporter detected Thai AND the setting
  // is ON. Absent = this feature's code paths are all no-ops and the built
  // book keeps today's exact structure (FR-003/SC-002).
  private thaiFont: ThaiFontAsset | null = null;

  constructor(private meta: ExportMeta) {}

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
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", this.containerXml());
    if (this.meta.coverBytes && this.meta.coverExt) {
      zip.file(`OEBPS/images/cover.${this.meta.coverExt}`, this.meta.coverBytes);
    }
    zip.file("OEBPS/package.opf", this.opf());
    zip.file("OEBPS/nav.xhtml", this.nav());
    // 006-thai-font: the stylesheet only gains @font-face + body chain when
    // the font is actually embedded — non-Thai books stay byte-stable.
    zip.file("OEBPS/style/epub.css", this.thaiFont ? `${EPUB_CSS}\n${thaiFontCss()}` : EPUB_CSS);
    if (this.thaiFont) {
      // Font binaries + the OFL license that must travel with them (FR-005).
      for (const f of THAI_FONT_META) {
        zip.file(`OEBPS/${f.href}`, f.weight === 400 ? this.thaiFont.regular : this.thaiFont.bold);
      }
      zip.file(`OEBPS/${OFL_LICENSE_HREF}`, this.thaiFont.license);
    }
    // Cover page: a real first spine document (not a chapter) so readers
    // open onto the artwork. Only when cover art exists — coverless books
    // keep today's exact structure (FR-004).
    if (this.hasCover()) {
      zip.file("OEBPS/text/cover.xhtml", this.coverDoc());
    }
    for (const ch of this.chapters) zip.file(`OEBPS/${ch.href}`, this.chapterDoc(ch));
    for (const a of this.assets) zip.file(`OEBPS/${a.href}`, a.bytes);
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

  private opf(): string {
    const m = this.meta;
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const hasCover = this.hasCover();
    const coverItem = hasCover
      ? `<item id="cover-image" href="images/cover.${m.coverExt}" media-type="image/${m.coverExt === "jpg" ? "jpeg" : m.coverExt}" properties="cover-image"/>`
      : "";
    const coverPageItem = hasCover
      ? `<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>`
      : "";
    const coverMeta = hasCover ? `<meta name="cover" content="cover-image"/>` : "";
    const items = this.chapters
      .map(
        (c) =>
          `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"${c.hasSvg ? ' properties="svg"' : ""}/>`
      )
      .concat(
        this.assets.map((a, i) => `<item id="asset_${i}" href="${a.href}" media-type="${a.mediaType}"/>`)
      )
      // 006-thai-font: stable manifest ids (font-regular/font-bold/
      // font-license), only present when the font was embedded.
      .concat(
        this.thaiFont
          ? THAI_FONT_META.map(
              (f) => `<item id="${f.manifestId}" href="${f.href}" media-type="${f.mediaType}"/>`
            ).concat([`<item id="font-license" href="${OFL_LICENSE_HREF}" media-type="text/plain"/>`])
          : []
      )
      .join("\n    ");
    const spine = (hasCover ? [`<itemref idref="cover-page"/>`] : [])
      .concat(this.chapters.map((c) => `<itemref idref="${c.id}"/>`))
      .join("\n    ");
    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${cryptoRandomUuid()}</dc:identifier>
    <dc:title>${escapeXml(m.title)}</dc:title>
    <dc:language>${escapeXml(m.language)}</dc:language>
    <dc:creator>${escapeXml(m.author)}</dc:creator>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style/epub.css" media-type="text/css"/>
    ${coverItem}
    ${coverPageItem}
    ${items}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  }

  private nav(): string {
    const lis = this.chapters
      .map(
        (c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a>${renderTocSubEntries(c.toc, c.href)}</li>`
      )
      .join("\n        ");
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
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
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

function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // RFC-4122 v4 UUID fallback: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
