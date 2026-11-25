import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverPath } from "../utils/api";
import {
  AddonApiError,
  createDebouncedSearch,
  getMeta,
  getNextEpisode,
  getStreams,
  getSubtitles,
  isAddonsConfigured,
  onAddonsConfiguredChange,
  resetAddonsConfigured,
  searchTitles,
  searchYouTube,
  toStreamList,
} from "./addons";

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const mockFetch = (handler: Handler) => {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

beforeEach(() => resetAddonsConfigured());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("addon endpoints", () => {
  it("searches and maps groups to typed title refs", async () => {
    const fetch = mockFetch(() =>
      json({
        movies: [
          {
            id: "tt0000001",
            type: "movie",
            name: "A",
            year: 1994,
            poster: null,
          },
        ],
        series: [
          {
            id: "tt0000002",
            type: "series",
            name: "B",
            year: null,
            poster: "https://p/b.jpg",
          },
          { bogus: true },
        ],
        anime: [
          {
            id: "kitsu:7",
            type: "series",
            name: "C",
            year: 2001,
            poster: null,
          },
        ],
      }),
    );
    const res = await searchTitles("  shawshank  ");
    expect(fetch.mock.calls[0][0]).toBe(
      serverPath + "/addon/search?q=shawshank",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "include" });
    expect(res.movies[0]).toMatchObject({ id: "tt0000001", kind: "movie" });
    expect(res.series).toHaveLength(1);
    expect(res.series[0]).toMatchObject({
      kind: "series",
      poster: "https://p/b.jpg",
    });
    expect(res.anime[0]).toMatchObject({ id: "kitsu:7", kind: "anime" });
  });

  it("tolerates missing groups", async () => {
    mockFetch(() => json({ movies: [] }));
    expect(await searchTitles("x")).toEqual({
      movies: [],
      series: [],
      anime: [],
    });
  });

  it("builds meta, streams, subtitles and next-episode URLs", async () => {
    const fetch = mockFetch((url) => {
      if (url.includes("/meta/")) {
        return json({
          id: "tt1",
          type: "series",
          name: "S",
          seasons: [
            { season: 1, episodes: [{ id: "tt1:1:1", season: 1, episode: 1 }] },
          ],
        });
      }
      if (url.includes("/streams/")) {
        return json({ streams: [], counts: { direct: 1 }, total: 3 });
      }
      if (url.includes("/subtitles/")) {
        return json([
          { id: "1", lang: "en", label: "English", url: "https://s/x.srt" },
        ]);
      }
      return json({ next: { id: "tt1:1:2", season: 1, episode: 2 } });
    });
    const meta = await getMeta("series", "tt1");
    expect(meta.genres).toEqual([]);
    expect(meta.seasons[0].episodes[0].id).toBe("tt1:1:1");
    const streams = await getStreams("anime", "kitsu:7:3", {
      bingeGroup: "grp|1080p",
    });
    expect(streams.counts).toEqual({
      direct: 1,
      "convert-light": 0,
      "convert-heavy": 0,
      unlikely: 0,
    });
    expect(streams.total).toBe(3);
    expect(await getSubtitles("series", "tt1:1:1")).toHaveLength(1);
    expect(await getNextEpisode("series", "tt1:1:1")).toMatchObject({
      episode: 2,
    });
    const urls = fetch.mock.calls.map((c) => c[0].slice(serverPath.length));
    expect(urls).toEqual([
      "/addon/meta/series/tt1",
      "/addon/streams/anime/kitsu%3A7%3A3?bingeGroup=grp%7C1080p",
      "/addon/subtitles/series/tt1%3A1%3A1",
      "/addon/next/series/tt1%3A1%3A1",
    ]);
  });

  it("marks addons as not configured on 503 and notifies listeners", async () => {
    mockFetch(() => json({ error: "aiostreams_not_configured" }, 503));
    const seen: boolean[] = [];
    const off = onAddonsConfiguredChange((c) => seen.push(c));
    expect(isAddonsConfigured()).toBe(true);
    const err = await searchTitles("x").catch((e) => e);
    expect(err).toBeInstanceOf(AddonApiError);
    expect(err.code).toBe("aiostreams_not_configured");
    expect(err.status).toBe(503);
    expect(isAddonsConfigured()).toBe(false);
    expect(seen).toEqual([false]);
    off();
  });

  it("maps upstream and unknown errors without leaking response bodies", async () => {
    mockFetch(() => json({ error: "upstream_timeout" }, 502));
    const err = await getStreams("movie", "tt1").catch((e) => e);
    expect(err.code).toBe("upstream_timeout");
    expect(err.message).toBe("The stream provider took too long to answer");

    mockFetch(
      () =>
        new Response("<html>secret https://aio.example.com/x</html>", {
          status: 500,
        }),
    );
    const err2 = await getStreams("movie", "tt1").catch((e) => e);
    expect(err2.code).toBe("unknown");
    expect(err2.message).not.toContain("aio.example.com");
    expect(isAddonsConfigured()).toBe(true);
  });

  it("maps network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await getMeta("movie", "tt1").catch((e) => e);
    expect(err.code).toBe("network");
  });

  it("searches YouTube through the server", async () => {
    const fetch = mockFetch(() =>
      json([
        { url: "https://www.youtube.com/watch?v=x", name: "X", duration: 60 },
      ]),
    );
    const res = await searchYouTube("cats & dogs");
    expect(fetch.mock.calls[0][0]).toBe(
      serverPath + "/youtube?q=cats%20%26%20dogs",
    );
    expect(res[0].type).toBe("youtube");
  });
});

