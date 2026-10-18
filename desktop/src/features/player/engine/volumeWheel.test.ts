import { describe, expect, it } from "vitest";
import { stepVolumeLevel } from "./volume";

describe("stepVolumeLevel", () => {
  it("up adds 5 points, down removes 5", () => {
    expect(stepVolumeLevel(0.24, -100)).toBe(0.29);
    expect(stepVolumeLevel(0.24, 100)).toBe(0.19);
  });
  it("clamps to 0..1 and ignores a zero delta", () => {
    expect(stepVolumeLevel(0.98, -100)).toBe(1);
    expect(stepVolumeLevel(0.02, 100)).toBe(0);
    expect(stepVolumeLevel(0.5, 0)).toBe(0.5);
  });
});
