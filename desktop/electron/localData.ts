import fs from "node:fs";
import path from "node:path";

// offline profile + library, kept as plain json in a folder the user can see, back up or edit by hand:
//   <dir>/config.json   profile (name, avatar, bio, privacy flags)
//   <dir>/library.json  liked tracks, playlists, play history, remembered track metadata
export const LOCAL_DATA_KINDS = ["config", "library"] as const;
export type LocalDataKind = (typeof LOCAL_DATA_KINDS)[number];

export interface LocalDataSnapshot {
  dir: string;
  config: unknown | null;
  library: unknown | null;
}

const FILE_NAMES: Record<LocalDataKind, string> = {
  config: "config.json",
  library: "library.json",
};

const MAX_BYTES = 64 * 1024 * 1024;

// LINER_DATA_DIR wins, otherwise ~/Liner
export function resolveDataDir(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LINER_DATA_DIR?.trim();
  return override ? path.resolve(override) : path.join(homeDir, "Liner");
}

function readJson(file: string): unknown | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // never throw away a file the user may want to repair, move it aside and start clean
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return null;
  }
}

export function loadLocalData(dir: string): LocalDataSnapshot {
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    config: readJson(path.join(dir, FILE_NAMES.config)),
    library: readJson(path.join(dir, FILE_NAMES.library)),
  };
}

// tmp file + rename so a crash mid-write never leaves a half written library
export function saveLocalData(dir: string, kind: LocalDataKind, data: unknown): void {
  if (!LOCAL_DATA_KINDS.includes(kind)) throw new Error(`unknown local data kind: ${String(kind)}`);
  const json = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("local data too large");

  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, FILE_NAMES[kind]);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, target);
}
