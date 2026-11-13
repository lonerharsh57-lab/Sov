/**
 * Playback + lyrics client for the standalone app.
 *
 * Everything goes straight to the Spotify Web API from the browser with
 * the PKCE access token from ./auth (encrypted in Electron safeStorage
 * on desktop, localStorage in a plain browser tab). No Client ID,
 * token or secret is baked into the app.
 * Lyrics come from LRCLIB, fetched directly by the browser.
 * Failures surface honestly through `PlayerError`.
 */
import {
  getAccessToken,
  invalidateAccessToken,
  logout,
  NotLoggedInError,
  RetryableAuthError,
} from "./auth";
import { fetchLyricsViaMain, hasMainLyrics } from "./bridge";

const API = "https://api.spotify.com/v1";

export type RepeatState = "off" | "one" | "all";

export type Playback = {
  hasItem: boolean;
  title: string;
  artists: string;
  album: string;
  imageUrl: string | null;
  trackUrl: string | null;
  trackUri: string;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatState;
  /** 0–100 when the player reports it for the active device, else null. */
  volume: number | null;
  deviceName: string;
};

export const EMPTY_PLAYBACK: Playback = {
  hasItem: false,
  title: "",
  artists: "",
  album: "",
  imageUrl: null,
  trackUrl: null,
  trackUri: "",
  durationMs: 0,
  progressMs: 0,
  isPlaying: false,
  shuffle: false,
  repeat: "off",
  volume: null,
  deviceName: "",
};

export class PlayerError extends Error {
  readonly status: number;
  readonly reason: string;
  /** Seconds Spotify asked us to wait (429 Retry-After), if any. */
  readonly retryAfterSeconds?: number;
  constructor(
    status: number,
    reason: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.status = status;
    this.reason = reason;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rate-limit backoff                                                  */
/*                                                                     */
/* When Spotify answers 429, noteRateLimit() records a backoff-until   */
/* timestamp from the Retry-After header (5s when the header is        */
/* missing). spotifyFetch refuses to send anything while the backoff   */
/* is running — it throws PlayerError(429) immediately instead of      */
/* hammering — and the polling queries in App.tsx read                 */
/* getRateLimitDelayMs() to stretch their next interval past it.       */
/* ------------------------------------------------------------------ */

let rateLimitedUntil = 0;
let lastRetryAfterSeconds = 0;

/** Milliseconds until the current rate-limit backoff ends (0 when
 *  not backing off). */
export function getRateLimitDelayMs(): number {
  return Math.max(0, rateLimitedUntil - Date.now());
}

function noteRateLimit(res: Response): number {
  const raw = res.headers.get("Retry-After");
  const secs = raw ? Number(raw) : NaN;
  const retryAfter =
    Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : 5;
  rateLimitedUntil = Date.now() + retryAfter * 1000;
  lastRetryAfterSeconds = retryAfter;
  return retryAfter;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Json)
    : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * One authenticated request to the Web API. Refreshes the token once on
 * a 401 and retries. Throws PlayerError(401) when there is no session,
 * PlayerError(404) with a plain message when there is no active device.
 * A network failure never logs the user out: it throws
 * PlayerError(0, "NETWORK_ERROR" | "RETRYABLE") instead, so the
 * caller can retry rather than routing to the Connect screen. A 429
 * starts a backoff (see noteRateLimit) and throws PlayerError(429)
 * carrying the Retry-After seconds.
 */
async function spotifyFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  // Backing off after a 429: refuse to send anything until it ends.
  const backoffMs = getRateLimitDelayMs();
  if (backoffMs > 0) {
    throw new PlayerError(
      429,
      "RATE_LIMITED",
      "Spotify is rate-limiting requests — backing off.",
      lastRetryAfterSeconds || Math.ceil(backoffMs / 1000),
    );
  }
  const tokenError = (e: unknown): Error => {
    if (e instanceof NotLoggedInError) {
      return new PlayerError(401, "NOT_CONNECTED", "Spotify isn't connected.");
    }
    if (e instanceof RetryableAuthError) {
      return new PlayerError(
        0,
        "RETRYABLE",
        e.message || "Couldn't reach Spotify — will retry.",
      );
    }
    return e instanceof Error ? e : new Error("Unknown auth error.");
  };
  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    throw tokenError(e);
  }
  const doFetch = (t: string) =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  const fetchOrNetworkError = async (t: string): Promise<Response> => {
    try {
      return await doFetch(t);
    } catch {
      throw new PlayerError(
        0,
        "NETWORK_ERROR",
        "Couldn't reach Spotify — check your connection.",
      );
    }
  };
  let res = await fetchOrNetworkError(token);
  if (res.status === 429) {
    const retryAfter = noteRateLimit(res);
    throw new PlayerError(
      429,
      "RATE_LIMITED",
      "Spotify is rate-limiting requests — backing off.",
      retryAfter,
    );
  }
  if (res.status === 401) {
    // Token went stale between the check and the call — force a refresh
    // by clearing the cached expiry (through the token store), then
    // retry once.
    invalidateAccessToken();
    try {
      token = await getAccessToken();
    } catch (e) {
      throw tokenError(e);
    }
    res = await fetchOrNetworkError(token);
    if (res.status === 429) {
      const retryAfter = noteRateLimit(res);
      throw new PlayerError(
        429,
        "RATE_LIMITED",
        "Spotify is rate-limiting requests — backing off.",
        retryAfter,
      );
    }
  }
  if (res.status === 401) {
    // Spotify rejected the refreshed token too — that IS an explicit
    // rejection, so the session is dead.
    logout();
    throw new PlayerError(401, "NOT_CONNECTED", "Spotify isn't connected.");
  }
  return res;
}

