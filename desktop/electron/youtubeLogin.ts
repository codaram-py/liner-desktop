// "sign in to youtube": google's device flow (the same one smart tvs use). the user opens google.com/device, types the
// short code and approves. the resulting tokens are kept by youtubei.js through the secure cache. a signed in session
// is what gets past youtube's "sign in to confirm you're not a bot" answer
export interface YoutubeLoginStatus {
  loggedIn: boolean;
  pending?: { userCode: string; verificationUrl: string };
  error?: string;
}

type Listener = (...args: any[]) => void;

export interface LoginSession {
  logged_in: boolean;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  signIn(): Promise<void>;
  signOut(): Promise<unknown>;
  oauth: { cacheCredentials(): Promise<void>; removeCache(): Promise<void> };
}

export interface YoutubeLoginDeps {
  getSession: () => Promise<LoginSession>;
  onChange?: () => void;
}

export function createYoutubeLogin(deps: YoutubeLoginDeps) {
  let pending: YoutubeLoginStatus["pending"];
  let error: string | undefined;
  let loggedIn = false;
  let running = false;

  return {
    // called once at startup after a silent sign in from cached credentials
    markLoggedIn(value: boolean) {
      loggedIn = value;
    },

    status(): YoutubeLoginStatus {
      return { loggedIn, ...(pending ? { pending } : {}), ...(error ? { error } : {}) };
    },

    async start(): Promise<YoutubeLoginStatus> {
      if (loggedIn || running) return this.status();
      running = true;
      error = undefined;
      const session = await deps.getSession();
      const onPending: Listener = (data: { user_code: string; verification_url: string }) => {
        pending = { userCode: data.user_code, verificationUrl: data.verification_url };
      };
      session.on("auth-pending", onPending);

      // resolves only after the user approved on google.com/device, so it is deliberately not awaited here
      session
        .signIn()
        .then(async () => {
          await session.oauth.cacheCredentials();
          loggedIn = true;
          deps.onChange?.();
        })
        .catch((err: unknown) => {
          error = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          pending = undefined;
          running = false;
          session.off("auth-pending", onPending);
        });

      // the code arrives after one request to google, give it a moment so the first status already carries it
      for (let i = 0; i < 100 && !pending && !loggedIn && !error; i++) await new Promise((r) => setTimeout(r, 50));
      return this.status();
    },

    async logout(): Promise<void> {
      const session = await deps.getSession();
      try {
        if (session.logged_in) await session.signOut();
      } catch {
        // revoking is best effort, the local credentials are dropped either way
      }
      await session.oauth.removeCache();
      loggedIn = false;
      pending = undefined;
      error = undefined;
      deps.onChange?.();
    },
  };
}
