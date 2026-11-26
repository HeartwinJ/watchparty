/**
 * Typed client for the AIOStreams/Stremio addon routes (`/addon/*`, see server/addons/ and the Addon API section in
 * CLAUDE.md), plus the YouTube search used by the source picker. Everything goes through apiFetch (session cookie,
 * 401 handling) and accepts an AbortSignal so a newer keystroke can cancel an older request.
 *
 * Stream playback URLs carry an encrypted debrid credential: never log them or put them in error messages.
 */
import { apiFetch } from "../utils/api";

// ---- DTOs (mirror server/addons/catalog.ts, streamParser.ts, subtitles.ts) ----

export type ContentType = "movie" | "series" | "anime";

export type SearchItem = {
  id: string;
  /** What the server calls it ("movie" | "series"); anime items are "series" or "movie" with a kitsu id */
  type: "movie" | "series";
  name: string;
  year: number | null;
  poster: string | null;
};

/** A search result with the type to use for /addon/meta and /addon/streams */
export type TitleRef = SearchItem & { kind: ContentType };

export type SearchResults = {
  movies: TitleRef[];
  series: TitleRef[];
  anime: TitleRef[];
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
  releaseInfo: string | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  description: string | null;
  runtime: string | null;
  genres: string[];
  imdbId: string | null;
  seasons: { season: number; episodes: Episode[] }[];
};

export type Tier = "direct" | "convert-light" | "convert-heavy" | "unlikely";
export const TIERS: readonly Tier[] = [
  "direct",
  "convert-light",
  "convert-heavy",
  "unlikely",
];

export type VideoCodec =
  "h264" | "hevc" | "av1" | "vp9" | "vc1" | "mpeg2" | "mpeg4";
export type AudioCodec =
  | "aac"
  | "opus"
  | "mp3"
  | "flac"
  | "ac3"
  | "eac3"
  | "dts"
  | "dts-hd"
  | "truehd"
  | "atmos"
  | "pcm";

export type StreamDTO = {
  url: string;
  name: string;
  title: string | null;
  filename: string | null;
  resolution: string | null;
  sizeBytes: number | null;
  bitrateMbps: number | null;
  durationSec: number | null;
  source: string | null;
  remux: boolean;
  videoCodec: VideoCodec | null;
  bitDepth: 8 | 10 | null;
  hdr: string[];
  audio: AudioCodec[];
  languages: string[];
  container: string | null;
  cached: boolean | null;
  service: string | null;
  addon: string | null;
  indexer: string | null;
  releaseGroup: string | null;
  bingeGroup: string | null;
  tier: Tier;
  reasons: string[];
  score: number;
};

export type StreamList = {
  streams: StreamDTO[];
  counts: Record<Tier, number>;
  total: number;
};

export type Subtitle = { id: string; lang: string; label: string; url: string };

// ---- Errors ----

export type AddonErrorCode =
  | "aiostreams_not_configured"
  | "invalid_params"
  | "invalid_query"
  | "not_found"
  | "upstream_error"
  | "upstream_timeout"
  | "unauthorized"
  | "network"
  | "unknown";

export class AddonApiError extends Error {
  readonly code: AddonErrorCode;
  readonly status: number;
  constructor(code: AddonErrorCode, status: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "AddonApiError";
    this.code = code;
    this.status = status;
  }
}

const ERROR_MESSAGES: Record<AddonErrorCode, string> = {
  aiostreams_not_configured: "Movies & Shows aren't set up on this server",
  invalid_params: "That title can't be looked up",
  invalid_query: "Search for 1 to 100 characters",
  not_found: "Not found",
  upstream_error: "The stream provider didn't answer",
  upstream_timeout: "The stream provider took too long to answer",
  unauthorized: "You're logged out",
  network: "Network error",
  unknown: "Something went wrong",
};

export const isAbortError = (e: unknown) =>
  e instanceof DOMException
    ? e.name === "AbortError"
    : (e as Error)?.name === "AbortError";

/**
 * Whether the server has AIOStreams configured (streams for Movies & Shows). Starts optimistic; `probeAddonsStatus()`
 * (GET /addon/status, once per page load) or the first 503 `aiostreams_not_configured` flips it so the picker can
 * hide the Movies & Shows section for the rest of the session. Title search, meta and subtitles work either way
 * (the subtitle search uses them).
 */
let addonsConfigured = true;
const configuredListeners = new Set<(configured: boolean) => void>();

export function isAddonsConfigured() {
  return addonsConfigured;
}

export function onAddonsConfiguredChange(fn: (configured: boolean) => void) {
  configuredListeners.add(fn);
  return () => {
    configuredListeners.delete(fn);
  };
}

let statusProbe: Promise<boolean> | undefined;

/** Asks the server once whether streams are available; failures leave the optimistic value. */
export function probeAddonsStatus(): Promise<boolean> {
  statusProbe ??= getJson<{ streams?: unknown }>("/addon/status")
    .then((s) => {
      const configured = s?.streams !== false;
      setConfigured(configured);
      return configured;
    })
    .catch(() => {
      statusProbe = undefined;
      return addonsConfigured;
    });
  return statusProbe;
}

/** Test helper */
export function resetAddonsConfigured() {
  addonsConfigured = true;
  statusProbe = undefined;
}

