import { useEffect, useMemo, useRef, useState } from "react";
import {
  isYoutubeLike,
  resolveYoutubeLink,
  searchAppleMusic,
  searchDeezer,
  searchYoutube,
  type ExternalTrack,
} from "../providers";
import { SOURCE_ORDER, type SourceId } from "../types";

export interface UseExternalSearchOptions {
  enabled: boolean;
  debounceMs?: number;
}

export interface UseExternalSearchResult {
  tracks: ExternalTrack[];
  loading: boolean;
  hasLoaded: boolean;
  // set when the query was a pasted youtube url / id, only youtube results are returned then
  linkMode: boolean;
  playlistTitle?: string;
}

type BySource = Partial<Record<SourceId, ExternalTrack[]>>;

export function useExternalSearch(query: string, options: UseExternalSearchOptions): UseExternalSearchResult {
  const { enabled, debounceMs = 320 } = options;
  const [bySource, setBySource] = useState<BySource>({});
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [playlistTitle, setPlaylistTitle] = useState<string | undefined>();
  const requestIdRef = useRef(0);

  const trimmed = query.trim();
  const active = enabled && trimmed.length >= 2;

  useEffect(() => {
    const requestId = ++requestIdRef.current;

    if (!active) {
      setBySource({});
      setLoading(false);
      setHasLoaded(false);
      setLinkMode(false);
      setPlaylistTitle(undefined);
      return;
    }

    const controller = new AbortController();
    const isCurrent = () => requestId === requestIdRef.current && !controller.signal.aborted;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        if (isYoutubeLike(trimmed)) {
          const link = await resolveYoutubeLink(trimmed).catch(() => null);
          if (!isCurrent()) return;
          if (link) {
            setBySource({ youtube: link.tracks });
            setLinkMode(true);
            setPlaylistTitle(link.playlistTitle);
            setHasLoaded(true);
            setLoading(false);
            return;
          }
        }

        setLinkMode(false);
        setPlaylistTitle(undefined);
        setBySource({});

        const providers: [SourceId, Promise<ExternalTrack[]>][] = [
          ["youtube", searchYoutube(trimmed)],
          ["deezer", searchDeezer(trimmed, controller.signal)],
          ["apple_music", searchAppleMusic(trimmed, controller.signal)],
        ];

        // each provider lands on its own so a slow one never blocks the others
        await Promise.all(
          providers.map(async ([source, pending]) => {
            const tracks = await pending.catch(() => [] as ExternalTrack[]);
            if (!isCurrent()) return;
            setBySource((prev) => ({ ...prev, [source]: tracks }));
          }),
        );
        if (!isCurrent()) return;
        setHasLoaded(true);
        setLoading(false);
      } catch {
        if (!isCurrent()) return;
        setHasLoaded(true);
        setLoading(false);
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, debounceMs, trimmed]);

  const tracks = useMemo(() => SOURCE_ORDER.flatMap((source) => bySource[source] ?? []), [bySource]);

  return { tracks, loading, hasLoaded, linkMode, playlistTitle };
}
