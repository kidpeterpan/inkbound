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
  basePath: string
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("app://")) return; // remote or already-rewritten images pass through
    const noQuery = src.split("?")[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(noQuery);
    } catch {
      // Malformed URI (e.g., literal % in filename): skip this image.
      return;
    }
    const at = decoded.indexOf(basePath);
    if (at === -1) return;
    const vaultPath = decoded.slice(at + basePath.length).replace(/^\//, "");
    const extMatch = /\.(\w+)$/.exec(vaultPath);
    const ext = extMatch ? extMatch[1].toLowerCase() : "png";
    const newHref = `../images/img_${String(found.length + 1).padStart(3, "0")}.${ext}`;
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
