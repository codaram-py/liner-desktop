// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ensureSignatureTimestamp, extractSignatureTimestamp } from "./youtubePlayer";

const js = (body: string) => (async () => new Response(body)) as unknown as typeof fetch;

describe("signature timestamp", () => {
  it("extracts the timestamp from the usual shapes", () => {
    expect(extractSignatureTimestamp("a;signatureTimestamp:20512,b")).toBe(20512);
    expect(extractSignatureTimestamp('x={sts:20513,y:1}')).toBe(20513);
    expect(extractSignatureTimestamp('"signatureTimestamp"=20514')).toBe(20514);
    expect(extractSignatureTimestamp("nothing here")).toBeNull();
  });

  it("leaves a valid timestamp alone and never fetches", async () => {
    const fetchImpl = vi.fn();
    const player = { player_id: "abc", signature_timestamp: 20000 };
    expect(await ensureSignatureTimestamp(player, fetchImpl as any)).toMatch(/sts=20000/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("patches a zero timestamp from base.js", async () => {
    const player = { player_id: "abc12345", signature_timestamp: 0 };
    expect(await ensureSignatureTimestamp(player, js("var g={signatureTimestamp:20999}"))).toMatch(/patched/);
    expect(player.signature_timestamp).toBe(20999);
  });

  it("reports instead of throwing when base.js cannot be used", async () => {
    const player = { player_id: "abc12345", signature_timestamp: 0 };
    expect(await ensureSignatureTimestamp(player, js("no timestamp"))).toMatch(/not found/);
    expect(await ensureSignatureTimestamp(player, (async () => { throw new Error("offline"); }) as any)).toMatch(/offline/);
    expect(player.signature_timestamp).toBe(0);
  });
});