async function spotifyJson(path: string, init?: RequestInit): Promise<Json | null> {
  const res = await spotifyFetch(path, init);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Like spotifyJson, but throws PlayerError (with the HTTP status) when
 *  Spotify refuses — so a 403 (missing scope) or a 429/5xx never
 *  degrades silently into "nothing playing". Callers that must tell a
 *  token/scope problem apart from "no playback" use this one. */
async function spotifyJsonOrThrow(
  path: string,
  init?: RequestInit,
): Promise<Json | null> {
  const res = await spotifyFetch(path, init);
  if (res.status === 204) return null;
  let body: Json | null = null;
  try {
    body = asRecord(JSON.parse(await res.text()));
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = str(asRecord(body?.error)?.message);
    throw new PlayerError(
      res.status,
      res.status === 403 ? "INSUFFICIENT_SCOPE" : "SPOTIFY_ERROR",
      msg || `Spotify refused that (${res.status}).`,
    );
  }
  return body;
}

function controlErrorMessage(res: Response, body: Json | null): string {
  const err = asRecord(body?.error);
  const msg = str(err?.message);
  if (res.status === 404 || /no active device/i.test(msg)) {
    return "No active device — open Spotify and press play once, then try again.";
  }
  if (res.status === 403 || /premium/i.test(msg)) {
    return "Playback control needs Spotify Premium.";
  }
  return msg || "Spotify refused that — try again in a moment.";
}

/** Runs one control call; throws PlayerError with a plain message. */
async function controlCall(path: string, init?: RequestInit): Promise<void> {
  let res: Response;
  try {
    res = await spotifyFetch(path, init);
  } catch (e) {
    if (e instanceof PlayerError) throw e;
    throw new PlayerError(0, "CONTROL_FAILED", "Couldn't reach Spotify.");
  }
  if (res.ok) return;
  let body: Json | null = null;
  try {
    body = asRecord(JSON.parse(await res.text()));
  } catch {
    body = null;
  }
  throw new PlayerError(
    res.status,
    "CONTROL_FAILED",
    controlErrorMessage(res, body),
  );
}

/* ------------------------------------------------------------------ */
/* Now playing                                                         */
/* ------------------------------------------------------------------ */

/** Last playback result, so cover art can be served without a second
 *  request (the Web API already returns the art with the track). */
let lastPlayback: Playback | null = null;

/** Reads the full playback state from the Spotify Web API.
 *  Throws PlayerError(401) when no Spotify account is connected. */
export async function fetchPlayback(): Promise<Playback> {
  // Status-aware: a 403/429/5xx must surface as an error (the player
  // then offers a reconnect), never silently become "Nothing playing".
  const data = await spotifyJsonOrThrow("/me/player");
  if (!data) return { ...EMPTY_PLAYBACK };
  const item = asRecord(data.item);
  if (!item || !str(item.name)) return { ...EMPTY_PLAYBACK };
  const artists = Array.isArray(item.artists)
    ? item.artists
        .map((a) => str(asRecord(a)?.name))
        .filter(Boolean)
        .join(", ")
    : "";
  const albumImages = asRecord(item.album)?.images;
  const images = Array.isArray(albumImages) ? albumImages : [];
  // Spotify lists images largest first; the ~300px one suits the panel.
  let imageUrl: string | null = null;
  for (const img of images) {
    const rec = asRecord(img);
    const url = rec ? str(rec.url) : "";
    const width = rec ? num(rec.width) : 0;
    if (url && width >= 200 && width <= 400) {
      imageUrl = url;
      break;
    }
  }
  if (!imageUrl && images.length > 0) {
    const first = asRecord(images[0]);
    imageUrl = first ? str(first.url) || null : null;
    if (!imageUrl && images.length > 1) {
      const second = asRecord(images[1]);
      imageUrl = second ? str(second.url) || null : null;
    }
  }
  const device = asRecord(data.device);
  const repeatRaw = str(data.repeat_state);
  const playback: Playback = {
    hasItem: true,
    title: str(item.name),
    artists,
    album: str(asRecord(item.album)?.name),
    imageUrl,
    trackUrl: str(asRecord(item.external_urls)?.spotify) || null,
    trackUri: str(item.uri),
    durationMs: num(item.duration_ms),
    progressMs: num(data.progress_ms),
    isPlaying: data.is_playing === true,
    shuffle: data.shuffle_state === true,
    repeat:
      repeatRaw === "track"
        ? "one"
        : repeatRaw === "context"
          ? "all"
          : "off",
    volume: device && device.volume_percent != null ? num(device.volume_percent) : null,
    deviceName: device ? str(device.name) : "",
  };
  lastPlayback = playback;
  return playback;
}

export type ControlAction =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "seek"; positionMs: number }
  | { kind: "volume"; percent: number }
  | { kind: "shuffle"; on: boolean }
  | { kind: "repeat"; state: RepeatState };

