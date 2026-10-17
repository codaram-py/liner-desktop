import { parsePlaylist, startHlsProxy, type HlsProxy } from "./hlsStitch.js";

export interface SoundcloudTrackDto {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
  // GO+ tracks only expose a 30s snippet without a subscription
  previewOnly: boolean;
}

export type SoundcloudResolveResult =
  | { kind: "track"; tracks: SoundcloudTrackDto[] }
  | { kind: "playlist"; title: string; tracks: SoundcloudTrackDto[] }
  | { kind: "none"; tracks: [] };

export interface SoundcloudStreamDto {
  url: string;
  mimeType: string;
  codec: "opus" | "aac";
  bitrate: number;
}

const API = "https://api-v2.soundcloud.com";
const SITE = "https://soundcloud.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CLIENT_ID_TTL_MS = 6 * 60 * 60 * 1000;
const TRACK_BATCH = 50;
const PLAYLIST_LIMIT = 100;
const SOUNDCLOUD_HOST_RE = /^(?:www\.|m\.|on\.)?soundcloud\.com$/i;

const log = (message: string) => console.log(`\x1b[44;37m soundcloud \x1b[0m ${message}`);

let clientId: { value: string; at: number } | null = null;
let clientIdPromise: Promise<string> | null = null;

// the web player ships a public client_id inside its js bundles, the same way every third party client gets one
async function scrapeClientId(): Promise<string> {
  const home = await fetch(SITE, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!home.ok) throw new Error(`soundcloud.com responded ${home.status}`);
  const html = await home.text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  // the id lives in one of the last bundles
  for (const src of scripts.reverse()) {
    const js = await fetch(src, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    const match = /client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/.exec(js);
    if (match) return match[1]!;
  }
  throw new Error("could not find a soundcloud client_id");
}

async function getClientId(force = false): Promise<string> {
  if (!force && clientId && Date.now() - clientId.at < CLIENT_ID_TTL_MS) return clientId.value;
  if (!clientIdPromise) {
    clientIdPromise = scrapeClientId()
      .then((value) => {
        clientId = { value, at: Date.now() };
        log("client_id refreshed");
        return value;
      })
      .finally(() => {
        clientIdPromise = null;
      });
  }
  return clientIdPromise;
}

async function api<T>(path: string, params: Record<string, string> = {}, retry = true): Promise<T> {
  const id = await getClientId();
  const url = new URL(path.startsWith("http") ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("client_id", id);
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  // an expired id answers 401 / 403, fetch a fresh one once
  if ((res.status === 401 || res.status === 403) && retry) {
    await getClientId(true);
    return api<T>(path, params, false);
  }
  if (!res.ok) throw new Error(`soundcloud ${url.pathname} responded ${res.status}`);
  return (await res.json()) as T;
}

function toTrack(raw: any): SoundcloudTrackDto | null {
  if (!raw?.id || !raw?.title) return null;
  if (raw.policy === "BLOCK" || raw.streamable === false) return null;
  const snip = raw.policy === "SNIP";
  const artwork: string | undefined = raw.artwork_url || raw.user?.avatar_url;
  return {
    id: String(raw.id),
    title: String(raw.title),
    artists: String(raw.publisher_metadata?.artist || raw.user?.username || ""),
    coverUrl: artwork ? artwork.replace("-large.", "-t300x300.") : "",
    durationMs: Number(raw.full_duration ?? raw.duration ?? 0),
    previewOnly: snip,
  };
}

export async function searchSoundcloud(query: string, limit = 20): Promise<SoundcloudTrackDto[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await api<{ collection?: any[] }>("/search/tracks", { q, limit: String(limit), app_locale: "en" });
  return (res.collection ?? []).map(toTrack).filter((t): t is SoundcloudTrackDto => t !== null && t.durationMs > 0);
}

export function isSoundcloudUrl(raw: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return SOUNDCLOUD_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

// track and set / playlist links. playlists come back with bare id stubs for most entries, those are filled in batches
export async function resolveSoundcloudUrl(raw: string): Promise<SoundcloudResolveResult> {
  if (!isSoundcloudUrl(raw)) return { kind: "none", tracks: [] };
  const target = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const resolved = await api<any>("/resolve", { url: target });

  if (resolved.kind === "track") {
    const track = toTrack(resolved);
    return track ? { kind: "track", tracks: [track] } : { kind: "none", tracks: [] };
  }

  if (resolved.kind === "playlist") {
    const entries: any[] = (resolved.tracks ?? []).slice(0, PLAYLIST_LIMIT);
    const stubIds = entries.filter((t) => !t.title).map((t) => String(t.id));
    const filled = new Map<string, any>();
    for (let i = 0; i < stubIds.length; i += TRACK_BATCH) {
      const batch = await api<any[]>("/tracks", { ids: stubIds.slice(i, i + TRACK_BATCH).join(",") });
      for (const t of batch) filled.set(String(t.id), t);
    }
    const tracks = entries
      .map((t) => toTrack(t.title ? t : filled.get(String(t.id))))
      .filter((t): t is SoundcloudTrackDto => t !== null);
    return { kind: "playlist", title: String(resolved.title ?? "SoundCloud"), tracks };
  }

  return { kind: "none", tracks: [] };
}

let hlsProxyPromise: Promise<HlsProxy> | null = null;

function getHlsProxy(): Promise<HlsProxy> {
  if (!hlsProxyPromise) {
    hlsProxyPromise = startHlsProxy({ log }).catch((err) => {
      hlsProxyPromise = null;
      throw err;
    });
  }
  return hlsProxyPromise;
}

const mimeOf = (t: any): string => String(t.format?.mime_type ?? "audio/mpeg").split(";")[0]!.trim();

// plain mp3 files are best (seekable, no stitching). uploads without one come as hls, the plain mp3 flavour first
// because it is the cheapest to play back, then fmp4 (aac), then ogg
function rankTranscodings(transcodings: any[]): any[] {
  const hlsOrder = ["audio/mpeg", "audio/mp4", "audio/ogg"];
  const progressive = transcodings.filter((t) => t.format?.protocol === "progressive");
  const hls = transcodings
    .filter((t) => t.format?.protocol === "hls")
    .sort((a, b) => hlsOrder.indexOf(mimeOf(a)) - hlsOrder.indexOf(mimeOf(b)));
  return [...progressive, ...hls];
}

export async function getSoundcloudStream(trackId: string): Promise<SoundcloudStreamDto> {
  if (!/^\d+$/.test(trackId)) throw new Error("invalid soundcloud track id");
  const track = await api<any>(`/tracks/${trackId}`);
  if (track.policy === "BLOCK") throw new Error("track is blocked in this region");

  const transcodings: any[] = track.media?.transcodings ?? [];
  const candidates = rankTranscodings(transcodings);
  if (candidates.length === 0) {
    throw new Error(`no playable stream for this track (${transcodings.map((t) => `${t.format?.protocol}/${mimeOf(t)}`).join(", ") || "no transcodings"})`);
  }

  const params: Record<string, string> = {};
  if (track.track_authorization) params.track_authorization = track.track_authorization;

  const errors: string[] = [];
  for (const transcoding of candidates) {
    const label = `${transcoding.format?.protocol}/${mimeOf(transcoding)}`;
    try {
      const media = await api<{ url?: string }>(transcoding.url, params);
      if (!media.url) throw new Error("soundcloud returned no stream url");

      if (transcoding.format.protocol === "progressive") {
        const probe = await fetch(media.url, { headers: { range: "bytes=0-1" }, signal: AbortSignal.timeout(8000) });
        await probe.body?.cancel().catch(() => {});
        if (!probe.ok) throw new Error(`stream probe failed: HTTP ${probe.status}`);
        log(`${trackId} ok via ${label}`);
        // the player only logs the codec, soundcloud progressive streams are mp3
        return { url: media.url, mimeType: mimeOf(transcoding), codec: "aac", bitrate: 128000 };
      }

      // hls: make sure the playlist is something we can stitch before handing the player a proxy url
      const playlistRes = await fetch(media.url, { signal: AbortSignal.timeout(8000) });
      if (!playlistRes.ok) throw new Error(`playlist responded HTTP ${playlistRes.status}`);
      parsePlaylist(await playlistRes.text(), media.url);
      const proxy = await getHlsProxy();
      log(`${trackId} ok via ${label}`);
      return {
        url: proxy.urlFor({ playlistUrl: media.url, mimeType: mimeOf(transcoding) }),
        mimeType: mimeOf(transcoding),
        codec: mimeOf(transcoding) === "audio/ogg" ? "opus" : "aac",
        bitrate: 128000,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`${trackId} ${label} failed: ${reason}`);
      errors.push(`${label}: ${reason}`);
    }
  }
  throw new Error(`no playable soundcloud stream (${errors.join("; ")})`);
}
