/**
 * Stream lookups against the owner's AIOStreams instance.
 *
 * The manifest URL embeds the owner's AIOStreams config and debrid
 * credentials. It must stay server-side: never return it, log it, or put it in
 * an error message. AddonError messages are built from fixed strings only.
 */
import type { TtlCache } from "./cache.ts";
import { AddonError, fetchJson, type FetchFn } from "./http.ts";
import type { ContentType } from "./ids.ts";

export const STREAMS_TTL_MS = 10 * 60 * 1000;

/** "https://host/stremio/<uuid>/<config>/manifest.json" → "https://host/stremio/<uuid>/<config>" */
export function manifestBase(manifestUrl: string): string {
  return manifestUrl
    .trim()
    .replace(/\/manifest\.json$/, "")
    .replace(/\/+$/, "");
}

export function createAioStreams(opts: {
  manifestUrl: string;
  fetchFn: FetchFn;
  cache: TtlCache<unknown>;
  timeoutMs?: number;
}) {
  const base = manifestBase(opts.manifestUrl);
  const timeoutMs = opts.timeoutMs ?? 30000;

  /** The raw `streams` array for a movie or episode id (cached ~10 min). */
  async function rawStreams(type: ContentType, id: string): Promise<unknown[]> {
    // Kitsu ids are looked up as "anime": as "series", AIOStreams' scrapers
    // return lots of unrelated results (spin-offs, movies, other shows).
    const streamType = id.startsWith("kitsu:") ? "anime" : type;
    return opts.cache.wrap(
      `streams:${streamType}:${id}`,
      STREAMS_TTL_MS,
      async () => {
        const body = await fetchJson(
          opts.fetchFn,
          `${base}/stream/${streamType}/${id}.json`,
          { label: "aiostreams", timeoutMs, maxBytes: 20 * 1024 * 1024 },
        );
        const streams = (body as { streams?: unknown } | null)?.streams;
        if (!Array.isArray(streams)) {
          throw new AddonError("aiostreams", "invalid_response");
        }
        return streams;
      },
    ) as Promise<unknown[]>;
  }

  return { rawStreams };
}
