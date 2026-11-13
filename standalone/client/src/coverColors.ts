/**
 * Album-art colour extraction (Phase 3).
 *
 * Draws the current track's cover into a small offscreen canvas
 * (32x32) and samples it for a dominant colour and a vibrant accent.
 * Runs only on track change, never per frame.
 *
 * Honest limits:
 * - The cover is a remote image (https://i.scdn.co), so the canvas
 *   can be tainted by CORS. We set crossOrigin="anonymous" and wrap
 *   everything in try/catch; any failure (CORS, load error, tainted
 *   canvas) falls back to the default yellow/green palette.
 * - The accent is picked for brightness as well as saturation, so it
 *   stays readable when used as the active-lyric colour.
 */

export type CoverColors = {
  /** Bright, saturated colour — ring, progress arc, active lyric. */
  accent: string;
  /** Most common colour — progress fill. */
  dominant: string;
};

export const DEFAULT_COVER_COLORS: CoverColors = {
  accent: "#ffe81a",
  dominant: "#1ed760",
};

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function luminance(r: number, g: number, b: number): number {
  // Relative luminance, 0 (black) .. 1 (white).
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

function hue(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  if (max === min) return 0;
  const d = max - min;
  if (max === rn) return ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  if (max === gn) return ((bn - rn) / d + 2) * 60;
  return ((rn - gn) / d + 4) * 60;
}

type Bucket = {
  r: number;
  g: number;
  b: number;
  count: number;
};

export async function extractCoverColors(
  imageUrl: string,
): Promise<CoverColors> {
  try {
    if (!imageUrl) return DEFAULT_COVER_COLORS;
    const img = new Image();
    img.crossOrigin = "anonymous";
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("cover failed to load"));
      // Never hang the player on a slow image.
      window.setTimeout(() => reject(new Error("cover load timeout")), 5000);
    });
    img.src = imageUrl;
    await loaded;
    if (!img.naturalWidth || !img.naturalHeight) {
      return DEFAULT_COVER_COLORS;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return DEFAULT_COVER_COLORS;
    ctx.drawImage(img, 0, 0, 32, 32);
    // Throws SecurityError if the canvas is tainted (CORS) — caught below.
    const data = ctx.getImageData(0, 0, 32, 32).data;
    const buckets = new Map<number, Bucket>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 0;
      if (a < 128) continue; // transparent pixel
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      // 4-bit buckets: 4096 possible colours, cheap to tally.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const existing = buckets.get(key);
      if (existing) {
        existing.r += r;
        existing.g += g;
        existing.b += b;
        existing.count += 1;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
    }
    if (buckets.size === 0) return DEFAULT_COVER_COLORS;
    const list = [...buckets.values()].map((bk) => ({
      r: bk.r / bk.count,
      g: bk.g / bk.count,
      b: bk.b / bk.count,
      count: bk.count,
    }));
    // Dominant: most frequent colour with a mid luminance, so the
    // progress fill is visible on the dark panel. Fall back to the
    // plain most-frequent bucket if every colour is near-black/white.
    const readable = list.filter(
      (c) => luminance(c.r, c.g, c.b) > 0.12 && luminance(c.r, c.g, c.b) < 0.9,
    );
    const dominantPool = readable.length > 0 ? readable : list;
    const dominant = [...dominantPool].sort((x, y) => y.count - x.count)[0];
    if (!dominant) return DEFAULT_COVER_COLORS;
    // Accent: most saturated colour that is also bright enough to
    // read as text (active lyric) and distinct in hue from the
    // dominant colour when such a colour exists.
    const domHue = hue(dominant.r, dominant.g, dominant.b);
    const accentPool = list.filter((c) => {
      const lum = luminance(c.r, c.g, c.b);
      return lum >= 0.3 && lum <= 0.95 && saturation(c.r, c.g, c.b) >= 0.35;
    });
    const scored = (accentPool.length > 0 ? accentPool : list)
      .map((c) => {
        const hueDiff = Math.min(
          Math.abs(hue(c.r, c.g, c.b) - domHue),
          360 - Math.abs(hue(c.r, c.g, c.b) - domHue),
        );
        return {
          c,
          score:
            saturation(c.r, c.g, c.b) * Math.sqrt(c.count) +
            (hueDiff > 30 ? 2 : 0),
        };
      })
      .sort((x, y) => y.score - x.score);
    const accent = scored[0]?.c ?? dominant;
    return {
      accent: toHex(accent.r, accent.g, accent.b),
      dominant: toHex(dominant.r, dominant.g, dominant.b),
    };
  } catch {
    // CORS / load error / tainted canvas — default yellow palette.
    return DEFAULT_COVER_COLORS;
  }
}
