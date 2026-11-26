// Inserting text (e.g. a picked emoji) at the caret of a text input. Pure.

/**
 * `value` with `text` in place of the selection `start`..`end` (the caret when they're equal; null = the end, e.g. an
 * input that never had focus), and where the caret goes afterwards (right after the inserted text). Out-of-range or
 * reversed positions are clamped.
 */
export function insertAtCaret(
  value: string,
  text: string,
  start: number | null,
  end: number | null,
): { value: string; caret: number } {
  const len = value.length;
  const s = Math.min(Math.max(start ?? len, 0), len);
  const e = Math.min(Math.max(end ?? s, s), len);
  return {
    value: value.slice(0, s) + text + value.slice(e),
    caret: s + text.length,
  };
}
