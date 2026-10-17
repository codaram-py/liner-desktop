import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const updateConfig = vi.fn((fn: (config: Record<string, unknown>) => void) => fn(saved));
const flushLocalStore = vi.fn(async () => {});
vi.mock("@/shared/local/localStore", () => ({
  updateConfig: (fn: (config: Record<string, unknown>) => void) => updateConfig(fn),
  flushLocalStore: () => flushLocalStore(),
}));

import SpotifySetup from "./SpotifySetup";

let saved: Record<string, unknown>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saved = {};
  updateConfig.mockClear();
  flushLocalStore.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("SpotifySetup", () => {
  it("keeps save disabled until both values look real, then stores them and asks for a new search", async () => {
    const onSaved = vi.fn();
    act(() => root.render(<SpotifySetup onSaved={onSaved} />));

    const [id, secret] = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Salvar")! as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(secret!.type).toBe("password");

    type(id!, "a".repeat(32));
    expect(save.disabled).toBe(true);
    type(secret!, " " + "b".repeat(32) + " ");
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
    });

    expect(saved.spotify).toEqual({ clientId: "a".repeat(32), clientSecret: "b".repeat(32) });
    expect(flushLocalStore).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
