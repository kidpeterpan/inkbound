// The ONLY module that knows BooxDrop's unofficial HTTP API.
// VERIFIED 2026-07-29 against a real Onyx Boox on firmware serving the Vue
// BOOX Drop SPA: the app's own uploadLibraryFile() posts FormData to
// /api/library/upload, field name "file". A live probe returned 200 with
// {"code":0,"successful":true,...} and the file appeared under
// /storage/emulated/0/Books/. (/api/storage/upload exists too, but drops the
// file into general storage rather than the Books library.)
// Re-probe procedure if a firmware update breaks this: fetch
// http://<device>:8085/js/app.js and grep for "upload".
export const UPLOAD_PATH = "/api/library/upload";

export type HttpFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}) => Promise<{ status: number; text?: string }>;

export function buildMultipart(boundary: string, filename: string, data: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/epub+zip\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

export class BooxDropClient {
  private base: string;

  constructor(
    baseUrl: string,
    private http: HttpFn
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await this.http({ url: this.base + "/", method: "GET", throw: false });
      return res.status >= 200 && res.status < 400;
    } catch {
      return false;
    }
  }

  async push(filename: string, data: Uint8Array): Promise<void> {
    const boundary = "----epubexport" + Math.random().toString(36).slice(2);
    const body = buildMultipart(boundary, filename, data);
    const res = await this.http({
      url: this.base + UPLOAD_PATH,
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`BooxDrop upload failed with status ${res.status}`);
    }
    // A 2xx is necessary but not sufficient: BooxDrop reports application-level
    // failures in the body as {"successful":false} / a non-zero "code".
    // A body we cannot parse is not treated as a failure — the status stands.
    if (res.text) {
      let parsed: { successful?: boolean; code?: number; message?: string } | null = null;
      try {
        const envelope: unknown = JSON.parse(res.text);
        parsed = envelope as { successful?: boolean; code?: number; message?: string };
      } catch {
        return;
      }
      if (parsed && (parsed.successful === false || (typeof parsed.code === "number" && parsed.code !== 0))) {
        throw new Error(
          `BooxDrop rejected the upload${parsed.message ? `: ${parsed.message}` : ` (code ${parsed.code})`}`
        );
      }
    }
  }
}
