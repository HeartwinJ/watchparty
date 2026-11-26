import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAddonRouter, type AddonRouterOptions } from "./routes.ts";
import type { FetchFn } from "./http.ts";

// Fake secret: the real one lives only in .env
const UUID = "00000000-aaaa-bbbb-cccc-123456789abc";
const CONFIG = "eyJpFAKEconfigBLOBwithCredentials0123456789";
const MANIFEST = `https://aio.example.com/stremio/${UUID}/${CONFIG}/manifest.json`;
const SECRET_PARTS = [MANIFEST, UUID, CONFIG];

const json = (body: unknown, status = 200) => Response.json(body, { status });

const SERIES_META = {
  meta: {
    id: "tt0903747",
    type: "series",
    name: "Breaking Bad",
    releaseInfo: "2008–2013",
    poster: "https://images.example/p.jpg",
    genres: ["Drama"],
    videos: [
      { id: "tt0903747:0:1", season: 0, episode: 1, name: "Special" },
      {
        id: "tt0903747:1:2",
        season: 1,
        episode: 2,
        name: "Cat's in the Bag",
        released: "2008-01-28T00:00:00.000Z",
      },
      {
        id: "tt0903747:1:1",
        season: 1,
        number: 1,
        name: "Pilot",
        released: "2008-01-21T00:00:00.000Z",
        thumbnail: "https://episodes.example/1.jpg",
      },
      {
        id: "tt0903747:2:1",
        season: 2,
        episode: 1,
        name: "Seven Thirty-Seven",
        released: "2009-03-08T00:00:00.000Z",
      },
      {
        id: "tt0903747:2:2",
        season: 2,
        episode: 2,
        name: "Future",
        released: "2999-01-01T00:00:00.000Z",
      },
      { id: "junk" },
      null,
    ],
  },
};

const KITSU_META = {
  meta: {
    id: "kitsu:11",
    type: "series",
    name: "Naruto",
    year: "2002-2007",
    imdb_id: "tt0409591",
    videos: [
      {
        id: "kitsu:11:1",
        season: 1,
        episode: 1,
        title: "Enter: Naruto Uzumaki!",
        imdb_id: "tt0409591",
        imdbSeason: 1,
        imdbEpisode: 1,
      },
      {
        id: "kitsu:11:2",
        season: 1,
        episode: 2,
        title: "My Name is Konohamaru!",
        imdb_id: "tt0409591",
        imdbSeason: 1,
        imdbEpisode: 2,
      },
    ],
  },
};

const STREAM = (i: number, extra: Record<string, unknown> = {}) => ({
  name: "🚀 FHD",
  description: `🎬 Movie \n🎥 WEB-DL 🎞️ AVC \n🎧 AAC 🔊 5.1\n📦 ${i} GB 📊 5 Mbps \n⚡Ready (TB) 🔍Comet `,
  url: `https://aio.example.com/api/v1/debrid/playback/opaque${i}/-/x/y/file${i}.mp4`,
  behaviorHints: {
    filename: `Movie.2020.1080p.WEB-DL.x264-GRP${i}.mp4`,
    videoSize: i * 1e9,
    bingeGroup: `aio.example.com|1080p|g${i}`,
  },
  ...extra,
});

type Handler = (url: string) => Response | Promise<Response>;

