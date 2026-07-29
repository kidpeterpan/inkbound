const CHROME_SELECTORS = [
  ".edit-block-button",
  ".copy-code-button",
  ".collapse-indicator",
  ".markdown-preview-pusher",
  ".mod-frontmatter",
  ".frontmatter",
  ".metadata-container",
];

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function stripDynamicBlocks(md: string): string {
  return md.replace(/```dataview(js)?\r?\n[\s\S]*?```/g, "*[dynamic content omitted]*");
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Block-level (or block-like) tags inside a mermaid foreignObject's XHTML
// content whose boundaries should become a line break in the flattened SVG
// <text>. Mermaid's own markup only ever nests <span>/<p>/<br> here, but a
// few extra tags are included defensively since foreignObject content is
// arbitrary XHTML.
const FOREIGN_OBJECT_BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

// Collects the normalized text lines inside a mermaid label foreignObject.
// Runs of whitespace collapse to a single space and each result is trimmed;
// <br> and block-level children each start a new line so multi-line labels
// (e.g. "mid = ...<br/>guess = ...") survive as separate lines rather than
// being smashed together.
function collectForeignObjectLines(fo: Element): string[] {
  const lines: string[] = [];
  let current = "";
  const flush = (): void => {
    const t = current.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
    current = "";
  };
  const walk = (node: ChildNode): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      flush();
      return;
    }
    const isBlock = FOREIGN_OBJECT_BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    Array.from(el.childNodes).forEach(walk);
    if (isBlock) flush();
  };
  Array.from(fo.childNodes).forEach(walk);
  flush();
  return lines;
}

// Converts every <foreignObject> under one mermaid <svg> into a real SVG
// <text> (or removes it, if it turns out to be an empty label placeholder).
// foreignObject/HTML-in-SVG is what e-ink EPUB readers refuse to render, and
// a <p> nested inside a <span> inside it is invalid XHTML (epubcheck RSC-005
// "element p not allowed here") — flattening to <text>/<tspan> fixes both.
function normalizeForeignObjects(svg: SVGElement): void {
  svg.querySelectorAll("foreignObject").forEach((fo) => {
    const width = parseFloat(fo.getAttribute("width") ?? "") || 0;
    const height = parseFloat(fo.getAttribute("height") ?? "") || 0;
    const lines = collectForeignObjectLines(fo);
    if (lines.length === 0) {
      // Empty edge-label placeholder (mermaid emits height="0" width="0"
      // with no text for edges that have no label) — contributes nothing.
      fo.remove();
      return;
    }
    // createElementNS is required here: createElement would place the node
    // in the XHTML namespace and it would serialize (and render) wrong.
    const text = document.createElementNS(SVG_NS, "text");
    const x = width / 2;
    const y = height / 2;
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(x));
      tspan.setAttribute("dy", i === 0 ? "0" : "1.2em");
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    fo.replaceWith(text);
  });
}

// Prefixes every id in one mermaid <svg> (and the svg's own id) with a
// stable per-diagram prefix, rewriting every url(#OLD)/href="#OLD" reference
// in lockstep so nothing breaks. Mermaid emits the same element ids (e.g.
// "L_A_B_0") in every diagram it renders, so multiple diagrams sharing one
// XHTML chapter collide (epubcheck RSC-005 "Duplicate ID") unless each
// diagram's ids are made unique.
function prefixIds(svg: SVGElement, prefix: string): void {
  const withIds: Element[] = [];
  if (svg.hasAttribute("id")) withIds.push(svg);
  svg.querySelectorAll("[id]").forEach((el) => withIds.push(el));

  const idMap = new Map<string, string>();
  for (const el of withIds) {
    const oldId = el.getAttribute("id");
    if (oldId && !idMap.has(oldId)) idMap.set(oldId, `${prefix}${oldId}`);
  }
  if (idMap.size === 0) return;

  for (const el of withIds) {
    const oldId = el.getAttribute("id");
    if (oldId) el.setAttribute("id", idMap.get(oldId)!);
  }

  const allElements: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
  for (const el of allElements) {
    for (const attr of Array.from(el.attributes)) {
      const { name, value } = attr;
      if (!value) continue;
      let newValue = value;
      if (newValue.includes("url(#")) {
        newValue = newValue.replace(/url\(#([^)'"]+)\)/g, (whole, id: string) => {
          const mapped = idMap.get(id);
          return mapped ? `url(#${mapped})` : whole;
        });
      }
      if ((name === "href" || name.endsWith(":href")) && newValue.startsWith("#")) {
        const mapped = idMap.get(newValue.slice(1));
        if (mapped) newValue = `#${mapped}`;
      }
      if (newValue !== value) el.setAttribute(name, newValue);
    }
  }
}

// Mermaid diagrams live in div.mermaid > svg, but this handles any inline
// svg in the export. Give each one a stable 1-based document-order index so
// its ids never collide with a sibling diagram's ids in the same chapter.
export function normalizeMermaidSvg(root: HTMLElement): void {
  root.querySelectorAll("svg").forEach((svg, index) => {
    normalizeForeignObjects(svg);
    prefixIds(svg, `m${index + 1}_`);
  });
}