/** Sends one playback command to the active Spotify device. */
export async function control(action: ControlAction): Promise<void> {
  switch (action.kind) {
    case "play":
      try {
        await controlCall("/me/player/play", { method: "PUT" });
      } catch (e) {
        // No active device: hand playback to the best available device
        // (e.g. the Spotify desktop app, if it is open) and try again
        // instead of just reporting "no active device" and doing nothing.
        if (
          e instanceof PlayerError &&
          (e.status === 404 || /no active device/i.test(e.message))
        ) {
          await playOnBestDevice();
          await controlCall("/me/player/play", { method: "PUT" });
          return;
        }
        throw e;
      }
      return;
    case "pause":
      await controlCall("/me/player/pause", { method: "PUT" });
      return;
    case "next":
      await controlCall("/me/player/next", { method: "POST" });
      return;
    case "previous":
      await controlCall("/me/player/previous", { method: "POST" });
      return;
    case "seek":
      await controlCall(
        `/me/player/seek?position_ms=${Math.max(0, Math.round(action.positionMs))}`,
        { method: "PUT" },
      );
      return;
    case "volume":
      await controlCall(
        `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(action.percent)))}`,
        { method: "PUT" },
      );
      return;
    case "shuffle":
      await controlCall(`/me/player/shuffle?state=${action.on}`, {
        method: "PUT",
      });
      return;
    case "repeat": {
      const state =
        action.state === "one"
          ? "track"
          : action.state === "all"
            ? "context"
            : "off";
      await controlCall(`/me/player/repeat?state=${state}`, {
        method: "PUT",
      });
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cover art, search, queue                                            */
/* ------------------------------------------------------------------ */

export type TrackResult = {
  title: string;
  artists: string;
  uri: string;
  url: string | null;
  durationMs: number;
};

function parseTrackItem(v: unknown): TrackResult | null {
  const r = asRecord(v);
  if (!r) return null;
  const title = str(r.name);
  const uri = str(r.uri);
  if (!title || !uri) return null;
  const artists = Array.isArray(r.artists)
    ? r.artists
        .map((a) => str(asRecord(a)?.name))
        .filter(Boolean)
        .join(", ")
    : "";
  return {
    title,
    artists,
    uri,
    url: str(asRecord(r.external_urls)?.spotify) || null,
    durationMs: num(r.duration_ms),
  };
}

/** Album cover for the current track — the Web API returns it with the
 *  now-playing state, so this just reuses that (null when unknown). */
export async function fetchCoverArt(
  _trackUrl: string,
  _trackUri: string,
): Promise<string | null> {
  return lastPlayback?.imageUrl ?? null;
}

/** Catalog search for tracks. Empty array on any failure. */
export async function searchTracks(query: string): Promise<TrackResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const data = await spotifyJson(
      `/search?q=${encodeURIComponent(q)}&type=track&limit=12`,
    );
    const tracks = asRecord(data?.tracks);
    const items = tracks && Array.isArray(tracks.items) ? tracks.items : [];
    return items
      .map(parseTrackItem)
      .filter((t): t is TrackResult => t !== null);
  } catch {
    return [];
  }
}

/** Upcoming tracks in the playback queue. Empty array on any failure. */
export async function fetchQueue(): Promise<TrackResult[]> {
  try {
    const data = await spotifyJson("/me/player/queue");
    const items = Array.isArray(data?.queue) ? data.queue : [];
    return items
      .map(parseTrackItem)
      .filter((t): t is TrackResult => t !== null)
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** Starts playing a track now. Throws PlayerError when Spotify refuses. */
export async function playUri(uri: string): Promise<void> {
  if (!uri.startsWith("spotify:")) {
    throw new PlayerError(0, "PLAY_FAILED", "That track can't be played.");
  }
  try {
    await controlCall("/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ uris: [uri] }),
    });
    return;
  } catch (e) {
    // No active device — hand playback to the best available device
    // (e.g. the Spotify desktop app) and try once more before giving up.
    if (
      e instanceof PlayerError &&
      (e.status === 404 || /no active device/i.test(e.message))
    ) {
      try {
        await playOnBestDevice();
        await controlCall("/me/player/play", {
          method: "PUT",
          body: JSON.stringify({ uris: [uri] }),
        });
        return;
      } catch {
        throw e;
      }
    }
    // Some devices reject a bare track as a context — queue it and skip
    // forward so it plays next instead.
    try {
      await addToQueue(uri);
      await controlCall("/me/player/next", { method: "POST" });
      return;
    } catch (e2) {
      if (e2 instanceof PlayerError) throw e2;
      if (e instanceof PlayerError) throw e;
      throw new PlayerError(0, "PLAY_FAILED", "Spotify refused to play that track.");
    }
  }
}

/** Adds a track to the playback queue. Throws PlayerError on refusal. */
export async function addToQueue(uri: string): Promise<void> {
  if (!uri.startsWith("spotify:")) {
    throw new PlayerError(0, "QUEUE_FAILED", "That track can't be queued.");
  }
  await controlCall(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
    method: "POST",
  });
}

/* ------------------------------------------------------------------ */
/* Account, devices, and "play even with no active device"             */
/* ------------------------------------------------------------------ */

export type Profile = { displayName: string; id: string };

/** The Spotify account this token belongs to — shown in the footer so
 *  a wrong-account mismatch is obvious. Throws PlayerError on refusal. */
export async function fetchProfile(): Promise<Profile> {
  const data = await spotifyJsonOrThrow("/me");
  return {
    displayName: str(data?.display_name) || str(data?.id) || "Spotify",
    id: str(data?.id),
  };
}

export type Device = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
};

