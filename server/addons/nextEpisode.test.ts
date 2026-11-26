import { describe, expect, it, vi } from "vitest";
import { AddonError } from "./http.ts";
import { NotFoundError, type Episode } from "./catalog.ts";
import {
  chooseNextStream,
  createNextEpisodeResolver,
  episodeCode,
  isEpisodeMeta,
  withDisplayName,
} from "./nextEpisode.ts";
import { createAddonServices } from "./routes.ts";
import type { StreamDTO, Tier } from "./streamParser.ts";

const dto = (
  tier: Tier,
  score: number,
  bingeGroup: string | null,
  n = score,
): StreamDTO =>
  ({
    url: `https://aio.example.com/api/v1/debrid/playback/${n}/file.mp4`,
    tier,
    score,
    bingeGroup,
  }) as StreamDTO;

describe("chooseNextStream", () => {
  it("prefers the same bingeGroup even in a worse tier", () => {
    const pick = chooseNextStream(
      [
        dto("direct", 100, "other"),
        dto("convert-heavy", 50, "same"),
        dto("convert-light", 60, "same"),
      ],
      "same",
    );
    expect(pick).toMatchObject({ tier: "convert-light", bingeGroup: "same" });
  });

  it("falls back to the best tier, then score", () => {
    const pick = chooseNextStream(
      [
        dto("convert-light", 500, "a"),
        dto("direct", 10, "b"),
        dto("direct", 30, "c"),
      ],
      "missing",
    );
    expect(pick).toMatchObject({ tier: "direct", score: 30 });
  });

  it("keeps AIOStreams order on ties", () => {
    const pick = chooseNextStream(
      [dto("direct", 10, "a", 1), dto("direct", 10, "b", 2)],
      null,
    );
    expect(pick?.bingeGroup).toBe("a");
  });

  it("never picks an unlikely stream, even in the same bingeGroup", () => {
    expect(chooseNextStream([dto("unlikely", 999, "same")], "same")).toBeNull();
    expect(
      chooseNextStream(
        [dto("unlikely", 999, "same"), dto("convert-heavy", 1, "x")],
        "same",
      ),
    ).toMatchObject({ tier: "convert-heavy" });
  });

  it("returns null for no streams", () => {
    expect(chooseNextStream([], "x")).toBeNull();
  });
});

describe("helpers", () => {
  it("episodeCode", () => {
    expect(episodeCode(1, 3)).toBe("S01E03");
    expect(episodeCode(null, 5)).toBe("E05");
    expect(episodeCode(2, null)).toBe("");
  });

  it("withDisplayName matches the client's fragment format", () => {
    expect(withDisplayName("https://x.example/a.mkv", "Show · S01E02")).toBe(
      "https://x.example/a.mkv#wp-name=Show%20%C2%B7%20S01E02",
    );
    expect(withDisplayName("https://x.example/a.mkv#t=1", "A")).toBe(
      "https://x.example/a.mkv#t=1&wp-name=A",
    );
  });

  it("isEpisodeMeta", () => {
    expect(isEpisodeMeta(current)).toBe(true);
    expect(isEpisodeMeta({ ...current, episode: null })).toBe(false);
    expect(isEpisodeMeta({ ...current, type: "movie" })).toBe(false);
    expect(isEpisodeMeta(null)).toBe(false);
  });
});

const current: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:2",
  imdbId: "tt0000001",
  season: 1,
  episode: 2,
  title: "Example Show",
  episodeTitle: "Second",
  poster: "https://images.example/p.jpg",
  bingeGroup: "aio|1080p|grp",
};

const EP3: Episode = {
  id: "tt0000001:1:3",
  season: 1,
  episode: 3,
  title: "Third",
  released: "2008-01-01T00:00:00.000Z",
  thumbnail: "https://images.example/e3.jpg",
};

const rawStream = (n: number, bingeGroup: string, desc = "🎞️ AVC\n🎧 AAC") => ({
  name: "FHD",
  description: desc,
  url: `https://aio.example.com/api/v1/debrid/playback/opaque${n}/file${n}.mp4`,
  behaviorHints: {
    filename: `Show.S01E03.1080p.WEB-DL.x264-G${n}.mp4`,
    bingeGroup,
  },
});

