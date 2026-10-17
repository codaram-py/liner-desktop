// streams from the local providers are played from memory: the whole file is downloaded first, then handed to the
// <audio> element as a blob. no range requests, no connection that can die halfway, seeking always works.
// long files (podcasts, hour long mixes) are streamed instead
export const MAX_BLOB_BYTES = 60 * 1024 * 1024;
export const MAX_BLOB_DURATION_MS = 25 * 60 * 1000;

export async function downloadAudioBlob(
  url: string,
  mimeType: string,
  signal?: AbortSignal,
  maxBytes = MAX_BLOB_BYTES,
): Promise<Blob | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`stream responded HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length")) || 0;
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }

  if (!res.body) return new Blob([await res.arrayBuffer()], { type: mimeType });

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  if (declared && size !== declared) throw new Error(`stream ended early (${size} of ${declared} bytes)`);
  if (size === 0) throw new Error("stream was empty");
  return new Blob(chunks as BlobPart[], { type: mimeType });
}
