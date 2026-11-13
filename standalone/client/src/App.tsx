/**
 * sov overlay — React client (standalone page + Electron shell).
 *
 * Minimal by design: one flat dark surface, one 1px border, one accent
 * colour. The expanded player shows the cover, the track, a progress
 * bar, prev/play/next and four small section buttons; everything else
 * (search, volume, opacity, settings) lives inside a panel.
 *
 * Sizing: the panel has FIXED widths (300 / 340 / 380px) and never uses
 * viewport units. A ResizeObserver on the wrapper reports its measured
 * box (panel + 16px) to the shell, so the window is always exactly the
 * panel's size and a size preset always maps to the same window width.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addToQueue,
  control,
  fetchDevices,
  fetchLikedSongs,
  fetchLyrics,
  fetchPlayback,
  fetchPlaylists,
  fetchQueue,
  getRateLimitDelayMs,
  pickBestDevice,
  playContext,
  playUri,
  PlayerError,
  searchTracks,
  type Playback,
  type PlaylistResult,
  type TrackResult,
} from "./spotify/api";
import {
  clearServerTokens,
  ensureTokensLoaded,
  fetchServerTokens,
  importTokens,
  isLoggedIn,
  logout,
  probeClientId,
  saveClientId,
  startLogin,
} from "./spotify/auth";
import {
  clearAllData,
  DEFAULT_SETTINGS,
  getSettings,
  isDesktop,
  onToggle,
  onVisibility,
  openLogs,
  requestDragEnd,
  requestDragStart,
  requestOpacity,
  requestResize,
  requestToggle,
  setPlayerActive,
  setSettings,
  whenBridgeReady,
  type SovSettings,
} from "./spotify/bridge";
import { CLIENT_BUILD } from "./version";
import type { PointerEvent as ReactPointerEvent } from "react";

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
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
  shrink:
    "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  lyrics: "M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z",
  queue: "M3 5h13v2.2H3zM3 10.9h13V13H3zM3 16.8h9V19H3zM16 15.5v7l6-3.5z",
  library:
    "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
};

/* ------------------------------------------------------------------ */
/* Window dragging                                                     */
/* ------------------------------------------------------------------ */

// How far the pointer must move before a press counts as a drag. Below
// this the press is a click, so the ring still toggles when tapped.
const DRAG_THRESHOLD_PX = 4;

type WindowDrag = {
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** True when the last press turned into a drag — the click that
   *  follows a drag must be ignored. Resets right after pointerup. */
  draggedRef: { current: boolean };
};

/**
 * Drag handles for the overlay window.
 *
 * The renderer only sends drag-start (on pointerdown) and drag-end (on
 * pointerup / pointercancel). The main process records the cursor, the
 * window position and the window size at drag-start, then follows the
 * cursor on a ~8ms timer — the window stays exactly under the pointer
 * with no per-frame IPC and no drift at any display scaling.
 */
function useWindowDrag(): WindowDrag {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Primary button only — right-click still opens the system menu.
      if (e.button !== 0) return;
      draggedRef.current = false;
      startRef.current = { x: e.screenX, y: e.screenY };
      requestDragStart(e.screenX, e.screenY);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer is already gone;
        // the drag just tracks without capture then.
      }
    },
    [],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const s = startRef.current;
    if (!s || draggedRef.current) return;
    // Screen pixels: the window moves under the cursor, so viewport
    // coordinates would shift even when the mouse is still.
    if (Math.hypot(e.screenX - s.x, e.screenY - s.y) > DRAG_THRESHOLD_PX) {
      draggedRef.current = true;
    }
  }, []);

  const endDrag = useCallback(() => {
    requestDragEnd();
    startRef.current = null;
    if (draggedRef.current) {
      // The click event fires right after pointerup, before any timer —
      // the click guard still sees the drag, then resets.
      window.setTimeout(() => {
        draggedRef.current = false;
      }, 0);
    }
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    draggedRef,
  };
}

/* ------------------------------------------------------------------ */
/* Window fitting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Size the desktop window from the panel's MEASURED box: one report per
 * animation frame, skipped when the size did not change. The panel is
 * `fixed` and content-sized, so measuring it can never feed back into
 * its own layout (no viewport units anywhere in the panel).
 */
function useWindowFit(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let last = "";
    const report = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const w = Math.ceil(rect.width) + 16;
      const h = Math.ceil(rect.height) + 16;
      const key = `${w}x${h}`;
      if (key === last) return;
      last = key;
      requestResize(w, h);
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(report);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    schedule();
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [ref]);
}

/* ------------------------------------------------------------------ */
/* Collapsed ring — a thin ring with a progress arc, nothing else      */
/* ------------------------------------------------------------------ */

