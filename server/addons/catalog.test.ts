// Cinemeta + Kitsu catalog client (catalog.ts) against a stubbed fetch: search, meta normalization, next episode and
// Kitsu → IMDb mapping.
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.ts";
import {
  CINEMETA_URL,
  KITSU_URL,
  NotFoundError,
  createCatalog,
  findNextEpisode,
  normalizeMeta,
} from "./catalog.ts";
import { AddonError } from "./http.ts";

type Routes = Record<string, unknown | ((url: string) => Response)>;

function setup(routes: Routes) {
  const fetchFn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) {
      return new Response("not found", { status: 404 });
    }
    const v = hit[1];
    return typeof v === "function"
      ? (v as (u: string) => Response)(url)
      : Response.json(v);
  });
  const catalog = createCatalog({
    fetchFn: fetchFn as unknown as typeof fetch,
    cache: new TtlCache({ maxEntries: 100 }),
  });
  return { catalog, fetchFn };
}

const C = CINEMETA_URL;
const K = KITSU_URL;

describe("search", () => {
  it("normalizes the three groups and skips invalid items", async () => {
    const { catalog, fetchFn } = setup({
      [`${C}/catalog/movie/`]: {
        metas: [
          {
            id: "tt1",
            name: " Movie ",
            type: "movie",
            releaseInfo: "1999",
            poster: "https://img.example.com/p.jpg",
          },
          { id: "tt2", name: "No poster", year: 2001, poster: "ftp://x" },
          { id: "", name: "No id" },
          { id: "tt3" },
          null,
          "garbage",
        ],
      },
      [`${C}/catalog/series/`]: {
        metas: [{ id: "tt9", name: "Show", releaseInfo: "2010–2014" }],
      },
      [`${K}/catalog/anime/`]: { metas: "not an array" },
    });
    const r = await catalog.search("  The Thing ");
    expect(r.movies).toEqual([
      {
        id: "tt1",
        type: "movie",
        name: "Movie",
        year: 1999,
        poster: "https://img.example.com/p.jpg",
      },
      { id: "tt2", type: "movie", name: "No poster", year: 2001, poster: null },
    ]);
    expect(r.series).toEqual([
      { id: "tt9", type: "series", name: "Show", year: 2010, poster: null },
    ]);
    // An invalid group is just empty
    expect(r.anime).toEqual([]);
    expect(String(fetchFn.mock.calls[0][0])).toContain(
      "search=the%20thing.json",
    );
    // Cached by the normalized query
    await catalog.search("the thing");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("fails when every source fails", async () => {
    const { catalog } = setup({});
    await expect(catalog.search("x")).rejects.toBeInstanceOf(AddonError);
  });
});

describe("normalizeMeta", () => {
  it("builds sorted seasons with specials last and drops bad videos", () => {
    const meta = normalizeMeta({
      id: "tt5",
      type: "series",
      name: "Show",
      year: "2020",
      genres: ["Drama", 5],
      imdb_id: "tt5",
      videos: [
        { id: "tt5:2:1", season: 2, episode: 1, name: "S2E1" },
        { id: "tt5:1:2", season: "1", number: "2", title: "Two" },
        { id: "tt5:1:1", season: 1, episode: 1, firstAired: "2020-01-01" },
        { id: "tt5:0:1", season: 0, episode: 1 },
        { id: "", season: 1, episode: 3 },
        { id: "tt5:x", season: "one", episode: 1 },
        null,
      ],
    });
    expect(meta.seasons.map((s) => s.season)).toEqual([1, 2, 0]);
    expect(meta.seasons[0].episodes).toMatchObject([
      { id: "tt5:1:1", title: null, released: "2020-01-01" },
      { id: "tt5:1:2", episode: 2, title: "Two" },
    ]);
    expect(meta.genres).toEqual(["Drama"]);
    expect(meta.year).toBe(2020);
    expect(meta.releaseInfo).toBe("2020");
  });

  it("gives movies no seasons and fills missing fields", () => {
    const meta = normalizeMeta({ type: "movie", videos: [{ id: "x" }] });
    expect(meta).toMatchObject({
      id: "",
      name: "",
      type: "movie",
      seasons: [],
      genres: [],
      year: null,
      poster: null,
    });
  });
});

describe("findNextEpisode", () => {
  const meta = normalizeMeta({
    id: "tt7",
    type: "series",
    videos: [
      { id: "tt7:1:1", season: 1, episode: 1 },
      { id: "tt7:1:2", season: 1, episode: 2, released: "2999-01-01" },
      { id: "tt7:0:1", season: 0, episode: 1 },
      { id: "tt7:0:2", season: 0, episode: 2 },
    ],
  });

  it("skips into specials only from specials, and not into unaired ones", () => {
    expect(findNextEpisode(meta, "tt7:1:1")).toBeNull();
    expect(findNextEpisode(meta, "tt7:1:1", Date.parse("3000-01-01"))?.id).toBe(
      "tt7:1:2",
    );
    expect(findNextEpisode(meta, "tt7:0:1")?.id).toBe("tt7:0:2");
    expect(findNextEpisode(meta, "tt7:0:2")).toBeNull();
    expect(findNextEpisode(meta, "tt7:9:9")).toBeNull();
  });
});

describe("meta", () => {
  it("queries Cinemeta by type and Kitsu as anime", async () => {
    const { catalog, fetchFn } = setup({
      [`${C}/meta/movie/tt1.json`]: { meta: { id: "tt1", type: "movie" } },
      [`${C}/meta/series/tt2.json`]: { meta: { id: "tt2", type: "series" } },
      [`${K}/meta/anime/kitsu:3.json`]: { meta: { id: "kitsu:3" } },
    });
    expect((await catalog.meta("movie", "tt1")).id).toBe("tt1");
    expect((await catalog.meta("anime", "tt2:1:1")).id).toBe("tt2");
    expect((await catalog.meta("series", "kitsu:3:4")).id).toBe("kitsu:3");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("answers NotFoundError for bad ids, 404s and {meta: null}", async () => {
    const { catalog } = setup({
      [`${C}/meta/movie/tt1.json`]: { meta: null },
      [`${C}/meta/movie/tt2.json`]: { meta: { id: "" } },
      [`${C}/meta/movie/tt3.json`]: () => new Response("x", { status: 500 }),
    });
    await expect(catalog.meta("movie", "nope")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(catalog.meta("movie", "tt1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(catalog.meta("movie", "tt2")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(catalog.meta("movie", "tt404")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Other upstream errors pass through
    await expect(catalog.meta("movie", "tt3")).rejects.toBeInstanceOf(
      AddonError,
    );
  });
});

describe("nextEpisode", () => {
  it("looks up the series for an episode id, and nothing for movies", async () => {
    const { catalog } = setup({
      [`${C}/meta/series/tt4.json`]: {
        meta: {
          id: "tt4",
          type: "series",
          videos: [
            { id: "tt4:1:1", season: 1, episode: 1 },
            { id: "tt4:1:2", season: 1, episode: 2 },
          ],
        },
      },
    });
    expect((await catalog.nextEpisode("movie", "tt4:1:1"))?.id).toBe("tt4:1:2");
    expect(await catalog.nextEpisode("series", "tt4")).toBeNull();
    expect(await catalog.nextEpisode("series", "garbage")).toBeNull();
  });
});

describe("kitsuToImdb", () => {
  const routes = {
    [`${K}/meta/anime/kitsu:1.json`]: {
      meta: {
        id: "kitsu:1",
        imdb_id: "tt100",
        videos: [
          { id: "kitsu:1:1", imdbSeason: 1, imdbEpisode: 1 },
          { id: "kitsu:1:2", imdb_id: "tt200", imdbSeason: 2, imdbEpisode: 5 },
          { id: "kitsu:1:3" },
        ],
      },
    },
    [`${K}/meta/anime/kitsu:2.json`]: {
      meta: { id: "kitsu:2", imdb_id: "not-imdb", videos: "nope" },
    },
  };

  it("maps a show or an episode to its IMDb id", async () => {
    const { catalog } = setup(routes);
    expect(await catalog.kitsuToImdb("kitsu:1")).toBe("tt100");
    expect(await catalog.kitsuToImdb("kitsu:1:1")).toBe("tt100:1:1");
    expect(await catalog.kitsuToImdb("kitsu:1:2")).toBe("tt200:2:5");
  });

  it("gives null for non-Kitsu ids, unmapped episodes and bad IMDb ids", async () => {
    const { catalog } = setup(routes);
    expect(await catalog.kitsuToImdb("tt1")).toBeNull();
    expect(await catalog.kitsuToImdb("kitsu:1:3")).toBeNull();
    expect(await catalog.kitsuToImdb("kitsu:1:9")).toBeNull();
    expect(await catalog.kitsuToImdb("kitsu:2")).toBeNull();
    expect(await catalog.kitsuToImdb("kitsu:2:1")).toBeNull();
  });
});
