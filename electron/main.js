"use strict";
/**
 * sov — Spotify overlay, Electron shell.
 *
 * Replaces the old Python/pywebview shell. Every failure the user hit
 * was in that shell (window compositing, bridge races, installer
 * environment) — never in the React player, which is reused unchanged
 * from standalone/dist/. This shell is Electron's own Chromium: no
 * Python, no pip, no venv, nothing to download at install time.
 *
 *   * Frameless, transparent, always-on-top window, starting at the
 *     ring size (70x70) in the bottom-right corner. The app resizes
 *     the window itself (Connect card 380x560, player to fit) through
 *     the bridge, anchored on the bottom-right corner so the icon
 *     stays where it is while the panel grows.
 *   * Single-instance lock: a second launch focuses the existing
 *     window instead of fighting over port 8888. The
 *     "second-instance" handler is registered at the top level,
 *     right after requestSingleInstanceLock, so a quick second
 *     launch can never be missed.
 *   * The local server (server.js — a port of server.py's HTTP
 *     contract) runs inside this process on 127.0.0.1:8888. The port
 *     is pinned to 8888: the Spotify redirect URI
 *     http://127.0.0.1:8888/callback is registered for 8888, so
 *     silently switching ports would break login. If the port is
 *     already held, a Retry/Quit dialog appears — Retry re-attempts
 *     the server start; the app never fails silently and never
 *     silently moves to another port.
 *   * Spotify login opens in the user's default browser
 *     (shell.openExternal), never inside the overlay window: typing
 *     on Spotify's login page inside the old window froze the whole
 *     process. Tokens come back through the local server (see
 *     server.js), exactly as before.
 *   * Window position is saved to ~/.sov-window.json (same file the
 *     old shell used) and restored on launch.
 */

const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  Tray,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { execFile } = require("child_process");
const { startServer, HOST, PORT, BUILD } = require("./server");
// parseHotkey / SETTINGS_FILE are guarded: the drag harness stubs
// hotkey.js with only createHotkey + HOTKEY_DESCRIPTION, so they may
// be undefined there — every use below checks first.
const {
  createHotkey,
  HOTKEY_DESCRIPTION,
  parseHotkey,
  SETTINGS_FILE: HOTKEY_SETTINGS_FILE,
} = require("./hotkey");

// Toggle hotkey: Ctrl+Shift+M by default (see hotkey.js / loadHotkeySettings).
// The old default was Right Shift+M, but Right Shift+M also types a capital
// M in chat — the low-level hook only observes keystrokes, it cannot
// swallow them, so the combo fired while typing. Ctrl+Shift+M cannot
// produce a character while Ctrl is held, so it never collides with
// typing; Ctrl+Shift is also not a gameplay combo. The hotkey is
// configurable via ~/.sov-settings.json, through the sov:settings-get /
// sov:settings-set IPC (see the settings section below) as well as by
// editing the file by hand; see hotkey.js for the exact file format.
// Electron's globalShortcut cannot tell left Shift from right Shift
// (Windows RegisterHotKey has only one MOD_SHIFT), so the toggle uses
// a low-level keyboard hook (uiohook-napi, see hotkey.js) and falls
// back to globalShortcut for the same combo if the hook cannot load.
const TOGGLE_HOTKEY = HOTKEY_DESCRIPTION;

const WIN_POS_FILE = path.join(os.homedir(), ".sov-window.json");

// ------------------------------------------------------------------ log file
// App log: <userData>/sov.log (e.g. %APPDATA%\sov\sov.log on Windows).
// Main-process console output AND the local server's onLog lines are
// appended here (the server's onLog already flows through console.log
// in startServerWithRetry, so the console wrapper below catches both).
// Size-capped: when the file exceeds ~1MB it is truncated to the last
// ~512KB, so it can never grow without bound. Everything here is
// best-effort and never throws — a failed write must never break the
// app. Opened from the tray menu ("Open logs") and via sov:open-logs.
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 512 * 1024;

function logFilePath() {
  try {
    return path.join(app.getPath("userData"), "sov.log");
  } catch {
    // app.getPath can fail before the app is ready (and in stubs) —
    // fall back to the OS temp dir rather than losing the log.
    return path.join(os.tmpdir(), "sov.log");
  }
}

