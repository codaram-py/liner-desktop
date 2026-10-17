import { memo, useCallback, useEffect, useRef, useState } from "react";

interface Status {
  loggedIn: boolean;
  pending?: { userCode: string; verificationUrl: string };
  error?: string;
}

const FONT = { fontFamily: "var(--font-inter), sans-serif" } as const;
const BUTTON =
  "cursor-pointer rounded-[6px] border-0 bg-border-alpha-14 px-[10px] py-[5px] text-[12px] text-text-secondary hover:text-text-primary";

// shown on the YouTube filter. youtube answers "sign in to confirm you're not a bot" to anonymous clients; signing in
// once (google's tv device code flow, the code is typed on google.com/device) lifts that
function YoutubeAccountBar({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const refresh = useCallback(async () => {
    const next = await window.linerElectron?.youtubeAuthStatus?.().catch(() => null);
    if (!next) return null;
    setStatus(next);
    return next;
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    timer.current = setInterval(async () => {
      const next = await refresh();
      if (next && !next.pending) {
        stopPolling();
        if (next.loggedIn) onChanged?.();
      }
    }, 2000);
  }, [refresh, onChanged]);

  useEffect(() => {
    void refresh().then((s) => s?.pending && poll());
    return stopPolling;
  }, [refresh, poll]);

  // an old build (or a stale preload) has no login bridge: say so instead of silently hiding the button
  if (!window.linerElectron?.youtubeAuthStatus) {
    return (
      <div className="px-[16px] pb-[8px] text-[12px] text-text-tertiary shrink-0" style={FONT} data-prevent-drag>
        Esta versão do app não tem o login do YouTube. Troque a pasta pelo zip mais novo, rode pnpm install e reinicie o pnpm dev.
      </div>
    );
  }
  if (!status) return null;

  if (status.loggedIn) {
    return (
      <div className="flex items-center gap-[8px] px-[16px] pb-[8px] shrink-0" style={FONT} data-prevent-drag>
        <span className="h-[7px] w-[7px] rounded-full bg-[#ff3b3b]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">YouTube conectado</span>
        <button
          type="button"
          className={BUTTON}
          style={FONT}
          onClick={async () => {
            await window.linerElectron?.youtubeLogout?.();
            await refresh();
          }}
        >
          Sair
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-[8px] px-[16px] pb-[8px] shrink-0" style={FONT} data-prevent-drag>
      {status.pending ? (
        <>
          <span className="text-[12px] text-text-tertiary">Digite este código em</span>
          <button
            type="button"
            className={BUTTON}
            style={FONT}
            onClick={() => window.open(status.pending!.verificationUrl, "_blank", "noopener,noreferrer")}
          >
            {status.pending.verificationUrl.replace(/^https?:\/\//, "")}
          </button>
          <span className="rounded-[6px] bg-border-alpha-14 px-[10px] py-[4px] text-[14px] font-semibold tracking-[0.12em] text-text-primary select-text">
            {status.pending.userCode}
          </span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-[12px] text-text-tertiary">
            {status.error ? `Login falhou: ${status.error}` : "Erro de bot no YouTube? Entre com sua conta (só uma vez)."}
          </span>
          <button
            type="button"
            className={BUTTON}
            style={FONT}
            onClick={async () => {
              const next = await window.linerElectron?.youtubeLoginStart?.().catch(() => null);
              if (next) {
                setStatus(next);
                if (next.pending) {
                  window.open(next.pending.verificationUrl, "_blank", "noopener,noreferrer");
                  poll();
                }
              }
            }}
          >
            Entrar com Google
          </button>
        </>
      )}
    </div>
  );
}

export default memo(YoutubeAccountBar);
