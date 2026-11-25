/**
 * Rooms this device visited recently, newest first, for the home page.
 * TODO(wave 2): replace with server-side history (PLAN 6d "Continue watching / history") once it exists.
 */
export interface RecentRoom {
  roomId: string;
  /** Display name of the last video seen in the room ("" if nothing was playing) */
  lastTitle: string;
  /** ms since epoch */
  visitedAt: number;
}

export const RECENT_ROOMS_KEY = "wp-recent-rooms";
export const RECENT_ROOMS_MAX = 8;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecentRoom(v: unknown): v is RecentRoom {
  const r = v as RecentRoom;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.roomId === "string" &&
    r.roomId.length > 0 &&
    typeof r.lastTitle === "string" &&
    typeof r.visitedAt === "number" &&
    Number.isFinite(r.visitedAt)
  );
}

/** The stored list (invalid or unreadable storage gives []). */
export function readRecentRooms(
  storage: StorageLike | null = defaultStorage(),
): RecentRoom[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(RECENT_ROOMS_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(isRecentRoom)
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, RECENT_ROOMS_MAX);
  } catch {
    return [];
  }
}

/**
 * Pure update: moves the room to the front (or adds it) and keeps at most RECENT_ROOMS_MAX.
 * A `lastTitle` of undefined keeps the stored one, so a visit without media doesn't erase the last title.
 */
export function upsertRecentRoom(
  list: RecentRoom[],
  entry: { roomId: string; lastTitle?: string; visitedAt: number },
): RecentRoom[] {
  const previous = list.find((r) => r.roomId === entry.roomId);
  const next: RecentRoom = {
    roomId: entry.roomId,
    lastTitle: entry.lastTitle ?? previous?.lastTitle ?? "",
    visitedAt: entry.visitedAt,
  };
  return [next, ...list.filter((r) => r.roomId !== entry.roomId)].slice(
    0,
    RECENT_ROOMS_MAX,
  );
}

/** Records a visit (and optionally the current title). Storage errors are ignored. */
export function recordRecentRoom(
  entry: { roomId: string; lastTitle?: string; visitedAt?: number },
  storage: StorageLike | null = defaultStorage(),
): RecentRoom[] {
  const list = upsertRecentRoom(readRecentRooms(storage), {
    ...entry,
    visitedAt: entry.visitedAt ?? Date.now(),
  });
  try {
    storage?.setItem(RECENT_ROOMS_KEY, JSON.stringify(list));
  } catch {
    // Full or unavailable storage: the home page just won't list it
  }
  return list;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date for older visits. */
export function formatVisitedAgo(visitedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - visitedAt) / 1000));
  if (sec < 60) {
    return "just now";
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min} min ago`;
  }
  const hours = Math.round(min / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 14) {
    return `${days} days ago`;
  }
  return new Date(visitedAt).toLocaleDateString();
}
