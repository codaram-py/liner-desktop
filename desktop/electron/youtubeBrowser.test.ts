// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pickAudioRequest } from "./youtubeBrowser";

const base = "https://rr3---sn-abc.googlevideo.com/videoplayback";
const q = (params: Record<string, string>) => `${base}?${new URLSearchParams(params)}`;

describe("pickAudioRequest", () => {
  it("accepts a content audio request and strips the per-chunk keys", () => {
    const hit = pickAudioRequest(q({ mime: "audio/webm", clen: "3102611", source: "youtube", pot: "TOKEN", range: "0-1048575", rn: "3", rbuf: "9000", itag: "251" }));
    expect(hit).not.toBeNull();
    expect(hit!.contentLength).toBe(3102611);
    expect(hit!.mimeType).toBe("audio/webm");
    const kept = new URL(hit!.url).searchParams;
    expect(kept.get("pot")).toBe("TOKEN");
    expect(kept.get("itag")).toBe("251");
    expect(kept.has("range")).toBe(false);
    expect(kept.has("rn")).toBe(false);
  });

  it("ignores video, ads, other hosts and malformed urls", () => {
    expect(pickAudioRequest(q({ mime: "video/mp4", clen: "1000", source: "youtube" }))).toBeNull();
    expect(pickAudioRequest(q({ mime: "audio/mp4", clen: "1000", source: "yt_ad" }))).toBeNull();
    expect(pickAudioRequest(q({ mime: "audio/mp4", clen: "1000", oad: "1" }))).toBeNull();
    expect(pickAudioRequest(q({ mime: "audio/mp4" }))).toBeNull(); // no clen
    expect(pickAudioRequest(`https://example.com/videoplayback?mime=audio/mp4&clen=5`)).toBeNull();
    expect(pickAudioRequest("not a url")).toBeNull();
    expect(pickAudioRequest("https://rr1.googlevideo.com/generate_204")).toBeNull();
  });
});
