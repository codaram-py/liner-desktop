import type { PlaybackSessionResponse } from "@/shared/contracts";
import type { Track } from "@/shared/types";
import { rememberTrack } from "@/shared/local/trackRegistry";
import { makeExternalId, rawExternalId, sourceOfTrackId, type SourceId } from "./types";

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
    id: makeExternalId(source, rawId),
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

// "Artist - Song (Official Video)" -> { artist: "Artist", title: "Song" }, otherwise keep the channel as artist
export function splitYoutubeTitle(title: string, channel: string): { title: string; artists: string } {
  const cleaned = title.replace(YT_NOISE_RE, "").trim();
  const match = cleaned.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
  if (match) return { artists: match[1]!.trim(), title: match[2]!.trim() };
  return { title: cleaned || title, artists: channel };
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

export interface YoutubeLinkResult {
  tracks: ExternalTrack[];
  playlistTitle?: string;
}

// pasted video / playlist url or bare video id. null when the input is not a youtube link
export async function resolveYoutubeLink(input: string): Promise<YoutubeLinkResult | null> {
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

// ---- deezer / apple music: public catalog endpoints, 30s previews only ----

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return (await res.json()) as T;
}

export async function searchDeezer(query: string, signal?: AbortSignal): Promise<ExternalTrack[]> {
  const data = await getJson<{ data?: any[] }>(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`,
    signal,
  );
  return (data.data ?? [])
    .filter((item) => item?.id && item?.preview)
    .map((item) =>
      toExternal(
        "deezer",
        item.id,
        {
          title: item.title_short || item.title,
          artists: item.artist?.name ?? "",
          coverUrl: item.album?.cover_medium || item.album?.cover || "",
          durationMs: (item.duration ?? 0) * 1000,
        },
        { explicit: item.explicit_lyrics || undefined, previewOnly: true },
      ),
    );
}

export async function searchAppleMusic(query: string, signal?: AbortSignal): Promise<ExternalTrack[]> {
  const data = await getJson<{ results?: any[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${SEARCH_LIMIT}`,
    signal,
  );
  return (data.results ?? [])
    .filter((item) => item?.trackId && item?.previewUrl)
    .map((item) =>
      toExternal(
        "apple_music",
        item.trackId,
        {
          title: item.trackName,
          artists: item.artistName ?? "",
          coverUrl: String(item.artworkUrl100 ?? "").replace(/\/\d+x\d+bb\./, "/300x300bb."),
          durationMs: item.trackTimeMillis ?? 0,
        },
        { explicit: item.trackExplicitness === "explicit" || undefined, previewOnly: true },
      ),
    );
}

// ---- playback ----

// resolves a stream for ids owned by a local provider. returns null for liner catalog ids
export async function resolveExternalPlayback(
  trackId: string,
  signal?: AbortSignal,
): Promise<PlaybackSessionResponse | null> {
  const source = sourceOfTrackId(trackId);
  if (source === "liner") return null;
  const raw = rawExternalId(trackId);

  if (source === "youtube") {
    const bridge = window.linerElectron;
    if (!bridge?.youtubeStream) throw new Error("YouTube playback needs the desktop app");
    const stream = await bridge.youtubeStream(raw);
    return {
      streamUrl: stream.url,
      mimeType: stream.mimeType,
      codec: stream.codec,
      bitrate: stream.bitrate,
      expiresAt: stream.expiresAt,
    };
  }

  if (source === "deezer") {
    const data = await getJson<{ preview?: string }>(`https://api.deezer.com/track/${raw}`, signal);
    if (!data.preview) throw new Error("Deezer returned no preview for this track");
    return { streamUrl: data.preview, mimeType: "audio/mpeg", codec: "aac", bitrate: 128000 };
  }

  const data = await getJson<{ results?: { previewUrl?: string }[] }>(
    `https://itunes.apple.com/lookup?id=${raw}`,
    signal,
  );
  const preview = data.results?.[0]?.previewUrl;
  if (!preview) throw new Error("Apple Music returned no preview for this track");
  return { streamUrl: preview, mimeType: "audio/mp4", codec: "aac", bitrate: 128000 };
}
