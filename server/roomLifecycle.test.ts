import { describe, expect, it, vi } from "vitest";
import { Server } from "socket.io";
import {
  deleteRoomData,
  getRoom,
  listRoomsIdleSince,
  openDatabase,
  saveRoomData,
} from "./utils/db.ts";
import {
  type ManagedRoom,
  parseMaxIdleDays,
  persistRooms,
  sweepInactiveRooms,
} from "./roomLifecycle.ts";
import { Room } from "./room.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

function fakeRoom(opts: {
  roster?: unknown[];
  lastUpdateTime: number;
  loadedAt: number;
}) {
  return {
    roster: opts.roster ?? [],
    lastUpdateTime: new Date(opts.lastUpdateTime),
    loadedAt: opts.loadedAt,
    saveRoom: vi.fn<() => void>(),
    destroy: vi.fn<() => void>(),
    deleteRoom: vi.fn<(by: PlaybackActor | null) => boolean>(() => true),
  } satisfies ManagedRoom;
}

const history = (db: ReturnType<typeof openDatabase>, roomId: string) =>
  db
    .prepare(
      `INSERT INTO history (roomId, itemKey, groupKey, kind, title, url, position, updatedAt)
       VALUES (?, ?, 'g', 'url', 'T', 'https://example.com/x.mp4', 30, 1)`,
    )
    .run(roomId, roomId + "-item");

const historyCount = (db: ReturnType<typeof openDatabase>, roomId: string) =>
  Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM history WHERE roomId = ?")
        .get(roomId) as { n: number }
    ).n,
  );

describe("db room deletion", () => {
  it("deletes the room row and its history, keeping subtitle offsets and other rooms", () => {
    const db = openDatabase(":memory:");
    saveRoomData(db, "/a", "{}", 1);
    saveRoomData(db, "/b", "{}", 1);
    history(db, "/a");
    history(db, "/b");
    db.prepare(
      "INSERT INTO subtitle_offsets (videoKey, offset, updatedAt) VALUES ('v', 1, 1)",
    ).run();
    expect(deleteRoomData(db, "/a")).toBe(true);
    expect(deleteRoomData(db, "/a")).toBe(false);
    expect(getRoom(db, "/a")).toBeUndefined();
    expect(historyCount(db, "/a")).toBe(0);
    expect(getRoom(db, "/b")).toBeDefined();
    expect(historyCount(db, "/b")).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM subtitle_offsets").get(),
    ).toMatchObject({ n: 1 });
    db.close();
  });

  it("lists rooms idle since a cutoff, oldest first", () => {
    const db = openDatabase(":memory:");
    saveRoomData(db, "/new", "{}", 300);
    saveRoomData(db, "/older", "{}", 100);
    saveRoomData(db, "/old", "{}", 200);
    expect(listRoomsIdleSince(db, 250)).toEqual(["/older", "/old"]);
    db.close();
  });
});

describe("parseMaxIdleDays", () => {
  it("accepts positive numbers and disables everything else", () => {
    expect(parseMaxIdleDays(60)).toBe(60);
    expect(parseMaxIdleDays("30")).toBe(30);
    expect(parseMaxIdleDays("0")).toBe(0);
    expect(parseMaxIdleDays("-5")).toBe(0);
    expect(parseMaxIdleDays("soon")).toBe(0);
  });
});

