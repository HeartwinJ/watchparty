/**
 * Title search and metadata from public Stremio addons:
 * Cinemeta (movies/series, IMDb ids) and Anime Kitsu (anime, kitsu ids).
 */
import type { TtlCache } from "./cache.ts";
import { AddonError, fetchJson, type FetchFn } from "./http.ts";
import { parseContentId, type ContentType } from "./ids.ts";

export const CINEMETA_URL = "https://v3-cinemeta.strem.io";
export const KITSU_URL = "https://anime-kitsu.strem.fun";

export const META_TTL_MS = 60 * 60 * 1000;
const SEARCH_LIMIT = 20;

export type SearchItem = {
  id: string;
  /** Use this type for /addon/streams, /addon/meta etc. */
  type: "movie" | "series";
  name: string;
  year: number | null;
  poster: string | null;
};

export type SearchResults = {
  movies: SearchItem[];
  series: SearchItem[];
  anime: SearchItem[];
};

export type Episode = {
  /** Stream id: "tt0903747:1:2" or "kitsu:11:5" */
  id: string;
  season: number;
  episode: number;
  title: string | null;
  released: string | null;
  thumbnail: string | null;
};

export type Meta = {
  id: string;
  type: "movie" | "series";
  name: string;
  year: number | null;
  /** Raw release info, e.g. "2008–2013" */
  releaseInfo: string | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  description: string | null;
  runtime: string | null;
  genres: string[];
  imdbId: string | null;
  /** Empty for movies. Sorted by season, specials (season 0) last. */
  seasons: { season: number; episodes: Episode[] }[];
};

export class NotFoundError extends Error {
  constructor() {
    super("not_found");
    this.name = "NotFoundError";
  }
}

type RawMeta = Record<string, unknown>;
type RawVideo = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v)
      ? Number(v)
      : null;
const httpUrl = (v: unknown): string | null => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};
const parseYear = (v: unknown): number | null => {
  const m = (str(v) ?? (typeof v === "number" ? String(v) : "")).match(/\d{4}/);
  return m ? Number(m[0]) : null;
};
const normType = (v: unknown): "movie" | "series" =>
  v === "movie" ? "movie" : "series";

function toSearchItem(
  m: unknown,
  fallbackType: "movie" | "series",
): SearchItem | null {
  if (!m || typeof m !== "object") {
    return null;
  }
  const r = m as RawMeta;
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    type: r.type ? normType(r.type) : fallbackType,
    name,
    year: parseYear(r.releaseInfo ?? r.year),
    poster: httpUrl(r.poster),
  };
}

function metasOf(body: unknown, label: string): unknown[] {
  const metas = (body as { metas?: unknown } | null)?.metas;
  if (!Array.isArray(metas)) {
    throw new AddonError(label, "invalid_response");
  }
  return metas;
}

function videoEpisode(v: RawVideo): number | null {
  return num(v.episode) ?? num(v.number);
}

export function normalizeMeta(raw: RawMeta): Meta {
  const type = normType(raw.type);
  const seasons = new Map<number, Episode[]>();
  const videos = Array.isArray(raw.videos) ? (raw.videos as unknown[]) : [];
  if (type === "series") {
    for (const item of videos) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const v = item as RawVideo;
      const id = str(v.id);
      const season = num(v.season);
      const episode = videoEpisode(v);
      if (!id || season == null || episode == null) {
        continue;
      }
      const list = seasons.get(season) ?? [];
      list.push({
        id,
        season,
        episode,
        title: str(v.name) ?? str(v.title),
        released: str(v.released) ?? str(v.firstAired),
        thumbnail: httpUrl(v.thumbnail),
      });
      seasons.set(season, list);
    }
  }
  const genres = Array.isArray(raw.genres)
    ? (raw.genres as unknown[]).filter(
        (g): g is string => typeof g === "string",
      )
    : [];
  return {
    id: str(raw.id) ?? "",
    type,
    name: str(raw.name) ?? "",
    year: parseYear(raw.releaseInfo ?? raw.year),
    releaseInfo: str(raw.releaseInfo) ?? str(raw.year),
    poster: httpUrl(raw.poster),
    background: httpUrl(raw.background),
    logo: httpUrl(raw.logo),
    description: str(raw.description),
    runtime: str(raw.runtime),
    genres,
    imdbId: str(raw.imdb_id),
    seasons: [...seasons.entries()]
      .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
      .map(([season, episodes]) => ({
        season,
        episodes: episodes.sort((a, b) => a.episode - b.episode),
      })),
  };
}

/** The episode after `id` in watch order, skipping specials (season 0). */
export function findNextEpisode(
  meta: Meta,
  id: string,
  now = Date.now(),
): Episode | null {
  const current = meta.seasons
    .flatMap((s) => s.episodes)
    .find((e) => e.id === id);
  // Specials only lead to other specials
  const pool = meta.seasons
    .filter((s) => (current?.season === 0 ? s.season === 0 : s.season > 0))
    .flatMap((s) => s.episodes);
  const idx = pool.findIndex((e) => e.id === id);
  if (idx === -1) {
    return null;
  }
  const next = pool[idx + 1];
  if (!next) {
    return null;
  }
  if (next.released && Date.parse(next.released) > now) {
    return null; // Not aired yet
  }
  return next;
}

