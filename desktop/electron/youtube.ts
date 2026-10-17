import { Constants, Innertube, Log } from "youtubei.js";
import { createSecureFileCache } from "./secureFileCache.js";
import type { SecretBox } from "./spotifyAuth.js";
import { createYoutubeLogin, type LoginSession, type YoutubeLoginStatus } from "./youtubeLogin.js";
import { parseYoutubeInput } from "./youtubeInput.js";
import { downloadWhole, MAX_BUFFER_BYTES } from "./youtubeDownload.js";
import { makeCpn, startYoutubeProxy, withRange, type Upstream, type YoutubeProxy } from "./youtubeProxy.js";

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

// order matters: clients that usually hand out plain googlevideo urls first, the ones that need a po token last.
// every candidate is probed with a real ranged request, a client whose urls answer 403 is skipped instead of reaching the player
const STREAM_CLIENTS = ["ANDROID_VR", "TV_SIMPLY", "TV_EMBEDDED", "WEB_EMBEDDED", "TV", "ANDROID", "IOS", "WEB"] as const;
const CLIENT_TIMEOUT_MS = 45_000;
const UPSTREAM_TTL_MS = 10 * 60 * 1000;
const PLAYLIST_LIMIT = 100;
const MAX_CACHED = 4; // each entry can hold up to 60 MB

type StreamClient = (typeof STREAM_CLIENTS)[number];

interface ResolvedUpstream extends Upstream {
  at: number;
  client: StreamClient;
  codec: "opus" | "aac";
  bitrate: number;
  expiresAt?: string;
}

const log = (message: string) => console.log(`\x1b[44;37m youtube \x1b[0m ${message}`);

// a signed in session (tv device flow) is what gets past "sign in to confirm you're not a bot", so the tv client leads then
const SIGNED_IN_CLIENTS: readonly StreamClient[] = ["TV", "ANDROID_VR", "TV_SIMPLY", "WEB_EMBEDDED", "TV_EMBEDDED", "ANDROID", "IOS", "WEB"];

let clientPromise: Promise<Innertube> | null = null;
let secretCache: ReturnType<typeof createSecureFileCache> | undefined;
let signedIn = false;

// call once at startup: google login (if any) is kept in <dataDir>/youtube-session.json, encrypted with the os keychain
export function configureYoutube(opts: { dataDir: string; box: SecretBox }): void {
  secretCache = createSecureFileCache(`${opts.dataDir.replace(/[\\/]+$/, "")}/youtube-session.json`, opts.box);
  clientPromise = null;
  signedIn = false;
  upstreams.clear();
}

