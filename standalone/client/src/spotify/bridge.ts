/**
 * sov desktop bridge, with its timing quirk handled.
 *
 * The Electron preload exposes the bridge as `window.sov`
 * (`window.pywebview` is kept as a compatibility alias pointing at
 * the same object). The bridge usually exists by the time React
 * mounts — the preload runs before the page's JavaScript — but on a
 * slow first load it can lag behind, so every call here retries
 * until the bridge answers: immediately when it is already there,
 * and on a short poll as a backstop. In a plain browser there is no
 * bridge and every call is a no-op.
 */

type Bridge = {
  resize_window?: (width: number, height: number) => unknown;
  open_login?: (url: string) => unknown;
  quit?: () => unknown;
  toggle?: () => unknown;
  set_player_active?: (active: boolean) => unknown;
  on_toggle?: (cb: (expanded: boolean) => void) => unknown;
  /** Subscribe to window show/hide (tray) events from the main process. */
  on_visibility?: (cb: (visible: boolean) => void) => unknown;
  /** Tokens, encrypted with Electron safeStorage by the main process. */
  tokens_get?: () => unknown;
  tokens_set?: (tokens: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  }) => unknown;
  tokens_clear?: () => unknown;
  set_opacity?: (value: number) => unknown;
  hide_window?: () => unknown;
  /** Anchor a drag at the press point (screen pixels). The main
   *  process records the cursor, the window position and the window
   *  size once, here, then follows the cursor itself. */
  drag_start?: (sx: number, sy: number) => unknown;
  /** Release the drag anchor (pointerup / cancel). */
  drag_end?: () => unknown;
  /** Settings (Phase 2): ~/.sov-settings.json via the main process.
   *  get returns the full settings object (defaults filled in);
   *  set takes a partial object and returns
   *  { ok, settings, rejected }. */
  settings_get?: () => unknown;
  settings_set?: (patch: Record<string, unknown>) => unknown;
  /** Open the log file in the default app. Returns true on success. */
  open_logs?: () => unknown;
  /** Lyrics from LRCLIB, fetched by the main process (proper
   *  User-Agent, 30-day disk cache). Returns the raw LRCLIB record
   *  ({ syncedLyrics, plainLyrics, ... }) or null. */
  lyrics_fetch?: (args: {
    title: string;
    artist: string;
    album: string;
    durationSec: number;
  }) => unknown;
  /** Log out + wipe everything sov stored on disk (tokens, settings,
   *  window position, log, lyrics cache). Returns true. The Client
   *  ID is NOT touched. */
  clear_data?: () => unknown;
};

/**
 * Per-launch local-server secret.
 *
 * The server generates a fresh random secret on every launch and
 * injects it into the served index.html in memory as
 * window.__SOV_SECRET__ (dist/index.html on disk is never edited).
 * The app sends it back as X-Sov-Secret on its /api/* calls, so a
 * foreign page — which can never read the served page — can't call
 * the sensitive local endpoints. GET /api/health is exempt (App.tsx
 * polls it without the secret) and the browser callback flow has no
 * secret at all (its token POST is bound to the OAuth state instead).
 * Returns null when the page wasn't served by the local server (plain
 * browser tab, stale server): callers then send no secret and the
 * server rejects the protected calls, which is the safe failure.
 */
declare global {
  interface Window {
    __SOV_SECRET__?: string;
  }
}

export function getLocalSecret(): string | null {
  if (typeof window === "undefined") return null;
  const s = window.__SOV_SECRET__;
  return typeof s === "string" && s ? s : null;
}

/** Headers for local /api/* calls: the per-launch secret when this
 *  page was served by the local server, plus any extra headers the
 *  caller needs (e.g. Content-Type). */
export function localApiHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const secret = getLocalSecret();
  if (secret) headers["X-Sov-Secret"] = secret;
  return headers;
}

function getBridge(): Bridge | null {
  if (typeof window === "undefined") return null;
  // `window.sov` is the primary name; `window.pywebview` is the old
  // name, kept as a compatibility alias for the same object.
  const sov = window.sov as { api?: Bridge } | undefined;
  if (sov?.api) return sov.api;
  const pv = window.pywebview as { api?: Bridge } | undefined;
  return pv?.api ?? null;
}

