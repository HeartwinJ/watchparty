import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.ts";

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TtlCache", () => {
  it("expires entries after their TTL", () => {
    const c = clock();
    const cache = new TtlCache<string>({ maxEntries: 10, now: c.now });
    cache.set("a", "1", 100);
    expect(cache.get("a")).toBe("1");
    c.advance(99);
    expect(cache.get("a")).toBe("1");
    c.advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new TtlCache<number>({ maxEntries: 2 });
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.get("a"); // a is now most recent
    cache.set("c", 3, 1000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("wrap() caches the loaded value per key", async () => {
    const c = clock();
    const cache = new TtlCache<string>({ maxEntries: 10, now: c.now });
    const load = vi.fn(async () => "v");
    expect(await cache.wrap("k", 100, load)).toBe("v");
    expect(await cache.wrap("k", 100, load)).toBe("v");
    expect(load).toHaveBeenCalledTimes(1);
    c.advance(100);
    await cache.wrap("k", 100, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("wrap() de-duplicates concurrent loads", async () => {
    const cache = new TtlCache<string>({ maxEntries: 10 });
    let resolve!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const p1 = cache.wrap("k", 1000, load);
    const p2 = cache.wrap("k", 1000, load);
    const other = cache.wrap("other", 1000, async () => "o");
    resolve("v");
    expect(await Promise.all([p1, p2, other])).toEqual(["v", "v", "o"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("wrap() doesn't cache failures and lets the next call retry", async () => {
    const cache = new TtlCache<string>({ maxEntries: 10 });
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const [a, b] = await Promise.allSettled([
      cache.wrap("k", 1000, load),
      cache.wrap("k", 1000, load),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected"); // shared the same in-flight failure
    expect(await cache.wrap("k", 1000, load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
