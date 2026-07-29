const CHROME_SELECTORS = [
  ".edit-block-button", ".copy-code-button", ".collapse-indicator",
  ".markdown-preview-pusher", ".mod-frontmatter", ".frontmatter",
  ".metadata-container",
];

export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

export function stripDynamicBlocks(md: string): string {
  return md.replace(/```dataview(js)?\r?\n[\s\S]*?```/g, "*[dynamic content omitted]*");
}

export function cleanupDom(root: HTMLElement): void {
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
