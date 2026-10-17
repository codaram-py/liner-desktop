import fs from "node:fs";
import path from "node:path";

// the main process reads ~/Liner/config.json itself for settings that never need to reach the renderer.
// the renderer keeps these keys untouched when it saves the profile (see normalizeConfig)
export interface AppConfig {
  spotify?: { clientId?: string; clientSecret?: string };
}

export function readAppConfig(dataDir: string): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return { spotify: { clientId: str(raw.spotify?.clientId), clientSecret: str(raw.spotify?.clientSecret) } };
  } catch {
    return {};
  }
}
