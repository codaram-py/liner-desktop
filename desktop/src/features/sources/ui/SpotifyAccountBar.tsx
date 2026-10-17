import { memo, useEffect, useState } from "react";

export interface SpotifyAccountBarProps {
  onOpenLiked: () => void;
  onLoggedOut: () => void;
}

const FONT = { fontFamily: "var(--font-inter), sans-serif" } as const;
const BUTTON =
  "cursor-pointer rounded-[6px] border-0 bg-border-alpha-14 px-[10px] py-[5px] text-[12px] text-text-secondary hover:text-text-primary";

// shown on the Spotify filter once a connected account exists: who is logged in, the liked songs shortcut, log out
function SpotifyAccountBar({ onOpenLiked, onLoggedOut }: SpotifyAccountBarProps) {
  const [account, setAccount] = useState<{ loggedIn: boolean; displayName?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.linerElectron?.spotifyStatus?.().then((status) => alive && setAccount(status)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!account?.loggedIn) return null;

  return (
    <div className="flex items-center gap-[8px] px-[16px] pb-[8px] shrink-0" style={FONT} data-prevent-drag>
      <span className="h-[7px] w-[7px] rounded-full bg-[#1ed760]" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
        Spotify conectado{account.displayName ? ` como ${account.displayName}` : ""}
      </span>
      <button type="button" className={BUTTON} style={FONT} onClick={onOpenLiked}>
        Músicas curtidas
      </button>
      <button
        type="button"
        className={BUTTON}
        style={FONT}
        onClick={async () => {
          await window.linerElectron?.spotifyLogout?.();
          setAccount({ loggedIn: false });
          onLoggedOut();
        }}
      >
        Sair
      </button>
    </div>
  );
}

export default memo(SpotifyAccountBar);
