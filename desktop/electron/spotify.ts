export interface SpotifyTrackDto {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
  explicit: boolean;
}

export interface SpotifySearchResult {
  // false until the user puts a client id / secret in config.json, there is no anonymous search anymore
  configured: boolean;
  tracks: SpotifyTrackDto[];
}

export type SpotifyResolveResult =
  | { configured: boolean; kind: "track"; tracks: SpotifyTrackDto[] }
  | { configured: boolean; kind: "album" | "playlist"; title: string; tracks: SpotifyTrackDto[] }
  | { configured: boolean; kind: "none"; tracks: [] };

export interface SpotifyCredentials {
  clientId?: string;
  clientSecret?: string;
}

export interface SpotifyDeps {
  getCredentials: () => SpotifyCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const LIST_LIMIT = 100;

export type SpotifyKind = "track" | "album" | "playlist";

// open.spotify.com/track/ID, /intl-pt/album/ID, spotify:playlist:ID
export function parseSpotifyUrl(raw: string): { kind: SpotifyKind; id: string } | null {
  const input = raw.trim();
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return { kind: uri[1] as SpotifyKind, id: uri[2]! };
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!/^(?:www\.)?open\.spotify\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter((p) => p && !/^intl-[a-z-]+$/i.test(p));
    const [kind, id] = parts;
    if ((kind === "track" || kind === "album" || kind === "playlist") && id && /^[A-Za-z0-9]{22}$/.test(id)) return { kind, id };
  } catch {}
  return null;
}

export function createSpotify(deps: SpotifyDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let token: { value: string; expiresAt: number; clientId: string } | null = null;

  const credentials = () => {
    const { clientId, clientSecret } = deps.getCredentials();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };

  async function getToken(creds: { clientId: string; clientSecret: string }): Promise<string> {
    if (token && token.clientId === creds.clientId && token.expiresAt > now() + 60_000) return token.value;
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(res.status === 400 || res.status === 401 ? "Spotify rejected the client id / secret in config.json" : `Spotify token request responded ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000, clientId: creds.clientId };
    return token.value;
  }

  async function api<T>(creds: { clientId: string; clientSecret: string }, pathAndQuery: string, retry = true): Promise<T> {
    const res = await fetchImpl(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${await getToken(creds)}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 && retry) {
      token = null;
      return api<T>(creds, pathAndQuery, false);
    }
    if (res.status === 429) throw new Error(`Spotify is rate limiting this app, retry in ${res.headers.get("retry-after") ?? "a few"}s`);
    if (res.status === 404) throw new Error("Spotify could not find that item (private playlists are not readable)");
    if (!res.ok) throw new Error(`Spotify ${pathAndQuery.split("?")[0]} responded ${res.status}`);
    return (await res.json()) as T;
  }

  function toTrack(raw: any, fallbackImages?: any[]): SpotifyTrackDto | null {
    if (!raw?.id || !raw?.name || raw.is_local || raw.type === "episode") return null;
    const images: any[] = raw.album?.images?.length ? raw.album.images : (fallbackImages ?? []);
    // images come largest first, the middle one (300px) is plenty for a row
    const cover = images[1]?.url ?? images[0]?.url ?? "";
    return {
      id: String(raw.id),
      title: String(raw.name),
      artists: (raw.artists ?? []).map((a: any) => a.name).filter(Boolean).join(", "),
      coverUrl: cover,
      durationMs: Number(raw.duration_ms) || 0,
      explicit: !!raw.explicit,
    };
  }

  const clean = (tracks: (SpotifyTrackDto | null)[]) => tracks.filter((t): t is SpotifyTrackDto => t !== null && t.durationMs > 0);

  async function search(query: string, limit = 20): Promise<SpotifySearchResult> {
    const creds = credentials();
    if (!creds) return { configured: false, tracks: [] };
    const q = query.trim();
    if (!q) return { configured: true, tracks: [] };
    const res = await api<{ tracks?: { items?: any[] } }>(creds, `/search?type=track&limit=${Math.min(limit, 50)}&q=${encodeURIComponent(q)}`);
    return { configured: true, tracks: clean((res.tracks?.items ?? []).map((t) => toTrack(t))) };
  }

  async function resolve(raw: string): Promise<SpotifyResolveResult> {
    const parsed = parseSpotifyUrl(raw);
    const creds = credentials();
    if (!parsed) return { configured: !!creds, kind: "none", tracks: [] };
    if (!creds) return { configured: false, kind: "none", tracks: [] };

    if (parsed.kind === "track") {
      const track = toTrack(await api<any>(creds, `/tracks/${parsed.id}`));
      return track ? { configured: true, kind: "track", tracks: clean([track]) } : { configured: true, kind: "none", tracks: [] };
    }

    if (parsed.kind === "album") {
      const album = await api<any>(creds, `/albums/${parsed.id}`);
      const tracks = clean((album.tracks?.items ?? []).slice(0, LIST_LIMIT).map((t: any) => toTrack(t, album.images)));
      return { configured: true, kind: "album", title: String(album.name ?? "Spotify"), tracks };
    }

    const [meta, items] = await Promise.all([
      api<any>(creds, `/playlists/${parsed.id}?fields=name`),
      api<{ items?: any[] }>(creds, `/playlists/${parsed.id}/tracks?limit=${LIST_LIMIT}&fields=items(track(id,name,duration_ms,explicit,is_local,type,artists(name),album(images)))`),
    ]);
    const tracks = clean((items.items ?? []).map((i) => toTrack(i.track)));
    return { configured: true, kind: "playlist", title: String(meta.name ?? "Spotify"), tracks };
  }

  return { search, resolve, isConfigured: () => !!credentials() };
}
