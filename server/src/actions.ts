// Spotify Overlay actions.
//
// The overlay is wired straight into the Spotify account connected to
// this Muse (the `spotify` connector): no Client ID, no OAuth in the
// browser, no credentials in the app. Actions run the connector CLI
// (/opt/hatch/bin/spotify-api) through the privileged contracts in
// server/src/privileged.ts and normalize its Partner API JSON into the
// shape the client renders. Lyrics come from LRCLIB, fetched host-side
// through the same privileged channel.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
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

/** Runs one spotify-api command and parses its JSON stdout, if any. */
async function cliJson(ctx: Ctx, args: string[]): Promise<Json | null> {
  const res = await ctx.executePrivileged(privileged.spotifyCli, { args });
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Now playing                                                         */
/* ------------------------------------------------------------------ */

const nowPlayingResponse = z.object({
  connected: z.boolean(),
  hasItem: z.boolean(),
  title: z.string(),
  artists: z.string(),
  album: z.string(),
  imageUrl: z.string().nullable(),
  trackUrl: z.string().nullable(),
  trackUri: z.string(),
  durationMs: z.number(),
  progressMs: z.number(),
  isPlaying: z.boolean(),
  shuffle: z.boolean(),
  repeat: z.enum(["off", "one", "all"]),
  volume: z.number().nullable(),
  deviceName: z.string(),
});

type NowPlaying = z.infer<typeof nowPlayingResponse>;

const EMPTY_PLAYBACK: NowPlaying = {
  connected: false,
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

async function loadNowPlaying(ctx: Ctx): Promise<NowPlaying> {
  const status = await cliJson(ctx, ["status"]);
  if (!status || status.status !== "connected") return EMPTY_PLAYBACK;
  const connected: NowPlaying = { ...EMPTY_PLAYBACK, connected: true };
  const np = await cliJson(ctx, ["now-playing"]);
  if (!np) return connected;
  const item = asRecord(np.item);
  if (!item || !str(item.name)) return connected;
  const creators = Array.isArray(np.creators) ? np.creators : [];
  const artists = creators
    .map((c) => str(asRecord(c)?.name))
    .filter(Boolean)
    .join(", ");
  const repeatRaw = str(np.repeat).toUpperCase();
  return {
    ...connected,
    hasItem: true,
    title: str(item.name),
    artists,
    // The Partner API surface reports no album name, artwork URL, volume
    // or device name — those stay empty/null rather than invented. Cover
    // art is resolved separately by getCoverArt from the track URL.
    trackUrl: str(item.url) || null,
    trackUri: str(item.uri),
    durationMs: num(item.duration_ms),
    progressMs: num(np.progress_ms),
    isPlaying: str(np.playback_status).toUpperCase() === "PLAYING",
    shuffle: np.shuffle === true,
    repeat:
      repeatRaw === "ONE"
        ? "one"
        : repeatRaw === "ALL" || repeatRaw === "TRUE"
          ? "all"
          : "off",
  };
}

/* ------------------------------------------------------------------ */
/* Playback control                                                    */
/* ------------------------------------------------------------------ */

const controlRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("play") }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("next") }),
  z.object({ kind: z.literal("previous") }),
  z.object({ kind: z.literal("seek"), positionMs: z.number() }),
  z.object({ kind: z.literal("volume"), percent: z.number() }),
  z.object({ kind: z.literal("shuffle"), on: z.boolean() }),
  z.object({ kind: z.literal("repeat"), state: z.enum(["off", "one", "all"]) }),
]);

const controlResponse = z.object({ ok: z.boolean(), message: z.string() });

type ControlArgs = z.infer<typeof controlRequest>;

