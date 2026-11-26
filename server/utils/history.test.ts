import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "./db.ts";
import {
  HISTORY_MAX_ROWS,
  HISTORY_SAVE_INTERVAL_MS,
  HistoryRecorder,
  deleteHistory,
  describeHistoryItem,
  getAttachedDisplayName,
  getHistoryEntry,
  isFinished,
  listHistory,
  parseDuration,
  pruneHistory,
  safeUrlName,
  upsertHistory,
  type HistoryWrite,
} from "./history.ts";
import { subtitleOffsetKey } from "./subtitleOffset.ts";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:2:4",
  imdbId: "tt0000001",
  season: 2,
  episode: 4,
  title: "Example Show",
  episodeTitle: "The Fourth",
  poster: "https://images.example.com/poster.jpg",
  bingeGroup: null,
};
const SECRET = "eyFAKEBLOBsecretcredential";
const AIO = `https://aio.example.com/api/v1/debrid/playback/${SECRET}/file.mkv#wp-name=Example%20Show%20%C2%B7%20S02E04`;

const dbs: ReturnType<typeof openDatabase>[] = [];
const newDb = () => {
  const db = openDatabase(":memory:");
  dbs.push(db);
  return db;
};
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
});

const write = (over: Partial<HistoryWrite> = {}): HistoryWrite => ({
  ...describeHistoryItem("https://example.com/movie.mp4", null)!,
  roomId: "/room",
  url: "https://example.com/movie.mp4",
  meta: null,
  position: 100,
  duration: null,
  finished: false,
  ...over,
});

