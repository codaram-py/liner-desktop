import { withRange } from "./youtubeProxy.js";

export const MAX_BUFFER_BYTES = 60 * 1024 * 1024;

// googlevideo sometimes answers 403 for big ranges on a url that passed the tiny probe, smaller ranges usually get through
export const CHUNK_STEPS = [1024 * 1024, 256 * 1024, 64 * 1024];

export interface DownloadSource {
  url: string;
  contentLength: number;
  userAgent: string;
  headers: Record<string, string>;
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  makeCpn: () => string;
  steps?: number[];
  timeoutMs?: number;
}

// whole file in memory, chunk by chunk. a 403/short read drops to the next smaller chunk size and retries the same offset.
// throws when even the smallest step fails so the caller can move on to another innertube client.
export async function downloadWhole(src: DownloadSource, deps: DownloadDeps): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const steps = deps.steps ?? CHUNK_STEPS;
  const total = src.contentLength;
  if (!Number.isFinite(total) || total <= 0) throw new Error("unknown content length");
  if (total > MAX_BUFFER_BYTES) throw new Error(`file too large to buffer (${total} bytes)`);

  const out = Buffer.allocUnsafe(total);
  const cpn = deps.makeCpn();
  let pos = 0;
  let step = 0;
  let lastError = "";

  while (pos < total) {
    const size = steps[step]!;
    const end = Math.min(pos + size - 1, total - 1);
    try {
      const res = await fetchImpl(withRange(src.url, pos, end, cpn), {
        headers: { ...src.headers, "user-agent": src.userAgent },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length !== end - pos + 1) throw new Error(`short read ${body.length}/${end - pos + 1}`);
      body.copy(out, pos);
      pos = end + 1;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      step += 1;
      if (step >= steps.length) throw new Error(`download failed at byte ${pos}/${total}: ${lastError}`);
    }
  }
  return out;
}
