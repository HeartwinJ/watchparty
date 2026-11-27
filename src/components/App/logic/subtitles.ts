// Subtitle offset: pure helpers for stepping/formatting offsets and re-timing TextTrack cues.

import { cleanSubtitleText } from "./subtitleText";

/**
 * Converts SRT text to WebVTT (WebVTT input is returned as-is). Strips a BOM, normalizes line endings and turns SRT's
 * `00:00:01,500` timestamps into `00:00:01.500`. Replaces the srt-webvtt package, whose CommonJS default export
 * doesn't resolve under Vite 8 (room subtitles silently failed to load). Also repairs mojibake and strips ASS tags
 * (cleanSubtitleText).
 */
export function toWebVtt(text: string): string {
  const clean = cleanSubtitleText(
    text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"),
  );
  if (/^WEBVTT/.test(clean)) {
    return clean;
  }
  const body = clean.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
    "$1.$2$3$4.$5",
  );
  return "WEBVTT\n\n" + body.trim() + "\n";
}

/** The slider covers ±10 s; larger offsets are typed into the menu. ±24 h is only a sanity bound. */
export const SUBTITLE_OFFSET_SLIDER_MAX = 10;
export const SUBTITLE_OFFSET_MAX = 24 * 60 * 60;
export const SUBTITLE_OFFSET_STEP = 0.1;

/** Clamps to ±24 h and rounds to 0.05 s (same as the server), without float noise or -0 */
export function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(
    SUBTITLE_OFFSET_MAX,
    Math.max(-SUBTITLE_OFFSET_MAX, value),
  );
  const rounded = Number((Math.round(clamped * 20) / 20).toFixed(2));
  return rounded === 0 ? 0 : rounded;
}

/** current + delta, normalized (so ten presses of `]` are exactly +1.0, not 0.9999999) */
export function stepOffset(current: number, delta: number) {
  return normalizeOffset(current + delta);
}

/** "+0.3 s", "−1.25 s", "0.0 s" (a real minus sign) */
export function formatOffset(offset: number) {
  if (offset === 0) {
    return "0.0 s";
  }
  const abs = Math.abs(offset);
  const digits = Math.round(abs * 100) % 10 === 0 ? 1 : 2;
  return `${offset > 0 ? "+" : "−"}${abs.toFixed(digits)} s`;
}

/**
 * Parses an offset typed into the menu: seconds ("2.5", "+2.5", "-1.25 s", "−3" with a real minus) or minutes:seconds
 * ("1:30", "-1:05.5"). Returns the normalized offset, or undefined if it isn't a number.
 */
export function parseOffsetInput(raw: string): number | undefined {
  const text = raw
    .trim()
    .replace(/[\u2212\u2013]/g, "-")
    .replace(/\s*s(ec(onds?)?)?$/i, "")
    .replace(",", ".");
  const m = /^([+-])?(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(text);
  if (!m) {
    return undefined;
  }
  const [, sign, minutes, seconds] = m;
  const abs = Number(minutes ?? 0) * 60 + Number(seconds);
  if (minutes !== undefined && Number(seconds) >= 60) {
    return undefined;
  }
  return normalizeOffset(sign === "-" ? -abs : abs);
}

/** Plain-language hint under the value in the menu */
export function describeOffset(offset: number) {
  if (offset > 0) {
    return "subtitles appear later";
  }
  if (offset < 0) {
    return "subtitles appear earlier";
  }
  return "no offset";
}

export type SubtitleScope = "everyone" | "me";

/** The offset to apply: a "Just me" override wins over the room value until it's reset */
export function effectiveOffset(
  roomOffset: number,
  localOverride: number | null,
) {
  return localOverride ?? roomOffset;
}

/** Same as the server: a time scale (frame-rate drift) must be within 0.9–1.1 */
export const SUBTITLE_SCALE_MIN = 0.9;
export const SUBTITLE_SCALE_MAX = 1.1;

/** Rounds a time scale to 6 decimals (1 when that close), or 1 for anything outside 0.9–1.1 */
export function normalizeScale(value: number | undefined | null): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < SUBTITLE_SCALE_MIN ||
    value > SUBTITLE_SCALE_MAX
  ) {
    return 1;
  }
  const rounded = Number(value.toFixed(6));
  return Math.abs(rounded - 1) < 1e-6 ? 1 : rounded;
}

