# sov — Electron edition

A tiny, animated Spotify overlay that lives in the corner of your
screen while gaming. This is the Electron shell for the standalone
Windows build — it replaces the old Python/pywebview shell, which
kept failing on Windows (window compositing, bridge races, installer
environment). Every failure was in that shell; the React player was
never the problem, so it is reused unchanged from
`../standalone/dist/` (build `2026-11-12h`, plus the toggle change
described below).

## How it works

- **Electron window** (`main.js`): frameless, transparent,
  always-on-top, starting as the 70px ring in the bottom-right
  corner. Its own Chromium — no Python, no pip, no venv, no
  WebView2, nothing to download at install time.
- **Local server** (`server.js`): a tiny Node server inside the main
  process on `127.0.0.1:8888` — a port of `standalone/server.py`'s
  HTTP contract (same endpoints, same behaviour). It serves the
  prebuilt React app from `dist/`, plus `/api/health`, `/api/config`
  (Client ID from `~/.spotify_overlay.json`), the PKCE login handoff
  (`/api/login-state`, `/api/tokens`, single-use, in-memory only)
  and `/callback` (byte-identical to the old shell's callback page).
  The redirect URI is still `http://127.0.0.1:8888/callback` — the
  one registered in the Spotify dashboard. Port 8888 is pinned:
  the redirect URI is registered for 8888, so the app can never
  silently move to another port (that would break login). If port
  8888 is already held, the app shows a Retry/Quit dialog naming
  the port — Retry re-attempts the server start (a stale sov may
  have just exited), Quit exits.
- **Bridge** (`preload.js`): exposes `window.pywebview.api` with the
  methods the React app calls (`resize_window`, `open_login`,
  `quit`), plus `toggle`, `set_player_active`, `on_toggle`,
  `set_opacity` (window opacity slider) and `hide_window` (hide to
  tray) for the hotkey toggle. The preload runs before the renderer's
  JavaScript, so there is no bridge race — a one-shot resize on
  mount always lands. There is deliberately no `move_window` any
  more: dragging is native (see below), so the JS move path — which
  stretched the window — is gone entirely.
- **Dragging** (native): the overlay is dragged with the OS, not
  with JavaScript. The outer wrapper carries
  `-webkit-app-region: drag` and every interactive descendant
  (buttons, inputs, sliders) carries `-webkit-app-region: no-drag`.
  The old path — a `setPosition` IPC call on every pointermove —
  made the transparent window smear/stretch between positions on
  Windows; the OS move is atomic and cannot stretch. The window
  position is saved on the window's own `move` event (throttled)
  to `~/.sov-window.json`.
- **Look** (2026-11-12h): no glow anywhere — the ring's halo and
  stroke shadow are off (`RING_GLOW_ALPHA = 0` in `App.tsx`), the
  player/Connect cards and the album art have no drop shadow, and
  the card is glassier (`--surface` 0.72 instead of 0.92; the
  quit/shrink pills use `--surface-pill` 0.35). The ring outline
  itself is unchanged. Tune the opacities in `theme.css` (`:root`)
  and the glow in `App.tsx` (`RING_GLOW_ALPHA`).
- **Transparent window**: `html`, `body` and `#root` paint no
  background at all, and the Electron window is created with
  `transparent: true` and no `backgroundColor` — so the collapsed
  state is ONLY the yellow ring, with no black box behind it, and
  the expanded card's rounded corners are see-through outside the
  card. (The old opaque `#0a0d10` page background was a pywebview
  workaround; it is what made the black square.) The player and
  Connect cards keep their own semi-transparent surfaces.
- **Window opacity slider**: a second slider under the volume
  control (droplet icon, 0.2–1.0, default 1.0) dims the WHOLE
  window via `win.setOpacity` (`sov:set-opacity` bridge call). It
  is persisted in localStorage (`sov:window-opacity`) and applied
  on mount. The card's 0.72 background is untouched — this is the
  window level on top of it.
- **Runs in the background (tray)**: closing the window — or the
  × button, now labelled "Hide to tray" — hides it to the system
  tray instead of quitting. The app keeps running (server, hotkey,
  tray) with no window. Tray icon is a yellow ring (`tray.png`,
  transparent background); click it to show/hide, right-click for
  Show sov / Hide / Quit. Ctrl+Shift+M still toggles show/hide
  (when hidden it just brings the window back, without flipping
  the expanded state). Quitting happens only via the tray menu.
  `window-all-closed` deliberately does not quit.
- **Library tab**: alongside Lyrics/Queue/Search. Liked Songs
  (`GET /v1/me/tracks`, first 50 with Load more) and Playlists
  (`GET /v1/me/playlists`) — tap a track to play it, + to queue,
  tap a playlist to play it. OAuth scopes now include
  `user-library-read playlist-read-private
  playlist-read-collaborative`. A token minted before those scopes
  were added gets a 403: the tab shows a "Reconnect Spotify"
  button (clears the token, restarts login) instead of an empty
  list. **He will need to reconnect Spotify once for the new
  scopes.**
- **Playback actually plays**: pressing play with no current track
  no longer does nothing, and the play button is no longer disabled
  when nothing is playing. When there is no active device, the app
  fetches `GET /v1/me/player/devices`, transfers playback to the
  best available device (active first, else the Spotify desktop
  app, else the first) and then plays — instead of reporting "no
  active device" and doing nothing. The idle hint says which device
  is available ("Spotify is open on X — press play to start
  here"). The footer shows the connected account (`GET /v1/me`
  display name) so a wrong-account mismatch is obvious. A 403 from
  the playback call (token refused) shows a "Reconnect Spotify"
  button instead of silently saying "Nothing playing"; other
  playback errors surface honestly instead of degrading into
  "Nothing playing". The playback poll runs every 2s even when the
  document is hidden (`refetchIntervalInBackground`).
- **Animations** (Discord-overlay feel, GPU-only transforms/opacity):
  the player fades + scales out of the ring on open and back on
  close (the window resize stays instant; the animation lives on
  elements inside the drag handle, never on the handle itself); the
  ring gently breathes while nothing is playing; buttons press
  down and lift on hover; the play button pulses while playing; the
  seek thumb appears and grows on hover; the volume thumb grows on
  hover; the active lyric line slides/scales into highlight;
  Queue/Search rows stagger in; switching Lyrics/Queue/Search
  cross-fades/slides. All of it respects
  `prefers-reduced-motion`.
- **Single instance**: a second launch focuses the existing window
  (showing it first if it is hidden to the tray) instead of
  fighting over port 8888.
- **Window position**: saved to `~/.sov-window.json` (same file the
  old shell used) and restored on launch.

## Toggle — Ctrl+Shift+M

The ring no longer expands on hover. It stays collapsed until
toggled, Discord-overlay style:

- **Ctrl+Shift+M** — the global hotkey. It works while gaming,
  even when the app is not focused. Either Ctrl and either Shift
  count. It is Ctrl+Shift specifically (not Shift+M): Shift+M
  types a capital M in chat, and the low-level hook only observes
  keystrokes — it cannot swallow them — so a Shift+M hotkey would
  fire while typing. With Ctrl held, the combo produces no
  character, so it never collides with typing; Ctrl+Shift is also
  not a gameplay combo.
- **Click the ring** — same toggle, secondary to the hotkey.
- **× shrink button** — same toggle.

The toggle never steals focus from the game: bringing the window
back uses `showInactive()` instead of `show()` + `focus()` (same
for the tray "Show sov" click and a second launch focusing the
existing window). The window is still focusable — it takes focus
when clicked into, which is default Windows behaviour, so typing
in the search box keeps working. `focusable: false` was
deliberately not used, because it would break typing in the
search box.

### Changing the hotkey

Edit `~/.sov-settings.json` (read once at startup; restart sov
after editing), or use the settings panel (see "Settings" below —
it applies a hotkey change live, without a restart):

```json
{
  "hotkey": "ctrl+shift+m",
  "hotkeyMode": "hook"
}
```

- `"hotkey"`: `"+"`-joined, case-insensitive. Modifiers `ctrl`,
  `shift`, `alt`, `meta`, each optionally suffixed `left`/`right`
  (e.g. `"ctrlright+shift+m"`, `"shiftright+m"` — the old
  default). The last token is the key: a letter (`a`–`z`), a digit
  (`0`–`9`), or `F1`–`F24`. An unknown token, a missing key, or
  invalid JSON falls back to the default with a console log.
- `"hotkeyMode"`: `"hook"` (default) or `"globalShortcut"`.
  `"hook"` uses the low-level keyboard hook (`uiohook-napi`) and
  falls back to `globalShortcut` for the same combo if the hook
  cannot load. `"globalShortcut"` skips the hook entirely.

### Anti-cheat note

The low-level keyboard hook (`uiohook-napi`) can trigger some
anti-cheat software: a global key hook looks suspicious to
anti-cheat even though sov only listens for its own toggle combo
and never logs or sends keystrokes. If a game flags or blocks
sov, set `"hotkeyMode": "globalShortcut"` in
`~/.sov-settings.json` — that path uses only Windows
`RegisterHotKey`, which anti-cheat does not flag. Note the
globalShortcut path cannot tell left from right modifiers, so a
side-specific hotkey (e.g. `"shiftright+m"`) degrades to either
side in that mode.

### Fullscreen note

The overlay window is always-on-top at the `"screen-saver"`
level, which sits above fullscreen windows — the default
(`"normal"`) level would never appear over a game. Exclusive
fullscreen may still hide the overlay on some setups: switch the
game to borderless windowed if the ring never appears over it.

## Settings (Phase 2)

Settings live in `~/.sov-settings.json` — the same file the
hotkey has always read — and are managed through IPC
(`sov:settings-get` / `sov:settings-set`, exposed in the preload
as `settings_get` / `settings_set`). The settings panel is built
on this exact schema; the main process validates every value and
ignores anything it does not recognise, so a bad value can never
break the app.

```json
{
  "hotkey": "ctrl+shift+m",
  "hotkeyMode": "hook",
  "startWithWindows": false,
  "snapToCorners": false,
  "clickThrough": false,
  "sizePreset": "medium",
  "dontStealFocus": true,
  "autoHideOnFullscreen": false,
  "highContrast": false,
  "lyricsOffsetMs": 0
}
```

| Key | Type / values | Default | Behaviour |
| --- | --- | --- | --- |
| `hotkey` | string, `"+"`-joined combo (modifiers `ctrl`/`shift`/`alt`/`meta`, optionally `left`/`right`, + one key `a`–`z`, `0`–`9`, `F1`–`F24`) | `"ctrl+shift+m"` | Applied live: the old hotkey handle is stopped and a new one created, no restart needed. An unparsable value is rejected and the old hotkey kept. |
| `hotkeyMode` | `"hook"` \| `"globalShortcut"` | `"hook"` | Applied live with the hotkey. |
| `startWithWindows` | boolean | `false` | Writes/removes the `sov` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (Windows only; a no-op elsewhere). Applied live and re-applied at startup. |
| `snapToCorners` | boolean | `false` | Persisted only — reserved for the client step. |
| `clickThrough` | boolean | `false` | Persisted only — reserved for the client step. |
| `sizePreset` | `"small"` \| `"medium"` \| `"large"` | `"medium"` | Persisted only — reserved for the client step. |
| `dontStealFocus` | boolean | `true` | When true, toggle/tray-show/second-launch use `showInactive()` and never call `focus()`; when false, `show()` + `focus()` is allowed. Applied live. |
| `autoHideOnFullscreen` | boolean | `false` | Hides the overlay while a fullscreen window is in the foreground; shows it again when it goes away (see below). Applied live. |
| `highContrast` | boolean | `false` | Stored here; the renderer applies the styling. |
| `lyricsOffsetMs` | number, integer ms in `[-5000, 5000]` | `0` | Shifts synced lyrics; applied by the client. Out-of-range values are clamped, non-numbers rejected. |

IPC contract (all sender-checked to the local overlay origin):

- `sov:settings-get` → the full settings object, defaults filled in (re-reads the file, so a hand edit shows up without a restart).
- `sov:settings-set(partial)` → `{ ok, settings, rejected }`: `settings` is the effective settings after the write, `rejected` lists keys that were ignored (unknown key, wrong type, out-of-range, unparsable hotkey). Only known keys with valid values are stored; the file is never trusted as-is.
- `sov:open-logs` → opens the log file (below); returns `true`/`false`.
- `sov:lyrics-fetch({ title, artist, album, durationSec })` → the raw LRCLIB record (`{ syncedLyrics, plainLyrics, … }`) or `null`. Fetched by the main process with a proper `User-Agent` (`sov/2026-11-13l (Spotify overlay; https://github.com/lonerharsh57-lab/Sov)`), cached on disk (see below). The client parses it with its existing `parseLrc`.
- `sov:clear-data` → wipes tokens, the settings file, the window-position file, the log file and the lyrics cache; resets in-memory settings to the defaults and restarts the hotkey from them. Returns `true`. The Client ID in `~/.spotify_overlay.json` is NOT touched.

### Logs

Main-process console output and the local server's log lines are
appended to `<userData>/sov.log` (on Windows:
`%APPDATA%\sov\sov.log`), timestamped, one line per entry. The
file is capped: past ~1MB it is truncated to the last ~512KB.
Open it from the tray menu (**Open logs**) or from the settings
panel (`sov:open-logs`). Logging failures are silent — a log
write can never break the app.

### Auto-update

`electron-updater`, GitHub provider (`lonerharsh57-lab/Sov`).
First check ~30s after startup (never blocks launch), plus
**Check for updates** in the tray menu. `autoDownload: true`,
`autoInstallOnAppQuit: true`: updates download in the background
and install only when sov quits — never while it is running, so
an update can never interrupt a game. Update events only log and
update the tray tooltip; an update error never shows a popup. If
`electron-updater` cannot load, the app runs without updates and
logs why.

**Limit — read before expecting delta updates:** differential
(delta) patches need GitHub Releases published with the NSIS
installer AND its blockmap. The current packaging is a custom
`makensis` installer, which produces no blockmap, so delta
updates require switching the packaging to electron-builder's
`nsis` target — a packaging decision for later, not this step.
What is wired up now is the updater plus the full-update path
once releases exist.

### Auto-hide on fullscreen

Gated behind `autoHideOnFullscreen` (default off). Electron has
no API for "another app went fullscreen", so this is a
best-effort Windows check: every 5s (only while the setting is
on) a small PowerShell snippet asks user32 for the foreground
window's rectangle and compares it with the primary display's
bounds. While the foreground window covers the whole primary
display the overlay hides; it reappears (via `showWindow()`, so
`dontStealFocus` still applies) when it stops covering it.
Limits: Windows only; primary display only (a fullscreen game on
a second monitor is not detected); it cannot tell a fullscreen
game from a maximised borderless window or fullscreen video; up
to ~5s delay; PowerShell failures are ignored (only the first is
logged). The overlay's own window can never trigger it — it is
far smaller than a display.

### Lyrics cache

`sov:lyrics-fetch` results are cached in
`<userData>/lyrics-cache.json`, keyed by track + artist +
duration, TTL ~30 days, capped at ~200 entries (oldest evicted
first). Browsers cannot set a `User-Agent` on `fetch`, which is
why the fetch happens in the main process at all.

### Don't steal focus

`dontStealFocus` (default true) is wired into every path that
brings the window forward: the hotkey toggle, the tray click /
"Show sov", a second launch focusing the existing window, and the
fullscreen auto-hide restore. When true they use
`showInactive()` and never call `focus()`; when false,
`show()` + `focus()` is allowed. The window stays focusable
either way, so clicking into it and typing in the search box keep
working.

Implementation (`hotkey.js`): Electron's `globalShortcut` cannot
tell left Shift from right Shift (Windows `RegisterHotKey` has only
one `MOD_SHIFT`), so the primary implementation is a low-level
global keyboard hook (`uiohook-napi`), which reports left and right
Shift as different keycodes. If the native hook module cannot load
or start, the toggle falls back automatically and silently to
`globalShortcut` for the same combo — the toggle always works; the
fallback is logged, never shown as an error. The hotkey is defined
in one place: the default lives in `hotkey.js`
(`DEFAULT_HOTKEY`), overridden by `~/.sov-settings.json`.

## Features (unchanged from the old build)

Glowing yellow ring (collapsed, no icon — just the ring, the window
itself is transparent), 340px player, smooth expand/shrink
animation, draggable with position memory and nearest-corner
anchoring, album cover, playback controls, Queue + Search (tap to
play, + to queue), Library (Liked Songs + Playlists), synced lyrics
via LRCLIB, Client ID PKCE login (redirect
`http://127.0.0.1:8888/callback`), window opacity slider, system
tray with background running.

## Install / uninstall

**Install:** double-click **`../installer/sov-setup.exe`**. It only
extracts the app to `%LOCALAPPDATA%\sov` (clean wipe first),
creates Desktop + Start Menu shortcuts to `sov.exe`, and registers
the uninstaller. No admin, no Python, no downloads at install time.
It also stops any stale old-Python sov still holding port 8888
first, so a leftover from the old shell can't block the new app.

**Uninstall:** Windows Settings → Apps → "sov — Spotify overlay",
or run `uninstall.exe` in `%LOCALAPPDATA%\sov`. It removes the
shortcuts and the install folder. Your Client ID
(`~/.spotify_overlay.json`) and login are never touched.

**Run without installing:** extract the installer payload or use
the `release/win-unpacked/` folder and double-click `sov.exe`.

## Files

- `main.js` — Electron main process: window, single-instance lock,
  toggle state, global hotkey, system tray, IPC bridge handlers,
  settings IPC + log file + auto-update + fullscreen auto-hide +
  lyrics fetch/cache + clear-data.
- `tray.png` — yellow-ring tray icon (transparent background).
- `preload.js` — `window.pywebview.api` bridge (contextBridge):
  the original calls plus `settings_get` / `settings_set`,
  `open_logs`, `lyrics_fetch` and `clear_data`.
- `hotkey.js` — Ctrl+Shift+M low-level hook + globalShortcut
  fallback; configurable via `~/.sov-settings.json`.
- `server.js` — local server on 127.0.0.1:8888 (Node port of
  `standalone/server.py`).
- `callback.html` — the Spotify login callback page (byte-identical
  to the old shell's).
- `dist/` — the prebuilt React app, copied from
  `../standalone/dist/` at packaging time. The source of truth is
  `../standalone/client/` — rebuild it with `bun run build` there,
  then re-copy and re-package.
- `package.json` — Electron 38 + electron-builder config
  (`--win --x64 --dir`, `npmRebuild: false` — uiohook-napi is an
  N-API prebuild, so it needs no native rebuild for Windows) +
  `electron-updater` (GitHub provider, see "Auto-update" above).
- `release/win-unpacked/` — the packaged Windows app (`sov.exe`).

## If it doesn't start

- **"port 8888 is in use"** — another app (or a stale sov) is
  holding port 8888, which sov must use (the Spotify redirect is
  registered for it). Close the other app and press **Retry**, or
  press **Quit**.
- **The hotkey does nothing** — click the ring instead; if the ring
  toggles, the hotkey registration failed (the app logs which mode
  it is in — hook or globalShortcut fallback — to its console).
  Exclusive-fullscreen games can cover the overlay: switch the game
  to borderless windowed if the ring never appears over it.
- **Login** — clicking Connect opens Spotify in your default
  browser; finish logging in there and the app picks it up. If the
  login never comes back, close any old sov window and try again.
- **"Nothing playing" but Spotify is playing** — first check the
  footer: it shows the connected account name. If that is the wrong
  account, reconnect with the right one. Otherwise press play: the
  app now transfers playback to an available device (e.g. the
  Spotify desktop app) instead of doing nothing. If the idle hint
  says no device is available, open the Spotify desktop app first.
  If the player shows a "Reconnect Spotify" button, the token was
  refused — press it and log in again (also needed once for the new
  library scopes).
- **Still stuck** — open `http://127.0.0.1:8888/` in your browser
  while sov is running: same UI, and the footer shows the build
  stamp (`2026-11-12h-electron`). The log file is
  `%APPDATA%\sov\sov.log` (tray menu → **Open logs**); include it
  when reporting a problem.

## Code signing

The exe and the installer are **unsigned**. On first run Windows
SmartScreen will warn ("Windows protected your PC" — click "More
info" > "Run anyway"), and some antivirus tools may flag the fresh
binary. That is expected for an unsigned build, not a sign the
download is bad — but only run an installer you got from Harshith's
own release.

To ship signed builds you need an OV or EV code-signing certificate
(or Azure Trusted Signing), then sign `sov.exe` after
`electron-builder` and sign `sov-setup.exe` after `makensis` with
`signtool sign /tr <timestamp-server> /td sha256 /fd sha256`, and
record the certificate thumbprint in the packaging notes. The
version shown in Apps & Features comes from the installer's
`DisplayVersion` (`2026-11-13l-electron`); see
`installer/sov-setup.nsi` for the version mapping.
