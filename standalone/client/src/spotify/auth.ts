/**
 * Spotify PKCE auth for the standalone app.
 *
 * No Client ID or secret is baked into the app. The Client ID comes from
 * one of two places, in this order:
 *   1. localStorage (pasted once in the app, stored on this machine only)
 *   2. the local server's /api/config, which reads it from
 *      ~/.spotify_overlay.json — the same file the old Python overlay
 *      saved it to.
 * Tokens live in Electron safeStorage on this machine (via the main
 * process — see bridge.ts getTokenStore) and are refreshed through
 * Spotify's token endpoint, exactly like the old Python overlay. In
 * a plain browser tab there is no safeStorage, so tokens fall back
 * to localStorage there.
 */

export const REDIRECT_URI = "http://127.0.0.1:8888/callback";
export const SCOPES =
  "user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read playlist-read-private playlist-read-collaborative";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";

import {
  getTokenStore,
  hasTokenStore,
  localApiHeaders,
  requestOpenLogin,
  waitForBridge,
} from "./bridge";

const LS_CLIENT_ID = "sov:client-id";
const LS_TOKENS = "sov:tokens";
const LS_VERIFIER = "sov:pkce-verifier";
const LS_STATE = "sov:oauth-state";

export type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
};

export class NotLoggedInError extends Error {
  constructor() {
    super("not-logged-in");
    this.name = "NotLoggedInError";
  }
}

/** Thrown when the session is still valid but Spotify couldn't be
 *  reached (network error, timeout, 429, 5xx) — the caller should
 *  retry / back off, NOT route to the Connect screen. Only an
 *  explicit rejection of the refresh token (invalid_grant, HTTP
 *  400/401) becomes NotLoggedInError. */
export class RetryableAuthError extends Error {
  constructor(message = "spotify-unreachable") {
    super(message);
    this.name = "RetryableAuthError";
  }
}

function base64url(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  // A PKCE verifier/state must be unpredictable — a Math.random
  // fallback would weaken the whole login, so fail loudly instead
  // of silently downgrading. crypto.getRandomValues exists in every
  // modern browser and in Electron.
  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw new Error(
      "Secure random numbers are unavailable, so login can't start.",
    );
  }
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomVerifier(): string {
  return base64url(randomBytes(64));
}

function randomState(): string {
  return base64url(randomBytes(16));
}

/* ------------------------------------------------------------------ */
/* SHA-256 (FIPS 180-4), vendored pure JavaScript.                      */
/*                                                                     */
/* The PKCE code_challenge is SHA-256 of the verifier. It used to be  */
/* computed with crypto.subtle.digest — but that promise never settles */
/* in some WebView2 builds, which stuck the login on "Opening          */
/* Spotify…" forever with no error. This implementation is synchronous */
/* and dependency-free, so the login path has no awaited call that can */
/* stall. Verified against Python hashlib (see README).                */
/* ------------------------------------------------------------------ */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const paddedLen = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  padded[paddedLen - 8] = (hi >>> 24) & 0xff;
  padded[paddedLen - 7] = (hi >>> 16) & 0xff;
  padded[paddedLen - 6] = (hi >>> 8) & 0xff;
  padded[paddedLen - 5] = hi & 0xff;
  padded[paddedLen - 4] = (lo >>> 24) & 0xff;
  padded[paddedLen - 3] = (lo >>> 16) & 0xff;
  padded[paddedLen - 2] = (lo >>> 8) & 0xff;
  padded[paddedLen - 1] = lo & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let t = 0; t < 16; t++) {
      const o = off + t * 4;
      w[t] =
        (padded[o]! << 24) |
        (padded[o + 1]! << 16) |
        (padded[o + 2]! << 8) |
        padded[o + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[t]! + w[t]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const hv = hs[i]!;
    out[i * 4] = (hv >>> 24) & 0xff;
    out[i * 4 + 1] = (hv >>> 16) & 0xff;
    out[i * 4 + 2] = (hv >>> 8) & 0xff;
    out[i * 4 + 3] = hv & 0xff;
  }
  return out;
}

function codeChallenge(verifier: string): string {
  return base64url(sha256Bytes(new TextEncoder().encode(verifier)));
}

