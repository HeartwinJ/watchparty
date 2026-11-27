// Pure helpers for the "Everyone in this room" form. The server validates again (server/roomSettings.ts); these only
// decide what's worth sending and mirror its limits so the inputs show what everyone will get.
import { isSkipIntroPreset, SKIP_INTRO_MAX } from "../logic/introSkip";

export const ROOM_TITLE_MAX = 60;
export const NEXT_EPISODE_OFFSET_MIN = 5;
export const NEXT_EPISODE_OFFSET_MAX = 300;

/** The title to send for a draft (trimmed, whitespace collapsed, ≤ 60 chars), or undefined when nothing changed. */
export function titleToSend(
  draft: string,
  current: string,
): string | undefined {
  const title = Array.from(draft.replace(/\s+/g, " ").trim())
    .slice(0, ROOM_TITLE_MAX)
    .join("")
    .trim();
  return title === current ? undefined : title;
}

/**
 * The next-episode offset to send for a NumberInput value (number, or a string while typing), clamped to 5–300 and
 * rounded, or undefined when it's empty/invalid or unchanged.
 */
export function offsetToSend(
  value: string | number,
  current: number,
): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || !Number.isFinite(n)) {
    return undefined;
  }
  const offset = Math.min(
    NEXT_EPISODE_OFFSET_MAX,
    Math.max(NEXT_EPISODE_OFFSET_MIN, Math.round(n)),
  );
  return offset === current ? undefined : offset;
}

export const ROOM_PASSWORD_MIN = 4;
export const ROOM_PASSWORD_MAX = 64;

/** A custom room password draft: trimmed, 4–64 characters, no control characters (mirrors server/roomAccess.ts). */
export function roomPasswordToSend(draft: string): string | undefined {
  const pw = draft.trim();
  const length = Array.from(pw).length;
  // eslint-disable-next-line no-control-regex
  if (
    length < ROOM_PASSWORD_MIN ||
    length > ROOM_PASSWORD_MAX ||
    /[\u0000-\u001f\u007f-\u009f]/.test(pw)
  ) {
    return undefined;
  }
  return pw;
}

/** The custom skip-intro input's limits (0 is the "Off" chip, not a custom value) */
export const SKIP_INTRO_CUSTOM_MIN = 1;
export const SKIP_INTRO_CUSTOM_MAX = SKIP_INTRO_MAX;

/**
 * The skip-intro seconds to send for the custom NumberInput (number, or a string while typing): rounded and clamped to
 * 1–600, or undefined when it's empty/invalid or unchanged.
 */
export function skipIntroToSend(
  value: string | number,
  current: number,
): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || !Number.isFinite(n)) {
    return undefined;
  }
  const seconds = Math.min(
    SKIP_INTRO_CUSTOM_MAX,
    Math.max(SKIP_INTRO_CUSTOM_MIN, Math.round(n)),
  );
  return seconds === current ? undefined : seconds;
}

/**
 * Which chip is selected: the preset matching the room's value, or "custom" while the custom input is open or the
 * value isn't a preset.
 */
export function skipIntroChip(value: number, customOpen: boolean): string {
  return customOpen || !isSkipIntroPreset(value) ? "custom" : String(value);
}