/** Devices Spotify knows about for this account. Empty array on any
 *  failure except auth problems (those throw, so the caller can route
 *  to reconnect instead of pretending there is simply no device). */
export async function fetchDevices(): Promise<Device[]> {
  try {
    const data = await spotifyJsonOrThrow("/me/player/devices");
    const items = Array.isArray(data?.devices) ? data.devices : [];
    return items
      .map((v) => {
        const r = asRecord(v);
        if (!r || !str(r.id)) return null;
        return {
          id: str(r.id),
          name: str(r.name) || "Spotify device",
          type: str(r.type),
          isActive: r.is_active === true,
        } as Device;
      })
      .filter((d): d is Device => d !== null);
  } catch (e) {
    if (e instanceof PlayerError && e.status === 401) throw e;
    return [];
  }
}

/** Hands playback to one device (and starts it). Throws PlayerError. */
export async function transferPlayback(deviceId: string): Promise<void> {
  await controlCall("/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play: true }),
  });
}

/** Picks the best available device: the active one, else the Spotify
 *  desktop app (type Computer), else the first one. Null when Spotify
 *  knows no device at all. */
export function pickBestDevice(devices: Device[]): Device | null {
  if (devices.length === 0) return null;
  return (
    devices.find((d) => d.isActive) ??
    devices.find((d) => d.type === "Computer") ??
    devices[0] ??
    null
  );
}

