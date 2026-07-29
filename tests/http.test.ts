import { describe, it, expect, afterEach } from "vitest";
import { setRequestUrlImpl, resetRequestUrlImpl, type RequestUrlParamLike } from "./fixtures/obsidian-stub";
import { obsidianHttp } from "../src/http";

afterEach(() => resetRequestUrlImpl());

describe("obsidianHttp", () => {
  it("forwards url, method, headers, body and throw:false to requestUrl", async () => {
    const seen: RequestUrlParamLike[] = [];
    setRequestUrlImpl(async (req) => {
      seen.push(req as RequestUrlParamLike);
      return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json: null };
    });
    const body = new Uint8Array([1, 2]).buffer;
    const res = await obsidianHttp({ url: "http://d/x", method: "POST", headers: { A: "b" }, body });
    expect(res.status).toBe(204);
    // Body identity: obsidianHttp must forward the exact ArrayBuffer given,
    // not drop it or wrap/copy it into a new one. `throw: false` is asserted
    // here too — src/http.ts always sends it (so a bad body still yields a
    // usable status instead of throwing), but nothing previously checked
    // that it hadn't silently flipped to `true`.
    expect(seen[0]).toMatchObject({ url: "http://d/x", method: "POST", headers: { A: "b" }, throw: false });
    expect(seen[0].body).toBe(body);
  });

  it("defaults the method to GET", async () => {
    let method: string | undefined;
    setRequestUrlImpl(async (req) => {
      method = typeof req === "string" ? undefined : req.method;
      return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json: null };
    });
    await obsidianHttp({ url: "http://d/" });
    expect(method).toBe("GET");
  });

  it("returns the response text so booxdrop can inspect the envelope", async () => {
    setRequestUrlImpl(async () => ({
      status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0),
      text: '{"successful":true}', json: null,
    }));
    expect((await obsidianHttp({ url: "http://d/" })).text).toBe('{"successful":true}');
  });

  it("survives a text getter that throws", async () => {
    setRequestUrlImpl(async () => {
      const res = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: null };
      Object.defineProperty(res, "text", {
        get() { throw new Error("binary body"); },
      });
      return res as never;
    });
    const res = await obsidianHttp({ url: "http://d/" });
    expect(res.status).toBe(200);
    expect(res.text).toBeUndefined();
  });
});