export function createCatalog(opts: {
  fetchFn: FetchFn;
  cache: TtlCache<unknown>;
  timeoutMs?: number;
  cinemetaUrl?: string;
  kitsuUrl?: string;
}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const cinemeta = opts.cinemetaUrl ?? CINEMETA_URL;
  const kitsu = opts.kitsuUrl ?? KITSU_URL;
  const get = (url: string, label: string) =>
    fetchJson(opts.fetchFn, url, { label, timeoutMs });

  async function search(q: string): Promise<SearchResults> {
    const query = q.trim().toLowerCase();
    return opts.cache.wrap(`search:${query}`, META_TTL_MS, async () => {
      const enc = encodeURIComponent(query);
      const results = await Promise.allSettled([
        get(
          `${cinemeta}/catalog/movie/top/search=${enc}.json`,
          "cinemeta search",
        ).then((b) => metasOf(b, "cinemeta search")),
        get(
          `${cinemeta}/catalog/series/top/search=${enc}.json`,
          "cinemeta search",
        ).then((b) => metasOf(b, "cinemeta search")),
        get(
          `${kitsu}/catalog/anime/kitsu-anime-list/search=${enc}.json`,
          "kitsu search",
        ).then((b) => metasOf(b, "kitsu search")),
      ]);
      if (results.every((r) => r.status === "rejected")) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
      const list = (i: number, type: "movie" | "series") => {
        const r = results[i];
        if (r.status !== "fulfilled") {
          return [];
        }
        return r.value
          .map((m) => toSearchItem(m, type))
          .filter((m): m is SearchItem => m !== null)
          .slice(0, SEARCH_LIMIT);
      };
      return {
        movies: list(0, "movie"),
        series: list(1, "series"),
        anime: list(2, "series"),
      };
    }) as Promise<SearchResults>;
  }

  /** Raw addon meta for a base id (no episode part). */
  async function rawMeta(type: ContentType, id: string): Promise<RawMeta> {
    const parsed = parseContentId(id);
    if (!parsed) {
      throw new NotFoundError();
    }
    const isKitsu = parsed.kind === "kitsu";
    // Kitsu's addon serves every kitsu id under "anime"; Cinemeta has no "anime" type
    const metaType = isKitsu ? "anime" : type === "movie" ? "movie" : "series";
    const key = `meta:${metaType}:${parsed.base}`;
    return opts.cache.wrap(key, META_TTL_MS, async () => {
      const label = isKitsu ? "kitsu meta" : "cinemeta meta";
      const base = isKitsu ? kitsu : cinemeta;
      let body: unknown;
      try {
        body = await get(`${base}/meta/${metaType}/${parsed.base}.json`, label);
      } catch (e) {
        if (e instanceof AddonError && e.upstreamStatus === 404) {
          throw new NotFoundError();
        }
        throw e;
      }
      const meta = (body as { meta?: unknown } | null)?.meta;
      if (!meta || typeof meta !== "object" || !str((meta as RawMeta).id)) {
        // Cinemeta answers unknown ids with {meta: null}
        throw new NotFoundError();
      }
      return meta as RawMeta;
    }) as Promise<RawMeta>;
  }

  async function meta(type: ContentType, id: string): Promise<Meta> {
    return normalizeMeta(await rawMeta(type, id));
  }

  async function nextEpisode(
    type: ContentType,
    id: string,
  ): Promise<Episode | null> {
    const parsed = parseContentId(id);
    if (!parsed || parsed.episode == null) {
      return null;
    }
    return findNextEpisode(
      await meta(type === "movie" ? "series" : type, parsed.base),
      id,
    );
  }

  /**
   * Maps a kitsu id to the IMDb id (+ season/episode) that the Kitsu addon
   * knows, for addons that only speak IMDb (OpenSubtitles).
   */
  async function kitsuToImdb(id: string): Promise<string | null> {
    const parsed = parseContentId(id);
    if (!parsed || parsed.kind !== "kitsu") {
      return null;
    }
    const raw = await rawMeta("anime", parsed.base);
    const imdb = str(raw.imdb_id);
    if (parsed.episode == null) {
      return imdb && /^tt\d+$/.test(imdb) ? imdb : null;
    }
    const videos = Array.isArray(raw.videos) ? (raw.videos as RawVideo[]) : [];
    const v = videos.find((x) => x && str(x.id) === id);
    const vImdb = (v && str(v.imdb_id)) ?? imdb;
    const s = v ? num(v.imdbSeason) : null;
    const e = v ? num(v.imdbEpisode) : null;
    if (!vImdb || !/^tt\d+$/.test(vImdb) || s == null || e == null) {
      return null;
    }
    return `${vImdb}:${s}:${e}`;
  }

  return { search, meta, nextEpisode, kitsuToImdb };
}

export type Catalog = ReturnType<typeof createCatalog>;
