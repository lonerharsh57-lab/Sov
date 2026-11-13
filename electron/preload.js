"use strict";
/**
 * sov preload — the JS bridge for the overlay window.
 *
 * Exposes window.sov.api with the methods the React app calls
 * (see client/src/spotify/bridge.ts): resize_window, open_login and
 * quit, plus the toggle helpers. The calls travel over ipcRenderer
 * to main.js. The bridge is installed by the preload, which runs
 * BEFORE the renderer's JavaScript — so unlike the old Python shell
 * there is no bridge race: the app never has to wait or retry for the
 * bridge to appear, and a one-shot resize on mount always lands.
 *
 * `window.pywebview` is exposed as a compatibility alias for the same
 * object (the old shell's name). contextIsolation stays on and
 * nodeIntegration stays off — the page gets nothing but these
 * functions.
 *
 * Tokens go through Electron safeStorage in the main process
 * (sov:tokens-get / set / clear): the renderer never sees the
 * encryption key, and the encrypted blob lives in a file under
 * app.getPath("userData").
 */

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  resize_window: (width, height) =>
    ipcRenderer.invoke("sov:resize", width, height),
  open_login: (url) => ipcRenderer.invoke("sov:open-login", url),
  quit: () => ipcRenderer.invoke("sov:quit"),
  // Ask the main process to toggle ring ⇄ player. The main process
  // owns the expanded state (hotkey, ring click and shrink button all
  // funnel through it) and answers with a "sov:toggle" event.
  toggle: () => ipcRenderer.invoke("sov:toggle-request"),
  // Tell the main process whether the player is mounted, so the
  // hotkey toggle knows there is a player to toggle.
  set_player_active: (active) =>
    ipcRenderer.invoke("sov:player-active", !!active),
  // Subscribe to toggle events from the main process. Returns an
  // unsubscribe function.
  on_toggle: (cb) => {
    const handler = (_event, expanded) => cb(expanded);
    ipcRenderer.on("sov:toggle", handler);
    return () => ipcRenderer.removeListener("sov:toggle", handler);
  },
  // Subscribe to window show/hide events from the main process (the
  // window being hidden to the tray, or shown again). The renderer
  // uses this to slow its polling while hidden. Returns an
  // unsubscribe function.
  on_visibility: (cb) => {
    const handler = (_event, visible) => cb(visible);
    ipcRenderer.on("sov:visibility", handler);
    return () => ipcRenderer.removeListener("sov:visibility", handler);
  },
  // Tokens, encrypted with Electron safeStorage by the main process.
  tokens_get: () => ipcRenderer.invoke("sov:tokens-get"),
  tokens_set: (tokens) => ipcRenderer.invoke("sov:tokens-set", tokens),
  tokens_clear: () => ipcRenderer.invoke("sov:tokens-clear"),
  // Set the whole window's opacity (0.2–1.0) — the opacity slider.
  set_opacity: (value) => ipcRenderer.invoke("sov:set-opacity", value),
  // Hide the window to the tray — the app keeps running.
  hide_window: () => ipcRenderer.invoke("sov:hide"),
  // Settings (Phase 2): read/write ~/.sov-settings.json. get returns
  // the full settings object (defaults filled in); set takes a
  // partial object and returns { ok, settings, rejected } — see
  // main.js for the exact schema.
  settings_get: () => ipcRenderer.invoke("sov:settings-get"),
  settings_set: (patch) => ipcRenderer.invoke("sov:settings-set", patch),
  // Open the log file (<userData>/sov.log) in the default app.
  open_logs: () => ipcRenderer.invoke("sov:open-logs"),
  // Lyrics from LRCLIB, fetched by the main process with a proper
  // User-Agent and a disk cache. Takes { title, artist, album,
  // durationSec } and returns the raw LRCLIB record
  // ({ syncedLyrics, plainLyrics, ... }) or null.
  lyrics_fetch: ({ title, artist, album, durationSec }) =>
    ipcRenderer.invoke("sov:lyrics-fetch", { title, artist, album, durationSec }),
  // Log out + wipe everything sov stored on disk (tokens, settings,
  // window position, log, lyrics cache). Returns true.
  clear_data: () => ipcRenderer.invoke("sov:clear-data"),
  // Drag following — the JS drag path (see useWindowDrag in App.tsx).
  // Fire-and-forget (send, not invoke): the renderer sends drag-start on
  // pointerdown and drag-end on pointerup/cancel only. The main process
  // records the cursor, the window position and the window size on
  // drag-start, then follows the cursor on its own ~8ms timer — no
  // per-frame IPC and no drift.
  drag_start: (sx, sy) => ipcRenderer.send("sov:drag-start", sx, sy),
  drag_end: () => ipcRenderer.send("sov:drag-end"),
};

contextBridge.exposeInMainWorld("sov", { api });
contextBridge.exposeInMainWorld("pywebview", { api });