/** Transfer playback to the best available device, then play.
 *  Throws PlayerError when there is no device to transfer to. */
export async function playOnBestDevice(): Promise<void> {
  const devices = await fetchDevices();
  const best = pickBestDevice(devices);
  if (!best) {
    throw new PlayerError(
      404,
      "NO_DEVICE",
      "No Spotify device found — open Spotify and press play once.",
    );
  }
  await transferPlayback(best.id);
}

/* ------------------------------------------------------------------ */
/* Library — Liked Songs + Playlists                                   */
/* ------------------------------------------------------------------ */

export type LibraryResult = {
  tracks: TrackResult[];
  total: number;
};

/** The user's Liked Songs, newest first. Throws PlayerError(403,
 *  INSUFFICIENT_SCOPE) when the token lacks user-library-read — the
 *  caller must offer a reconnect instead of showing an empty list. */
export async function fetchLikedSongs(
  limit = 50,
  offset = 0,
): Promise<LibraryResult> {
  const data = await spotifyJsonOrThrow(
    `/me/tracks?limit=${limit}&offset=${offset}`,
  );
  const items = Array.isArray(data?.items) ? data.items : [];
  const tracks = items
    .map((v) => parseTrackItem(asRecord(v)?.track))
    .filter((t): t is TrackResult => t !== null);
  return { tracks, total: num(data?.total) };
}

export type PlaylistResult = {
  name: string;
  uri: string;
  id: string;
  owner: string;
  trackCount: number;
  imageUrl: string | null;
};

/** The user's playlists. Same 403 handling as Liked Songs. */
export async function fetchPlaylists(): Promise<PlaylistResult[]> {
  const data = await spotifyJsonOrThrow("/me/playlists?limit=50");
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .map((v) => {
      const r = asRecord(v);
      if (!r) return null;
      const name = str(r.name);
      const uri = str(r.uri);
      if (!name || !uri) return null;
      const images = Array.isArray(r.images) ? r.images : [];
      const first = asRecord(images[0]);
      return {
        name,
        uri,
        id: str(r.id),
        owner: str(asRecord(r.owner)?.display_name),
        trackCount: num(asRecord(r.tracks)?.total),
        imageUrl: first ? str(first.url) || null : null,
      } as PlaylistResult;
    })
    .filter((p): p is PlaylistResult => p !== null);
}

/** The track id inside a `spotify:track:<id>` URI, or null. */
export function trackIdFromUri(uri: string): string | null {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri.trim());
  return m ? m[1] ?? null : null;
}

/** Whether a track is in the user's Liked Songs. Throws
 *  PlayerError(403, INSUFFICIENT_SCOPE) when the token lacks
 *  user-library-read — the caller must offer a reconnect. */
export async function fetchTrackLiked(id: string): Promise<boolean> {
  const res = await spotifyFetch(
    `/me/tracks/contains?ids=${encodeURIComponent(id)}`,
  );
  if (res.status === 403) {
    throw new PlayerError(
      403,
      "INSUFFICIENT_SCOPE",
      "Liking needs library access — reconnect Spotify once to allow it.",
    );
  }
  if (!res.ok) {
    throw new PlayerError(
      res.status,
      "SPOTIFY_ERROR",
      `Spotify refused that (${res.status}).`,
    );
  }
  try {
    const arr: unknown = await res.json();
    return Array.isArray(arr) && arr[0] === true;
  } catch {
    return false;
  }
}

async function saveTrackCall(id: string, method: "PUT" | "DELETE"): Promise<void> {
  const res = await spotifyFetch(
    `/me/tracks?ids=${encodeURIComponent(id)}`,
    { method },
  );
  if (res.status === 403) {
    throw new PlayerError(
      403,
      "INSUFFICIENT_SCOPE",
      "Liking needs library access — reconnect Spotify once to allow it.",
    );
  }
  if (!res.ok) {
    throw new PlayerError(
      res.status,
      "SPOTIFY_ERROR",
      `Spotify refused that (${res.status}).`,
    );
  }
}