function setConfigured(configured: boolean) {
  if (configured !== addonsConfigured) {
    addonsConfigured = configured;
    configuredListeners.forEach((fn) => fn(configured));
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, { signal });
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    throw new AddonApiError("network", 0);
  }
  if (res.ok) {
    return (await res.json()) as T;
  }
  let code: AddonErrorCode = "unknown";
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error && body.error in ERROR_MESSAGES) {
      code = body.error as AddonErrorCode;
    }
  } catch {
    // Not JSON
  }
  if (res.status === 401) {
    code = "unauthorized";
  }
  if (code === "aiostreams_not_configured") {
    setConfigured(false);
  }
  throw new AddonApiError(code, res.status);
}

const enc = encodeURIComponent;

// ---- DTO mapping (defensive: a missing group or field shouldn't break the picker) ----

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function toTitleRefs(items: unknown, kind?: ContentType): TitleRef[] {
  return arr<SearchItem>(items)
    .filter((i) => i && typeof i.id === "string" && typeof i.name === "string")
    .map((i) => ({
      id: i.id,
      type: i.type === "movie" ? "movie" : "series",
      name: i.name,
      year: typeof i.year === "number" ? i.year : null,
      poster: typeof i.poster === "string" ? i.poster : null,
      // Kitsu ids are always looked up as anime (as series, AIOStreams returns unrelated results)
      kind:
        kind ??
        (i.id.startsWith("kitsu:")
          ? "anime"
          : i.type === "movie"
            ? "movie"
            : "series"),
    }));
}

export function toSearchResults(json: unknown): SearchResults {
  const o = (json ?? {}) as Record<string, unknown>;
  return {
    movies: toTitleRefs(o.movies),
    series: toTitleRefs(o.series),
    anime: toTitleRefs(o.anime, "anime"),
  };
}

export function toStreamList(json: unknown): StreamList {
  const o = (json ?? {}) as Partial<StreamList>;
  const streams = arr<StreamDTO>(o.streams)
    .filter((s) => s && typeof s.url === "string")
    .map((s) => ({
      ...s,
      hdr: arr<string>(s.hdr),
      audio: arr<AudioCodec>(s.audio),
      languages: arr<string>(s.languages),
      reasons: arr<string>(s.reasons),
      tier: (TIERS as readonly string[]).includes(s.tier) ? s.tier : "unlikely",
    }));
  const counts = {
    direct: 0,
    "convert-light": 0,
    "convert-heavy": 0,
    unlikely: 0,
  };
  for (const tier of TIERS) {
    const n = o.counts?.[tier];
    counts[tier] = typeof n === "number" ? n : 0;
  }
  return {
    streams,
    counts,
    total: typeof o.total === "number" ? o.total : streams.length,
  };
}

export function toMeta(json: unknown): Meta {
  const m = json as Meta;
  return {
    ...m,
    genres: arr<string>(m.genres),
    seasons: arr<Meta["seasons"][number]>(m.seasons).map((s) => ({
      season: s.season,
      episodes: arr<Episode>(s.episodes),
    })),
  };
}

// ---- Endpoints ----

export async function searchTitles(
  q: string,
  signal?: AbortSignal,
): Promise<SearchResults> {
  return toSearchResults(
    await getJson(`/addon/search?q=${enc(q.trim().slice(0, 100))}`, signal),
  );
}

export async function getMeta(
  type: ContentType,
  id: string,
  signal?: AbortSignal,
): Promise<Meta> {
  return toMeta(await getJson(`/addon/meta/${type}/${enc(id)}`, signal));
}

export async function getStreams(
  type: ContentType,
  id: string,
  opts: { bingeGroup?: string | null; signal?: AbortSignal } = {},
): Promise<StreamList> {
  const query = opts.bingeGroup ? `?bingeGroup=${enc(opts.bingeGroup)}` : "";
  return toStreamList(
    await getJson(`/addon/streams/${type}/${enc(id)}${query}`, opts.signal),
  );
}

export async function getSubtitles(
  type: ContentType,
  id: string,
  signal?: AbortSignal,
): Promise<Subtitle[]> {
  return arr<Subtitle>(
    await getJson(`/addon/subtitles/${type}/${enc(id)}`, signal),
  );
}

export async function getNextEpisode(
  type: ContentType,
  id: string,
  signal?: AbortSignal,
): Promise<Episode | null> {
  const res = await getJson<{ next?: Episode | null }>(
    `/addon/next/${type}/${enc(id)}`,
    signal,
  );
  return res?.next ?? null;
}

/** YouTube search via the server's /youtube route (same shape ComboBox used) */
export async function searchYouTube(
  q: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const data = await getJson<unknown>(`/youtube?q=${enc(q)}`, signal);
  return arr<SearchResult>(data).map((d) => ({ ...d, type: "youtube" }));
}

/**
 * Debounces a search and cancels the previous request whenever a new query arrives (or on cancel()).
 * Only the latest query's result or error is delivered; aborted requests are silent.
 */
export function createDebouncedSearch<T>(
  fn: (q: string, signal: AbortSignal) => Promise<T>,
  delayMs = 250,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller?.abort();
    controller = undefined;
  };
  const run = (
    q: string,
    onResult: (result: T) => void,
    onError?: (err: unknown) => void,
  ) => {
    cancel();
    timer = setTimeout(async () => {
      timer = undefined;
      const mine = new AbortController();
      controller = mine;
      try {
        const result = await fn(q, mine.signal);
        if (!mine.signal.aborted) {
          onResult(result);
        }
      } catch (e) {
        if (!mine.signal.aborted && !isAbortError(e)) {
          onError?.(e);
        }
      } finally {
        if (controller === mine) {
          controller = undefined;
        }
      }
    }, delayMs);
  };
  return { run, cancel };
}
