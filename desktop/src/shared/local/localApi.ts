import type { PlaybackHistoryItem, RecordPlaybackEventRequest } from "@/shared/contracts";
import type { Track } from "@/shared/types";
import {
  HISTORY_LIMIT,
  getConfig,
  getLibrary,
  initLocalStore,
  updateConfig,
  updateLibrary,
  type LocalLibrary,
  type LocalPlaylist,
} from "./localStore";
import { LOCAL_USER_ID } from "./mode";
import { getRememberedTrack, rememberTrack } from "./trackRegistry";

// thrown for routes the local backend cannot answer, api.ts turns it into an ApiError
export class LocalRouteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "LOCAL_MODE",
  ) {
    super(message);
    this.name = "LocalRouteError";
  }
}

const notFound = (what: string) => new LocalRouteError(404, `${what} is not available in local mode`);

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---- shapes the ui expects from the real api ----

function toApiTrack(track: Track) {
  const names = track.artists ? track.artists.split(",").map((n) => n.trim()).filter(Boolean) : [];
  const artists = (track.artistList?.length ? track.artistList : names.map((name, i) => ({ id: i === 0 ? track.artistId : "", name }))).map(
    (a) => ({ id: a.id ?? "", name: a.name }),
  );
  return {
    type: "track" as const,
    id: track.id,
    title: track.title,
    artists,
    album: track.album,
    durationMs: track.durationMs,
    explicit: track.explicit,
    cover: track.coverUrl ? { url: track.coverUrl, width: 300, height: 300 } : undefined,
    viewer: { liked: isLiked(track.id) },
  };
}

function metadataFor(library: LocalLibrary, trackId: string): Track {
  return (
    library.tracks[trackId] ??
    getRememberedTrack(trackId) ?? { id: trackId, title: trackId, artists: "", coverUrl: "", durationMs: 0, playCount: 0 }
  );
}

function isLiked(trackId: string): boolean {
  return getLibrary().liked.some((l) => l.trackId === trackId);
}

function keepMetadata(library: LocalLibrary, trackId: string) {
  const known = getRememberedTrack(trackId);
  if (known) library.tracks[trackId] = known;
  else if (!library.tracks[trackId]) library.tracks[trackId] = metadataFor(library, trackId);
}

function toUserPlaylist(p: LocalPlaylist) {
  const { profile } = getConfig();
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    isPublic: p.isPublic,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    revision: p.revision,
    ownerId: profile.id,
    owner: { id: profile.id, username: profile.username, displayName: profile.displayName, avatarUrl: profile.avatarUrl },
  };
}

function toPlaylistItems(library: LocalLibrary, p: LocalPlaylist) {
  return p.items.map((item, index) => ({
    id: item.id,
    track: toApiTrack(metadataFor(library, item.trackId)),
    position: index,
    addedAt: item.addedAt,
  }));
}

function authUser() {
  const { profile } = getConfig();
  return {
    id: profile.id,
    email: "local@liner.local",
    username: profile.username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    bio: profile.bio,
    isPublic: profile.isPublic,
    showActivity: profile.showActivity,
    showHistory: profile.showHistory,
    showLikedTracks: profile.showLikedTracks,
    participateLeaderboards: profile.participateLeaderboards,
  };
}

export function getLocalAuthUser() {
  return authUser();
}

const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

function patchProfile(patch: Record<string, unknown>) {
  if (typeof patch.username === "string" && !USERNAME_RE.test(patch.username.toLowerCase())) {
    throw new LocalRouteError(400, "Username must be 3-30 lowercase characters (a-z, 0-9, _).", "INVALID_USERNAME");
  }
  updateConfig((cfg) => {
    const p = cfg.profile;
    if (typeof patch.username === "string") p.username = patch.username.toLowerCase();
    for (const key of ["displayName", "avatarUrl", "bio"] as const) {
      if (key in patch) p[key] = typeof patch[key] === "string" ? (patch[key] as string) : null;
    }
    for (const key of ["isPublic", "showActivity", "showHistory", "showLikedTracks", "participateLeaderboards"] as const) {
      if (typeof patch[key] === "boolean") p[key] = patch[key] as boolean;
    }
  });
  return authUser();
}

// ---- paging helpers (cursor = offset) ----

function page<T>(all: T[], params: URLSearchParams, fallbackLimit: number) {
  const limit = Math.max(1, Math.min(Number(params.get("limit")) || fallbackLimit, 500));
  const start = Math.max(0, Number(params.get("cursor")) || 0);
  const items = all.slice(start, start + limit);
  const next = start + limit;
  return { items, nextCursor: next < all.length ? String(next) : null };
}

