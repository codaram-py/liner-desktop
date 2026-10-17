import { Innertube } from "youtubei.js";
import { parseYoutubeInput } from "./youtubeInput.js";

export interface YoutubeTrackDto {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
}

export type YoutubeResolveResult =
  | { kind: "video"; tracks: YoutubeTrackDto[] }
  | { kind: "playlist"; title: string; tracks: YoutubeTrackDto[] }
  | { kind: "none"; tracks: [] };

export interface YoutubeStreamDto {
  url: string;
  mimeType: string;
  codec: "opus" | "aac";
  bitrate: number;
  expiresAt?: string;
}

// order matters: the first two return plain googlevideo urls without po tokens at the time of writing,
// web is the last resort. FILL: reorder here if youtube starts rejecting one of them
const STREAM_CLIENTS = ["ANDROID_VR", "IOS", "TV", "WEB"] as const;
const STREAM_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_LIMIT = 100;

let clientPromise: Promise<Innertube> | null = null;
const streamCache = new Map<string, { at: number; stream: YoutubeStreamDto }>();

function getClient(): Promise<Innertube> {
  if (!clientPromise) {
    clientPromise = Innertube.create({ generate_session_locally: true }).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function parseClock(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function cleanChannel(name: string | undefined): string {
  return (name ?? "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .trim();
}

function thumbFor(id: string, thumbs?: { url?: string }[]): string {
  return thumbs?.[0]?.url?.split("?")[0] || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function toTrack(node: any): YoutubeTrackDto | null {
  const id: string | undefined = node?.video_id ?? node?.id;
  const title: string | undefined = node?.title?.text ?? (typeof node?.title === "string" ? node.title : undefined);
  if (!id || !title) return null;
  const seconds: number = node?.duration?.seconds ?? parseClock(node?.length_text?.text);
  if (node?.is_live || !seconds) return null;
  return {
    id,
    title,
    artists: cleanChannel(node?.author?.name),
    coverUrl: thumbFor(id, node?.thumbnails),
    durationMs: seconds * 1000,
  };
}

export async function searchYoutube(query: string, limit = 20): Promise<YoutubeTrackDto[]> {
  const q = query.trim();
  if (!q) return [];
  const yt = await getClient();
  const res = await yt.search(q);
  const out: YoutubeTrackDto[] = [];
  for (const node of res.results as any[]) {
    if (node?.type !== "Video") continue;
    const track = toTrack(node);
    if (track) out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}

// url / id / playlist url pasted into the search bar
export async function resolveYoutubeInput(raw: string): Promise<YoutubeResolveResult> {
  const parsed = parseYoutubeInput(raw);
  if (parsed.kind === "none") return { kind: "none", tracks: [] };

  const yt = await getClient();

  if (parsed.kind === "video") {
    const info = await yt.getBasicInfo(parsed.id, { client: "ANDROID_VR" }).catch(() => yt.getBasicInfo(parsed.id));
    const b: any = info.basic_info;
    const track = toTrack({
      video_id: parsed.id,
      title: b?.title,
      author: { name: b?.author },
      duration: { seconds: b?.duration },
      is_live: b?.is_live,
      thumbnails: b?.thumbnail,
    });
    return track ? { kind: "video", tracks: [track] } : { kind: "none", tracks: [] };
  }

  const playlist: any = await yt.getPlaylist(parsed.id);
  const tracks: YoutubeTrackDto[] = [];
  for (const node of playlist.items as any[]) {
    const track = toTrack(node);
    if (track) tracks.push(track);
    if (tracks.length >= PLAYLIST_LIMIT) break;
  }
  return { kind: "playlist", title: playlist.info?.title ?? "YouTube", tracks };
}

export async function getYoutubeStream(videoId: string): Promise<YoutubeStreamDto> {
  const cached = streamCache.get(videoId);
  if (cached && Date.now() - cached.at < STREAM_TTL_MS) return cached.stream;

  const yt = await getClient();
  let lastError: unknown = new Error("no playable audio format");

  for (const client of STREAM_CLIENTS) {
    try {
      const info = await yt.getInfo(videoId, { client });
      const status = info.playability_status?.status;
      if (status && status !== "OK") {
        lastError = new Error(info.playability_status?.reason || status);
        continue;
      }

      let format;
      try {
        format = info.chooseFormat({ type: "audio", quality: "best", format: "mp4" });
      } catch {
        format = info.chooseFormat({ type: "audio", quality: "best" });
      }

      const url = await format.decipher(yt.session.player);
      if (!url) continue;

      const mimeType = (format.mime_type ?? "audio/mp4").split(";")[0]!;
      const stream: YoutubeStreamDto = {
        url,
        mimeType,
        codec: mimeType.includes("webm") || /opus/i.test(format.mime_type ?? "") ? "opus" : "aac",
        bitrate: format.bitrate ?? 128000,
        expiresAt: info.streaming_data?.expires?.toISOString(),
      };
      streamCache.set(videoId, { at: Date.now(), stream });
      return stream;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
