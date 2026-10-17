// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSpotify, parseSpotifyUrl } from "./spotify";

const ID = "4uLU6hMCjMI75M1A2tKUQC";
const ID2 = "6rqhFgbbKwnb9MLmUQDhG6";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const spTrack = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "Never Gonna Give You Up",
  duration_ms: 213000,
  explicit: false,
  artists: [{ name: "Rick Astley" }, { name: "Guest" }],
  album: { images: [{ url: "https://i/640" }, { url: "https://i/300" }, { url: "https://i/64" }] },
  ...over,
});

let calls: { url: string; init?: RequestInit }[];
let respond: (url: URL, init?: RequestInit) => Response;
let creds: { clientId?: string; clientSecret?: string };
let clock: number;

const make = () =>
  createSpotify({
    getCredentials: () => creds,
    now: () => clock,
    fetchImpl: (async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const url = new URL(String(input));
      if (url.host === "accounts.spotify.com") return json({ access_token: `tok${calls.filter((c) => c.url.includes("accounts")).length}`, expires_in: 3600 });
      return respond(url, init);
    }) as typeof fetch,
  });

beforeEach(() => {
  calls = [];
  clock = 1_000_000;
  creds = { clientId: "cid", clientSecret: "sec" };
  respond = () => json({}, 404);
});

describe("parseSpotifyUrl", () => {
  it("reads open.spotify.com links, localized links and uris", () => {
    expect(parseSpotifyUrl(`https://open.spotify.com/track/${ID}?si=abc`)).toEqual({ kind: "track", id: ID });
    expect(parseSpotifyUrl(`https://open.spotify.com/intl-pt/album/${ID}`)).toEqual({ kind: "album", id: ID });
    expect(parseSpotifyUrl(`open.spotify.com/playlist/${ID}`)).toEqual({ kind: "playlist", id: ID });
    expect(parseSpotifyUrl(`spotify:track:${ID}`)).toEqual({ kind: "track", id: ID });
  });

  it("ignores everything else", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/artist/" + ID)).toBeNull();
    expect(parseSpotifyUrl("https://youtube.com/watch?v=abc")).toBeNull();
    expect(parseSpotifyUrl("daft punk")).toBeNull();
    expect(parseSpotifyUrl(`https://open.spotify.com/track/short`)).toBeNull();
  });
});

