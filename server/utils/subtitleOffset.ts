import { createHash } from "node:crypto";

/**
 * Not a usability limit (offsets can be anything a video could need), just a sanity bound on what's stored: ±24 h.
 */
export const SUBTITLE_OFFSET_MAX = 24 * 60 * 60;

/**
 * Validates a CMD:subtitleOffset payload: a finite number, clamped to ±24 h and rounded to 0.05 s.
 * Returns undefined for anything else.
 */
export function normalizeSubtitleOffset(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.min(
    SUBTITLE_OFFSET_MAX,
    Math.max(-SUBTITLE_OFFSET_MAX, value),
  );
  // Round to 0.05, then strip float noise (0.30000000000000004) and -0
  const rounded = Number((Math.round(clamped * 20) / 20).toFixed(2));
  return rounded === 0 ? 0 : rounded;
}

/**
 * The key a video's subtitle offset is saved under (subtitle_offsets table), or undefined when the video has no
 * stable identity (nothing playing, screen/file shares).
 * AIOStreams picks are keyed by their title/episode id (`meta:tt0903747:2:4`), because their playback URLs change
 * per pick and embed a credential. Other videos are keyed by a hash of the URL without its `#fragment` (the picker
 * stores the display name there).
 */
export function subtitleOffsetKey(
  video: string | null | undefined,
  meta?: { id?: unknown } | null,
) {
  if (meta && typeof meta.id === "string" && meta.id) {
    return "meta:" + meta.id;
  }
  if (
    !video ||
    video.startsWith("screenshare://") ||
    video.startsWith("fileshare://")
  ) {
    return undefined;
  }
  const withoutFragment = video.split("#")[0];
  return "url:" + createHash("sha256").update(withoutFragment).digest("hex");
}
