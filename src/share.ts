// ── Share hand-off (008-mobile-support, FR-016 / FR-017) ──────────────────
//
// Hands a finished book to the device's own sharing mechanism, so a mobile user
// can open it in a reading app or send it onward without a computer.
//
// This is deliberately built as an OFFER, not a feature. Obsidian exposes no
// sharing API of its own, so the only standards-based route is the Web Share
// API, whose support in mobile WebViews varies by platform and version. FR-017
// therefore requires that where sharing is unavailable, the offer is simply
// absent and the export is still a success. Nothing in this module may turn a
// completed export into a failed one.
//
// The host is INJECTED rather than read from `navigator` inline — same
// discipline as setSvgRasterizer in render.ts and setThaiFontLoader in
// font-assets.ts — so the degradation paths are testable without simulating a
// browser that lacks an API.

export interface ShareTarget {
  fileName: string;
  bytes: Uint8Array;
  mimeType: "application/epub+zip";
}

/** The slice of `navigator` this module uses. Both members are optional. */
export interface ShareHost {
  canShare?: (data: unknown) => boolean;
  share?: (data: unknown) => Promise<void> | void;
}

function defaultShareHost(): ShareHost {
  return typeof navigator === "undefined" ? {} : (navigator as ShareHost);
}

let shareHost: ShareHost | null = null;

/** Install a share host for tests. `null` restores the real `navigator`. */
export function setShareHost(host: ShareHost | null): void {
  shareHost = host;
}

function host(): ShareHost {
  return shareHost ?? defaultShareHost();
}

function probe(target?: ShareTarget): boolean {
  const h = host();
  // BOTH are required. A host with share() but no canShare() cannot confirm it
  // handles files, and an offer that fails when tapped is worse than no offer.
  if (typeof h.share !== "function" || typeof h.canShare !== "function") return false;
  try {
    return h.canShare({ files: [fileFor(target ?? probeTarget)] });
  } catch {
    return false;
  }
}

const probeTarget: ShareTarget = {
  fileName: "probe.epub",
  bytes: new Uint8Array(0),
  mimeType: "application/epub+zip",
};

// `File` exists in every WebView but not in every test environment; falling back
// to the plain descriptor keeps capability probing honest rather than throwing.
function fileFor(target: ShareTarget): unknown {
  if (typeof File === "function") {
    return new File([target.bytes as BlobPart], target.fileName, { type: target.mimeType });
  }
  return { name: target.fileName, type: target.mimeType };
}

/** Whether this device can actually share a finished book. */
export function canShareEpub(): boolean {
  return probe();
}

/**
 * Hand the book to the device's share sheet.
 *
 * Resolves `true` if it was shared, `false` if sharing is unavailable, was
 * dismissed, or failed. NEVER throws and NEVER touches the saved file — a
 * cancelled share sheet is an ordinary outcome, not an export failure (FR-017).
 *
 * MUST be called from a user gesture (a tapped control): the Web Share API
 * requires transient user activation and rejects a share invoked from an
 * export-completion callback with no tap behind it.
 */
export async function shareEpub(target: ShareTarget): Promise<boolean> {
  if (!probe(target)) return false;
  try {
    await host().share?.({
      files: [fileFor(target)],
      title: target.fileName,
    });
    return true;
  } catch {
    // AbortError (user dismissed the sheet) is by far the most common path
    // here, and is indistinguishable from a real failure at this boundary —
    // both mean "not shared", and neither means "export failed".
    return false;
  }
}