describe("toStreamList", () => {
  it("normalizes arrays and unknown tiers", () => {
    const list = toStreamList({
      streams: [
        { url: "https://aio.example.com/p/1", tier: "weird" },
        { nope: 1 },
      ],
    });
    expect(list.streams).toHaveLength(1);
    expect(list.streams[0]).toMatchObject({
      tier: "unlikely",
      audio: [],
      hdr: [],
      reasons: [],
    });
    expect(list.total).toBe(1);
  });
});

describe("createDebouncedSearch", () => {
  it("debounces keystrokes and only calls the latest query", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async (q: string) => q.toUpperCase());
    const search = createDebouncedSearch(fn, 250);
    const results: string[] = [];
    search.run("s", (r) => results.push(r));
    vi.advanceTimersByTime(100);
    search.run("sh", (r) => results.push(r));
    vi.advanceTimersByTime(100);
    search.run("sha", (r) => results.push(r));
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe("sha");
    expect(results).toEqual(["SHA"]);
  });

  it("aborts the in-flight request when a new query arrives", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const fn = vi.fn(
      (q: string, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          signals.push(signal);
          if (q === "first") {
            release = () => resolve("first");
          } else {
            resolve(q);
          }
        }),
    );
    const search = createDebouncedSearch(fn, 250);
    const results: string[] = [];
    search.run("first", (r) => results.push(r));
    await vi.advanceTimersByTimeAsync(250);
    expect(signals[0].aborted).toBe(false);
    search.run("second", (r) => results.push(r));
    expect(signals[0].aborted).toBe(true);
    release(); // the stale response arrives late and is dropped
    await vi.advanceTimersByTimeAsync(250);
    expect(results).toEqual(["second"]);
  });

  it("aborts through fetch and stays silent on cancel()", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const search = createDebouncedSearch(
      (q, signal) => searchTitles(q, signal),
      250,
    );
    const onResult = vi.fn();
    const onError = vi.fn();
    search.run("shawshank", onResult, onError);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(1);
    search.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports errors for the latest query", async () => {
    vi.useFakeTimers();
    mockFetch(() => json({ error: "upstream_error" }, 502));
    const search = createDebouncedSearch(
      (q, signal) => searchTitles(q, signal),
      250,
    );
    const onError = vi.fn();
    search.run("x", () => {}, onError);
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe("upstream_error");
  });
});
