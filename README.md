# sov — Spotify overlay (Electron, Windows)

A tiny, animated Spotify overlay that lives in the corner of your screen
while gaming. It collapses to a small glowing yellow ring (like Discord's
gaming overlay) and expands to a full mini player with album art,
playback controls, volume, queue, search, library, and Apple Music–style
synced lyrics.

**Current build: `2026-11-13l-electron`** (see the footer in the app, or
`electron/server.js` `BUILD`).

## Install

Double-click **`installer/sov-setup.exe`**. It installs to
`%LOCALAPPDATA%\sov` (clean wipe first), creates Desktop + Start Menu
shortcuts to `sov.exe`, and registers an uninstaller. No admin rights,
no Python, no downloads at install time — the app is a self-contained
Electron build.

Uninstall from Windows Settings → Apps → "sov — Spotify overlay", or
run `uninstall.exe` in `%LOCALAPPDATA%\sov`. Your Client ID and login
are never touched by install or uninstall.

## Setup (first run)

sov logs in with your own Spotify app's Client ID via PKCE OAuth
(redirect URI `http://127.0.0.1:8888/callback` — the same one the old
Python overlay used, so no dashboard changes). If the Client ID is
already saved in `~/.spotify_overlay.json`, the app picks it up
automatically; otherwise the Connect screen asks you to paste it once.
Spotify login opens in your default browser; tokens live on your
machine only.

## Use it

- **Ctrl+Shift+M** — the global toggle, even mid-game (with Ctrl held it
  never types a character while gaming). Clicking the ring or the
  × shrink button does the same thing. If the low-level keyboard hook
  can't start, it falls back silently to the same combo via the global
  shortcut. The hotkey is configurable in `~/.sov-settings.json`.
- **Drag** the ring / player header to move it; position is remembered.
- **Opacity slider** under the volume row dims the whole window.
- **Close / ×** hides the app to the system tray instead of quitting —
  it keeps running in the background. Quit from the tray menu.
- **Library tab** — Liked Songs and playlists, tap to play. First use
  needs one Spotify reconnect for the new read permissions.
- In exclusive-fullscreen games the overlay may sit behind the game;
  switch the game to borderless windowed.

## How it works

```
electron/                 Electron shell (the actual app)
  main.js                 Window, tray, hotkey, single instance, IPC
  server.js               Local server on 127.0.0.1:8888 (Node port of
                          the old standalone/server.py HTTP contract):
                          serves the React app, /api/health,
                          /api/config (Client ID), PKCE login handoff,
                          /callback
  preload.js              window.pywebview.api bridge (contextBridge)
  hotkey.js               Ctrl+Shift+M hook + global-shortcut fallback
  callback.html           Spotify login callback page
  dist/                   Prebuilt React app (copied from
                          ../standalone/dist/ at packaging time)
standalone/client/src/    The React player — source of truth
  App.tsx                 Overlay UI: ring ⇄ player, lyrics, queue,
                          search, library
  spotify/                Spotify API, auth (PKCE), bridge
installer/                sov-setup.nsi → sov-setup.exe (NSIS)
```

The Electron window is frameless, transparent and always-on-top; its
own Chromium, no Python, no pip, no venv, no WebView2. The local
server runs inside the main process. Playback needs an active Spotify
device — with none open, pressing play wakes the best available one.
Synced lyrics come from [LRCLIB](https://lrclib.net).

## Build

```sh
# React client (source of truth is standalone/client/)
cd standalone/client && bun run typecheck && bun run build
# → outputs to standalone/dist/

# Copy the fresh build into the Electron shell, then pack:
cp -r standalone/dist/* electron/dist/
cd electron && bun run pack        # electron-builder --win --x64 --dir
# → electron/release/win-unpacked/sov.exe

# Installer (from installer/):
makensis sov-setup.nsi            # → sov-setup.exe
```

Bump the build stamp in `electron/server.js` (`BUILD`), in
`standalone/client/src/version.ts` (`CLIENT_BUILD`), and in
`installer/sov-setup.nsi` (`DisplayVersion`) on every shipped change —
the app footer shows the stamp so a stale build is provable.

## Legacy folders — NOT part of the exe

`client/`, `server/` and `drizzle/` are the old Muse-hosted web version
of this overlay (it ran inside Muse on the Spotify connector, no
Client ID, no desktop app). They are kept in this repo for reference
only: nothing in `electron/`, `standalone/client/` or `installer/`
imports or ships them, and the root `package.json` belongs to that
legacy space. Do not build the desktop app from them.

The old Python/pywebview shell (`standalone/server.py` and its
`.bat`/`setup.ps1` launchers) was removed when the Electron shell
replaced it — `electron/server.js` is its Node port. The React client
in `standalone/client/src/` still carries a few comments that mention
`server.py` / `run.bat` by name; they describe the same HTTP contract
the Electron server implements.

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, ship your own copy.
