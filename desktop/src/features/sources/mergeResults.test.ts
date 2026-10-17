import { describe, expect, it } from "vitest";
import { interleave, mergeTrackVariants, normalizeArtist, normalizeTitle } from "./mergeResults";
import { buildSearchResults } from "./buildResults";
import { splitYoutubeTitle } from "./providers";

const t = (id: string, title: string, artists: string, durationMs = 200_000) => ({
  id,
  title,
  artists,
  coverUrl: "",
  durationMs,
});

describe("normalize", () => {
  it("strips noise, accents and featuring tails", () => {
    expect(normalizeTitle("Beyoncé – Halo (Official Video)")).toBe(normalizeTitle("beyonce – halo"));
    expect(normalizeTitle("Song (feat. Someone)")).toBe("song");
    expect(normalizeTitle("Song - Remastered 2011")).toBe("song");
  });

  it("keeps only the lead artist", () => {
    expect(normalizeArtist("Daft Punk, Pharrell Williams")).toBe("daftpunk");
    expect(normalizeArtist("A & B")).toBe("a");
  });
});

describe("mergeTrackVariants", () => {
  it("merges the same song across sources and keeps the best source as primary", () => {
    const merged = mergeTrackVariants([
      t("yt:aaaaaaaaaaa", "Get Lucky (Official Video)", "Daft Punk", 369_000),
      t("dz:1", "Get Lucky", "Daft Punk", 368_000),
      t("am:2", "Get Lucky", "Daft Punk", 369_500),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("youtube");
    expect(merged[0]!.variants?.map((v) => v.source)).toEqual(["youtube", "deezer", "apple_music"]);
  });

  it("does not merge different songs, wildly different lengths or two copies from one source", () => {
    const merged = mergeTrackVariants([
      t("yt:aaaaaaaaaaa", "Halo", "Beyonce", 261_000),
      t("dz:1", "Halo", "Beyonce", 60_000 * 9),
      t("yt:bbbbbbbbbbb", "Halo", "Beyonce", 261_000),
      t("dz:2", "Halo 2", "Beyonce", 261_000),
    ]);
    expect(merged).toHaveLength(4);
    expect(merged.every((m) => !m.variants)).toBe(true);
  });

  it("never merges rows without an artist", () => {
    const merged = mergeTrackVariants([t("yt:aaaaaaaaaaa", "Intro", ""), t("dz:1", "Intro", "")]);
    expect(merged).toHaveLength(2);
  });
});

describe("interleave", () => {
  it("round robins uneven lists", () => {
    expect(interleave([[1, 2, 3], [], [4, 5]])).toEqual([1, 4, 2, 5, 3]);
  });
});

describe("buildSearchResults", () => {
  const liner = [
    { _type: "artist", id: "ar1", title: "Daft Punk", artists: "" },
    { _type: "track", ...t("ln1", "Get Lucky", "Daft Punk", 369_000) },
    { _type: "album", id: "al1", title: "RAM", artists: "" },
  ];
  const external = [
    { ...t("yt:aaaaaaaaaaa", "Get Lucky", "Daft Punk", 369_000), playCount: 0, source: "youtube" as const },
    { ...t("dz:1", "Get Lucky", "Daft Punk", 369_000), playCount: 0, source: "deezer" as const, previewOnly: true },
    { ...t("yt:bbbbbbbbbbb", "Other Song", "Someone", 180_000), playCount: 0, source: "youtube" as const },
  ];

  it("keeps the top-hit entity first and groups copies into +N variants", () => {
    const rows = buildSearchResults({ linerItems: liner, external, sourceFilter: "all" });
    expect(rows.map((r) => r.id)).toEqual(["ar1", "ln1", "yt:bbbbbbbbbbb", "al1"]);
    expect(rows[1]!.variants).toHaveLength(3);
  });

  it("filters by source, drops entities and plays that source's copy", () => {
    const rows = buildSearchResults({ linerItems: liner, external, sourceFilter: "deezer" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dz:1", source: "deezer", previewOnly: true });
    expect(rows[0]!.variants).toHaveLength(3);
  });
});

describe("splitYoutubeTitle", () => {
  it("splits 'Artist - Song' and removes video noise", () => {
    expect(splitYoutubeTitle("Rick Astley - Never Gonna Give You Up (Official Video) [4K]", "RickAstleyVEVO")).toEqual({
      artists: "Rick Astley",
      title: "Never Gonna Give You Up",
    });
  });

  it("falls back to the channel name", () => {
    expect(splitYoutubeTitle("lofi hip hop mix", "Lofi Girl")).toEqual({ title: "lofi hip hop mix", artists: "Lofi Girl" });
  });
});
