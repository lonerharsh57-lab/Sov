declare module "*.css";

/** The sov desktop bridge (present only when running inside the
 *  desktop window). All methods are optional — the app also runs in
 *  a plain browser, where they are simply absent. */
interface SovApi {
  resize_window?(width: number, height: number): Promise<void>;
  open_login?(url: string): Promise<boolean>;
  quit?(): Promise<void>;
  /** Ask the main process to toggle ring ⇄ player (hotkey path). */
  toggle?(): Promise<boolean>;
  /** Tell the main process whether the player is mounted (hotkey target). */
  set_player_active?(active: boolean): Promise<void>;
  /** Subscribe to toggle events from the main process (hotkey/click).
   *  Returns an unsubscribe function. */
  on_toggle?(cb: (expanded: boolean) => void): () => void;
  /** Subscribe to window show/hide (tray) events from the main process.
   *  Returns an unsubscribe function. */
  on_visibility?(cb: (visible: boolean) => void): () => void;
  /** Tokens, encrypted with Electron safeStorage by the main process.
   *  Null when nothing is stored. */
  tokens_get?(): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: number;
  } | null>;
  tokens_set?(tokens: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  }): Promise<void>;
  tokens_clear?(): Promise<void>;
  /** Set the whole window's opacity, 0.2–1.0. */
  set_opacity?(value: number): Promise<void>;
  /** Hide the window to the tray (the app keeps running). */
  hide_window?(): Promise<void>;
  /** Anchor a drag at the press point (screen pixels). The main
   *  process records the cursor, the window position and the window
   *  size once, here, then follows the cursor itself. */
  drag_start?(sx: number, sy: number): Promise<void>;
  /** Release the drag anchor (pointerup / cancel). */
  drag_end?(): Promise<void>;
}

/** Old name for the bridge interface — window.pywebview is kept as a
 *  compatibility alias for window.sov. */
type PywebviewApi = SovApi;

interface Window {
  sov?: {
    api?: SovApi;
  };
  /** Compatibility alias for window.sov — same object. */
  pywebview?: {
    api?: PywebviewApi;
  };
}