/* ------------------------------------------------------------------ */
/* Token store                                                         */
/*                                                                     */
/* On desktop the tokens live in Electron safeStorage (encrypted by   */
/* the OS keychain, via IPC to the main process — see bridge.ts        */
/* getTokenStore and main.js sov:tokens-*). In a plain browser tab     */
/* there is no bridge, so they fall back to localStorage. The Client   */
/* ID (a public OAuth client id) and the short-lived PKCE               */
/* verifier/state stay in localStorage in both cases — only the        */
/* tokens move.                                                        */
/*                                                                     */
/* The IPC is async but several callers read tokens synchronously      */
/* (loadStoredTokens, isLoggedIn), so the tokens are held in an        */
/* in-memory cache: loaded once at startup by ensureTokensLoaded(),    */
/* updated on every store, and the sync readers serve the cache.       */
/* ------------------------------------------------------------------ */

/** In-memory token cache: undefined = not loaded yet. */
let cachedTokens: StoredTokens | null | undefined;
let tokensLoadPromise: Promise<StoredTokens | null> | null = null;

function readLocalTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(LS_TOKENS);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<StoredTokens>;
    if (typeof t.access_token !== "string") return null;
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
      expires_at: typeof t.expires_at === "number" ? t.expires_at : 0,
    };
  } catch {
    return null;
  }
}

function removeLocalTokens(): void {
  try {
    localStorage.removeItem(LS_TOKENS);
  } catch {
    // Storage unavailable — nothing to remove.
  }
}

/** Load the tokens into the cache (once). On first run with the new
 *  build, tokens left in localStorage are moved into safeStorage and
 *  removed from localStorage. Never rejects — null when there is no
 *  session. Callers that need tokens must await this before the sync
 *  readers below can see desktop tokens. */
export async function ensureTokensLoaded(): Promise<StoredTokens | null> {
  if (cachedTokens !== undefined) return cachedTokens;
  if (!tokensLoadPromise) {
    tokensLoadPromise = (async () => {
      if (!hasTokenStore()) {
        cachedTokens = readLocalTokens();
        return cachedTokens;
      }
      let stored: StoredTokens | null = null;
      try {
        stored = await getTokenStore().get();
      } catch {
        // IPC failed — fall through to the localStorage copy, if any.
      }
      if (stored) {
        cachedTokens = stored;
        // safeStorage is now the source of truth — drop any stale
        // plain-text copy.
        removeLocalTokens();
        return cachedTokens;
      }
      const legacy = readLocalTokens();
      if (legacy) {
        cachedTokens = legacy;
        try {
          await getTokenStore().set(legacy);
        } catch {
          // Migration failed — keep the localStorage copy as the
          // session (it is removed only after a successful move).
          return cachedTokens;
        }
        removeLocalTokens();
      } else {
        cachedTokens = null;
      }
      return cachedTokens;
    })();
  }
  return tokensLoadPromise;
}

/** Persist tokens to the active backend and update the cache. The
 *  bridge write is awaited when the caller can await; importTokens
 *  and logout fire-and-forget it (the cache is already correct). */
async function persistTokens(t: StoredTokens | null): Promise<void> {
  cachedTokens = t;
  if (hasTokenStore()) {
    try {
      if (t) await getTokenStore().set(t);
      else await getTokenStore().clear();
      return;
    } catch {
      // IPC failed — keep a localStorage copy as a backup so the
      // session survives; it is migrated again on next launch.
    }
  }
  try {
    if (t) localStorage.setItem(LS_TOKENS, JSON.stringify(t));
    else localStorage.removeItem(LS_TOKENS);
  } catch {
    // Storage unavailable — the session just won't persist.
  }
}

/** Sync read from the cache (browser fallback: straight from
 *  localStorage). Returns null on desktop before
 *  ensureTokensLoaded() has run — App awaits that at startup. */
export function loadStoredTokens(): StoredTokens | null {
  if (cachedTokens !== undefined) return cachedTokens;
  if (!hasTokenStore()) {
    cachedTokens = readLocalTokens();
    return cachedTokens;
  }
  return null;
}

async function storeTokens(t: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}): Promise<void> {
  const prev = loadStoredTokens();
  const tokens: StoredTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token ?? "",
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
  await persistTokens(tokens);
}

export function isLoggedIn(): boolean {
  return loadStoredTokens() !== null;
}

/** Force the next getAccessToken() to refresh (used after a 401 from
 *  a data call — the token went stale between the check and the
 *  call). Goes through the token store, never raw localStorage. */