function resolverWith(opts: {
  next?: Episode | null | Error;
  streams?: unknown[] | Error;
}) {
  const logs: string[] = [];
  const nextEpisode = vi.fn(async () => {
    if (opts.next instanceof Error) {
      throw opts.next;
    }
    return opts.next === undefined ? EP3 : opts.next;
  });
  const rawStreams = vi.fn(async () => {
    if (opts.streams instanceof Error) {
      throw opts.streams;
    }
    return opts.streams ?? [];
  });
  const resolve = createNextEpisodeResolver({
    catalog: { nextEpisode },
    aio: { rawStreams },
    log: (m) => logs.push(m),
  });
  return { resolve, logs, nextEpisode, rawStreams };
}

describe("createNextEpisodeResolver", () => {
  it("finds the next episode and keeps the bingeGroup", async () => {
    const { resolve, rawStreams, nextEpisode } = resolverWith({
      streams: [rawStream(1, "other"), rawStream(2, "aio|1080p|grp")],
    });
    const r = await resolve(current);
    expect(nextEpisode).toHaveBeenCalledWith("series", "tt0000001:1:2");
    expect(rawStreams).toHaveBeenCalledWith("series", "tt0000001:1:3");
    expect(r).toEqual({
      kind: "found",
      thumbnail: "https://images.example/e3.jpg",
      url: "https://aio.example.com/api/v1/debrid/playback/opaque2/file2.mp4#wp-name=Example%20Show%20%C2%B7%20S01E03",
      meta: {
        ...current,
        id: "tt0000001:1:3",
        season: 1,
        episode: 3,
        episodeTitle: "Third",
        bingeGroup: "aio|1080p|grp",
      },
    });
  });

  it("is none for the finale / unknown ids, without a stream lookup", async () => {
    for (const next of [null, new NotFoundError()]) {
      const { resolve, rawStreams } = resolverWith({ next });
      expect(await resolve(current)).toEqual({ kind: "none" });
      expect(rawStreams).not.toHaveBeenCalled();
    }
  });

  it("is none for movies", async () => {
    const { resolve, nextEpisode } = resolverWith({});
    expect(await resolve({ ...current, type: "movie", episode: null })).toEqual(
      { kind: "none" },
    );
    expect(nextEpisode).not.toHaveBeenCalled();
  });

  it("fails without meta when the catalog lookup fails", async () => {
    const { resolve, logs } = resolverWith({
      next: new AddonError("cinemeta meta", "timeout"),
    });
    expect(await resolve(current)).toEqual({
      kind: "failed",
      meta: null,
      thumbnail: null,
    });
    expect(logs).toEqual([
      "[next-episode] lookup failed: cinemeta meta: timeout",
    ]);
  });

  it("fails with the episode's meta when no stream is playable", async () => {
    const { resolve } = resolverWith({
      streams: [rawStream(1, "x", "🎞️ VC-1\n🎧 TrueHD")],
    });
    const r = await resolve(current);
    expect(r).toMatchObject({
      kind: "failed",
      meta: { id: "tt0000001:1:3", bingeGroup: null },
    });
  });

  it("fails (and logs no URL) when AIOStreams errors", async () => {
    const { resolve, logs } = resolverWith({
      streams: new Error("https://aio.example.com/secret/manifest.json"),
    });
    const r = await resolve(current);
    expect(r.kind).toBe("failed");
    expect(logs.join("\n")).not.toContain("aio.example.com");
  });
});

describe("createAddonServices", () => {
  it("has no next-episode resolver without AIOStreams", () => {
    const s = createAddonServices({
      manifestUrl: "",
      subtitleLangs: "en",
      fetchFn: vi.fn(),
    });
    expect(s.nextEpisode).toBeNull();
    const t = createAddonServices({
      manifestUrl: "https://aio.example.com/stremio/u/c/manifest.json",
      subtitleLangs: "en",
      fetchFn: vi.fn(),
    });
    expect(typeof t.nextEpisode).toBe("function");
  });
});