function recordPlayback(payload: RecordPlaybackEventRequest) {
  const finished = payload.completed || payload.playedDurationMs >= 10_000;
  if (!finished) return;
  updateLibrary((lib) => {
    const track = metadataFor(lib, payload.trackId);
    const entry: PlaybackHistoryItem = {
      id: payload.playbackSessionId || uuid(),
      playbackSessionId: payload.playbackSessionId,
      listeningSessionId: payload.listeningSessionId,
      track: toApiTrack(track) as unknown as PlaybackHistoryItem["track"],
      playedDurationMs: payload.playedDurationMs,
      completionRate: payload.completionRate,
      completed: !!payload.completed,
      skipped: !!payload.skipped,
      loopCount: payload.loopCount ?? 0,
      hasSeekBackward: !!payload.hasSeekBackward,
      context: payload.context,
      listenedAt: new Date().toISOString(),
    };
    // the engine can report the same session more than once, keep the latest
    lib.history = [entry, ...lib.history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_LIMIT);
  });
}

function findPlaylist(library: LocalLibrary, id: string): LocalPlaylist {
  const playlist = library.playlists.find((p) => p.id === id);
  if (!playlist) throw new LocalRouteError(404, "Playlist not found", "NOT_FOUND");
  return playlist;
}

function touch(p: LocalPlaylist) {
  p.revision += 1;
  p.updatedAt = new Date().toISOString();
}

function parseBody(init?: RequestInit): Record<string, any> {
  if (typeof init?.body !== "string" || !init.body) return {};
  try {
    return JSON.parse(init.body) as Record<string, any>;
  } catch {
    return {};
  }
}

const seg = (s: string) => decodeURIComponent(s);

