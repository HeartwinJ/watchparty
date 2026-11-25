// Subtitle offset (PLAN 6b): pure helpers for stepping/formatting offsets and re-timing TextTrack cues.

/**
 * Converts SRT text to WebVTT (WebVTT input is returned as-is). Strips a BOM, normalizes line endings and turns SRT's
 * `00:00:01,500` timestamps into `00:00:01.500`. Replaces the srt-webvtt package, whose CommonJS default export
 * doesn't resolve under Vite 8 (room subtitles silently failed to load).
 */
export function toWebVtt(text: string): string {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^WEBVTT/.test(clean)) {
    return clean;
  }
  const body = clean.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})(\s*-->\s*)(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
    "$1.$2$3$4.$5",
  );
  return "WEBVTT\n\n" + body.trim() + "\n";
}

/** The slider and step buttons cover ±10 s; the server accepts up to ±30 s */
export const SUBTITLE_OFFSET_SLIDER_MAX = 10;
export const SUBTITLE_OFFSET_MAX = 30;
export const SUBTITLE_OFFSET_STEP = 0.1;

/** Clamps to ±30 s and rounds to 0.05 s (same as the server), without float noise or -0 */
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

export interface CueLike {
  startTime: number;
  endTime: number;
}

/**
 * Shifts every cue by `shift` seconds relative to its original timing. Originals are remembered in `originals` the
 * first time a cue is seen, so repeated calls never accumulate and the subtitle file isn't re-downloaded. Cues are
 * clamped at 0 (a negative start time is invalid).
 */
export function retimeCues(
  cues: ArrayLike<CueLike> | Iterable<CueLike>,
  shift: number,
  originals: WeakMap<CueLike, { start: number; end: number }>,
) {
  const list = Array.from(cues as ArrayLike<CueLike>);
  for (const cue of list) {
    let orig = originals.get(cue);
    if (!orig) {
      orig = { start: cue.startTime, end: cue.endTime };
      originals.set(cue, orig);
    }
    const start = Math.max(0, orig.start + shift);
    const end = Math.max(start, orig.end + shift);
    if (cue.startTime !== start) {
      cue.startTime = start;
    }
    if (cue.endTime !== end) {
      cue.endTime = end;
    }
  }
  return list.length;
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