export function cleanupDom(root: HTMLElement): void {
  normalizeMermaidSvg(root);
  for (const sel of CHROME_SELECTORS) root.querySelectorAll(sel).forEach((n) => n.remove());
  root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    const glyph = (input as HTMLInputElement).checked ? "☑ " : "☐ ";
    input.replaceWith(document.createTextNode(glyph));
  });
  root.querySelectorAll("a.tag").forEach((a) => {
    // Obsidian renders inline #tags as <a class="tag" href="#tagname" ...>
    // with no data-href, so rewriteLinks's internal-link/data-href check
    // never sees them — they'd otherwise pass through as dead fragment
    // links in the EPUB (epubcheck RSC-012; dead taps on e-ink readers).
    const span = document.createElement("span");
    span.textContent = a.textContent ?? "";
    a.replaceWith(span);
  });
  root.querySelectorAll("span.internal-embed, div.internal-embed").forEach((embed) => {
    // Check if this embed has rendered content (img, video, or markdown-embed-content).
    const hasRenderedContent = embed.querySelector("img, video, .markdown-embed-content") !== null;
    if (hasRenderedContent) {
      // Unwrap: replace the embed container with its child nodes.
      Array.from(embed.childNodes).forEach((child) => {
        embed.parentNode?.insertBefore(child, embed);
      });
      embed.remove();
    } else {
      // No rendered content: replace with omission marker.
      const name = embed.getAttribute("src") ?? "unknown";
      const p = document.createElement("p");
      p.className = "omitted";
      p.textContent = `[embedded content omitted: ${name}]`;
      embed.replaceWith(p);
    }
  });
}

export function rewriteLinks(
  root: HTMLElement,
  hrefByPath: Map<string, string>,
  resolve: (linkpath: string) => string | null
): string[] {
  const warnings: string[] = [];
  root.querySelectorAll("a").forEach((a) => {
    const dataHref = a.getAttribute("data-href");
    const isInternal = a.classList.contains("internal-link") || dataHref !== null;
    if (!isInternal) return; // external link: leave untouched
    const targetPath = dataHref ? resolve(dataHref) : null;
    const chapter = targetPath ? hrefByPath.get(targetPath) : undefined;
    if (chapter) {
      // Chapters live side by side in text/, so link by filename only.
      a.setAttribute("href", chapter.replace(/^text\//, ""));
      a.removeAttribute("data-href");
      a.removeAttribute("class");
      a.removeAttribute("target");
      a.removeAttribute("rel");
    } else {
      const span = document.createElement("span");
      span.textContent = a.textContent ?? "";
      a.replaceWith(span);
    }
  });
  return warnings;
}

export function rewriteImages(
  root: HTMLElement,
  basePath: string,
  startIndex = 0
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    // Missing/empty src: nothing to resolve, nothing to warn about.
    if (src === "") return;
    // Protocol-relative (scheme-less): leave completely untouched.
    if (/^\/\//.test(src)) return;
    // Any other scheme (http:, https:, data:, blob:, file:, mailto:, ...)
    // except our own "app://" internal-resource scheme: leave untouched.
    // Case-insensitive per RFC 3986 (scheme names are not case sensitive).
    const scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(src)?.[1].toLowerCase();
    if (scheme && scheme !== "app") return;
    // Already rewritten by a previous pass: idempotence guard. Matches only
    // what this function itself emits, not an arbitrary note-relative
    // "../images/..." reference from a sibling folder.
    if (/^\.\.\/images\/img_\d+\.[a-z0-9]+$/i.test(src)) return;

    let vaultPath: string;
    if (scheme === "app") {
      const noQueryOrFragment = src.split(/[?#]/)[0];
      let decoded: string;
      try {
        decoded = decodeURIComponent(noQueryOrFragment);
      } catch {
        // Malformed URI (e.g., literal % in filename): skip this image.
        return;
      }
      const at = decoded.indexOf(basePath);
      if (at === -1) {
        // Path doesn't contain the given basePath (multi-vault, symlinked
        // attachment folders, path-case differences). Fall through with just
        // the basename so the caller's fuzzy resolver (getFirstLinkpathDest)
        // gets a chance, and failing that, the missing-image warning fires —
        // every image ends up either embedded or warned, never silently
        // left as a broken app:// href.
        vaultPath = decoded.split("/").pop() ?? decoded;
      } else {
        vaultPath = decoded.slice(at + basePath.length).replace(/^\//, "");
      }
    } else {
      // Relative or vault-absolute markdown image path (not app://-resolved).
      // Left UNRESOLVED here — the caller resolves it against the source
      // note (render.ts stays pure, zero obsidian imports).
      const noQueryOrFragment = src.split(/[?#]/)[0];
      try {
        vaultPath = decodeURIComponent(noQueryOrFragment);
      } catch {
        // Malformed URI (e.g., literal % in filename): skip this image.
        return;
      }
    }
    const extMatch = /\.(\w+)$/.exec(vaultPath);
    const ext = extMatch ? extMatch[1].toLowerCase() : "png";
    // startIndex offsets numbering so images from different chapters in the
    // same export never collide (each call only sees one chapter's <img>s).
    const newHref = `../images/img_${String(startIndex + found.length + 1).padStart(3, "0")}.${ext}`;
    found.push({ vaultPath, newHref });
    img.setAttribute("src", newHref);
    if (!img.getAttribute("alt")) img.setAttribute("alt", "");
  });
  return found;
}

export function serializeBody(root: HTMLElement): string {
  // Guard: empty root returns empty string.
  if (root.childNodes.length === 0) return "";

  const s = new XMLSerializer();
  // Serialize the root element once (includes xmlns handling).
  const whole = s.serializeToString(root);

  // Strip root's opening and closing tags positionally (not regex).
  // First ">" ends root's start tag, last "</" starts root's close tag.
  const inner = whole.slice(whole.indexOf(">") + 1, whole.lastIndexOf("</"));

  // Normalize <br /> to <br/>.
  return inner.replace(/ \/>/g, "/>");
}
