export type Codec = 'opus' | 'aac';

export type CodecPreference = Codec | undefined;

export interface DirectInnertubePlan {
  transport: 'direct_innertube';
  videoId: string;
  endpoint: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface PlaybackSessionResponse {
  sessionId?: string;
  trackId?: string;
  streamUrl?: string;
  codec?: Codec;
  bitrate?: number;
  mimeType?: string;
  expiresAt?: string;
  transport?: 'proxy' | 'direct_innertube';
  playbackId?: string;
  // direct_innertube plan fields
  videoId?: string;
  endpoint?: string;
  method?: 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export type PlaybackResponse = PlaybackSessionResponse | DirectInnertubePlan;
export type ApiPlaybackSession = PlaybackResponse;
export type PlaybackSession = PlaybackResponse;
