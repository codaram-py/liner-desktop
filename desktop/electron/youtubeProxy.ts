import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// googlevideo urls for the ios / android clients answer 403 unless the request looks like that client's own player:
// matching user-agent, youtube origin/referer and the ranged `&range=a-b&cpn=...` query form instead of a Range header.
// chromium cannot send that, so the <audio> element talks to this loopback proxy and the proxy talks to googlevideo.

export interface Upstream {
  url: string;
  contentLength: number;
  mimeType: string;
  userAgent: string;
  headers: Record<string, string>;
  // whole file when it was downloaded ahead of time, served straight from memory
  buffer?: Buffer;
}

export interface ProxyDeps {
  getUpstream: (videoId: string) => Promise<Upstream>;
  invalidate: (videoId: string) => void;
  fetchImpl?: typeof fetch;
  chunkBytes?: number;
  log?: (message: string) => void;
}

export interface YoutubeProxy {
  urlFor: (videoId: string) => string;
  close: () => Promise<void>;
}

export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CPN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function makeCpn(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += CPN_ALPHABET[b % CPN_ALPHABET.length];
  return out;
}

export function withRange(url: string, start: number, end: number, cpn: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}cpn=${cpn}&range=${start}-${end}`;
}

// single range only, which is all media elements send. null = no header, "invalid" = unsatisfiable
export function parseRange(header: string | undefined, total: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, a, b] = match;
  let start: number;
  let end: number;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "invalid";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(a);
    end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
  }
  if (start >= total || start > end) return "invalid";
  return { start, end };
}

class UpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`upstream responded ${status}`);
  }
}

export async function startYoutubeProxy(deps: ProxyDeps): Promise<YoutubeProxy> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const chunkBytes = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const log = deps.log ?? (() => {});
  // other local pages must not be able to use the proxy, the token only lives in this process and in the audio src
  const token = randomBytes(18).toString("base64url");

  async function fetchChunk(up: Upstream, start: number, end: number, cpn: string, signal: AbortSignal) {
    const res = await fetchImpl(withRange(up.url, start, end, cpn), {
      headers: { ...up.headers, "user-agent": up.userAgent },
      signal,
    });
    if (!res.ok || !res.body) throw new UpstreamError(res.status);
    return res;
  }

  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const fail = (status: number, message: string) => {
      // mid-stream there is no clean way to report it, cut the connection so the player sees a network error
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(message);
    };

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = /^\/yt\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
      if (!match || !VIDEO_ID_RE.test(match[1]!) || url.searchParams.get("k") !== token) return fail(404, "not found");
      if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method not allowed");

      const videoId = match[1]!;
      const up = await deps.getUpstream(videoId);
      const total = up.contentLength;
      const range = parseRange(req.headers.range, total);
      if (range === "invalid") {
        res.writeHead(416, { "content-range": `bytes */${total}`, "access-control-allow-origin": "*" });
        return res.end();
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? total - 1;
      const headers: http.OutgoingHttpHeaders = {
        "content-type": up.mimeType,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${total}`;

      if (req.method === "HEAD") {
        res.writeHead(range ? 206 : 200, headers);
        return res.end();
      }

      if (up.buffer && up.buffer.length === total) {
        res.writeHead(range ? 206 : 200, headers);
        return res.end(up.buffer.subarray(start, end + 1));
      }

      const cpn = makeCpn();
      let pos = start;
      // the first chunk is fetched before the head is written so an upstream 403 reaches the player as a 403
      let current = await fetchChunk(up, pos, Math.min(pos + chunkBytes - 1, end), cpn, abort.signal);
      res.writeHead(range ? 206 : 200, headers);

      while (true) {
        const chunkEnd = Math.min(pos + chunkBytes - 1, end);
        let received = 0;
        for await (const piece of current.body as unknown as AsyncIterable<Uint8Array>) {
          received += piece.byteLength;
          if (!res.write(piece)) await once(res, "drain");
        }
        if (received !== chunkEnd - pos + 1) throw new Error(`short upstream chunk: got ${received} of ${chunkEnd - pos + 1} bytes`);
        pos = chunkEnd + 1;
        if (pos > end) break;
        current = await fetchChunk(up, pos, Math.min(pos + chunkBytes - 1, end), cpn, abort.signal);
      }
      res.end();
    } catch (err) {
      if (abort.signal.aborted) return;
      const videoId = /\/yt\/([A-Za-z0-9_-]{11})/.exec(req.url ?? "")?.[1];
      if (videoId) deps.invalidate(videoId);
      if (err instanceof UpstreamError) {
        log(`proxy: upstream ${err.status} for ${videoId}`);
        return fail(err.status, "upstream error");
      }
      log(`proxy: ${err instanceof Error ? err.message : String(err)}`);
      fail(502, "proxy error");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    urlFor: (videoId) => `http://127.0.0.1:${port}/yt/${videoId}?k=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
