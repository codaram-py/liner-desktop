import type { PlaybackHistoryItem } from "@/shared/contracts";
import type { Track } from "@/shared/types";
import { LOCAL_USER_ID } from "./mode";

export interface LocalProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isPublic: boolean;
  showActivity: boolean;
  showHistory: boolean;
  showLikedTracks: boolean;
  participateLeaderboards: boolean;
  createdAt: string;
}

export interface LocalConfig {
  version: 1;
  profile: LocalProfile;
}

export interface LocalPlaylistItem {
  id: string;
  trackId: string;
  addedAt: string;
}

export interface LocalPlaylist {
  id: string;
  title: string;
  description?: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  items: LocalPlaylistItem[];
}

export interface LocalLibrary {
  version: 1;
  // metadata for every track referenced below, the catalog is not reachable offline
  tracks: Record<string, Track>;
  liked: { trackId: string; likedAt: string }[];
  playlists: LocalPlaylist[];
  history: PlaybackHistoryItem[];
  saved: { albums: string[]; artists: string[]; playlists: string[] };
}

export const HISTORY_LIMIT = 500;
const SAVE_DEBOUNCE_MS = 250;
const LS_CONFIG = "liner_local_config";
const LS_LIBRARY = "liner_local_library";

export function defaultConfig(now = new Date()): LocalConfig {
  return {
    version: 1,
    profile: {
      id: LOCAL_USER_ID,
      username: "local",
      displayName: null,
      avatarUrl: null,
      bio: null,
      isPublic: false,
      showActivity: false,
      showHistory: false,
      showLikedTracks: false,
      participateLeaderboards: false,
      createdAt: now.toISOString(),
    },
  };
}

export function defaultLibrary(): LocalLibrary {
  return {
    version: 1,
    tracks: {},
    liked: [],
    playlists: [],
    history: [],
    saved: { albums: [], artists: [], playlists: [] },
  };
}

// files are hand editable, so anything missing or mistyped falls back to the default instead of crashing the app
export function normalizeConfig(raw: unknown): LocalConfig {
  const base = defaultConfig();
  const profile = (raw as Partial<LocalConfig> | null)?.profile;
  if (!profile || typeof profile !== "object") return base;
  const p = profile as Partial<LocalProfile>;
  const str = (v: unknown, fallback: string | null) => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    version: 1,
    profile: {
      id: LOCAL_USER_ID,
      username: str(p.username, base.profile.username) || base.profile.username,
      displayName: str(p.displayName, null),
      avatarUrl: str(p.avatarUrl, null),
      bio: str(p.bio, null),
      isPublic: bool(p.isPublic, false),
      showActivity: bool(p.showActivity, false),
      showHistory: bool(p.showHistory, false),
      showLikedTracks: bool(p.showLikedTracks, false),
      participateLeaderboards: bool(p.participateLeaderboards, false),
      createdAt: str(p.createdAt, base.profile.createdAt) || base.profile.createdAt,
    },
  };
}

export function normalizeLibrary(raw: unknown): LocalLibrary {
  const base = defaultLibrary();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<LocalLibrary>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const ids = (v: unknown): string[] => arr<unknown>(v).filter((x): x is string => typeof x === "string");
  return {
    version: 1,
    tracks: r.tracks && typeof r.tracks === "object" ? (r.tracks as Record<string, Track>) : {},
    liked: arr<LocalLibrary["liked"][number]>(r.liked).filter((l) => typeof l?.trackId === "string"),
    playlists: arr<LocalPlaylist>(r.playlists)
      .filter((p) => typeof p?.id === "string" && typeof p?.title === "string")
      .map((p) => ({ ...p, isPublic: !!p.isPublic, revision: p.revision ?? 1, items: arr<LocalPlaylistItem>(p.items) })),
    history: arr<PlaybackHistoryItem>(r.history).filter((h) => typeof h?.id === "string"),
    saved: {
      albums: ids(r.saved?.albums),
      artists: ids(r.saved?.artists),
      playlists: ids(r.saved?.playlists),
    },
  };
}

