import JSZip from "jszip";
import { EPUB_CSS } from "./epub-css";
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
}
interface Asset {
  href: string;
  bytes: Uint8Array;
  mediaType: string;
}

export class EpubBuilder {
  private chapters: Chapter[] = [];
  private assets: Asset[] = [];

  constructor(private meta: ExportMeta) {}

  addChapter(title: string, xhtmlBody: string): string {
    const index = this.chapters.length;
    const href = chapterHref(index);
    this.chapters.push({ id: `ch_${String(index + 1).padStart(3, "0")}`, href, title, body: xhtmlBody });
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
    zip.file("OEBPS/style/epub.css", EPUB_CSS);
    for (const ch of this.chapters) zip.file(`OEBPS/${ch.href}`, this.chapterDoc(ch));
    for (const a of this.assets) zip.file(`OEBPS/${a.href}`, a.bytes);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
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
    const coverItem =
      m.coverBytes && m.coverExt
        ? `<item id="cover-image" href="images/cover.${m.coverExt}" media-type="image/${m.coverExt === "jpg" ? "jpeg" : "png"}" properties="cover-image"/>`
        : "";
    const coverMeta = coverItem ? `<meta name="cover" content="cover-image"/>` : "";
    const items = this.chapters
      .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
      .concat(
        this.assets.map((a, i) => `<item id="asset_${i}" href="${a.href}" media-type="${a.mediaType}"/>`)
      )
      .join("\n    ");
    const spine = this.chapters.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ");
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
    ${items}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  }

  private nav(): string {
    const lis = this.chapters
      .map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`)
      .join("\n        ");
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
    </nav>
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
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();

  // RFC-4122 v4 UUID fallback: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
