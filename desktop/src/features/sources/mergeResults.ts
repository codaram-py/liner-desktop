import { SOURCES, isPreviewOnly, sourceOfTrackId, type SourceId, type SourceVariant } from "./types";

export interface MergeableTrack {
  id: string;
  title: string;
  artists: string;
  coverUrl?: string;
  durationMs?: number;
  source?: SourceId;
}

export type MergedTrack<T extends MergeableTrack> = T & {
  source: SourceId;
  // every copy of this track we found, primary first. only set when there is more than one
  variants?: SourceVariant[];
};

const NOISE_RE =
  /\s*[([](?:official|lyrics?|lyric video|audio|video|visuali[sz]er|hd|hq|4k|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|live)[^)\]]*[)\]]/gi;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function normalizeTitle(title: string): string {
  return fold(title)
    .replace(NOISE_RE, "")
    .replace(/\s*[([]\s*(?:feat|ft|featuring|with)\.?[^)\]]*[)\]]/g, "")
    .replace(/\s+-\s+(?:remaster(?:ed)?|single version|radio edit|album version).*$/, "")
    .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeArtist(artists: string): string {
  const first = fold(artists).split(/\s*(?:,|&|;|\/|\sx\s|\sfeat\.?\s|\sft\.?\s|\sand\s)\s*/)[0] ?? "";
  return first.replace(/[^\p{L}\p{N}]+/gu, "");
}

const DURATION_TOLERANCE_MS = 12_000;

function sameLength(a?: number, b?: number): boolean {
  if (!a || !b) return true;
  return Math.abs(a - b) <= DURATION_TOLERANCE_MS;
}

function toVariant(track: MergeableTrack, source: SourceId): SourceVariant {
  return {
    id: track.id,
    source,
    title: track.title,
    artists: track.artists,
    coverUrl: track.coverUrl ?? "",
    durationMs: track.durationMs ?? 0,
    previewOnly: isPreviewOnly(source) || undefined,
  };
}

// round robin across sources so a slow or empty provider never pushes the others below the fold
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]!);
    }
  }
  return out;
}

// groups copies of the same song found on different sources into one row with `variants`.
// the row plays the best source (see SOURCES[x].priority), the rest become the "+N" badge
export function mergeTrackVariants<T extends MergeableTrack>(items: T[]): MergedTrack<T>[] {
  interface Group {
    members: { track: T; source: SourceId }[];
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group[]>();

  for (const track of items) {
    const source = track.source ?? sourceOfTrackId(track.id);
    const titleKey = normalizeTitle(track.title);
    const artistKey = normalizeArtist(track.artists);
    const key = `${titleKey}|${artistKey}`;

    // without both title and artist we cannot tell tracks apart, never merge those
    const mergeable = titleKey.length > 0 && artistKey.length > 0;
    const candidates = mergeable ? (byKey.get(key) ?? []) : [];
    const group = candidates.find(
      (g) =>
        g.members.every((m) => m.source !== source) &&
        g.members.some((m) => sameLength(m.track.durationMs, track.durationMs)),
    );

    if (group) {
      group.members.push({ track, source });
    } else {
      const created: Group = { members: [{ track, source }] };
      groups.push(created);
      if (mergeable) byKey.set(key, [...candidates, created]);
    }
  }

  return groups.map(({ members }) => {
    const ranked = [...members].sort((a, b) => SOURCES[a.source].priority - SOURCES[b.source].priority);
    const primary = ranked[0]!;
    const merged: MergedTrack<T> = { ...primary.track, source: primary.source };
    if (members.length > 1) {
      merged.variants = ranked.map((m) => toVariant(m.track, m.source));
    }
    return merged;
  });
}
