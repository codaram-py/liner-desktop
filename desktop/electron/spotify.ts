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

// a logged in user (see spotifyAuth.ts): preferred over client credentials, and the only way to read liked songs
export interface SpotifyUserSession {
  status: () => { loggedIn: boolean };
  getAccessToken: () => Promise<string | null>;
  invalidate?: () => void;
}

export interface SpotifyDeps {
  getCredentials: () => SpotifyCredentials;
  auth?: SpotifyUserSession;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const LIST_LIMIT = 100;

export type SpotifyKind = "track" | "album" | "playlist" | "liked";

// open.spotify.com/track/ID, /intl-pt/album/ID, spotify:playlist:ID. "liked" is the signed in user's liked songs:
// open.spotify.com/collection/tracks or spotify:me:liked
export function parseSpotifyUrl(raw: string): { kind: SpotifyKind; id: string } | null {
  const input = raw.trim();
  if (/^spotify:me:liked$/i.test(input)) return { kind: "liked", id: "me" };
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return { kind: uri[1] as SpotifyKind, id: uri[2]! };
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!/^(?:www\.)?open\.spotify\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter((p) => p && !/^intl-[a-z-]+$/i.test(p));
    const [kind, id] = parts;
    if (kind === "collection" && id === "tracks") return { kind: "liked", id: "me" };
    if ((kind === "track" || kind === "album" || kind === "playlist") && id && /^[A-Za-z0-9]{22}$/.test(id)) return { kind, id };
  } catch {}
  return null;
}

const EMBED_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function pickImage(images: any[] | undefined, key: "width" | "maxWidth"): string {
  if (!images?.length) return "";
  // closest to 300px, the size a row needs
  return [...images].sort((a, b) => Math.abs((a[key] ?? 300) - 300) - Math.abs((b[key] ?? 300) - 300))[0]?.url ?? "";
}

// public embed pages (open.spotify.com/embed/...) carry the entity as json, no login or credentials involved.
// the format is not documented, so everything is read defensively and an unknown shape just means "nothing found"
export function parseEmbedPage(html: string, kind: SpotifyKind, id: string): { title: string; tracks: SpotifyTrackDto[] } | null {
  const raw = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!raw) return null;
  let entity: any;
  try {
    entity = JSON.parse(raw)?.props?.pageProps?.state?.data?.entity;
  } catch {
    return null;
  }
  if (!entity) return null;

  const cover = pickImage(entity.coverArt?.sources, "width") || pickImage(entity.visualIdentity?.image, "maxWidth");
  const title = String(entity.name ?? entity.title ?? "Spotify");
  const make = (trackId: string, name: unknown, artists: unknown, duration: unknown, explicit: unknown, image = cover): SpotifyTrackDto | null => {
    const durationMs = Number(duration) || 0;
    if (!trackId || !name || durationMs <= 0) return null;
    return { id: trackId, title: String(name), artists: String(artists ?? "").replace(/ /g, " ").trim(), coverUrl: image, durationMs, explicit: !!explicit };
  };

  if (kind === "track") {
    const artists = Array.isArray(entity.artists) ? entity.artists.map((a: any) => a?.name).filter(Boolean).join(", ") : entity.subtitle;
    const track = make(id, entity.name ?? entity.title, artists, entity.duration ?? entity.durationMs, entity.isExplicit);
    return track ? { title, tracks: [track] } : null;
  }

  const list: any[] = Array.isArray(entity.trackList) ? entity.trackList : [];
  const tracks = list
    .map((item) => make(String(item?.uri ?? "").split(":").pop() ?? "", item?.title, item?.subtitle, item?.duration, item?.isExplicit))
    .filter((t): t is SpotifyTrackDto => t !== null)
    .slice(0, LIST_LIMIT);
  return tracks.length ? { title, tracks } : null;
}

