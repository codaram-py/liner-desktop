// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSoundcloudStream, isSoundcloudUrl, resolveSoundcloudUrl, searchSoundcloud } from "./soundcloud";

const CLIENT_ID = "a".repeat(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
let handler: (url: URL) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  handler = () => json({}, 404);
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    // the hls proxy listens on loopback, those calls are real
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    calls.push(url.pathname + url.search);
    if (url.host === "soundcloud.com") {
      return new Response('<html><script src="https://a-v2.sndcdn.com/assets/0-abc.js"></script><script src="https://a-v2.sndcdn.com/assets/1-def.js"></script></html>');
    }
    if (url.host === "a-v2.sndcdn.com") {
      return new Response(url.pathname.includes("1-def") ? `x={client_id:"${CLIENT_ID}"}` : "nothing here");
    }
    return handler(url);
  });
});

const sc = (over: Record<string, unknown> = {}) => ({
  id: 111,
  title: "Song",
  duration: 200000,
  policy: "ALLOW",
  streamable: true,
  user: { username: "Uploader" },
  artwork_url: "https://i1.sndcdn.com/artworks-x-large.jpg",
  ...over,
});

describe("searchSoundcloud", () => {
  it("scrapes the client id once and maps playable tracks, keeping GO+ snippets as previews", async () => {
    handler = (url) => {
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      return json({
        collection: [
          sc(),
          sc({ id: 222, title: "Snip", policy: "SNIP", duration: 30000, full_duration: 180000, publisher_metadata: { artist: "Real Artist" } }),
          sc({ id: 333, policy: "BLOCK" }),
          sc({ id: 444, streamable: false }),
        ],
      });
    };

    const res = await searchSoundcloud("daft punk");
    expect(res).toEqual([
      { id: "111", title: "Song", artists: "Uploader", coverUrl: "https://i1.sndcdn.com/artworks-x-t300x300.jpg", durationMs: 200000, previewOnly: false },
      { id: "222", title: "Snip", artists: "Real Artist", coverUrl: "https://i1.sndcdn.com/artworks-x-t300x300.jpg", durationMs: 180000, previewOnly: true },
    ]);

    await searchSoundcloud("again");
    expect(calls.filter((c) => c.startsWith("/?") || c === "/").length).toBeLessThanOrEqual(1);
  });

  it("refreshes the client id once when the api answers 401", async () => {
    let first = true;
    handler = () => {
      if (first) {
        first = false;
        return new Response("", { status: 401 });
      }
      return json({ collection: [sc()] });
    };
    expect(await searchSoundcloud("x")).toHaveLength(1);
  });
});

describe("resolveSoundcloudUrl", () => {
  it("recognises soundcloud links only", () => {
    expect(isSoundcloudUrl("https://soundcloud.com/artist/track")).toBe(true);
    expect(isSoundcloudUrl("on.soundcloud.com/abc")).toBe(true);
    expect(isSoundcloudUrl("https://youtube.com/watch?v=x")).toBe(false);
    expect(isSoundcloudUrl("daft punk")).toBe(false);
  });

  it("resolves a track link", async () => {
    handler = (url) => (url.pathname === "/resolve" ? json({ kind: "track", ...sc() }) : json({}, 404));
    const res = await resolveSoundcloudUrl("https://soundcloud.com/artist/track");
    expect(res.kind).toBe("track");
    expect(res.tracks[0]).toMatchObject({ id: "111", title: "Song" });
  });

  it("fills playlist stubs in a second request", async () => {
    handler = (url) => {
      if (url.pathname === "/resolve") return json({ kind: "playlist", title: "My set", tracks: [sc({ id: 1, title: "Full" }), { id: 2 }, { id: 3 }] });
      if (url.pathname === "/tracks") {
        expect(url.searchParams.get("ids")).toBe("2,3");
        return json([sc({ id: 2, title: "Two" }), sc({ id: 3, title: "Three", policy: "BLOCK" })]);
      }
      return json({}, 404);
    };
    const res = await resolveSoundcloudUrl("https://soundcloud.com/artist/sets/my-set");
    expect(res).toMatchObject({ kind: "playlist", title: "My set" });
    expect(res.tracks.map((t) => t.title)).toEqual(["Full", "Two"]);
  });
});

