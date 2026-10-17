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

  it("points bot checks at the youtube login, even when the message is cut", () => {
    const msg = `no playable audio stream (TV: Sign in to confirm you're not a bot; ${"y".repeat(500)})`;
    const out = describeStreamError(msg, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("Entrar com Google")).toBe(true);
  });
});
