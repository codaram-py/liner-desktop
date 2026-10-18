import { Constants, Innertube, Log } from "youtubei.js";
import { createSecureFileCache } from "./secureFileCache.js";
import type { SecretBox } from "./spotifyAuth.js";
import { createYoutubeLogin, type LoginSession, type YoutubeLoginStatus } from "./youtubeLogin.js";
import { parseYoutubeInput } from "./youtubeInput.js";
import { captureAudioUrl } from "./youtubeBrowser.js";
import { ensureSignatureTimestamp } from "./youtubePlayer.js";
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
  client: StreamClient | "BROWSER";
  codec: "opus" | "aac";
  bitrate: number;
  expiresAt?: string;
}

const log = (message: string) => console.log(`\x1b[44;37m youtube \x1b[0m ${message}`);

// the oauth token belongs to the tv app: youtubei.js sends it as a bearer on EVERY request of a signed in session and
// youtube answers 400 to anything that is not a tv client (search included). so there are two sessions: an anonymous one
// for search, metadata and the regular clients, and a signed in one used only for the tv clients
const AUTH_CLIENTS: readonly StreamClient[] = ["TV", "TV_SIMPLY", "TV_EMBEDDED"];

let anonPromise: Promise<Innertube> | null = null;
let authPromise: Promise<Innertube> | null = null;
let secretCache: ReturnType<typeof createSecureFileCache> | undefined;
let signedIn = false;

// call once at startup: google login (if any) is kept in <dataDir>/youtube-session.json, encrypted with the os keychain
// bumped whenever the youtube path changes, printed at startup so a log says which build produced it
const BUILD_TAG = "yt-2026-10-18-capture-diag";

export function configureYoutube(opts: { dataDir: string; box: SecretBox }): void {
  log(`build ${BUILD_TAG}`);
  secretCache = createSecureFileCache(`${opts.dataDir.replace(/[\\/]+$/, "")}/youtube-session.json`, opts.box);
  anonPromise = null;
  authPromise = null;
  signedIn = false;
  upstreams.clear();
}

function getClient(): Promise<Innertube> {
  if (!anonPromise) {
    // youtubei.js logs a parser warning for every unknown node, that is noise here
    Log.setLevel(Log.Level.ERROR);
    anonPromise = (async () => {
      const yt = await Innertube.create({ generate_session_locally: true });
      log(`anonymous session: ${await ensureSignatureTimestamp(yt.session.player as any)}`);
      return yt;
    })().catch((err) => {
      anonPromise = null;
      throw err;
    });
  }
  return anonPromise;
}

// the signed in session. a real (not locally generated) visitor id, the account's tokens come from the secure cache
function getAuthClient(): Promise<Innertube> {
  if (!authPromise) {
    Log.setLevel(Log.Level.ERROR);
    authPromise = (async () => {
      const yt = await Innertube.create({ cache: secretCache as any });
      yt.session.on("update-credentials", () => void yt.session.oauth.cacheCredentials().catch(() => {}));
      log(`signed in session: ${await ensureSignatureTimestamp(yt.session.player as any)}`);
      return yt;
    })().catch((err) => {
      authPromise = null;
      throw err;
    });
  }
  return authPromise;
}

