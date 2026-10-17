<div align="center">

# Liner

**Modern desktop music streaming player with syllable-synced lyrics and reactive dynamic visuals.**

[![Electron](https://img.shields.io/badge/Electron-44.0-47848F?style=flat-square&logo=electron&logoColor=black&labelColor=white)](https://electronjs.org)
[![React 19](https://img.shields.io/badge/React_19-19.2-61DAFB?style=flat-square&logo=react&logoColor=black&labelColor=white)](https://react.dev)
[![TypeScript 5](https://img.shields.io/badge/TypeScript_5-5.0-3178C6?style=flat-square&logo=typescript&logoColor=black&labelColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS_v4-v4.0-06B6D4?style=flat-square&logo=tailwindcss&logoColor=black&labelColor=white)](https://tailwindcss.com)
[![WebAssembly](https://img.shields.io/badge/Rust-WebAssembly-654FF0?style=flat-square&logo=webassembly&logoColor=black&labelColor=white)](https://webassembly.org)
[![License: Source-Available](https://img.shields.io/badge/License-Source--Available-blueviolet?style=flat-square&labelColor=white)](./LICENSE)

[Preview](#preview) •
[Architecture](#architecture) •
[Getting Started](#getting-started) •
[Building](#building) •
[Contributing](#contributing) •
[License](#license)

<br/>

<img src="./.github/assets/lyrics_preview.png" alt="Liner Fullscreen Lyrics" width="100%" />

</div>

---

## Preview

<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img src="./.github/assets/home.png" alt="Liner Home Page" />
        <br/>
        <sub><b>Home</b></sub>
      </td>
      <td align="center" width="50%">
        <img src="./.github/assets/demo.gif" alt="Liner Fullscreen Mode Demo" />
        <br/>
        <sub><b>Fullscreen mode</b></sub>
      </td>
    </tr>
  </table>
</div>

---

> [!NOTE]
> Liner client connects to the official Liner API backend for music catalog, streaming playback, and synchronized lyrics.

---

## Architecture

```
liner/desktop/
├── electron/
│   ├── main.ts              # Electron main process & IPC handlers
│   ├── preload.ts           # Context bridge & secure renderer bindings
│   ├── crypto.ts            # High-performance in-memory WebAssembly signer
│   └── signer.ts            # Embedded WebAssembly binary
├── src/
│   ├── assets/              # Static assets and media
│   ├── components/          # Shared reusable UI components
│   ├── features/            # Feature modules (player, lyrics, queue, library, search, auth)
│   ├── pages/               # Route views (Home, Search, Album, Artist, Playlist)
│   ├── shared/              # API client, state stores (Zustand), and data contracts
│   ├── App.tsx              # Application root
│   └── main.tsx             # Vite entry point
├── package.json
└── vite.config.ts
```

---

## Getting Started

### Prerequisites

- **Node.js** `v20+` and **pnpm** or **Bun**
- Modern OS (Windows 10/11, macOS, or Linux)

---

### Setup

```bash
# 1. Clone repository
git clone https://github.com/tryliner/desktop.git
cd desktop

# 2. Install dependencies (pnpm or Bun)
pnpm install
# or
bun install
```

---

### Running in Development

```bash
# Start Liner in development mode (Electron app with Vite hot-reload)
pnpm run dev
# or
bun run dev
```

---

## Local mode

By default the app runs without a Liner account and without the Liner backend: no login screen, nothing is sent to their servers. Your data lives in plain json files you can open, back up or edit:

```
~/Liner/
├── config.json    # profile: name, username, avatar, bio
└── library.json   # liked tracks, playlists, play history
```

Set `LINER_DATA_DIR` to use another folder. The folder button next to your name in Settings opens it. Writes are atomic and a corrupt file is moved aside (`*.corrupt-<timestamp>`) instead of deleted.

What still needs the Liner servers and is empty in local mode: catalog search, recommendations, charts, lyrics, playlist import. YouTube, Deezer and Apple Music search/playback (see Sources) work without them.

Build with `VITE_LINER_ONLINE=true` to get the original login flow back.

---

## Sources

Search merges the Liner catalog with providers that run locally in the app:

| Source | Playback | Notes |
|---|---|---|
| YouTube | full track | search, pasted video / playlist links and bare video ids, resolved in the Electron main process (`electron/youtube.ts`, `youtubei.js`) and streamed through a loopback proxy (`electron/youtubeProxy.ts`) |
| SoundCloud | full track | search, pasted track / set links, progressive mp3 streams (`electron/soundcloud.ts`). GO+ snippets go to the Prévia category |
| Spotify | full track via YouTube | search and pasted track / album / playlist links through the official Web API, metadata only. Needs your own free developer app, see below |
| Deezer | full track via YouTube | public search endpoint for metadata. The song plays from the best matching YouTube upload (title, artist and duration are scored) |
| Apple Music | full track via YouTube | public iTunes search endpoint, same matching as Deezer |

Deezer and Apple Music do not give out full streams without a paid, DRM protected session, so only their official 30s clips are played from them directly. Those clips are listed under the **Prévia** chip at the right end of the source filter, never mixed into the normal results.

**Spotify**: pasted track / album / playlist links open without any setup (public embed pages). Searching needs your Spotify account, because the Spotify API has no anonymous search:

1. Create a free app at <https://developer.spotify.com/dashboard> and add `http://127.0.0.1:8888/callback` under *Redirect URIs*.
2. Open the Spotify chip in the search, paste the app's **Client ID** and press **Entrar com Spotify**. Your browser opens Spotify's own login page (official PKCE flow, no password or client secret ever reaches the app).
3. Done. The session lasts until you press *Sair*; the refresh token is stored in `~/Liner/spotify-session.json`, encrypted with the OS keychain when one is available.

Once signed in, private and collaborative playlists open, and the **Músicas curtidas** button loads your liked songs as a queue. The audio still plays from the matching YouTube upload: Spotify's own audio is DRM protected and only plays inside its official players, a Premium plan does not change that. Without logging in you can instead save a Client ID + Secret (`"spotify": { "clientId": "...", "clientSecret": "..." }` in `~/Liner/config.json`) for search only.

```json
{
  "spotify": { "clientId": "your client id", "clientSecret": "your client secret" }
}
```

Each result row ends with a source badge. A `+N` chip means the same song exists on N other sources, click it to pick one. The chip row under the search tabs filters by source.

---

## Testing

```bash
# Run test suite with Vitest
bun run test
# or
pnpm test
```

---

## Building

```bash
# Build desktop packages for your current OS:

# Linux (AppImage & .deb)
bun run electron:build:linux

# Windows (.exe installer)
bun run electron:build:win
```

Compiled distributions will be placed in the `release/` directory.

---

## Contributing

Bug fixes, small features, and docs fixes are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you open a pull request. The [license](./LICENSE) limits what a fork is allowed to do.

---

## Special Thanks

- [`@braccato/core`](https://github.com/better-lyrics/braccato) & `@braccato/parsers` — Synced lyrics components and format parsers.
- [`@kawarp/react`](https://github.com/better-lyrics/kawarp) & `@kawarp/core` — WebGL background shader components.
- [Solar Icons](https://solar-icons.com) & [MingCute Icons](https://www.mingcute.com) — Icon collections.

---

## License

Liner is distributed under the **Liner Source-Available & Non-Commercial Contribution License**.

- **Allowed**: Personal non-commercial usage, local builds, and upstream contributions.
- **Prohibited**: Commercial distribution, public competing forks, or extracting core algorithms for third-party products.

See [LICENSE](./LICENSE) for details.