function defaultHandler(url: string): Response {
  const u = new URL(url);
  if (u.host === "v3-cinemeta.strem.io") {
    if (u.pathname.startsWith("/catalog/movie/")) {
      return json({
        metas: [
          {
            id: "tt0111161",
            type: "movie",
            name: "The Shawshank Redemption",
            releaseInfo: "1994",
            poster: "https://images.example/s.jpg",
          },
          { bad: true },
        ],
      });
    }
    if (u.pathname.startsWith("/catalog/series/")) {
      return json({
        metas: [
          {
            id: "tt0903747",
            type: "series",
            name: "Breaking Bad",
            releaseInfo: "2008–2013",
            poster: "javascript:alert(1)",
          },
        ],
      });
    }
    if (u.pathname === "/meta/series/tt0903747.json") {
      return json(SERIES_META);
    }
    if (u.pathname === "/meta/movie/tt0111161.json") {
      return json({
        meta: {
          id: "tt0111161",
          type: "movie",
          name: "The Shawshank Redemption",
          releaseInfo: "1994",
        },
      });
    }
    return json({ meta: null });
  }
  if (u.host === "anime-kitsu.strem.fun") {
    if (u.pathname.startsWith("/catalog/anime/kitsu-anime-list/search=")) {
      return json({
        metas: [
          {
            id: "kitsu:11",
            type: "series",
            name: "Naruto",
            releaseInfo: "2002-2007",
          },
        ],
      });
    }
    if (u.pathname === "/meta/anime/kitsu:11.json") {
      return json(KITSU_META);
    }
    return new Response("not found", { status: 404 });
  }
  if (u.host === "opensubtitles-v3.strem.io") {
    return json({
      subtitles: [
        { id: "1", url: "https://subs.example/1.srt", lang: "spa" },
        { id: "2", url: "https://subs.example/2.srt", lang: "eng" },
        { id: "3", url: "https://subs.example/3.srt", lang: "eng" },
        { id: "4", url: "https://subs.example/4.srt", lang: "pob" },
        { id: "5", url: "not-a-url", lang: "eng" },
        { id: "6", url: "https://subs.example/6.srt", lang: "fre" },
      ],
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

function aioHandler(url: string): Response {
  if (
    !url.startsWith(`https://aio.example.com/stremio/${UUID}/${CONFIG}/stream/`)
  ) {
    throw new Error("unexpected aio fetch");
  }
  return json({
    streams: [
      STREAM(3),
      STREAM(2),
      { name: "torrent", infoHash: "abc" },
      STREAM(1, { description: "🎞️ HEVC\n🎧 DD+" }),
    ],
  });
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
  vi.restoreAllMocks();
});

const allowAuth: RequestHandler = (req, res, next) => {
  if (req.headers["x-test-auth"] !== "ok") {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};

async function start(
  overrides: Partial<AddonRouterOptions> & {
    handler?: Handler;
    aio?: Handler;
  } = {},
) {
  const logs: string[] = [];
  const fetchFn = vi.fn<FetchFn>(async (url) =>
    (overrides.handler ?? defaultHandler)(String(url)),
  );
  const aioFetchFn = vi.fn<FetchFn>(async (url) =>
    (overrides.aio ?? aioHandler)(String(url)),
  );
  const app = express();
  app.use(
    createAddonRouter({
      manifestUrl: MANIFEST,
      subtitleLangs: "en",
      requireAuth: allowAuth,
      fetchFn,
      aioFetchFn,
      timeoutMs: 200,
      aioTimeoutMs: 200,
      log: (m) => logs.push(m),
      ...overrides,
    }),
  );
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  const port = (server!.address() as AddressInfo).port;
  const get = async (path: string, auth = true) => {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: auth ? { "x-test-auth": "ok" } : {},
    });
    const text = await resp.text();
    return { status: resp.status, text, body: JSON.parse(text) };
  };
  return { get, logs, fetchFn, aioFetchFn };
}

function expectNoSecret(...texts: string[]) {
  for (const t of texts) {
    for (const s of SECRET_PARTS) {
      expect(t).not.toContain(s);
    }
  }
}

describe("addon routes: guards", () => {
  it("requires auth before anything else", async () => {
    const { get } = await start({ manifestUrl: "" });
    expect((await get("/addon/search?q=x", false)).status).toBe(401);
  });

  it("requires auth on every route, including /addon/status", async () => {
    const { get, fetchFn, aioFetchFn } = await start();
    for (const path of [
      "/addon/status",
      "/addon/search?q=x",
      "/addon/meta/movie/tt0111161",
      "/addon/streams/movie/tt0111161",
      "/addon/subtitles/movie/tt0111161",
      "/addon/next/series/tt0903747:1:1",
    ]) {
      expect((await get(path, false)).status).toBe(401);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(aioFetchFn).not.toHaveBeenCalled();
  });

  it("returns 503 for streams only when AIOStreams isn't configured", async () => {
    const { get, aioFetchFn } = await start({ manifestUrl: "" });
    const r = await get("/addon/streams/movie/tt0111161");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "aiostreams_not_configured" });
    expect(aioFetchFn).not.toHaveBeenCalled();
  });

  it("serves search, meta, subtitles and next episode without AIOStreams", async () => {
    const { get, aioFetchFn } = await start({ manifestUrl: "" });
    const search = await get("/addon/search?q=Breaking");
    expect(search.status).toBe(200);
    expect(search.body.series[0].id).toBe("tt0903747");
    const meta = await get("/addon/meta/series/tt0903747");
    expect(meta.status).toBe(200);
    expect(meta.body.name).toBe("Breaking Bad");
    const subs = await get("/addon/subtitles/series/tt0903747:1:1");
    expect(subs.status).toBe(200);
    expect(subs.body[0].lang).toBe("en");
    const next = await get("/addon/next/series/tt0903747:1:1");
    expect(next.status).toBe(200);
    expect(next.body.next.id).toBe("tt0903747:1:2");
    expect(aioFetchFn).not.toHaveBeenCalled();
  });

  it("reports whether streams are available", async () => {
    expect((await (await start()).get("/addon/status")).body).toEqual({
      streams: true,
    });
    server?.close();
    const { get, fetchFn } = await start({ manifestUrl: "" });
    const r = await get("/addon/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ streams: false });
    expectNoSecret(r.text);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    "/addon/meta/tv/tt0111161",
    "/addon/meta/movie/tt",
    "/addon/meta/movie/nm0000001",
    "/addon/streams/movie/tt0111161:1",
    "/addon/streams/movie/tt0111161:1:2:3",
    "/addon/streams/series/kitsu:11:1:1",
    "/addon/streams/series/kitsu:abc",
    "/addon/streams/movie/..%2F..%2Fmanifest",
    "/addon/streams/movie/tt0111161.json",
    "/addon/subtitles/movie/tt0111161%20",
    "/addon/next/series/mal:1",
  ])("rejects invalid params: %s", async (path) => {
    const { get, fetchFn, aioFetchFn } = await start();
    const r = await get(path);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_params" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(aioFetchFn).not.toHaveBeenCalled();
  });

  it.each([
    "/addon/search",
    "/addon/search?q=",
    "/addon/search?q=%20%20",
    `/addon/search?q=${"a".repeat(101)}`,
  ])("rejects a bad search query: %s", async (path) => {
    const { get } = await start();
    expect((await get(path)).status).toBe(400);
  });
});

describe("GET /addon/search", () => {
  it("merges Cinemeta and Kitsu results", async () => {
    const { get, fetchFn } = await start();
    const r = await get("/addon/search?q=Shawshank%20%26%20co");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      movies: [
        {
          id: "tt0111161",
          type: "movie",
          name: "The Shawshank Redemption",
          year: 1994,
          poster: "https://images.example/s.jpg",
        },
      ],
      series: [
        {
          id: "tt0903747",
          type: "series",
          name: "Breaking Bad",
          year: 2008,
          poster: null,
        },
      ],
      anime: [
        {
          id: "kitsu:11",
          type: "series",
          name: "Naruto",
          year: 2002,
          poster: null,
        },
      ],
    });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      "https://v3-cinemeta.strem.io/catalog/movie/top/search=shawshank%20%26%20co.json",
    );
    // Cached for an hour
    await get("/addon/search?q=shawshank%20%26%20CO");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("still answers when one source fails", async () => {
    const { get } = await start({
      handler: (url) =>
        url.includes("kitsu")
          ? new Response("down", { status: 500 })
          : defaultHandler(url),
    });
    const r = await get("/addon/search?q=naruto");
    expect(r.status).toBe(200);
    expect(r.body.anime).toEqual([]);
    expect(r.body.movies).toHaveLength(1);
  });

  it("502s when every source fails", async () => {
    const { get } = await start({
      handler: () => new Response("down", { status: 500 }),
    });
    const r = await get("/addon/search?q=naruto");
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "upstream_error" });
  });
});

