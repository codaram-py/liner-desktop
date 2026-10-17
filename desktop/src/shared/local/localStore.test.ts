import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./localStore";

describe("normalizeConfig", () => {
  it("keeps settings the renderer does not own, like spotify credentials, when the profile is saved back", () => {
    const config = normalizeConfig({
      version: 1,
      profile: { displayName: "Codaram", username: "codaram" },
      spotify: { clientId: "id", clientSecret: "secret" },
    });
    expect(config.spotify).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(config.profile.displayName).toBe("Codaram");
    expect(config.version).toBe(1);
  });

  it("keeps extras even when the profile is missing or broken", () => {
    expect(normalizeConfig({ spotify: { clientId: "id" } }).spotify).toEqual({ clientId: "id" });
    expect(normalizeConfig({ profile: "nope", spotify: { clientId: "id" } }).spotify).toEqual({ clientId: "id" });
    expect(normalizeConfig(null).profile.username).toBe("local");
  });
});
