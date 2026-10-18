import { describe, expect, it } from "vitest";
import { wheelSeekTarget } from "./wheelSeek";

describe("wheelSeekTarget", () => {
  it("scroll up skips 10s forward, scroll down goes 10s back", () => {
    expect(wheelSeekTarget(-100, 30_000, 200_000)).toBe(40_000);
    expect(wheelSeekTarget(100, 30_000, 200_000)).toBe(20_000);
  });

  it("clamps to the track", () => {
    expect(wheelSeekTarget(100, 4_000, 200_000)).toBe(0);
    expect(wheelSeekTarget(-100, 195_000, 200_000)).toBe(200_000);
  });

  it("does nothing without movement or a duration", () => {
    expect(wheelSeekTarget(0, 1000, 200_000)).toBeNull();
    expect(wheelSeekTarget(-100, 0, 0)).toBeNull();
  });
});
