import type { TrackArtist as ContractTrackArtist } from "../contracts";

export type SourceId = "liner" | "youtube" | "soundcloud" | "spotify" | "deezer" | "apple_music";

export interface TrackArtist {
  id?: string;
  name: string;
}

export interface Track {
  id: string;
  playlistItemId?: string;
  title: string;
  artists: string;
  artistId?: string;
  artistList?: (ContractTrackArtist | TrackArtist)[];
  coverUrl: string;
  durationMs: number;
  playCount: number;
  explicit?: boolean;
  source?: SourceId;
  releaseDate?: string;
  album?: {
    id: string;
    title: string;
  };
}
