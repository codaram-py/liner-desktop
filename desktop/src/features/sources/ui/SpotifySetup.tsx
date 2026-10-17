import { memo, useState } from "react";
import { flushLocalStore, getConfig, updateConfig } from "@/shared/local/localStore";

export interface SpotifySetupProps {
  onSaved: () => void;
}

const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const FONT = { fontFamily: "var(--font-inter), sans-serif" } as const;
const INPUT =
  "min-w-0 flex-1 rounded-[6px] border-0 bg-border-alpha-14 px-[10px] py-[7px] text-[12px] text-text-primary outline-none placeholder:text-text-tertiary";
const LINK = "cursor-pointer border-0 bg-transparent p-0 text-[12px] text-text-secondary underline hover:text-text-primary";

function savedSpotify(): Record<string, unknown> {
  const value = getConfig().spotify;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// "log in with spotify": the Client ID of a free developer app is the only thing typed, the login itself happens in
// the browser (official PKCE flow, see electron/spotifyAuth.ts). the search needs a connected account or app credentials
function SpotifySetup({ onSaved }: SpotifySetupProps) {
  const [clientId, setClientId] = useState(() => String(savedSpotify().clientId ?? ""));
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"login" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const validId = /^[A-Za-z0-9]{16,64}$/.test(clientId.trim());
  const validSecret = /^[A-Za-z0-9]{16,64}$/.test(clientSecret.trim());

  const persist = async (secret?: string) => {
    updateConfig((config) => {
      config.spotify = { ...savedSpotify(), clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) };
    });
    await flushLocalStore();
  };

  const login = async () => {
    const bridge = window.linerElectron;
    if (!validId || !bridge?.spotifyLogin) return;
    setBusy("login");
    setError(null);
    try {
      await persist();
      await bridge.spotifyLogin();
      onSaved();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ""));
    } finally {
      setBusy(null);
    }
  };

  const saveWithoutLogin = async () => {
    if (!validId || !validSecret) return;
    setBusy("save");
    setError(null);
    await persist(clientSecret.trim());
    setClientSecret("");
    setBusy(null);
    onSaved();
  };

  const copyRedirect = () => {
    void navigator.clipboard?.writeText(REDIRECT_URI).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col gap-[8px] px-[16px] pb-[10px] shrink-0" style={FONT} data-prevent-drag>
      <p className="m-0 text-[12px] leading-snug text-text-tertiary">
        Entre com a sua conta do Spotify uma vez e depois a busca roda normal (as playlists privadas e as músicas curtidas também abrem). Precisa só do{" "}
        <b className="font-medium text-text-secondary">Client ID</b> de um app seu, grátis:{" "}
        <button type="button" className={LINK} style={FONT} onClick={() => window.open("https://developer.spotify.com/dashboard", "_blank")}>
          abrir developer.spotify.com
        </button>
        , crie o app, em <i>Redirect URIs</i> cadastre exatamente{" "}
        <button type="button" className={LINK} style={FONT} onClick={copyRedirect} title="Copiar">
          {copied ? "copiado!" : REDIRECT_URI}
        </button>{" "}
        e copie o Client ID. O áudio continua tocando pelo YouTube.
      </p>

      <div className="flex items-center gap-[6px]">
        <input
          className={INPUT}
          style={FONT}
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => void login()}
          disabled={!validId || busy !== null}
          className="shrink-0 cursor-pointer rounded-[6px] border-0 bg-[#1ed760] px-[12px] py-[7px] text-[12px] font-medium text-black disabled:cursor-default disabled:opacity-40"
          style={FONT}
        >
          {busy === "login" ? "Aguardando o navegador…" : "Entrar com Spotify"}
        </button>
      </div>

      {error ? (
        <p className="m-0 text-[12px] leading-snug text-[#ff6b6b]" role="alert">
          {error}
        </p>
      ) : null}

      <details className="text-[12px] text-text-tertiary">
        <summary className="cursor-pointer select-none">Prefiro não entrar (usar Client ID + Secret)</summary>
        <div className="mt-[6px] flex items-center gap-[6px]">
          <input
            className={INPUT}
            style={FONT}
            placeholder="Client Secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => void saveWithoutLogin()}
            disabled={!validId || !validSecret || busy !== null}
            className="shrink-0 cursor-pointer rounded-[6px] border-0 bg-text-primary px-[12px] py-[7px] text-[12px] text-bg-primary disabled:cursor-default disabled:opacity-40"
            style={FONT}
          >
            {busy === "save" ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </details>
    </div>
  );
}

export default memo(SpotifySetup);
