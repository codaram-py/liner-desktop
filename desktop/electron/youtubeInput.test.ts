import { describe, expect, it } from "vitest";
import { parseYoutubeInput } from "./youtubeInput";

describe("parseYoutubeInput", () => {
  it("parses a bare video id", () => {
    expect(parseYoutubeInput("dQw4w9WgXcQ")).toEqual({ kind: "video", id: "dQw4w9WgXcQ" });
  });

  it("parses watch, short, music, shorts and embed urls", () => {
    const id = "dQw4w9WgXcQ";
    for (const url of [
      `https://www.youtube.com/watch?v=${id}&t=42s`,
      `https://youtu.be/${id}?si=abc`,
      `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`,
      `https://m.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `youtube.com/watch?v=${id}`,
    ]) {
      expect(parseYoutubeInput(url)).toEqual({ kind: "video", id });
    }
  });

  it("parses playlist urls without a video", () => {
    expect(parseYoutubeInput("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toEqual({
      kind: "playlist",
      id: "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    });
  });

  it("ignores plain text and foreign hosts", () => {
    expect(parseYoutubeInput("daft punk around the world")).toEqual({ kind: "none" });
    expect(parseYoutubeInput("https://vimeo.com/123456789")).toEqual({ kind: "none" });
    expect(parseYoutubeInput("")).toEqual({ kind: "none" });
  });
});