function appendLog(line) {
  try {
    const file = logFilePath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Directory creation is best-effort; the append below will fail
      // quietly if the directory is missing.
    }
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const kept = fs
          .readFileSync(file, "utf8")
          .slice(-LOG_KEEP_BYTES)
          .replace(/^[^\n]*\n/, "");
        fs.writeFileSync(file, kept, "utf8");
      }
    } catch {
      // No existing file, or the rotation failed — append anyway.
    }
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} ${line}\n`,
      "utf8",
    );
  } catch {
    // Logging must never break the app.
  }
}

// Route console output to the log file as well as the terminal.
// The originals are kept and still called, so behaviour in a dev
// console is unchanged; the file just gets a timestamped copy.
const _origConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => {
    try {
      _origConsole[level](...args);
    } catch {
      // The original console call failing must not break logging.
    }
    try {
      appendLog(`[${level}] ${util.format(...args)}`);
    } catch {
      // Already best-effort inside appendLog.
    }
  };
}

// ------------------------------------------------------------------ settings
// Settings schema — the single source of truth for the settings
// panel (the client step builds its UI on this exact schema).
// Stored in the SAME file hotkey.js already reads:
//   ~/.sov-settings.json
// IPC: sov:settings-get -> full settings object (defaults filled
// in); sov:settings-set({ ...partial }) -> { ok, settings, rejected }
// where `settings` is the effective settings after the write and
// `rejected` lists keys that were ignored (unknown key, wrong type,
// out-of-range value, or an unparsable hotkey).
//
//   {
//     "hotkey": "ctrl+shift+m",          // string, "+"-joined combo,
//                                        // see hotkey.js parseHotkey:
//                                        // modifiers ctrl/shift/alt/meta
//                                        // (optionally left/right) + one
//                                        // key (a-z, 0-9, F1-F24)
//     "hotkeyMode": "hook",              // "hook" | "globalShortcut"
//     "startWithWindows": false,         // boolean — HKCU Run key
//     "snapToCorners": false,            // boolean — on drag-end, snap
//                                        // the window to the nearest
//                                        // corner of its display
//     "clickThrough": false,             // boolean — while collapsed,
//                                        // clicks pass through to the
//                                        // game; expanding via the
//                                        // hotkey restores mouse input
//                                        // (see applyClickThrough)
//     "sizePreset": "medium",            // "small" | "medium" | "large"
//                                        // — panel widths, applied by
//                                        // the client (300/340/380px)
//     "dontStealFocus": true,            // boolean — toggle/tray-show
//                                        // use showInactive() and never
//                                        // focus(); false allows
//                                        // show()+focus()
//     "autoHideOnFullscreen": false,     // boolean — hide the overlay
//                                        // while a fullscreen window is
//                                        // in the foreground (Windows
//                                        // poll, see below)
//     "highContrast": false,             // boolean — stored here; the
//                                        // renderer applies the styling
//     "lyricsOffsetMs": 0                // number, integer ms in
//                                        // [-5000, 5000] — shifts synced
//                                        // lyrics; applied by the client
//   }
//
// Only the keys above are ever stored; anything else in the file or
// in a settings-set call is dropped. Wrong-typed or out-of-range
// values fall back to the default for that key (and are reported in
// `rejected` on set). A missing file, or invalid JSON, means all
// defaults — nothing throws.
const SETTINGS_FILE =
  typeof HOTKEY_SETTINGS_FILE === "string" && HOTKEY_SETTINGS_FILE
    ? HOTKEY_SETTINGS_FILE
    : path.join(os.homedir(), ".sov-settings.json");

const SETTINGS_DEFAULTS = {
  hotkey: "ctrl+shift+m",
  hotkeyMode: "hook",
  startWithWindows: false,
  snapToCorners: false,
  clickThrough: false,
  sizePreset: "medium",
  dontStealFocus: true,
  autoHideOnFullscreen: false,
  highContrast: false,
  lyricsOffsetMs: 0,
};

// Each validator returns the normalised value, or undefined to
// reject the value (caller keeps the current/default value).
const SETTINGS_VALIDATORS = {
  hotkey(value) {
    if (typeof value !== "string") return undefined;
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) return undefined;
    if (typeof parseHotkey === "function") {
      return parseHotkey(cleaned) ? cleaned : undefined;
    }
    // hotkey.js stubbed (drag harness) — accept the same shape
    // loosely: modifiers + one key, "+"-joined.
    return /^(ctrl|shift|alt|meta)(left|right)?(\+(ctrl|shift|alt|meta)(left|right)?)*\+([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$/.test(
      cleaned,
    )
      ? cleaned
      : undefined;
  },
  hotkeyMode(value) {
    return value === "hook" || value === "globalShortcut" ? value : undefined;
  },
  startWithWindows(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  snapToCorners(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  clickThrough(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  sizePreset(value) {
    return value === "small" || value === "medium" || value === "large"
      ? value
      : undefined;
  },
  dontStealFocus(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  autoHideOnFullscreen(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  highContrast(value) {
    return typeof value === "boolean" ? value : undefined;
  },
  lyricsOffsetMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.round(Math.max(-5000, Math.min(5000, value)));
  },
};

function loadSettings() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    // No file, or invalid JSON — all defaults.
  }
  const settings = { ...SETTINGS_DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (raw[key] === undefined) continue;
      const valid = SETTINGS_VALIDATORS[key](raw[key]);
      if (valid !== undefined) settings[key] = valid;
    }
  }
  return settings;
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

// In-memory copy of the effective settings, loaded once at startup
// and kept in sync by sov:settings-set (and re-read by
// sov:settings-get). Behaviour flags below read this, never the
// file, so a settings-set applies live without a restart.
let currentSettings = loadSettings();

// Start with Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// ("sov" = the app's own exe path). Windows-only; on any other
// platform this is a no-op that resolves false. Best-effort: a
// registry failure is logged, never thrown, and never blocks startup
// or a settings-set.
function applyStartWithWindows(enabled) {
  if (process.platform !== "win32") return Promise.resolve(false);
  const valueName = "sov";
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const args = enabled
    ? ["add", runKey, "/v", valueName, "/t", "REG_SZ", "/d", app.getPath("exe"), "/f"]
    : ["delete", runKey, "/v", valueName, "/f"];
  return new Promise((resolve) => {
    try {
      execFile("reg.exe", args, { timeout: 10000, windowsHide: true }, (err) => {
        if (err) {
          console.log(`sov: start-with-Windows ${enabled ? "enable" : "disable"} failed: ${err.message}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch (err) {
      console.log(`sov: start-with-Windows ${enabled ? "enable" : "disable"} failed: ${err && err.message ? err.message : err}`);
      resolve(false);
    }
  });
}

// ------------------------------------------------------------------ show helper
// Bring the window forward, respecting dontStealFocus (default true):
// showInactive() never steals focus from the game; only when the
// setting is explicitly false is show()+focus() allowed. Used by the
// hotkey toggle, the tray, and the second-instance handler.
function showWindow() {
  if (!win) return;
  if (currentSettings.dontStealFocus === false) {
    if (typeof win.show === "function") win.show();
    try {
      if (typeof win.focus === "function") win.focus();
    } catch {
      // Focusing is best-effort.
    }
    return;
  }
  if (typeof win.showInactive === "function") win.showInactive();
  else if (typeof win.show === "function") win.show();
}

// ------------------------------------------------------------------ click-through
// Click-through mode (settings.clickThrough): while the player is
// COLLAPSED (the ring), mouse events pass through the window to the
// game below (setIgnoreMouseEvents(true, { forward: true })). While
// the player is EXPANDED the window always takes mouse events —
// otherwise the user could never click anything, including the
// Settings checkbox that turns this off. The way back is the hotkey
// (it still toggles): press it to open the player, mouse input works
// while it is open, then turn click-through off in Settings. Applied
// on settings-set, on toggle, and at startup. Guarded for windows
// without setIgnoreMouseEvents (test stubs).
function applyClickThrough() {
  if (!win || typeof win.setIgnoreMouseEvents !== "function") return;
  try {
    win.setIgnoreMouseEvents(
      currentSettings.clickThrough === true && !expanded,
      { forward: true },
    );
  } catch {
    // Best-effort: a window that refuses stays clickable.
  }
}

// ------------------------------------------------------------------ auto-hide
// Auto-hide while a fullscreen window is in the foreground, gated
// behind autoHideOnFullscreen (default false). Electron has no API
// for "another app went fullscreen", so this is a best-effort
// Windows check: every 5s (only while the setting is on) a small
// PowerShell snippet asks user32 for the foreground window's rect
// and compares it with the primary display's bounds. While the
// foreground window covers the whole primary display the overlay
// is hidden; it is shown again (via showWindow(), so
// dontStealFocus still applies) when it stops covering it.
//
// Limits, stated honestly:
//  - Windows only. On macOS/Linux the poller never starts.
//  - Primary display only: a fullscreen game on a second monitor
//    is not detected (the overlay would stay visible there).
//  - It cannot tell a fullscreen game from a maximised borderless
//    window or a fullscreen video — any window covering the whole
//    primary display hides the overlay.
//  - A ~5s delay between the game going fullscreen and the hide.
//  - PowerShell spawn failures are ignored (the overlay just stays
//    visible); only the first failure is logged, so a broken
//    PowerShell cannot spam the log file every 5s.
//  - The overlay's own window can never trigger it: it is far
//    smaller than a display, so even when it is the foreground
//    window its rect does not cover the screen.
const FULLSCREEN_POLL_MS = 5000;
let fullscreenTimer = null;
let fullscreenAutoHidden = false;
let fullscreenCheckFailedLogged = false;

