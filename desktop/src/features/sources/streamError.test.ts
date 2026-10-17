import { describe, expect, it } from "vitest";
import { describeStreamError } from "./streamError";

describe("describeStreamError", () => {
  it("strips the ipc wrapper and trims long messages", () => {
    expect(describeStreamError("Error invoking remote method 'youtube:stream': Error: no playable audio stream (IOS: probe failed: HTTP 403)")).toBe(
      "no playable audio stream (IOS: probe failed: HTTP 403)",
    );
    expect(describeStreamError("plain message")).toBe("plain message");
    expect(describeStreamError("x".repeat(300), 20)).toBe(`${"x".repeat(19)}…`);
  });
});
