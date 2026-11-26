/**
 * Watch history / "Continue watching".
 *
 * One row per room + item in the `history` table. Items are keyed like subtitle offsets (subtitleOffsetKey):
 * AIOStreams picks by their title/episode id (`meta:tt0903747:2:4`), other videos by a hash of the URL without its
 * `#fragment`. Screen/file shares and an empty video are never recorded.
 *
 * The stored URL is used server-side only (POST /history/:id/resume). AIOStreams playback URLs carry a reusable
 * debrid credential, so nothing in here ever returns, logs or derives a title from them: listHistory() leaves the URL
 * out, and titles come from the video metadata, the picker's `#wp-name=` display name or a short safe name.
 */
import type { DatabaseSync } from "node:sqlite";
import { subtitleOffsetKey } from "./subtitleOffset.ts";
import { getYoutubeVideoID } from "./youtube.ts";

/** Rows kept in total (oldest pruned first) */
export const HISTORY_MAX_ROWS = 200;
/** How often a playing item's position is written (pause, seek and host changes write right away) */
export const HISTORY_SAVE_INTERVAL_MS = 30_000;
/** An item counts as finished once its position reaches this share of the duration (or it ended) */
export const HISTORY_FINISHED_RATIO = 0.9;
/** Positions below this aren't recorded, so briefly opening something doesn't add it */
export const HISTORY_MIN_POSITION = 10;
/** Longest accepted duration report (seconds), anything above is garbage */
const MAX_DURATION = 7 * 24 * 3600;

export type HistoryKind = "aiostreams" | "youtube" | "url";

/** What GET /history returns per row. Never contains the URL. */
export interface HistoryItem {
  id: number;
  roomId: string;
  kind: HistoryKind;
  title: string;
  /** "S02E04 · Episode title", "E05", or null */
  subtitle: string | null;
  poster: string | null;
  /** Seconds */
  position: number;
  /** Seconds, null when no viewer reported it yet */
  duration: number | null;
  /** ms since epoch */
  updatedAt: number;
  finished: boolean;
  /** Items with the same group are the same title (a series' episodes share one), used to dedupe */
  group: string;
}

/** A full row, including the server-only URL and metadata (for resuming) */
export interface HistoryEntry extends HistoryItem {
  itemKey: string;
  url: string;
  meta: VideoMeta | null;
}

interface HistoryRow {
  id: number;
  roomId: string;
  itemKey: string;
  groupKey: string;
  kind: string;
  title: string;
  subtitle: string | null;
  poster: string | null;
  meta: string | null;
  url: string;
  position: number;
  duration: number | null;
  finished: number;
  updatedAt: number;
}

// --- Describing an item (pure) ---

const DISPLAY_NAME_PARAM = "wp-name=";
const TITLE_MAX = 200;

