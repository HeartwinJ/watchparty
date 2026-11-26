// Skip intro (roomSettings.skipIntro): a video the room switches to starts this many seconds in instead of at 0.
// Pure helpers plus a tiny per-video tracker; the Room applies the effects (REC:host videoTS, REC:introSkip, REC:seek).

/** The longest skip, in seconds (10 minutes) */
export const SKIP_INTRO_MAX = 600;
/** Videos shorter than this (seconds) are never skipped into: clips, trailers, music videos */
export const SKIP_INTRO_MIN_DURATION = 300;
/**
 * The skip is undone (back to 0) when the reported duration shows it doesn't fit, but only while the room is still
 * within this many seconds of the skip point (later reports are just the 30 s refresh).
 */
export const SKIP_INTRO_UNDO_WINDOW = 30;

/** The skip-intro setting: an integer number of seconds, clamped to 0–600 (0 = off). */
export function normalizeSkipIntro(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(SKIP_INTRO_MAX, Math.max(0, Math.round(raw)));
}

/** Whether a video of `duration` seconds is long enough to skip `skip` seconds into (at least 5 min and 2× the skip). */
export function introSkipFits(skip: number, duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration >= Math.max(SKIP_INTRO_MIN_DURATION, skip * 2)
  );
}

/**
 * Where a video the room just switched to starts. `from` is the position it was asked to start at: anything but 0
 * is kept as is (no caller passes one today; `preloadVideo`, used by history resume, doesn't skip at all). From the
 * beginning it's `skipIntro`, except for no video, screen/file shares (live P2P), anything that isn't an http(s)
 * URL, and a video whose duration is already known (a YouTube queue item) and too short.
 */
export function introSkipStart(opts: {
  skipIntro: number;
  video: string | null;
  from?: number;
  knownDuration?: number | null;
}): number {
  const from = opts.from ?? 0;
  if (from !== 0) {
    return from;
  }
  const skip = normalizeSkipIntro(opts.skipIntro) ?? 0;
  if (!skip || !opts.video || !/^https?:\/\//i.test(opts.video)) {
    return 0;
  }
  const known = opts.knownDuration;
  if (typeof known === "number" && known > 0 && !introSkipFits(skip, known)) {
    return 0;
  }
  return skip;
}

/** What to do about a skip after a report: nothing, or put everyone back at 0 (and hide the notice). */
export type IntroSkipVerdict = "keep" | "undo" | null;

/**
 * The current video's skip, from the host change until it's settled. A viewer's CMD:duration confirms it (`keep`)
 * or, if the video is too short and nobody has played/paused/seeked yet, undoes it (`undo`). A live stream (negative
 * CMD:ts) or a seek just ends it: there's nothing to undo then (a live stream's room time is relative to the live
 * edge, so the skip had no effect on it).
 */
export class IntroSkipTracker {
  private video: string | null = null;
  private seconds = 0;
  private interacted = false;
  private settled = false;

  /** A host change: `seconds` is where the new video starts (0 = not skipped) */
  start(video: string | null, seconds: number) {
    this.video = seconds > 0 ? video : null;
    this.seconds = seconds > 0 ? seconds : 0;
    this.interacted = false;
    this.settled = false;
  }

  /** The skipped seconds for `video` while the notice is meaningful, else 0 */
  active(video: string | null): number {
    return this.video !== null && this.video === video ? this.seconds : 0;
  }

  /** Someone played or paused: the skip can no longer be undone on its own */
  interact() {
    this.interacted = true;
  }

  /** A seek, a live stream or a new video: forget it. Returns whether a skip was active. */
  clear(): boolean {
    const was = this.video !== null;
    this.start(null, 0);
    return was;
  }

  /** CMD:duration for `video`, with the room's current time */
  duration(
    video: string | null,
    raw: unknown,
    roomTime: number,
  ): IntroSkipVerdict {
    if (this.video === null || video !== this.video || this.settled) {
      return null;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      return null;
    }
    if (introSkipFits(this.seconds, raw)) {
      this.settled = true;
      return "keep";
    }
    if (this.interacted || roomTime > this.seconds + SKIP_INTRO_UNDO_WINDOW) {
      this.settled = true;
      return "keep";
    }
    return "undo";
  }
}