describe("describeHistoryItem", () => {
  it("uses the metadata for AIOStreams picks and never the URL", () => {
    const d = describeHistoryItem(AIO, meta)!;
    expect(d).toEqual({
      itemKey: "meta:tt0000001:2:4",
      groupKey: "meta:tt0000001",
      kind: "aiostreams",
      title: "Example Show",
      subtitle: "S02E04 · The Fourth",
      poster: meta.poster,
    });
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });

  it("groups kitsu episodes by show and formats episode-only codes", () => {
    const d = describeHistoryItem(AIO, {
      ...meta,
      type: "anime",
      id: "kitsu:11:5",
      imdbId: null,
      season: null,
      episode: 5,
      episodeTitle: null,
    })!;
    expect(d.groupKey).toBe("meta:kitsu:11");
    expect(d.subtitle).toBe("E05");
  });

  it("uses the display name, a file name or the host for other URLs", () => {
    expect(describeHistoryItem(AIO, null)!.title).toBe("Example Show · S02E04");
    expect(
      describeHistoryItem("https://example.com/videos/My%20Movie.mp4", null)!
        .title,
    ).toBe("My Movie.mp4");
    expect(
      describeHistoryItem("https://cdn.example.com/stream?token=abc", null)!
        .title,
    ).toBe("cdn.example.com");
    // The URL key ignores the fragment
    expect(describeHistoryItem(AIO, null)!.itemKey).toBe(
      subtitleOffsetKey(AIO.split("#")[0], null),
    );
  });

  it("recognises YouTube and uses the queue item's name", () => {
    const d = describeHistoryItem(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      null,
      { name: "A song" },
    )!;
    expect(d.kind).toBe("youtube");
    expect(d.title).toBe("A song");
    expect(d.poster).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("skips shares and empty videos", () => {
    expect(describeHistoryItem("", null)).toBeUndefined();
    expect(describeHistoryItem(null, null)).toBeUndefined();
    expect(describeHistoryItem("screenshare://abc", null)).toBeUndefined();
    expect(describeHistoryItem("fileshare://abc", null)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("getAttachedDisplayName", () => {
    expect(getAttachedDisplayName("https://x/a#wp-name=Hi%20there")).toBe(
      "Hi there",
    );
    expect(getAttachedDisplayName("https://x/a#t=1&wp-name=B")).toBe("B");
    expect(getAttachedDisplayName("https://x/a")).toBeUndefined();
    expect(getAttachedDisplayName("https://x/a#wp-name=%E0")).toBeUndefined();
  });

  it("safeUrlName never returns path tokens", () => {
    expect(
      safeUrlName(`https://aio.example.com/playback/${SECRET}${SECRET}`),
    ).toBe("aio.example.com");
    expect(safeUrlName(`https://h.example.com/${"a".repeat(50)}.mkv`)).toBe(
      "h.example.com",
    );
    expect(safeUrlName("not a url")).toBe("Video");
  });

  it("isFinished and parseDuration", () => {
    expect(isFinished(90, 100)).toBe(true);
    expect(isFinished(89, 100)).toBe(false);
    expect(isFinished(10, null)).toBe(false);
    expect(isFinished(10, null, true)).toBe(true);
    expect(parseDuration(3600.04)).toBe(3600);
    for (const bad of [0, -1, NaN, Infinity, "10", null, 1e9]) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });
});

describe("history table", () => {
  it("upserts per room + item and lists newest first without URLs", () => {
    const db = newDb();
    upsertHistory(db, write(), 1000);
    upsertHistory(
      db,
      write({
        ...describeHistoryItem(AIO, meta)!,
        url: AIO,
        meta,
        position: 50,
      }),
      2000,
    );
    upsertHistory(db, write({ position: 200 }), 3000);
    const items = listHistory(db);
    expect(items.map((i) => [i.title, i.position])).toEqual([
      ["movie.mp4", 200],
      ["Example Show", 50],
    ]);
    expect(JSON.stringify(items)).not.toContain("aio.example.com");
    expect(JSON.stringify(items)).not.toContain("example.com/movie.mp4");
    expect(items[0]).not.toHaveProperty("url");
    // The full entry keeps the URL and metadata for resuming
    const entry = getHistoryEntry(db, items[1].id)!;
    expect(entry.url).toBe(AIO);
    expect(entry.meta).toEqual(meta);
  });

  it("keeps a known duration and derives finished from it", () => {
    const db = newDb();
    upsertHistory(db, write({ duration: 1000 }), 1);
    upsertHistory(db, write({ position: 950, duration: null }), 2);
    const [item] = listHistory(db);
    expect(item.duration).toBe(1000);
    expect(item.finished).toBe(true);
    upsertHistory(db, write({ position: 100, duration: null }), 3);
    expect(listHistory(db)[0].finished).toBe(false);
  });

  it("prunes to the newest rows and deletes by id", () => {
    const db = newDb();
    for (let i = 0; i < HISTORY_MAX_ROWS + 5; i++) {
      upsertHistory(db, write({ roomId: "/r" + i }), i);
    }
    const items = listHistory(db, 1000);
    expect(items).toHaveLength(HISTORY_MAX_ROWS);
    expect(items.at(-1)!.roomId).toBe("/r5");
    expect(pruneHistory(db, 10)).toBe(HISTORY_MAX_ROWS - 10);
    expect(deleteHistory(db, items[0].id)).toBe(true);
    expect(deleteHistory(db, items[0].id)).toBe(false);
  });
});

describe("HistoryRecorder", () => {
  const setup = () => {
    const db = newDb();
    let now = 1_000_000;
    const rec = new HistoryRecorder(db, "/room", { now: () => now });
    return {
      db,
      rec,
      advance: (ms: number) => (now += ms),
      rows: () => listHistory(db),
    };
  };
  const snap = (
    over: Partial<Parameters<HistoryRecorder["save"]>[0]> = {},
  ) => ({
    video: "https://example.com/movie.mp4",
    meta: null,
    position: 100,
    paused: false,
    ...over,
  });

  it("writes while playing at most every 30 s, and never under 10 s", () => {
    const { rec, advance, rows } = setup();
    rec.tick(snap({ position: 5 }));
    expect(rows()).toHaveLength(0);
    rec.tick(snap({ position: 11 }));
    expect(rows()[0].position).toBe(11);
    advance(1000);
    rec.tick(snap({ position: 12 }));
    expect(rows()[0].position).toBe(11);
    advance(HISTORY_SAVE_INTERVAL_MS);
    rec.tick(snap({ position: 42 }));
    expect(rows()[0].position).toBe(42);
    // Paused: the tick doesn't write, an explicit save (pause/seek) does
    advance(HISTORY_SAVE_INTERVAL_MS);
    rec.tick(snap({ position: 50, paused: true }));
    expect(rows()[0].position).toBe(42);
    rec.save(snap({ position: 50, paused: true }));
    expect(rows()[0].position).toBe(50);
  });

  it("skips live streams and shares", () => {
    const { rec, rows } = setup();
    rec.save(snap({ position: -30 }));
    rec.save(snap({ video: "screenshare://abc" }));
    rec.save(snap({ video: "" }));
    expect(rows()).toHaveLength(0);
  });

  it("uses the reported duration and marks ended items finished on host change", () => {
    const { rec, rows } = setup();
    rec.setDuration("https://example.com/movie.mp4", 1000);
    rec.save(snap({ position: 500 }));
    expect(rows()[0]).toMatchObject({ duration: 1000, finished: false });
    rec.save(snap({ position: 920 }));
    expect(rows()[0].finished).toBe(true);

    rec.markEnded("https://example.com/other.mp4");
    rec.beforeHostChange(
      snap({ video: "https://example.com/other.mp4", position: 300 }),
    );
    const other = rows().find((r) => r.title === "other.mp4")!;
    expect(other.finished).toBe(true);
    // The next video starts without the old duration
    rec.save(snap({ video: "https://example.com/third.mp4", position: 20 }));
    expect(rows().find((r) => r.title === "third.mp4")!.duration).toBeNull();
  });

  it("re-keys a URL entry when the metadata arrives", () => {
    const { rec, rows } = setup();
    rec.save(snap({ video: AIO, position: 30 }));
    expect(rows()[0].kind).toBe("url");
    rec.metaAttached(snap({ video: AIO, meta, position: 30 }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      kind: "aiostreams",
      title: "Example Show",
    });
  });

  it("uses the queue item's name hint", () => {
    const { rec, rows } = setup();
    rec.setHint("https://example.com/x.mp4", { name: "Holiday clip" });
    rec.save(snap({ video: "https://example.com/x.mp4", position: 20 }));
    expect(rows()[0].title).toBe("Holiday clip");
  });

  it("looks up YouTube titles in the background", async () => {
    const db = newDb();
    const lookupYoutube = vi.fn(async () => ({
      name: "Real title",
      duration: 200,
    }));
    const rec = new HistoryRecorder(db, "/room", { lookupYoutube });
    const yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    rec.save(snap({ video: yt, position: 20 }));
    expect(listHistory(db)[0].title).toBe("YouTube video");
    await vi.waitFor(() => expect(listHistory(db)[0].title).toBe("Real title"));
    expect(lookupYoutube).toHaveBeenCalledWith("dQw4w9WgXcQ");
    rec.save(snap({ video: yt, position: 190 }));
    expect(listHistory(db)[0]).toMatchObject({
      title: "Real title",
      finished: true,
    });
    expect(lookupYoutube).toHaveBeenCalledTimes(1);
  });
});