function bridgeReady(): boolean {
  const b = getBridge();
  return (
    !!b &&
    (typeof b.resize_window === "function" ||
      typeof b.open_login === "function" ||
      typeof b.toggle === "function" ||
      typeof b.quit === "function")
  );
}

/** Resolve true once the bridge exists, or false after timeoutMs.
 *  The bridge usually exists by the time the user can click anything,
 *  but on a slow first load it can lag behind React mounting — the
 *  login waits briefly rather than falling back to the in-window
 *  login, which is the path that freezes. In a plain browser the
 *  bridge never appears and this resolves false after the timeout. */
export function waitForBridge(timeoutMs = 1000): Promise<boolean> {
  if (bridgeReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const check = () => {
      if (bridgeReady()) finish(true);
    };
    // Poll backstop only — the old `pywebviewready` event no longer
    // fires in the Electron shell (the preload installs the bridge
    // before the page's JavaScript runs), so there is no event to wait on.
    const id = window.setInterval(check, 100);
    window.setTimeout(() => {
      window.clearInterval(id);
      finish(false);
    }, timeoutMs);
  });
}

/** True when running inside the desktop window. */
export function isDesktop(): boolean {
  return bridgeReady();
}

/** Run cb as soon as the bridge exists: now, or on a short poll —
 *  whichever comes first. Never calls back in a plain browser. */
export function whenBridgeReady(cb: () => void): void {
  if (bridgeReady()) {
    cb();
    return;
  }
  let done = false;
  const check = () => {
    if (done) return;
    if (bridgeReady()) {
      done = true;
      cb();
    }
  };
  // Poll backstop only — no `pywebviewready` event in the Electron shell.
  const id = window.setInterval(() => {
    check();
    if (done) window.clearInterval(id);
  }, 150);
  window.setTimeout(() => window.clearInterval(id), 8000);
}

/** Resize the desktop window, retrying until the bridge answers. */
export function requestResize(width: number, height: number): void {
  const b = getBridge();
  if (b && typeof b.resize_window === "function") {
    void b.resize_window(width, height);
    return;
  }
  whenBridgeReady(() => {
    const b2 = getBridge();
    if (b2 && typeof b2.resize_window === "function") {
      void b2.resize_window(width, height);
    }
  });
}

/** Close the desktop window. */
export function requestQuit(): void {
  const b = getBridge();
  if (b && typeof b.quit === "function") {
    void b.quit();
  }
}

/** Anchor a drag at the press point, in screen pixels. Called on
 *  pointerdown by the drag hook — the main process records the cursor,
 *  the window position and the window size once, here, then follows
 *  the cursor on its own timer. No-op without a bridge (plain browser:
 *  there is no window to move). */
export function requestDragStart(sx: number, sy: number): void {
  const b = getBridge();
  if (b && typeof b.drag_start === "function") {
    void b.drag_start(sx, sy);
  }
}

/** Release the drag anchor (pointerup / cancel). No-op without a
 *  bridge. */
export function requestDragEnd(): void {
  const b = getBridge();
  if (b && typeof b.drag_end === "function") {
    void b.drag_end();
  }
}

/** Hide the desktop window to the tray — the app keeps running
 *  (server, hotkey, tray). No-op without a bridge (plain browser). */
export function requestHide(): void {
  const b = getBridge();
  if (b && typeof b.hide_window === "function") {
    void b.hide_window();
  }
}

/** Set the whole window's opacity (0.2–1.0), retrying until the bridge
 *  answers — same pattern as requestResize, so a call on mount lands. */
export function requestOpacity(value: number): void {
  const v = Math.min(1, Math.max(0.2, value));
  const b = getBridge();
  if (b && typeof b.set_opacity === "function") {
    void b.set_opacity(v);
    return;
  }
  whenBridgeReady(() => {
    const b2 = getBridge();
    if (b2 && typeof b2.set_opacity === "function") {
      void b2.set_opacity(v);
    }
  });
}

/** Open a URL in the user's default browser through the desktop
 *  bridge. Returns true when the call was issued, false when there is
 *  no bridge (plain browser) — the caller then falls back to
 *  navigating in-page. */
