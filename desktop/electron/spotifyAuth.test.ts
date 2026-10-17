// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCOPES,
  buildAuthUrl,
  createFileSessionStore,
  createSpotifyAuth,
  makePkce,
  type SessionStore,
  type StoredSession,
} from "./spotifyAuth";

const CLIENT_ID = "a".repeat(32);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

const memoryStore = (initial: StoredSession | null = null) => {
  let value = initial;
  const store: SessionStore & { value: () => StoredSession | null } = {
    read: () => value,
    write: (s) => {
      value = s;
    },
    value: () => value,
  };
  return store;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("pkce and auth url", () => {
  it("derives the challenge from the verifier with sha256", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(makePkce().verifier).not.toBe(verifier);
  });

  it("builds the authorize url with pkce, state, the loopback redirect and read only scopes", () => {
    const url = new URL(buildAuthUrl({ clientId: CLIENT_ID, challenge: "chal", state: "st" }));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: "http://127.0.0.1:8888/callback",
      code_challenge_method: "S256",
      code_challenge: "chal",
      state: "st",
      scope: SCOPES.join(" "),
    });
    expect(SCOPES.every((s) => s.endsWith("-read") || s.includes("-read-") || s.startsWith("playlist-read"))).toBe(true);
  });
});

describe("login", () => {
  let port: number;
  let store: ReturnType<typeof memoryStore>;
  let tokenCalls: URLSearchParams[];

  const make = (opts: { open: (authUrl: URL) => Promise<void> | void; timeoutMs?: number; tokenResponse?: () => Response }) =>
    createSpotifyAuth({
      store,
      port,
      timeoutMs: opts.timeoutMs,
      openExternal: (url) => opts.open(new URL(url)),
      fetchImpl: (async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://accounts.spotify.com/api/token") {
          tokenCalls.push(new URLSearchParams(String(init!.body)));
          return opts.tokenResponse ? opts.tokenResponse() : json({ access_token: "access1", refresh_token: "refresh1", expires_in: 3600 });
        }
        if (url === "https://api.spotify.com/v1/me") return json({ display_name: "Codaram" });
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });

  const hitCallback = (authUrl: URL, query: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams({ state: authUrl.searchParams.get("state")!, ...query })}`);

  beforeEach(async () => {
    port = await freePort();
    store = memoryStore();
    tokenCalls = [];
  });

  it("completes the pkce exchange and keeps only the refresh token", async () => {
    const auth = make({ open: async (u) => void (await hitCallback(u, { code: "thecode" })) });
    const status = await auth.login(CLIENT_ID);

    expect(status).toEqual({ loggedIn: true, displayName: "Codaram" });
    expect(store.value()).toEqual({ clientId: CLIENT_ID, refreshToken: "refresh1", displayName: "Codaram" });
    expect(auth.status()).toEqual({ loggedIn: true, displayName: "Codaram" });

    const body = tokenCalls[0]!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("thecode");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8888/callback");
    expect(body.has("client_secret")).toBe(false);
  });

  it("sends a verifier that matches the challenge in the browser url", async () => {
    let challenge = "";
    const auth = make({
      open: async (u) => {
        challenge = u.searchParams.get("code_challenge")!;
        await hitCallback(u, { code: "c" });
      },
    });
    await auth.login(CLIENT_ID);
    expect(createHash("sha256").update(tokenCalls[0]!.get("code_verifier")!).digest("base64url")).toBe(challenge);
  });

  it("ignores callbacks with the wrong state and still completes with the right one", async () => {
    const auth = make({
      open: async (u) => {
        const stray = await fetch(`http://127.0.0.1:${port}/callback?state=forged&code=evil`);
        expect(stray.status).toBe(400);
        await hitCallback(u, { code: "good" });
      },
    });
    await auth.login(CLIENT_ID);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.get("code")).toBe("good");
  });

  it("reports a cancelled login and a rejected exchange", async () => {
    await expect(make({ open: async (u) => void (await hitCallback(u, { error: "access_denied" })) }).login(CLIENT_ID)).rejects.toThrow(/cancelled/);

    const rejected = make({
      open: async (u) => void (await hitCallback(u, { code: "c" })),
      tokenResponse: () => json({ error: "invalid_client", error_description: "Invalid client" }, 400),
    });
    await expect(rejected.login(CLIENT_ID)).rejects.toThrow(/did not accept the login \(Invalid client\)/);
    expect(store.value()).toBeNull();
  });

  it("times out and frees the port, and fails clearly when the port is taken or the id is junk", async () => {
    await expect(make({ open: () => {}, timeoutMs: 80 }).login(CLIENT_ID)).rejects.toThrow(/timed out/);

    const blocker = http.createServer().listen(port, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    await expect(make({ open: () => {} }).login(CLIENT_ID)).rejects.toThrow(/is busy/);
    blocker.close();

    const never = vi.fn();
    await expect(make({ open: never }).login("not a client id!")).rejects.toThrow(/does not look like/);
    expect(never).not.toHaveBeenCalled();
  });

  it("does not leave the server waiting when the browser cannot be opened", async () => {
    const auth = make({
      open: () => {
        throw new Error("no browser");
      },
      timeoutMs: 5000,
    });
    await expect(auth.login(CLIENT_ID)).rejects.toThrow("no browser");
    // the one-shot server got torn down by its timer or is still ours: a new login must be allowed to start
    const second = make({ open: async (u) => void (await hitCallback(u, { code: "c" })) });
    await expect(second.login(CLIENT_ID)).resolves.toMatchObject({ loggedIn: true });
  }, 15000);
});