describe("search", () => {
  it("reports not configured without any request when credentials are missing", async () => {
    creds = {};
    expect(await make().search("daft punk")).toEqual({ configured: false, tracks: [] });
    expect(calls).toHaveLength(0);
  });

  it("gets a client credentials token once and maps tracks", async () => {
    respond = (url, init) => {
      expect(url.pathname).toBe("/v1/search");
      expect(url.searchParams.get("q")).toBe("never gonna");
      expect((init!.headers as Record<string, string>).authorization).toMatch(/^Bearer tok\d$/);
      return json({ tracks: { items: [spTrack(), spTrack({ id: "x", name: "Zero length", duration_ms: 0 })] } });
    };
    const sp = make();
    const first = await sp.search("never gonna");
    expect(first).toEqual({
      configured: true,
      tracks: [{ id: ID, title: "Never Gonna Give You Up", artists: "Rick Astley, Guest", coverUrl: "https://i/300", durationMs: 213000, explicit: false }],
    });

    await sp.search("never gonna");
    expect(calls.filter((c) => c.url.includes("accounts.spotify.com"))).toHaveLength(1);

    const tokenCall = calls[0]!;
    expect((tokenCall.init!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);

    clock += 3_600_000; // token expired
    await sp.search("never gonna");
    expect(calls.filter((c) => c.url.includes("accounts.spotify.com"))).toHaveLength(2);
  });

  it("never asks for more than 10 per page (dev mode apps reject larger limits)", async () => {
    const seen: string[] = [];
    respond = (url) => {
      const offset = Number(url.searchParams.get("offset"));
      seen.push(`${url.searchParams.get("limit")}@${offset}`);
      expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(10);
      return json({ tracks: { items: [spTrack({ id: `id${offset}` })], next: offset < 20 ? "more" : null } });
    };
    const res = await make().search("pages");
    expect(seen.slice(0, 2)).toEqual(["10@0", "10@10"]);
    expect(res.tracks.length).toBe(seen.length);
  });

  it("surfaces the error body of a failed api call", async () => {
    respond = (url) =>
      url.pathname === "/v1/search" ? json({ error: { status: 400, message: "Invalid limit" } }, 400) : json({}, 404);
    await expect(make().search("x")).rejects.toThrow(/Invalid limit/);
  });

  it("explains rejected credentials and rate limits", async () => {
    const bad = createSpotify({ getCredentials: () => creds, fetchImpl: (async () => new Response("{}", { status: 400 })) as typeof fetch });
    await expect(bad.search("x")).rejects.toThrow(/rejected the client id/);

    respond = () => json({}, 429, { "retry-after": "7" });
    await expect(make().search("x")).rejects.toThrow(/retry in 7s/);
  });
});

describe("resolve", () => {
  it("resolves a track link", async () => {
    respond = (url) => (url.pathname === `/v1/tracks/${ID}` ? json(spTrack()) : json({}, 404));
    const res = await make().resolve(`https://open.spotify.com/track/${ID}`);
    expect(res).toMatchObject({ kind: "track", configured: true });
    expect(res.tracks[0]).toMatchObject({ id: ID, title: "Never Gonna Give You Up" });
  });

  it("resolves albums using the album cover for every track", async () => {
    respond = (url) =>
      url.pathname === `/v1/albums/${ID}`
        ? json({ name: "Whenever You Need Somebody", images: [{ url: "https://a/640" }, { url: "https://a/300" }], tracks: { items: [spTrack({ album: undefined }), spTrack({ id: "t2", name: "Two", album: undefined })] } })
        : json({}, 404);
    const res = await make().resolve(`https://open.spotify.com/album/${ID}`);
    expect(res).toMatchObject({ kind: "album", title: "Whenever You Need Somebody" });
    expect(res.tracks.map((t) => [t.title, t.coverUrl])).toEqual([["Never Gonna Give You Up", "https://a/300"], ["Two", "https://a/300"]]);
  });

  it("resolves playlists and skips local files and episodes", async () => {
    respond = (url) => {
      if (url.pathname === `/v1/playlists/${ID}`) return json({ name: "My list" });
      if (url.pathname === `/v1/playlists/${ID}/tracks`) {
        return json({ items: [{ track: spTrack() }, { track: spTrack({ id: "l", is_local: true }) }, { track: spTrack({ id: "e", type: "episode" }) }, { track: null }] });
      }
      return json({}, 404);
    };
    const res = await make().resolve(`https://open.spotify.com/playlist/${ID}`);
    expect(res).toMatchObject({ kind: "playlist", title: "My list" });
    expect(res.tracks).toHaveLength(1);
  });

  it("reports unconfigured, unknown links and missing items", async () => {
    creds = {};
    expect(await make().resolve(`https://open.spotify.com/track/${ID}`)).toEqual({ configured: false, kind: "none", tracks: [] });
    creds = { clientId: "cid", clientSecret: "sec" };
    expect(await make().resolve("daft punk")).toEqual({ configured: true, kind: "none", tracks: [] });
    await expect(make().resolve(`https://open.spotify.com/playlist/${ID2}`)).rejects.toThrow(/could not find/);
  });

  it("retries once with a fresh token after a 401", async () => {
    let first = true;
    respond = () => {
      if (first) {
        first = false;
        return json({}, 401);
      }
      return json(spTrack());
    };
    const res = await make().resolve(`https://open.spotify.com/track/${ID}`);
    expect(res.tracks).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("accounts.spotify.com"))).toHaveLength(2);
  });
});

describe("embed pages (no credentials)", () => {
  const page = (entity: unknown) =>
    `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></body></html>`;

  const playlistEntity = {
    type: "playlist",
    name: "Treino",
    coverArt: { sources: [{ url: "https://i/640", width: 640 }, { url: "https://i/300", width: 300 }, { url: "https://i/64", width: 64 }] },
    trackList: [
      { uri: `spotify:track:${ID}`, title: "Song A", subtitle: "Artist One, Artist Two", duration: 200000, isExplicit: true },
      { uri: `spotify:track:${ID2}`, title: "Song B", subtitle: "Artist Three", duration: 180000 },
      { uri: "spotify:track:zzzzzzzzzzzzzzzzzzzzzz", title: "No length", subtitle: "x", duration: 0 },
    ],
  };

  it("opens playlist links without credentials", async () => {
    creds = {};
    respond = (url) => {
      expect(url.pathname).toBe(`/embed/playlist/${ID}`);
      return new Response(page(playlistEntity));
    };
    const res = await make().resolve(`https://open.spotify.com/playlist/${ID}`);
    expect(res).toMatchObject({ configured: false, kind: "playlist", title: "Treino" });
    expect(res.tracks).toEqual([
      { id: ID, title: "Song A", artists: "Artist One, Artist Two", coverUrl: "https://i/300", durationMs: 200000, explicit: true },
      { id: ID2, title: "Song B", artists: "Artist Three", coverUrl: "https://i/300", durationMs: 180000, explicit: false },
    ]);
  });

  it("opens single track links", async () => {
    creds = {};
    respond = () =>
      new Response(
        page({ type: "track", name: "Solo", artists: [{ name: "A" }, { name: "B" }], duration: 123000, visualIdentity: { image: [{ url: "https://v/300", maxWidth: 300 }] } }),
      );
    const res = await make().resolve(`https://open.spotify.com/track/${ID}`);
    expect(res).toMatchObject({ configured: false, kind: "track" });
    expect(res.tracks).toEqual([{ id: ID, title: "Solo", artists: "A, B", coverUrl: "https://v/300", durationMs: 123000, explicit: false }]);
  });

  it("returns nothing, not an error, when the page has an unknown shape or fails", async () => {
    creds = {};
    respond = () => new Response("<html>no data here</html>");
    expect(await make().resolve(`https://open.spotify.com/track/${ID}`)).toEqual({ configured: false, kind: "none", tracks: [] });

    respond = () => new Response(page({ type: "playlist", name: "Empty", trackList: [] }));
    expect(await make().resolve(`https://open.spotify.com/playlist/${ID}`)).toEqual({ configured: false, kind: "none", tracks: [] });

    respond = () => new Response("blocked", { status: 403 });
    expect(await make().resolve(`https://open.spotify.com/album/${ID}`)).toEqual({ configured: false, kind: "none", tracks: [] });
  });
});

