export type YoutubeInput =
  | { kind: "video"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "none" };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOST_RE = /^(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com$/i;

function pickId(value: string | null | undefined): string | null {
  return value && VIDEO_ID_RE.test(value) ? value : null;
}

// accepts watch / shorts / embed / live / youtu.be / music.youtube.com urls, playlist urls and bare 11-char ids
export function parseYoutubeInput(raw: string): YoutubeInput {
  const input = raw.trim();
  if (!input) return { kind: "none" };

  if (VIDEO_ID_RE.test(input)) return { kind: "video", id: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { kind: "none" };
  }

  const host = url.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = pickId(url.pathname.split("/").filter(Boolean)[0]);
    return id ? { kind: "video", id } : { kind: "none" };
  }

  if (!YT_HOST_RE.test(host)) return { kind: "none" };

  const watchId = pickId(url.searchParams.get("v"));
  if (watchId) return { kind: "video", id: watchId };

  const [section, maybeId] = url.pathname.split("/").filter(Boolean);
  if (section && ["shorts", "embed", "live", "v"].includes(section)) {
    const id = pickId(maybeId);
    if (id) return { kind: "video", id };
  }

  const list = url.searchParams.get("list");
  if (list && /^[A-Za-z0-9_-]{10,}$/.test(list)) return { kind: "playlist", id: list };

  return { kind: "none" };
}
