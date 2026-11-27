// Room-wide settings (CMD:roomSettings / REC:roomSettings): validation, normalization and a light rate limit.
// Everything here is pure so it can be unit tested without a socket.
import { normalizeSkipIntro } from "./introSkip.ts";

export const ROOM_TITLE_MAX = 60;
export const NEXT_EPISODE_OFFSET_MIN = 5;
export const NEXT_EPISODE_OFFSET_MAX = 300;

export const DEFAULT_ROOM_SETTINGS: Readonly<RoomSettings> = Object.freeze({
  title: "",
  readyCheck: true,
  nextEpisodeOffset: 25,
  autoSyncSubtitles: false,
  skipIntro: 0,
});

/** The settings keys, in the order they're announced in chat */
export const ROOM_SETTINGS_KEYS = [
  "title",
  "readyCheck",
  "nextEpisodeOffset",
  "autoSyncSubtitles",
  "skipIntro",
] as const satisfies readonly (keyof RoomSettings)[];

// C0/C1 control characters, plus line/paragraph separators and bidi overrides/isolates (they can reorder the
// rest of the top bar or chat line)
const UNSAFE_CHARS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

/** A room title: control characters removed, whitespace collapsed, trimmed, at most 60 characters. */
export function normalizeRoomTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  // Bound the work before the regexes run on untrusted input
  const cleaned = raw
    .slice(0, ROOM_TITLE_MAX * 8)
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cut by code points so a surrogate pair is never split
  return Array.from(cleaned).slice(0, ROOM_TITLE_MAX).join("").trim();
}

/** Seconds before the end for the next-episode card: an integer clamped to 5–300. */
export function normalizeNextEpisodeOffset(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(
    NEXT_EPISODE_OFFSET_MAX,
    Math.max(NEXT_EPISODE_OFFSET_MIN, Math.round(raw)),
  );
}

/**
 * Validates an untrusted CMD:roomSettings patch. Unknown keys and keys with the wrong type are dropped; values are
 * normalized. Returns undefined when nothing valid is left.
 */
export function parseRoomSettingsPatch(
  raw: unknown,
): Partial<RoomSettings> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  const patch: Partial<RoomSettings> = {};
  const title = normalizeRoomTitle(data.title);
  if (title !== undefined) {
    patch.title = title;
  }
  if (typeof data.readyCheck === "boolean") {
    patch.readyCheck = data.readyCheck;
  }
  if (typeof data.autoSyncSubtitles === "boolean") {
    patch.autoSyncSubtitles = data.autoSyncSubtitles;
  }
  const offset = normalizeNextEpisodeOffset(data.nextEpisodeOffset);
  if (offset !== undefined) {
    patch.nextEpisodeOffset = offset;
  }
  const skipIntro = normalizeSkipIntro(data.skipIntro);
  if (skipIntro !== undefined) {
    patch.skipIntro = skipIntro;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Full settings from stored/untrusted data: the default for anything missing or invalid (old rooms have none). */
export function normalizeRoomSettings(raw: unknown): RoomSettings {
  return { ...DEFAULT_ROOM_SETTINGS, ...parseRoomSettingsPatch(raw) };
}

/** Applies a (validated) patch. `changed` lists the keys whose value actually changed (empty = no-op). */
export function applyRoomSettingsPatch(
  current: RoomSettings,
  patch: Partial<RoomSettings>,
): { settings: RoomSettings; changed: (keyof RoomSettings)[] } {
  const settings = { ...current, ...patch };
  const changed = ROOM_SETTINGS_KEYS.filter((k) => settings[k] !== current[k]);
  return { settings: changed.length ? settings : current, changed };
}

/** The keys whose value differs between two settings objects. */
export function diffRoomSettings(
  a: RoomSettings,
  b: RoomSettings,
): (keyof RoomSettings)[] {
  return ROOM_SETTINGS_KEYS.filter((k) => a[k] !== b[k]);
}

/**
 * A light per-room limit for settings changes: at most `max` accepted changes per `windowMs` (default 20 per 10 s).
 * Generous enough for typing/stepping through the settings, but stops a client from flooding the room.
 */
export function createSettingsLimiter(
  opts: { max?: number; windowMs?: number } = {},
) {
  const max = opts.max ?? 20;
  const windowMs = opts.windowMs ?? 10_000;
  let recent: number[] = [];
  return {
    allow(now = Date.now()): boolean {
      recent = recent.filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        return false;
      }
      recent.push(now);
      return true;
    },
  };
}
