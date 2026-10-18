// last resort when every innertube client is refused: let youtube's own web player run in a hidden electron window.
// that is a real browser session, it proves itself to youtube the way the website does (botguard / po token), so the
// audio request it makes is one googlevideo accepts. the app only reads the url of that request and then downloads the
// stream itself. nothing is spoofed or forged here, the page is simply played muted and invisible.
export interface CapturedAudio {
  url: string;
  contentLength: number;
  mimeType: string;
}

// query keys that belong to one particular chunk request; the download adds its own range
const PER_REQUEST_KEYS = ["range", "rn", "rbuf", "cpn", "alr"];

// googlevideo "videoplayback" request → the audio stream it belongs to, or null (video, ads, other hosts)
export function pickAudioRequest(rawUrl: string, hostCheck: (host: string) => boolean = (h) => h.endsWith(".googlevideo.com")): CapturedAudio | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!hostCheck(url.hostname) || !url.pathname.endsWith("/videoplayback")) return null;

  const mime = url.searchParams.get("mime") ?? "";
  if (!mime.startsWith("audio/")) return null;
  // ads come from the same hosts and are tagged, they are not the song
  const source = url.searchParams.get("source");
  if (source && source !== "youtube") return null;
  if (url.searchParams.has("oad")) return null;

  const contentLength = Number(url.searchParams.get("clen"));
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null;

  for (const key of PER_REQUEST_KEYS) url.searchParams.delete(key);
  return { url: url.toString(), contentLength, mimeType: mime };
}

export interface CaptureOptions {
  timeoutMs?: number;
  // test seams, production uses the youtube watch page and googlevideo
  watchUrl?: (videoId: string) => string;
  urlPatterns?: string[];
  hostCheck?: (host: string) => boolean;
}

export interface CaptureResult extends CapturedAudio {
  userAgent: string;
  headers: Record<string, string>;
  // downloads through the same session (cookies, network stack) that produced the url
  fetch: typeof fetch;
}

const PARTITION = "persist:youtube-capture";
let queue: Promise<unknown> = Promise.resolve();

// one capture at a time: the request listener is per session and a request does not say which video it is for
export function captureAudioUrl(videoId: string, options: CaptureOptions = {}): Promise<CaptureResult> {
  const run = queue.then(() => capture(videoId, options));
  queue = run.catch(() => {});
  return run;
}

async function capture(videoId: string, options: CaptureOptions): Promise<CaptureResult> {
  const { BrowserWindow, session } = await import("electron");
  const ses = session.fromPartition(PARTITION);
  const watchUrl = options.watchUrl?.(videoId) ?? `https://www.youtube.com/watch?v=${videoId}`;
  const patterns = options.urlPatterns ?? ["*://*.googlevideo.com/*"];

  // skips the cookie consent wall some regions get before the player loads
  await ses.cookies
    .set({ url: "https://www.youtube.com", name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/", secure: true, expirationDate: Math.floor(Date.now() / 1000) + 31536000 })
    .catch(() => {});

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 600,
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setAudioMuted(true);

  try {
    const found = await new Promise<CapturedAudio>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the web player did not request any audio within ${(options.timeoutMs ?? 25_000) / 1000}s`)), options.timeoutMs ?? 25_000);
      ses.webRequest.onBeforeRequest({ urls: patterns }, (details, callback) => {
        callback({});
        const hit = pickAudioRequest(details.url, options.hostCheck);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        }
      });
      win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) {
          clearTimeout(timer);
          reject(new Error(`watch page failed to load: ${description}`));
        }
      });
      // some layouts need a nudge even with autoplay allowed
      win.webContents.on("did-finish-load", () => {
        void win.webContents.executeJavaScript("document.querySelector('video')?.play?.()", true).catch(() => {});
      });
      win.loadURL(watchUrl).catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const userAgent = ses.getUserAgent();
    return {
      ...found,
      userAgent,
      // electron's fetch refuses Origin / Referer as plain headers, the referrer option is the supported way
      headers: {},
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        ses.fetch(String(input), { ...init, credentials: "include", referrer: "https://www.youtube.com/" })) as typeof fetch,
    };
  } finally {
    ses.webRequest.onBeforeRequest(null);
    if (!win.isDestroyed()) win.destroy();
  }
}
