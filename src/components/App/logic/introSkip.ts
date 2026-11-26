// Skip intro (room setting `skipIntro`, see server/introSkip.ts): formatting, the settings presets and when the
// "Skipped intro" notice shows. Pure, so it's tested without a room.

/** Mirrors SKIP_INTRO_MAX in server/introSkip.ts (seconds) */
export const SKIP_INTRO_MAX = 600;

/** The settings' preset chips, in seconds (0 = off) */
export const SKIP_INTRO_PRESETS = [0, 15, 30, 45, 60, 90, 120] as const;

/** How long the "Skipped intro" notice stays up */
export const INTRO_SKIP_NOTICE_MS = 10_000;

/** Seconds as m:ss ("1:30", "0:45", "10:00") */
export function formatSkipIntro(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A preset chip's label: "Off", "15s", "45s", then m:ss from a minute on ("1:00", "1:30") */
export function skipIntroPresetLabel(seconds: number): string {
  if (!seconds) {
    return "Off";
  }
  return seconds < 60 ? `${seconds}s` : formatSkipIntro(seconds);
}

export const isSkipIntroPreset = (seconds: number) =>
  (SKIP_INTRO_PRESETS as readonly number[]).includes(seconds);

/**
 * Whether to show the "Skipped intro" notice: the room said the current video started past its intro (REC:introSkip),
 * less than INTRO_SKIP_NOTICE_MS ago, and it isn't a live stream (where the skip has no effect).
 */
export function showIntroSkipNotice(opts: {
  info: { seconds: number; at: number } | null;
  isLiveStream: boolean;
  now: number;
}): boolean {
  const { info } = opts;
  return Boolean(
    info &&
    info.seconds > 0 &&
    !opts.isLiveStream &&
    opts.now - info.at < INTRO_SKIP_NOTICE_MS,
  );
}
