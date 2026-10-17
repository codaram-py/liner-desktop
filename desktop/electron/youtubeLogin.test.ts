// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createYoutubeLogin, type LoginSession } from "./youtubeLogin";

function fakeSession(signIn: (emit: (e: string, d: any) => void) => Promise<void>) {
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const emit = (e: string, d: any) => listeners.get(e)?.forEach((l) => l(d));
  const session: LoginSession = {
    logged_in: false,
    on: (e, l) => (listeners.has(e) ? listeners.get(e)! : listeners.set(e, new Set()).get(e)!).add(l),
    off: (e, l) => listeners.get(e)?.delete(l),
    signIn: vi.fn(() => signIn(emit)),
    signOut: vi.fn(async () => {
      session.logged_in = false;
    }),
    oauth: { cacheCredentials: vi.fn(async () => {}), removeCache: vi.fn(async () => {}) },
  };
  return session;
}

describe("youtube login", () => {
  it("exposes the device code while pending, then flips to logged in and caches", async () => {
    let approve!: () => void;
    const s = fakeSession(async (emit) => {
      emit("auth-pending", { user_code: "ABC-DEF-GHI", verification_url: "https://www.google.com/device" });
      await new Promise<void>((r) => (approve = r));
    });
    const onChange = vi.fn();
    const login = createYoutubeLogin({ getSession: async () => s, onChange });

    expect(await login.start()).toEqual({ loggedIn: false, pending: { userCode: "ABC-DEF-GHI", verificationUrl: "https://www.google.com/device" } });
    expect((await login.start()).pending?.userCode).toBe("ABC-DEF-GHI"); // second click does not start another flow
    expect(s.signIn).toHaveBeenCalledTimes(1);

    approve();
    await vi.waitFor(() => expect(login.status().loggedIn).toBe(true));
    expect(s.oauth.cacheCredentials).toHaveBeenCalled();
    expect(login.status().pending).toBeUndefined();
    expect(onChange).toHaveBeenCalled();
  });

  it("reports a denied / expired code and allows trying again", async () => {
    const s = fakeSession(async (emit) => {
      emit("auth-pending", { user_code: "X", verification_url: "u" });
      throw new Error("The device code has expired.");
    });
    const login = createYoutubeLogin({ getSession: async () => s });
    await login.start();
    await vi.waitFor(() => expect(login.status().error).toMatch(/expired/));
    expect(login.status().loggedIn).toBe(false);
    await login.start();
    expect(s.signIn).toHaveBeenCalledTimes(2);
  });

  it("logout revokes, drops the cache and clears state", async () => {
    const s = fakeSession(async () => {});
    s.logged_in = true;
    const login = createYoutubeLogin({ getSession: async () => s });
    login.markLoggedIn(true);
    await login.logout();
    expect(s.signOut).toHaveBeenCalled();
    expect(s.oauth.removeCache).toHaveBeenCalled();
    expect(login.status()).toEqual({ loggedIn: false });
  });
});
