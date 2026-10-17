import fs from "node:fs";
import path from "node:path";
import type { SecretBox } from "./spotifyAuth.js";

// youtubei.js ICache. everything lives in memory except the oauth credentials: those are the user's google login, so
// they go to disk, encrypted with the os keychain (electron safeStorage) when there is one
export const OAUTH_KEY = "youtubei_oauth_credentials";

export interface SecureCache {
  cache_dir: string;
  get(key: string): Promise<ArrayBuffer | undefined>;
  set(key: string, value: ArrayBuffer): Promise<void>;
  remove(key: string): Promise<void>;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function createSecureFileCache(file: string, box: SecretBox): SecureCache {
  const memory = new Map<string, ArrayBuffer>();

  function readSecret(): ArrayBuffer | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof raw.data !== "string") return undefined;
      const text = raw.encrypted ? box.decrypt(Buffer.from(raw.data, "base64")) : raw.data;
      return toArrayBuffer(Buffer.from(text, "utf8"));
    } catch {
      return undefined;
    }
  }

  return {
    cache_dir: path.dirname(file),
    async get(key) {
      return key === OAUTH_KEY ? readSecret() : memory.get(key);
    },
    async set(key, value) {
      if (key !== OAUTH_KEY) {
        memory.set(key, value);
        return;
      }
      const text = Buffer.from(value).toString("utf8");
      const encrypted = box.isAvailable();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ encrypted, data: encrypted ? box.encrypt(text).toString("base64") : text }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    async remove(key) {
      if (key === OAUTH_KEY) fs.rmSync(file, { force: true });
      else memory.delete(key);
    },
  };
}
