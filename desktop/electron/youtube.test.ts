// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeFormat = (mime: string, url = "https://rr1.googlevideo.com/videoplayback?x=1") => ({
  mime_type: mime,
  bitrate: 130000,
  content_length: 400,
  decipher: vi.fn(async () => url),
});

const state = {
  clients: [] as string[],
  infoByClient: {} as Record<string, any>,
};

const fakeYt = {
  session: { player: {}, on: vi.fn() },
  search: vi.fn(async () => ({
    results: [
      {
        type: "Video",
        video_id: "dQw4w9WgXcQ",
        title: { text: "Rick Astley - Never Gonna Give You Up" },
        author: { name: "Rick Astley - Topic" },
        duration: { seconds: 213 },
        thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=abc" }],
      },
      { type: "Video", video_id: "liveliveliv", title: { text: "radio 24/7" }, is_live: true, duration: { seconds: 0 } },
      { type: "Channel", id: "UC123" },
    ],
  })),
  getBasicInfo: vi.fn(async (id: string) => ({
    basic_info: { title: "Song", author: "Artist", duration: 120, is_live: false, thumbnail: [{ url: `https://t/${id}.jpg` }] },
  })),
  getPlaylist: vi.fn(async () => ({
    info: { title: "My list" },
    items: [
      { id: "aaaaaaaaaaa", title: { text: "One" }, author: { name: "A" }, duration: { seconds: 60 } },
      { id: "bbbbbbbbbbb", title: { text: "Deleted video" }, author: { name: "B" }, duration: { seconds: 0 } },
    ],
  })),
  getInfo: vi.fn(async (_id: string, opts: { client: string }) => {
    state.clients.push(opts.client);
    const info = state.infoByClient[opts.client];
    if (info instanceof Error) throw info;
    return info;
  }),
};

vi.mock("youtubei.js", () => ({
  Innertube: { create: vi.fn(async () => fakeYt) },
  Log: { setLevel: vi.fn(), Level: { ERROR: 1 } },
  Constants: {
    CLIENTS: { IOS: { USER_AGENT: "ios-ua" }, ANDROID_VR: { USER_AGENT: "vr-ua" }, TV_SIMPLY: { USER_AGENT: "tvs-ua" }, WEB: {} },
    STREAM_HEADERS: { origin: "https://www.youtube.com" },
  },
}));

// googlevideo is faked, loopback (the proxy) goes through the real fetch
const realFetch = globalThis.fetch;
const googlevideo = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", (input: any, init?: RequestInit) => {
  const url = String(input);
  return url.startsWith("https://rr1.googlevideo.com") ? googlevideo(url, init) : realFetch(input, init);
});

import { getYoutubeStream, resolveYoutubeInput, searchYoutube } from "./youtube";

beforeEach(() => {
  state.clients = [];
  state.infoByClient = {};
});

describe("searchYoutube", () => {
  it("keeps playable videos only and maps fields", async () => {
    const res = await searchYoutube("rick");
    expect(res).toEqual([
      {
        id: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up",
        artists: "Rick Astley",
        coverUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg",
        durationMs: 213000,
      },
    ]);
  });
});

