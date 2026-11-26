import type { DatabaseSync } from "node:sqlite";
import { deleteRoomData, listRoomsIdleSince } from "./utils/db.ts";

/** What the save loop and the inactivity sweep need from a loaded Room */
export interface ManagedRoom {
  roster: unknown[];
  /** Last activity (someone in the room). Loaded from the database, so loading a room doesn't refresh it */
  lastUpdateTime: Date;
  /** When this Room was loaded into memory (ms since epoch) */
  loadedAt: number;
  saveRoom(): void;
  destroy(): void;
  /** Deletes the room for good (database rows, sockets, namespace) */
  deleteRoom(by: PlaybackActor | null): boolean;
}

export const ROOM_IDLE_UNLOAD_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A room loaded this recently may be about to get its first socket (join screen → connect), so the sweep skips it */
const SWEEP_LOAD_GRACE_MS = 10 * 60 * 1000;

/**
 * The 1 s save loop. A room with people in it is active: its lastUpdateTime moves to `now` and it's saved. An empty
 * room isn't saved (nothing changes without people) and keeps its lastUpdateTime; it's saved one last time and unloaded
 * once it has been idle, and loaded, for `idleUnloadMs` (being loaded counts, so a room loaded for a join isn't unloaded before the
 * socket arrives).
 */
export function persistRooms(
  rooms: Map<string, ManagedRoom>,
  now = Date.now(),
  idleUnloadMs = ROOM_IDLE_UNLOAD_MS,
  log: (msg: string, ...args: unknown[]) => void = console.log,
) {
  for (const [key, room] of rooms) {
    if (room.roster.length) {
      room.lastUpdateTime = new Date(now);
      room.saveRoom();
    } else if (
      Math.max(Number(room.lastUpdateTime), room.loadedAt) <
      now - idleUnloadMs
    ) {
      log("freeing room %s from memory", key);
      room.saveRoom();
      room.destroy();
      rooms.delete(key);
    }
  }
}

/** ROOM_MAX_IDLE_DAYS as a number of days, or 0 (disabled) for 0, negative or invalid values */
export function parseMaxIdleDays(raw: unknown): number {
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * Deletes rooms nobody has been in for `maxIdleDays` (lastUpdateTime older than that): the room row and its history
 * rows (subtitle offsets are per video and stay). A loaded room is skipped while people are in it or it was loaded
 * in the last few minutes, otherwise it's deleted (and unloaded) too. Returns how many rooms were deleted.
 */
export function sweepInactiveRooms(opts: {
  db: DatabaseSync;
  rooms: Map<string, ManagedRoom>;
  maxIdleDays: number;
  now?: number;
}): number {
  const { db, rooms, maxIdleDays } = opts;
  const now = opts.now ?? Date.now();
  if (!(maxIdleDays > 0)) {
    return 0;
  }
  const cutoff = now - maxIdleDays * DAY_MS;
  let deleted = 0;
  for (const roomId of listRoomsIdleSince(db, cutoff)) {
    const room = rooms.get(roomId);
    if (room) {
      if (
        room.roster.length > 0 ||
        Number(room.lastUpdateTime) >= cutoff ||
        room.loadedAt > now - SWEEP_LOAD_GRACE_MS
      ) {
        continue;
      }
      if (room.deleteRoom(null)) {
        rooms.delete(roomId);
        deleted++;
      }
    } else if (deleteRoomData(db, roomId)) {
      deleted++;
    }
  }
  return deleted;
}
