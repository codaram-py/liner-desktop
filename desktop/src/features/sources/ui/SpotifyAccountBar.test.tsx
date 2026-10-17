import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import SpotifyAccountBar from "./SpotifyAccountBar";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const bridge = { spotifyStatus: vi.fn(), spotifyLogout: vi.fn() };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  bridge.spotifyStatus.mockReset();
  bridge.spotifyLogout.mockReset().mockResolvedValue(undefined);
  (window as any).linerElectron = bridge;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).linerElectron;
});

const button = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement;

describe("SpotifyAccountBar", () => {
  it("shows the account, opens the liked songs and logs out", async () => {
    bridge.spotifyStatus.mockResolvedValue({ loggedIn: true, displayName: "Codaram", hasClientId: true });
    const onOpenLiked = vi.fn();
    const onLoggedOut = vi.fn();
    await act(async () => root.render(<SpotifyAccountBar onOpenLiked={onOpenLiked} onLoggedOut={onLoggedOut} />));

    expect(container.textContent).toContain("Spotify conectado como Codaram");
    act(() => button("Músicas curtidas").click());
    expect(onOpenLiked).toHaveBeenCalledTimes(1);

    await act(async () => button("Sair").click());
    expect(bridge.spotifyLogout).toHaveBeenCalledTimes(1);
    expect(onLoggedOut).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when nobody is logged in", async () => {
    bridge.spotifyStatus.mockResolvedValue({ loggedIn: false, hasClientId: true });
    await act(async () => root.render(<SpotifyAccountBar onOpenLiked={vi.fn()} onLoggedOut={vi.fn()} />));
    expect(container.textContent).toBe("");
  });
});
