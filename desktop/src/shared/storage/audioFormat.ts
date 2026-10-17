// true when the bytes start a complete audio file the <audio> element can open on its own.
// rejects fragmented-mp4 media segments ("styp"), error pages and other junk before caching.
export function isStandaloneAudioFile(head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head.length < 12) return false;
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // webm / matroska
  if (ascii(4, 8) === "ftyp") return true; // mp4 / m4a with its init header
  const magic = ascii(0, 4);
  if (magic === "OggS" || magic === "fLaC" || magic === "RIFF") return true;
  if (ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return true; // mp3
  return false;
}
