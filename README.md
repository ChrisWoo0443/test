# Spotify G2

Control Spotify from your **Even Realities G2** smart glasses — browse playlists, pick tracks, and control playback without touching your phone.

Existing G2 music apps only offer play/pause/skip. This one adds full playlist browsing: open any playlist, scroll to a song, and play it from the glasses.

## How it works

```
G2 glasses ←BLE→ Even Hub app (phone) ←WebView→ this app ←→ local server ←→ Spotify API
```

- **`src/main.ts`** — glasses UI (Even Hub SDK): two tabs (Now Playing / Playlists) plus a track drill-down
- **`src/ui.ts` + `index.html`** — companion UI shown on the phone: setup wizard, album art, progress bar, full playback controls
- **`server/index.ts`** — Express server that holds your Spotify tokens and proxies API calls

## Requirements

- Even Realities G2 glasses + the Even Hub phone app
- Node.js 18+
- A Spotify account (Premium required for playback control — a Spotify API limitation)
- A free [Spotify Developer](https://developer.spotify.com/dashboard) app — the in-app wizard walks you through creating one

## Getting started

```bash
npm install
npm run dev        # starts the server (:3001) and Vite (:5173)
npm run qr         # QR code — scan with the Even Hub app to sideload
```

Open the app in the Even Hub app (or a browser at `http://localhost:5173`) and follow the 3-step wizard:

1. **Create a Spotify app** — the wizard links to the dashboard and gives you the exact Redirect URI to paste
2. **Enter your Client ID + Secret** — validated immediately
3. **Authorize** — log in with Spotify and grant access

Credentials persist in `spotify-credentials.json` (gitignored). You can also pre-set them via `.env` — see `.env.example`.

## Glasses controls

| Gesture | Now Playing tab | Playlists tab | Track list |
|---|---|---|---|
| Swipe ↑/↓ | Cycle `<<` `\|\|` `>>` buttons | Scroll list | Scroll list |
| Tap | Execute selected button | Open playlist | Play track |
| Double-tap | Switch to Playlists | Switch to Now Playing | Back to playlists |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + Vite dev server with hot reload |
| `npm run typecheck` | Type-check glasses UI, companion UI, and server |
| `npm run build` | Production build to `dist/` |
| `npm run pack` | Build + package as `.ehpk` for distribution |

## Notes

- Playback control needs an **active Spotify device** (phone, desktop app, etc. currently playing or recently active). The Web API controls existing sessions; it can't start one from nothing.
- Tokens live in server memory; restarting the server requires re-authorizing (one tap — credentials are remembered).
- Playlist track loading is capped at 200 tracks per playlist.