const FILM = 24000 / 1001;
/** Frame-rate pairs a scale usually comes from: scale = subtitle fps / video fps */
const FPS_PAIRS: [number, string, string][] = [
  [FILM / 24, "23.976", "24"],
  [24 / FILM, "24", "23.976"],
  [24 / 25, "24", "25"],
  [25 / 24, "25", "24"],
  [FILM / 25, "23.976", "25"],
  [25 / FILM, "25", "23.976"],
];

/**
 * "speed 0.959 (23.976→25 fps)" for a time scale (subtitles timed for 23.976 fps on a 25 fps video), "speed 1.0023"
 * for a scale that isn't a known frame-rate pair, "" for 1.
 */
export function describeScale(scale: number): string {
  if (scale === 1) {
    return "";
  }
  const pair = FPS_PAIRS.find(([ratio]) => Math.abs(ratio - scale) < 5e-6);
  const digits = Math.abs(scale - 1) < 0.01 ? 4 : 3;
  const speed = `speed ${scale.toFixed(digits)}`;
  return pair ? `${speed} (${pair[1]}→${pair[2]} fps)` : speed;
}

/** "+2.35 s", or "+2.35 s · speed 0.959 (23.976→25 fps)" with a scale */
export function formatTiming(offset: number, scale: number) {
  const s = describeScale(scale);
  return s ? `${formatOffset(offset)} · ${s}` : formatOffset(offset);
}

export interface CueLike {
  startTime: number;
  endTime: number;
}

/**
 * Re-times every cue to original × scale + shift (scale corrects frame-rate drift; 1 = a plain shift). Originals are
 * remembered in `originals` the first time a cue is seen, so repeated calls never accumulate and the subtitle file
 * isn't re-downloaded. Cues are clamped at 0 (a negative start time is invalid).
 */
export function retimeCues(
  cues: ArrayLike<CueLike> | Iterable<CueLike>,
  shift: number,
  originals: WeakMap<CueLike, { start: number; end: number }>,
  scale = 1,
) {
  const list = Array.from(cues as ArrayLike<CueLike>);
  for (const cue of list) {
    let orig = originals.get(cue);
    if (!orig) {
      orig = { start: cue.startTime, end: cue.endTime };
      originals.set(cue, orig);
    }
    const start = Math.max(0, orig.start * scale + shift);
    const end = Math.max(start, orig.end * scale + shift);
    if (cue.startTime !== start) {
      cue.startTime = start;
    }
    if (cue.endTime !== end) {
      cue.endTime = end;
    }
  }
  return list.length;
}

/**
 * The cues that should be on screen at `time`, in track order. Used instead of TextTrack.activeCues, which some
 * browsers leave stale after cue times change in place (offset re-timing): passed lines then piled up above the
 * current one. A cue is shown from its start up to (not including) its end.
 */
export function cuesAt<T extends { startTime: number; endTime: number }>(
  cues: ArrayLike<T> | null | undefined,
  time: number,
): T[] {
  const out: T[] = [];
  if (!cues || !Number.isFinite(time)) {
    return out;
  }
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.startTime <= time && time < c.endTime) {
      out.push(c);
    }
  }
  return out;
}

/** Subtitle style (per device) */
export type SubtitleSize = "s" | "m" | "l" | "xl";
export type SubtitleBackground = "none" | "shadow" | "box";
export const SUBTITLE_SIZE_SCALE: Record<SubtitleSize, number> = {
  s: 0.8,
  m: 1,
  l: 1.25,
  xl: 1.5,
};
