/**
 * Next episode: finds the episode after the room's current one and picks a stream for it, so the room
 * can play it without anyone opening the picker. Used by the room (server/nextEpisode.ts), not by an HTTP route.
 *
 * The stream URL that comes back is an AIOStreams playback URL. It goes straight into the room's media (with a
 * readable name in the fragment, like the picker does) and is never logged.
 */
import { NotFoundError, type Catalog, type Episode } from "./catalog.ts";
import type { ContentType } from "./ids.ts";
import { rankStreams, type StreamDTO, type Tier } from "./streamParser.ts";

export type NextEpisodeResult =
  /** No next episode (finale, not aired yet, unknown id) */
  | { kind: "none" }
  /** There is (or may be) a next episode, but no playable stream for it, or a lookup failed */
  | { kind: "failed"; meta: VideoMeta | null; thumbnail: string | null }
  | { kind: "found"; meta: VideoMeta; thumbnail: string | null; url: string };

export type NextEpisodeResolver = (
  current: VideoMeta,
) => Promise<NextEpisodeResult>;

/** Tiers we'll pick automatically, best first ("unlikely" streams are only played when someone picks them) */
const AUTO_TIERS: readonly Tier[] = [
  "direct",
  "convert-light",
  "convert-heavy",
];

/**
 * The stream to play for the next episode: the same `bingeGroup` (release/quality) as the current one first, then
 * the best tier (direct > convert-light > convert-heavy, never "unlikely"), then the highest score.
 */
export function chooseNextStream(
  streams: StreamDTO[],
  bingeGroup: string | null,
): StreamDTO | null {
  const candidates = streams.filter((s) => AUTO_TIERS.includes(s.tier));
  const best = (list: StreamDTO[]) =>
    list.reduce<StreamDTO | null>((acc, s) => {
      if (!acc) {
        return s;
      }
      const byTier = AUTO_TIERS.indexOf(s.tier) - AUTO_TIERS.indexOf(acc.tier);
      // Ties keep the earlier one (AIOStreams' own order)
      return byTier < 0 || (byTier === 0 && s.score > acc.score) ? s : acc;
    }, null);
  if (bingeGroup) {
    const same = best(candidates.filter((s) => s.bingeGroup === bingeGroup));
    if (same) {
      return same;
    }
  }
  return best(candidates);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "S01E03", or "E05" without a season (same as the client's episodeCode) */
export function episodeCode(season: number | null, episode: number | null) {
  if (episode === null) {
    return "";
  }
  return season === null
    ? `E${pad2(episode)}`
    : `S${pad2(season)}E${pad2(episode)}`;
}

/**
 * Same format as the client's `withDisplayName` (src/components/App/logic/media.ts): the readable name rides in the
 * URL fragment so the top bar, chat and queue show it instead of the credential-bearing playback URL.
 */
export function withDisplayName(url: string, name: string): string {
  const encoded = "wp-name=" + encodeURIComponent(name);
  return url.includes("#") ? `${url}&${encoded}` : `${url}#${encoded}`;
}

/** The VideoMeta of `episode`, carrying over the show's fields from the current one */
export function nextVideoMeta(
  current: VideoMeta,
  episode: Episode,
  bingeGroup: string | null,
): VideoMeta {
  return {
    source: "aiostreams",
    type: current.type,
    id: episode.id,
    imdbId: current.imdbId,
    season: episode.season,
    episode: episode.episode,
    title: current.title,
    episodeTitle: episode.title ? episode.title.slice(0, 300) : null,
    poster: current.poster,
    bingeGroup: bingeGroup ? bingeGroup.slice(0, 300) : null,
  };
}

/** Whether the room's video is an episode we can look past */
export function isEpisodeMeta(meta: VideoMeta | null): meta is VideoMeta {
  return Boolean(
    meta &&
    (meta.type === "series" || meta.type === "anime") &&
    meta.episode !== null,
  );
}

export function createNextEpisodeResolver(opts: {
  catalog: Pick<Catalog, "nextEpisode">;
  aio: { rawStreams: (type: ContentType, id: string) => Promise<unknown[]> };
  /** Gets fixed-string messages only (AddonError), already redacted by the caller */
  log?: (msg: string) => void;
}): NextEpisodeResolver {
  const log = opts.log ?? console.warn;
  return async (current) => {
    if (!isEpisodeMeta(current)) {
      return { kind: "none" };
    }
    let episode: Episode | null;
    try {
      episode = await opts.catalog.nextEpisode(current.type, current.id);
    } catch (e) {
      if (e instanceof NotFoundError) {
        return { kind: "none" };
      }
      log(`[next-episode] lookup failed: ${errorText(e)}`);
      return { kind: "failed", meta: null, thumbnail: null };
    }
    if (!episode) {
      return { kind: "none" };
    }
    const thumbnail = episode.thumbnail;
    let stream: StreamDTO | null;
    try {
      const raw = await opts.aio.rawStreams(current.type, episode.id);
      // No limit: the right bingeGroup may rank below the first 60
      const { streams } = rankStreams(raw, {
        bingeGroup: current.bingeGroup ?? undefined,
        limit: Infinity,
      });
      stream = chooseNextStream(streams, current.bingeGroup);
    } catch (e) {
      log(`[next-episode] streams failed: ${errorText(e)}`);
      stream = null;
    }
    if (!stream) {
      return {
        kind: "failed",
        meta: nextVideoMeta(current, episode, null),
        thumbnail,
      };
    }
    const meta = nextVideoMeta(current, episode, stream.bingeGroup);
    const name = `${current.title} · ${episodeCode(meta.season, meta.episode)}`;
    return {
      kind: "found",
      meta,
      thumbnail,
      url: withDisplayName(stream.url, name),
    };
  };
}

// AddonError messages are fixed strings; anything else only logs its name so nothing upstream-supplied leaks
const errorText = (e: unknown) =>
  (e as Error)?.name === "AddonError" || (e as Error)?.name === "NotFoundError"
    ? (e as Error).message
    : ((e as Error)?.name ?? "error");