const FULLSCREEN_PS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms;",
  "$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
  "$code='using System; using System.Runtime.InteropServices; public class SovWin32 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } }';",
  "Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;",
  "$h=[SovWin32]::GetForegroundWindow(); $r=New-Object SovWin32+RECT;",
  "if ([SovWin32]::GetWindowRect($h, [ref]$r)) { if (($r.Right-$r.Left) -ge $s.Width -and ($r.Bottom-$r.Top) -ge $s.Height) { 'FULLSCREEN' } else { 'WINDOWED' } } else { 'UNKNOWN' }",
].join("\n");

function checkFullscreenOnce() {
  if (process.platform !== "win32" || !win) return;
  try {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", FULLSCREEN_PS_SCRIPT],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || typeof stdout !== "string") {
          if (!fullscreenCheckFailedLogged) {
            fullscreenCheckFailedLogged = true;
            console.log(`sov: fullscreen check failed (${err && err.message ? err.message : "no output"}) — auto-hide disabled until restart.`);
          }
          return;
        }
        const isFullscreen = stdout.trim().toUpperCase().includes("FULLSCREEN");
        if (isFullscreen && win && win.isVisible() && !fullscreenAutoHidden) {
          fullscreenAutoHidden = true;
          win.hide();
          console.log("sov: fullscreen window detected — hiding overlay.");
        } else if (!isFullscreen && fullscreenAutoHidden && win && !win.isVisible()) {
          fullscreenAutoHidden = false;
          showWindow();
          console.log("sov: fullscreen window gone — showing overlay.");
        } else if (!isFullscreen) {
          // Not fullscreen, and the window is visible (or the user hid
          // it themselves): clear the flag so a later fullscreen
          // period can hide it again.
          fullscreenAutoHidden = false;
        }
      },
    );
  } catch {
    // Spawning PowerShell must never break the app.
  }
}

function startFullscreenPoller() {
  if (process.platform !== "win32") return;
  if (fullscreenTimer) return;
  fullscreenTimer = setInterval(checkFullscreenOnce, FULLSCREEN_POLL_MS);
  if (typeof fullscreenTimer.unref === "function") fullscreenTimer.unref();
  checkFullscreenOnce();
}

function stopFullscreenPoller() {
  if (fullscreenTimer) {
    clearInterval(fullscreenTimer);
    fullscreenTimer = null;
  }
  if (fullscreenAutoHidden && win && !win.isVisible()) {
    fullscreenAutoHidden = false;
    showWindow();
  } else {
    fullscreenAutoHidden = false;
  }
}

// Ring size: the 54px icon plus the 16px the app adds when it reports
// its size (see App.tsx reportSize: rect + 16).
const START_W = 70;
const START_H = 70;
const MARGIN = 18;

const MIN_W = 70;
const MIN_H = 70;
const MAX_W = 1200;
const MAX_H = 1000;

let win = null;
// System tray (see createTray): the app lives there when the window is
// hidden, and quitting happens only from its menu.
let tray = null;
// True only while a real quit is in progress (tray menu Quit) — the
// window's close event hides to the tray instead when this is false.
let isQuitting = false;

// Toggle state — the main process owns expanded/collapsed, so the
// hotkey, the ring click and the shrink button can never disagree.
// `playerActive` is true while the player is mounted (the Connect
// screen has no player to toggle). `lastPlayerSize` is the last
// panel size the renderer reported, so the hotkey can restore it.
let expanded = false;
let playerActive = false;
let lastPlayerSize = { width: 356, height: 420 };
let hotkeyHandle = null;

// Single-instance lock — must be requested before the app is ready.
// A second launch quits immediately; the running instance is focused
// instead (see the top-level "second-instance" handler below). No
// server is started before this check (startServer runs only inside
// whenReady), so the duplicate instance exits cleanly without ever
// touching port 8888.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Second-instance handler — registered at the top level, right after
// requestSingleInstanceLock and before app.whenReady, so a quick
// second launch can never be missed (a handler registered inside
// whenReady, after startServer, could miss a launch that arrives
// while the server is still starting). Guards for win being null:
// the second launch can arrive before the app is ready and the
// window exists. showInactive() brings the window forward without
// stealing focus from whatever the user is doing (same reasoning as
// the hotkey toggle path — see togglePlayer).
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  showWindow();
});

// The local origin — the only origin allowed to drive this window.
// IPC senders and navigations are validated against it (see
// isLocalSender and the will-navigate guard in createWindow).
const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

// True when an IPC event came from the local overlay page. In real
// Electron event.senderFrame.url is always set for renderer IPC; a
// missing senderFrame (e.g. a test harness driving handlers with a
// bare event object) cannot be verified, so it is allowed through
// rather than breaking the call — the check only ever rejects a
// sender that positively identifies as a foreign origin.
function isLocalSender(event) {
  const url = event && event.senderFrame && event.senderFrame.url;
  if (!url) return true;
  return url.startsWith(LOCAL_ORIGIN);
}

function getAllDisplays() {
  // screen.getAllDisplays exists in real Electron; fall back to the
  // primary display so a stubbed screen (tests) still works.
  if (screen.getAllDisplays) return screen.getAllDisplays();
  return [screen.getPrimaryDisplay()];
}

// True when the (x, y, w, h) rect overlaps some display's work area
// by at least VISIBLE px on each axis — i.e. the window would still
// be reachable there. Monitors left of / above the primary have
// negative work-area origins, so negative coordinates are valid here.
function isOnAnyDisplay(x, y, w, h) {
  const VISIBLE = 48;
  return getAllDisplays().some((d) => {
    const wa = d.workArea;
    const overlapX = Math.min(x + w, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapY = Math.min(y + h, wa.y + wa.height) - Math.max(y, wa.y);
    return overlapX >= VISIBLE && overlapY >= VISIBLE;
  });
}

// Per-monitor positions: the file keeps the last position per
// display id ({ x, y, byDisplay: { "<displayId>": { x, y } } }) plus
// the top-level { x, y } as the fallback — and the old format, a bare
// { x, y }, still loads. On startup the display matching the last
// saved spot is looked up and its own entry restored when present,
// so moving the overlay to a second monitor sticks there instead of
// snapping back to where it was on the primary. A display without an
// id (test stubs) falls back to "primary".
function displayIdFor(x, y, w, h) {
  try {
    const d = screen.getDisplayMatching({ x, y, width: w, height: h });
    if (d && d.id !== undefined && d.id !== null) return String(d.id);
  } catch {
    // getDisplayMatching is best-effort here.
  }
  return "primary";
}

function loadWindowPos() {
  try {
    const data = JSON.parse(fs.readFileSync(WIN_POS_FILE, "utf8"));
    const x = Math.trunc(data.x);
    const y = Math.trunc(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Per-display entry for the display the saved spot is on.
    if (data.byDisplay && typeof data.byDisplay === "object") {
      const entry = data.byDisplay[displayIdFor(x, y, START_W, START_H)];
      if (entry) {
        const ex = Math.trunc(entry.x);
        const ey = Math.trunc(entry.y);
        if (Number.isFinite(ex) && Number.isFinite(ey)) {
          return { x: ex, y: ey };
        }
      }
    }
    return { x, y };
  } catch {
    // No saved position (or a corrupt one) — fall back to bottom-right.
  }
  return null;
}

function saveWindowPos(x, y) {
  try {
    const px = Math.trunc(x);
    const py = Math.trunc(y);
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(WIN_POS_FILE, "utf8")) || {};
    } catch {
      prev = {};
    }
    const byDisplay =
      prev.byDisplay && typeof prev.byDisplay === "object"
        ? prev.byDisplay
        : {};
    const [w, h] = win ? win.getSize() : [START_W, START_H];
    byDisplay[displayIdFor(px, py, w, h)] = { x: px, y: py };
    fs.writeFileSync(
      WIN_POS_FILE,
      JSON.stringify({ x: px, y: py, byDisplay }),
      "utf8",
    );
  } catch {
    // A failed save must never break the app.
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(n, hi));
}

