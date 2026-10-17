import { describe, expect, it } from "vitest";
import { interleave, mergeTrackVariants, normalizeArtist, normalizeTitle } from "./mergeResults";
import { buildSearchResults } from "./buildResults";
import { splitYoutubeTitle } from "./providers";
import { isPreviewTrackId, makeExternalId, playsViaYoutube, rawExternalId, sourceOfTrackId } from "./types";

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
  const ext = (id: string, title: string, artists: string, source: "youtube" | "deezer" | "apple_music" | "soundcloud", extra = {}) => ({
    ...t(id, title, artists, 369_000),
    playCount: 0,
    source,
    ...extra,
  });
  const external = [
    ext("yt:aaaaaaaaaaa", "Get Lucky", "Daft Punk", "youtube"),
    ext("sc:42", "Get Lucky", "Daft Punk", "soundcloud"),
    ext("dz:1", "Get Lucky", "Daft Punk", "deezer"),
    ext("dzp:1", "Get Lucky", "Daft Punk", "deezer", { previewOnly: true }),
    ext("amp:9", "Other Song", "Someone", "apple_music", { previewOnly: true }),
    { ...ext("yt:bbbbbbbbbbb", "Other Song", "Someone", "youtube"), durationMs: 180_000 },
  ];

  it("keeps the top-hit entity first and groups copies into +N variants, previews stay out", () => {
    const rows = buildSearchResults({ linerItems: liner, external, sourceFilter: "all" });
    expect(rows.map((r) => r.id)).toEqual(["ar1", "ln1", "yt:bbbbbbbbbbb", "al1"]);
    expect(rows[1]!.variants?.map((v: { source: string }) => v.source)).toEqual(["liner", "youtube", "soundcloud", "deezer"]);
    expect(rows.some((r) => r.previewOnly)).toBe(false);
  });

  it("filters by source, drops entities and plays that source's copy", () => {
    const rows = buildSearchResults({ linerItems: liner, external, sourceFilter: "deezer" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dz:1", source: "deezer" });
    expect(rows[0]!.previewOnly).toBeFalsy();
    expect(rows[0]!.variants).toHaveLength(4);
  });

  it("lists every 30s clip under the preview filter and nothing else", () => {
    const rows = buildSearchResults({ linerItems: liner, external, sourceFilter: "preview" });
    expect(rows.map((r) => r.id)).toEqual(["dzp:1", "amp:9"]);
    expect(rows.every((r) => r.previewOnly && r._type === "track")).toBe(true);
    expect(rows.every((r) => !r.variants)).toBe(true);
  });

  it("snippet-only soundcloud tracks count as previews", () => {
    const snip = ext("sc:77", "Gated", "Artist", "soundcloud", { previewOnly: true });
    expect(buildSearchResults({ linerItems: [], external: [snip], sourceFilter: "soundcloud" })).toEqual([]);
    expect(buildSearchResults({ linerItems: [], external: [snip], sourceFilter: "preview" }).map((r) => r.id)).toEqual(["sc:77"]);
  });
});

describe("track ids", () => {
  it("keeps full and preview ids apart and maps them to the right source", () => {
    expect(makeExternalId("deezer", 5)).toBe("dz:5");
    expect(makeExternalId("deezer", 5, true)).toBe("dzp:5");
    expect(makeExternalId("apple_music", 7, true)).toBe("amp:7");
    expect(makeExternalId("soundcloud", 9, true)).toBe("sc:9");
    expect(sourceOfTrackId("dzp:5")).toBe("deezer");
    expect(sourceOfTrackId("sc:9")).toBe("soundcloud");
    expect(isPreviewTrackId("dzp:5")).toBe(true);
    expect(isPreviewTrackId("dz:5")).toBe(false);
    expect(rawExternalId("amp:7")).toBe("7");
    expect(playsViaYoutube("deezer")).toBe(true);
    expect(playsViaYoutube("soundcloud")).toBe(false);
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
