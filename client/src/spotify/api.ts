/**
 * Playback + lyrics client.
 *
 * Everything goes through this artifact's own server actions: the server
 * talks to the Spotify account connected to this Muse (the `spotify`
 * connector) and to LRCLIB. The browser holds no tokens, no Client ID and
 * no credentials — opening the page is the whole setup. Playback control
 * requires an active Spotify device (and Spotify Premium for some
 * commands); failures surface honestly through `PlayerError`.
 */
import { api } from "../api";

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
  /** 0–100 when the source reports it for the active device, else null. */
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
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Reads the full playback state from the connected Spotify account.
 * Throws PlayerError(401) when no Spotify account is connected.
 */
export async function fetchPlayback(): Promise<Playback> {
  const res = await api.getNowPlaying({});
  if (!res.connected) {
    throw new PlayerError(401, "NOT_CONNECTED", "Spotify isn't connected.");
  }
  return {
    hasItem: res.hasItem,
    title: res.title,
    artists: res.artists,
    album: res.album,
    imageUrl: res.imageUrl,
    trackUrl: res.trackUrl,
    trackUri: res.trackUri,
    durationMs: res.durationMs,
    progressMs: res.progressMs,
    isPlaying: res.isPlaying,
    shuffle: res.shuffle,
    repeat: res.repeat,
    volume: res.volume,
    deviceName: res.deviceName,
  };
}

/** The Spotify connect link for this Muse, or null if unavailable. */
export async function fetchConnectUrl(): Promise<string | null> {
  try {
    const res = await api.getConnectUrl({});
    return res.url;
  } catch {
    return null;
  }
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

/** Sends one playback command to the connected account's active device. */
export async function control(action: ControlAction): Promise<void> {
  const res = await api.controlPlayback(action);
  if (!res.ok) {
    throw new PlayerError(
      0,
      "CONTROL_FAILED",
      res.message || "Spotify refused that command.",
    );
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

/** Album cover for the given track (owned blob URL), or null. */
export async function fetchCoverArt(
  trackUrl: string,
  trackUri: string,
): Promise<string | null> {
  try {
    const res = await api.getCoverArt({ trackUrl, trackUri });
    return res.imageUrl;
  } catch {
    return null;
  }
}

/** Catalog search for tracks. Empty array on any failure. */
export async function searchTracks(query: string): Promise<TrackResult[]> {
  try {
    const res = await api.searchTracks({ query });
    return res.tracks;
  } catch {
    return [];
  }
}

/** Upcoming tracks in the playback queue. Empty array on any failure. */
export async function fetchQueue(): Promise<TrackResult[]> {
  try {
    const res = await api.getQueue({});
    return res.upcoming;
  } catch {
    return [];
  }
}

/** Starts playing a track now. Throws PlayerError when Spotify refuses. */
export async function playUri(uri: string): Promise<void> {
  const res = await api.playTrack({ uri });
  if (!res.ok) {
    throw new PlayerError(
      0,
      "PLAY_FAILED",
      res.message || "Spotify refused to play that track.",
    );
  }
}

/** Adds a track to the playback queue. Throws PlayerError on refusal. */
export async function addToQueue(uri: string): Promise<void> {
  const res = await api.addToQueue({ uri });
  if (!res.ok) {
    throw new PlayerError(
      0,
      "QUEUE_FAILED",
      res.message || "Spotify refused to queue that track.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lyrics via the getLyrics action (LRCLIB, fetched server-side)       */
/* ------------------------------------------------------------------ */

export type LyricLine = { t: number; text: string };
export type Lyrics = {
  found: boolean;
  synced: LyricLine[];
  plain: string;
};

/** Fetches synced (preferred) or plain lyrics for a track from LRCLIB. */
export async function fetchLyrics(
  title: string,
  artist: string,
  album: string,
  durationSec: number,
): Promise<Lyrics> {
  try {
    const res = await api.getLyrics({ title, artist, album, durationSec });
    return { found: res.found, synced: res.synced, plain: res.plain };
  } catch {
    return { found: false, synced: [], plain: "" };
  }
}
