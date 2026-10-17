import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let saved: Record<string, unknown>;
const updateConfig = vi.fn((fn: (config: Record<string, unknown>) => void) => fn(saved));
const flushLocalStore = vi.fn(async () => {});
vi.mock("@/shared/local/localStore", () => ({
  getConfig: () => saved,
  updateConfig: (fn: (config: Record<string, unknown>) => void) => updateConfig(fn),
  flushLocalStore: () => flushLocalStore(),
}));

import SpotifySetup from "./SpotifySetup";

const bridge = { spotifyLogin: vi.fn() };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saved = {};
  updateConfig.mockClear();
  flushLocalStore.mockClear();
  bridge.spotifyLogin.mockReset().mockResolvedValue({ loggedIn: true, displayName: "Codaram" });
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

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const inputs = () => Array.from(container.querySelectorAll("input")) as HTMLInputElement[];

describe("SpotifySetup", () => {
  it("saves the client id, opens the browser login and asks for a new search when it succeeds", async () => {
    const onSaved = vi.fn();
    act(() => root.render(<SpotifySetup onSaved={onSaved} />));

    const login = button("Entrar com Spotify");
    expect(login.disabled).toBe(true);
    type(inputs()[0]!, " " + "a".repeat(32) + " ");
    expect(login.disabled).toBe(false);

    await act(async () => {
      login.click();
    });

    expect(saved.spotify).toEqual({ clientId: "a".repeat(32) });
    expect(flushLocalStore).toHaveBeenCalledTimes(1);
    expect(bridge.spotifyLogin).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows what went wrong without the ipc wrapper and lets the user try again", async () => {
    bridge.spotifyLogin.mockRejectedValue(new Error("Error invoking remote method 'spotify:login': Error: port 8888 is busy"));
    const onSaved = vi.fn();
    act(() => root.render(<SpotifySetup onSaved={onSaved} />));
    type(inputs()[0]!, "a".repeat(32));

    await act(async () => {
      button("Entrar com Spotify").click();
    });

    expect(container.querySelector("[role=alert]")?.textContent).toBe("port 8888 is busy");
    expect(onSaved).not.toHaveBeenCalled();
    expect(button("Entrar com Spotify").disabled).toBe(false);
  });

  it("prefills the saved client id and keeps a saved secret when only the id changes", async () => {
    saved = { spotify: { clientId: "b".repeat(32), clientSecret: "s".repeat(32) } };
    act(() => root.render(<SpotifySetup onSaved={vi.fn()} />));
    expect(inputs()[0]!.value).toBe("b".repeat(32));

    await act(async () => {
      button("Entrar com Spotify").click();
    });
    expect(saved.spotify).toEqual({ clientId: "b".repeat(32), clientSecret: "s".repeat(32) });
  });

  it("still supports saving client id + secret without logging in", async () => {
    const onSaved = vi.fn();
    act(() => root.render(<SpotifySetup onSaved={onSaved} />));
    type(inputs()[0]!, "a".repeat(32));
    const save = button("Salvar");
    expect(save.disabled).toBe(true);
    type(inputs()[1]!, "b".repeat(32));

    await act(async () => {
      save.click();
    });

    expect(saved.spotify).toEqual({ clientId: "a".repeat(32), clientSecret: "b".repeat(32) });
    expect(bridge.spotifyLogin).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
