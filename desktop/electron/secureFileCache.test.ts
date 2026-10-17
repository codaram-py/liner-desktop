// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSecureFileCache, OAUTH_KEY } from "./secureFileCache";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer | undefined) => (b ? new TextDecoder().decode(b) : undefined);
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "yt-cache-"));
const rot = { isAvailable: () => true, encrypt: (p: string) => Buffer.from([...Buffer.from(p)].map((b) => b ^ 7)), decrypt: (d: Buffer) => Buffer.from([...d].map((b) => b ^ 7)).toString() };
const plain = { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" };

describe("secure file cache", () => {
  it("keeps ordinary keys in memory only", async () => {
    const file = path.join(dir(), "yt.json");
    const c = createSecureFileCache(file, rot);
    await c.set("player", enc("x"));
    expect(dec(await c.get("player"))).toBe("x");
    expect(fs.existsSync(file)).toBe(false);
    await c.remove("player");
    expect(await c.get("player")).toBeUndefined();
  });

  it("stores oauth credentials encrypted and reads them back in a new instance", async () => {
    const file = path.join(dir(), "yt.json");
    await createSecureFileCache(file, rot).set(OAUTH_KEY, enc('{"refresh_token":"SECRET"}'));
    expect(fs.readFileSync(file, "utf8")).not.toContain("SECRET");
    expect(dec(await createSecureFileCache(file, rot).get(OAUTH_KEY))).toBe('{"refresh_token":"SECRET"}');
  });

  it("falls back to plain text without a keychain, and removes the file on logout", async () => {
    const file = path.join(dir(), "yt.json");
    const c = createSecureFileCache(file, plain);
    await c.set(OAUTH_KEY, enc("abc"));
    expect(dec(await c.get(OAUTH_KEY))).toBe("abc");
    await c.remove(OAUTH_KEY);
    expect(await c.get(OAUTH_KEY)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("treats a corrupt file as logged out", async () => {
    const file = path.join(dir(), "yt.json");
    fs.writeFileSync(file, "{nope");
    expect(await createSecureFileCache(file, rot).get(OAUTH_KEY)).toBeUndefined();
  });
});
