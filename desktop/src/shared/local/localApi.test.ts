import { beforeEach, describe, expect, it } from "vitest";
import { LocalRouteError, handleLocalRequest } from "./localApi";
import { flushLocalStore, getLibrary, resetLocalStoreForTests } from "./localStore";
import { clearTrackRegistry, rememberTrack } from "./trackRegistry";

const track = (id: string, title = id, artists = "Artist") => ({
  id,
  title,
  artists,
  coverUrl: `https://img/${id}.jpg`,
  durationMs: 200_000,
  playCount: 0,
});

const enc = encodeURIComponent;
const call = <T = any>(method: string, path: string, body?: unknown) =>
  handleLocalRequest<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  localStorage.clear();
  resetLocalStoreForTests();
  clearTrackRegistry();
});

describe("profile", () => {
  it("returns a default local user and persists edits", async () => {
    const me = await call("GET", "/v1/me");
    expect(me).toMatchObject({ id: "local-user", username: "local" });

    const updated = await call("PATCH", "/v1/users/me", { displayName: "Codaram", username: "Codaram_1", bio: "oi" });
    expect(updated).toMatchObject({ displayName: "Codaram", username: "codaram_1", bio: "oi" });

    await flushLocalStore();
    const saved = JSON.parse(localStorage.getItem("liner_local_config")!);
    expect(saved.profile.displayName).toBe("Codaram");
  });

  it("rejects invalid usernames", async () => {
    await expect(call("PATCH", "/v1/users/me", { username: "a b" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_USERNAME",
    });
  });
});

describe("liked tracks", () => {
  it("likes with remembered metadata, lists newest first and unlikes", async () => {
    rememberTrack(track("yt:aaaaaaaaaaa", "Song A"));
    rememberTrack(track("yt:bbbbbbbbbbb", "Song B"));

    await call("PUT", `/v1/me/library/tracks/${enc("yt:aaaaaaaaaaa")}`);
    await new Promise((r) => setTimeout(r, 5));
    await call("PUT", `/v1/me/library/tracks/${enc("yt:bbbbbbbbbbb")}`);
    await call("PUT", `/v1/me/library/tracks/${enc("yt:bbbbbbbbbbb")}`); // idempotent

    const res = await call("GET", "/v1/me/library/tracks?limit=100");
    expect(res.items.map((i: any) => i.track.title)).toEqual(["Song B", "Song A"]);
    expect(res.items[0].track.cover.url).toBe("https://img/yt:bbbbbbbbbbb.jpg");
    expect(res.nextCursor).toBeNull();

    await call("DELETE", `/v1/me/library/tracks/${enc("yt:aaaaaaaaaaa")}`);
    const after = await call("GET", "/v1/me/library/tracks");
    expect(after.items).toHaveLength(1);
    expect(getLibrary().tracks["yt:aaaaaaaaaaa"]).toBeUndefined(); // pruned, nothing references it
  });

  it("pages with a cursor", async () => {
    for (let i = 0; i < 3; i++) {
      rememberTrack(track(`dz:${i}`));
      await call("PUT", `/v1/me/library/tracks/dz%3A${i}`);
    }
    const first = await call("GET", "/v1/me/library/tracks?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = await call("GET", `/v1/me/library/tracks?limit=2&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe("playlists", () => {
  it("creates, fills, reorders, removes and deletes", async () => {
    rememberTrack(track("yt:aaaaaaaaaaa", "A"));
    rememberTrack(track("yt:bbbbbbbbbbb", "B"));
    rememberTrack(track("yt:ccccccccccc", "C"));

    const created = await call("POST", "/v1/me/playlists", { title: "  Mix  " });
    expect(created).toMatchObject({ title: "Mix", revision: 1 });

    const a = await call("POST", `/v1/me/playlists/${created.id}/tracks/${enc("yt:aaaaaaaaaaa")}`);
    await call("POST", `/v1/me/playlists/${created.id}/tracks/${enc("yt:bbbbbbbbbbb")}`);
    const c = await call("POST", `/v1/me/playlists/${created.id}/tracks/${enc("yt:ccccccccccc")}`);
    expect(a).toMatchObject({ position: 0, track: { title: "A" } });

    // move C before A
    const moved = await call("POST", `/v1/me/playlists/${created.id}/items/${c.id}/move`, { beforeItemId: a.id, revision: 4 });
    expect(moved.items.map((i: any) => i.track.title)).toEqual(["C", "A", "B"]);

    await call("DELETE", `/v1/me/playlists/${created.id}/items/${a.id}`);
    const detail = await call("GET", `/v1/me/playlists/${created.id}`);
    expect(detail.items.map((i: any) => i.track.title)).toEqual(["C", "B"]);
    expect(detail.playlist.revision).toBeGreaterThan(created.revision);

    const renamed = await call("PATCH", `/v1/me/playlists/${created.id}`, { title: "Renamed" });
    expect(renamed.title).toBe("Renamed");

    await call("DELETE", `/v1/me/playlists/${created.id}`);
    expect((await call("GET", "/v1/me/playlists")).items).toEqual([]);
    expect(Object.keys(getLibrary().tracks)).toEqual([]);
  });

  it("404s for unknown playlists and refuses empty titles", async () => {
    await expect(call("GET", "/v1/me/playlists/nope")).rejects.toMatchObject({ status: 404 });
    await expect(call("POST", "/v1/me/playlists", { title: "  " })).rejects.toMatchObject({ status: 400 });
  });
});

describe("history", () => {
  it("records real listens only and keeps the latest report per session", async () => {
    rememberTrack(track("yt:aaaaaaaaaaa", "A"));
    const base = {
      playbackSessionId: "s1",
      listeningSessionId: "l1",
      trackId: "yt:aaaaaaaaaaa",
      completionRate: 0.5,
    };
    await call("POST", "/v1/me/playback/events", { ...base, playedDurationMs: 2_000 }); // skipped too early
    await call("POST", "/v1/me/playback/events", { ...base, playedDurationMs: 30_000 });
    await call("POST", "/v1/me/playback/events", { ...base, playedDurationMs: 60_000, completed: true });

    const history = await call("GET", "/v1/me/history");
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ playedDurationMs: 60_000, completed: true, track: { title: "A" } });
  });
});

describe("offline answers", () => {
  it("returns empty results for catalog endpoints instead of failing", async () => {
    expect(await call("GET", "/v1/search?q=x&type=all")).toEqual({ items: [] });
    expect(await call("GET", "/v1/explore/popular?window=7d")).toMatchObject({ items: [] });
    expect(await call("GET", "/v1/me/recommendations/daily-mixes")).toMatchObject({ items: [] });
    expect(await call("GET", "/v1/leaderboards/global")).toMatchObject({ entries: [] });
  });

  it("throws LocalRouteError for things that need the server", async () => {
    await expect(call("POST", "/v1/tracks/abc/playback", {})).rejects.toBeInstanceOf(LocalRouteError);
    await expect(call("POST", "/v1/me/playlist-imports", {})).rejects.toMatchObject({ status: 501 });
  });
});