describe("GET /addon/meta", () => {
  it("normalizes a series into seasons and episodes", async () => {
    const { get } = await start();
    const r = await get("/addon/meta/series/tt0903747:1:1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: "tt0903747",
      type: "series",
      name: "Breaking Bad",
      year: 2008,
      releaseInfo: "2008–2013",
      genres: ["Drama"],
    });
    expect(r.body.seasons.map((s: { season: number }) => s.season)).toEqual([
      1, 2, 0,
    ]);
    expect(r.body.seasons[0].episodes).toEqual([
      {
        id: "tt0903747:1:1",
        season: 1,
        episode: 1,
        title: "Pilot",
        released: "2008-01-21T00:00:00.000Z",
        thumbnail: "https://episodes.example/1.jpg",
      },
      {
        id: "tt0903747:1:2",
        season: 1,
        episode: 2,
        title: "Cat's in the Bag",
        released: "2008-01-28T00:00:00.000Z",
        thumbnail: null,
      },
    ]);
  });

  it("returns a movie with no seasons", async () => {
    const { get } = await start();
    const r = await get("/addon/meta/movie/tt0111161");
    expect(r.body).toMatchObject({
      id: "tt0111161",
      type: "movie",
      year: 1994,
      seasons: [],
    });
  });

  it("uses the Kitsu addon for kitsu ids", async () => {
    const { get, fetchFn } = await start();
    const r = await get("/addon/meta/anime/kitsu:11");
    expect(r.body.seasons[0].episodes[1]).toMatchObject({
      id: "kitsu:11:2",
      episode: 2,
      title: "My Name is Konohamaru!",
    });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      "https://anime-kitsu.strem.fun/meta/anime/kitsu:11.json",
    );
  });

  it("404s for unknown ids", async () => {
    const { get } = await start();
    expect((await get("/addon/meta/movie/tt9999999")).status).toBe(404);
    expect((await get("/addon/meta/anime/kitsu:999")).status).toBe(404);
  });
});