export function invalidateAccessToken(): void {
  const t = loadStoredTokens();
  if (!t) return;
  void persistTokens({ ...t, expires_at: 0 });
}

export function logout(): void {
  cachedTokens = null;
  tokensLoadPromise = null;
  removeLocalTokens();
  localStorage.removeItem(LS_VERIFIER);
  localStorage.removeItem(LS_STATE);
  if (hasTokenStore()) {
    void getTokenStore()
      .clear()
      .catch(() => {
        // Best effort — the local copy is already gone.
      });
  }
}

let cachedClientId: string | null | undefined;

const CONFIG_TIMEOUT_MS = 5000;

/** Fetches /api/config with a hard timeout. Returns the parsed config,
 *  or null when the server doesn't answer in time (e.g. a stale old
 *  sov process holding port 8888, or a WebView2 fetch stall). Never
 *  rejects and never hangs — the caller must not wait forever on it. */
async function fetchConfig(): Promise<{
  clientId?: unknown;
  build?: unknown;
} | null> {
  try {
    const res = await fetch("/api/config", {
      headers: localApiHeaders(),
      signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as { clientId?: unknown; build?: unknown };
  } catch {
    return null;
  }
}

/** The Client ID plus whether the local server answered at all.
 *  `configOk` is false when the /api/config request timed out or
 *  failed — the Connect screen can then say so instead of hanging on
 *  "Checking…". When the server answers but has no Client ID on file,
 *  configOk is true and clientId is null. `build` is the server's build
 *  stamp (null when the server didn't answer), so the footer can prove
 *  which server.py is actually running. */
export async function probeClientId(): Promise<{
  clientId: string | null;
  configOk: boolean;
  build: string | null;
}> {
  let stored: string | null = null;
  try {
    const raw = localStorage.getItem(LS_CLIENT_ID);
    if (raw && raw.trim()) stored = raw.trim();
  } catch {
    // Storage unavailable — fall through to the server.
  }
  const cfg = await fetchConfig();
  const build =
    cfg && typeof cfg.build === "string" && cfg.build.trim()
      ? cfg.build.trim()
      : null;
  if (stored) {
    return { clientId: stored, configOk: true, build };
  }
  if (cfg && typeof cfg.clientId === "string" && cfg.clientId.trim()) {
    return { clientId: cfg.clientId.trim(), configOk: true, build };
  }
  return { clientId: null, configOk: cfg !== null, build };
}

/** The Client ID: localStorage first, then the local server (which reads
 *  ~/.spotify_overlay.json). Returns null when neither has one. */
export async function loadClientId(): Promise<string | null> {
  if (cachedClientId !== undefined) return cachedClientId;
  const { clientId } = await probeClientId();
  cachedClientId = clientId;
  return clientId;
}

export function saveClientId(id: string): void {
  cachedClientId = id.trim();
  try {
    localStorage.setItem(LS_CLIENT_ID, id.trim());
  } catch {
    // Storage unavailable — the ID just won't persist.
  }
}

/** Starts the Spotify login: builds the PKCE pair, stores the verifier,
 *  and opens Spotify's authorize page.
 *
 *  In the desktop window the authorize page opens in the user's real
 *  default browser — never inside the overlay window: typing on
 *  Spotify's login page inside the window freezes the whole
 *  process ("Python is not responding" in the old shell). The verifier/state are handed
 *  to the local server first (POST /api/login-state) so the callback,
 *  which runs in the browser, can finish the exchange; the tokens
 *  come back through GET /api/tokens, which the Connect screen polls.
 *  In a plain browser tab there is no bridge, so it falls back to
 *  navigating in-page (the callback then shares this tab's storage).
 *
 *  Returns "browser" when the login continues in the default browser
 *  (the caller must then poll for the tokens) or "in-window" when the
 *  page navigated away to Spotify.
 *
 *  The only awaited call that can stall is the login-state POST, and
 *  it is capped at 5s — the login can never hang silently again. */
export async function startLogin(
  clientId: string,
): Promise<"browser" | "in-window"> {
  const verifier = randomVerifier();
  const challenge = codeChallenge(verifier);
  const state = randomState();
  try {
    localStorage.setItem(LS_VERIFIER, verifier);
    localStorage.setItem(LS_STATE, state);
  } catch {
    throw new Error("Browser storage is unavailable, so login can't start.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  const url = `${AUTH_URL}?${params}`;
  if (await waitForBridge(1000)) {
    // Hand the verifier to the local server first: the callback runs
    // in the default browser, whose storage doesn't have it.
    let posted = false;
    try {
      const res = await fetch("/api/login-state", {
        method: "POST",
        headers: localApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ verifier, state, client_id: clientId }),
        signal: AbortSignal.timeout(5000),
      });
      posted = res.ok;
    } catch {
      posted = false;
    }
    if (!posted) {
      throw new Error(
        "Couldn't reach the local server — close any old sov window and restart sov.",
      );
    }
    if (requestOpenLogin(url)) return "browser";
    // The bridge vanished mid-call — fall through to in-window login.
  }
  window.location.assign(url);
  return "in-window";
}

/** Tokens the login callback posted to the local server (window mode:
 *  the default browser and the overlay window don't share storage).
 *  Returns null when nothing has arrived yet. Never rejects. */
export async function fetchServerTokens(): Promise<StoredTokens | null> {
  try {
    const res = await fetch("/api/tokens", {
      headers: localApiHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tokens?: unknown };
    const t = data.tokens as Partial<StoredTokens> | null | undefined;
    if (!t || typeof t.access_token !== "string" || !t.access_token) {
      return null;
    }
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
      expires_at: typeof t.expires_at === "number" ? t.expires_at : 0,
    };
  } catch {
    return null;
  }
}

/** Clear the server-side token handoff once the app has saved the
 *  tokens. Best effort — never rejects. */
export async function clearServerTokens(): Promise<void> {
  try {
    await fetch("/api/tokens", {
      method: "DELETE",
      headers: localApiHeaders(),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best effort; a stale handoff expires on the server anyway.
  }
}

/** Save tokens that arrived from the server into this window's
 *  storage, exactly as if the login had finished here. Updates the
 *  in-memory cache synchronously so getAccessToken() can use them
 *  immediately; the safeStorage write runs in the background. */
export function importTokens(t: StoredTokens): void {
  cachedTokens = t;
  void persistTokens(t);
}

/**
 * Exchanges a refresh token for a fresh access token.
 *
 * Logout happens ONLY when Spotify explicitly rejects the refresh
 * token: HTTP 400/401 on the refresh call (invalid_grant and
 * friends). A network error, timeout, 429 or 5xx throws
 * RetryableAuthError instead — the session is kept and the caller
 * retries / backs off rather than routing to the Connect screen.
 */
async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RetryableAuthError(
      "Couldn't reach Spotify to refresh the login.",
    );
  }
  if (res.status === 400 || res.status === 401) {
    // Spotify explicitly rejected the refresh token — the session
    // is dead. (400 is invalid_grant: revoked / expired grant.)
    throw new NotLoggedInError();
  }
  if (!res.ok) {
    // 429 / 5xx / anything else: transient — keep the session.
    throw new RetryableAuthError(
      `Spotify refresh failed (${res.status}) — will retry.`,
    );
  }
  const data = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.access_token !== "string") {
    throw new RetryableAuthError(
      "Spotify's refresh reply had no access token — will retry.",
    );
  }
  await storeTokens({
    access_token: data.access_token,
    refresh_token:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in:
      typeof data.expires_in === "number" ? data.expires_in : undefined,
  });
  return data.access_token;
}

/** One in-flight refresh, shared by every concurrent caller: a
 *  second getAccessToken() while a refresh is running waits on the
 *  same promise instead of firing a second refresh. */
let refreshInFlight: Promise<string> | null = null;

/** A valid access token, refreshing it first when it is stale.
 *  Throws NotLoggedInError only when there is no session or Spotify
 *  explicitly rejected the refresh token; throws
 *  RetryableAuthError when Spotify couldn't be reached, so callers
 *  can retry / back off instead of logging the user out. */
export async function getAccessToken(): Promise<string> {
  const tokens = (await ensureTokensLoaded()) ?? loadStoredTokens();
  if (!tokens) throw new NotLoggedInError();
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const clientId = await loadClientId();
      const current = loadStoredTokens();
      if (!clientId || !current?.refresh_token) {
        logout();
        throw new NotLoggedInError();
      }
      return await refreshAccessToken(clientId, current.refresh_token);
    } catch (e) {
      if (e instanceof NotLoggedInError) logout();
      throw e;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
