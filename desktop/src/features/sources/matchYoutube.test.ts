import { describe, expect, it } from "vitest";
import { pickBestYoutubeMatch } from "./matchYoutube";

const c = (title: string, artists: string, seconds: number) => ({ title, artists, durationMs: seconds * 1000 });

describe("pickBestYoutubeMatch", () => {
  const target = { title: "Rabetão", artists: "MC Lan", durationMs: 192_000 };

  it("prefers the studio upload over live, remix and slowed versions", () => {
    const studio = c("Rabetão", "MC Lan", 191);
    const best = pickBestYoutubeMatch(target, [
      c("Rabetão (Ao Vivo)", "MC Lan", 192),
      c("Rabetão (Remix)", "DJ Fulano", 192),
      c("Rabetão slowed + reverb", "Some Channel", 192),
      studio,
    ]);
    expect(best).toBe(studio);
  });

  it("picks the closest duration when titles tie", () => {
    const exact = c("Rabetão", "MC Lan", 192);
    expect(pickBestYoutubeMatch(target, [c("Rabetão", "MC Lan", 214), exact, c("Rabetão", "MC Lan", 175)])).toBe(exact);
  });

  it("recognises the artist even when it only appears in the title", () => {
    const upload = c("MC Lan - Rabetão (KondZilla)", "KondZilla", 192);
    expect(pickBestYoutubeMatch(target, [upload])).toBe(upload);
  });

  it("returns null for unrelated titles, wildly different lengths or no candidates", () => {
    expect(pickBestYoutubeMatch(target, [c("Another Song Entirely", "MC Lan", 192)])).toBeNull();
    expect(pickBestYoutubeMatch(target, [c("Rabetão", "MC Lan", 3600)])).toBeNull();
    expect(pickBestYoutubeMatch(target, [])).toBeNull();
  });

  it("keeps a live version when the track itself is live", () => {
    const live = c("Halo (Live)", "Beyonce", 260);
    expect(pickBestYoutubeMatch({ title: "Halo (Live)", artists: "Beyonce", durationMs: 260_000 }, [live])).toBe(live);
  });
});
