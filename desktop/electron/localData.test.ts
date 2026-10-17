// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalData, resolveDataDir, saveLocalData } from "./localData";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "liner-local-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
  it("defaults to ~/Liner and honours LINER_DATA_DIR", () => {
    expect(resolveDataDir("/home/u", {})).toBe(path.join("/home/u", "Liner"));
    expect(resolveDataDir("/home/u", { LINER_DATA_DIR: "/data/liner" })).toBe(path.resolve("/data/liner"));
  });
});

describe("local data files", () => {
  it("creates the folder and returns nulls on first run", () => {
    const dir = path.join(tmp, "Liner");
    expect(loadLocalData(dir)).toEqual({ dir, config: null, library: null });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("round trips both files without leaving tmp files behind", () => {
    const dir = path.join(tmp, "Liner");
    saveLocalData(dir, "config", { profile: { displayName: "Codaram" } });
    saveLocalData(dir, "library", { liked: [{ id: "yt:aaaaaaaaaaa" }] });

    expect(loadLocalData(dir)).toEqual({
      dir,
      config: { profile: { displayName: "Codaram" } },
      library: { liked: [{ id: "yt:aaaaaaaaaaa" }] },
    });
    expect(fs.readdirSync(dir).sort()).toEqual(["config.json", "library.json"]);
  });

  it("moves a corrupt file aside instead of deleting it", () => {
    const dir = path.join(tmp, "Liner");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "library.json"), "{ not json");

    expect(loadLocalData(dir).library).toBeNull();
    expect(fs.readdirSync(dir).some((f) => f.startsWith("library.json.corrupt-"))).toBe(true);
  });

  it("rejects unknown kinds so the renderer cannot pick file names", () => {
    expect(() => saveLocalData(tmp, "../../etc/passwd" as never, {})).toThrow();
  });
});
