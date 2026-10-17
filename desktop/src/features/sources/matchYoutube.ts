import { normalizeArtist, normalizeTitle } from "./mergeResults";

export interface MatchTarget {
  title: string;
  artists: string;
  durationMs: number;
}

export interface MatchCandidate {
  title: string;
  artists: string;
  durationMs: number;
}

// deezer and apple music only give us metadata, the audio comes from the best matching youtube upload.
// uploads that are not the studio recording are penalised unless the track itself says so
const UNWANTED: [RegExp, string][] = [
  [/\blive\b|ao vivo|en vivo/, "live"],
  [/\bcover\b/, "cover"],
  [/karaoke/, "karaoke"],
  [/instrumental/, "instrumental"],
  [/\bremix\b|mashup|\bbootleg\b/, "remix"],
  [/sped up|speed up|slowed|reverb|8d audio|nightcore/, "edit"],
  [/reaction|tutorial|how to play/, "other"],
];

const MAX_DURATION_DIFF_MS = 45_000;
const MIN_SCORE = 0.55;
const MIN_TITLE_SIM = 0.5;

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function tokens(text: string): Set<string> {
  return new Set(
    fold(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function titleSimilarity(target: string, candidate: string): number {
  const t = normalizeTitle(target);
  const c = normalizeTitle(candidate);
  if (t && c) {
    if (t === c) return 1;
    const [short, long] = t.length <= c.length ? [t, c] : [c, t];
    if (short.length >= 4 && long.includes(short)) return 0.9;
  }
  return jaccard(tokens(target), tokens(candidate));
}

function artistSimilarity(target: string, candidate: MatchCandidate): number {
  const ta = normalizeArtist(target);
  if (!ta) return 0.5;
  const ca = normalizeArtist(candidate.artists);
  if (ca === ta) return 1;
  const haystack = fold(`${candidate.artists} ${candidate.title}`).replace(/[^\p{L}\p{N}]+/gu, "");
  if (haystack.includes(ta)) return 0.9;
  return jaccard(tokens(target.split(/,|&| feat\.? /i)[0] ?? target), tokens(candidate.artists)) * 0.8;
}

function durationSimilarity(target: number, candidate: number): number | null {
  if (!target || !candidate) return 0.5;
  const diff = Math.abs(target - candidate);
  if (diff > MAX_DURATION_DIFF_MS) return null;
  if (diff <= 3_000) return 1;
  if (diff <= 8_000) return 0.8;
  if (diff <= 15_000) return 0.4;
  return 0.1;
}

export function scoreCandidate(target: MatchTarget, candidate: MatchCandidate): number {
  const duration = durationSimilarity(target.durationMs, candidate.durationMs);
  if (duration === null) return 0;

  const title = titleSimilarity(target.title, candidate.title);
  if (title < MIN_TITLE_SIM) return 0;
  const artist = artistSimilarity(target.artists, candidate);

  const wanted = fold(target.title);
  const seen = fold(candidate.title);
  let penalty = 0;
  for (const [re] of UNWANTED) {
    if (re.test(seen) && !re.test(wanted)) penalty += 0.5;
  }

  return 0.4 * title + 0.25 * artist + 0.35 * duration - penalty;
}

export function pickBestYoutubeMatch<T extends MatchCandidate>(target: MatchTarget, candidates: T[]): T | null {
  let best: T | null = null;
  let bestScore = MIN_SCORE;
  for (const candidate of candidates) {
    const score = scoreCandidate(target, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
