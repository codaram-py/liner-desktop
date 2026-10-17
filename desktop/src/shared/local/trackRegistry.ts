import type { Track } from "@/shared/types";

// the local library only receives track ids from the ui (like, add to playlist), the metadata is whatever we saw earlier:
// search results, queue, now playing. this keeps the last few thousand so they can be saved next to the id
const MAX_ENTRIES = 3000;
const registry = new Map<string, Track>();

export function rememberTrack(track: Partial<Track> | null | undefined): void {
  if (!track?.id) return;
  const prev = registry.get(track.id);
  const next: Track = {
    id: track.id,
    title: track.title || prev?.title || track.id,
    artists: track.artists ?? prev?.artists ?? "",
    artistList: track.artistList ?? prev?.artistList,
    artistId: track.artistId ?? prev?.artistId,
    coverUrl: track.coverUrl || prev?.coverUrl || "",
    durationMs: track.durationMs || prev?.durationMs || 0,
    playCount: track.playCount ?? prev?.playCount ?? 0,
    explicit: track.explicit ?? prev?.explicit,
    album: track.album ?? prev?.album,
    source: track.source ?? prev?.source,
  };
  registry.delete(track.id);
  registry.set(track.id, next);
  if (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
}

export function rememberTracks(tracks: Iterable<Partial<Track> | null | undefined>): void {
  for (const track of tracks) rememberTrack(track);
}

export function getRememberedTrack(id: string): Track | undefined {
  return registry.get(id);
}

export function clearTrackRegistry(): void {
  registry.clear();
}
