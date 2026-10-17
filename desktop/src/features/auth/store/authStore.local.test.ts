import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/player", () => ({ usePlayerStore: { getState: () => ({}) }, playerRuntime: null }));

import { useAuthStore } from "./authStore";
import { api, getAuthSession, setAuthSession } from "@/shared/api";
import { resetLocalStoreForTests } from "@/shared/local/localStore";

describe("authStore in local mode", () => {
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
    vi.stubEnv("VITE_LINER_ONLINE", "");
    localStorage.clear();
    resetLocalStoreForTests();
    setAuthSession(null);
    useAuthStore.setState({ status: "initializing", user: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setAuthSession(null);
  });

  it("signs in with the local profile without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(useAuthStore.getState().user).toMatchObject({ id: "local-user", username: "local" });
    expect(getAuthSession()?.accessToken).toBe("local");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("saves profile edits to the local config and keeps the session on logout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useAuthStore.getState().initialize();

    await useAuthStore.getState().updateProfile({ displayName: "Codaram" });
    expect(useAuthStore.getState().user?.displayName).toBe("Codaram");
    expect((await api.getMe()).displayName).toBe("Codaram");

    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