describe("signed in user", () => {
  const session = (loggedIn = true) => ({
    status: () => ({ loggedIn }),
    getAccessToken: vi.fn(async () => (loggedIn ? "usertok" : null)),
    invalidate: vi.fn(),
  });

  const makeWith = (auth: ReturnType<typeof session>, fetchImpl: (url: URL, init?: RequestInit) => Response, credentials: Record<string, string> = {}) =>
    createSpotify({ getCredentials: () => credentials, auth, fetchImpl: (async (input: any, init?: RequestInit) => fetchImpl(new URL(String(input)), init)) as typeof fetch });

  it("searches with the user's token and no app credentials at all", async () => {
    const auth = session();
    const seen: string[] = [];
    const sp = makeWith(auth, (url, init) => {
      seen.push(`${url.host}${url.pathname} ${(init!.headers as Record<string, string>).authorization}`);
      return json({ tracks: { items: [spTrack()] } });
    });
    expect(sp.isConfigured()).toBe(true);
    expect((await sp.search("x")).configured).toBe(true);
    expect(seen).toEqual(["api.spotify.com/v1/search Bearer usertok"]);
  });

  it("prefers the user token over client credentials and falls back to them when logged out", async () => {
    const calls: string[] = [];
    const handler = (url: URL, init?: RequestInit) => {
      calls.push(url.host === "accounts.spotify.com" ? "token" : (init!.headers as Record<string, string>).authorization!);
      return url.host === "accounts.spotify.com" ? json({ access_token: "apptok", expires_in: 3600 }) : json({ tracks: { items: [] } });
    };
    await makeWith(session(true), handler, { clientId: "cid", clientSecret: "sec" }).search("x");
    expect(calls).toEqual(["Bearer usertok"]);

    calls.length = 0;
    await makeWith(session(false), handler, { clientId: "cid", clientSecret: "sec" }).search("x");
    expect(calls).toEqual(["token", "Bearer apptok"]);
  });

  it("reads the liked songs page by page and stops when there is no next page", async () => {
    const offsets: string[] = [];
    const sp = makeWith(session(), (url) => {
      expect(url.pathname).toBe("/v1/me/tracks");
      offsets.push(url.searchParams.get("offset")!);
      const first = url.searchParams.get("offset") === "0";
      return json({ items: [{ track: spTrack({ id: first ? "one" : "two", name: first ? "One" : "Two" }) }], next: first ? "more" : null });
    });
    const res = await sp.resolve("spotify:me:liked");
    expect(res).toMatchObject({ configured: true, kind: "playlist", title: "Músicas curtidas" });
    expect(res.tracks.map((t) => t.title)).toEqual(["One", "Two"]);
    expect(offsets).toEqual(["0", "50"]);
  });

  it("only treats the liked songs as available when logged in", async () => {
    const out = makeWith(session(false), () => json({}, 500));
    expect(await out.resolve("https://open.spotify.com/collection/tracks")).toEqual({ configured: false, kind: "none", tracks: [] });
  });

  it("refreshes through the session on a 401, then says to log in again on a 403", async () => {
    const auth = session();
    let first = true;
    const sp = makeWith(auth, () => {
      if (first) {
        first = false;
        return json({}, 401);
      }
      return json({ tracks: { items: [spTrack()] } });
    });
    expect((await sp.search("x")).tracks).toHaveLength(1);
    expect(auth.invalidate).toHaveBeenCalledTimes(1);

    const forbidden = makeWith(session(), () => json({}, 403));
    await expect(forbidden.search("x")).rejects.toThrow(/log in again/);
  });
});

describe("parseSpotifyUrl liked songs", () => {
  it("recognises the liked songs page and uri", () => {
    expect(parseSpotifyUrl("spotify:me:liked")).toEqual({ kind: "liked", id: "me" });
    expect(parseSpotifyUrl("https://open.spotify.com/collection/tracks")).toEqual({ kind: "liked", id: "me" });
    expect(parseSpotifyUrl("https://open.spotify.com/collection/other")).toBeNull();
  });
});