function getClient(): Promise<Innertube> {
  if (!clientPromise) {
    // youtubei.js logs a parser warning for every unknown node, that is noise here
    Log.setLevel(Log.Level.ERROR);
    clientPromise = (async () => {
      const yt = await Innertube.create({ generate_session_locally: true, cache: secretCache as any });
      yt.session.on("update-credentials", () => void yt.session.oauth.cacheCredentials().catch(() => {}));
      if (secretCache && (await secretCache.get("youtubei_oauth_credentials"))) {
        try {
          await Promise.race([yt.session.signIn(), new Promise<never>((_, r) => setTimeout(() => r(new Error("timed out")), 15_000))]);
          signedIn = true;
          youtubeLogin.markLoggedIn(true);
          log("signed in from saved credentials");
        } catch (err) {
          log(`saved login could not be used: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return yt;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export const youtubeLogin = createYoutubeLogin({
  getSession: async () => (await getClient()).session as unknown as LoginSession,
  onChange: () => {
    signedIn = youtubeLogin.status().loggedIn;
    upstreams.clear();
  },
});

export const getYoutubeLoginStatus = async (): Promise<YoutubeLoginStatus> => {
  await getClient().catch(() => {});
  return youtubeLogin.status();
};

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

// the web client has no user agent in the library constants, any current desktop chrome string works for it
const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function userAgentFor(client: StreamClient): string {
  const clients = Constants.CLIENTS as unknown as Record<string, { USER_AGENT?: string }>;
  return clients[client]?.USER_AGENT ?? WEB_USER_AGENT;
}

const upstreams = new Map<string, ResolvedUpstream>();
const inflight = new Map<string, Promise<ResolvedUpstream>>();
let proxyPromise: Promise<YoutubeProxy> | null = null;

function getProxy(): Promise<YoutubeProxy> {
  if (!proxyPromise) {
    proxyPromise = startYoutubeProxy({
      getUpstream: resolveUpstream,
      invalidate: (id) => upstreams.delete(id),
      log,
    }).catch((err) => {
      proxyPromise = null;
      throw err;
    });
  }
  return proxyPromise;
}

async function probe(url: string, userAgent: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(withRange(url, 0, 1, "probeprobeprobe00"), {
      headers: { ...headers, "user-agent": userAgent },
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function resolveClient(yt: Innertube, videoId: string, client: StreamClient): Promise<ResolvedUpstream> {
  const info = await yt.getInfo(videoId, { client });
  const status = info.playability_status?.status;
  if (status && status !== "OK") throw new Error(info.playability_status?.reason || status);

  let format;
  try {
    format = info.chooseFormat({ type: "audio", quality: "best", format: "mp4" });
  } catch {
    format = info.chooseFormat({ type: "audio", quality: "best" });
  }

  const url = await format.decipher(yt.session.player);
  if (!url) throw new Error("format has no url");

  const contentLength = Number(format.content_length ?? new URL(url).searchParams.get("clen"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw new Error("unknown content length");

  const headers = { ...(Constants.STREAM_HEADERS as Record<string, string>) };
  const userAgent = userAgentFor(client);
  const failure = await probe(url, userAgent, headers);
  if (failure) throw new Error(`probe failed: ${failure}`);

  // the player gets the bytes from memory, so a googlevideo 403 on a later range cannot reach it. a client whose
  // url cannot be downloaded whole is rejected here and the next one is tried
  let buffer: Buffer | undefined;
  if (contentLength <= MAX_BUFFER_BYTES) {
    buffer = await downloadWhole({ url, contentLength, userAgent, headers }, { makeCpn });
  }

  const mimeType = (format.mime_type ?? "audio/mp4").split(";")[0]!;
  return {
    buffer,
    url,
    contentLength,
    mimeType,
    userAgent,
    headers,
    at: Date.now(),
    client,
    codec: mimeType.includes("webm") || /opus/i.test(format.mime_type ?? "") ? "opus" : "aac",
    bitrate: format.bitrate ?? 128000,
    expiresAt: info.streaming_data?.expires?.toISOString(),
  };
}

async function resolveUpstream(videoId: string): Promise<ResolvedUpstream> {
  const cached = upstreams.get(videoId);
  if (cached && Date.now() - cached.at < UPSTREAM_TTL_MS) return cached;
  const pending = inflight.get(videoId);
  if (pending) return pending;

  const run = (async () => {
    const yt = await getClient();
    const errors: string[] = [];
    for (const client of signedIn ? SIGNED_IN_CLIENTS : STREAM_CLIENTS) {
      try {
        const resolved = await Promise.race([
          resolveClient(yt, videoId, client),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${CLIENT_TIMEOUT_MS / 1000}s`)), CLIENT_TIMEOUT_MS)),
        ]);
        log(`${videoId} ok via ${client} (${resolved.mimeType}, ${resolved.contentLength} bytes)`);
        upstreams.set(videoId, resolved);
        while (upstreams.size > MAX_CACHED) upstreams.delete(upstreams.keys().next().value!);
        return resolved;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`${videoId} ${client} failed: ${reason}`);
        errors.push(`${client}: ${reason}`);
      }
    }
    throw new Error(`no playable audio stream (${errors.join("; ")})`);
  })().finally(() => inflight.delete(videoId));

  inflight.set(videoId, run);
  return run;
}

export async function getYoutubeStream(videoId: string): Promise<YoutubeStreamDto> {
  const [upstream, proxy] = await Promise.all([resolveUpstream(videoId), getProxy()]);
  return {
    url: proxy.urlFor(videoId),
    mimeType: upstream.mimeType,
    codec: upstream.codec,
    bitrate: upstream.bitrate,
    expiresAt: upstream.expiresAt,
  };
}