// Clamp a window position to the display's work area (the screen
// minus the taskbar), keeping at least VISIBLE px of the window
// on-screen on every edge — so the window can never be dragged (or
// resized) somewhere the user can't reach it. The display is the one
// the target rect is mostly on, so dragging across monitors clamps
// to the monitor the window is on.
function clampToWorkArea(x, y, w, h) {
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const wa = display.workArea;
  const VISIBLE = 48;
  const minX = wa.x - w + VISIBLE;
  const maxX = wa.x + wa.width - VISIBLE;
  const minY = wa.y - h + VISIBLE;
  const maxY = wa.y + wa.height - VISIBLE;
  return {
    x: maxX < minX ? wa.x : clamp(x, minX, maxX),
    y: maxY < minY ? wa.y : clamp(y, minY, maxY),
  };
}

// Resize-only tightening on top of clampToWorkArea: when the window
// FITS in the matched display's work area, keep it fully inside it.
// A bare clampToWorkArea would let an expanding panel slide partly
// off the top edge (e.g. y=-98 with 342px still visible) whenever
// the ring sits near the top — the old Math.max(0, ...) pinned it
// to 0 instead, and the drag harness expects that fully-on-screen
// result. This does the same thing without hardcoding 0: the bounds
// come from the matched display's work area, so a monitor above the
// primary (negative work-area origin) still allows negative
// coordinates. Dragging deliberately does NOT use this — a drag may
// leave the window partly off-screen (48px visible is enough to
// grab it back).
function clampFullyInsideIfFits(x, y, w, h) {
  const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  return {
    x: w <= wa.width ? clamp(x, wa.x, wa.x + wa.width - w) : x,
    y: h <= wa.height ? clamp(y, wa.y, wa.y + wa.height - h) : y,
  };
}

