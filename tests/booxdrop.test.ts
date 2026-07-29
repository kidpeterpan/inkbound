import { describe, it, expect } from "vitest";
import { buildMultipart, BooxDropClient, UPLOAD_PATH } from "../src/booxdrop";

describe("buildMultipart", () => {
  it("lays out headers, binary payload, and closing boundary", () => {
    const data = new Uint8Array([1, 2, 3]);
    const bytes = buildMultipart("BB", "b.epub", data);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("--BB\r\n")).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="b.epub"');
    expect(text).toContain("Content-Type: application/epub+zip\r\n\r\n");
    expect(text.endsWith("\r\n--BB--\r\n")).toBe(true);
    expect(Array.from(bytes).join(",")).toContain("1,2,3");
  });
});

describe("BooxDropClient", () => {
  it("testConnection is true on 200 and false on network error", async () => {
    const ok = new BooxDropClient("http://boox:8085", async () => ({ status: 200 }));
    const bad = new BooxDropClient("http://boox:8085", async () => {
      throw new Error("refused");
    });
    expect(await ok.testConnection()).toBe(true);
    expect(await bad.testConnection()).toBe(false);
  });

  it("push POSTs multipart bytes to the upload path", async () => {
    const calls: { url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer }[] = [];
    const client = new BooxDropClient("http://boox:8085/", async (req) => {
      calls.push(req);
      return { status: 200 };
    });
    await client.push("x.epub", new Uint8Array([9]));
    expect(calls[0].url).toBe(`http://boox:8085${UPLOAD_PATH}`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers?.["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(new Uint8Array(calls[0].body!).length).toBeGreaterThan(50);
  });

  it("push throws with status text on non-2xx", async () => {
    const client = new BooxDropClient("http://boox:8085", async () => ({ status: 500 }));
    await expect(client.push("x.epub", new Uint8Array([9]))).rejects.toThrow(/500/);
  });

  it("targets the device's real library-upload endpoint", () => {
    expect(UPLOAD_PATH).toBe("/api/library/upload");
  });

  it("push resolves on the device's real success envelope", async () => {
    const body = '{"code":0,"data":{"name":"x.epub"},"successful":true}';
    const client = new BooxDropClient("http://boox:8085", async () => ({ status: 200, text: body }));
    await expect(client.push("x.epub", new Uint8Array([9]))).resolves.toBeUndefined();
  });

  it("push throws when a 200 body reports application-level failure", async () => {
    const client = new BooxDropClient("http://boox:8085", async () => ({
      status: 200,
      text: '{"successful":false,"message":"no space left"}',
    }));
    await expect(client.push("x.epub", new Uint8Array([9]))).rejects.toThrow(/no space left/);
  });

  it("push throws on a non-zero code even when successful is absent", async () => {
    const client = new BooxDropClient("http://boox:8085", async () => ({ status: 200, text: '{"code":7}' }));
    await expect(client.push("x.epub", new Uint8Array([9]))).rejects.toThrow(/code 7/);
  });

  it("push accepts a 2xx whose body is not JSON", async () => {
    const client = new BooxDropClient("http://boox:8085", async () => ({ status: 200, text: "OK" }));
    await expect(client.push("x.epub", new Uint8Array([9]))).resolves.toBeUndefined();
  });
});
