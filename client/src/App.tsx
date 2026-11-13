import {
useCallback,
useEffect,
useLayoutEffect,
useMemo,
useRef,
useState,
type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
addToQueue,
control,
fetchConnectUrl,
fetchCoverArt,
fetchLyrics,
fetchPlayback,
fetchQueue,
playUri,
PlayerError,
searchTracks,
type Playback,
type RepeatState,
type TrackResult,
} from "./spotify/api";
import { api } from "./api";

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Icon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

const PATHS = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  next: "M6 6l8.5 6L6 18V6zm10 0h2v12h-2z",
  prev: "M8 6H6v12h2V6zm10 0l-8.5 6L18 18V6z",
  shuffle:
    "M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.83-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
  repeat:
    "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  volume:
    "M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z",
  note: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z",
  shrink:
    "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  lyrics: "M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z",
  search:
    "M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z",
  queue: "M3 5h13v2.2H3zM3 10.9h13V13H3zM3 16.8h9V19H3zM16 15.5v7l6-3.5z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  external:
    "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
};

/** The glowing ring — canvas-animated, breathes and sheds sparks while playing. */
function RingCanvas({
  size,
  playing,
  fraction,
}: {
  size: number;
  playing: boolean;
  fraction: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef({ playing, fraction });
  liveRef.current = { playing, fraction };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    type Spark = { a: number; r: number; sp: number; life: number; max: number };
    const sparks: Spark[] = [];
    let raf = 0;
    let t = Math.random() * 100;
    const draw = () => {
      const { playing: isPlaying, fraction: frac } = liveRef.current;
      t += reduced ? 0 : isPlaying ? 0.016 : 0.004;
      const w = size;
      const cx = w / 2;
      const cy = w / 2;
      const baseR = w * 0.33;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, w);
      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.4, cx, cy, baseR * 1.55);
      halo.addColorStop(0, isPlaying ? "rgba(255,232,26,0.15)" : "rgba(255,232,26,0.05)");
      halo.addColorStop(1, "rgba(255,232,26,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, w);
      const amp = isPlaying && !reduced ? w * 0.022 : w * 0.006;
      ctx.beginPath();
      for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * Math.PI * 2;
        const r =
          baseR +
          Math.sin(a * 3 + t * 2) * amp +
          Math.sin(a * 5 - t * 3.1) * amp * 0.7 +
          Math.sin(a * 2 + t) * amp * 0.5;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = "#ffe81a";
      ctx.lineWidth = Math.max(2, w * 0.045);
      ctx.shadowColor = "rgba(255,232,26,0.85)";
      ctx.shadowBlur = isPlaying ? w * 0.16 : w * 0.07;
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (frac > 0.001) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + w * 0.08, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = "#1ed760";
        ctx.lineWidth = Math.max(1.5, w * 0.028);
        ctx.lineCap = "round";
        ctx.stroke();
      }
      if (isPlaying && !reduced && Math.random() < 0.25 && sparks.length < 26) {
        sparks.push({
          a: Math.random() * Math.PI * 2,
          r: baseR,
          sp: 0.25 + Math.random() * 0.5,
          life: 0,
          max: 40 + Math.random() * 40,
        });
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        if (!s) continue;
        s.life += 1;
        s.r += s.sp;
        s.a += 0.004;
        const alpha = 1 - s.life / s.max;
        if (alpha <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(cx + Math.cos(s.a) * s.r, cy + Math.sin(s.a) * s.r, Math.max(0.8, w * 0.014), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,232,26,${(alpha * 0.8).toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Apple Music–style synced lyrics                                     */
/* ------------------------------------------------------------------ */

const LYRICS_H = 232;

function LyricsView({
  playback,
  currentMs,
  onSeek,
  height = LYRICS_H,
}: {
  playback: Playback;
  currentMs: number;
  onSeek: (ms: number) => void;
  height?: number;
}) {
  const firstArtist = playback.artists.split(",")[0]?.trim() ?? "";
  const query = useQuery({
    queryKey: ["lyrics", playback.title, firstArtist],
    queryFn: () =>
      fetchLyrics(
        playback.title,
        firstArtist,
        playback.album,
        playback.durationMs / 1000,
      ),
    enabled: playback.hasItem,
    staleTime: 5 * 60_000,
  });

  const lines = useMemo(() => query.data?.synced ?? [], [query.data]);
  const currentSec = currentMs / 1000;
  const active = useMemo(() => {
    let idx = -1;
    const t = currentSec + 0.25;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i]?.t ?? Infinity) <= t) idx = i;
      else break;
    }
    return idx;
  }, [lines, currentSec]);

  const trackRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<{ tops: number[]; heights: number[] }>({
    tops: [],
    heights: [],
  });
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const tops: number[] = [];
    const heights: number[] = [];
    for (const child of Array.from(track.children)) {
      const el = child as HTMLElement;
      tops.push(el.offsetTop);
      heights.push(el.offsetHeight);
    }
    setGeom({ tops, heights });
  }, [lines]);

  if (query.isPending) {
    return (
      <div style={{ height }} className="grid place-items-center">
        <p className="text-sm text-[var(--dim)]">Loading lyrics…</p>
      </div>
    );
  }
  if (!query.data?.found) {
    return (
      <div style={{ height }} className="grid place-items-center px-4">
        <p className="text-center text-sm text-[var(--dim)]">
          No lyrics found for this song.
        </p>
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div
        style={{ maxHeight: height }}
        className="overflow-y-auto px-1 py-2"
      >
        <p className="whitespace-pre-line text-[15px] leading-7 text-[var(--dim)]">
          {query.data.plain}
        </p>
      </div>
    );
  }

  const target = Math.max(active, 0);
  const top = geom.tops[target] ?? 0;
  const lineHeight = geom.heights[target] ?? 28;
  const y = height / 2 - (top + lineHeight / 2);

  return (
    <div
      style={{ height }}
      className="relative overflow-hidden"
      aria-label="Synced lyrics"
    >
      <div
        ref={trackRef}
        className="lyrics-track absolute inset-x-0 top-0"
        style={{ transform: `translateY(${y}px)` }}
      >
        {lines.map((line, i) => {
          const d = Math.abs(i - active);
          const isActive = i === active;
          const style = isActive
            ? { opacity: 1, filter: "none", fontSize: 21, fontWeight: 700 as const, color: "#ffffff" }
            : d === 1
              ? { opacity: 0.55, filter: "none", fontSize: 17, fontWeight: 600 as const, color: "#f4f6f3" }
              : d === 2
                ? { opacity: 0.34, filter: "blur(0.4px)", fontSize: 17, fontWeight: 600 as const, color: "#f4f6f3" }
                : { opacity: 0.2, filter: "blur(0.8px)", fontSize: 17, fontWeight: 600 as const, color: "#f4f6f3" };
          return (
            <button
              key={`${line.t}-${i}`}
              type="button"
              className="lyric-line block w-full py-1.5 text-left leading-snug"
              style={style}
              aria-label={`Play from: ${line.text || "instrumental break"}`}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSeek(line.t * 1000)}
            >
              {line.text || "♪"}
            </button>
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[rgba(16,19,22,0.95)] to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[rgba(16,19,22,0.95)] to-transparent" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Queue + search sections (toggle open inside the same-size panel)    */
/* ------------------------------------------------------------------ */

function TrackRow({
  track,
  index,
  onPlay,
  onAdd,
}: {
  track: TrackResult;
  index?: number;
  onPlay: (track: TrackResult) => void;
  onAdd?: (track: TrackResult) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl px-1 py-1 transition hover:bg-[rgba(255,255,255,0.05)]">
      <button
        type="button"
        onClick={() => onPlay(track)}
        aria-label={`Play ${track.title} by ${track.artists}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        {typeof index === "number" && (
          <span className="w-5 flex-none text-center text-xs tabular-nums text-[var(--dim)]">
            {index + 1}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-5">
            {track.title}
          </span>
          <span className="block truncate text-xs leading-4 text-[var(--dim)]">
            {track.artists}
          </span>
        </span>
        <span className="flex-none text-xs tabular-nums text-[var(--dim)]">
          {track.durationMs > 0 ? fmt(track.durationMs) : ""}
        </span>
      </button>
      {onAdd && (
        <button
          type="button"
          onClick={() => onAdd(track)}
          aria-label={`Add ${track.title} to queue`}
          className="grid h-9 w-9 flex-none place-items-center rounded-full text-[var(--dim)] transition hover:bg-[rgba(255,255,255,0.08)] hover:text-white"
        >
          <Icon d={PATHS.plus} size={17} />
        </button>
      )}
    </div>
  );
}

function QueueSection({
  onPlay,
}: {
  onPlay: (track: TrackResult) => void;
}) {
  const queueQuery = useQuery({
    queryKey: ["queue"],
    queryFn: fetchQueue,
    refetchInterval: 5000,
    retry: false,
  });
  const upcoming = queueQuery.data ?? [];
  return (
    <div
      className="h-[190px] overflow-y-auto px-1 py-1"
      aria-label="Up next in queue"
    >
      {queueQuery.isPending ? (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          Loading queue…
        </p>
      ) : upcoming.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm leading-5 text-[var(--dim)]">
          Queue is empty — search for a song and add it, or just press
          play on one.
        </p>
      ) : (
        <>
          <p className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--dim)]">
            Up next
          </p>
          {upcoming.map((t, i) => (
            <TrackRow
              key={`${t.uri}-${i}`}
              track={t}
              index={i}
              onPlay={onPlay}
            />
          ))}
        </>
      )}
    </div>
  );
}

function SearchSection({
  onPlay,
  onAdd,
}: {
  onPlay: (track: TrackResult) => void;
  onAdd: (track: TrackResult) => void;
}) {
  const [value, setValue] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value.trim()), 400);
    return () => clearTimeout(id);
  }, [value]);
  const searchQuery = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchTracks(debounced),
    enabled: debounced.length > 1,
    staleTime: 30_000,
    retry: false,
  });
  const results = searchQuery.data ?? [];
  return (
    <div aria-label="Search Spotify">
      <div className="px-1 pb-1">
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search songs…"
          aria-label="Search songs"
          className="h-10 w-full rounded-full border border-[var(--border)] bg-[rgba(255,255,255,0.06)] px-4 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
        />
      </div>
      <div className="h-[150px] overflow-y-auto px-1 py-1">
        {debounced.length <= 1 ? (
          <p className="px-3 py-5 text-center text-sm leading-5 text-[var(--dim)]">
            Type a song or artist — tap a result to play it, or + to
            queue it.
          </p>
        ) : searchQuery.isPending ? (
          <p className="py-5 text-center text-sm text-[var(--dim)]">
            Searching…
          </p>
        ) : results.length === 0 ? (
          <p className="py-5 text-center text-sm text-[var(--dim)]">
            No songs found for “{debounced}”.
          </p>
        ) : (
          results.map((t) => (
            <TrackRow key={t.uri} track={t} onPlay={onPlay} onAdd={onAdd} />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connect screen — shown only when no Spotify account is linked       */
/* ------------------------------------------------------------------ */

function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  const connectQuery = useQuery({
    queryKey: ["connect-url"],
    queryFn: fetchConnectUrl,
    staleTime: Infinity,
    retry: false,
  });
  // Poll playback: fetchPlayback throws 401 until an account is linked,
  // then resolves and we move straight into the player.
  const statusQuery = useQuery({
    queryKey: ["playback"],
    queryFn: fetchPlayback,
    refetchInterval: 3000,
    retry: false,
  });
  useEffect(() => {
    if (statusQuery.data) onConnected();
  }, [statusQuery.data, onConnected]);

  const url = connectQuery.data ?? null;

  return (
    <div className="mx-auto w-full max-w-md px-5 py-10">
      <div className="flex justify-center">
        <RingCanvas size={92} playing={false} fraction={0} />
      </div>
      <h1 className="mt-4 text-center text-2xl font-bold tracking-tight">
        Connect your Spotify
      </h1>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--dim)]">
        This overlay runs straight on the Spotify account connected to
        this Muse — no Client ID, no setup. One tap links it, and this
        page picks it up on its own.
      </p>

      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-6 block w-full rounded-full bg-[var(--accent)] py-3 text-center text-[15px] font-bold text-[#06130a] transition hover:brightness-110"
        >
          Connect to Spotify
        </a>
      ) : (
        <p
          className="mt-6 text-center text-sm leading-6 text-[var(--dim)]"
          role={connectQuery.isPending ? undefined : "alert"}
        >
          {connectQuery.isPending
            ? "Getting the connect link…"
            : "Couldn't get a connect link here. Ask Muse in chat to connect Spotify, then come back to this page."}
        </p>
      )}
      <p className="mt-5 text-center text-xs leading-5 text-[var(--dim)]">
        Playback control needs Spotify Premium (a Spotify rule).
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The overlay: tiny gaming icon ⇄ full player                         */
/* ------------------------------------------------------------------ */

/**
 * The overlay is anchored to the nearest screen corner: offsets are
 * measured from that corner's edges, so when the small icon grows into
 * the full panel it expands inward — toward the middle of the screen —
 * instead of spilling off the top or side edge it was dragged to.
 * (Bottom/right-only offsets did exactly that at the top corners: the
 * panel stayed pinned to a huge `bottom` value and grew off-screen.)
 */
type OverlayPos = {
  ax: "left" | "right";
  ay: "top" | "bottom";
  ox: number;
  oy: number;
};

const POS_KEY = "spotify-overlay-pos";
const ICON_SIZE = 54;

function clampPos(p: OverlayPos): OverlayPos {
  return {
    ...p,
    ox: Math.max(
      6,
      Math.min(p.ox, Math.max(6, window.innerWidth - ICON_SIZE - 8)),
    ),
    oy: Math.max(
      6,
      Math.min(p.oy, Math.max(6, window.innerHeight - ICON_SIZE - 8)),
    ),
  };
}

function loadPos(): OverlayPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OverlayPos> & {
      right?: unknown;
      bottom?: unknown;
    };
    if (
      (parsed.ax === "left" || parsed.ax === "right") &&
      (parsed.ay === "top" || parsed.ay === "bottom") &&
      typeof parsed.ox === "number" &&
      typeof parsed.oy === "number"
    ) {
      return clampPos({
        ax: parsed.ax,
        ay: parsed.ay,
        ox: parsed.ox,
        oy: parsed.oy,
      });
    }
    // Positions saved by earlier builds were bottom-right offsets.
    if (
      typeof parsed.right === "number" &&
      typeof parsed.bottom === "number"
    ) {
      return clampPos({
        ax: "right",
        ay: "bottom",
        ox: parsed.right,
        oy: parsed.bottom,
      });
    }
  } catch {
    // Storage unavailable — fall back to the default corner.
  }
  return null;
}

function Player({ onNotConnected }: { onNotConnected: () => void }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<OverlayPos | null>(loadPos);
  // While dragging, the wrapper follows the pointer in plain left/top
  // coordinates; on drop it re-anchors to the nearest corner.
  const [dragTl, setDragTl] = useState<{ left: number; top: number } | null>(
    null,
  );

  // A saved spot can fall outside a smaller window — pull it back in.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    grabDX: number;
    grabDY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [section, setSection] = useState<
    "lyrics" | "queue" | "search" | null
  >(null);
  const [message, setMessage] = useState("");
  const [messageOk, setMessageOk] = useState(false);
  const [volume, setVolumeState] = useState<number>(50);
  const volumeTouchedAt = useRef(0);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playbackQuery = useQuery({
    queryKey: ["playback"],
    queryFn: fetchPlayback,
    refetchInterval: 2000,
    retry: false,
  });
  const playback = playbackQuery.data ?? null;

  // Album cover for the current track, resolved once per track.
  const coverQuery = useQuery({
    queryKey: ["cover", playback?.trackUri ?? ""],
    queryFn: () =>
      fetchCoverArt(playback?.trackUrl ?? "", playback?.trackUri ?? ""),
    enabled: !!playback?.hasItem && !!playback?.trackUrl,
    staleTime: Infinity,
    retry: false,
  });
  const coverUrl = coverQuery.data ?? playback?.imageUrl ?? null;

  useEffect(() => {
    if (
      playbackQuery.error instanceof PlayerError &&
      playbackQuery.error.status === 401
    ) {
      onNotConnected();
    }
  }, [playbackQuery.error, onNotConnected]);

  // Local interpolation between polls.
  const [base, setBase] = useState({ progressMs: 0, at: 0, isPlaying: false });
  useEffect(() => {
    if (playback) {
      setBase({
        progressMs: playback.progressMs,
        at: Date.now(),
        isPlaying: playback.isPlaying,
      });
      if (
        playback.volume != null &&
        Date.now() - volumeTouchedAt.current > 3000
      ) {
        setVolumeState(playback.volume);
      }
    }
  }, [playback]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const durationMs = playback?.durationMs ?? 0;
  const currentMs = Math.min(
    base.progressMs + (base.isPlaying ? now - base.at : 0),
    durationMs || Number.MAX_SAFE_INTEGER,
  );
  const fraction = durationMs > 0 ? currentMs / durationMs : 0;
  const isPlaying = base.isPlaying;

  const send = useCallback(
    async (action: Parameters<typeof control>[0], optimistic?: () => void) => {
      optimistic?.();
      try {
        await control(action);
        setMessage("");
      } catch (e) {
        setMessageOk(false);
        setMessage(
          e instanceof PlayerError
            ? e.message
            : "Something went wrong talking to Spotify.",
        );
        if (e instanceof PlayerError && e.status === 401) onNotConnected();
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["playback"] });
      }
    },
    [queryClient, onNotConnected],
  );

  const togglePlay = useCallback(() => {
    if (!playback?.hasItem) return;
    if (isPlaying) {
      void send({ kind: "pause" }, () =>
        setBase((b) => ({ progressMs: currentMs, at: Date.now(), isPlaying: false })),
      );
    } else {
      void send({ kind: "play" }, () =>
        setBase((b) => ({ ...b, at: Date.now(), isPlaying: true })),
      );
    }
  }, [playback?.hasItem, isPlaying, send, currentMs]);

  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(ms, durationMs));
      setBase({ progressMs: clamped, at: Date.now(), isPlaying });
      void send({ kind: "seek", positionMs: clamped });
    },
    [durationMs, isPlaying, send],
  );

  const onSeekBar = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!durationMs) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * durationMs);
  };

  const onVolume = (value: number) => {
    setVolumeState(value);
    volumeTouchedAt.current = Date.now();
    if (volumeTimer.current) clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      void send({ kind: "volume", percent: value });
    }, 350);
  };

  const playTrack = useCallback(
    async (track: TrackResult) => {
      try {
        await playUri(track.uri);
        setMessage("");
        setMessageOk(false);
        setSection(null);
      } catch (e) {
        setMessageOk(false);
        setMessage(
          e instanceof PlayerError
            ? e.message
            : "Something went wrong talking to Spotify.",
        );
        if (e instanceof PlayerError && e.status === 401) onNotConnected();
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["playback"] });
        void queryClient.invalidateQueries({ queryKey: ["queue"] });
      }
    },
    [queryClient, onNotConnected],
  );

  const queueTrack = useCallback(
    async (track: TrackResult) => {
      try {
        await addToQueue(track.uri);
        setMessage(`Added “${track.title}” to the queue.`);
        setMessageOk(true);
      } catch (e) {
        setMessageOk(false);
        setMessage(
          e instanceof PlayerError
            ? e.message
            : "Something went wrong talking to Spotify.",
        );
        if (e instanceof PlayerError && e.status === 401) onNotConnected();
      } finally {
        void queryClient.invalidateQueries({ queryKey: ["queue"] });
      }
    },
    [queryClient, onNotConnected],
  );

  const cycleRepeat = () => {
    const next: RepeatState =
      playback?.repeat === "off"
        ? "all"
        : playback?.repeat === "all"
          ? "one"
          : "off";
    void send({ kind: "repeat", state: next });
  };

  const expand = (pin: boolean) => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    setExpanded(true);
    if (pin) setPinned(true);
  };
  const collapse = () => {
    setPinned(false);
    if (!expanded || closing) return;
    // Play the shrink animation, then swap back to the icon.
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setExpanded(false);
      setClosing(false);
      closeTimer.current = null;
    }, 240);
  };

  /* Drag the overlay anywhere; the spot is remembered across opens. */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = wrapRef.current;
    if (!el) return;
    // In the big panel, drags start from empty space, not from controls.
    if (expanded) {
      const t = e.target as HTMLElement;
      if (t.closest("button, a, input, [role='slider']")) return;
    }
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - rect.left,
      grabDY: e.clientY - rect.top,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = wrapRef.current;
    if (!d || !el) return;
    if (
      !d.moved &&
      Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5
    ) {
      return;
    }
    if (!d.moved) {
      d.moved = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety; window-edge drags still work without it.
      }
    }
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      4,
      Math.min(e.clientX - d.grabDX, window.innerWidth - rect.width - 4),
    );
    const top = Math.max(
      4,
      Math.min(e.clientY - d.grabDY, window.innerHeight - rect.height - 4),
    );
    setDragTl({ left, top });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) {
      // The pointer-up ends in a click — don't let it also toggle the panel.
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 80);
      // Re-anchor to whichever corner the overlay landed nearest, so
      // expanding from here always grows into the screen, never off it.
      const el = wrapRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const next = clampPos({
          ax: cx < window.innerWidth / 2 ? "left" : "right",
          ay: cy < window.innerHeight / 2 ? "top" : "bottom",
          ox:
            cx < window.innerWidth / 2
              ? rect.left
              : window.innerWidth - (rect.left + rect.width),
          oy:
            cy < window.innerHeight / 2
              ? rect.top
              : window.innerHeight - (rect.top + rect.height),
        });
        setPos(next);
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(next));
        } catch {
          // Position just won't persist in this browser.
        }
      }
      setDragTl(null);
    }
  };

  const controlsDisabled = !playback?.hasItem;

  // The grow/shrink animation springs from the corner the overlay is
  // anchored to — the spot the icon actually sits in.
  const origin = `${pos?.ay ?? "bottom"} ${pos?.ax ?? "right"}`;

  let panel: ReactNode;
  if (!expanded) {
    panel = (
      <button
        type="button"
        aria-label={playback?.hasItem ? `Open player — ${playback.title} by ${playback.artists}` : "Open Spotify player"}
        aria-expanded={false}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          expand(true);
        }}
        style={{ transformOrigin: origin }}
        className="overlay-icon relative grid h-[54px] w-[54px] cursor-grab place-items-center rounded-full transition hover:scale-105 active:cursor-grabbing"
      >
        <RingCanvas size={54} playing={isPlaying && !!playback?.hasItem} fraction={fraction} />
      </button>
    );
  } else {
    panel = (
      <section
        aria-label="Spotify player"
        style={{ transformOrigin: origin }}
        className={`overlay-panel ${closing ? "closing" : ""} relative flex max-h-[calc(100dvh-16px)] w-[min(340px,calc(100vw-20px))] cursor-grab flex-col overflow-x-hidden overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-5 py-5 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-md active:cursor-grabbing`}
      >
        <button
          type="button"
          aria-label="Shrink to small icon"
          onClick={collapse}
          className="sticky top-0 z-10 -mb-9 grid h-9 w-9 flex-none place-self-end rounded-full bg-[rgba(16,19,22,0.55)] text-[var(--dim)] transition hover:bg-[rgba(255,255,255,0.07)] hover:text-white"
        >
          <Icon d={PATHS.shrink} size={18} />
        </button>
        <div className="flex w-full flex-col items-center text-center">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={playback?.album ? `Album art for ${playback.album}` : "Album cover"}
              className="h-[88px] w-[88px] flex-none rounded-2xl object-cover shadow-[0_10px_28px_rgba(0,0,0,0.5)]"
              width={88}
              height={88}
            />
          ) : (
            <span className="grid h-[88px] w-[88px] flex-none place-items-center overflow-hidden rounded-2xl bg-[rgba(255,255,255,0.05)]">
              <RingCanvas size={88} playing={isPlaying && !!playback?.hasItem} fraction={fraction} />
            </span>
          )}
          <div className="mt-2 w-full min-w-0 px-2">
            {playback?.hasItem ? (
              <>
                <p className="truncate text-[16px] font-bold leading-6">
                  {playback.title}
                </p>
                <p className="truncate text-sm leading-5 text-[var(--dim)]">
                  {playback.artists}
                </p>
              </>
            ) : (
              <>
                <p className="text-[16px] font-bold leading-6">Nothing playing</p>
                <p className="text-sm leading-5 text-[var(--dim)]">
                  Open Spotify and press play once.
                </p>
              </>
            )}
          </div>
        </div>

        <div
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(currentMs / 1000)}
          aria-valuetext={`${fmt(currentMs)} of ${fmt(durationMs)}`}
          tabIndex={controlsDisabled ? -1 : 0}
          onClick={onSeekBar}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seekTo(currentMs + 5000);
            if (e.key === "ArrowLeft") seekTo(currentMs - 5000);
          }}
          className="group mx-auto mt-3 w-full cursor-pointer py-2"
        >
          <div className="h-[5px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.16)]">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${Math.min(100, fraction * 100)}%` }}
            />
          </div>
        </div>
        <div className="mx-auto flex w-full justify-between text-xs tabular-nums text-[var(--dim)]">
          <span>{fmt(currentMs)}</span>
          <span>{fmt(durationMs)}</span>
        </div>

        <div className="mt-1 flex items-center justify-center gap-1">
          <button
            type="button"
            aria-label={playback?.shuffle ? "Turn shuffle off" : "Turn shuffle on"}
            aria-pressed={!!playback?.shuffle}
            disabled={controlsDisabled}
            onClick={() => void send({ kind: "shuffle", on: !playback?.shuffle })}
            className={`grid h-11 w-11 place-items-center rounded-full transition disabled:opacity-35 ${playback?.shuffle ? "text-[var(--accent)]" : "text-[#d8dcd6] hover:text-white"}`}
          >
            <Icon d={PATHS.shuffle} size={20} />
          </button>
          <button
            type="button"
            aria-label="Previous track"
            disabled={controlsDisabled}
            onClick={() => void send({ kind: "previous" })}
            className="grid h-11 w-11 place-items-center rounded-full text-[#f4f6f3] transition hover:scale-105 disabled:opacity-35"
          >
            <Icon d={PATHS.prev} size={26} />
          </button>
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            disabled={controlsDisabled}
            onClick={togglePlay}
            className="grid h-14 w-14 place-items-center rounded-full bg-[var(--accent)] text-[#06130a] shadow-[0_8px_24px_rgba(30,215,96,0.35)] transition hover:scale-105 disabled:opacity-35"
          >
            <Icon d={isPlaying ? PATHS.pause : PATHS.play} size={28} />
          </button>
          <button
            type="button"
            aria-label="Next track"
            disabled={controlsDisabled}
            onClick={() => void send({ kind: "next" })}
            className="grid h-11 w-11 place-items-center rounded-full text-[#f4f6f3] transition hover:scale-105 disabled:opacity-35"
          >
            <Icon d={PATHS.next} size={26} />
          </button>
          <button
            type="button"
            aria-label={`Repeat: ${playback?.repeat ?? "off"}`}
            aria-pressed={playback?.repeat !== "off"}
            disabled={controlsDisabled}
            onClick={cycleRepeat}
            className={`relative grid h-11 w-11 place-items-center rounded-full transition disabled:opacity-35 ${playback?.repeat !== "off" ? "text-[var(--accent)]" : "text-[#d8dcd6] hover:text-white"}`}
          >
            <Icon d={PATHS.repeat} size={20} />
            {playback?.repeat === "one" && (
              <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-[#06130a]">
                1
              </span>
            )}
          </button>
        </div>

        <div className="mx-auto mt-1 flex w-[85%] items-center gap-3">
          <span className="text-[var(--dim)]">
            <Icon d={PATHS.volume} size={20} />
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            aria-label="Volume"
            disabled={controlsDisabled}
            onChange={(e) => onVolume(Number(e.target.value))}
            className="vol flex-1 disabled:opacity-35"
          />
        </div>

        {message && (
          <p
            className={`mt-3 px-2 text-center text-sm leading-5 ${messageOk ? "text-[var(--accent)]" : "text-[#ffb4b4]"}`}
            role={messageOk ? "status" : "alert"}
          >
            {message}
          </p>
        )}
        {!playback && playbackQuery.isPending && (
          <p className="mt-3 text-sm text-[var(--dim)]">Checking Spotify…</p>
        )}

        {section === "lyrics" && playback?.hasItem && (
          <div className="mt-2 w-full">
            <LyricsView playback={playback} currentMs={currentMs} onSeek={seekTo} height={132} />
          </div>
        )}
        {section === "queue" && (
          <div className="mt-2 w-full">
            <QueueSection onPlay={playTrack} />
          </div>
        )}
        {section === "search" && (
          <div className="mt-2 w-full">
            <SearchSection onPlay={playTrack} onAdd={queueTrack} />
          </div>
        )}

        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            aria-label={section === "lyrics" ? "Hide lyrics" : "Show lyrics"}
            aria-expanded={section === "lyrics"}
            disabled={controlsDisabled}
            onClick={() =>
              setSection((s) => (s === "lyrics" ? null : "lyrics"))
            }
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition disabled:opacity-35 ${section === "lyrics" ? "bg-[var(--accent)] text-[#06130a]" : "bg-[rgba(255,255,255,0.07)] text-[#e8ece7] hover:bg-[rgba(255,255,255,0.12)]"}`}
          >
            <Icon d={PATHS.lyrics} size={15} />
            Lyrics
          </button>
          <button
            type="button"
            aria-label={section === "queue" ? "Hide queue" : "Show queue"}
            aria-expanded={section === "queue"}
            onClick={() =>
              setSection((s) => (s === "queue" ? null : "queue"))
            }
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition ${section === "queue" ? "bg-[var(--accent)] text-[#06130a]" : "bg-[rgba(255,255,255,0.07)] text-[#e8ece7] hover:bg-[rgba(255,255,255,0.12)]"}`}
          >
            <Icon d={PATHS.queue} size={15} />
            Queue
          </button>
          <button
            type="button"
            aria-label={section === "search" ? "Hide search" : "Show search"}
            aria-expanded={section === "search"}
            onClick={() =>
              setSection((s) => (s === "search" ? null : "search"))
            }
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition ${section === "search" ? "bg-[var(--accent)] text-[#06130a]" : "bg-[rgba(255,255,255,0.07)] text-[#e8ece7] hover:bg-[rgba(255,255,255,0.12)]"}`}
          >
            <Icon d={PATHS.search} size={15} />
            Search
          </button>
          {playback?.trackUrl && (
            <a
              href={playback.trackUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open this track in Spotify"
              className="grid h-9 w-9 place-items-center rounded-full text-[var(--dim)] transition hover:bg-[rgba(255,255,255,0.07)] hover:text-white"
            >
              <Icon d={PATHS.external} size={16} />
            </a>
          )}
          {playback?.deviceName && (
            <span className="max-w-[110px] truncate text-xs text-[var(--dim)]">
              {playback.deviceName}
            </span>
          )}
        </div>
      </section>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="fixed z-10 touch-none select-none"
      style={
        dragTl
          ? { left: dragTl.left, top: dragTl.top }
          : pos
            ? {
                ...(pos.ax === "left" ? { left: pos.ox } : { right: pos.ox }),
                ...(pos.ay === "top" ? { top: pos.oy } : { bottom: pos.oy }),
              }
            : {
                right: "max(18px, env(safe-area-inset-right))",
                bottom: "max(18px, env(safe-area-inset-bottom))",
              }
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseEnter={() => expand(false)}
      onMouseLeave={() => {
        if (!pinned && !dragRef.current) collapse();
      }}
    >
      {panel}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

export function App() {
  const [phase, setPhase] = useState<"checking" | "connect" | "player">(
    "checking",
  );

  // The connection lives in Muse, not the browser: ask the server
  // whether a Spotify account is linked, then go straight to the player.
  useEffect(() => {
    let cancelled = false;
    api
      .getNowPlaying({})
      .then((res) => {
        if (!cancelled) setPhase(res.connected ? "player" : "connect");
      })
      .catch(() => {
        // Transport hiccup — let the player surface it and keep retrying.
        if (!cancelled) setPhase("player");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showConnect = useCallback(() => setPhase("connect"), []);
  const showPlayer = useCallback(() => setPhase("player"), []);

  return (
    <div className="min-h-screen bg-[var(--bg)] pt-safe pb-safe">
      <main>
        {phase === "checking" && (
          <p className="py-24 text-center text-sm text-[var(--dim)]">
            Loading…
          </p>
        )}
        {phase === "connect" && <ConnectScreen onConnected={showPlayer} />}
        {phase === "player" && (
          <>
            <div className="mx-auto max-w-md px-5 py-10">
              <p className="text-center text-sm leading-6 text-[var(--dim)]">
                Connected straight to your Spotify. The overlay lives in
                the corner — hover it or tap the icon to open the player,
                shrink it back when you&rsquo;re in game. Drag it to any
                spot on the screen and it&rsquo;ll stay there. In the
                player you&rsquo;ll find the album cover, your queue, and
                search to play whatever you want.
              </p>
            </div>
            <Player onNotConnected={showConnect} />
          </>
        )}
      </main>
    </div>
  );
}