function controlArgv(args: ControlArgs): string[] {
  switch (args.kind) {
    case "play":
      return ["resume"];
    case "pause":
      return ["pause"];
    case "next":
      return ["skip"];
    case "previous":
      return ["previous"];
    case "seek":
      return ["seek", "--position-ms", String(Math.max(0, Math.round(args.positionMs)))];
    case "volume":
      return [
        "set-volume",
        "--volume-percent",
        String(Math.max(0, Math.min(100, Math.round(args.percent)))),
      ];
    case "shuffle":
      return ["set-playback-options", args.on ? "--shuffle" : "--no-shuffle"];
    case "repeat":
      return ["set-playback-options", "--repeat", args.state];
  }
}

function controlErrorMessage(parsed: Json): string {
  const body = asRecord(parsed.body);
  const msg =
    str(body?.message) || str(parsed.error) || str(parsed.message);
  const status = num(parsed.status);
  if (status === 404 || /not found/i.test(msg)) {
    return "No active device — open Spotify on your phone or computer and press play once, then try again.";
  }
  if (/premium/i.test(msg)) {
    return "Playback control needs Spotify Premium.";
  }
  if (/not_connected|not connected/i.test(msg)) {
    return "Spotify isn't connected.";
  }
  return msg || "Spotify refused that — try again in a moment.";
}

/* ------------------------------------------------------------------ */
/* Lyrics (LRCLIB)                                                     */
/* ------------------------------------------------------------------ */

const lyricsRequest = z.object({
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  durationSec: z.number(),
});

const lyricsResponse = z.object({
  found: z.boolean(),
  album: z.string(),
  synced: z.array(z.object({ t: z.number(), text: z.string() })),
  plain: z.string(),
});

type Lyrics = z.infer<typeof lyricsResponse>;

const NO_LYRICS: Lyrics = { found: false, album: "", synced: [], plain: "" };

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

