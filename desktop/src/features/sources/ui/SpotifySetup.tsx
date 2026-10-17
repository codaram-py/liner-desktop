import { memo, useState } from "react";
import { flushLocalStore, updateConfig } from "@/shared/local/localStore";

export interface SpotifySetupProps {
  onSaved: () => void;
}

const FONT = { fontFamily: "var(--font-inter), sans-serif" } as const;
const INPUT =
  "min-w-0 flex-1 rounded-[6px] border-0 bg-border-alpha-14 px-[10px] py-[7px] text-[12px] text-text-primary outline-none placeholder:text-text-tertiary";

// the spotify search api has no anonymous mode. a free developer app gives the two values this form saves into
// config.json (kept untouched when the profile is saved, read by the main process on every search)
function SpotifySetup({ onSaved }: SpotifySetupProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = clientId.trim().length >= 20 && clientSecret.trim().length >= 20 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    updateConfig((config) => {
      config.spotify = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
    });
    await flushLocalStore();
    setSaving(false);
    setClientId("");
    setClientSecret("");
    onSaved();
  };

  return (
    <div className="flex flex-col gap-[8px] px-[16px] pb-[10px] shrink-0" style={FONT} data-prevent-drag>
      <p className="m-0 text-[12px] leading-snug text-text-tertiary">
        A busca do Spotify precisa de um app gratuito seu (2 minutos). Links colados de faixa, álbum e playlist já funcionam sem isso.{" "}
        <button
          type="button"
          onClick={() => window.open("https://developer.spotify.com/dashboard", "_blank")}
          className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-text-secondary underline hover:text-text-primary"
          style={FONT}
        >
          Abrir developer.spotify.com
        </button>
        . Crie o app e copie o Client ID e o Client Secret (Redirect URI pode ser http://127.0.0.1:8888/callback).
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
          onClick={() => void save()}
          disabled={!canSave}
          className="shrink-0 cursor-pointer rounded-[6px] border-0 bg-text-primary px-[12px] py-[7px] text-[12px] text-bg-primary disabled:cursor-default disabled:opacity-40"
          style={FONT}
        >
          {saving ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </div>
  );
}

export default memo(SpotifySetup);
