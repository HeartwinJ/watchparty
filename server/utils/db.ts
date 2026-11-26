import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite persistence (built-in node:sqlite, no extra dependency).
 * Schema changes go in MIGRATIONS: each entry runs once, in order, and
 * PRAGMA user_version records how many have been applied.
 */
const MIGRATIONS: string[] = [
  // 1: rooms + uploaded subtitles (previously Postgres + Redis)
  `CREATE TABLE rooms (
    roomId TEXT PRIMARY KEY,
    data TEXT,
    lastUpdateTime INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE subtitles (
    hash TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX subtitles_expiresAt ON subtitles (expiresAt);`,
  // 2: room-wide subtitle offset per video, keyed by subtitleOffsetKey()
  `CREATE TABLE subtitle_offsets (
    videoKey TEXT PRIMARY KEY,
    offset REAL NOT NULL,
    updatedAt INTEGER NOT NULL
  );`,
  // 3: watch history / continue watching, see utils/history.ts. One row per room + item
  // (itemKey = subtitleOffsetKey()); url is server-only (resume), never sent to clients.
  `CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT NOT NULL,
    itemKey TEXT NOT NULL,
    groupKey TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    poster TEXT,
    meta TEXT,
    url TEXT NOT NULL,
    position REAL NOT NULL,
    duration REAL,
    finished INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL,
    UNIQUE (roomId, itemKey)
  );
  CREATE INDEX history_updatedAt ON history (updatedAt);`,
  // 4: subtitle time scale (frame-rate drift): shown time = original × scale + offset
  `ALTER TABLE subtitle_offsets ADD COLUMN scale REAL NOT NULL DEFAULT 1;`,
];

export function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  let version = Number(row.user_version);
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      // PRAGMA can't take bound parameters, version is always an integer we computed
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return version;
}

/** Open (creating if needed) a database. Pass ":memory:" for tests. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export interface RoomRow {
  roomId: string;
  data: string | null;
  lastUpdateTime: number;
  createdAt: number;
}

export function getRoom(db: DatabaseSync, roomId: string): RoomRow | undefined {
  return db.prepare("SELECT * FROM rooms WHERE roomId = ?").get(roomId) as
    RoomRow | undefined;
}

/** Reserve a room ID. Returns false if it already exists. */
export function insertRoom(
  db: DatabaseSync,
  roomId: string,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO rooms (roomId, data, lastUpdateTime, createdAt) VALUES (?, NULL, ?, ?)",
    )
    .run(roomId, now, now);
  return Number(result.changes) > 0;
}

/** Insert or update a room's serialized state. */
export function saveRoomData(
  db: DatabaseSync,
  roomId: string,
  data: string,
  lastUpdateTime: number,
) {
  db.prepare(
    `INSERT INTO rooms (roomId, data, lastUpdateTime, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(roomId) DO UPDATE SET data = excluded.data, lastUpdateTime = excluded.lastUpdateTime`,
  ).run(roomId, data, lastUpdateTime, lastUpdateTime);
}

/**
 * Deletes a room for good: its row and its watch history rows (subtitle_offsets are per video, shared by every
 * room, so they stay). Returns whether the room existed.
 */
export function deleteRoomData(db: DatabaseSync, roomId: string): boolean {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM history WHERE roomId = ?").run(roomId);
    const changes = Number(
      db.prepare("DELETE FROM rooms WHERE roomId = ?").run(roomId).changes,
    );
    db.exec("COMMIT");
    return changes > 0;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Ids of rooms whose lastUpdateTime is older than `cutoff` (ms since epoch), oldest first */
export function listRoomsIdleSince(db: DatabaseSync, cutoff: number): string[] {
  return (
    db
      .prepare(
        "SELECT roomId FROM rooms WHERE lastUpdateTime < ? ORDER BY lastUpdateTime",
      )
      .all(cutoff) as { roomId: string }[]
  ).map((r) => r.roomId);
}

export function saveSubtitle(
  db: DatabaseSync,
  hash: string,
  gzipped: Uint8Array,
  ttlMs: number,
  now = Date.now(),
) {
  db.prepare(
    `INSERT INTO subtitles (hash, data, expiresAt) VALUES (?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET expiresAt = excluded.expiresAt`,
  ).run(hash, gzipped, now + ttlMs);
}

/** Returns the gzipped subtitle and refreshes its expiry, or undefined if missing/expired. */
export function getSubtitle(
  db: DatabaseSync,
  hash: string,
  ttlMs: number,
  now = Date.now(),
): Uint8Array | undefined {
  const row = db
    .prepare("SELECT data FROM subtitles WHERE hash = ? AND expiresAt > ?")
    .get(hash, now) as { data: Uint8Array } | undefined;
  if (!row) {
    return undefined;
  }
  db.prepare("UPDATE subtitles SET expiresAt = ? WHERE hash = ?").run(
    now + ttlMs,
    hash,
  );
  return row.data;
}

export function pruneSubtitles(db: DatabaseSync, now = Date.now()) {
  return Number(
    db.prepare("DELETE FROM subtitles WHERE expiresAt <= ?").run(now).changes,
  );
}

/** The saved subtitle timing (offset in seconds, time scale) for a video key, or undefined if none was saved. */
export function getSubtitleTiming(
  db: DatabaseSync,
  videoKey: string,
): { offset: number; scale: number } | undefined {
  const row = db
    .prepare("SELECT offset, scale FROM subtitle_offsets WHERE videoKey = ?")
    .get(videoKey) as { offset: number; scale: number } | undefined;
  return row
    ? { offset: Number(row.offset), scale: Number(row.scale) }
    : undefined;
}

/** Saves a video's subtitle timing. Offset 0 with scale 1 deletes the row (it's the default). */
export function saveSubtitleTiming(
  db: DatabaseSync,
  videoKey: string,
  timing: { offset: number; scale: number },
  now = Date.now(),
) {
  if (timing.offset === 0 && timing.scale === 1) {
    db.prepare("DELETE FROM subtitle_offsets WHERE videoKey = ?").run(videoKey);
    return;
  }
  db.prepare(
    `INSERT INTO subtitle_offsets (videoKey, offset, scale, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(videoKey) DO UPDATE SET offset = excluded.offset, scale = excluded.scale,
       updatedAt = excluded.updatedAt`,
  ).run(videoKey, timing.offset, timing.scale, now);
}