function createWindow() {
  const primary = screen.getPrimaryDisplay().workArea;
  const saved = loadWindowPos();
  let x;
  let y;
  if (saved && isOnAnyDisplay(saved.x, saved.y, START_W, START_H)) {
    // Saved spot is still on some display (negative coordinates are
    // fine — a monitor left of / above the primary has a negative
    // work-area origin). Clamp to that display's work area so a
    // saved spot from a bigger window can't hang off-screen.
    const pos = clampToWorkArea(saved.x, saved.y, START_W, START_H);
    x = pos.x;
    y = pos.y;
  } else {
    // No saved position, a corrupt one, or the monitor it was on is
    // gone: bottom-right of the primary display — and ONLY then.
    x = primary.x + primary.width - START_W - MARGIN;
    y = primary.y + primary.height - START_H - MARGIN;
  }

  win = new BrowserWindow({
    width: START_W,
    height: START_H,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // "screen-saver" level: the default always-on-top level ("normal")
  // sits below exclusive-fullscreen games, so the overlay would
  // never appear over them. screen-saver sits above fullscreen
  // windows. Exclusive fullscreen may still hide it on some setups —
  // borderless windowed is the workaround (see README).
  if (typeof win.setAlwaysOnTop === "function") {
    win.setAlwaysOnTop(true, "screen-saver");
  }

  // External links (and any navigation the page attempts) must never
  // take over the overlay window: links open in the default browser,
  // and in-page navigation is allowed only to the local server
  // origin (the overlay page itself). Everything else is denied.
  if (win.webContents && typeof win.webContents.setWindowOpenHandler === "function") {
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
  }
  if (win.webContents && typeof win.webContents.on === "function") {
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(LOCAL_ORIGIN)) event.preventDefault();
    });
  }

  win.loadURL(`http://${HOST}:${PORT}/`);
  win.once("ready-to-show", () => win.show());
  // Position is saved on drag-end only (see the drag section) and on
  // close/quit — never on every move, and never during a drag.
  win.on("close", (event) => {
    if (win) {
      const [cx, cy] = win.getPosition();
      saveWindowPos(cx, cy);
    }
    // Closing the window hides it to the tray — the app keeps running
    // (server, hotkey, tray). Quitting happens only via the tray menu.
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  // Tell the renderer when the window is shown or hidden (tray):
  // the player slows its polling while hidden instead of hammering
  // Spotify from the background. "show"/"hide" fire for every path
  // that shows/hides the window (hotkey, tray click, close-to-tray,
  // toggle), so no call site needs to send it by hand.
  const sendVisibility = () => {
    if (win && win.webContents) {
      win.webContents.send("sov:visibility", win.isVisible());
    }
  };
  win.on("show", sendVisibility);
  win.on("hide", sendVisibility);
}

// ------------------------------------------------------------------ bridge
// The React app calls window.pywebview.api.* (see
// client/src/spotify/bridge.ts). The preload forwards those calls here.

// Apply a panel size: clamp to the display's work area (the height cap
// comes from the display, so content taller than the screen scrolls
// inside the panel's own lists instead of shrinking the window), keep
// the bottom-right corner fixed, then keep the window on-screen.
function applyResize(width, height) {
  if (!win) return false;
  const w = clamp(Math.trunc(width) || MIN_W, MIN_W, MAX_W);
  const [bx, by] = win.getPosition();
  const [bw, bh] = win.getSize();
  // Work-area height of the display the window is on: the window may
  // never grow past it, no matter what the renderer measured.
  const workAreaH = screen.getDisplayMatching({
    x: bx,
    y: by,
    width: bw,
    height: bh,
  }).workArea.height;
  const h = clamp(
    Math.trunc(height) || MIN_H,
    MIN_H,
    Math.min(MAX_H, workAreaH),
  );
  // While the player is expanded the window only ever matches the
  // panel's measured size: the 70x70 ring report belongs to the
  // collapsed state, so a stale one must never shrink an open panel.
  if (playerActive && expanded && (w < 100 || h < 100)) {
    return true;
  }
  // Remember the last panel size so the hotkey can restore it. Only
  // while the player is active — the Connect card is not a player size.
  if (playerActive && w > 100 && h > 100) {
    lastPlayerSize = { width: w, height: h };
  }
  // Bottom-right corner stays fixed. No Math.max(0, ...) here: monitors
  // left of / above the primary have negative coordinates, and
  // clampToWorkArea (multi-monitor aware via getDisplayMatching) is the
  // only clamp. clampFullyInsideIfFits then keeps a panel that fits
  // fully on-screen instead of sliding partly off the top edge.
  const x = bx + bw - w;
  const y = by + bh - h;
  const clamped = clampToWorkArea(x, y, w, h);
  const pos = clampFullyInsideIfFits(clamped.x, clamped.y, w, h);
  win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  return true;
}

ipcMain.handle("sov:resize", (event, width, height) => {
  if (!isLocalSender(event)) return false;
  if (!win) return false;
  // Never resize (or move) the window mid-drag: a resize would shift
  // the window under the cursor. Keep only the latest request and
  // apply it on drag-end.
  if (dragAnchor) {
    dragPendingResize = { width, height };
    return true;
  }
  return applyResize(width, height);
});

ipcMain.handle("sov:open-login", async (event, url) => {
  if (!isLocalSender(event)) return false;
  // Only Spotify authorize URLs are accepted — anything else is refused.
  if (typeof url !== "string") return false;
  if (!url.startsWith("https://accounts.spotify.com/authorize?")) return false;
  try {
    console.log("sov: opening Spotify login in your browser…");
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("sov:quit", (event) => {
  if (!isLocalSender(event)) return false;
  // The window's close handler preventDefaults unless isQuitting is
  // true — and only the tray menu used to set it, so an in-app Quit
  // (and a Windows shutdown / installer-upgrade quit, which also go
  // through before-quit → close) was blocked. Set it here so every
  // quit path actually quits; before-quit sets it too as a backstop.
  isQuitting = true;
  if (win) {
    const [x, y] = win.getPosition();
    saveWindowPos(x, y);
  }
  app.quit();
  return true;
});

// Hide the window to the tray (the X button) — the app keeps running.
ipcMain.handle("sov:hide", (event) => {
  if (!isLocalSender(event)) return false;
  if (win) win.hide();
  return true;
});

// ------------------------------------------------------------------ tokens
// Spotify tokens, encrypted with Electron safeStorage (OS keychain /
// DPAPI) — never plain text on disk. The encrypted blob lives in
// tokens.json under app.getPath("userData"). The renderer only ever
// sees the decrypted tokens over IPC from this local page, and the
// Client ID / PKCE verifier stay in the renderer's localStorage —
// only the tokens move here. If safeStorage is unavailable (no OS
// key backend), the handlers report failure and the renderer falls
// back to localStorage.
function tokensFile() {
  return path.join(app.getPath("userData"), "tokens.json");
}

function readStoredTokens() {
  try {
    const raw = fs.readFileSync(tokensFile(), "utf8");
    const blob = Buffer.from(JSON.parse(raw).data, "base64");
    const json = safeStorage.decryptString(blob);
    if (!json) return null;
    const t = JSON.parse(json);
    if (!t || typeof t.access_token !== "string") return null;
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
      expires_at: typeof t.expires_at === "number" ? t.expires_at : 0,
    };
  } catch {
    return null;
  }
}

ipcMain.handle("sov:tokens-get", (event) => {
  if (!isLocalSender(event)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  return readStoredTokens();
});

ipcMain.handle("sov:tokens-set", (event, tokens) => {
  if (!isLocalSender(event)) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!tokens || typeof tokens.access_token !== "string") return false;
  try {
    const blob = safeStorage.encryptString(
      JSON.stringify({
        access_token: tokens.access_token,
        refresh_token:
          typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
        expires_at:
          typeof tokens.expires_at === "number" ? tokens.expires_at : 0,
      }),
    );
    fs.writeFileSync(
      tokensFile(),
      JSON.stringify({ data: blob.toString("base64") }),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("sov:tokens-clear", (event) => {
  if (!isLocalSender(event)) return false;
  try {
    fs.unlinkSync(tokensFile());
  } catch {
    // Already gone — clearing is still a success.
  }
  return true;
});

// ------------------------------------------------------------------ settings
// Restart the toggle hotkey from the settings file on disk (the
// settings-set handler writes the file first, then calls this, so
// createHotkey picks up the new combo/mode). Never throws.
function restartHotkey() {
  if (hotkeyHandle) {
    try {
      hotkeyHandle.stop();
    } catch {
      // Stopping the old handle is best-effort.
    }
    hotkeyHandle = null;
  }
  try {
    hotkeyHandle = createHotkey({ toggle: togglePlayer, globalShortcut });
    if (hotkeyHandle.description && tray) {
      tray.setToolTip(`sov — Spotify overlay (${hotkeyHandle.description} to toggle)`);
    }
    console.log(
      `sov: toggle hotkey: ${hotkeyHandle.description || TOGGLE_HOTKEY} (${hotkeyHandle.mode || "none"})`,
    );
  } catch (err) {
    console.log(`sov: could not restart the toggle hotkey: ${err && err.message ? err.message : err}`);
    hotkeyHandle = { mode: "none", stop() {} };
  }
}

// Full settings object, defaults filled in. Re-reads the file, so a
// hand edit to ~/.sov-settings.json shows up here without a restart.
ipcMain.handle("sov:settings-get", (event) => {
  if (!isLocalSender(event)) return null;
  currentSettings = loadSettings();
  return { ...currentSettings };
});

// Partial update: only known keys with valid values are applied;
// anything else is listed in `rejected` and ignored — the renderer
// is never trusted. Applies live where possible (hotkey restart,
// start-with-Windows registry key, fullscreen poller, click-through);
// the rest is read from `currentSettings` by the behaviour that owns it.
// Returns { ok, settings, rejected }.
ipcMain.handle("sov:settings-set", async (event, patch) => {
  if (!isLocalSender(event)) return { ok: false, settings: { ...currentSettings }, rejected: ["(foreign sender)"] };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, settings: { ...currentSettings }, rejected: ["(patch must be an object)"] };
  }
  const rejected = [];
  const next = { ...currentSettings };
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) {
      rejected.push(key);
      continue;
    }
    const valid = SETTINGS_VALIDATORS[key](patch[key]);
    if (valid === undefined) {
      rejected.push(key);
      continue;
    }
    next[key] = valid;
  }
  const hotkeyChanged =
    next.hotkey !== currentSettings.hotkey ||
    next.hotkeyMode !== currentSettings.hotkeyMode;
  const startWithWindowsChanged =
    next.startWithWindows !== currentSettings.startWithWindows;
  const clickThroughChanged =
    next.clickThrough !== currentSettings.clickThrough;
  const autoHideChanged =
    next.autoHideOnFullscreen !== currentSettings.autoHideOnFullscreen;
  currentSettings = next;
  if (!saveSettings(currentSettings)) {
    console.log("sov: could not write ~/.sov-settings.json");
  }
  if (hotkeyChanged) restartHotkey();
  if (clickThroughChanged) applyClickThrough();
  if (startWithWindowsChanged) {
    await applyStartWithWindows(currentSettings.startWithWindows);
  }
  if (autoHideChanged) {
    if (currentSettings.autoHideOnFullscreen) startFullscreenPoller();
    else stopFullscreenPoller();
  }
  return { ok: true, settings: { ...currentSettings }, rejected };
});

// ------------------------------------------------------------------ logs
ipcMain.handle("sov:open-logs", async (event) => {
  if (!isLocalSender(event)) return false;
  try {
    if (shell && typeof shell.openPath === "function") {
      await shell.openPath(logFilePath());
      return true;
    }
  } catch {
    // Opening the log is best-effort.
  }
  return false;
});

// ------------------------------------------------------------------ lyrics
// Lyrics from LRCLIB, fetched FROM the main process (not the
// renderer): browsers cannot set a User-Agent header on fetch, so
// only the main process can identify sov properly to the API.
// Mirrors the client's fetchLyrics logic (standalone/client/src/
// spotify/api.ts): /api/get with track/artist/duration (+album),
// falling back to /api/search and taking the first result that has
// synced or plain lyrics. Returns the raw LRCLIB record
// ({ syncedLyrics, plainLyrics, ... }) or null when nothing was
// found / the fetch failed — the client parses it with its existing
// parseLrc. Never throws.
const LYRICS_USER_AGENT =
  "sov/2026-11-13l (Spotify overlay; https://github.com/lonerharsh57-lab/Sov)";
const LYRICS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LYRICS_CACHE_MAX_ENTRIES = 200;

function lyricsCacheFile() {
  return path.join(app.getPath("userData"), "lyrics-cache.json");
}

function lyricsCacheKey(title, artist, durationSec) {
  return `${String(title || "").trim().toLowerCase()}\n${String(artist || "").trim().toLowerCase()}\n${Math.round(Number(durationSec) || 0)}`;
}

function loadLyricsCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(lyricsCacheFile(), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch {
    // No cache, or a corrupt one — start empty.
  }
  return {};
}

function saveLyricsCache(cache) {
  try {
    fs.mkdirSync(path.dirname(lyricsCacheFile()), { recursive: true });
    const keys = Object.keys(cache);
    if (keys.length > LYRICS_CACHE_MAX_ENTRIES) {
      // Evict the oldest entries first (by fetchedAt).
      keys
        .sort((a, b) => (cache[a].fetchedAt || 0) - (cache[b].fetchedAt || 0))
        .slice(0, keys.length - LYRICS_CACHE_MAX_ENTRIES)
        .forEach((k) => delete cache[k]);
    }
    fs.writeFileSync(lyricsCacheFile(), JSON.stringify(cache), "utf8");
  } catch {
    // A failed cache write must never break lyrics.
  }
}

async function lrclibJson(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": LYRICS_USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function lrclibRecordHasLyrics(rec) {
  return (
    rec &&
    typeof rec === "object" &&
    (typeof rec.syncedLyrics === "string" && rec.syncedLyrics.trim() !== "" ||
      typeof rec.plainLyrics === "string" && rec.plainLyrics.trim() !== "")
  );
}

ipcMain.handle("sov:lyrics-fetch", async (event, args) => {
  if (!isLocalSender(event)) return null;
  const title = args && typeof args.title === "string" ? args.title.trim() : "";
  const artist = args && typeof args.artist === "string" ? args.artist.trim() : "";
  const album = args && typeof args.album === "string" ? args.album.trim() : "";
  const durationSec = args && Number.isFinite(Number(args.durationSec)) ? Number(args.durationSec) : 0;
  if (!title || !artist) return null;

  const key = lyricsCacheKey(title, artist, durationSec);
  const cache = loadLyricsCache();
  const cached = cache[key];
  if (cached && cached.record && Date.now() - (cached.fetchedAt || 0) < LYRICS_CACHE_TTL_MS) {
    return cached.record;
  }

  let record = null;
  const getParams = new URLSearchParams({
    track_name: title,
    artist_name: artist,
    duration: String(Math.round(durationSec)),
  });
  if (album) getParams.set("album_name", album);
  const got = await lrclibJson(`https://lrclib.net/api/get?${getParams}`);
  if (lrclibRecordHasLyrics(got)) {
    record = got;
  } else {
    const searchParams = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    const found = await lrclibJson(`https://lrclib.net/api/search?${searchParams}`);
    if (Array.isArray(found)) {
      for (const r of found) {
        if (lrclibRecordHasLyrics(r)) {
          record = r;
          break;
        }
      }
    }
  }
  if (!record) return null;
  cache[key] = { record, fetchedAt: Date.now() };
  saveLyricsCache(cache);
  return record;
});

// ------------------------------------------------------------------ clear data
// Log out + wipe everything sov stored on disk: tokens (safeStorage
// blob), the settings file, the window-position file, the log file
// and the lyrics cache. In-memory settings reset to the defaults and
// the hotkey is restarted from those defaults, so the app keeps
// running in a clean state. Returns true. (The Client ID in
// ~/.spotify_overlay.json is NOT touched — that is the user's
// Spotify app registration, not sov data.)
ipcMain.handle("sov:clear-data", async (event) => {
  if (!isLocalSender(event)) return false;
  currentSettings = { ...SETTINGS_DEFAULTS };
  try {
    restartHotkey();
  } catch {
    // Restarting the hotkey is best-effort.
  }
  stopFullscreenPoller();
  const files = [
    tokensFile(),
    SETTINGS_FILE,
    WIN_POS_FILE,
    lyricsCacheFile(),
    logFilePath(),
  ];
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone — clearing is still a success.
    }
  }
  return true;
});

// Drag following — the JS drag path (see useWindowDrag in App.tsx).
// The renderer only sends drag-start and drag-end. On drag-start this
// process records the cursor (screen.getCursorScreenPoint()), the
// window position and the window size. While dragging, a ~8ms timer
// reads the cursor and sets the window's bounds from the SAVED size:
// position = startWindowPos + (cursor - startCursor), clamped to the
// work area. Never setPosition(), never getSize() mid-drag, so display
// scaling and window re-sizing can never make it drift.
let dragAnchor = null;
let dragTimer = null;
let dragPendingResize = null;

function stopDragTimer() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
}

