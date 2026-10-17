// the player request carries `signatureTimestamp`, taken from youtube's base.js. youtubei.js pulls it out with a js
// analyzer and falls back to 0 when youtube reshuffles the script. 0 makes the server answer "The page needs to be
// reloaded". this reads the value with plain patterns instead, the same ones other extractors rely on
export interface PlayerLike {
  player_id?: string;
  signature_timestamp?: number;
}

const STS_PATTERNS = [/signatureTimestamp["']?\s*[:=]\s*(\d{5})/, /\bsts["']?\s*[:=]\s*(\d{5})/];

export function extractSignatureTimestamp(source: string): number | null {
  for (const re of STS_PATTERNS) {
    const m = re.exec(source);
    if (m) return Number(m[1]);
  }
  return null;
}

// returns a one line description for the log
export async function ensureSignatureTimestamp(
  player: PlayerLike | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!player) return "no player loaded";
  if (player.signature_timestamp) return `player ${player.player_id} sts=${player.signature_timestamp}`;
  if (!player.player_id) return "player without id, sts unknown";
  try {
    const res = await fetchImpl(`https://www.youtube.com/s/player/${player.player_id}/player_es6.vflset/en_US/base.js`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `player ${player.player_id} sts=0, base.js answered ${res.status}`;
    const sts = extractSignatureTimestamp(await res.text());
    if (!sts) return `player ${player.player_id} sts=0, not found in base.js`;
    player.signature_timestamp = sts;
    return `player ${player.player_id} sts=${sts} (patched, the library found none)`;
  } catch (err) {
    return `player ${player.player_id} sts=0, base.js fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
