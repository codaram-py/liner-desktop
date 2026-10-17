import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";

// "log in with spotify": the official authorization code flow with PKCE. no client secret involved, the user's own
// browser does the login and spotify redirects to a one-shot server on loopback. only the refresh token is kept
export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
export const SCOPES = ["playlist-read-private", "playlist-read-collaborative", "user-library-read"];

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export interface StoredSession {
  clientId: string;
  refreshToken: string;
  displayName?: string;
}

export interface SessionStore {
  read: () => StoredSession | null;
  write: (session: StoredSession | null) => void;
}

export interface SpotifyAuthStatus {
  loggedIn: boolean;
  displayName?: string;
}

export function makePkce(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = random(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(opts: { clientId: string; challenge: string; state: string; redirectUri?: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri ?? REDIRECT_URI);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

// the refresh token is a long lived secret: encrypted with the os keychain (electron safeStorage) when there is one
export interface SecretBox {
  isAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (data: Buffer) => string;
}

export function createFileSessionStore(file: string, box: SecretBox): SessionStore {
  return {
    read() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof raw.clientId !== "string" || typeof raw.refreshToken !== "string") return null;
        const refreshToken = raw.encrypted ? box.decrypt(Buffer.from(raw.refreshToken, "base64")) : raw.refreshToken;
        return { clientId: raw.clientId, refreshToken, displayName: typeof raw.displayName === "string" ? raw.displayName : undefined };
      } catch {
        return null;
      }
    },
    write(session) {
      if (!session) {
        fs.rmSync(file, { force: true });
        return;
      }
      const encrypted = box.isAvailable();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          clientId: session.clientId,
          displayName: session.displayName,
          encrypted,
          refreshToken: encrypted ? box.encrypt(session.refreshToken).toString("base64") : session.refreshToken,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, file);
    },
  };
}

export interface SpotifyAuthDeps {
  store: SessionStore;
  openExternal: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  port?: number;
  timeoutMs?: number;
  random?: (n: number) => Buffer;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0b0d;color:#f2f2f4;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#a0a0a8;margin:0}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

export function createSpotifyAuth(deps: SpotifyAuthDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const port = deps.port ?? REDIRECT_PORT;
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  let access: { token: string; expiresAt: number } | null = null;
  let pending = false;

  async function tokenRequest(params: Record<string, string>) {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    return { ok: res.ok, status: res.status, body };
  }

  function waitForCallback(state: string): { promise: Promise<string>; cancel: () => void; listening: Promise<void> } {
    let cancel: () => void = () => {};
    let onListening: () => void = () => {};
    let onListenError: (err: Error) => void = () => {};
    const listening = new Promise<void>((res, rej) => {
      onListening = res;
      onListenError = rej;
    });
    listening.catch(() => {});
    const promise = new Promise<string>((resolve, reject) => {
      let settled = false;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const finish = (status: number, title: string, text: string, result: () => void) => {
          res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE(title, text));
          if (!settled) {
            settled = true;
            result();
            server.close();
            server.closeAllConnections?.();
          }
        };
        if (url.searchParams.get("state") !== state) {
          // anything else on the machine that pokes this port must not be able to end the login
          res.writeHead(400, { "content-type": "text/plain" }).end("invalid state");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error || !code) {
          finish(400, "Login cancelado", "Pode fechar esta aba e tentar de novo no Liner.", () => reject(new Error(error === "access_denied" ? "login was cancelled" : `spotify returned an error: ${error ?? "no code"}`)));
          return;
        }
        finish(200, "Tudo certo", "Spotify conectado. Pode fechar esta aba e voltar pro Liner.", () => resolve(code));
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.close();
        server.closeAllConnections?.();
        reject(new Error("login timed out"));
      }, timeoutMs);
      server.on("close", () => clearTimeout(timer));
      server.once("listening", () => onListening());
      server.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        settled = true;
        const failure = new Error(err.code === "EADDRINUSE" ? `port ${port} is busy, close whatever uses it and try again` : err.message);
        onListenError(failure);
        reject(failure);
      });
      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
        reject(new Error("login cancelled"));
      };
      server.listen(port, "127.0.0.1");
    });
    return { promise, cancel: () => cancel(), listening };
  }

  async function login(clientId: string): Promise<SpotifyAuthStatus> {
    if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) throw new Error("that does not look like a Spotify Client ID");
    if (pending) throw new Error("a login is already open in your browser");
    pending = true;
    try {
      const { verifier, challenge } = makePkce(deps.random);
      const state = (deps.random ?? randomBytes)(16).toString("base64url");
      const callback = waitForCallback(state);
      callback.promise.catch(() => {});
      // the browser only opens once the callback port is ours, so a busy port fails before anything is shown
      await callback.listening;
      try {
        await deps.openExternal(buildAuthUrl({ clientId, challenge, state }));
      } catch (err) {
        // a browser that cannot be opened must not leave the one-shot server holding the port for three minutes
        callback.cancel();
        throw err;
      }
      const code = await callback.promise;

      const exchanged = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      });
      if (!exchanged.ok || !exchanged.body.access_token || !exchanged.body.refresh_token) {
        throw new Error(`spotify did not accept the login (${exchanged.body.error_description ?? exchanged.body.error ?? exchanged.status})`);
      }
      access = { token: exchanged.body.access_token, expiresAt: now() + (exchanged.body.expires_in ?? 3600) * 1000 };

      let displayName: string | undefined;
      try {
        const me = await fetchImpl("https://api.spotify.com/v1/me", { headers: { authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(10_000) });
        if (me.ok) displayName = ((await me.json()) as { display_name?: string }).display_name || undefined;
      } catch {}

      deps.store.write({ clientId, refreshToken: exchanged.body.refresh_token, displayName });
      return { loggedIn: true, displayName };
    } finally {
      pending = false;
    }
  }

  async function getAccessToken(): Promise<string | null> {
    if (access && access.expiresAt > now() + 60_000) return access.token;
    const session = deps.store.read();
    if (!session) return null;

    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId });
    if (!refreshed.ok || !refreshed.body.access_token) {
      // a revoked or expired grant cannot recover, ask for a new login. a network blip or 5xx keeps the session
      if (refreshed.status === 400 || refreshed.status === 401) {
        deps.store.write(null);
        access = null;
        return null;
      }
      throw new Error(`could not refresh the Spotify session (${refreshed.status})`);
    }
    access = { token: refreshed.body.access_token, expiresAt: now() + (refreshed.body.expires_in ?? 3600) * 1000 };
    if (refreshed.body.refresh_token && refreshed.body.refresh_token !== session.refreshToken) {
      deps.store.write({ ...session, refreshToken: refreshed.body.refresh_token });
    }
    return access.token;
  }

  function status(): SpotifyAuthStatus {
    const session = deps.store.read();
    return session ? { loggedIn: true, displayName: session.displayName } : { loggedIn: false };
  }

  function logout(): void {
    access = null;
    deps.store.write(null);
  }

  // a 401 from the api means the cached token died early, the next call refreshes it
  function invalidate(): void {
    access = null;
  }

  return { login, getAccessToken, status, logout, invalidate };
}
