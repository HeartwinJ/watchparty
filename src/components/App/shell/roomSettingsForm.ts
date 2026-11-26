// Pure helpers for the "Everyone in this room" form. The server validates again (server/roomSettings.ts); these only
// decide what's worth sending and mirror its limits so the inputs show what everyone will get.

export const ROOM_TITLE_MAX = 60;
export const NEXT_EPISODE_OFFSET_MIN = 5;
export const NEXT_EPISODE_OFFSET_MAX = 120;

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
 * The next-episode offset to send for a NumberInput value (number, or a string while typing), clamped to 5–120 and
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
