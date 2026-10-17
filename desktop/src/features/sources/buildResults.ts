import { interleave, mergeTrackVariants } from "./mergeResults";
import type { ExternalTrack } from "./providers";
import { SOURCE_ORDER, isPreviewOnly, sourceOfTrackId, type SourceId, type SourceVariant } from "./types";

export type SourceFilter = "all" | SourceId;

type Row = Record<string, any> & { id: string; title: string; artists: string };

function isTrackRow(row: Row): boolean {
  return row._type === "track";
}

function withSource(row: Row): Row {
  return { ...row, source: row.source ?? sourceOfTrackId(row.id) };
}

// swaps the row to another copy of the same song (e.g. filter = Deezer but liner had the song first)
export function applyVariant(row: Row, variant: SourceVariant): Row {
  const next: Row = {
    ...row,
    id: variant.id,
    source: variant.source,
    title: variant.title,
    artists: variant.artists,
    coverUrl: variant.coverUrl,
    durationMs: variant.durationMs,
    previewOnly: variant.previewOnly,
  };
  if (variant.source !== "liner") {
    // catalog-only fields point at liner entities that do not exist for this copy
    delete next.artistId;
    delete next.artistList;
    delete next.album;
  }
  return next;
}

export interface BuildSearchResultsInput {
  // liner results already mapped by AppFrame (every row has _type)
  linerItems: Row[];
  external: ExternalTrack[];
  sourceFilter: SourceFilter;
}

// merges liner + external tracks into one list, groups copies of the same song and applies the source filter.
// non-track rows (artists / albums / playlists) only exist in the liner catalog
export function buildSearchResults({ linerItems, external, sourceFilter }: BuildSearchResultsInput): Row[] {
  const linerTracks = linerItems.filter(isTrackRow).map(withSource);
  const externalRows: Row[] = external.map((t) => ({ ...t, _type: "track" }));

  const bySource = SOURCE_ORDER.map((source) =>
    source === "liner" ? linerTracks : externalRows.filter((r) => r.source === source),
  );
  let tracks = mergeTrackVariants(interleave(bySource)) as Row[];

  if (sourceFilter !== "all") {
    tracks = tracks
      .map((row) => {
        if (row.source === sourceFilter) return row;
        const variant = (row.variants as SourceVariant[] | undefined)?.find((v) => v.source === sourceFilter);
        return variant ? applyVariant(row, variant) : null;
      })
      .filter((row): row is Row => row !== null);
    return tracks;
  }

  const firstTrackIdx = linerItems.findIndex(isTrackRow);
  const head = firstTrackIdx === -1 ? [] : linerItems.slice(0, firstTrackIdx);
  const tail = (firstTrackIdx === -1 ? linerItems : linerItems.slice(firstTrackIdx)).filter((r) => !isTrackRow(r));
  return [...head, ...tracks, ...tail];
}

export function previewOnlyFor(row: { source?: SourceId; previewOnly?: boolean }): boolean {
  return row.previewOnly ?? (row.source ? isPreviewOnly(row.source) : false);
}
