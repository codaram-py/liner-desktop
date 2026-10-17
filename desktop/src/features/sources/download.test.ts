import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAudioBlob } from "./download";

const stream = (parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });

const respond = (body: BodyInit | null, init: ResponseInit = {}) => vi.stubGlobal("fetch", async () => new Response(body, init));

afterEach(() => vi.unstubAllGlobals());

describe("downloadAudioBlob", () => {
  it("collects the whole body into a typed blob", async () => {
    respond(stream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), { headers: { "content-length": "5" } });
    const blob = await downloadAudioBlob("http://x/a", "audio/mpeg");
    expect(blob?.type).toBe("audio/mpeg");
    expect(blob?.size).toBe(5);
  });

  it("returns null instead of buffering files over the limit, declared or not", async () => {
    respond(new Uint8Array(100), { headers: { "content-length": "100" } });
    expect(await downloadAudioBlob("http://x/a", "audio/mpeg", undefined, 50)).toBeNull();

    respond(stream([new Uint8Array(40), new Uint8Array(40)]));
    expect(await downloadAudioBlob("http://x/a", "audio/mpeg", undefined, 50)).toBeNull();
  });

  it("fails loudly on http errors, truncated bodies and empty bodies", async () => {
    respond("nope", { status: 403 });
    await expect(downloadAudioBlob("http://x/a", "audio/mpeg")).rejects.toThrow("HTTP 403");

    vi.stubGlobal("fetch", async () => {
      const res = new Response(stream([new Uint8Array(3)]));
      Object.defineProperty(res.headers, "get", { value: (k: string) => (k === "content-length" ? "10" : null) });
      return res;
    });
    await expect(downloadAudioBlob("http://x/a", "audio/mpeg")).rejects.toThrow("ended early (3 of 10");

    respond(stream([]));
    await expect(downloadAudioBlob("http://x/a", "audio/mpeg")).rejects.toThrow("empty");
  });
});
