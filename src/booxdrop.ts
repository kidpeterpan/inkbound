// The ONLY module that knows BooxDrop's unofficial HTTP API.
// Default path is the community-documented endpoint; Task 10 verifies it
// against the real device (firmware differences land here and only here).
export const UPLOAD_PATH = "/api/std/upload";

export type HttpFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}) => Promise<{ status: number }>;

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

  constructor(baseUrl: string, private http: HttpFn) {
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
  }
}