// answers the user scoped endpoints from ~/Liner and returns empty results for everything that needs the catalog,
// so nothing in the app ever waits on (or trips an outage screen for) the liner servers
export async function handleLocalRequest<T>(path: string, init?: RequestInit): Promise<T> {
  await initLocalStore();
  const method = (init?.method ?? "GET").toUpperCase();
  const url = new URL(path, "http://local");
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
  const q = url.searchParams;
  const route = `${method} /${parts.join("/")}`;
  const body = parseBody(init);

  const reply = (value: unknown) => value as T;

  // profile
  if (route === "GET /v1/me") return reply(authUser());
  if (route === "PATCH /v1/users/me") return reply(patchProfile(body));
  if (method === "GET" && parts[0] === "v1" && parts[1] === "users" && parts[2] && parts[2] !== "search" && parts[2] !== "me") {
    const { profile } = getConfig();
    const id = seg(parts[2]);
    const isMe = id === profile.id || id.toLowerCase() === profile.username;
    if (parts[3] === "followers" || parts[3] === "following") return reply([]);
    if (!isMe) throw notFound("User");
    if (parts[3] === "playlists") return reply({ items: getLibrary().playlists.map(toUserPlaylist) });
    if (parts[3] === "history") return reply(page(getLibrary().history, q, 30));
    return reply({ ...authUser(), followersCount: 0, followingCount: 0, createdAt: profile.createdAt });
  }
  if (route === "GET /v1/users/search") return reply([]);

  // liked tracks
  if (route === "GET /v1/me/library/tracks") {
    const lib = getLibrary();
    const sorted = [...lib.liked].sort((a, b) => b.likedAt.localeCompare(a.likedAt));
    const { items, nextCursor } = page(sorted, q, 100);
    return reply({
      items: items.map((l) => ({ track: toApiTrack(metadataFor(lib, l.trackId)), likedAt: l.likedAt })),
      nextCursor,
    });
  }
  if (parts[1] === "me" && parts[2] === "library" && parts[3] === "tracks" && parts[4]) {
    const trackId = seg(parts[4]);
    if (method === "PUT") {
      updateLibrary((lib) => {
        if (!lib.liked.some((l) => l.trackId === trackId)) {
          lib.liked.push({ trackId, likedAt: new Date().toISOString() });
        }
        keepMetadata(lib, trackId);
      });
      return reply(undefined);
    }
    if (method === "DELETE") {
      updateLibrary((lib) => {
        lib.liked = lib.liked.filter((l) => l.trackId !== trackId);
      });
      return reply(undefined);
    }
  }

  // saved albums / artists / playlists: the catalog pages they point to are not reachable, only the ids are kept
  if (parts[1] === "me" && parts[2] === "library" && (parts[3] === "albums" || parts[3] === "artists" || parts[3] === "playlists")) {
    const kind = parts[3];
    if (method === "GET") return reply({ items: [] });
    const id = parts[4] ? seg(parts[4]) : "";
    if (id && method === "PUT") {
      updateLibrary((lib) => {
        if (!lib.saved[kind].includes(id)) lib.saved[kind].push(id);
      });
      return reply(undefined);
    }
    if (id && method === "DELETE") {
      updateLibrary((lib) => {
        lib.saved[kind] = lib.saved[kind].filter((x) => x !== id);
      });
      return reply(undefined);
    }
  }

  // playlists
  if (route === "GET /v1/me/playlists") return reply({ items: getLibrary().playlists.map(toUserPlaylist) });
  if (route === "POST /v1/me/playlists") {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new LocalRouteError(400, "Title is required", "INVALID_INPUT");
    const now = new Date().toISOString();
    const playlist: LocalPlaylist = {
      id: uuid(),
      title,
      description: typeof body.description === "string" ? body.description : undefined,
      isPublic: !!body.isPublic,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      items: [],
    };
    updateLibrary((lib) => {
      lib.playlists.unshift(playlist);
    });
    return reply(toUserPlaylist(playlist));
  }
  if (parts[1] === "me" && parts[2] === "playlists" && parts[3]) {
    const playlistId = seg(parts[3]);
    const lib = getLibrary();

    if (parts.length === 4) {
      if (method === "GET") {
        const playlist = findPlaylist(lib, playlistId);
        return reply({ playlist: toUserPlaylist(playlist), items: toPlaylistItems(lib, playlist) });
      }
      if (method === "PATCH") {
        const updated = updateLibrary((l) => {
          const playlist = findPlaylist(l, playlistId);
          if (typeof body.title === "string" && body.title.trim()) playlist.title = body.title.trim();
          if ("description" in body) playlist.description = typeof body.description === "string" ? body.description : undefined;
          if (typeof body.isPublic === "boolean") playlist.isPublic = body.isPublic;
          touch(playlist);
          return playlist;
        });
        return reply(toUserPlaylist(updated));
      }
      if (method === "DELETE") {
        updateLibrary((l) => {
          findPlaylist(l, playlistId);
          l.playlists = l.playlists.filter((p) => p.id !== playlistId);
        });
        return reply(undefined);
      }
    }

    if (parts[4] === "tracks" && parts[5] && method === "POST") {
      const trackId = seg(parts[5]);
      const added = updateLibrary((l) => {
        const playlist = findPlaylist(l, playlistId);
        keepMetadata(l, trackId);
        const item = { id: uuid(), trackId, addedAt: new Date().toISOString() };
        playlist.items.push(item);
        touch(playlist);
        return { item, position: playlist.items.length - 1 };
      });
      return reply({
        id: added.item.id,
        track: toApiTrack(metadataFor(getLibrary(), trackId)),
        position: added.position,
        addedAt: added.item.addedAt,
      });
    }

    if (parts[4] === "items" && parts[5]) {
      const itemId = seg(parts[5]);
      if (method === "DELETE" && parts.length === 6) {
        updateLibrary((l) => {
          const playlist = findPlaylist(l, playlistId);
          playlist.items = playlist.items.filter((i) => i.id !== itemId);
          touch(playlist);
        });
        return reply(undefined);
      }
      if (method === "POST" && parts[6] === "move") {
        const playlist = updateLibrary((l) => {
          const target = findPlaylist(l, playlistId);
          const from = target.items.findIndex((i) => i.id === itemId);
          if (from === -1) throw new LocalRouteError(404, "Playlist item not found", "NOT_FOUND");
          const [item] = target.items.splice(from, 1);
          const before = typeof body.beforeItemId === "string" ? target.items.findIndex((i) => i.id === body.beforeItemId) : -1;
          target.items.splice(before === -1 ? target.items.length : before, 0, item!);
          touch(target);
          return target;
        });
        return reply({ playlist: toUserPlaylist(playlist), items: toPlaylistItems(getLibrary(), playlist) });
      }
    }
  }

  // history
  if (route === "POST /v1/me/playback/events") {
    recordPlayback(body as RecordPlaybackEventRequest);
    return reply(undefined);
  }
  if (route === "GET /v1/me/history") return reply(page(getLibrary().history, q, 30));

  // recommendations / explore need the server side models, nothing to show offline
  if (route === "GET /v1/me/recommendations/daily-mixes") return reply({ items: [], generatedAt: new Date().toISOString() });
  if (route === "GET /v1/me/recommendations/wave") return reply({ items: [], source: "history-seeds", count: 0 });
  if (route === "GET /v1/me/recommendations/taste") {
    return reply({ userId: LOCAL_USER_ID, topSeedTracks: [], topArtists: [], recentSkipTrackIds: [] });
  }
  if (route === "GET /v1/explore/popular") {
    return reply({ window: q.get("window") ?? "7d", generatedAt: new Date().toISOString(), items: [] });
  }
  if (parts[1] === "leaderboards") {
    return reply({ type: parts[2] ?? "global", targetId: parts[3] ?? "global", period: q.get("period") ?? "weekly", entries: [], updatedAt: new Date().toISOString() });
  }

  // catalog: search, radio and lookups of tracks we already saw
  if (route === "GET /v1/search") return reply({ items: [] });
  if (parts[1] === "tracks" && parts[2] && parts[3] === "radio") return reply({ items: [] });
  if (route.startsWith("GET /v1/tracks/") && parts.length === 3) {
    const known = getLibrary().tracks[seg(parts[2]!)] ?? getRememberedTrack(seg(parts[2]!));
    if (known) return reply({ ...toApiTrack(known), relatedTracks: [] });
  }

  if (parts[1] === "me" && parts[2] === "playlist-imports") {
    throw new LocalRouteError(501, "Playlist import needs the Liner servers", "LOCAL_MODE");
  }
  throw notFound(`${method} ${url.pathname}`);
}

export { rememberTrack };