export function requestOpenLogin(url: string): boolean {
  const b = getBridge();
  if (b && typeof b.open_login === "function") {
    void b.open_login(url);
    return true;
  }
  return false;
}

/** Ask the main process to toggle ring ⇄ player (the hotkey path —
 *  the main process owns the expanded state). Returns true when the
 *  call was issued, false when there is no bridge (plain browser) —
 *  the caller then toggles locally instead. */
export function requestToggle(): boolean {
  const b = getBridge();
  if (b && typeof b.toggle === "function") {
    void b.toggle();
    return true;
  }
  return false;
}

/** Tell the main process whether the player is mounted, so the
 *  hotkey toggle knows there is a player to toggle (the Connect
 *  screen has none). No-op without a bridge. */
export function setPlayerActive(active: boolean): void {
  const b = getBridge();
  if (b && typeof b.set_player_active === "function") {
    void b.set_player_active(active);
  }
}

/** Subscribe to toggle events from the main process (hotkey or a
 *  toggle request). Returns an unsubscribe function; without a
 *  bridge (plain browser) it returns a no-op. */
export function onToggle(cb: (expanded: boolean) => void): () => void {
  const b = getBridge();
  if (b && typeof b.on_toggle === "function") {
    const off = b.on_toggle(cb) as unknown;
    if (typeof off === "function") return off as () => void;
  }
  return () => {};
}

/* ------------------------------------------------------------------ */
/* Token store (Electron safeStorage via the main process)             */
/* ------------------------------------------------------------------ */

export type BridgeTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

/** True when the desktop bridge offers the safeStorage token store.
 *  False in a plain browser tab — auth.ts then falls back to
 *  localStorage. */
export function hasTokenStore(): boolean {
  const b = getBridge();
  return !!b && typeof b.tokens_get === "function";
}

/** The token store: get/set/clear through the main process, which
 *  encrypts with Electron safeStorage. Rejects when there is no
 *  bridge (plain browser) or the IPC fails — auth.ts falls back to
 *  localStorage in that case. */
export function getTokenStore(): {
  get: () => Promise<BridgeTokens | null>;
  set: (t: BridgeTokens) => Promise<void>;
  clear: () => Promise<void>;
} {
  const read = async (): Promise<BridgeTokens | null> => {
    const b = getBridge();
    if (!b || typeof b.tokens_get !== "function") {
      throw new Error("no token store");
    }
    const v = (await b.tokens_get()) as unknown;
    if (!v || typeof v !== "object") return null;
    const t = v as Partial<BridgeTokens>;
    if (typeof t.access_token !== "string") return null;
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
      expires_at: typeof t.expires_at === "number" ? t.expires_at : 0,
    };
  };
  const write = async (t: BridgeTokens): Promise<void> => {
    const b = getBridge();
    if (!b || typeof b.tokens_set !== "function") {
      throw new Error("no token store");
    }
    await b.tokens_set(t);
  };
  const clear = async (): Promise<void> => {
    const b = getBridge();
    if (!b || typeof b.tokens_clear !== "function") {
      throw new Error("no token store");
    }
    await b.tokens_clear();
  };
  return { get: read, set: write, clear };
}

/* ------------------------------------------------------------------ */
/* Window visibility (tray hide/show)                                  */
/* ------------------------------------------------------------------ */

/** Subscribe to window visibility changes from the main process
 *  (shown / hidden to the tray). The callback fires with true when
 *  the window is shown and false when it is hidden. Returns an
 *  unsubscribe function; without a bridge (plain browser) it
 *  returns a no-op — the caller should also listen to
 *  document.visibilitychange as a secondary signal. */
export function onVisibility(cb: (visible: boolean) => void): () => void {
  const b = getBridge();
  if (b && typeof b.on_visibility === "function") {
    const off = b.on_visibility(cb) as unknown;
    if (typeof off === "function") return off as () => void;
  }
  return () => {};
}

/* ------------------------------------------------------------------ */
/* Settings, logs, lyrics, clear-data (Phase 2)                        */
/* ------------------------------------------------------------------ */