/** The readable name the picker attaches to a URL (`#wp-name=...`, see withDisplayName on the client) */
export function getAttachedDisplayName(url: string): string | undefined {
  const hash = url.indexOf("#");
  if (hash < 0) {
    return undefined;
  }
  const part = url
    .slice(hash + 1)
    .split("&")
    .find((p) => p.startsWith(DISPLAY_NAME_PARAM));
  if (!part) {
    return undefined;
  }
  try {
    const name = decodeURIComponent(part.slice(DISPLAY_NAME_PARAM.length));
    return name.trim().slice(0, TITLE_MAX) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A short name for a URL without a display name: the file name when the last path segment looks like one
 * (`movie.mp4`), otherwise the host name. Never the full URL, query or other path segments, which may hold tokens.
 */
export function safeUrlName(url: string): string {
  try {
    const parsed = new URL(url.split("#")[0]);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    let segment = "";
    try {
      segment = decodeURIComponent(last);
    } catch {
      segment = "";
    }
    if (
      segment.length <= 100 &&
      /^[^/?#]+\.[a-z0-9]{2,5}$/i.test(segment) &&
      // Long unbroken runs look like ids/tokens rather than names
      !/[A-Za-z0-9_-]{40,}/.test(segment)
    ) {
      return segment;
    }
    return parsed.hostname || "Video";
  } catch {
    return "Video";
  }
}

/** "S02E04", "E05" (anime without seasons) or "" */
export function formatEpisodeCode(meta: VideoMeta): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (meta.episode == null) {
    return "";
  }
  return meta.season != null
    ? `S${pad(meta.season)}E${pad(meta.episode)}`
    : `E${pad(meta.episode)}`;
}

export interface ItemDescription {
  itemKey: string;
  groupKey: string;
  kind: HistoryKind;
  title: string;
  subtitle: string | null;
  poster: string | null;
}

/** The base title id of an addon id: "tt0903747:2:4" → "tt0903747", "kitsu:11:5" → "kitsu:11" */
function baseTitleId(meta: VideoMeta) {
  if (meta.imdbId) {
    return meta.imdbId;
  }
  const parts = meta.id.split(":");
  return parts[0] === "kitsu" ? parts.slice(0, 2).join(":") : parts[0];
}

/**
 * How a video shows up in the history, or undefined when it isn't recorded (nothing playing, screen/file shares).
 * `hint` is the playlist item's name/thumbnail when the video came from the queue.
 */
export function describeHistoryItem(
  video: string | null | undefined,
  meta: VideoMeta | null,
  hint?: { name?: string | null; img?: string | null } | null,
): ItemDescription | undefined {
  const itemKey = subtitleOffsetKey(video, meta);
  if (!itemKey || !video) {
    return undefined;
  }
  if (meta) {
    const code = formatEpisodeCode(meta);
    const subtitle =
      [code, meta.episodeTitle].filter(Boolean).join(" · ") || null;
    return {
      itemKey,
      groupKey: "meta:" + baseTitleId(meta),
      kind: "aiostreams",
      title: (meta.title || "Untitled").slice(0, TITLE_MAX),
      subtitle,
      poster: meta.poster,
    };
  }
  const hintName = hint?.name && hint.name !== video ? hint.name : undefined;
  const ytId = getYoutubeVideoID(video);
  if (ytId) {
    return {
      itemKey,
      groupKey: itemKey,
      kind: "youtube",
      title: (getAttachedDisplayName(video) ?? hintName ?? "YouTube video")
        .trim()
        .slice(0, TITLE_MAX),
      subtitle: null,
      poster: `https://i.ytimg.com/vi/${encodeURIComponent(ytId)}/hqdefault.jpg`,
    };
  }
  return {
    itemKey,
    groupKey: itemKey,
    kind: "url",
    title: (getAttachedDisplayName(video) ?? hintName ?? safeUrlName(video))
      .trim()
      .slice(0, TITLE_MAX),
    subtitle: null,
    poster: hint?.img && /^https:\/\//.test(hint.img) ? hint.img : null,
  };
}

/** Whether a position counts as watched to the end */
export function isFinished(
  position: number,
  duration: number | null | undefined,
  ended = false,
) {
  return (
    ended ||
    (typeof duration === "number" &&
      duration > 0 &&
      position >= duration * HISTORY_FINISHED_RATIO)
  );
}

/** Validates a CMD:duration report (seconds). Returns undefined for anything that isn't a sane duration. */
export function parseDuration(raw: unknown): number | undefined {
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw <= 0 ||
    raw > MAX_DURATION
  ) {
    return undefined;
  }
  return Math.round(raw * 10) / 10;
}

// --- Database ---

export interface HistoryWrite extends ItemDescription {
  roomId: string;
  url: string;
  meta: VideoMeta | null;
  position: number;
  duration: number | null;
  finished: boolean;
}

/**
 * Inserts or updates a room's entry for an item. A missing duration keeps the stored one, and the finished flag is
 * re-derived from it, so a report from before the restart still counts. Prunes to HISTORY_MAX_ROWS.
 */
export function upsertHistory(
  db: DatabaseSync,
  entry: HistoryWrite,
  now = Date.now(),
) {
  db.prepare(
    `INSERT INTO history (roomId, itemKey, groupKey, kind, title, subtitle, poster, meta, url, position, duration, finished, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(roomId, itemKey) DO UPDATE SET
       groupKey = excluded.groupKey, kind = excluded.kind, title = excluded.title, subtitle = excluded.subtitle,
       poster = COALESCE(excluded.poster, history.poster), meta = excluded.meta, url = excluded.url,
       position = excluded.position, duration = COALESCE(excluded.duration, history.duration),
       finished = CASE
         WHEN excluded.finished = 1 THEN 1
         WHEN COALESCE(excluded.duration, history.duration) > 0
           AND excluded.position >= ? * COALESCE(excluded.duration, history.duration) THEN 1
         ELSE 0 END,
       updatedAt = excluded.updatedAt`,
  ).run(
    entry.roomId,
    entry.itemKey,
    entry.groupKey,
    entry.kind,
    entry.title,
    entry.subtitle,
    entry.poster,
    entry.meta ? JSON.stringify(entry.meta) : null,
    entry.url,
    entry.position,
    entry.duration,
    entry.finished ? 1 : 0,
    now,
    HISTORY_FINISHED_RATIO,
  );
  pruneHistory(db);
}

export function pruneHistory(db: DatabaseSync, max = HISTORY_MAX_ROWS) {
  return Number(
    db
      .prepare(
        `DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY updatedAt DESC, id DESC LIMIT ?)`,
      )
      .run(max).changes,
  );
}

const toItem = (row: HistoryRow): HistoryItem => ({
  id: Number(row.id),
  roomId: row.roomId,
  kind: (["aiostreams", "youtube", "url"].includes(row.kind)
    ? row.kind
    : "url") as HistoryKind,
  title: row.title,
  subtitle: row.subtitle,
  poster: row.poster,
  position: Number(row.position),
  duration: row.duration == null ? null : Number(row.duration),
  updatedAt: Number(row.updatedAt),
  finished: Boolean(row.finished),
  group: row.groupKey,
});

/** Newest first, without URLs or metadata (safe to send to the Home page) */
export function listHistory(db: DatabaseSync, limit = 50): HistoryItem[] {
  const rows = db
    .prepare(
      `SELECT id, roomId, itemKey, groupKey, kind, title, subtitle, poster, position, duration, finished, updatedAt
       FROM history ORDER BY updatedAt DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as HistoryRow[];
  return rows.map(toItem);
}

/** The full entry (server-only: includes the URL) */
export function getHistoryEntry(
  db: DatabaseSync,
  id: number,
): HistoryEntry | undefined {
  const row = db.prepare("SELECT * FROM history WHERE id = ?").get(id) as
    HistoryRow | undefined;
  if (!row) {
    return undefined;
  }
  let meta: VideoMeta | null = null;
  try {
    meta = row.meta ? (JSON.parse(row.meta) as VideoMeta) : null;
  } catch {
    meta = null;
  }
  return { ...toItem(row), itemKey: row.itemKey, url: row.url, meta };
}

export function deleteHistory(db: DatabaseSync, id: number): boolean {
  return (
    Number(db.prepare("DELETE FROM history WHERE id = ?").run(id).changes) > 0
  );
}

export function deleteHistoryItem(
  db: DatabaseSync,
  roomId: string,
  itemKey: string,
) {
  db.prepare("DELETE FROM history WHERE roomId = ? AND itemKey = ?").run(
    roomId,
    itemKey,
  );
}

// --- Recording (one per room) ---

/** What the room is playing right now */
export interface PlaybackSnapshot {
  video: string | null;
  meta: VideoMeta | null;
  /** Seconds (the room's videoTS) */
  position: number;
  paused: boolean;
}

export type YoutubeLookup = (
  id: string,
) => Promise<{ name?: string; duration?: number } | null>;

/**
 * Records a room's playback into the history table. The room calls:
 * - tick() every second (writes at most every HISTORY_SAVE_INTERVAL_MS while playing),
 * - save() on pause and seek,
 * - beforeHostChange() with the outgoing video right before the video changes,
 * - metaAttached() when CMD:videoMeta gives the current video a title/episode identity,
 * - setDuration() for a viewer's CMD:duration report, markEnded() when the video played to its end.
 * Database errors are logged and swallowed: history must never break playback.
 */
export class HistoryRecorder {
  private db: DatabaseSync;
  private roomId: string;
  private now: () => number;
  private lookupYoutube: YoutubeLookup | undefined;
  private lastWriteAt = 0;
  /** The video the duration/ended/hint state belongs to */
  private current: string | null = null;
  private duration: number | null = null;
  private ended = false;
  private hint: { name?: string | null; img?: string | null } | null = null;
  private youtubeNames = new Map<string, string>();

  constructor(
    db: DatabaseSync,
    roomId: string,
    opts: { now?: () => number; lookupYoutube?: YoutubeLookup } = {},
  ) {
    this.db = db;
    this.roomId = roomId;
    this.now = opts.now ?? Date.now;
    this.lookupYoutube = opts.lookupYoutube;
  }

  /** Resets the per-video state when the room's video isn't the one it was collected for */
  private sync(video: string | null) {
    if (video !== this.current) {
      this.current = video;
      this.duration = null;
      this.ended = false;
      this.hint = null;
      this.lastWriteAt = 0;
    }
  }

  /** Name/thumbnail of the queue item that's about to play (call right before the host change) */
  setHint(video: string, hint: { name?: string | null; img?: string | null }) {
    this.sync(video);
    this.hint = hint;
  }

  setDuration(video: string | null, raw: unknown) {
    const duration = parseDuration(raw);
    if (!video || duration === undefined) {
      return;
    }
    this.sync(video);
    this.duration = duration;
  }

  markEnded(video: string | null) {
    this.sync(video);
    this.ended = true;
  }

  /** Writes now (pause, seek, host change) */
  save(snap: PlaybackSnapshot) {
    this.sync(snap.video);
    if (snap.position < 0) {
      // Live streams report negative positions: nothing to resume
      return;
    }
    if (snap.position < HISTORY_MIN_POSITION && !this.ended) {
      return;
    }
    const desc = describeHistoryItem(snap.video, snap.meta, this.hint);
    if (!desc || !snap.video) {
      return;
    }
    if (desc.kind === "youtube") {
      this.fillYoutubeName(desc);
    }
    const position = Math.round(snap.position * 10) / 10;
    try {
      upsertHistory(
        this.db,
        {
          ...desc,
          roomId: this.roomId,
          url: snap.video,
          meta: snap.meta,
          position,
          duration: this.duration,
          finished: isFinished(position, this.duration, this.ended),
        },
        this.now(),
      );
      this.lastWriteAt = this.now();
    } catch (e) {
      console.warn("[history] failed to save:", e);
    }
  }

  /** Called every second; writes while playing, at most every HISTORY_SAVE_INTERVAL_MS */
  tick(snap: PlaybackSnapshot) {
    this.sync(snap.video);
    if (snap.paused || !snap.video) {
      return;
    }
    if (this.now() - this.lastWriteAt < HISTORY_SAVE_INTERVAL_MS) {
      return;
    }
    this.save(snap);
  }

  /** Saves the outgoing video's position; the next video starts fresh */
  beforeHostChange(outgoing: PlaybackSnapshot) {
    this.save(outgoing);
    this.sync(null);
  }

  /**
   * The current video just got its title/episode identity. Rows written before that were keyed by URL (and would
   * keep the playback URL around under the wrong key), so drop them and save under the new key.
   */
  metaAttached(snap: PlaybackSnapshot) {
    const urlKey = subtitleOffsetKey(snap.video, null);
    if (urlKey) {
      try {
        deleteHistoryItem(this.db, this.roomId, urlKey);
      } catch (e) {
        console.warn("[history] failed to re-key:", e);
      }
    }
    this.save(snap);
  }

  /** YouTube titles come from the Data API when it's configured (looked up once per video, in the background) */
  private fillYoutubeName(desc: ItemDescription) {
    if (desc.title !== "YouTube video" || !this.lookupYoutube) {
      return;
    }
    const id = desc.itemKey;
    const known = this.youtubeNames.get(id);
    if (known !== undefined) {
      if (known) {
        desc.title = known;
      }
      return;
    }
    this.youtubeNames.set(id, "");
    const video = this.current;
    if (!video) {
      return;
    }
    const ytId = getYoutubeVideoID(video);
    if (!ytId) {
      return;
    }
    this.lookupYoutube(ytId)
      .then((info) => {
        const name = info?.name?.trim().slice(0, TITLE_MAX);
        if (name) {
          this.youtubeNames.set(id, name);
          this.db
            .prepare(
              "UPDATE history SET title = ? WHERE roomId = ? AND itemKey = ?",
            )
            .run(name, this.roomId, id);
        }
        if (info?.duration && this.current === video && !this.duration) {
          this.duration = parseDuration(info.duration) ?? null;
        }
      })
      .catch(() => {
        // No API key or quota: the generic title stays
      });
  }
}
