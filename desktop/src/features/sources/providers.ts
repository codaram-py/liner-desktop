import type { PlaybackSessionResponse } from "@/shared/contracts";
import type { Track } from "@/shared/types";
import { rememberTrack } from "@/shared/local/trackRegistry";
import { pickBestYoutubeMatch } from "./matchYoutube";
import { normalizeArtist } from "./mergeResults";
import { isPreviewTrackId, makeExternalId, rawExternalId, sourceOfTrackId, type SourceId } from "./types";

export type ExternalTrack = Track & { source: SourceId; previewOnly?: boolean; collection?: string };

const SEARCH_LIMIT = 15;
const YT_NOISE_RE =
  /\s*[([](?:official|lyrics?|lyric video|audio|video|visuali[sz]er|hd|hq|4k|music video|clip)[^)\]]*[)\]]/gi;

function toExternal(
  source: Exclude<SourceId, "liner">,
  rawId: string | number,
  fields: { title: string; artists: string; coverUrl: string; durationMs: number },
  extra?: Partial<ExternalTrack>,
): ExternalTrack {
  const track: ExternalTrack = {
    id: makeExternalId(source, rawId, extra?.previewOnly),
    title: fields.title,
    artists: fields.artists,
    coverUrl: fields.coverUrl,
    durationMs: fields.durationMs,
    playCount: 0,
    source,
    ...extra,
  };
  rememberTrack(track);
  return track;
}

