// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAppConfig } from "./appConfig";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "liner-cfg-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readAppConfig", () => {
  it("reads trimmed spotify credentials and ignores everything else", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ profile: { displayName: "x" }, spotify: { clientId: " id ", clientSecret: "  " } }),
    );
    expect(readAppConfig(dir)).toEqual({ spotify: { clientId: "id", clientSecret: undefined } });
  });

  it("returns an empty config for a missing or broken file", () => {
    expect(readAppConfig(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, "config.json"), "{ nope");
    expect(readAppConfig(dir)).toEqual({});
  });
});