describe("resolveYoutubeInput", () => {
  it("resolves a video url", async () => {
    const res = await resolveYoutubeInput("https://youtu.be/dQw4w9WgXcQ");
    expect(res.kind).toBe("video");
    expect(res.tracks[0]).toMatchObject({ id: "dQw4w9WgXcQ", title: "Song", artists: "Artist", durationMs: 120000 });
  });

  it("resolves a playlist and drops unplayable items", async () => {
    const res = await resolveYoutubeInput("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
    expect(res).toMatchObject({ kind: "playlist", title: "My list" });
    expect(res.tracks.map((t) => t.id)).toEqual(["aaaaaaaaaaa"]);
  });

  it("returns none for plain text", async () => {
    expect(await resolveYoutubeInput("daft punk")).toEqual({ kind: "none", tracks: [] });
  });
});

describe("getYoutubeStream", () => {
  const BYTES = Buffer.from(Array.from({ length: 400 }, (_, n) => n % 200));
  const slice = (url: string) => {
    const [a, b] = new URL(url).searchParams.get("range")!.split("-").map(Number);
    return new Response(BYTES.subarray(a, b! + 1), { status: 200, headers: { "content-type": "audio/mp4" } });
  };

  beforeEach(() => {
    googlevideo.mockReset();
    googlevideo.mockImplementation(async (url) => slice(url));
  });

  it("skips a client whose urls 403 on the probe and plays through the local proxy", async () => {
    // the failure from the field: ios hands out a url that looks fine and answers 403
    state.infoByClient.ANDROID_VR = {
      playability_status: { status: "OK" },
      chooseFormat: vi.fn(() => fakeFormat('audio/mp4; codecs="mp4a.40.2"', "https://rr1.googlevideo.com/videoplayback?c=VR")),
    };
    state.infoByClient.TV_SIMPLY = {
      playability_status: { status: "OK" },
      streaming_data: { expires: new Date("2030-01-01T00:00:00Z") },
      chooseFormat: vi.fn(() => fakeFormat('audio/mp4; codecs="mp4a.40.2"', "https://rr1.googlevideo.com/videoplayback?c=TVS")),
    };
    googlevideo.mockImplementation(async (url) => (url.includes("c=VR") ? new Response("forbidden", { status: 403 }) : slice(url)));

    const stream = await getYoutubeStream("fallbackvid");

    expect(state.clients).toEqual(["ANDROID_VR", "TV_SIMPLY"]);
    expect(googlevideo.mock.calls[0]![0]).toContain("range=0-1");
    expect((googlevideo.mock.calls[0]![1]!.headers as Record<string, string>)["user-agent"]).toBe("vr-ua");
    expect(stream).toMatchObject({
      mimeType: "audio/mp4",
      codec: "aac",
      bitrate: 130000,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(stream.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/yt\/fallbackvid\?k=/);

    // the whole file was fetched with the tv_simply identity while resolving
    const last = googlevideo.mock.calls.at(-1)!;
    expect(last[0]).toContain("c=TVS");
    expect(last[0]).toContain("range=0-399");
    expect((last[1]!.headers as Record<string, string>)["user-agent"]).toBe("tvs-ua");

    // what the <audio> element does: a ranged GET against the proxy url, answered from memory (no new googlevideo call)
    const before = googlevideo.mock.calls.length;
    const res = await realFetch(stream.url, { headers: { range: "bytes=10-59" } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES.subarray(10, 60))).toBe(true);
    expect(googlevideo.mock.calls.length).toBe(before);
  });

  it("moves to the next client when a url passes the probe but 403s on the real download", async () => {
    state.infoByClient.ANDROID_VR = {
      playability_status: { status: "OK" },
      chooseFormat: vi.fn(() => fakeFormat('audio/mp4; codecs="mp4a.40.2"', "https://rr1.googlevideo.com/videoplayback?c=VR")),
    };
    state.infoByClient.TV_SIMPLY = {
      playability_status: { status: "OK" },
      chooseFormat: vi.fn(() => fakeFormat('audio/mp4; codecs="mp4a.40.2"', "https://rr1.googlevideo.com/videoplayback?c=TVS")),
    };
    googlevideo.mockImplementation(async (url) => {
      const [a, b] = new URL(url).searchParams.get("range")!.split("-").map(Number);
      return url.includes("c=VR") && b! - a! > 1 ? new Response("forbidden", { status: 403 }) : slice(url);
    });
    await getYoutubeStream("probeokvid1");
    expect(state.clients).toEqual(["ANDROID_VR", "TV_SIMPLY"]);
  });

  it("prefers mp4 but accepts webm/opus when mp4 is missing, and reuses the resolved stream", async () => {
    const chooseFormat = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("no mp4 format");
      })
      .mockImplementationOnce(() => fakeFormat('audio/webm; codecs="opus"'));
    state.infoByClient.ANDROID_VR = { playability_status: { status: "OK" }, chooseFormat };

    const first = await getYoutubeStream("webmvideo01");
    expect(first).toMatchObject({ mimeType: "audio/webm", codec: "opus" });

    const second = await getYoutubeStream("webmvideo01");
    expect(second.url).toBe(first.url);
    expect(state.clients).toEqual(["ANDROID_VR"]);
  });

  it("reports every client's reason when none works", async () => {
    for (const c of ["ANDROID_VR", "TV_SIMPLY", "TV_EMBEDDED", "WEB_EMBEDDED", "TV", "ANDROID", "IOS", "WEB"]) state.infoByClient[c] = new Error(`${c} failed`);
    await expect(getYoutubeStream("deadvideo01")).rejects.toThrow(/ANDROID_VR: ANDROID_VR failed.*WEB: WEB failed/);
  });
});
