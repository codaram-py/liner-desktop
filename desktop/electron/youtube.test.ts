import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeFormat = (mime: string, url = "https://rr1.googlevideo.com/videoplayback?x=1") => ({
  mime_type: mime,
  bitrate: 130000,
  decipher: vi.fn(async () => url),
});

const state = {
  clients: [] as string[],
  infoByClient: {} as Record<string, any>,
};

const fakeYt = {
  session: { player: {} },
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

vi.mock("youtubei.js", () => ({ Innertube: { create: vi.fn(async () => fakeYt) } }));

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
  it("falls through clients until one yields an audio url", async () => {
    state.infoByClient.ANDROID_VR = new Error("LOGIN_REQUIRED");
    state.infoByClient.IOS = { playability_status: { status: "UNPLAYABLE", reason: "blocked" } };
    state.infoByClient.TV = {
      playability_status: { status: "OK" },
      streaming_data: { expires: new Date("2030-01-01T00:00:00Z") },
      chooseFormat: vi.fn(() => fakeFormat('audio/mp4; codecs="mp4a.40.2"')),
    };

    const stream = await getYoutubeStream("fallbackvid");
    expect(state.clients).toEqual(["ANDROID_VR", "IOS", "TV"]);
    expect(stream).toMatchObject({
      url: "https://rr1.googlevideo.com/videoplayback?x=1",
      mimeType: "audio/mp4",
      codec: "aac",
      bitrate: 130000,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("prefers mp4 but accepts webm/opus when mp4 is missing, and caches the result", async () => {
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
    expect(second).toBe(first);
    expect(state.clients).toEqual(["ANDROID_VR"]);
  });

  it("throws the last error when no client works", async () => {
    for (const c of ["ANDROID_VR", "IOS", "TV", "WEB"]) state.infoByClient[c] = new Error(`${c} failed`);
    await expect(getYoutubeStream("deadvideo01")).rejects.toThrow("WEB failed");
  });
});