describe("persistRooms (1 s save loop)", () => {
  const log = () => {};

  it("refreshes and saves rooms with people in them", () => {
    const room = fakeRoom({
      roster: [{ id: "a" }],
      lastUpdateTime: NOW - 90 * DAY,
      loadedAt: NOW - 9 * 3600_000,
    });
    const rooms = new Map([["/a", room]]);
    persistRooms(rooms, NOW, 8 * 3600_000, log);
    expect(Number(room.lastUpdateTime)).toBe(NOW);
    expect(room.saveRoom).toHaveBeenCalled();
    expect(rooms.has("/a")).toBe(true);
  });

  it("doesn't refresh an empty room, and unloads it once idle and loaded for 8 h", () => {
    const room = fakeRoom({
      lastUpdateTime: NOW - 90 * DAY,
      loadedAt: NOW - 1000,
    });
    const rooms = new Map([["/a", room]]);
    persistRooms(rooms, NOW, 8 * 3600_000, log);
    // Just loaded (join screen): kept, not saved, still 90 days old
    expect(rooms.has("/a")).toBe(true);
    expect(room.saveRoom).not.toHaveBeenCalled();
    expect(Number(room.lastUpdateTime)).toBe(NOW - 90 * DAY);

    persistRooms(rooms, NOW + 8 * 3600_000, 8 * 3600_000, log);
    expect(rooms.has("/a")).toBe(false);
    expect(room.destroy).toHaveBeenCalled();
    expect(Number(room.lastUpdateTime)).toBe(NOW - 90 * DAY);
  });
});

describe("sweepInactiveRooms", () => {
  it("deletes rooms idle for longer than the limit, with their history", () => {
    const db = openDatabase(":memory:");
    saveRoomData(db, "/stale", "{}", NOW - 61 * DAY);
    saveRoomData(db, "/fresh", "{}", NOW - 59 * DAY);
    history(db, "/stale");
    const deleted = sweepInactiveRooms({
      db,
      rooms: new Map(),
      maxIdleDays: 60,
      now: NOW,
    });
    expect(deleted).toBe(1);
    expect(getRoom(db, "/stale")).toBeUndefined();
    expect(historyCount(db, "/stale")).toBe(0);
    expect(getRoom(db, "/fresh")).toBeDefined();
    db.close();
  });

  it("does nothing when disabled", () => {
    const db = openDatabase(":memory:");
    saveRoomData(db, "/stale", "{}", NOW - 600 * DAY);
    expect(
      sweepInactiveRooms({ db, rooms: new Map(), maxIdleDays: 0, now: NOW }),
    ).toBe(0);
    expect(getRoom(db, "/stale")).toBeDefined();
    db.close();
  });

  it("skips loaded rooms with people or loaded just now, and deletes loaded empty ones", () => {
    const db = openDatabase(":memory:");
    const old = NOW - 90 * DAY;
    for (const id of ["/busy", "/joining", "/empty"]) {
      saveRoomData(db, id, "{}", old);
    }
    const busy = fakeRoom({
      roster: [{ id: "a" }],
      lastUpdateTime: old,
      loadedAt: NOW - DAY,
    });
    const joining = fakeRoom({ lastUpdateTime: old, loadedAt: NOW - 1000 });
    const empty = fakeRoom({ lastUpdateTime: old, loadedAt: NOW - DAY });
    const rooms = new Map<string, ManagedRoom>([
      ["/busy", busy],
      ["/joining", joining],
      ["/empty", empty],
    ]);
    expect(sweepInactiveRooms({ db, rooms, maxIdleDays: 60, now: NOW })).toBe(
      1,
    );
    expect(empty.deleteRoom).toHaveBeenCalledWith(null);
    expect(rooms.has("/empty")).toBe(false);
    expect(busy.deleteRoom).not.toHaveBeenCalled();
    expect(joining.deleteRoom).not.toHaveBeenCalled();
    db.close();
  });
});

describe("Room.lastUpdateTime", () => {
  it("keeps the stored time when loaded, so loading isn't activity", () => {
    const io = new Server();
    const db = openDatabase(":memory:");
    const stored = Date.now() - 70 * DAY;
    saveRoomData(db, "/loaded", "{}", stored);
    const row = getRoom(db, "/loaded")!;
    const room = new Room(io, db, "/loaded", row.data, row.lastUpdateTime);
    // A legacy room gets a password and is saved right away, without refreshing its time
    expect(Number(room.lastUpdateTime)).toBe(stored);
    expect(getRoom(db, "/loaded")?.lastUpdateTime).toBe(stored);
    room.saveRoom();
    expect(getRoom(db, "/loaded")?.lastUpdateTime).toBe(stored);
    room.destroy();
    db.close();
  });
});
