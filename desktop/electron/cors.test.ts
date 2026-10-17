import { describe, expect, it } from "vitest";
import { withOpenCors } from "./cors";

describe("withOpenCors", () => {
  it("replaces server cors headers instead of duplicating them and keeps everything else", () => {
    const out = withOpenCors({
      responseHeaders: {
        "Access-Control-Allow-Origin": ["https://other.example"],
        "Content-Range": ["bytes 0-9/100"],
        "content-type": ["audio/mpeg"],
      },
      statusLine: "HTTP/1.1 206 Partial Content",
    });
    expect(out.statusLine).toBe("HTTP/1.1 206 Partial Content");
    expect(out.responseHeaders["access-control-allow-origin"]).toEqual(["*"]);
    expect(Object.keys(out.responseHeaders).filter((k) => /allow-origin/i.test(k))).toHaveLength(1);
    expect(out.responseHeaders["Content-Range"]).toEqual(["bytes 0-9/100"]);
    expect(out.responseHeaders["content-type"]).toEqual(["audio/mpeg"]);
  });

  it("works without headers or a status line", () => {
    expect(withOpenCors({})).toEqual({
      responseHeaders: {
        "access-control-allow-origin": ["*"],
        "access-control-allow-headers": ["*"],
        "access-control-allow-methods": ["GET, HEAD, OPTIONS"],
      },
    });
  });
});