// drops metadata nothing points at anymore so library.json does not grow forever
export function pruneTracks(library: LocalLibrary): void {
  const used = new Set<string>();
  for (const l of library.liked) used.add(l.trackId);
  for (const p of library.playlists) for (const i of p.items) used.add(i.trackId);
  for (const id of Object.keys(library.tracks)) {
    if (!used.has(id)) delete library.tracks[id];
  }
}

type Persist = { load: () => Promise<{ dir: string | null; config: unknown; library: unknown }>; save: (kind: "config" | "library", data: unknown) => Promise<void> };

function electronPersist(): Persist | null {
  const bridge = typeof window !== "undefined" ? window.linerElectron : undefined;
  if (!bridge?.localDataLoad || !bridge.localDataSave) return null;
  return {
    load: async () => {
      const snap = await bridge.localDataLoad();
      return { dir: snap.dir, config: snap.config, library: snap.library };
    },
    save: async (kind, data) => {
      const res = await bridge.localDataSave(kind, data);
      if (!res.ok) throw new Error(res.error || "failed to write local data");
    },
  };
}

// plain browser (vite in a tab, tests): same data, kept in localStorage
function browserPersist(): Persist {
  const read = (key: string) => {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  return {
    load: async () => ({ dir: null, config: read(LS_CONFIG), library: read(LS_LIBRARY) }),
    save: async (kind, data) => {
      localStorage.setItem(kind === "config" ? LS_CONFIG : LS_LIBRARY, JSON.stringify(data));
    },
  };
}

let config: LocalConfig = defaultConfig();
let library: LocalLibrary = defaultLibrary();
let dataDir: string | null = null;
let persist: Persist = browserPersist();
let initPromise: Promise<void> | null = null;
const dirty = new Set<"config" | "library">();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> = Promise.resolve();

export function initLocalStore(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      persist = electronPersist() ?? browserPersist();
      try {
        const snap = await persist.load();
        dataDir = snap.dir;
        config = normalizeConfig(snap.config);
        library = normalizeLibrary(snap.library);
        // first run: write the defaults so the files exist where the user expects them
        if (snap.config === null) dirty.add("config");
        if (snap.library === null) dirty.add("library");
        if (dirty.size > 0) scheduleSave();
      } catch (err) {
        console.error("failed to load local data, starting empty", err);
      }
    })();
  }
  return initPromise;
}

export function getLocalDataDir(): string | null {
  return dataDir;
}

export function getConfig(): LocalConfig {
  return config;
}

export function getLibrary(): LocalLibrary {
  return library;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushLocalStore(), SAVE_DEBOUNCE_MS);
}

export function updateConfig<T>(fn: (draft: LocalConfig) => T): T {
  const result = fn(config);
  dirty.add("config");
  scheduleSave();
  return result;
}

export function updateLibrary<T>(fn: (draft: LocalLibrary) => T): T {
  const result = fn(library);
  pruneTracks(library);
  dirty.add("library");
  scheduleSave();
  return result;
}

export function flushLocalStore(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const kinds = [...dirty];
  dirty.clear();
  saving = saving.then(async () => {
    for (const kind of kinds) {
      try {
        await persist.save(kind, kind === "config" ? config : library);
      } catch (err) {
        console.error(`failed to save local ${kind}`, err);
        dirty.add(kind);
      }
    }
  });
  return saving;
}

export function openLocalDataFolder(): Promise<boolean> {
  return window.linerElectron?.localDataOpenFolder?.() ?? Promise.resolve(false);
}

// test helper
export function resetLocalStoreForTests(): void {
  config = defaultConfig();
  library = defaultLibrary();
  dataDir = null;
  persist = browserPersist();
  initPromise = null;
  dirty.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saving = Promise.resolve();
}

if (typeof window !== "undefined") {
  const flushNow = () => void flushLocalStore();
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
}
