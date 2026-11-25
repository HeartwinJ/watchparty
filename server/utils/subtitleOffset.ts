import { createHash } from "node:crypto";

/** Room-wide subtitle offsets are clamped to ±30 s (the UI slider covers ±10 s, keys can go further). */
export const SUBTITLE_OFFSET_MAX = 30;

/**
 * Validates a CMD:subtitleOffset payload: a finite number, clamped to ±30 s and rounded to 0.05 s.
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
 * TODO: once the room stores AIOStreams metadata (PLAN 6c), key by IMDb id + episode instead, so the offset survives a
 * new debrid link for the same release.
 */
export function subtitleOffsetKey(video: string | null | undefined) {
  if (
    !video ||
    video.startsWith("screenshare://") ||
    video.startsWith("fileshare://")
  ) {
    return undefined;
  }
  return "url:" + createHash("sha256").update(video).digest("hex");
}