function sameName(a: string, b: string): boolean {
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

// "Artist - Song (Official Video)" -> { artist: "Artist", title: "Song" }, otherwise keep the channel as artist.
// uploads also come as "Song - Artist", the channel name tells which side is the artist
export function splitYoutubeTitle(title: string, channel: string): { title: string; artists: string } {
  const cleaned = title.replace(YT_NOISE_RE, "").trim();
  const match = cleaned.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
  if (!match) return { title: cleaned || title, artists: channel };

  const left = match[1]!.trim();
  const right = match[2]!.trim();
  const ch = normalizeArtist(channel);
  if (sameName(ch, normalizeArtist(right)) && !sameName(ch, normalizeArtist(left))) {
    return { title: left, artists: right };
  }
  return { artists: left, title: right };
}

// ---- youtube (runs in the electron main process, see electron/youtube.ts) ----

export function isYoutubeLike(query: string): boolean {
  const q = query.trim();
  return /(?:youtu\.be|youtube\.com)/i.test(q) || /^[A-Za-z0-9_-]{11}$/.test(q);
}

function fromYoutubeDto(dto: {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
}): ExternalTrack {
  const meta = splitYoutubeTitle(dto.title, dto.artists);
  return toExternal("youtube", dto.id, { ...dto, ...meta });
}

export async function searchYoutube(query: string): Promise<ExternalTrack[]> {
  const bridge = window.linerElectron;
  if (!bridge?.youtubeSearch) return [];
  const results = await bridge.youtubeSearch(query, SEARCH_LIMIT);
  return results.map(fromYoutubeDto);
}

export interface LinkResult {
  tracks: ExternalTrack[];
  playlistTitle?: string;
}

// pasted video / playlist url or bare video id. null when the input is not a youtube link
export async function resolveYoutubeLink(input: string): Promise<LinkResult | null> {
  const bridge = window.linerElectron;
  if (!bridge?.youtubeResolve || !isYoutubeLike(input)) return null;
  const res = await bridge.youtubeResolve(input);
  if (res.kind === "none" || res.tracks.length === 0) return null;
  const collection = res.kind === "playlist" ? `yt-playlist:${input.trim()}` : undefined;
  return {
    tracks: res.tracks.map((dto) => ({ ...fromYoutubeDto(dto), collection })),
    playlistTitle: res.kind === "playlist" ? res.title : undefined,
  };
}

// ---- soundcloud (runs in the electron main process, see electron/soundcloud.ts) ----

export function isSoundcloudLike(query: string): boolean {
  return /(?:^|\/\/|\.)soundcloud\.com\//i.test(query.trim());
}

function fromSoundcloudDto(dto: {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
  previewOnly: boolean;
}): ExternalTrack {
  return toExternal("soundcloud", dto.id, dto, dto.previewOnly ? { previewOnly: true } : undefined);
}

export async function searchSoundcloud(query: string): Promise<ExternalTrack[]> {
  const bridge = window.linerElectron;
  if (!bridge?.soundcloudSearch) return [];
  const results = await bridge.soundcloudSearch(query, SEARCH_LIMIT);
  return results.map(fromSoundcloudDto);
}

export async function resolveSoundcloudLink(input: string): Promise<LinkResult | null> {
  const bridge = window.linerElectron;
  if (!bridge?.soundcloudResolve || !isSoundcloudLike(input)) return null;
  const res = await bridge.soundcloudResolve(input);
  if (res.kind === "none" || res.tracks.length === 0) return null;
  const collection = res.kind === "playlist" ? `sc-playlist:${input.trim()}` : undefined;
  return {
    tracks: res.tracks.map((dto) => ({ ...fromSoundcloudDto(dto), collection })),
    playlistTitle: res.kind === "playlist" ? res.title : undefined,
  };
}

// ---- spotify (runs in the electron main process, see electron/spotify.ts) ----
// metadata only: the audio plays from the matching youtube upload, like deezer / apple music rows

export function isSpotifyLike(query: string): boolean {
  const q = query.trim();
  return /(?:^|\/\/|\.)open\.spotify\.com\//i.test(q) || /^spotify:(?:track|album|playlist):/i.test(q);
}

function fromSpotifyDto(dto: {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
  explicit: boolean;
}): ExternalTrack {
  return toExternal("spotify", dto.id, dto, dto.explicit ? { explicit: true } : undefined);
}

export interface SpotifySearchOutcome {
  // false when there are no client credentials in config.json yet
  configured: boolean;
  tracks: ExternalTrack[];
}

export async function searchSpotify(query: string): Promise<SpotifySearchOutcome> {
  const bridge = window.linerElectron;
  if (!bridge?.spotifySearch) return { configured: true, tracks: [] };
  const res = await bridge.spotifySearch(query, SEARCH_LIMIT);
  return { configured: res.configured, tracks: res.tracks.map(fromSpotifyDto) };
}

export class SpotifyNotConfiguredError extends Error {
  constructor() {
    super("Spotify needs a client id and secret in config.json");
    this.name = "SpotifyNotConfiguredError";
  }
}

export async function resolveSpotifyLink(input: string): Promise<LinkResult | null> {
  const bridge = window.linerElectron;
  if (!bridge?.spotifyResolve || !isSpotifyLike(input)) return null;
  const res = await bridge.spotifyResolve(input);
  // links open without credentials (public embed page), only a link that found nothing needs them
  if (res.kind === "none" || res.tracks.length === 0) {
    if (!res.configured) throw new SpotifyNotConfiguredError();
    return null;
  }
  const collection = res.kind === "album" || res.kind === "playlist" ? `sp-${res.kind}:${input.trim()}` : undefined;
  return {
    tracks: res.tracks.map((dto) => ({ ...fromSpotifyDto(dto), collection })),
    playlistTitle: res.kind === "album" || res.kind === "playlist" ? res.title : undefined,
  };
}

// any pasted link we know how to open
export async function resolveExternalLink(input: string): Promise<LinkResult | null> {
  return (await resolveYoutubeLink(input)) ?? (await resolveSoundcloudLink(input)) ?? (await resolveSpotifyLink(input));
}

export function isLinkLike(query: string): boolean {
  return isYoutubeLike(query) || isSoundcloudLike(query) || isSpotifyLike(query);
}

// ---- deezer / apple music: public catalog endpoints, metadata + 30s clips ----
// every hit becomes two rows: the song itself (played in full from the matching youtube upload, see resolveExternalPlayback)
// and the official 30s clip, which is listed under the "Prévia" category

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

type CatalogFields = { title: string; artists: string; coverUrl: string; durationMs: number };

function fullAndPreview(
  source: "deezer" | "apple_music",
  rawId: string | number,
  fields: CatalogFields,
  extra: Partial<ExternalTrack>,
): ExternalTrack[] {
  return [
    toExternal(source, rawId, fields, extra),
    toExternal(source, rawId, fields, { ...extra, previewOnly: true }),
  ];
}

export async function searchDeezer(query: string, signal?: AbortSignal): Promise<ExternalTrack[]> {
  const data = await getJson<{ data?: any[] }>(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`,
    signal,
  );
  const rows = (data.data ?? [])
    .filter((item) => item?.id && item?.preview)
    .flatMap((item) =>
      fullAndPreview(
        "deezer",
        item.id,
        {
          title: item.title_short || item.title,
          artists: item.artist?.name ?? "",
          coverUrl: item.album?.cover_medium || item.album?.cover || "",
          durationMs: (item.duration ?? 0) * 1000,
        },
        { explicit: item.explicit_lyrics || undefined },
      ),
    );
  return rows;
}

export async function searchAppleMusic(query: string, signal?: AbortSignal): Promise<ExternalTrack[]> {
  const data = await getJson<{ results?: any[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${SEARCH_LIMIT}`,
    signal,
  );
  return (data.results ?? [])
    .filter((item) => item?.trackId && item?.previewUrl)
    .flatMap((item) =>
      fullAndPreview(
        "apple_music",
        item.trackId,
        {
          title: item.trackName,
          artists: item.artistName ?? "",
          coverUrl: String(item.artworkUrl100 ?? "").replace(/\/\d+x\d+bb\./, "/300x300bb."),
          durationMs: item.trackTimeMillis ?? 0,
        },
        { explicit: item.trackExplicitness === "explicit" || undefined },
      ),
    );
}

// ---- playback ----

const youtubeMatches = new Map<string, string>();

// full length audio for a deezer / apple music row: search youtube for the same song and take the best upload
async function findYoutubeVideoFor(track: PlayableRef): Promise<string | null> {
  const cached = youtubeMatches.get(track.id);
  if (cached) return cached;
  const candidates = await searchYoutube(`${track.artists} ${track.title}`.trim());
  const best = pickBestYoutubeMatch(
    { title: track.title, artists: track.artists, durationMs: track.durationMs },
    candidates,
  );
  if (!best) return null;
  const videoId = rawExternalId(best.id);
  youtubeMatches.set(track.id, videoId);
  return videoId;
}

async function youtubeSession(videoId: string): Promise<PlaybackSessionResponse> {
  const bridge = window.linerElectron;
  if (!bridge?.youtubeStream) throw new Error("YouTube playback needs the desktop app");
  const stream = await bridge.youtubeStream(videoId);
  return {
    streamUrl: stream.url,
    mimeType: stream.mimeType,
    codec: stream.codec,
    bitrate: stream.bitrate,
    expiresAt: stream.expiresAt,
  };
}

async function previewSession(source: SourceId, raw: string, signal?: AbortSignal): Promise<PlaybackSessionResponse> {
  if (source === "deezer") {
    const data = await getJson<{ preview?: string }>(`https://api.deezer.com/track/${raw}`, signal);
    if (!data.preview) throw new Error("Deezer returned no preview for this track");
    return { streamUrl: data.preview, mimeType: "audio/mpeg", codec: "aac", bitrate: 128000 };
  }
  const data = await getJson<{ results?: { previewUrl?: string }[] }>(`https://itunes.apple.com/lookup?id=${raw}`, signal);
  const preview = data.results?.[0]?.previewUrl;
  if (!preview) throw new Error("Apple Music returned no preview for this track");
  return { streamUrl: preview, mimeType: "audio/mp4", codec: "aac", bitrate: 128000 };
}

export interface PlayableRef {
  id: string;
  title: string;
  artists: string;
  durationMs: number;
}

// resolves a stream for ids owned by a local provider. returns null for liner catalog ids
export async function resolveExternalPlayback(
  track: PlayableRef,
  signal?: AbortSignal,
): Promise<PlaybackSessionResponse | null> {
  const source = sourceOfTrackId(track.id);
  if (source === "liner") return null;
  const raw = rawExternalId(track.id);

  if (source === "youtube") return youtubeSession(raw);

  if (source === "soundcloud") {
    const bridge = window.linerElectron;
    if (!bridge?.soundcloudStream) throw new Error("SoundCloud playback needs the desktop app");
    const stream = await bridge.soundcloudStream(raw);
    return { streamUrl: stream.url, mimeType: stream.mimeType, codec: stream.codec, bitrate: stream.bitrate };
  }

  // dzp: / amp: ids are the official 30s clips
  if (isPreviewTrackId(track.id)) return previewSession(source, raw, signal);

  const videoId = await findYoutubeVideoFor(track);
  if (videoId) return youtubeSession(videoId);

  // spotify has no clip to fall back on
  if (source === "spotify") throw new Error(`no full length match on YouTube for "${track.artists} - ${track.title}"`);

  // nothing on youtube matches closely enough, a clip is better than silence
  console.warn(`no full length match for "${track.artists} - ${track.title}", playing the 30s preview`);
  return previewSession(source, raw, signal);
}
