import { cyrb53 } from "../../utils/hash";

/** Number of `--wp-avatar-*` colours in tokens.css */
export const AVATAR_COLOR_COUNT = 8;

/** A stable avatar colour for a user id: `var(--wp-avatar-N)`, picked by hashing the id. */
export function avatarColor(id: string): string {
  const index = (Math.abs(cyrb53(id || "?")) % AVATAR_COLOR_COUNT) + 1;
  return `var(--wp-avatar-${index})`;
}

/** One or two letters for an avatar: the first letter of the first two words of the name. */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join("");
}
