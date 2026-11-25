/**
 * Validation for the room's video metadata (CMD:videoMeta) and playback issue reports (CMD:playbackIssue).
 * Pure functions so they can be unit tested without a socket. Both payloads come from untrusted clients.
 */
import { isContentId } from "./addons/ids.ts";

/** Serialized size limit for one VideoMeta (it's stored with the room and in playlist items) */
export const VIDEO_META_MAX_BYTES = 4096;
const TITLE_MAX = 300;
const URL_MAX = 1000;
const BINGE_GROUP_MAX = 300;
export const ISSUE_REASON_MAX = 200;

const CONTENT_TYPES = ["movie", "series", "anime"] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const optString = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null || v === "") {
    return null;
  }
  if (typeof v !== "string" || v.length > max) {
    return undefined;
  }
  return v;
};

const optInt = (v: unknown, max: number): number | null | undefined => {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    return undefined;
  }
  return v;
};

const optHttpUrl = (v: unknown): string | null | undefined => {
  const s = optString(v, URL_MAX);
  if (s === undefined || s === null) {
    return s;
  }
  // Rendered as an <img src> by every client, so only plain web URLs
  return /^https?:\/\//i.test(s) ? s : undefined;
};

/**
 * Returns a clean VideoMeta (only known fields), or null when the payload is invalid.
 * `undefined` from the helpers above means "present but invalid".
 */
export function parseVideoMeta(raw: unknown): VideoMeta | null {
  if (!isObject(raw) || raw.source !== "aiostreams") {
    return null;
  }
  const type = raw.type;
  if (
    typeof type !== "string" ||
    !(CONTENT_TYPES as readonly string[]).includes(type)
  ) {
    return null;
  }
  if (!isContentId(raw.id)) {
    return null;
  }
  const imdbId = optString(raw.imdbId, 20);
  if (
    imdbId === undefined ||
    (imdbId !== null && !/^tt\d{1,10}$/.test(imdbId))
  ) {
    return null;
  }
  const season = optInt(raw.season, 10000);
  const episode = optInt(raw.episode, 100000);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const episodeTitle = optString(raw.episodeTitle, TITLE_MAX);
  const poster = optHttpUrl(raw.poster);
  const bingeGroup = optString(raw.bingeGroup, BINGE_GROUP_MAX);
  if (
    season === undefined ||
    episode === undefined ||
    !title ||
    title.length > TITLE_MAX ||
    episodeTitle === undefined ||
    poster === undefined ||
    bingeGroup === undefined
  ) {
    return null;
  }
  const meta: VideoMeta = {
    source: "aiostreams",
    type: type as VideoMeta["type"],
    id: raw.id,
    imdbId,
    season,
    episode,
    title,
    episodeTitle,
    poster,
    bingeGroup,
  };
  if (Buffer.byteLength(JSON.stringify(meta)) > VIDEO_META_MAX_BYTES) {
    return null;
  }
  return meta;
}

/** CMD:videoMeta payload: the meta applies only while `url` is still the room's video (guards against races). */
export function parseVideoMetaCommand(
  raw: unknown,
): { url: string; meta: VideoMeta | null } | null {
  if (!isObject(raw) || typeof raw.url !== "string" || !raw.url) {
    return null;
  }
  if (raw.meta === null) {
    return { url: raw.url, meta: null };
  }
  const meta = parseVideoMeta(raw.meta);
  return meta ? { url: raw.url, meta } : null;
}

/** CMD:playbackIssue payload → the trimmed reason, or null if invalid */
export function parsePlaybackIssue(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.reason !== "string") {
    return null;
  }
  // Single line, no control characters: it ends up in a toast for everyone
  const reason = raw.reason
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, ISSUE_REASON_MAX);
  return reason || null;
}

/**
 * Rate limit for playback issue reports: at most one per user per `perUserMs`, and at most `roomMax` per
 * `roomWindowMs` for the whole room (so a room full of failing viewers doesn't flood everyone with toasts).
 */
export function createIssueLimiter(
  opts: { perUserMs?: number; roomMax?: number; roomWindowMs?: number } = {},
) {
  const perUserMs = opts.perUserMs ?? 10_000;
  const roomMax = opts.roomMax ?? 6;
  const roomWindowMs = opts.roomWindowMs ?? 60_000;
  const lastByUser = new Map<string, number>();
  let recent: number[] = [];
  return {
    allow(userId: string, now = Date.now()): boolean {
      const last = lastByUser.get(userId);
      if (last !== undefined && now - last < perUserMs) {
        return false;
      }
      recent = recent.filter((t) => now - t < roomWindowMs);
      if (recent.length >= roomMax) {
        return false;
      }
      recent.push(now);
      lastByUser.set(userId, now);
      if (lastByUser.size > 500) {
        for (const [k, t] of lastByUser) {
          if (now - t >= perUserMs) {
            lastByUser.delete(k);
          }
        }
      }
      return true;
    },
  };
}

/** CMD:playlistAdd accepts a plain URL (legacy) or an item with a display name, image and metadata. */
export function parsePlaylistAdd(raw: unknown): {
  url: string;
  name: string | null;
  img: string | null;
  meta: VideoMeta | null;
} | null {
  if (typeof raw === "string") {
    return raw ? { url: raw, name: null, img: null, meta: null } : null;
  }
  if (!isObject(raw) || typeof raw.url !== "string" || !raw.url) {
    return null;
  }
  const name = optString(raw.name, TITLE_MAX);
  const img = optHttpUrl(raw.img);
  if (name === undefined || img === undefined) {
    return null;
  }
  const meta = raw.meta == null ? null : parseVideoMeta(raw.meta);
  if (raw.meta != null && !meta) {
    return null;
  }
  return { url: raw.url, name, img, meta };
}
