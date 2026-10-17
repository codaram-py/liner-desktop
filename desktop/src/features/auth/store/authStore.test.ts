import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the player feature pulls lottie/canvas ui that jsdom cannot load; initialize() never touches it
vi.mock("@/features/player", () => ({ usePlayerStore: { getState: () => ({}) }, playerRuntime: null }));

import { useAuthStore } from "./authStore";
import { api, ApiError, getAuthSession, setAuthSession, type AuthTokens } from "@/shared/api";

const stored = {
  accessToken: "expired-access",
  refreshToken: "refresh-1",
  user: { id: "u1", username: "leo" },
} as unknown as AuthTokens;

describe("authStore.initialize — expired access token at launch", () => {
  beforeEach(() => {
    setAuthSession(stored);
    useAuthStore.setState({ status: "initializing", user: null });
    vi.spyOn(api, "getMe").mockRejectedValue(new ApiError(401, "Unauthorized"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAuthSession(null);
  });

  it("keeps the session when the refresh fails for a transient reason (server down)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error code: 525", { status: 525 }));

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("authenticated");
    expect(getAuthSession()?.refreshToken).toBe("refresh-1");
  });

  it("signs out when the server rejects the refresh token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().status).toBe("anonymous");
    expect(getAuthSession()).toBeNull();
  });
});
