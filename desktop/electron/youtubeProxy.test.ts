// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRange, startYoutubeProxy, withRange, type Upstream, type YoutubeProxy } from "./youtubeProxy";

const AUDIO = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
const UA = "com.google.ios.youtube/20.11.6 (test)";

describe("parseRange", () => {
  it("handles open, closed and suffix ranges and rejects bad ones", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});

describe("withRange", () => {
  it("appends to urls with and without a query", () => {
    expect(withRange("https://x/v?a=1", 0, 9, "c")).toBe("https://x/v?a=1&cpn=c&range=0-9");
    expect(withRange("https://x/v", 0, 9, "c")).toBe("https://x/v?cpn=c&range=0-9");
  });
});

describe("youtube proxy", () => {
  let upstreamServer: http.Server;
  let upstreamUrl: string;
  let seen: { ranges: string[]; ua: string[]; origin: string[]; rangeHeader: (string | undefined)[] };
  let upstreamStatus = 200;
  let proxy: YoutubeProxy;
  const invalidate = vi.fn();

  beforeEach(async () => {
    seen = { ranges: [], ua: [], origin: [], rangeHeader: [] };
    upstreamStatus = 200;
    invalidate.mockClear();

    upstreamServer = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      seen.ranges.push(url.searchParams.get("range") ?? "");
      seen.ua.push(String(req.headers["user-agent"]));
      seen.origin.push(String(req.headers.origin));
      seen.rangeHeader.push(req.headers.range);
      if (upstreamStatus !== 200 || req.headers["user-agent"] !== UA) {
        res.writeHead(upstreamStatus !== 200 ? upstreamStatus : 403).end("nope");
        return;
      }
      const [a, b] = url.searchParams.get("range")!.split("-").map(Number);
      res.writeHead(200, { "content-type": "audio/mp4" }).end(AUDIO.subarray(a, b! + 1));
    });
    await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}/videoplayback?id=abc`;

    const upstream: Upstream = {
      url: upstreamUrl,
      contentLength: AUDIO.length,
      mimeType: "audio/mp4",
      userAgent: UA,
      headers: { origin: "https://www.youtube.com", referer: "https://www.youtube.com" },
    };
    proxy = await startYoutubeProxy({ getUpstream: async () => upstream, invalidate, chunkBytes: 1000 });
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise((r) => upstreamServer.close(r));
  });

  it("serves the whole file by stitching ranged upstream chunks, with the client headers", async () => {
    const res = await fetch(proxy.urlFor("dQw4w9WgXcQ"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO)).toBe(true);

    expect(seen.ranges).toEqual(["0-999", "1000-1999", "2000-2499"]);
    expect(new Set(seen.ua)).toEqual(new Set([UA]));
    expect(new Set(seen.origin)).toEqual(new Set(["https://www.youtube.com"]));
    // the Range header never goes upstream, youtube wants the query form
    expect(seen.rangeHeader.every((h) => h === undefined)).toBe(true);
  });

  it("answers a media element seek with 206 and the exact slice across chunk boundaries", async () => {
    const res = await fetch(proxy.urlFor("dQw4w9WgXcQ"), { headers: { range: "bytes=900-2100" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 900-2100/${AUDIO.length}`);
    expect(res.headers.get("content-length")).toBe("1201");
    expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO.subarray(900, 2101))).toBe(true);
    expect(seen.ranges).toEqual(["900-1899", "1900-2100"]);
  });

  it("supports HEAD and 416 for unsatisfiable ranges", async () => {
    const head = await fetch(proxy.urlFor("dQw4w9WgXcQ"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(AUDIO.length));
    expect(seen.ranges).toEqual([]);

    const bad = await fetch(proxy.urlFor("dQw4w9WgXcQ"), { headers: { range: `bytes=${AUDIO.length}-` } });
    expect(bad.status).toBe(416);
  });

  it("passes an upstream 403 through and drops the cached upstream", async () => {
    upstreamStatus = 403;
    const res = await fetch(proxy.urlFor("dQw4w9WgXcQ"));
    expect(res.status).toBe(403);
    expect(invalidate).toHaveBeenCalledWith("dQw4w9WgXcQ");
  });

  it("rejects requests without the token or for other paths", async () => {
    const base = proxy.urlFor("dQw4w9WgXcQ");
    expect((await fetch(base.replace(/k=[^&]+/, "k=wrong"))).status).toBe(404);
    expect((await fetch(base.replace("/yt/dQw4w9WgXcQ", "/etc/passwd"))).status).toBe(404);
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
  });
});
