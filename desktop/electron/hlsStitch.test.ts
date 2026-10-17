// @vitest-environment node
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePlaylist, startHlsProxy, type HlsProxy } from "./hlsStitch";

describe("parsePlaylist", () => {
  it("resolves relative segments and the fmp4 init map", () => {
    const text = ["#EXTM3U", "#EXT-X-VERSION:6", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10.0,", "seg0.m4s", "#EXTINF:10.0,", "https://cdn.example/seg1.m4s", "#EXT-X-ENDLIST"].join("\n");
    expect(parsePlaylist(text, "https://host.example/a/b/playlist.m3u8")).toEqual({
      init: "https://host.example/a/b/init.mp4",
      segments: ["https://host.example/a/b/seg0.m4s", "https://cdn.example/seg1.m4s"],
    });
  });

  it("rejects master playlists, encryption, empty playlists and non playlists", () => {
    const base = "https://h/p.m3u8";
    expect(() => parsePlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8", base)).toThrow(/master/);
    expect(() => parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\nseg.ts', base)).toThrow(/encrypted/);
    expect(() => parsePlaylist("#EXTM3U\n#EXT-X-ENDLIST", base)).toThrow(/no segments/);
    expect(() => parsePlaylist("<html>", base)).toThrow(/not an m3u8/);
    expect(parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nseg.ts", base).segments).toHaveLength(1);
  });
});

describe("hls proxy", () => {
  let origin: http.Server;
  let base: string;
  let proxy: HlsProxy;
  const seg = (n: number) => Buffer.alloc(1000 + n, n + 1);
  let failSegment = -1;

  beforeEach(async () => {
    failSegment = -1;
    origin = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      if (req.headers.authorization !== "Bearer t") return res.writeHead(401).end();
      if (url.pathname === "/p.m3u8") {
        return res.writeHead(200).end(["#EXTM3U", "#EXTINF:5,", "s0.mp3", "#EXTINF:5,", "s1.mp3", "#EXTINF:5,", "s2.mp3", "#EXT-X-ENDLIST"].join("\n"));
      }
      const n = Number(/s(\d)\.mp3/.exec(url.pathname)?.[1]);
      if (n === failSegment) return res.writeHead(500).end();
      res.writeHead(200).end(seg(n));
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    proxy = await startHlsProxy();
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise((r) => origin.close(r));
  });

  it("plays the playlist back as one continuous file with the upstream headers", async () => {
    const url = proxy.urlFor({ playlistUrl: `${base}/p.m3u8`, mimeType: "audio/mpeg", headers: { authorization: "Bearer t" } });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.concat([seg(0), seg(1), seg(2)]))).toBe(true);
  });

  it("answers an error status when the playlist or the first segment is dead, and 404 for strangers", async () => {
    const noAuth = proxy.urlFor({ playlistUrl: `${base}/p.m3u8`, mimeType: "audio/mpeg" });
    expect((await fetch(noAuth)).status).toBe(502);

    failSegment = 0;
    const dead = proxy.urlFor({ playlistUrl: `${base}/p.m3u8`, mimeType: "audio/mpeg", headers: { authorization: "Bearer t" } });
    expect((await fetch(dead)).status).toBe(502);

    expect((await fetch(dead.replace(/k=[^&]+/, "k=nope"))).status).toBe(404);
    expect((await fetch(dead.replace(/\/hls\/[^?]+/, "/hls/0000000000000000"))).status).toBe(404);
  });

  it("cuts the connection when a later segment fails so the player does not treat a truncated file as complete", async () => {
    failSegment = 2;
    const url = proxy.urlFor({ playlistUrl: `${base}/p.m3u8`, mimeType: "audio/mpeg", headers: { authorization: "Bearer t" } });
    await expect(fetch(url).then((r) => r.arrayBuffer())).rejects.toThrow();
  });
});