export function createSpotify(deps: SpotifyDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let token: { value: string; expiresAt: number; clientId: string } | null = null;

  const credentials = () => {
    const { clientId, clientSecret } = deps.getCredentials();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };
  const loggedIn = () => !!deps.auth?.status().loggedIn;
  const configured = () => loggedIn() || !!credentials();

  async function clientCredentialsToken(creds: { clientId: string; clientSecret: string }): Promise<string> {
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

  // the signed in user wins (private playlists, liked songs), client credentials are the login free fallback
  async function bearer(): Promise<string> {
    if (deps.auth) {
      const user = await deps.auth.getAccessToken();
      if (user) return user;
    }
    const creds = credentials();
    if (!creds) throw new Error("Spotify is not connected");
    return clientCredentialsToken(creds);
  }

  async function api<T>(pathAndQuery: string, retry = true): Promise<T> {
    const res = await fetchImpl(`${API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${await bearer()}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401 && retry) {
      token = null;
      deps.auth?.invalidate?.();
      return api<T>(pathAndQuery, false);
    }
    if (res.status === 403 && loggedIn()) throw new Error("Spotify refused this request, log in again to renew the permissions");
    if (res.status === 429) throw new Error(`Spotify is rate limiting this app, retry in ${res.headers.get("retry-after") ?? "a few"}s`);
    if (res.status === 404) throw new Error("Spotify could not find that item (private playlists need you to be logged in)");
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
    if (!configured()) return { configured: false, tracks: [] };
    const q = query.trim();
    if (!q) return { configured: true, tracks: [] };
    const res = await api<{ tracks?: { items?: any[] } }>(`/search?type=track&limit=${Math.min(limit, 50)}&q=${encodeURIComponent(q)}`);
    return { configured: true, tracks: clean((res.tracks?.items ?? []).map((t) => toTrack(t))) };
  }

  // liked songs come 50 at a time, four pages is plenty for a queue
  async function liked(): Promise<SpotifyTrackDto[]> {
    const out: SpotifyTrackDto[] = [];
    for (let offset = 0; offset < LIST_LIMIT * 2; offset += 50) {
      const page = await api<{ items?: any[]; next?: string | null }>(`/me/tracks?limit=50&offset=${offset}`);
      out.push(...clean((page.items ?? []).map((i) => toTrack(i.track))));
      if (!page.next) break;
    }
    return out;
  }

  async function resolve(raw: string): Promise<SpotifyResolveResult> {
    const parsed = parseSpotifyUrl(raw);
    if (!parsed) return { configured: configured(), kind: "none", tracks: [] };

    if (parsed.kind === "liked") {
      if (!loggedIn()) return { configured: configured(), kind: "none", tracks: [] };
      return { configured: true, kind: "playlist", title: "Músicas curtidas", tracks: await liked() };
    }

    if (!configured()) {
      // not connected: links still open through the public embed page
      try {
        const res = await fetchImpl(`https://open.spotify.com/embed/${parsed.kind}/${parsed.id}`, {
          headers: { "user-agent": EMBED_USER_AGENT, "accept-language": "en-US,en;q=0.9" },
          signal: AbortSignal.timeout(12_000),
        });
        const page = res.ok ? parseEmbedPage(await res.text(), parsed.kind, parsed.id) : null;
        if (page) {
          return parsed.kind === "track"
            ? { configured: false, kind: "track", tracks: page.tracks }
            : { configured: false, kind: parsed.kind, title: page.title, tracks: page.tracks };
        }
      } catch {}
      return { configured: false, kind: "none", tracks: [] };
    }

    if (parsed.kind === "track") {
      const track = toTrack(await api<any>(`/tracks/${parsed.id}`));
      return track ? { configured: true, kind: "track", tracks: clean([track]) } : { configured: true, kind: "none", tracks: [] };
    }

    if (parsed.kind === "album") {
      const album = await api<any>(`/albums/${parsed.id}`);
      const tracks = clean((album.tracks?.items ?? []).slice(0, LIST_LIMIT).map((t: any) => toTrack(t, album.images)));
      return { configured: true, kind: "album", title: String(album.name ?? "Spotify"), tracks };
    }

    const [meta, items] = await Promise.all([
      api<any>(`/playlists/${parsed.id}?fields=name`),
      api<{ items?: any[] }>(`/playlists/${parsed.id}/tracks?limit=${LIST_LIMIT}&fields=items(track(id,name,duration_ms,explicit,is_local,type,artists(name),album(images)))`),
    ]);
    const tracks = clean((items.items ?? []).map((i) => toTrack(i.track)));
    return { configured: true, kind: "playlist", title: String(meta.name ?? "Spotify"), tracks };
  }

  return { search, resolve, isConfigured: configured };
}