function Ring({ size, fraction }: { size: number; fraction: number }) {
  const radius = size / 2 - 1.5;
  const circumference = 2 * Math.PI * radius;
  const played = Math.min(1, Math.max(0, fraction));
  const centre = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        stroke="var(--border)"
        strokeWidth={1.5}
      />
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - played)}
        transform={`rotate(-90 ${centre} ${centre})`}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
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
    <div className="flex items-center gap-1 border-b border-[var(--border)] py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => onPlay(track)}
        aria-label={`Play ${track.title} by ${track.artists}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {typeof index === "number" && (
          <span className="w-4 flex-none text-[11px] tabular-nums text-[var(--dim)]">
            {index + 1}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4">
            {track.title}
          </span>
          <span className="block truncate text-[11px] leading-4 text-[var(--dim)]">
            {track.artists}
          </span>
        </span>
        <span className="flex-none text-[11px] tabular-nums text-[var(--dim)]">
          {track.durationMs > 0 ? fmt(track.durationMs) : ""}
        </span>
      </button>
      {onAdd && (
        <button
          type="button"
          onClick={() => onAdd(track)}
          aria-label={`Add ${track.title} to queue`}
          className="grid h-8 w-8 flex-none place-items-center text-[var(--dim)] hover:text-[var(--text)]"
        >
          <Icon d={PATHS.plus} size={14} />
        </button>
      )}
    </div>
  );
}

function PlaylistRow({
  playlist,
  onPlay,
}: {
  playlist: PlaylistResult;
  onPlay: (playlist: PlaylistResult) => void;
}) {
  return (
    <div className="border-b border-[var(--border)] py-1 last:border-b-0">
      <button
        type="button"
        onClick={() => onPlay(playlist)}
        aria-label={`Play playlist ${playlist.name}`}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4">
            {playlist.name}
          </span>
          <span className="block truncate text-[11px] leading-4 text-[var(--dim)]">
            {playlist.owner ? `${playlist.owner} · ` : ""}
            {playlist.trackCount} songs
          </span>
        </span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Queue + search panel                                                */
/* ------------------------------------------------------------------ */

function QueueSection({
  onPlay,
  onAdd,
  visible,
}: {
  onPlay: (track: TrackResult) => void;
  onAdd: (track: TrackResult) => void;
  /** False while the window is hidden to the tray — polling pauses. */
  visible: boolean;
}) {
  const [value, setValue] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value.trim()), 400);
    return () => window.clearTimeout(id);
  }, [value]);
  const searching = debounced.length > 1;
  const searchQuery = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchTracks(debounced),
    enabled: searching,
    staleTime: 30_000,
    retry: false,
  });
  const queueQuery = useQuery({
    queryKey: ["queue"],
    queryFn: fetchQueue,
    refetchInterval: visible ? 5000 : false,
    retry: false,
  });
  const results = searchQuery.data ?? [];
  const upcoming = queueQuery.data ?? [];
  return (
    <div className="flex h-full flex-col gap-1.5" aria-label="Queue and search">
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search to add…"
        aria-label="Search songs"
        className="h-8 w-full flex-none rounded border border-[var(--border)] bg-transparent px-2 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          searchQuery.isPending ? (
            <p className="py-3 text-[13px] text-[var(--dim)]">Searching…</p>
          ) : results.length === 0 ? (
            <p className="py-3 text-[13px] text-[var(--dim)]">
              No songs found.
            </p>
          ) : (
            results.map((t) => (
              <TrackRow key={t.uri} track={t} onPlay={onPlay} onAdd={onAdd} />
            ))
          )
        ) : queueQuery.isPending ? (
          <p className="py-3 text-[13px] text-[var(--dim)]">Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="py-3 text-[13px] text-[var(--dim)]">Queue is empty.</p>
        ) : (
          upcoming.map((t, i) => (
            <TrackRow
              key={`${t.uri}-${i}`}
              track={t}
              index={i}
              onPlay={onPlay}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Library panel — Liked Songs + Playlists                             */
/* ------------------------------------------------------------------ */

function LibrarySection({
  onPlay,
  onAdd,
  onPlayPlaylist,
  onReconnect,
}: {
  onPlay: (track: TrackResult) => void;
  onAdd: (track: TrackResult) => void;
  onPlayPlaylist: (playlist: PlaylistResult) => void;
  onReconnect: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [allTracks, setAllTracks] = useState<TrackResult[]>([]);
  const [total, setTotal] = useState(0);
  const likedQuery = useQuery({
    queryKey: ["library", "liked", offset],
    queryFn: () => fetchLikedSongs(50, offset),
    retry: false,
  });
  const playlistsQuery = useQuery({
    queryKey: ["library", "playlists"],
    queryFn: fetchPlaylists,
    staleTime: 60_000,
    retry: false,
  });
  // "Load more" appends the next page instead of replacing the list.
  useEffect(() => {
    const data = likedQuery.data;
    if (!data) return;
    setTotal(data.total);
    setAllTracks((prev) => {
      const seen = new Set(prev.map((t) => t.uri));
      return [...prev, ...data.tracks.filter((t) => !seen.has(t.uri))];
    });
  }, [likedQuery.data]);
  // A 403 here means the token was minted before the library scopes
  // were added — offer a reconnect instead of an empty list.
  const scopeError =
    (likedQuery.error instanceof PlayerError &&
      likedQuery.error.status === 403) ||
    (playlistsQuery.error instanceof PlayerError &&
      playlistsQuery.error.status === 403);
  if (scopeError) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-2">
        <p className="text-[13px]">Library needs a reconnect</p>
        <p className="text-[11px] leading-4 text-[var(--dim)]">
          Your Spotify login doesn't include library access yet.
        </p>
        <button
          type="button"
          onClick={onReconnect}
          className="rounded bg-[var(--accent)] px-2 py-1 text-[13px] font-semibold text-[#06130a]"
        >
          Reconnect
        </button>
      </div>
    );
  }
  const playlists = playlistsQuery.data ?? [];
  return (
    <div className="h-full overflow-y-auto" aria-label="Your library">
      <p className="pb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Liked Songs{total > 0 ? ` · ${total}` : ""}
      </p>
      {likedQuery.isPending && allTracks.length === 0 ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">Loading…</p>
      ) : likedQuery.isError ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">
          Couldn't load Liked Songs.
        </p>
      ) : allTracks.length === 0 ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">
          No Liked Songs yet.
        </p>
      ) : (
        <>
          {allTracks.map((t) => (
            <TrackRow key={t.uri} track={t} onPlay={onPlay} onAdd={onAdd} />
          ))}
          {allTracks.length < total && (
            <button
              type="button"
              onClick={() => setOffset((o) => o + 50)}
              disabled={likedQuery.isFetching}
              className="mt-1 w-full rounded border border-[var(--border)] px-2 py-1 text-[13px] disabled:opacity-50"
            >
              {likedQuery.isFetching ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
      <p className="pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Playlists
      </p>
      {playlistsQuery.isPending ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">Loading…</p>
      ) : playlistsQuery.isError ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">
          Couldn't load playlists.
        </p>
      ) : playlists.length === 0 ? (
        <p className="py-2 text-[13px] text-[var(--dim)]">No playlists yet.</p>
      ) : (
        playlists.map((p) => (
          <PlaylistRow key={p.uri} playlist={p} onPlay={onPlayPlaylist} />
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lyrics panel                                                        */
/* ------------------------------------------------------------------ */

function LyricsView({
  playback,
  currentMs,
  onSeek,
  offsetMs,
}: {
  playback: Playback;
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Synced-lyrics shift from settings (ms, + = lyrics later). */
  offsetMs: number;
}) {
  const firstArtist = playback.artists.split(",")[0]?.trim() ?? "";
  const query = useQuery({
    queryKey: ["lyrics", playback.title, firstArtist, offsetMs],
    queryFn: () =>
      fetchLyrics(
        playback.title,
        firstArtist,
        playback.album,
        playback.durationMs / 1000,
        offsetMs,
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

  const boxRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const line = lineRef.current;
    if (!box || !line) return;
    box.scrollTop = line.offsetTop - box.clientHeight / 2 + line.offsetHeight / 2;
  }, [active, lines.length]);

  if (query.isPending) {
    return <p className="text-[13px] text-[var(--dim)]">Loading lyrics…</p>;
  }
  if (!query.data?.found) {
    return <p className="text-[13px] text-[var(--dim)]">No lyrics found.</p>;
  }
  if (lines.length === 0) {
    return (
      <div ref={boxRef} className="h-full overflow-y-auto">
        <p className="whitespace-pre-line text-[13px] leading-5 text-[var(--dim)]">
          {query.data.plain}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className="h-full overflow-y-auto"
      aria-label="Synced lyrics"
    >
      {lines.map((line, i) => (
        <button
          key={`${line.t}-${i}`}
          ref={i === active ? lineRef : null}
          type="button"
          onClick={() => onSeek(line.t * 1000)}
          aria-label={`Play from: ${line.text || "instrumental break"}`}
          aria-current={i === active ? "true" : undefined}
          className={`block w-full py-1 text-left text-[13px] leading-5 ${
            i === active ? "text-[var(--accent)]" : "text-[var(--dim)]"
          }`}
        >
          {line.text || "♪"}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings panel                                                      */
/* ------------------------------------------------------------------ */

function SettingsCheck({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-b-0">
      <span className="min-w-0">
        <span className="block text-[13px] leading-4">{label}</span>
        {hint && (
          <span className="block text-[11px] leading-4 text-[var(--dim)]">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 flex-none accent-[var(--accent)]"
      />
    </label>
  );
}

function SettingsSection({
  settings,
  onSave,
  onLogout,
  onClearData,
  note,
  rejected,
  volume,
  onVolume,
  volumeDisabled,
  opacity,
  onOpacity,
  opacityDisabled,
}: {
  settings: SovSettings;
  onSave: (patch: Partial<SovSettings>) => void;
  onLogout: () => void;
  onClearData: () => void;
  note: string;
  rejected: string[];
  volume: number;
  onVolume: (value: number) => void;
  volumeDisabled: boolean;
  opacity: number;
  onOpacity: (value: number) => void;
  opacityDisabled: boolean;
}) {
  // Hotkey text: local draft, committed on blur/Enter — every keystroke
  // must not fire a settings-set (and a hotkey restart).
  const [hotkeyDraft, setHotkeyDraft] = useState(settings.hotkey);
  useEffect(() => {
    setHotkeyDraft(settings.hotkey);
  }, [settings.hotkey]);
  const commitHotkey = () => {
    const cleaned = hotkeyDraft.trim().toLowerCase();
    if (cleaned && cleaned !== settings.hotkey) {
      onSave({ hotkey: cleaned });
    } else {
      setHotkeyDraft(settings.hotkey);
    }
  };
  // Lyrics offset: local draft, committed 400ms after the last slider
  // movement — dragging must not spam IPC writes.
  const [offsetDraft, setOffsetDraft] = useState(settings.lyricsOffsetMs);
  const offsetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setOffsetDraft(settings.lyricsOffsetMs);
  }, [settings.lyricsOffsetMs]);
  useEffect(
    () => () => {
      if (offsetTimer.current) clearTimeout(offsetTimer.current);
    },
    [],
  );
  const onOffset = (value: number) => {
    setOffsetDraft(value);
    if (offsetTimer.current) clearTimeout(offsetTimer.current);
    offsetTimer.current = setTimeout(() => {
      onSave({ lyricsOffsetMs: value });
    }, 400);
  };
  // Clear data: two-step inline confirm, never a browser dialog.
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const id = window.setTimeout(() => setConfirmClear(false), 8000);
    return () => window.clearTimeout(id);
  }, [confirmClear]);
  const offsetSec = (offsetDraft / 1000).toFixed(1);
  const offsetLabel =
    offsetDraft === 0
      ? "in sync"
      : offsetDraft > 0
        ? `${offsetSec}s later`
        : `${Math.abs(Number(offsetSec)).toFixed(1)}s earlier`;

  return (
    <div className="h-full overflow-y-auto" aria-label="Settings">
      <p className="pb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Player size
      </p>
      <div className="flex gap-1.5" role="group" aria-label="Player size">
        {(["small", "medium", "large"] as const).map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={settings.sizePreset === preset}
            onClick={() => onSave({ sizePreset: preset })}
            className={`flex-1 rounded border px-2 py-1 text-[13px] capitalize ${
              settings.sizePreset === preset
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>
      <p className="pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Behaviour
      </p>
      <SettingsCheck
        label="Start with Windows"
        hint="Launch sov when Windows starts."
        checked={settings.startWithWindows}
        onChange={(v) => onSave({ startWithWindows: v })}
      />
      <SettingsCheck
        label="Snap to corners"
        hint="Snap to the nearest screen corner after a drag."
        checked={settings.snapToCorners}
        onChange={(v) => onSave({ snapToCorners: v })}
      />
      <SettingsCheck
        label="Click-through when collapsed"
        hint="Clicks pass through to your game while the ring is shown."
        checked={settings.clickThrough}
        onChange={(v) => onSave({ clickThrough: v })}
      />
      <SettingsCheck
        label="Don't steal focus"
        hint="Opening the overlay never pulls focus from your game."
        checked={settings.dontStealFocus}
        onChange={(v) => onSave({ dontStealFocus: v })}
      />
      <SettingsCheck
        label="Auto-hide on fullscreen"
        hint="Hide while a fullscreen window is in front."
        checked={settings.autoHideOnFullscreen}
        onChange={(v) => onSave({ autoHideOnFullscreen: v })}
      />
      <SettingsCheck
        label="High contrast"
        hint="Brighter text, stronger borders."
        checked={settings.highContrast}
        onChange={(v) => onSave({ highContrast: v })}
      />

      <p className="pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Toggle hotkey
      </p>
      <input
        type="text"
        value={hotkeyDraft}
        onChange={(e) => setHotkeyDraft(e.target.value)}
        onBlur={commitHotkey}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="ctrl+shift+m"
        aria-label="Toggle hotkey"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-8 w-full rounded border border-[var(--border)] bg-transparent px-2 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
      />
      <select
        value={settings.hotkeyMode}
        onChange={(e) =>
          onSave({
            hotkeyMode:
              e.target.value === "globalShortcut" ? "globalShortcut" : "hook",
          })
        }
        aria-label="Hotkey mode"
        className="mt-1.5 h-8 w-full rounded border border-[var(--border)] bg-transparent px-2 text-[13px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
      >
        <option value="hook">Low-level hook — works while gaming</option>
        <option value="globalShortcut">Global shortcut (fallback)</option>
      </select>
      <p className="pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Volume and opacity
      </p>
      <label className="flex items-center gap-2 py-1">
        <span className="w-14 flex-none text-[13px] text-[var(--dim)]">
          Volume
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Volume"
          disabled={volumeDisabled}
          onChange={(e) => onVolume(Number(e.target.value))}
          className="vol flex-1 disabled:opacity-35"
        />
        <span className="w-8 flex-none text-right text-[11px] tabular-nums text-[var(--dim)]">
          {Math.round(volume)}%
        </span>
      </label>
      <label className="flex items-center gap-2 py-1">
        <span className="w-14 flex-none text-[13px] text-[var(--dim)]">
          Opacity
        </span>
        <input
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          aria-label="Window opacity"
          disabled={opacityDisabled}
          onChange={(e) => onOpacity(Number(e.target.value))}
          className="vol flex-1 disabled:opacity-35"
        />
        <span className="w-8 flex-none text-right text-[11px] tabular-nums text-[var(--dim)]">
          {Math.round(opacity * 100)}%
        </span>
      </label>

      <p className="pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        Lyrics offset
      </p>
      <input
        type="range"
        min={-5000}
        max={5000}
        step={250}
        value={offsetDraft}
        aria-label="Lyrics offset in milliseconds"
        onChange={(e) => onOffset(Number(e.target.value))}
        className="vol w-full"
      />
      <p className="text-[11px] tabular-nums text-[var(--dim)]">
        {offsetDraft > 0 ? "+" : ""}
        {offsetSec}s — lyrics {offsetLabel}
      </p>

      <div className="flex flex-wrap gap-1.5 pt-3">
        <button
          type="button"
          onClick={() => void openLogs()}
          className="rounded border border-[var(--border)] px-2 py-1 text-[13px]"
        >
          Open logs
        </button>
        <button
          type="button"
          onClick={onLogout}
          className="rounded border border-[var(--border)] px-2 py-1 text-[13px]"
        >
          Log out
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmClear) {
              setConfirmClear(false);
              onClearData();
            } else {
              setConfirmClear(true);
            }
          }}
          className={`rounded border px-2 py-1 text-[13px] ${
            confirmClear
              ? "border-[#c0392b] text-[#ffb4b4]"
              : "border-[var(--border)]"
          }`}
        >
          {confirmClear ? "Tap again to erase" : "Clear data"}
        </button>
      </div>
      {confirmClear && (
        <p className="pt-1 text-[11px] leading-4 text-[#ffb4b4]" role="alert">
          Deletes tokens, settings, the saved position, logs and the lyrics
          cache. Your Client ID is kept.
        </p>
      )}
      {note && (
        <p className="pt-1 text-[11px] text-[var(--accent)]" role="status">
          {note}
        </p>
      )}
      {rejected.length > 0 && (
        <p className="pt-1 text-[11px] leading-4 text-[#ffb4b4]" role="alert">
          Couldn't apply: {rejected.join(", ")}
        </p>
      )}


    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connect screen — first run: Client ID once, then Spotify login      */
