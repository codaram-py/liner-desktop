import type { SourceId } from "@/shared/types";

export type { SourceId };

export interface SourceInfo {
  id: SourceId;
  label: string;
  color: string;
  // lower wins when the same track exists on several sources: full-length playback beats 30s previews
  priority: number;
}

export const SOURCES: Record<SourceId, SourceInfo> = {
  liner: { id: "liner", label: "Liner", color: "#8b93ff", priority: 0 },
  youtube: { id: "youtube", label: "YouTube", color: "#ff2d46", priority: 1 },
  soundcloud: { id: "soundcloud", label: "SoundCloud", color: "#ff7a1a", priority: 2 },
  spotify: { id: "spotify", label: "Spotify", color: "#1ed760", priority: 3 },
  deezer: { id: "deezer", label: "Deezer", color: "#a238ff", priority: 4 },
  apple_music: { id: "apple_music", label: "Apple Music", color: "#fa5c7c", priority: 5 },
};

export const SOURCE_ORDER: SourceId[] = ["liner", "youtube", "soundcloud", "spotify", "deezer", "apple_music"];

// sources that only hand us metadata: the full track is played from the matching youtube upload
export function playsViaYoutube(source: SourceId): boolean {
  return source === "spotify" || source === "deezer" || source === "apple_music";
}

// id prefixes for tracks that do not come from the liner catalog, playback is resolved locally
const ID_PREFIX: Record<Exclude<SourceId, "liner">, string> = {
  youtube: "yt:",
  soundcloud: "sc:",
  spotify: "sp:",
  deezer: "dz:",
  apple_music: "am:",
};

// the official 30s clips of deezer / apple music get their own ids so the same song can exist as a full row and a preview row
const PREVIEW_PREFIX: Partial<Record<Exclude<SourceId, "liner">, string>> = {
  deezer: "dzp:",
  apple_music: "amp:",
};

export function makeExternalId(source: Exclude<SourceId, "liner">, rawId: string | number, preview = false): string {
  return `${(preview && PREVIEW_PREFIX[source]) || ID_PREFIX[source]}${rawId}`;
}

export function isPreviewTrackId(id: string): boolean {
  return Object.values(PREVIEW_PREFIX).some((prefix) => id.startsWith(prefix));
}

export function sourceOfTrackId(id: string): SourceId {
  for (const [source, prefix] of Object.entries(PREVIEW_PREFIX)) {
    if (id.startsWith(prefix!)) return source as SourceId;
  }
  for (const [source, prefix] of Object.entries(ID_PREFIX)) {
    if (id.startsWith(prefix)) return source as SourceId;
  }
  return "liner";
}

export function isExternalTrackId(id: string | null | undefined): boolean {
  return !!id && sourceOfTrackId(id) !== "liner";
}

export function rawExternalId(id: string): string {
  const colon = id.indexOf(":");
  return colon === -1 ? id : id.slice(colon + 1);
}

export interface SourceVariant {
  id: string;
  source: SourceId;
  title: string;
  artists: string;
  coverUrl: string;
  durationMs: number;
  previewOnly?: boolean;
}