/** The sov settings object — the exact schema main.js validates
 *  (see SETTINGS_DEFAULTS there). Unknown keys are rejected by
 *  settings-set and never stored. */
export type SovSettings = {
  hotkey: string;
  hotkeyMode: "hook" | "globalShortcut";
  startWithWindows: boolean;
  snapToCorners: boolean;
  clickThrough: boolean;
  sizePreset: "small" | "medium" | "large";
  dontStealFocus: boolean;
  autoHideOnFullscreen: boolean;
  highContrast: boolean;
  lyricsOffsetMs: number;
};

export const DEFAULT_SETTINGS: SovSettings = {
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

/** Run fn with the bridge, waiting briefly for it if it has not
 *  appeared yet (slow first load). Null when there is no bridge
 *  (plain browser) or the call fails. */
async function withBridge<T>(
  fn: (b: NonNullable<ReturnType<typeof getBridge>>) => Promise<T>,
): Promise<T | null> {
  let b = getBridge();
  if (!b) {
    const ok = await waitForBridge(1000);
    if (!ok) return null;
    b = getBridge();
    if (!b) return null;
  }
  try {
    return await fn(b);
  } catch {
    return null;
  }
}

/** Full settings object (defaults filled in). Null without a bridge. */
export async function getSettings(): Promise<SovSettings | null> {
  return withBridge(async (b) => {
    if (typeof b.settings_get !== "function") return null;
    const v = (await b.settings_get()) as unknown;
    if (!v || typeof v !== "object") return null;
    return { ...DEFAULT_SETTINGS, ...(v as Partial<SovSettings>) };
  });
}

/** Save a partial settings patch. Returns the main process's answer
 *  ({ ok, settings, rejected }) or null without a bridge. */
export async function setSettings(
  patch: Partial<SovSettings>,
): Promise<{
  ok: boolean;
  settings: SovSettings;
  rejected: string[];
} | null> {
  return withBridge(async (b) => {
    if (typeof b.settings_set !== "function") return null;
    const v = (await b.settings_set(patch)) as unknown;
    if (!v || typeof v !== "object") return null;
    const r = v as {
      ok?: unknown;
      settings?: unknown;
      rejected?: unknown;
    };
    if (!r.settings || typeof r.settings !== "object") return null;
    return {
      ok: r.ok === true,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(r.settings as Partial<SovSettings>),
      },
      rejected: Array.isArray(r.rejected)
        ? r.rejected.filter((x): x is string => typeof x === "string")
        : [],
    };
  });
}

/** Ask the main process to open the log file. False without a bridge. */
export async function openLogs(): Promise<boolean> {
  const b = getBridge();
  if (!b || typeof b.open_logs !== "function") return false;
  try {
    return (await b.open_logs()) === true;
  } catch {
    return false;
  }
}

/** Raw LRCLIB record as returned by the main-process lyrics fetch. */
export type LyricsRecord = {
  syncedLyrics?: string;
  plainLyrics?: string;
  [key: string]: unknown;
};

/** True when the desktop bridge offers the main-process lyrics fetch. */
export function hasMainLyrics(): boolean {
  const b = getBridge();
  return !!b && typeof b.lyrics_fetch === "function";
}

/** Lyrics via the main process (proper User-Agent + 30-day cache).
 *  Null when there is no bridge or nothing was found — the caller
 *  falls back to the direct browser fetch. */
export async function fetchLyricsViaMain(args: {
  title: string;
  artist: string;
  album: string;
  durationSec: number;
}): Promise<LyricsRecord | null> {
  const b = getBridge();
  if (!b || typeof b.lyrics_fetch !== "function") return null;
  try {
    const v = (await b.lyrics_fetch(args)) as unknown;
    if (!v || typeof v !== "object") return null;
    return v as LyricsRecord;
  } catch {
    return null;
  }
}

/** Wipe everything sov stored on disk (tokens, settings, window
 *  position, log, lyrics cache). The Client ID is NOT touched.
 *  False without a bridge. */
export async function clearAllData(): Promise<boolean> {
  const b = getBridge();
  if (!b || typeof b.clear_data !== "function") return false;
  try {
    return (await b.clear_data()) === true;
  } catch {
    return false;
  }
}