// silent sign in from saved credentials, once. false = nothing saved or the saved login is dead
async function restoreLogin(): Promise<boolean> {
  if (signedIn) return true;
  if (!secretCache || !(await secretCache.get("youtubei_oauth_credentials"))) return false;
  try {
    const yt = await getAuthClient();
    await Promise.race([yt.session.signIn(), new Promise<never>((_, r) => setTimeout(() => r(new Error("timed out")), 15_000))]);
    signedIn = true;
    youtubeLogin.markLoggedIn(true);
    log("signed in from saved credentials");
    return true;
  } catch (err) {
    log(`saved login could not be used: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export const youtubeLogin = createYoutubeLogin({
  getSession: async () => (await getAuthClient()).session as unknown as LoginSession,
  onChange: () => {
    signedIn = youtubeLogin.status().loggedIn;
    upstreams.clear();
  },
});

export const getYoutubeLoginStatus = async (): Promise<YoutubeLoginStatus> => {
  await restoreLogin();
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
  let res;
  try {
    res = await (await getClient()).search(q);
  } catch (err) {
    // a stale session (expired visitor data, a half initialised client) is the usual cause: start a fresh one once
    log(`search failed, retrying with a new session: ${err instanceof Error ? err.message : String(err)}`);
    anonPromise = null;
    res = await (await getClient()).search(q);
  }
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

async function probe(url: string, userAgent: string, headers: Record<string, string>, start = 0, end = 1): Promise<string | null> {
  try {
    const res = await fetch(withRange(url, start, end, "probeprobeprobe00"), {
      headers: { ...headers, "user-agent": userAgent },
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// some clients (ios without a po token) answer the first megabyte and 403 everything after it, a 2 byte probe cannot tell
const PAST_FIRST_CHUNK = 1_200_000;

async function resolveClient(yt: Innertube, videoId: string, client: StreamClient): Promise<ResolvedUpstream> {
  // getBasicInfo = the /player call only. getInfo also fires /next with the default web context, which a signed in
  // session answers with 400 (the oauth bearer is tv only) and which the stream does not need anyway
  const info = await yt.getBasicInfo(videoId, { client });
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
  if (contentLength > PAST_FIRST_CHUNK + 1024) {
    const late = await probe(url, userAgent, headers, PAST_FIRST_CHUNK, PAST_FIRST_CHUNK + 1);
    if (late) throw new Error(`stream is cut after the first chunk: ${late}`);
  }

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

// every innertube client refused: play the video in a hidden browser window and take the audio request it makes
async function resolveViaBrowser(videoId: string): Promise<ResolvedUpstream> {
  const cap = await captureAudioUrl(videoId);
  if (cap.contentLength > MAX_BUFFER_BYTES) throw new Error(`file too large to buffer (${cap.contentLength} bytes)`);
  const buffer = await downloadWhole(
    { url: cap.url, contentLength: cap.contentLength, userAgent: cap.userAgent, headers: cap.headers },
    { makeCpn, fetchImpl: cap.fetch },
  );
  return {
    buffer,
    url: cap.url,
    contentLength: cap.contentLength,
    mimeType: cap.mimeType,
    userAgent: cap.userAgent,
    headers: cap.headers,
    at: Date.now(),
    client: "BROWSER",
    codec: cap.mimeType.includes("webm") ? "opus" : "aac",
    bitrate: 128000,
  };
}

async function resolveUpstream(videoId: string): Promise<ResolvedUpstream> {
  const cached = upstreams.get(videoId);
  if (cached && Date.now() - cached.at < UPSTREAM_TTL_MS) return cached;
  const pending = inflight.get(videoId);
  if (pending) return pending;

  const run = (async () => {
    const anon = await getClient();
    await restoreLogin();
    const errors: string[] = [];
    const candidates: { yt: Innertube; client: StreamClient; tag: string }[] = [];
    if (signedIn) {
      const auth = await getAuthClient();
      for (const client of AUTH_CLIENTS) candidates.push({ yt: auth, client, tag: `${client}+login` });
    }
    for (const client of STREAM_CLIENTS) candidates.push({ yt: anon, client, tag: client });

    for (const { yt, client, tag } of candidates) {
      try {
        const attempt = () =>
          Promise.race([
            resolveClient(yt, videoId, client),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${CLIENT_TIMEOUT_MS / 1000}s`)), CLIENT_TIMEOUT_MS)),
          ]);
        // "The page needs to be reloaded" is youtube asking for the same request again
        const resolved = await attempt().catch((err: unknown) => {
          if (!/needs to be reloaded/i.test(err instanceof Error ? err.message : String(err))) throw err;
          return attempt();
        });
        log(`${videoId} ok via ${tag} (${resolved.mimeType}, ${resolved.contentLength} bytes)`);
        upstreams.set(videoId, resolved);
        while (upstreams.size > MAX_CACHED) upstreams.delete(upstreams.keys().next().value!);
        return resolved;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`${videoId} ${tag} failed: ${reason}`);
        errors.push(`${tag}: ${reason}`);
      }
    }
    try {
      const resolved = await resolveViaBrowser(videoId);
      log(`${videoId} ok via BROWSER (${resolved.mimeType}, ${resolved.contentLength} bytes)`);
      upstreams.set(videoId, resolved);
      while (upstreams.size > MAX_CACHED) upstreams.delete(upstreams.keys().next().value!);
      return resolved;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`${videoId} BROWSER failed: ${reason}`);
      // first, it is the most informative entry and the toast only shows the start of the message
      errors.unshift(`BROWSER: ${reason}`);
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
