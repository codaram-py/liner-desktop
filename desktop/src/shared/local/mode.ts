// local mode: no liner account, no liner backend. profile + library live in ~/Liner (see electron/localData.ts).
// set VITE_LINER_ONLINE=true at build time to get the original login flow back. tests run against the online code paths.
export function isLocalMode(): boolean {
  if (import.meta.env.MODE === "test") return false;
  return import.meta.env.VITE_LINER_ONLINE !== "true";
}

export const LOCAL_USER_ID = "local-user";