/** Save a track to the library (Liked Songs). Throws PlayerError. */
export async function likeTrack(id: string): Promise<void> {
  await saveTrackCall(id, "PUT");
}

/** Remove a track from the library (Liked Songs). Throws PlayerError. */
export async function unlikeTrack(id: string): Promise<void> {
  await saveTrackCall(id, "DELETE");
}

/** Starts playing a whole playlist (context). Throws PlayerError. */
export async function playContext(uri: string): Promise<void> {
  if (!uri.startsWith("spotify:")) {
    throw new PlayerError(0, "PLAY_FAILED", "That playlist can't be played.");
  }
  try {
    await controlCall("/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ context_uri: uri }),
    });
  } catch (e) {
    if (
      e instanceof PlayerError &&
      (e.status === 404 || /no active device/i.test(e.message))
    ) {
      await playOnBestDevice();
      await controlCall("/me/player/play", {
        method: "PUT",
        body: JSON.stringify({ context_uri: uri }),
      });
      return;
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Lyrics via LRCLIB, fetched directly by the browser                 */
/* ------------------------------------------------------------------ */

export type LyricLine = { t: number; text: string };
export type Lyrics = {
  found: boolean;
  synced: LyricLine[];
  plain: string;
};

const LRC_TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

function parseLrc(text: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const line of text.split("\n")) {
    const tags = [...line.matchAll(LRC_TAG)];
    if (tags.length === 0) continue;
    const lyric = line.replace(LRC_TAG, "").trim();
    for (const m of tags) {
      out.push({ t: Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0), text: lyric });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function lrclibJson(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`https://lrclib.net${path}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Fetches synced (preferred) or plain lyrics for a track from LRCLIB.
 *  Prefers the main-process fetch (proper User-Agent + 30-day disk
 *  cache) when the desktop bridge offers it, and falls back to the
 *  direct browser fetch otherwise. `offsetMs` shifts every synced
 *  line time (positive = lyrics later, e.g. +500ms); lines never go
 *  below 0s. */
export async function fetchLyrics(
  title: string,
  artist: string,
  album: string,
  durationSec: number,
  offsetMs = 0,
): Promise<Lyrics> {
  const noLyrics: Lyrics = { found: false, synced: [], plain: "" };
  let record: Json | null = null;
  if (hasMainLyrics()) {
    // The bridge exists, so the main process owns the lookup: a null
    // here means it searched and found nothing — do not re-fetch
    // directly (that would hit LRCLIB twice for every miss).
    const viaMain = await fetchLyricsViaMain({
      title,
      artist,
      album,
      durationSec,
    });
    if (viaMain && (str(viaMain.syncedLyrics) || str(viaMain.plainLyrics))) {
      record = viaMain as unknown as Json;
    } else {
      return noLyrics;
    }
  }
  if (!record) {
    const getParams = new URLSearchParams({
      track_name: title,
      artist_name: artist,
      duration: String(Math.round(durationSec)),
    });
    if (album) getParams.set("album_name", album);
    const got = asRecord(await lrclibJson(`/api/get?${getParams}`));
    if (got && (str(got.syncedLyrics) || str(got.plainLyrics))) {
      record = got;
    } else {
      const searchParams = new URLSearchParams({
        track_name: title,
        artist_name: artist,
      });
      const found = await lrclibJson(`/api/search?${searchParams}`);
      if (Array.isArray(found)) {
        for (const r of found) {
          const rec = asRecord(r);
          if (rec && (str(rec.syncedLyrics) || str(rec.plainLyrics))) {
            record = rec;
            break;
          }
        }
      }
    }
  }
  if (!record) return noLyrics;
  const offsetSec = offsetMs / 1000;
  const synced = parseLrc(str(record.syncedLyrics))
    .map((line) => ({ t: Math.max(0, line.t + offsetSec), text: line.text }))
    .sort((a, b) => a.t - b.t);
  const plain = str(record.plainLyrics);
  if (synced.length === 0 && !plain) return noLyrics;
  return { found: true, synced, plain };
}
