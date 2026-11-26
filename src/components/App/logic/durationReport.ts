// When to send CMD:duration (the server's watch history uses it to mark items finished, PLAN 6d).

/** Re-sent this often even when unchanged, so a room reloaded on the server learns it again */
export const DURATION_REPORT_INTERVAL_MS = 30_000;

export type DurationReport = { media: string; duration: number; at: number };

/**
 * The duration to report now, or undefined. Only for media with a real, finite runtime (not live streams or
 * shares): when the media or the (rounded) duration changed, or every DURATION_REPORT_INTERVAL_MS.
 */
export function nextDurationReport(
  last: DurationReport | null,
  opts: {
    media: string;
    duration: number;
    isLive: boolean;
    hasDuration: boolean;
    now: number;
  },
): number | undefined {
  const { media, duration, now } = opts;
  if (
    !media ||
    opts.isLive ||
    !opts.hasDuration ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return undefined;
  }
  if (
    !last ||
    last.media !== media ||
    Math.round(last.duration) !== Math.round(duration) ||
    now - last.at >= DURATION_REPORT_INTERVAL_MS
  ) {
    return duration;
  }
  return undefined;
}
