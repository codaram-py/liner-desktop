import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExternalLink, resolveExternalPlayback, searchDeezer } from "./providers";

const ytDto = (id: string, title: string, artists: string, seconds: number) => ({
  id,
  title,
  artists,
  coverUrl: "",
  durationMs: seconds * 1000,
});

const bridge = {
  youtubeSearch: vi.fn(),
  youtubeStream: vi.fn(),
  youtubeResolve: vi.fn(),
  soundcloudStream: vi.fn(),
  soundcloudResolve: vi.fn(),
};

beforeEach(() => {
  Object.values(bridge).forEach((fn) => fn.mockReset());
  bridge.youtubeStream.mockImplementation(async (id: string) => ({
    url: `http://127.0.0.1:1/yt/${id}`,
    mimeType: "audio/mp4",
    codec: "aac",
    bitrate: 130000,
  }));
  (window as any).linerElectron = bridge;
});

afterEach(() => {
  delete (window as any).linerElectron;
  vi.unstubAllGlobals();
});

const track = (id: string, over = {}) => ({ id, title: "Rabetão", artists: "MC Lan", durationMs: 192_000, ...over });

describe("resolveExternalPlayback", () => {
  it("returns null for liner catalog ids", async () => {
    expect(await resolveExternalPlayback(track("abc123"))).toBeNull();
  });

  it("plays a deezer / apple music row in full from the best youtube match", async () => {
    bridge.youtubeSearch.mockResolvedValue([
      ytDto("liveliveliv", "Rabetão (Ao Vivo)", "MC Lan", 192),
      ytDto("RymhzC238YI", "MC Lan - Rabetão", "KondZilla", 191),
    ]);

    const session = await resolveExternalPlayback(track("dz:123"));
    expect(session?.streamUrl).toBe("http://127.0.0.1:1/yt/RymhzC238YI");
    expect(bridge.youtubeSearch).toHaveBeenCalledWith("MC Lan Rabetão", 15);

    // the match is remembered for the session
    await resolveExternalPlayback(track("dz:123"));
    expect(bridge.youtubeSearch).toHaveBeenCalledTimes(1);

    const apple = await resolveExternalPlayback(track("am:55"));
    expect(apple?.streamUrl).toBe("http://127.0.0.1:1/yt/RymhzC238YI");
  });

  it("plays the official 30s clip for preview ids without touching youtube", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ preview: "https://cdn.deezer/clip.mp3" })));
    const session = await resolveExternalPlayback(track("dzp:123"));
    expect(session).toMatchObject({ streamUrl: "https://cdn.deezer/clip.mp3", mimeType: "audio/mpeg" });
    expect(bridge.youtubeSearch).not.toHaveBeenCalled();
  });

  it("falls back to the clip when youtube has no close match", async () => {
    bridge.youtubeSearch.mockResolvedValue([ytDto("zzzzzzzzzzz", "Totally Different", "Nobody", 400)]);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{ previewUrl: "https://apple/clip.m4a" }] })));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const session = await resolveExternalPlayback(track("am:77"));
    expect(session).toMatchObject({ streamUrl: "https://apple/clip.m4a", mimeType: "audio/mp4" });
  });

  it("streams soundcloud tracks through the main process", async () => {
    bridge.soundcloudStream.mockResolvedValue({ url: "https://cf-media.sndcdn.com/a.mp3", mimeType: "audio/mpeg", codec: "aac", bitrate: 128000 });
    const session = await resolveExternalPlayback(track("sc:42"));
    expect(bridge.soundcloudStream).toHaveBeenCalledWith("42");
    expect(session?.streamUrl).toBe("https://cf-media.sndcdn.com/a.mp3");
  });
});

describe("searchDeezer", () => {
  it("returns a full row and a preview row per hit", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 1, title: "Song", title_short: "Song", duration: 200, preview: "https://p", artist: { name: "A" }, album: { cover_medium: "https://c" } },
              { id: 2, title: "No preview", duration: 100, artist: { name: "B" } },
            ],
          }),
        ),
    );
    const rows = await searchDeezer("song");
    expect(rows.map((r) => [r.id, !!r.previewOnly])).toEqual([
      ["dz:1", false],
      ["dzp:1", true],
    ]);
  });
});

describe("resolveExternalLink", () => {
  it("opens soundcloud links and keeps playlists together", async () => {
    bridge.soundcloudResolve.mockResolvedValue({
      kind: "playlist",
      title: "My set",
      tracks: [
        { id: "1", title: "One", artists: "A", coverUrl: "", durationMs: 1000, previewOnly: false },
        { id: "2", title: "Two", artists: "A", coverUrl: "", durationMs: 1000, previewOnly: true },
      ],
    });
    const res = await resolveExternalLink("https://soundcloud.com/a/sets/my-set");
    expect(res?.playlistTitle).toBe("My set");
    expect(res?.tracks.map((t) => [t.id, t.source, !!t.previewOnly])).toEqual([
      ["sc:1", "soundcloud", false],
      ["sc:2", "soundcloud", true],
    ]);
    expect(new Set(res?.tracks.map((t) => t.collection)).size).toBe(1);
  });

  it("returns null for plain text", async () => {
    expect(await resolveExternalLink("daft punk")).toBeNull();
  });
});