/* ------------------------------------------------------------------ */

function StandaloneConnect({ onConnected }: { onConnected: () => void }) {
  const [clientId, setClientId] = useState<string | null | undefined>(
    undefined,
  );
  const [manualId, setManualId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // True while a browser login is in flight: the authorize page opened
  // in the user's default browser and this screen polls the local
  // server for the tokens the callback posts back.
  const [waiting, setWaiting] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  // True when /api/config failed outright (timeout / unreachable).
  const [configFailed, setConfigFailed] = useState(false);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [build, setBuild] = useState<string | null>(null);

  // The card is the measured panel: the window fits it exactly.
  const cardRef = useRef<HTMLDivElement>(null);
  useWindowFit(cardRef);

  // Drag handle: only the header (ring + title) moves the window.
  const connectDrag = useWindowDrag();

  // The Client ID check never blocks the paste box: the input renders
  // immediately and the card upgrades to the "found" variant if the
  // check finds an ID (capped at 5s inside probeClientId).
  useEffect(() => {
    let cancelled = false;
    probeClientId().then(({ clientId: id, configOk, build: b }) => {
      if (cancelled) return;
      if (b) setBuild(b);
      if (id) {
        setClientId(id);
      } else {
        setClientId(null);
        if (!configOk) setConfigFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (!cancelled) setServerOk(r.ok);
      })
      .catch(() => {
        if (!cancelled) setServerOk(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // If a login finished in another tab/window, pick it up.
  useEffect(() => {
    if (isLoggedIn()) onConnected();
  }, [onConnected]);

  const connect = async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      setError("Paste your Spotify app's Client ID first.");
      return;
    }
    setBusy(true);
    setError("");
    saveClientId(trimmed);
    // Drop stale tokens a previous unfinished login left on the server,
    // so the poll below can't pick up an old session.
    await clearServerTokens();
    try {
      const mode = await startLogin(trimmed);
      if (mode === "browser") {
        setBusy(false);
        setWaiting(true);
      }
      // "in-window": the page navigated away to Spotify.
    } catch (e) {
      setBusy(false);
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't start the Spotify login. Try again.",
      );
    }
  };

  // Poll GET /api/tokens while waiting for a browser login to finish.
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      void fetchServerTokens().then((t) => {
        if (cancelled) return;
        if (t) {
          window.clearInterval(id);
          importTokens(t);
          void clearServerTokens();
          setWaiting(false);
          setJustConnected(true);
          window.setTimeout(() => onConnected(), 800);
        } else if (tries >= 300) {
          // 10 minutes with no tokens — give up instead of polling
          // forever.
          window.clearInterval(id);
          setWaiting(false);
          setError("Login didn't finish in time — press Connect again.");
        }
      });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [waiting, onConnected]);

  return (
    <div className="fixed bottom-2 right-2">
      <div
        ref={cardRef}
        style={{ width: 340 }}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div
          {...connectDrag.handlers}
          className="cursor-grab touch-none select-none active:cursor-grabbing"
        >
          <div className="flex justify-center">
            <Ring size={64} fraction={0} />
          </div>
          <p className="mt-3 text-center text-[13px] font-semibold">
            Connect your Spotify
          </p>
          <p className="mt-1 text-center text-[11px] leading-4 text-[var(--dim)]">
            One login, right here — no Client ID is sent anywhere except to
            Spotify.
          </p>
        </div>
        {justConnected ? (
          <p className="mt-3 text-center text-[13px] text-[var(--accent)]">
            Connected!
          </p>
        ) : waiting ? (
          <>
            <p className="mt-3 text-center text-[11px] leading-4 text-[var(--dim)]">
              Finish logging in in your browser — this screen picks it up
              automatically.
            </p>
            <button
              type="button"
              onClick={() => setWaiting(false)}
              className="mt-3 w-full rounded border border-[var(--border)] py-1.5 text-[13px]"
            >
              Cancel
            </button>
          </>
        ) : clientId ? (
          <>
            <p className="mt-3 text-center text-[11px] leading-4 text-[var(--dim)]">
              Your Client ID was found on this computer — nothing to paste.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void connect(clientId)}
              className="mt-3 w-full rounded bg-[var(--accent)] py-1.5 text-[13px] font-semibold text-[#06130a] disabled:opacity-50"
            >
              {busy ? "Opening Spotify…" : "Connect to Spotify"}
            </button>
          </>
        ) : (
          <>
            <p className="mt-3 text-center text-[11px] leading-4 text-[var(--dim)]">
              Paste the Client ID of your Spotify app. It stays on this
              computer only.
            </p>
            <input
              type="text"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="Spotify Client ID"
              aria-label="Spotify Client ID"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="mt-2 h-8 w-full rounded border border-[var(--border)] bg-transparent px-2 text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--dim)] focus:border-[var(--accent)]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void connect(manualId)}
              className="mt-2 w-full rounded bg-[var(--accent)] py-1.5 text-[13px] font-semibold text-[#06130a] disabled:opacity-50"
            >
              {busy ? "Opening Spotify…" : "Save & connect"}
            </button>
            {clientId === undefined && (
              <p className="mt-2 text-center text-[11px] text-[var(--dim)]">
                Checking for your Client ID…
              </p>
            )}
            {configFailed && (
              <p className="mt-2 text-center text-[11px] leading-4 text-[#ffb4b4]" role="alert">
                Couldn't reach the local server — restart sov.
              </p>
            )}
            <p className="mt-2 text-center text-[11px] leading-4 text-[var(--dim)]">
              Create one at developer.spotify.com/dashboard with redirect URI
              http://127.0.0.1:8888/callback.
            </p>
          </>
        )}
        {error && (
          <p className="mt-2 text-center text-[13px] text-[#ffb4b4]" role="alert">
            {error}
          </p>
        )}
        <p className="mt-2 text-center text-[11px] text-[var(--dim)]">
          Playback control needs Spotify Premium.
        </p>
        <p className="mt-2 text-center text-[11px] leading-4 text-[var(--dim)]">
          sov · server {serverOk === null ? "…" : serverOk ? "ok" : "unreachable"}{" "}
          · build {build ?? CLIENT_BUILD}
        </p>

      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The overlay: collapsed ring ⇄ minimal player                        */
/* ------------------------------------------------------------------ */

type Section = "lyrics" | "queue" | "library" | "settings" | null;

function Player({
  onNotConnected,
  settings,
  onSaveSettings,
  onSettingsReset,
  settingsNote,
  settingsRejected,
}: {
  onNotConnected: () => void;
  settings: SovSettings;
  onSaveSettings: (patch: Partial<SovSettings>) => void;
  onSettingsReset: () => void;
  settingsNote: string;
  settingsRejected: string[];
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const [section, setSection] = useState<Section>(null);
  const [message, setMessage] = useState("");
  const [messageOk, setMessageOk] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useWindowFit(wrapRef);

  // Whether the window is actually visible: the main process sends a
  // "sov:visibility" event on show/hide (tray), and
  // document.visibilitychange is a secondary signal. Polling intervals
  // below are driven by this.
  const [windowVisible, setWindowVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const off = onVisibility((visible) => setWindowVisible(visible));
    const onDoc = () => setWindowVisible(!document.hidden);
    document.addEventListener("visibilitychange", onDoc);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onDoc);
    };
  }, []);

  // True when running inside the desktop window (sizing, opacity).
  const [desktop, setDesktop] = useState(isDesktop());
  useEffect(() => {
    whenBridgeReady(() => setDesktop(true));
  }, []);
  const inDesktop = desktop;

  const [volume, setVolumeState] = useState<number>(50);
  const volumeTouchedAt = useRef(0);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whole-window opacity (0.2–1.0), persisted across restarts.
  const [windowOpacity, setWindowOpacity] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("sov:window-opacity"));
      return Number.isFinite(v) ? Math.min(1, Math.max(0.2, v)) : 1;
    } catch {
      return 1;
    }
  });
  const onOpacity = useCallback((value: number) => {
    const v = Math.min(1, Math.max(0.2, value));
    setWindowOpacity(v);
    try {
      localStorage.setItem("sov:window-opacity", String(v));
    } catch {
      // Storage unavailable — the opacity just won't persist.
    }
    requestOpacity(v);
  }, []);
  useEffect(() => {
    requestOpacity(windowOpacity);
    // Runs once with the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Log out / clear data (from the settings panel). Log out clears the
  // tokens; clear data also wipes everything sov stored on disk but
  // NOT the Client ID.
  const handleLogout = useCallback(async () => {
    logout();
    await clearServerTokens();
    onNotConnected();
  }, [onNotConnected]);
  const handleClearData = useCallback(async () => {
    await clearAllData();
    logout();
    await clearServerTokens();
    onSettingsReset();
    onNotConnected();
  }, [onNotConnected, onSettingsReset]);

  // Consecutive offline failures (network / rate-limit) — drives the
  // automatic retry backoff: 1s, 2s, 4s … capped at 30s.
  const offlineFailuresRef = useRef(0);

  const playbackQuery = useQuery({
    queryKey: ["playback"],
    queryFn: fetchPlayback,
    // ~1s while expanded and visible, ~5s while collapsed, ~20s while
    // hidden to the tray — never sooner than a Spotify 429 backoff or
    // the offline retry backoff.
    refetchInterval: () => {
      const backoff = getRateLimitDelayMs();
      const offlineBackoff =
        offlineFailuresRef.current > 0
          ? Math.min(30_000, 1000 * 2 ** (offlineFailuresRef.current - 1))
          : 0;
      const base = !windowVisible ? 20_000 : expanded ? 1000 : 5000;
      return Math.max(base, backoff, offlineBackoff);
    },
    refetchIntervalInBackground: true,
    retry: false,
  });
  const playback = playbackQuery.data ?? null;
  // Devices, only while idle: the hint can then say a device is
  // available instead of just "open Spotify and press play".
  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: fetchDevices,
    enabled: !playback?.hasItem && windowVisible,
    refetchInterval: 5000,
    retry: false,
  });
  const devices = devicesQuery.data ?? [];
  const bestDevice = pickBestDevice(devices);
  const coverUrl = playback?.imageUrl ?? null;

  // Now-playing toast: when the track changes while playing, show a
  // small overlay banner for ~4s. Only while EXPANDED — the window never
  // auto-expands for a toast. Absolutely positioned so it never changes
  // the panel's measured size.
  const [toast, setToast] = useState<{
    title: string;
    artists: string;
    cover: string | null;
  } | null>(null);
  const prevTrackUriRef = useRef("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const uri = playback?.trackUri ?? "";
    const prev = prevTrackUriRef.current;
    prevTrackUriRef.current = uri;
    if (!uri || uri === prev || !playback?.isPlaying || !expanded) return;
    setToast({
      title: playback.title,
      artists: playback.artists,
      cover: coverUrl,
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, [playback?.trackUri, playback?.isPlaying, expanded, playback, coverUrl]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (
      playbackQuery.error instanceof PlayerError &&
      playbackQuery.error.status === 401
    ) {
      onNotConnected();
    }
  }, [playbackQuery.error, onNotConnected]);

  // Offline state: network / rate-limit failures are NOT a logout — the
  // player stays with a banner and retries with backoff. Only an
  // explicit 401 routes to Connect.
  const playbackError =
    playbackQuery.error instanceof PlayerError ? playbackQuery.error : null;
  const isOfflineError =
    !!playbackError &&
    playbackError.status !== 401 &&
    (playbackError.reason === "NETWORK_ERROR" ||
      playbackError.reason === "RETRYABLE" ||
      playbackError.reason === "RATE_LIMITED" ||
      playbackError.status === 0 ||
      playbackError.status === 429);
  const offlineBackoffMs =
    offlineFailuresRef.current > 0
      ? Math.min(30_000, 1000 * 2 ** (offlineFailuresRef.current - 1))
      : 0;
  useEffect(() => {
    if (isOfflineError) offlineFailuresRef.current += 1;
    else if (!playbackQuery.isError) offlineFailuresRef.current = 0;
  }, [playbackQuery.error, playbackQuery.isError, isOfflineError]);
  const retryNow = useCallback(() => {
    offlineFailuresRef.current = 0;
    void playbackQuery.refetch();
  }, [playbackQuery]);

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
  // Progress ticker: runs only while the player is expanded, visible and
  // actually playing — and only writes state when the displayed 250ms
  // bucket changes.
  const tickerActive = windowVisible && expanded && base.isPlaying;
  useEffect(() => {
    if (!tickerActive) return;
    let raf = 0;
    let lastBucket = Math.floor(Date.now() / 250);
    const tick = () => {
      const bucket = Math.floor(Date.now() / 250);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        setNow(Date.now());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tickerActive]);
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
    if (isPlaying) {
      void send({ kind: "pause" }, () =>
        setBase(() => ({
          progressMs: currentMs,
          at: Date.now(),
          isPlaying: false,
        })),
      );
      return;
    }
    // Playing transfers playback to the best available device first
    // when there is no active device, so the button actually starts
    // music instead of silently doing nothing.
    void send({ kind: "play" }, () =>
      setBase((b) => ({ ...b, at: Date.now(), isPlaying: true })),
    );
  }, [isPlaying, send, currentMs]);

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

  const playPlaylist = useCallback(
    async (playlist: PlaylistResult) => {
      try {
        await playContext(playlist.uri);
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
      }
    },
    [queryClient, onNotConnected],
  );

  // Expand/collapse are driven by the toggle (hotkey or ring click),
  // owned by the main process; in a plain browser the click toggles
  // locally. One 150ms opacity/transform transition, nothing else.
  const expand = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    setExpanded(true);
  };
  const collapse = () => {
    if (!expanded || closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setExpanded(false);
      setClosing(false);
      setEntered(false);
      closeTimer.current = null;
    }, 150);
  };
  useEffect(() => {
    if (!expanded) return;
    const id = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(id);
  }, [expanded]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  // The handlers are read through refs so the subscription (registered
  // once) always calls the latest render's functions.
  const expandRef = useRef(expand);
  const collapseRef = useRef(collapse);
  expandRef.current = expand;
  collapseRef.current = collapse;
  useEffect(() => {
    const off = onToggle((on) => {
      if (on) expandRef.current();
      else collapseRef.current();
    });
    return () => {
      off();
    };
  }, []);
  // Tell the main process the player is mounted, so the hotkey toggle
  // knows there is a player to toggle.
  useEffect(() => {
    setPlayerActive(true);
    return () => setPlayerActive(false);
  }, []);
  const toggle = () => {
    if (requestToggle()) return;
    if (expanded) collapse();
    else expand();
  };

  // Only the ring (collapsed) and the cover/title header (expanded) move
  // the window, and only after >4px of movement.
  const ringDrag = useWindowDrag();
  const headerDrag = useWindowDrag();
  const controlsDisabled = !playback?.hasItem;

  // Fixed panel widths — never viewport-relative, so the window size is
  // exactly panel + 16 and a preset always maps to the same width.
  const panelWidth =
    settings.sizePreset === "small"
      ? 300
      : settings.sizePreset === "large"
        ? 380
        : 340;

  const toggleSection = (next: Exclude<Section, null>) =>
    setSection((s) => (s === next ? null : next));

  return (
    <div
      ref={wrapRef}
      className={`fixed z-10 touch-none select-none ${
        inDesktop ? "bottom-2 right-2" : "bottom-4 right-4"
      }`}
    >
      {!expanded ? (
        <button
          type="button"
          aria-label={
            playback?.hasItem
              ? `Open player — ${playback.title} by ${playback.artists}`
              : "Open Spotify player"
          }
          aria-expanded={false}
          onClick={() => {
            // A press that turned into a drag must not toggle.
            if (ringDrag.draggedRef.current) return;
            toggle();
          }}
          {...ringDrag.handlers}
          className="grid h-[54px] w-[54px] cursor-grab touch-none place-items-center overflow-hidden rounded-full bg-[var(--surface)] active:cursor-grabbing"
        >
          <Ring size={54} fraction={fraction} />
        </button>
      ) : (
        <section
          aria-label="Spotify player"
          style={{
            width: panelWidth,
            opacity: closing || !entered ? 0 : 1,
            transform:
              closing || !entered ? "translateY(4px)" : "translateY(0)",
          }}
          className="overlay-panel relative flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <button
            type="button"
            aria-label="Collapse to ring"
            onClick={toggle}
            className="absolute right-2 top-2 z-10 grid h-7 w-7 place-items-center text-[var(--dim)] hover:text-[var(--text)]"
          >
            <Icon d={PATHS.shrink} size={14} />
          </button>

          {toast && (
            <div
              className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-center gap-2 rounded border border-[var(--border)] bg-[#161a1c] px-2 py-1.5"
              role="status"
            >
              {toast.cover && (
                <img
                  src={toast.cover}
                  alt=""
                  width={24}
                  height={24}
                  className="h-6 w-6 flex-none rounded object-cover"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-4">
                  {toast.title}
                </span>
                <span className="block truncate text-[11px] leading-4 text-[var(--dim)]">
                  {toast.artists}
                </span>
              </span>
            </div>
          )}

          <header
            {...headerDrag.handlers}
            className="flex cursor-grab touch-none select-none items-start gap-3 pr-7 active:cursor-grabbing"
          >
            <div className="grid h-[88px] w-[88px] flex-none place-items-center overflow-hidden rounded bg-[rgba(255,255,255,0.04)]">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={
                    playback?.album
                      ? `Album art for ${playback.album}`
                      : "Album cover"
                  }
                  draggable={false}
                  width={88}
                  height={88}
                  className="h-[88px] w-[88px] object-cover"
                />
              ) : (
                <Ring size={64} fraction={fraction} />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-1">
              {playback?.hasItem ? (
                <>
                  <p className="truncate text-[13px] font-semibold leading-5">
                    {playback.title}
                  </p>
                  <p className="truncate text-[11px] leading-4 text-[var(--dim)]">
                    {playback.artists}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[13px] font-semibold leading-5">
                    Nothing playing
                  </p>
                  <p className="text-[11px] leading-4 text-[var(--dim)]">
                    {isOfflineError
                      ? "Spotify is unreachable right now."
                      : playbackQuery.isError
                        ? "Couldn't reach Spotify."
                        : bestDevice
                          ? `Spotify is open on ${bestDevice.name} — press play.`
                          : "Open Spotify and press play once."}
                  </p>
                </>
              )}
            </div>
          </header>
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
            className="mt-3 w-full cursor-pointer py-1"
          >
            <div className="h-[3px] w-full rounded-full bg-[rgba(255,255,255,0.14)]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, fraction * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex w-full justify-between text-[11px] tabular-nums text-[var(--dim)]">
            <span>{fmt(currentMs)}</span>
            <span>{fmt(durationMs)}</span>
          </div>

          <div className="mt-2 flex items-center justify-center gap-2">
            <button
              type="button"
              aria-label="Previous track"
              disabled={controlsDisabled}
              onClick={() => void send({ kind: "previous" })}
              className="grid h-9 w-9 place-items-center text-[var(--text)] disabled:opacity-35"
            >
              <Icon d={PATHS.prev} size={20} />
            </button>
            <button
              type="button"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={togglePlay}
              className="grid h-10 w-10 place-items-center rounded-full bg-[var(--accent)] text-[#06130a] disabled:opacity-35"
            >
              <Icon d={isPlaying ? PATHS.pause : PATHS.play} size={22} />
            </button>
            <button
              type="button"
              aria-label="Next track"
              disabled={controlsDisabled}
              onClick={() => void send({ kind: "next" })}
              className="grid h-9 w-9 place-items-center text-[var(--text)] disabled:opacity-35"
            >
              <Icon d={PATHS.next} size={20} />
            </button>
          </div>

          <div className="mt-2 flex items-center justify-center gap-1">
            <button
              type="button"
              aria-label={section === "lyrics" ? "Hide lyrics" : "Show lyrics"}
              aria-expanded={section === "lyrics"}
              disabled={controlsDisabled}
              onClick={() => toggleSection("lyrics")}
              className={`grid h-8 w-8 place-items-center disabled:opacity-35 ${
                section === "lyrics"
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              <Icon d={PATHS.lyrics} size={16} />
            </button>
            <button
              type="button"
              aria-label={section === "queue" ? "Hide queue" : "Show queue"}
              aria-expanded={section === "queue"}
              onClick={() => toggleSection("queue")}
              className={`grid h-8 w-8 place-items-center ${
                section === "queue"
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              <Icon d={PATHS.queue} size={16} />
            </button>
            <button
              type="button"
              aria-label={
                section === "library" ? "Hide library" : "Show library"
              }
              aria-expanded={section === "library"}
              onClick={() => toggleSection("library")}
              className={`grid h-8 w-8 place-items-center ${
                section === "library"
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              <Icon d={PATHS.library} size={16} />
            </button>
            <button
              type="button"
              aria-label={
                section === "settings" ? "Hide settings" : "Show settings"
              }
              aria-expanded={section === "settings"}
              onClick={() => toggleSection("settings")}
              className={`grid h-8 w-8 place-items-center ${
                section === "settings"
                  ? "text-[var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              <Icon d={PATHS.gear} size={16} />
            </button>
          </div>

          {section && (
            <div className="mt-2 h-[220px] w-full">
              {section === "lyrics" && playback?.hasItem && (
                <LyricsView
                  playback={playback}
                  currentMs={currentMs}
                  onSeek={seekTo}
                  offsetMs={settings.lyricsOffsetMs}
                />
              )}
              {section === "queue" && (
                <QueueSection
                  onPlay={playTrack}
                  onAdd={queueTrack}
                  visible={windowVisible}
                />
              )}
              {section === "library" && (
                <LibrarySection
                  onPlay={playTrack}
                  onAdd={queueTrack}
                  onPlayPlaylist={playPlaylist}
                  onReconnect={onNotConnected}
                />
              )}
              {section === "settings" && (
                <SettingsSection
                  settings={settings}
                  onSave={onSaveSettings}
                  onLogout={() => void handleLogout()}
                  onClearData={() => void handleClearData()}
                  note={settingsNote}
                  rejected={settingsRejected}
                  volume={volume}
                  onVolume={onVolume}
                  volumeDisabled={controlsDisabled}
                  opacity={windowOpacity}
                  onOpacity={onOpacity}
                  opacityDisabled={!inDesktop}
                />
              )}
            </div>
          )}

          <p
            className={`mt-2 h-4 truncate text-center text-[11px] leading-4 ${
              messageOk ? "text-[var(--accent)]" : "text-[#ffb4b4]"
            }`}
            role={message ? (messageOk ? "status" : "alert") : undefined}
          >
            {message}
          </p>

          {isOfflineError && (
            <div
              className="mt-2 rounded border border-[rgba(255,176,32,0.4)] px-2 py-1.5 text-center"
              role="alert"
            >
              <p className="text-[11px] leading-4 text-[#ffd28a]">
                Spotify unreachable
                {offlineBackoffMs > 0
                  ? ` — retrying in ~${Math.ceil(offlineBackoffMs / 1000)}s`
                  : ""}
              </p>
              <button
                type="button"
                onClick={retryNow}
                className="mt-1 rounded border border-[var(--border)] px-2 py-0.5 text-[11px]"
              >
                Retry now
              </button>
            </div>
          )}

          {playbackQuery.error instanceof PlayerError &&
            playbackQuery.error.status === 403 && (
              <div className="mt-2 text-center">
                <p className="text-[11px] leading-4 text-[#ffb4b4]">
                  Spotify refused the connection — reconnect your login.
                </p>
                <button
                  type="button"
                  onClick={onNotConnected}
                  className="mt-1 rounded bg-[var(--accent)] px-2 py-1 text-[13px] font-semibold text-[#06130a]"
                >
                  Reconnect
                </button>
              </div>
            )}
        </section>

      )}
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

  // Settings: loaded once from the main process, applied live through
  // settings-set. The high-contrast class lives on this root so it
  // covers the Connect screen too.
  const [settings, setSettingsState] =
    useState<SovSettings>(DEFAULT_SETTINGS);
  const [settingsNote, setSettingsNote] = useState("");
  const [settingsRejected, setSettingsRejected] = useState<string[]>([]);
  const settingsNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const apply = (s: SovSettings | null) => {
      if (!cancelled && s) setSettingsState(s);
    };
    void getSettings().then((s) => {
      apply(s);
      // The bridge can lag behind React mounting on a slow first load.
      if (!s) whenBridgeReady(() => void getSettings().then(apply));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(
    () => () => {
      if (settingsNoteTimer.current) clearTimeout(settingsNoteTimer.current);
    },
    [],
  );
  const saveSettingsPatch = useCallback(
    async (patch: Partial<SovSettings>) => {
      const res = await setSettings(patch);
      if (!res) {
        // No desktop bridge (plain browser tab): apply locally so the UI
        // still responds, but it won't persist.
        setSettingsState((prev) => ({ ...prev, ...patch }));
        setSettingsRejected([]);
        setSettingsNote("Saved for this tab only — no desktop bridge.");
        return;
      }
      setSettingsState(res.settings);
      setSettingsRejected(res.rejected);
      setSettingsNote(
        res.ok ? "Saved." : "Saved, but some settings were rejected.",
      );
      if (settingsNoteTimer.current) clearTimeout(settingsNoteTimer.current);
      settingsNoteTimer.current = setTimeout(
        () => setSettingsNote(""),
        2500,
      );
    },
    [],
  );
  const resetSettingsState = useCallback(() => {
    setSettingsState(DEFAULT_SETTINGS);
    setSettingsRejected([]);
    setSettingsNote("");
  }, []);

  // Tokens live in safeStorage (desktop) or localStorage (plain browser
  // tab): load them into the cache first, so the isLoggedIn() check
  // below sees a stored desktop session instead of reporting "no
  // session" before the IPC has answered.
  useEffect(() => {
    let cancelled = false;
    void ensureTokensLoaded().then(() => {
      if (!cancelled) setPhase(isLoggedIn() ? "player" : "connect");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const showConnect = useCallback(() => {
    logout();
    setPhase("connect");
  }, []);
  const showPlayer = useCallback(() => setPhase("player"), []);

  return (
    <div className={settings.highContrast ? "high-contrast" : undefined}>
      {phase === "checking" && (
        <p className="p-2 text-[13px] text-[var(--dim)]">Loading…</p>
      )}
      {phase === "connect" && (
        <StandaloneConnect onConnected={showPlayer} />
      )}
      {phase === "player" && (
        <Player
          onNotConnected={showConnect}
          settings={settings}
          onSaveSettings={(patch) => void saveSettingsPatch(patch)}
          onSettingsReset={resetSettingsState}
          settingsNote={settingsNote}
          settingsRejected={settingsRejected}
        />
      )}
    </div>
  );
}

