// Link and image retargeting: internal links become sibling-chapter hrefs,
// vault/`app://` image sources become numbered ../images/img_NNN hrefs.
// Chapter-relative only — resolving a linkpath or an image path against the
// vault is the caller's job (render-adapter.ts), which keeps this module pure
// and independently testable.
//
// Part of the pure rendering library (see render.ts for the module map and
// the zero-"obsidian"-import constraint).
import { replaceWithPlainTextSpan } from "./render-dom";

export function rewriteLinks(
  root: HTMLElement,
  hrefByPath: Map<string, string>,
  resolve: (linkpath: string) => string | null
): void {
  root.querySelectorAll("a").forEach((anchor) => {
    const dataHref = anchor.getAttribute("data-href");
    const isInternalLink = anchor.classList.contains("internal-link") || dataHref !== null;
    if (!isInternalLink) return; // external link: leave untouched

    const targetPath = dataHref ? resolve(dataHref) : null;
    const chapterHref = targetPath ? hrefByPath.get(targetPath) : undefined;
    if (!chapterHref) {
      replaceWithPlainTextSpan(anchor);
      return;
    }

    // Chapters live side by side in text/, so link by filename only.
    anchor.setAttribute("href", chapterHref.replace(/^text\//, ""));
    anchor.removeAttribute("data-href");
    anchor.removeAttribute("class");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
  });
}

// The vault path an <img> src refers to, or null when the src is malformed
// (a warning is emitted in that case). `scheme` is the src's parsed scheme,
// or undefined for a relative/vault-absolute path. Left UNRESOLVED against the
// vault — the caller resolves it against the source note (this module stays
// pure, zero obsidian imports).
function vaultPathFromSrc(
  src: string,
  scheme: string | undefined,
  basePath: string,
  warn?: (message: string) => void
): string | null {
  const pathWithoutQueryOrFragment = src.split(/[?#]/)[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathWithoutQueryOrFragment);
  } catch {
    // Malformed URI (e.g., literal % in filename): skip this image, but
    // say so — the src stays as it was, which no reader can open.
    warn?.(`malformed image reference skipped: ${src}`);
    return null;
  }

  if (scheme !== "app") {
    // Relative or vault-absolute markdown image path (not app://-resolved).
    return decodedPath;
  }

  // 008-mobile-support — INVARIANT: the empty check is NOT redundant with
  // `basePathIndex === -1`. `"anything".indexOf("")` returns 0, not -1, so an
  // empty basePath takes the "found at position 0" branch, slices off nothing,
  // and hands the caller the entire `app://…` URL as a vault path — the
  // exact failure the fallback below was written to prevent. An empty
  // basePath is not exotic: main.ts produces it whenever the vault adapter
  // is not a FileSystemAdapter, which is EVERY export on Obsidian mobile.
  const basePathIndex = basePath === "" ? -1 : decodedPath.indexOf(basePath);
  if (basePathIndex === -1) {
    // Path doesn't contain the given basePath (multi-vault, symlinked
    // attachment folders, path-case differences). Fall through with just
    // the basename so the caller's fuzzy resolver (getFirstLinkpathDest)
    // gets a chance, and failing that, the missing-image warning fires —
    // every image ends up either embedded or warned, never silently
    // left as a broken app:// href.
    return decodedPath.split("/").pop() ?? decodedPath;
  }
  return decodedPath.slice(basePathIndex + basePath.length).replace(/^\//, "");
}

// An <img> src already produced by this function on an earlier pass.
// Idempotence guard: it matches only what we ourselves emit, not an arbitrary
// note-relative "../images/..." reference from a sibling folder.
const ALREADY_REWRITTEN_IMAGE_SRC = /^\.\.\/images\/img_\d+\.[a-z0-9]+$/i;

// What to do with one <img> src. The parsed scheme travels with the decision
// so the caller doesn't have to parse the src a second time.
type ImageSrcDecision = { action: "leave" } | { action: "rewrite"; scheme: string | undefined };

function decideImageSrc(src: string): ImageSrcDecision {
  // Missing/empty src: nothing to resolve, nothing to warn about.
  if (src === "") return { action: "leave" };
  // Protocol-relative (scheme-less): leave completely untouched.
  if (/^\/\//.test(src)) return { action: "leave" };
  // Any other scheme (http:, https:, data:, blob:, file:, mailto:, ...)
  // except our own "app://" internal-resource scheme: leave untouched.
  // Case-insensitive per RFC 3986 (scheme names are not case sensitive).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1].toLowerCase();
  if (scheme && scheme !== "app") return { action: "leave" };
  if (ALREADY_REWRITTEN_IMAGE_SRC.test(src)) return { action: "leave" };
  return { action: "rewrite", scheme };
}

// Every image asset in a book lives at images/img_NNN.<ext>; the shared
// numbering keeps two chapters' images, and rasterized diagrams, from
// colliding with each other.
export function numberedImageHref(imageNumber: number, extension: string): string {
  return `../images/img_${String(imageNumber).padStart(3, "0")}.${extension}`;
}

export function rewriteImages(
  root: HTMLElement,
  basePath: string,
  startIndex = 0,
  warn?: (message: string) => void
): { vaultPath: string; newHref: string }[] {
  const found: { vaultPath: string; newHref: string }[] = [];

  root.querySelectorAll("img").forEach((image) => {
    const src = image.getAttribute("src") ?? "";
    const decision = decideImageSrc(src);
    if (decision.action === "leave") return;

    const vaultPath = vaultPathFromSrc(src, decision.scheme, basePath, warn);
    if (vaultPath === null) return;

    const extension = /\.(\w+)$/.exec(vaultPath)?.[1].toLowerCase() ?? "png";
    // startIndex offsets numbering so images from different chapters in the
    // same export never collide (each call only sees one chapter's <img>s).
    const newHref = numberedImageHref(startIndex + found.length + 1, extension);
    found.push({ vaultPath, newHref });
    image.setAttribute("src", newHref);
    if (!image.getAttribute("alt")) image.setAttribute("alt", "");
  });

  return found;
}