// One drag frame: the window is always placed from the drag-start
// anchor, with the size it had at drag-start.
function dragFrame() {
  if (!win || !dragAnchor) return;
  const cursor = screen.getCursorScreenPoint();
  const nx = dragAnchor.wx + (cursor.x - dragAnchor.cx);
  const ny = dragAnchor.wy + (cursor.y - dragAnchor.cy);
  const pos = clampToWorkArea(
    Math.round(nx),
    Math.round(ny),
    dragAnchor.ww,
    dragAnchor.wh,
  );
  if (pos.x !== dragAnchor.wx || pos.y !== dragAnchor.wy) {
    dragAnchor.moved = true;
  }
  win.setBounds({
    x: pos.x,
    y: pos.y,
    width: dragAnchor.ww,
    height: dragAnchor.wh,
  });
}

ipcMain.on("sov:drag-start", (event) => {
  if (!isLocalSender(event)) return;
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const [ww, wh] = win.getSize();
  dragAnchor = {
    cx: cursor.x,
    cy: cursor.y,
    wx,
    wy,
    ww,
    wh,
    moved: false,
  };
  stopDragTimer();
  dragTimer = setInterval(dragFrame, 8);
});


ipcMain.on("sov:drag-end", (event) => {
  if (!isLocalSender(event)) return;
  // Stop following the cursor first, then land on the final position
  // (the last timer tick may be up to 8ms old).
  stopDragTimer();
  const anchor = dragAnchor;
  if (win && anchor) {
    dragFrame();
    // A queued resize from mid-drag is applied here, now that the drag
    // is over: the drag itself never moved or resized the window.
    if (dragPendingResize) {
      const pending = dragPendingResize;
      dragPendingResize = null;
      applyResize(pending.width, pending.height);
    }
    // Snap-to-corners (settings.snapToCorners): the window lands on the
    // nearest corner of the display work area it is on. Only after a
    // real move — a plain click must not move the window.
    if (currentSettings.snapToCorners && anchor.moved) {
      try {
        const [cx, cy] = win.getPosition();
        const [cw, ch] = win.getSize();
        const wa = screen.getDisplayMatching({
          x: cx,
          y: cy,
          width: cw,
          height: ch,
        }).workArea;
        const corners = [
          { x: wa.x, y: wa.y },
          { x: wa.x + wa.width - cw, y: wa.y },
          { x: wa.x, y: wa.y + wa.height - ch },
          { x: wa.x + wa.width - cw, y: wa.y + wa.height - ch },
        ];
        // Nearest corner by centre distance.
        const ccx = cx + cw / 2;
        const ccy = cy + ch / 2;
        let best = corners[0];
        let bestD = Infinity;
        for (const c of corners) {
          const d = Math.hypot(ccx - (c.x + cw / 2), ccy - (c.y + ch / 2));
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        win.setPosition(Math.round(best.x), Math.round(best.y));
      } catch {
        // A failed snap never blocks the drag ending.
      }
    }
    // Save the position ONCE, on drag-end — never per move frame.
    if (anchor.moved) {
      const [x, y] = win.getPosition();
      saveWindowPos(x, y);
    }
  }
  dragAnchor = null;
});


// Whole-window opacity from the opacity slider (0.2–1.0).
ipcMain.handle("sov:set-opacity", (event, value) => {
  if (!isLocalSender(event)) return false;
  if (!win) return false;
  const v = clamp(Number(value) || 1, 0.2, 1);
  win.setOpacity(v);
  return true;
});

// ------------------------------------------------------------------ toggle
// Ring ⇄ player, owned by the main process. The hotkey, the ring
// click and the shrink button all funnel through togglePlayer(), and
// the renderer is told the new state through the "sov:toggle" event
// (see preload.js on_toggle) — it never flips `expanded` on its own.
function resizeToPlayerSize() {
  if (!win) return;
  const w = lastPlayerSize.width;
  const h = lastPlayerSize.height;
  const [bx, by] = win.getPosition();
  const [bw, bh] = win.getSize();
  // No Math.max(0, ...) — see sov:resize: negative coordinates are
  // valid on monitors left of / above the primary; clampToWorkArea
  // is the only clamp, plus clampFullyInsideIfFits when it fits.
  const x = bx + bw - w;
  const y = by + bh - h;
  const clamped = clampToWorkArea(x, y, w, h);
  const pos = clampFullyInsideIfFits(clamped.x, clamped.y, w, h);
  win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
}

function togglePlayer() {
  if (!win || !playerActive) return false;
  // Hidden to the tray: just bring the window back in whatever state
  // it was in — don't flip `expanded`, or the first press after hiding
  // is wasted (it would collapse an invisible window).
  if (!win.isVisible()) {
    // showWindow() respects dontStealFocus (default true):
    // showInactive(), NOT show()+focus(): the hotkey fires while the
    // user is in a game, and focus() would steal focus (and input)
    // from the game. The window still takes focus when the user
    // clicks into it — that is default Windows behaviour, and
    // focusable is deliberately left on so typing in the search box
    // keeps working.
    showWindow();
    return expanded;
  }
  expanded = !expanded;
  if (expanded) {
    // Resize first so the window is already player-sized when the
    // panel appears, then bring it to front — the user may be in a
    // game, so the window has to come to them, not the other way.
    // showWindow() respects dontStealFocus (see above).
    resizeToPlayerSize();
    showWindow();
  }
  // On collapse the window is NOT resized here: the renderer plays the
  // 150ms shrink transition first, then reports the ring size and the
  // window shrinks to 70x70 (see useWindowFit in App.tsx). Resizing
  // here would clip that transition mid-shrink.
  //
  // Click-through follows the expanded state (see applyClickThrough):
  // collapsed + clickThrough on = clicks pass through to the game;
  // expanded = the window takes mouse events again.
  applyClickThrough();
  win.webContents.send("sov:toggle", expanded);
  return expanded;
}

ipcMain.handle("sov:toggle-request", (event) => {
  if (!isLocalSender(event)) return false;
  return togglePlayer();
});

ipcMain.handle("sov:player-active", (event, active) => {
  if (!isLocalSender(event)) return false;
  playerActive = !!active;
  return true;
});

// ------------------------------------------------------------------ auto-update
// Crash-safe auto-update via electron-updater (GitHub provider:
// lonerharsh57-lab/Sov). autoDownload + autoInstallOnAppQuit: an
// update is downloaded in the background and installed only when
// the app quits — never while it is running, so an update can never
// crash a gaming session or a half-applied install. First check runs
// ~30s after startup so it never blocks launch; the tray menu also
// has "Check for updates". Events only ever log or update the tray
// tooltip — an update error never shows a popup.
//
// The require is lazy and fully guarded: if electron-updater is
// missing (or cannot load — e.g. outside Electron, where its
// autoUpdater getter throws), the app simply runs without updates
// and logs why. setFeedURL configures the GitHub provider in code,
// so no publish config is needed in package.json.
//
// Honest limit (see README too): DIFFERENTIAL (delta) updates need
// GitHub Releases published with the NSIS installer AND its
// blockmap. The current packaging is a custom makensis installer,
// which produces no blockmap, so delta updates require switching
// the packaging to electron-builder's nsis target — a packaging
// decision for later, not this step. What this wires up is the
// updater + the full-update path once releases exist.
let autoUpdater = null;

function checkForUpdates() {
  if (!autoUpdater) {
    console.log("sov: auto-updater is not available — install updates manually.");
    return false;
  }
  try {
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.log(`sov: update check failed: ${err && err.message ? err.message : err}`);
      });
    }
    return true;
  } catch (err) {
    console.log(`sov: update check failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

function setupAutoUpdater() {
  try {
    const mod = require("electron-updater");
    autoUpdater = (mod && (mod.autoUpdater || mod.default)) || null;
    if (!autoUpdater) {
      console.log("sov: electron-updater loaded but has no autoUpdater — updates disabled.");
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    try {
      if (typeof autoUpdater.setFeedURL === "function") {
        autoUpdater.setFeedURL({
          provider: "github",
          owner: "lonerharsh57-lab",
          repo: "Sov",
        });
      }
    } catch (err) {
      console.log(`sov: could not set the update feed: ${err && err.message ? err.message : err}`);
    }
    if (typeof autoUpdater.on === "function") {
      autoUpdater.on("update-available", (info) => {
        const version = (info && info.version) || "a new version";
        console.log(`sov: update available (${version}) — downloading in the background.`);
        if (tray) tray.setToolTip(`sov — update ${version} downloading…`);
      });
      autoUpdater.on("update-downloaded", (info) => {
        const version = (info && info.version) || "a new version";
        console.log(`sov: update ${version} downloaded — it will install when you quit sov.`);
        if (tray) tray.setToolTip(`sov — update ${version} ready, installs on quit`);
      });
      autoUpdater.on("error", (err) => {
        // Log only — an update failure is never worth a popup.
        console.log(`sov: auto-update error: ${err && err.message ? err.message : err}`);
      });
    }
    // First check ~30s after startup, so it can never block launch.
    const timer = setTimeout(() => checkForUpdates(), 30000);
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (err) {
    autoUpdater = null;
    console.log(`sov: auto-updater unavailable (${err && err.message ? err.message : err}) — updates must be installed manually.`);
  }
}

// ------------------------------------------------------------------ tray
// The app lives in the system tray when the window is hidden: closing
// the window (or the X button) hides it there instead of quitting, so
// it keeps running in the background (server, hotkey, tray). Quitting
// happens only from the tray menu.
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Show sov",
      click: () => {
        showWindow();
      },
    },
    {
      label: "Hide",
      click: () => {
        if (win) win.hide();
      },
    },
    { type: "separator" },
    {
      label: "Open logs",
      click: () => {
        // Same file as sov:open-logs — <userData>/sov.log.
        if (shell && typeof shell.openPath === "function") {
          shell.openPath(logFilePath()).catch(() => {});
        }
      },
    },
    {
      label: "Check for updates",
      click: () => {
        checkForUpdates();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  tray = new Tray(image);
  tray.setToolTip(`sov — Spotify overlay (${TOGGLE_HOTKEY} to toggle)`);
  tray.on("click", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    // showWindow(): a tray click is the user asking to see the
    // overlay, not to take focus away from their game — same
    // reasoning as the hotkey path. Clicking into the window still
    // focuses it normally.
    else showWindow();
  });
  tray.setContextMenu(buildTrayMenu());
}

// ------------------------------------------------------------------ startup
// Start the local server, with a Retry/Quit dialog when the port is
// held. The port is PINNED to 8888: the Spotify redirect URI
// http://127.0.0.1:8888/callback is registered for 8888, so silently
// falling back to another port would break login. Retry re-attempts
// startServer on the same port (a stale sov may have just exited);
// Quit exits. Never silently switches ports.
async function startServerWithRetry(distDir) {
  for (;;) {
    try {
      await startServer({
        distDir,
        // console.log is wrapped (see the log-file section at the
        // top) so server lines land in <userData>/sov.log too.
        onLog: (line) => console.log(line),
      });
      return true;
    } catch (err) {
      const inUse = err && err.code === "EADDRINUSE";
      const message = inUse
        ? `Port 8888 is already in use — another app (or a stale sov) is holding it.\n\nsov must use port 8888: the Spotify login redirect (http://127.0.0.1:8888/callback) is registered for that port, so it cannot move to another one.\n\nClose the other app (or the old sov window) and press Retry, or press Quit.`
        : `sov could not start its local server on 127.0.0.1:8888.\n\n${err && err.message ? err.message : err}`;
      if (dialog.showMessageBox) {
        const { response } = await dialog.showMessageBox({
          type: "error",
          title: "sov — port 8888 is in use",
          message,
          buttons: ["Retry", "Quit"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) continue;
        return false;
      }
      dialog.showErrorBox("sov — port 8888 is in use", message);
      return false;
    }
  }
}

app.whenReady().then(async () => {
  const distDir = path.join(__dirname, "dist");
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    dialog.showErrorBox(
      "sov — files missing",
      "The app files (dist/) are missing. Reinstall sov and try again.",
    );
    app.quit();
    return;
  }

  if (!(await startServerWithRetry(distDir))) {
    app.quit();
    return;
  }

  console.log(`sov: serving on http://${HOST}:${PORT}/`);
  console.log(`sov: build ${BUILD}`);
  console.log(
    "sov: if the overlay window doesn't respond to clicks, open " +
      `http://${HOST}:${PORT}/ in your browser instead — same UI.`,
  );

  createWindow();
  createTray();
  setupAutoUpdater();

  // Apply the persisted settings that need acting on at startup:
  // start-with-Windows (registry key), the fullscreen poller, and
  // click-through (collapsed + on = clicks pass through to the game).
  // All are best-effort and never block startup.
  applyClickThrough();
  if (currentSettings.startWithWindows) {
    applyStartWithWindows(true);
  }
  if (currentSettings.autoHideOnFullscreen) {
    startFullscreenPoller();
  }

  // Global toggle hotkey (works while gaming). The hook is
  // registered once here and unregistered on quit. The effective
  // hotkey comes from ~/.sov-settings.json (see hotkey.js); the
  // default is Ctrl+Shift+M.
  hotkeyHandle = createHotkey({ toggle: togglePlayer, globalShortcut });
  if (hotkeyHandle.mode === "hook") {
    console.log(
      `sov: toggle hotkey: ${hotkeyHandle.description || TOGGLE_HOTKEY} (low-level hook — works while gaming)`,
    );
  } else if (hotkeyHandle.mode === "globalShortcut") {
    console.log(
      `sov: toggle hotkey: ${hotkeyHandle.description || TOGGLE_HOTKEY} (global shortcut fallback)`,
    );
  } else {
    console.log(
      "sov: no global toggle hotkey available — click the ring to toggle.",
    );
  }
  // The tray tooltip was set with the default hotkey description;
  // correct it if the settings file configured a different hotkey.
  if (hotkeyHandle.description && tray) {
    tray.setToolTip(`sov — Spotify overlay (${hotkeyHandle.description} to toggle)`);
  }
  // (The "second-instance" handler lives at the top level, right
  // after requestSingleInstanceLock — it is not registered here, so
  // a quick second launch can never be missed.)
});

app.on("window-all-closed", () => {
  // Deliberately NOT quitting: the app stays running in the tray when
  // the window closes. Quitting happens only via the tray menu.
});

app.on("before-quit", () => {
  // Backstop for the close handler: any quit path (tray Quit,
  // in-app Quit, Windows shutdown, installer upgrade) sets
  // isQuitting, so the window's close event lets the quit through
  // instead of hiding to the tray and blocking it.
  isQuitting = true;
  stopFullscreenPoller();
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // Destroying the tray on quit is best-effort.
    }
    tray = null;
  }
  if (hotkeyHandle) {
    try {
      hotkeyHandle.stop();
    } catch {
      // Unregistering on quit is best-effort.
    }
    hotkeyHandle = null;
  }
});