describe("GET /addon/streams", () => {
  it("returns ranked streams with counts", async () => {
    const { get, aioFetchFn } = await start();
    const r = await get("/addon/streams/movie/tt0111161");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.counts).toEqual({
      direct: 2,
      "convert-light": 0,
      "convert-heavy": 1,
      unlikely: 0,
    });
    expect(r.body.streams.map((s: { tier: string }) => s.tier)).toEqual([
      "direct",
      "direct",
      "convert-heavy",
    ]);
    expect(r.body.streams[0].url).toBe(
      "https://aio.example.com/api/v1/debrid/playback/opaque3/-/x/y/file3.mp4",
    );
    expect(r.body.streams[0]).not.toHaveProperty("description");
    expect(String(aioFetchFn.mock.calls[0][0])).toBe(
      `https://aio.example.com/stremio/${UUID}/${CONFIG}/stream/movie/tt0111161.json`,
    );
    expectNoSecret(r.text);
  });

  it("looks kitsu ids up as anime", async () => {
    const { get, aioFetchFn } = await start();
    expect((await get("/addon/streams/series/kitsu:11:1")).status).toBe(200);
    await get("/addon/streams/anime/kitsu:11:1");
    expect(aioFetchFn).toHaveBeenCalledTimes(1);
    expect(String(aioFetchFn.mock.calls[0][0])).toMatch(
      /\/stream\/anime\/kitsu:11:1\.json$/,
    );
  });

  it("caches lookups and de-duplicates concurrent ones", async () => {
    const { get, aioFetchFn } = await start();
    await Promise.all([
      get("/addon/streams/series/tt0903747:1:1"),
      get("/addon/streams/series/tt0903747:1:1"),
    ]);
    await get("/addon/streams/series/tt0903747:1:1?bingeGroup=x");
    expect(aioFetchFn).toHaveBeenCalledTimes(1);
  });

  it("boosts the requested bingeGroup", async () => {
    const { get } = await start();
    const plain = await get("/addon/streams/movie/tt0111161");
    expect(plain.body.streams[0].bingeGroup).toBe("aio.example.com|1080p|g3");
    const boosted = await get(
      `/addon/streams/movie/tt0111161?bingeGroup=${encodeURIComponent("aio.example.com|1080p|g2")}`,
    );
    expect(boosted.body.streams[0].bingeGroup).toBe("aio.example.com|1080p|g2");
  });

  it("502s on upstream errors without leaking the manifest URL", async () => {
    const { get, logs } = await start({
      aio: () => new Response(`bad ${MANIFEST}`, { status: 500 }),
    });
    const r = await get("/addon/streams/movie/tt0111161");
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "upstream_error" });
    expect(logs).toEqual(["[addon] streams failed: aiostreams: http 500"]);
    expectNoSecret(r.text, ...logs);
  });

  it("502s on timeout without leaking the manifest URL", async () => {
    const { get, logs } = await start({
      aioFetchFn: (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          ),
        ),
      aioTimeoutMs: 30,
    });
    const r = await get("/addon/streams/movie/tt0111161");
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "upstream_timeout" });
    expectNoSecret(r.text, ...logs);
  });

  it("never leaks the manifest URL from network errors, logs or console", async () => {
    const consoleSpies = (
      ["log", "warn", "error", "info", "debug"] as const
    ).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { get, logs } = await start({
      aioFetchFn: async (url) => {
        throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url}`);
      },
      log: undefined, // default logger (console.warn)
    });
    const r = await get("/addon/streams/series/tt0903747:1:1");
    expect(r.status).toBe(502);
    const consoleOutput = consoleSpies.flatMap((s) =>
      s.mock.calls.flat().map(String),
    );
    expect(consoleOutput.join("\n")).toContain(
      "[addon] streams failed: aiostreams: network",
    );
    expectNoSecret(r.text, ...logs, ...consoleOutput);
  });

  it("502s on a malformed response", async () => {
    const { get } = await start({ aio: () => json({ nope: true }) });
    expect((await get("/addon/streams/movie/tt0111161")).status).toBe(502);
  });

  it("does not cache failures", async () => {
    let calls = 0;
    const { get } = await start({
      aio: (url) =>
        ++calls === 1 ? new Response("x", { status: 503 }) : aioHandler(url),
    });
    expect((await get("/addon/streams/movie/tt0111161")).status).toBe(502);
    expect((await get("/addon/streams/movie/tt0111161")).status).toBe(200);
  });
});

describe("GET /addon/subtitles", () => {
  it("returns subtitles with preferred languages first", async () => {
    const { get, fetchFn } = await start({ subtitleLangs: "pt-BR, en" });
    const r = await get("/addon/subtitles/series/tt0903747:1:1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        id: "4",
        lang: "pt-BR",
        label: "Brazilian Portuguese",
        url: "https://subs.example/4.srt",
      },
      {
        id: "2",
        lang: "en",
        label: "English",
        url: "https://subs.example/2.srt",
      },
      {
        id: "3",
        lang: "en",
        label: "English 2",
        url: "https://subs.example/3.srt",
      },
      {
        id: "6",
        lang: "fr",
        label: "French",
        url: "https://subs.example/6.srt",
      },
      {
        id: "1",
        lang: "es",
        label: "Spanish",
        url: "https://subs.example/1.srt",
      },
    ]);
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      "https://opensubtitles-v3.strem.io/subtitles/series/tt0903747:1:1.json",
    );
  });

  it("maps kitsu episodes to IMDb ids", async () => {
    const { get, fetchFn } = await start();
    const r = await get("/addon/subtitles/series/kitsu:11:2");
    expect(r.body[0].lang).toBe("en");
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://anime-kitsu.strem.fun/meta/anime/kitsu:11.json",
      "https://opensubtitles-v3.strem.io/subtitles/series/tt0409591:1:2.json",
    ]);
  });

  it("returns [] when a kitsu id has no IMDb mapping", async () => {
    const { get } = await start();
    expect((await get("/addon/subtitles/series/kitsu:11:99")).body).toEqual([]);
  });

  it("502s when OpenSubtitles is down", async () => {
    const { get } = await start({
      handler: () => new Response("x", { status: 500 }),
    });
    expect((await get("/addon/subtitles/movie/tt0111161")).status).toBe(502);
  });
});

describe("GET /addon/next", () => {
  it.each([
    ["tt0903747:1:1", "tt0903747:1:2"],
    ["tt0903747:1:2", "tt0903747:2:1"], // across seasons
    ["tt0903747:2:1", null], // next one hasn't aired
    ["tt0903747:0:1", null], // specials don't lead into the main seasons
    ["tt0903747:9:9", null], // unknown episode
  ])("%s → %s", async (id, next) => {
    const { get } = await start();
    const r = await get(`/addon/next/series/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.next?.id ?? null).toBe(next);
  });

  it("works for kitsu episodes", async () => {
    const { get } = await start();
    const r = await get("/addon/next/series/kitsu:11:1");
    expect(r.body.next).toMatchObject({
      id: "kitsu:11:2",
      season: 1,
      episode: 2,
    });
    expect((await get("/addon/next/series/kitsu:11:2")).body).toEqual({
      next: null,
    });
  });

  it("is null for movies / ids without an episode", async () => {
    const { get, fetchFn } = await start();
    expect((await get("/addon/next/movie/tt0111161")).body).toEqual({
      next: null,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