describe("getAccessToken", () => {
  let now: number;
  let calls: URLSearchParams[];
  let respond: () => Response;

  const make = (store: SessionStore) =>
    createSpotifyAuth({
      store,
      now: () => now,
      openExternal: () => {},
      fetchImpl: (async (_url: any, init?: RequestInit) => {
        calls.push(new URLSearchParams(String(init!.body)));
        return respond();
      }) as typeof fetch,
    });

  beforeEach(() => {
    now = 1_000_000;
    calls = [];
    respond = () => json({ access_token: "fresh", expires_in: 3600 });
  });

  it("returns null without a session and caches the access token until it is about to expire", async () => {
    expect(await make(memoryStore()).getAccessToken()).toBeNull();

    const auth = make(memoryStore({ clientId: CLIENT_ID, refreshToken: "r1" }));
    expect(await auth.getAccessToken()).toBe("fresh");
    expect(await auth.getAccessToken()).toBe("fresh");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.get("refresh_token")).toBe("r1");

    now += 3_600_000;
    await auth.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it("stores a rotated refresh token", async () => {
    respond = () => json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
    const store = memoryStore({ clientId: CLIENT_ID, refreshToken: "r1", displayName: "X" });
    await make(store).getAccessToken();
    expect(store.value()).toEqual({ clientId: CLIENT_ID, refreshToken: "r2", displayName: "X" });
  });

  it("drops a revoked session but keeps one through a server error", async () => {
    respond = () => json({ error: "invalid_grant" }, 400);
    const revoked = memoryStore({ clientId: CLIENT_ID, refreshToken: "r1" });
    expect(await make(revoked).getAccessToken()).toBeNull();
    expect(revoked.value()).toBeNull();

    respond = () => json({}, 503);
    const kept = memoryStore({ clientId: CLIENT_ID, refreshToken: "r1" });
    await expect(make(kept).getAccessToken()).rejects.toThrow(/503/);
    expect(kept.value()).not.toBeNull();
  });

  it("logout forgets everything", async () => {
    const store = memoryStore({ clientId: CLIENT_ID, refreshToken: "r1" });
    const auth = make(store);
    await auth.getAccessToken();
    auth.logout();
    expect(store.value()).toBeNull();
    expect(auth.status()).toEqual({ loggedIn: false });
    expect(await auth.getAccessToken()).toBeNull();
  });
});

describe("file session store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "liner-spauth-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const box = (available: boolean) => ({
    isAvailable: () => available,
    encrypt: (plain: string) => Buffer.from(plain.split("").reverse().join("")),
    decrypt: (data: Buffer) => data.toString().split("").reverse().join(""),
  });

  it("encrypts the refresh token when the keychain is available and never writes it in the clear", () => {
    const file = path.join(dir, "spotify-session.json");
    const store = createFileSessionStore(file, box(true));
    store.write({ clientId: CLIENT_ID, refreshToken: "super-secret", displayName: "Codaram" });

    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("super-secret");
    expect(store.read()).toEqual({ clientId: CLIENT_ID, refreshToken: "super-secret", displayName: "Codaram" });
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("falls back to a private plain file, removes it on logout and survives garbage", () => {
    const file = path.join(dir, "s.json");
    const store = createFileSessionStore(file, box(false));
    store.write({ clientId: CLIENT_ID, refreshToken: "tok" });
    expect(store.read()?.refreshToken).toBe("tok");

    store.write(null);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toBeNull();

    fs.writeFileSync(file, "{ nope");
    expect(store.read()).toBeNull();
  });
});
