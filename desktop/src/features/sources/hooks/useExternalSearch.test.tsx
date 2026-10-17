import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({
  searchYoutube: vi.fn(),
  searchSoundcloud: vi.fn(),
  searchSpotify: vi.fn(),
  searchDeezer: vi.fn(),
  searchAppleMusic: vi.fn(),
  resolveExternalLink: vi.fn(),
}));

vi.mock("../providers", () => ({
  ...providers,
  isLinkLike: () => false,
  isSpotifyLike: () => false,
  SpotifyNotConfiguredError: class extends Error {},
}));

import { useExternalSearch } from "./useExternalSearch";

beforeEach(() => {
  for (const fn of Object.values(providers)) fn.mockReset();
  providers.searchSoundcloud.mockResolvedValue([]);
  providers.searchSpotify.mockResolvedValue({ configured: true, tracks: [] });
  providers.searchDeezer.mockResolvedValue([]);
  providers.searchAppleMusic.mockResolvedValue([]);
});

describe("useExternalSearch errors", () => {
  it("reports why a provider returned nothing instead of silently showing no results", async () => {
    providers.searchYoutube.mockRejectedValue(
      new Error("Error invoking remote method 'youtube:search': InnertubeError: Request failed with status code 400"),
    );
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let latest: ReturnType<typeof useExternalSearch> | undefined;
    function Probe() {
      latest = useExternalSearch("mc lan", { enabled: true, debounceMs: 0 });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Probe));
    });
    await vi.waitFor(() => expect(latest?.hasLoaded).toBe(true));
    expect(latest!.errors.youtube).toMatch(/status code 400/);
    expect(latest!.errors.youtube).not.toMatch(/Error invoking/);
    expect(latest!.errors.soundcloud).toBeUndefined();
    await act(async () => root.unmount());
  });
});
