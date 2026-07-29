import { requestUrl } from "obsidian";
import type { HttpFn } from "./booxdrop";

// Obsidian's fetch-alike (bypasses CORS) satisfying booxdrop.ts's HttpFn.
// Lives in its own module — not main.ts — so settings.ts can import it
// without creating a main.ts <-> settings.ts import cycle.
export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  // res.text is a getter that can throw on a binary or empty body; the status
  // alone is still a usable result, so never let that sink the request.
  let text: string | undefined;
  try {
    text = res.text;
  } catch {
    text = undefined;
  }
  return { status: res.status, text };
};
