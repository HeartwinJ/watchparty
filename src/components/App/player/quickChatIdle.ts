// Quick chat closes itself after it has been empty for a while (same in every browser; Esc in fullscreen belongs to
// the browser). Pure, with the time passed in.

/** How long an empty quick chat stays open */
export const QUICK_CHAT_IDLE_MS = 5_000;

/**
 * When the input became empty, after a change to `value` (null while it has text). Text cancels the countdown;
 * emptying it again starts a new one; staying empty (e.g. typing only spaces) keeps the running one.
 */
export function nextEmptySince(
  prev: number | null,
  value: string,
  now: number,
): number | null {
  if (value.trim()) {
    return null;
  }
  return prev ?? now;
}

/** How long until an empty quick chat closes (0 = now), or null while it has text */
export function idleDelay(
  emptySince: number | null,
  now: number,
  idleMs = QUICK_CHAT_IDLE_MS,
): number | null {
  if (emptySince === null) {
    return null;
  }
  return Math.max(0, emptySince + idleMs - now);
}