describe("getSoundcloudStream", () => {
  const trackWith = (transcodings: unknown[]) =>
    sc({ id: 555, track_authorization: "auth123", media: { transcodings } });

  it("uses the progressive transcoding and probes the signed url", async () => {
    handler = (url) => {
      if (url.pathname === "/tracks/555") {
        return json(trackWith([
          { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:555/hls", format: { protocol: "hls", mime_type: "audio/ogg; codecs=opus" } },
          { url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:555/stream/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" } },
        ]));
      }
      if (url.pathname.endsWith("/stream/progressive")) {
        expect(url.searchParams.get("track_authorization")).toBe("auth123");
        return json({ url: "https://cf-media.sndcdn.com/abc.mp3?sig=1" });
      }
      if (url.host === "cf-media.sndcdn.com") return new Response("ab", { status: 206 });
      return json({}, 404);
    };

    expect(await getSoundcloudStream("555")).toMatchObject({ url: "https://cf-media.sndcdn.com/abc.mp3?sig=1", mimeType: "audio/mpeg" });
  });

  it("falls back to an hls transcoding through the stitching proxy when there is no progressive one", async () => {
    handler = (url) => {
      if (url.pathname === "/tracks/555") {
        return json(trackWith([
          { url: "https://api-v2.soundcloud.com/media/555/hls-opus", format: { protocol: "hls", mime_type: 'audio/ogg; codecs="opus"' } },
          { url: "https://api-v2.soundcloud.com/media/555/hls-mp3", format: { protocol: "hls", mime_type: "audio/mpeg" } },
        ]));
      }
      if (url.pathname.endsWith("/hls-mp3")) return json({ url: "https://playback.example/pl.m3u8?sig=1" });
      if (url.pathname === "/pl.m3u8") return new Response("#EXTM3U\n#EXTINF:5,\nhttps://playback.example/s0.mp3\n#EXTINF:5,\nhttps://playback.example/s1.mp3\n#EXT-X-ENDLIST");
      if (url.pathname === "/s0.mp3") return new Response(Buffer.from("AAAA"));
      if (url.pathname === "/s1.mp3") return new Response(Buffer.from("BBBB"));
      return json({}, 404);
    };

    const stream = await getSoundcloudStream("555");
    expect(stream.mimeType).toBe("audio/mpeg");
    expect(stream.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hls\//);
    expect(await (await fetch(stream.url)).text()).toBe("AAAABBBB");
  });

  it("tries the next transcoding when one is unusable and reports every reason when none works", async () => {
    handler = (url) => {
      if (url.pathname === "/tracks/555") {
        return json(trackWith([
          { url: "https://api-v2.soundcloud.com/media/555/progressive", format: { protocol: "progressive", mime_type: "audio/mpeg" } },
          { url: "https://api-v2.soundcloud.com/media/555/hls-mp3", format: { protocol: "hls", mime_type: "audio/mpeg" } },
        ]));
      }
      if (url.pathname.endsWith("/progressive")) return json({}, 500);
      if (url.pathname.endsWith("/hls-mp3")) return json({ url: "https://playback.example/pl.m3u8" });
      return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8");
    };
    await expect(getSoundcloudStream("555")).rejects.toThrow(/progressive\/audio\/mpeg: .*responded 500.*hls\/audio\/mpeg: .*master playlists/);
  });

  it("explains when there is nothing to play and rejects bad ids", async () => {
    handler = (url) => (url.pathname === "/tracks/555" ? json(trackWith([])) : json({}, 404));
    await expect(getSoundcloudStream("555")).rejects.toThrow(/no playable stream/);
    await expect(getSoundcloudStream("../etc")).rejects.toThrow(/invalid/);
  });
});
