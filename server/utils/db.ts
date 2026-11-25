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
  // 2: room-wide subtitle offset per video (PLAN 6b), keyed by subtitleOffsetKey()
  `CREATE TABLE subtitle_offsets (
    videoKey TEXT PRIMARY KEY,
    offset REAL NOT NULL,
    updatedAt INTEGER NOT NULL
  );`,
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

/** The saved subtitle offset (seconds) for a video key, or undefined if none was saved. */
export function getSubtitleOffset(
  db: DatabaseSync,
  videoKey: string,
): number | undefined {
  const row = db
    .prepare("SELECT offset FROM subtitle_offsets WHERE videoKey = ?")
    .get(videoKey) as { offset: number } | undefined;
  return row ? Number(row.offset) : undefined;
}

/** Saves a video's subtitle offset. An offset of 0 deletes the row (it's the default). */
export function saveSubtitleOffset(
  db: DatabaseSync,
  videoKey: string,
  offset: number,
  now = Date.now(),
) {
  if (offset === 0) {
    db.prepare("DELETE FROM subtitle_offsets WHERE videoKey = ?").run(videoKey);
    return;
  }
  db.prepare(
    `INSERT INTO subtitle_offsets (videoKey, offset, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(videoKey) DO UPDATE SET offset = excluded.offset, updatedAt = excluded.updatedAt`,
  ).run(videoKey, offset, now);
}
