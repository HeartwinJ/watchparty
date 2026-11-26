import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import {
  getRoom,
  getSubtitle,
  deleteRoomData,
  getSubtitleTiming,
  insertRoom,
  migrate,
  openDatabase,
  pruneSubtitles,
  saveRoomData,
  saveSubtitle,
  saveSubtitleOffset,
} from "./db.ts";
import { Room } from "../room.ts";

describe("db", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
  });

  it("migrates once and records user_version", () => {
    const db = openDatabase(":memory:");
    const { user_version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(user_version).toBeGreaterThan(0);
    // Running again is a no-op
    expect(migrate(db)).toBe(user_version);
    db.close();
  });

  it("reserves room IDs uniquely and upserts data", () => {
    const db = openDatabase(":memory:");
    expect(insertRoom(db, "/a-b-c", 1000)).toBe(true);
    expect(insertRoom(db, "/a-b-c", 2000)).toBe(false);
    expect(getRoom(db, "/a-b-c")).toMatchObject({
      data: null,
      createdAt: 1000,
    });
    saveRoomData(db, "/a-b-c", '{"video":"x"}', 3000);
    expect(getRoom(db, "/a-b-c")).toMatchObject({
      data: '{"video":"x"}',
      lastUpdateTime: 3000,
      createdAt: 1000,
    });
    // Saving a room that was never inserted creates it
    saveRoomData(db, "/new", "{}", 5000);
    expect(getRoom(db, "/new")?.createdAt).toBe(5000);
    expect(getRoom(db, "/missing")).toBeUndefined();
    db.close();
  });

  it("round-trips a Room through a file database across reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-db-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "nested", "watchparty.db");
    const io = new Server();

    let db = openDatabase(file);
    expect(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
    ).toBe("wal");
    const room = new Room(io, db, "/round-trip-room");
    room.video = "https://example.com/video.mp4";
    room.videoTS = 42.5;
    room.paused = true;
    room.loop = true;
    room.playbackRate = 1.5;
    room.playlist = [
      {
        url: "https://example.com/2.mp4",
        name: "two",
        duration: 0,
        type: "file",
      },
    ];
    room.saveRoom();
    room.destroy();
    db.close();

    db = openDatabase(file);
    const row = getRoom(db, "/round-trip-room");
    expect(row?.data).toBeTruthy();
    const loaded = new Room(io, db, "/round-trip-room", row?.data);
    cleanups.push(() => loaded.destroy());
    expect(loaded.video).toBe("https://example.com/video.mp4");
    expect(loaded.videoTS).toBe(42.5);
    expect(loaded.paused).toBe(true);
    expect(loaded.loop).toBe(true);
    expect(loaded.playbackRate).toBe(1.5);
    expect(loaded.playlist).toHaveLength(1);
    expect(JSON.parse(loaded.serialize())).toEqual(
      JSON.parse(room.serialize()),
    );
    db.close();
  });

  it("stores subtitles with expiry", () => {
    const db = openDatabase(":memory:");
    const data = new Uint8Array([1, 2, 3]);
    saveSubtitle(db, "h", data, 1000, 0);
    expect(Array.from(getSubtitle(db, "h", 1000, 500) ?? [])).toEqual([
      1, 2, 3,
    ]);
    // Reading refreshed the expiry to 1500
    expect(getSubtitle(db, "h", 1000, 1200)).toBeDefined();
    expect(getSubtitle(db, "h", 1000, 5000)).toBeUndefined();
    expect(pruneSubtitles(db, 5000)).toBe(1);
    db.close();
  });
});

describe("db failures", () => {
  it("rolls back a migration that fails", () => {
    const db = openDatabase(":memory:");
    db.exec("PRAGMA user_version = 0");
    // Migration 1 would create a table that already exists
    expect(() => migrate(db)).toThrow();
    const { user_version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(user_version).toBe(0);
    db.close();
  });

  it("rolls back a failed room delete", () => {
    const db = openDatabase(":memory:");
    insertRoom(db, "/r");
    db.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT, 'nope'); END",
    );
    expect(() => deleteRoomData(db, "/r")).toThrow("nope");
    expect(getRoom(db, "/r")).toBeDefined();
    db.close();
  });

  it("saves an offset without a time scale, deleting it at 0", () => {
    const db = openDatabase(":memory:");
    saveSubtitleOffset(db, "url:x", 1.5);
    expect(getSubtitleTiming(db, "url:x")).toEqual({ offset: 1.5, scale: 1 });
    saveSubtitleOffset(db, "url:x", 0);
    expect(getSubtitleTiming(db, "url:x")).toBeUndefined();
    db.close();
  });
});
