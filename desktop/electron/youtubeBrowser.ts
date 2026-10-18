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
  // how long the user gets to solve google's "unusual traffic" check once the window is shown
  humanTimeoutMs?: number;
  isHumanCheckUrl?: (url: string) => boolean;
  // called once when the window has to be shown to the user
  onNeedsHuman?: () => void;
}

// google's interstitial for traffic it considers automated (a captcha). only a person can pass it
export function isHumanCheckUrl(url: string): boolean {
  return /^https?:\/\/([^/]+\.)?google\.[a-z.]+\/sorry\//i.test(url);
}

export interface CaptureResult extends CapturedAudio {
  userAgent: string;
  headers: Record<string, string>;
  // downloads through the same session (cookies, network stack) that produced the url
  fetch: typeof fetch;
}

const PARTITION = "persist:youtube-capture";

// what the page looked like when no audio request came, so a failure says why (bot wall, consent page, player error)
async function describePage(win: { isDestroyed(): boolean; webContents: { executeJavaScript(code: string, gesture?: boolean): Promise<unknown> } }): Promise<string> {
  if (win.isDestroyed()) return "window closed";
  try {
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const text = document.body?.innerText ?? "";
        const video = document.querySelector("video");
        return JSON.stringify({
          title: document.title.slice(0, 60),
          url: location.href.slice(0, 90),
          playerError: (document.querySelector(".ytp-error-content-wrap-reason, .ytp-error")?.innerText ?? "").slice(0, 120) || undefined,
          botWall: /not a bot|confirm you.re not/i.test(text) || undefined,
          consent: /consent\./i.test(location.href) || /before you continue/i.test(text) || undefined,
          video: !!video,
          paused: video ? video.paused : undefined,
          playability: (() => {
            const p = window.ytInitialPlayerResponse?.playabilityStatus;
            return p ? [p.status, (p.reason || "").slice(0, 80)].filter(Boolean).join(": ") : undefined;
          })(),
          state: document.getElementById("movie_player")?.getPlayerState?.(),
          ad: document.getElementById("movie_player")?.classList.contains("ad-showing") || undefined,
          visibility: document.visibilityState,
        });
      })()`,
      true,
    );
    return String(state);
  } catch {
    return "page could not be inspected";
  }
}
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

  // a window with show:false counts as a hidden page and youtube's player may never start in it. this one is shown,
  // but far off screen, transparent, out of the taskbar and unfocusable: the page sees a visible tab, the user sees nothing
  const win = new BrowserWindow({
    show: false,
    x: -32000,
    y: -32000,
    width: 960,
    height: 600,
    skipTaskbar: true,
    focusable: false,
    title: "Verificação do YouTube",
    autoHideMenuBar: true,
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
    win.setOpacity(0);
  } catch {
    // not supported on every platform, the offscreen position already hides it
  }
  win.showInactive();

  try {
    const found = await new Promise<CapturedAudio>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 25_000;
      const humanTimeoutMs = options.humanTimeoutMs ?? 180_000;
      const isHumanCheck = options.isHumanCheckUrl ?? isHumanCheckUrl;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let revealed = false;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      // google wants a person: bring the window forward so the check can be solved. the cookie it sets afterwards
      // lives in this partition, later songs go through without the window
      const reveal = () => {
        if (revealed || win.isDestroyed()) return;
        revealed = true;
        options.onNeedsHuman?.();
        try {
          win.setOpacity(1);
        } catch {
          // see above
        }
        win.setFocusable(true);
        win.setSkipTaskbar(false);
        win.setSize(560, 760);
        win.center();
        win.show();
        win.focus();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => done(() => reject(new Error("the Google check was not completed in time"))), humanTimeoutMs);
      };

      timer = setTimeout(() => {
        void describePage(win).then((state) => {
          // the page itself may tell us: a bot wall without a redirect
          if (!settled && /"botWall":true/.test(state) && !revealed) return reveal();
          done(() => reject(new Error(`the web player did not request any audio within ${timeoutMs / 1000}s (${state})`)));
        });
      }, timeoutMs);

      ses.webRequest.onBeforeRequest({ urls: patterns }, (details, callback) => {
        callback({});
        const hit = pickAudioRequest(details.url, options.hostCheck);
        if (hit) done(() => resolve(hit));
      });
      // the check passed, the player page is back: put the window away again and give the player its usual time
      const conceal = () => {
        if (!revealed || win.isDestroyed()) return;
        revealed = false;
        win.hide();
        win.setSkipTaskbar(true);
        win.setFocusable(false);
        win.setPosition(-32000, -32000);
        try {
          win.setOpacity(0);
        } catch {
          // see above
        }
        win.showInactive();
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void describePage(win).then((state) => done(() => reject(new Error(`the web player did not request any audio within ${timeoutMs / 1000}s after the check (${state})`))));
        }, timeoutMs);
      };
      const onNavigate = (_event: unknown, url: string) => {
        if (isHumanCheck(url)) reveal();
        else conceal();
      };
      win.webContents.on("did-navigate", onNavigate);
      win.webContents.on("did-redirect-navigation", ((_event: unknown, url: string) => onNavigate(_event, url)) as never);
      win.on("closed", () => done(() => reject(new Error("the verification window was closed"))));
      win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) done(() => reject(new Error(`watch page failed to load: ${description}`)));
      });
      // some layouts need a nudge even with autoplay allowed; run it a few times, the player mounts after load
      win.webContents.on("did-finish-load", () => {
        const nudge = () =>
          win.isDestroyed()
            ? undefined
            : void win.webContents
                .executeJavaScript(
                  `(() => {
                    const player = document.getElementById("movie_player");
                    try { player?.mute?.(); player?.playVideo?.(); } catch {}
                    const v = document.querySelector("video");
                    if (v) { v.muted = true; v.play?.(); }
                    document.querySelector(".ytp-large-play-button")?.click();
                    // an ad in front of the song: skip it as soon as youtube allows
                    document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button")?.click();
                  })()`,
                  true,
                )
                .catch(() => {});
        // keeps nudging: ads need a few seconds before they can be skipped, the player may also mount late
        for (let delay = 0; delay <= 24_000; delay += delay < 6000 ? 1500 : 3000) setTimeout(nudge, delay);
      });
      win.loadURL(watchUrl).catch((err) => done(() => reject(err)));
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
