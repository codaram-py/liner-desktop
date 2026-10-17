// @vitest-environment node
import { describe, expect, it } from "vitest";
import { downloadWhole } from "./youtubeDownload";

const DATA = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const src = { url: "https://g/v?x=1", contentLength: DATA.length, userAgent: "ua", headers: {} };

function serve(maxRange: number, seen: number[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const [a, b] = u.searchParams.get("range")!.split("-").map(Number) as [number, number];
    seen.push(b - a + 1);
    if (b - a + 1 > maxRange) return new Response("no", { status: 403 });
    return new Response(DATA.subarray(a, b + 1));
  }) as typeof fetch;
}

describe("downloadWhole", () => {
  it("downloads everything", async () => {
    const out = await downloadWhole(src, { fetchImpl: serve(1e9), makeCpn: () => "c", steps: [2000, 500, 100] });
    expect(out.equals(DATA)).toBe(true);
  });

  it("falls back to smaller chunks on 403", async () => {
    const seen: number[] = [];
    const out = await downloadWhole(src, { fetchImpl: serve(500, seen), makeCpn: () => "c", steps: [2000, 500, 100] });
    expect(out.equals(DATA)).toBe(true);
    expect(seen[0]).toBe(2000);
    expect(seen).toContain(500);
  });

  it("fails when even the smallest step is refused", async () => {
    await expect(downloadWhole(src, { fetchImpl: serve(10), makeCpn: () => "c", steps: [2000, 500, 100] })).rejects.toThrow(/download failed at byte 0/);
  });

  it("refuses huge files", async () => {
    await expect(downloadWhole({ ...src, contentLength: 100 * 1024 * 1024 }, { fetchImpl: serve(1e9), makeCpn: () => "c" })).rejects.toThrow(/too large/);
  });
});
