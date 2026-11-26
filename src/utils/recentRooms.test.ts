import { describe, expect, it } from "vitest";
import {
  formatVisitedAgo,
  readRecentRooms,
  RECENT_ROOMS_KEY,
  RECENT_ROOMS_MAX,
  recordRecentRoom,
  removeRecentRoom,
  upsertRecentRoom,
} from "./recentRooms";

const memoryStorage = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set(RECENT_ROOMS_KEY, initial);
  }
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
};

describe("upsertRecentRoom", () => {
  it("adds new rooms to the front", () => {
    const list = upsertRecentRoom([], {
      roomId: "a",
      lastTitle: "A",
      visitedAt: 1,
    });
    expect(
      upsertRecentRoom(list, { roomId: "b", visitedAt: 2 }).map(
        (r) => r.roomId,
      ),
    ).toEqual(["b", "a"]);
  });

  it("moves a revisited room to the front and keeps its title unless given one", () => {
    let list = upsertRecentRoom([], {
      roomId: "a",
      lastTitle: "Movie",
      visitedAt: 1,
    });
    list = upsertRecentRoom(list, { roomId: "b", visitedAt: 2 });
    list = upsertRecentRoom(list, { roomId: "a", visitedAt: 3 });
    expect(list[0]).toEqual({
      roomId: "a",
      lastTitle: "Movie",
      roomTitle: "",
      visitedAt: 3,
    });
    expect(list).toHaveLength(2);
    list = upsertRecentRoom(list, { roomId: "a", lastTitle: "", visitedAt: 4 });
    expect(list[0].lastTitle).toBe("");
  });

  it("stores the room title and keeps it unless given a new one", () => {
    let list = upsertRecentRoom([], {
      roomId: "a",
      roomTitle: "Friday movies",
      visitedAt: 1,
    });
    list = upsertRecentRoom(list, {
      roomId: "a",
      lastTitle: "X",
      visitedAt: 2,
    });
    expect(list[0].roomTitle).toBe("Friday movies");
    list = upsertRecentRoom(list, { roomId: "a", roomTitle: "", visitedAt: 3 });
    expect(list[0].roomTitle).toBe("");
  });

  it(`keeps at most ${RECENT_ROOMS_MAX}`, () => {
    let list = upsertRecentRoom([], { roomId: "r0", visitedAt: 0 });
    for (let i = 1; i < 20; i++) {
      list = upsertRecentRoom(list, { roomId: `r${i}`, visitedAt: i });
    }
    expect(list).toHaveLength(RECENT_ROOMS_MAX);
    expect(list[0].roomId).toBe("r19");
  });
});

describe("readRecentRooms / recordRecentRoom", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    recordRecentRoom({ roomId: "a", lastTitle: "A", visitedAt: 5 }, storage);
    recordRecentRoom({ roomId: "b", visitedAt: 6 }, storage);
    expect(readRecentRooms(storage)).toEqual([
      { roomId: "b", lastTitle: "", roomTitle: "", visitedAt: 6 },
      { roomId: "a", lastTitle: "A", roomTitle: "", visitedAt: 5 },
    ]);
  });

  it("forgets a deleted room", () => {
    const storage = memoryStorage();
    recordRecentRoom({ roomId: "a", visitedAt: 5 }, storage);
    recordRecentRoom({ roomId: "b", visitedAt: 6 }, storage);
    expect(removeRecentRoom("a", storage).map((r) => r.roomId)).toEqual(["b"]);
    expect(readRecentRooms(storage).map((r) => r.roomId)).toEqual(["b"]);
    expect(removeRecentRoom("missing", storage)).toHaveLength(1);
  });

  it("ignores corrupt or foreign data", () => {
    expect(readRecentRooms(memoryStorage("not json"))).toEqual([]);
    expect(readRecentRooms(memoryStorage('{"a":1}'))).toEqual([]);
    expect(
      readRecentRooms(
        memoryStorage(
          JSON.stringify([
            { roomId: "", lastTitle: "", visitedAt: 1 },
            { roomId: "ok", lastTitle: "x", visitedAt: 2 },
            { roomId: "bad", visitedAt: "x" },
          ]),
        ),
      ),
    ).toEqual([{ roomId: "ok", lastTitle: "x", roomTitle: "", visitedAt: 2 }]);
  });

  it("survives unavailable storage", () => {
    expect(readRecentRooms(null)).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readRecentRooms(throwing)).toEqual([]);
    expect(recordRecentRoom({ roomId: "a" }, throwing)).toHaveLength(1);
  });
});

describe("formatVisitedAgo", () => {
  const now = 1_000_000_000_000;
  it.each([
    [10_000, "just now"],
    [5 * 60_000, "5 min ago"],
    [3 * 3_600_000, "3 h ago"],
    [30 * 3_600_000, "yesterday"],
    [4 * 86_400_000, "4 days ago"],
  ])("%s ms ago -> %s", (ago, expected) => {
    expect(formatVisitedAgo(now - ago, now)).toBe(expected);
  });
});