async function lrclibJson(ctx: Ctx, path: string): Promise<unknown> {
  const res = await ctx.executePrivileged(privileged.fetchText, {
    url: `https://lrclib.net${path}`,
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

async function loadLyrics(
  ctx: Ctx,
  args: z.infer<typeof lyricsRequest>,
): Promise<Lyrics> {
  let record: Json | null = null;
  const getParams = new URLSearchParams({
    track_name: args.title,
    artist_name: args.artist,
    duration: String(Math.round(args.durationSec)),
  });
  if (args.album) getParams.set("album_name", args.album);
  const got = asRecord(await lrclibJson(ctx, `/api/get?${getParams}`));
  if (got && (str(got.syncedLyrics) || str(got.plainLyrics))) {
    record = got;
  } else {
    const searchParams = new URLSearchParams({
      track_name: args.title,
      artist_name: args.artist,
    });
    const found = await lrclibJson(ctx, `/api/search?${searchParams}`);
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
  if (!record) return NO_LYRICS;
  const synced = parseLrc(str(record.syncedLyrics));
  const plain = str(record.plainLyrics);
  if (synced.length === 0 && !plain) return NO_LYRICS;
  return { found: true, album: str(record.albumName), synced, plain };
}

/* ------------------------------------------------------------------ */
/* Track results (search + queue share the row shape)                  */
/* ------------------------------------------------------------------ */

const trackResult = z.object({
  title: z.string(),
  artists: z.string(),
  uri: z.string(),
  url: z.string().nullable(),
  durationMs: z.number(),
});

type TrackResult = z.infer<typeof trackResult>;

/** Search items carry title/subtitle/spotify_uri; now-playing-style items
 *  carry name/uri/creators. Accept either shape. */
function parseTrackItem(v: unknown): TrackResult | null {
  const r = asRecord(v);
  if (!r) return null;
  const title = str(r.title) || str(r.name);
  const uri = str(r.spotify_uri) || str(r.uri);
  if (!title || !uri) return null;
  let artists = str(r.subtitle);
  if (!artists && Array.isArray(r.creators)) {
    artists = r.creators
      .map((c) => str(asRecord(c)?.name))
      .filter(Boolean)
      .join(", ");
  }
  if (!artists && Array.isArray(r.artists)) {
    artists = r.artists
      .map((c) => str(asRecord(c)?.name))
      .filter(Boolean)
      .join(", ");
  }
  return {
    title,
    artists,
    uri,
    url: str(r.spotify_url) || str(r.url) || null,
    durationMs: num(r.duration_ms),
  };
}

function parseTrackList(v: unknown): TrackResult[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(parseTrackItem)
    .filter((t): t is TrackResult => t !== null);
}

/* ------------------------------------------------------------------ */
/* Cover art (Spotify oEmbed thumbnail, cached as an owned blob)       */
/* ------------------------------------------------------------------ */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function loadCoverArt(
  ctx: Ctx,
  trackUrl: string,
  trackUri: string,
): Promise<string | null> {
  const trackId = (trackUri.split(":").pop() ?? "").replace(
    /[^A-Za-z0-9]/g,
    "",
  );
  if (!trackId || !trackUrl) return null;
  const key = `covers/${trackId}`;
  try {
    if (await ctx.blobs.head(key)) return await ctx.blobs.getUrl(key);
  } catch {
    // Blob store unavailable — fall through and try the fetch anyway.
  }
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`;
  const meta = await ctx.executePrivileged(privileged.fetchText, {
    url: oembedUrl,
  });
  if (!meta.ok) return null;
  let thumb = "";
  try {
    thumb = str(asRecord(JSON.parse(meta.text))?.thumbnail_url);
  } catch {
    return null;
  }
  if (!thumb) return null;
  const img = await ctx.executePrivileged(privileged.fetchBinary, {
    url: thumb,
  });
  if (!img.ok || !img.base64) return null;
  try {
    await ctx.blobs.put(key, base64ToBytes(img.base64), {
      contentType: img.contentType || "image/jpeg",
    });
    return await ctx.blobs.getUrl(key);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export const Actions = {
  getNowPlaying: defineAction({
    description:
      "Returns the live playback state from the Spotify account connected to this Muse, or connected:false when no account is linked.",
    request: z.object({}),
    response: nowPlayingResponse,
    privileged: [privileged.spotifyCli],
    async handler(ctx): Promise<NowPlaying> {
      return loadNowPlaying(ctx);
    },
  }),

  controlPlayback: defineAction({
    description:
      "Controls playback (play, pause, skip, previous, seek, volume, shuffle, repeat) on the connected Spotify account's active device.",
    request: controlRequest,
    response: controlResponse,
    privileged: [privileged.spotifyCli],
    async handler(ctx, args): Promise<z.infer<typeof controlResponse>> {
      const parsed = await cliJson(ctx, controlArgv(args));
      if (!parsed) {
        return {
          ok: false,
          message: "Spotify didn't respond. Try again in a moment.",
        };
      }
      if (parsed.ok === true) return { ok: true, message: "" };
      return { ok: false, message: controlErrorMessage(parsed) };
    },
  }),

  getLyrics: defineAction({
    description:
      "Fetches synced (preferred) or plain lyrics for a track from LRCLIB.",
    request: lyricsRequest,
    response: lyricsResponse,
    privileged: [privileged.fetchText],
    async handler(ctx, args): Promise<Lyrics> {
      return loadLyrics(ctx, args);
    },
  }),

  getConnectUrl: defineAction({
    description:
      "Returns the Spotify connect link for this Muse when no Spotify account is linked yet, or null when one already is.",
    request: z.object({}),
    response: z.object({ url: z.string().nullable() }),
    privileged: [privileged.spotifyCli],
    async handler(ctx): Promise<{ url: string | null }> {
      const parsed = await cliJson(ctx, ["authorize-url"]);
      if (!parsed) return { url: null };
      return { url: str(parsed.connect_url) || str(parsed.url) || null };
    },
  }),

  getCoverArt: defineAction({
    description:
      "Returns the album cover art for a track (resolved from its Spotify page via the official oEmbed endpoint and cached in blob storage), or null when unavailable.",
    request: z.object({ trackUrl: z.string(), trackUri: z.string() }),
    response: z.object({ imageUrl: z.string().nullable() }),
    privileged: [privileged.fetchText, privileged.fetchBinary],
    async handler(ctx, args): Promise<{ imageUrl: string | null }> {
      return { imageUrl: await loadCoverArt(ctx, args.trackUrl, args.trackUri) };
    },
  }),

  searchTracks: defineAction({
    description:
      "Searches the Spotify catalog for tracks matching a query on the connected account.",
    request: z.object({ query: z.string() }),
    response: z.object({ tracks: z.array(trackResult) }),
    privileged: [privileged.spotifyCli],
    async handler(ctx, args): Promise<{ tracks: TrackResult[] }> {
      const q = args.query.trim();
      if (!q) return { tracks: [] };
      const parsed = await cliJson(ctx, [
        "search",
        "--query",
        q,
        "--search-type",
        "TRACKS",
      ]);
      if (!parsed || parsed.ok !== true) return { tracks: [] };
      const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
      for (const s of sections) {
        const tracks = parseTrackList(asRecord(s)?.items);
        if (tracks.length > 0) return { tracks: tracks.slice(0, 12) };
      }
      return { tracks: [] };
    },
  }),

  getQueue: defineAction({
    description:
      "Returns the upcoming tracks in the connected account's playback queue.",
    request: z.object({}),
    response: z.object({ upcoming: z.array(trackResult) }),
    privileged: [privileged.spotifyCli],
    async handler(ctx): Promise<{ upcoming: TrackResult[] }> {
      const parsed = await cliJson(ctx, ["get-queue"]);
      if (!parsed || parsed.ok !== true) return { upcoming: [] };
      return { upcoming: parseTrackList(parsed.upcoming).slice(0, 20) };
    },
  }),

  playTrack: defineAction({
    description:
      "Starts playing a specific track URI on the connected account's active device (falls back to queueing it and skipping to it).",
    request: z.object({ uri: z.string() }),
    response: controlResponse,
    privileged: [privileged.spotifyCli],
    async handler(ctx, args): Promise<z.infer<typeof controlResponse>> {
      if (!args.uri.startsWith("spotify:")) {
        return { ok: false, message: "That track can't be played." };
      }
      const played = await cliJson(ctx, ["play", "--context-uri", args.uri]);
      if (played?.ok === true) return { ok: true, message: "" };
      // Some devices reject a bare track as a context — queue it and
      // skip forward so it plays next instead.
      const queued = await cliJson(ctx, [
        "add-to-queue",
        "--item-uri",
        args.uri,
      ]);
      if (queued?.ok === true) {
        const skipped = await cliJson(ctx, ["skip"]);
        if (skipped?.ok === true) return { ok: true, message: "" };
        if (skipped) return { ok: false, message: controlErrorMessage(skipped) };
      }
      const err = played ?? queued;
      if (err) return { ok: false, message: controlErrorMessage(err) };
      return {
        ok: false,
        message: "Spotify didn't respond. Try again in a moment.",
      };
    },
  }),

  addToQueue: defineAction({
    description:
      "Adds a track URI to the connected account's playback queue.",
    request: z.object({ uri: z.string() }),
    response: controlResponse,
    privileged: [privileged.spotifyCli],
    async handler(ctx, args): Promise<z.infer<typeof controlResponse>> {
      if (!args.uri.startsWith("spotify:")) {
        return { ok: false, message: "That track can't be queued." };
      }
      const parsed = await cliJson(ctx, [
        "add-to-queue",
        "--item-uri",
        args.uri,
      ]);
      if (!parsed) {
        return {
          ok: false,
          message: "Spotify didn't respond. Try again in a moment.",
        };
      }
      if (parsed.ok === true) return { ok: true, message: "" };
      return { ok: false, message: controlErrorMessage(parsed) };
    },
  }),

  getAppInfo: defineAction({
    description: "Returns this app's name and version for diagnostics.",
    request: z.object({}),
    response: z.object({ name: z.string(), version: z.string() }),
    async handler() {
      return { name: "Spotify Overlay", version: "3.1.0" };
    },
  }),
} satisfies ActionsModule;
