import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

// soundcloud serves many tracks as hls only. mp3 segments, fmp4 segments (with an init map) and ogg pages all stay valid
// when appended one after another, so the proxy plays the playlist back as one continuous file the <audio> element can read

export interface ParsedPlaylist {
  init?: string;
  segments: string[];
}

export function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const abs = (uri: string) => new URL(uri, baseUrl).toString();
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== "#EXTM3U") throw new Error("not an m3u8 playlist");
  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) throw new Error("master playlists are not supported");
  if (lines.some((l) => /^#EXT-X-KEY:(?!METHOD=NONE)/.test(l))) throw new Error("encrypted hls is not supported");

  const mapLine = lines.find((l) => l.startsWith("#EXT-X-MAP:"));
  const init = mapLine ? /URI="([^"]+)"/.exec(mapLine)?.[1] : undefined;
  const segments = lines.filter((l) => l && !l.startsWith("#")).map(abs);
  if (segments.length === 0) throw new Error("playlist has no segments");
  return { init: init ? abs(init) : undefined, segments };
}

export interface HlsStream {
  playlistUrl: string;
  mimeType: string;
  headers?: Record<string, string>;
}

export interface HlsProxy {
  urlFor: (stream: HlsStream) => string;
  close: () => Promise<void>;
}

export async function startHlsProxy(deps: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<HlsProxy> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const token = randomBytes(18).toString("base64url");
  const streams = new Map<string, HlsStream>();

  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const fail = (status: number, message: string) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(message);
    };

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const match = /^\/hls\/([A-Za-z0-9_-]{16})$/.exec(url.pathname);
      const stream = match ? streams.get(match[1]!) : undefined;
      if (!stream || url.searchParams.get("k") !== token) return fail(404, "not found");
      if (req.method !== "GET") return fail(405, "method not allowed");

      const get = async (target: string) => {
        const r = await fetchImpl(target, { headers: stream.headers, signal: abort.signal });
        if (!r.ok || !r.body) throw new Error(`${new URL(target).host} responded ${r.status}`);
        return r;
      };

      const playlist = parsePlaylist(await (await get(stream.playlistUrl)).text(), stream.playlistUrl);
      const parts = [...(playlist.init ? [playlist.init] : []), ...playlist.segments];

      // first part before the head, so a dead playlist reaches the player as an error and not as an empty 200
      let current = await get(parts[0]!);
      res.writeHead(200, { "content-type": stream.mimeType, "accept-ranges": "none", "cache-control": "no-store", "access-control-allow-origin": "*" });
      for (let i = 0; i < parts.length; i++) {
        for await (const piece of current.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(piece)) await once(res, "drain");
        }
        if (i + 1 < parts.length) current = await get(parts[i + 1]!);
      }
      res.end();
    } catch (err) {
      if (abort.signal.aborted) return;
      log(`hls proxy: ${err instanceof Error ? err.message : String(err)}`);
      fail(502, "hls proxy error");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    urlFor: (stream) => {
      const id = randomBytes(12).toString("base64url").slice(0, 16);
      streams.set(id, stream);
      // old entries are never needed again, keep the map from growing over a long session
      if (streams.size > 200) streams.delete(streams.keys().next().value!);
      return `http://127.0.0.1:${port}/hls/${id}?k=${token}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
