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
  deezer: { id: "deezer", label: "Deezer", color: "#a238ff", priority: 2 },
  apple_music: { id: "apple_music", label: "Apple Music", color: "#fa5c7c", priority: 3 },
};

export const SOURCE_ORDER: SourceId[] = ["liner", "youtube", "deezer", "apple_music"];

// id prefixes for tracks that do not come from the liner catalog, playback is resolved locally
const ID_PREFIX: Record<Exclude<SourceId, "liner">, string> = {
  youtube: "yt:",
  deezer: "dz:",
  apple_music: "am:",
};

export function makeExternalId(source: Exclude<SourceId, "liner">, rawId: string | number): string {
  return `${ID_PREFIX[source]}${rawId}`;
}

export function sourceOfTrackId(id: string): SourceId {
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

// deezer / apple music only expose 30s clips without a subscription token
export function isPreviewOnly(source: SourceId): boolean {
  return source === "deezer" || source === "apple_music";
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
