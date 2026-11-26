import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseContentId,
  buildVideoMeta,
  contextFromVideoMeta,
  detectLink,
  episodeCode,
  formatAirDate,
  formatSize,
  groupStreams,
  interleave,
  isFuture,
  isUrlInput,
  loadRecents,
  resolutionLabel,
  saveRecent,
  streamBadges,
  streamDisplayName,
  streamFileLabel,
} from "./pickerLogic";
import { movie, show, stream, streamList } from "./fixtures";
import { withDisplayName } from "../logic/media";

describe("detectLink", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abcdefghijk", "youtube", "YouTube video"],
    ["https://youtu.be/abcdefghijk", "youtube", "YouTube video"],
    [
      "https://www.youtube.com/playlist?list=PL123",
      "youtube",
      "YouTube playlist",
    ],
    ["https://cdn.example.com/live/index.m3u8", "hls", "HLS stream"],
    ["https://cdn.example.com/dash/manifest.mpd", "dash", "DASH stream"],
    ["https://cdn.example.com/video/clip.mp4", "direct", "Direct video · MP4"],
    [
      "https://cdn.example.com/video/clip.webm?sig=1",
      "direct",
      "Direct video · WEBM",
    ],
    ["https://cdn.example.com/video/movie.mkv", "direct", "Direct video · MKV"],
    ["https://example.com/some/article", "unknown", "Web page or unknown link"],
  ])("%s → %s", (url, kind, label) => {
    expect(detectLink(url)).toMatchObject({ kind, label });
  });

  it("warns about MKV and unknown pages", () => {
    expect(detectLink("https://cdn.example.com/a.mkv")?.warning).toMatch(/MKV/);
    expect(detectLink("https://example.com/")?.warning).toMatch(
      /doesn't look like a video/,
    );
    expect(
      detectLink("https://cdn.example.com/a.mp4")?.warning,
    ).toBeUndefined();
  });

  it("returns null for search text", () => {
    expect(detectLink("shawshank redemption")).toBeNull();
    expect(isUrlInput("http//nope")).toBe(false);
    expect(isUrlInput(" https://x.example.com/a ")).toBe(true);
  });
});

describe("streams", () => {
  it("groups by tier keeping server order", () => {
    const g = groupStreams(streamList);
    expect(g.direct.map((s) => s.filename)).toEqual(["Direct.One.mp4"]);
    expect(g.convert.map((s) => s.tier)).toEqual([
      "convert-light",
      "convert-heavy",
    ]);
    expect(g.unlikely).toHaveLength(1);
  });

  it("formats sizes and resolutions", () => {
    expect(formatSize(4.2e9)).toBe("4.2 GB");
    expect(formatSize(88e9)).toBe("88.0 GB");
    expect(formatSize(120e9)).toBe("120 GB");
    expect(formatSize(850e6)).toBe("850 MB");
    expect(formatSize(null)).toBeNull();
    expect(resolutionLabel("2160p")).toBe("4K");
    expect(resolutionLabel("1080p")).toBe("1080p");
    expect(resolutionLabel(null)).toBeNull();
  });

  it("flags problem codecs, containers and REMUX", () => {
    const badges = streamBadges(
      stream({
        videoCodec: "hevc",
        bitDepth: 10,
        audio: ["eac3", "dts-hd"],
        container: "mkv",
        hdr: ["DV"],
        remux: true,
      }),
    );
    expect(badges).toEqual([
      { label: "HEVC 10-bit", tone: "problem" },
      { label: "EAC3", tone: "neutral" },
      { label: "DTS-HD", tone: "problem" },
      { label: "MKV", tone: "neutral" },
      { label: "DV", tone: "neutral" },
      { label: "REMUX", tone: "problem" },
    ]);
    expect(
      streamBadges(
        stream({
          videoCodec: "h264",
          bitDepth: 10,
          audio: [],
          container: "other:avi",
        }),
      ),
    ).toEqual([
      { label: "H.264 10-bit", tone: "problem" },
      { label: "AVI", tone: "problem" },
    ]);
  });

  it("labels a stream by file name, never by URL", () => {
    expect(streamFileLabel(stream())).toContain("Example.Movie");
    expect(
      streamFileLabel(stream({ filename: null, title: null, name: "AIO" })),
    ).toBe("AIO");
  });
});

describe("names and metadata", () => {
  it("builds episode codes and display names", () => {
    expect(episodeCode(2, 4)).toBe("S02E04");
    expect(episodeCode(null, 5)).toBe("E05");
    expect(streamDisplayName("Show", { season: 2, episode: 4 })).toBe(
      "Show · S02E04",
    );
    expect(streamDisplayName("Movie", null)).toBe("Movie");
  });

  it("finds base ids", () => {
    expect(baseContentId("tt1:2:3")).toBe("tt1");
    expect(baseContentId("kitsu:11:5")).toBe("kitsu:11");
    expect(baseContentId("tt9")).toBe("tt9");
  });

  it("builds VideoMeta for a movie and an episode, and back", () => {
    expect(buildVideoMeta({ title: movie }, { bingeGroup: null })).toEqual({
      source: "aiostreams",
      type: "movie",
      id: "tt0000001",
      imdbId: "tt0000001",
      season: null,
      episode: null,
      title: "Example Movie",
      episodeTitle: null,
      poster: "https://images.example.com/movie.jpg",
      bingeGroup: null,
    });
    const episode = {
      id: "tt0000002:2:4",
      season: 2,
      episode: 4,
      title: "Four",
      released: null,
      thumbnail: null,
    };
    const meta = buildVideoMeta(
      { title: show, episode },
      { bingeGroup: "grp" },
    );
    expect(meta).toMatchObject({
      id: "tt0000002:2:4",
      season: 2,
      episode: 4,
      episodeTitle: "Four",
      bingeGroup: "grp",
      poster: show.poster,
    });
    const ctx = contextFromVideoMeta(meta);
    expect(ctx.title).toMatchObject({
      id: "tt0000002",
      kind: "series",
      type: "series",
      name: "Example Show",
    });
    expect(ctx.episode).toMatchObject({
      id: "tt0000002:2:4",
      season: 2,
      episode: 4,
    });
  });

  it("interleaves groups", () => {
    expect(interleave<unknown>([1, 2, 3], ["a"], [true, false])).toEqual([
      1,
      "a",
      true,
      2,
      false,
      3,
    ]);
  });
});

describe("recents", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the newest first, de-duplicated, capped at 8", () => {
    for (let i = 0; i < 10; i++) {
      saveRecent({
        kind: "url",
        url: `https://v.example.com/${i}.mp4`,
        name: `${i}`,
        at: i,
      });
    }
    saveRecent({
      kind: "url",
      url: "https://v.example.com/5.mp4",
      name: "5",
      at: 99,
    });
    const r = loadRecents();
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ name: "5", at: 99 });
    expect(r.filter((x) => x.kind === "url" && x.name === "5")).toHaveLength(1);
  });

  it("never stores AIOStreams playback URLs", () => {
    saveRecent({
      kind: "url",
      url: withDisplayName(
        "https://aio.example.com/playback/x.mkv",
        "Show · S01E01",
      ),
      name: "Show",
      at: 1,
    });
    expect(loadRecents()).toEqual([]);
    saveRecent({ kind: "title", context: { title: movie }, at: 2 });
    expect(JSON.stringify(loadRecents())).not.toContain("playback");
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem("wp-recent-sources", "{nope");
    expect(loadRecents()).toEqual([]);
  });
});

describe("detectLink edge cases", () => {
  it("rejects text that isn't a parseable URL", () => {
    expect(detectLink("hello world")).toBeNull();
    expect(detectLink("https://exa mple.com/x.mp4")).toBeNull();
  });

  it("warns about containers browsers rarely play", () => {
    expect(detectLink("https://cdn.example.com/a/old.avi")).toMatchObject({
      kind: "direct",
      label: "Direct video · AVI",
      title: "old.avi",
      warning: "AVI files usually don't play in browsers.",
    });
    expect(detectLink("https://cdn.example.com/b.M2TS")?.warning).toBe(
      "M2TS files usually don't play in browsers.",
    );
  });

  it("names a link without a file by its host, and decodes file names", () => {
    expect(detectLink("https://cdn.example.com/")?.title).toBe(
      "cdn.example.com",
    );
    expect(detectLink("https://cdn.example.com/My%20Movie.mp4")?.title).toBe(
      "My Movie.mp4",
    );
    // A dot-file isn't an extension
    expect(detectLink("https://cdn.example.com/.mp4")?.kind).toBe("unknown");
  });
});

describe("streamBadges edge cases", () => {
  it("flags 10-bit H.264, problem audio and unknown containers", () => {
    expect(
      streamBadges(
        stream({
          videoCodec: "h264",
          bitDepth: 10,
          audio: ["truehd", "atmos", "weird" as never],
          container: "other:rmvb",
          hdr: ["DV", "HDR10"],
          remux: true,
        }),
      ),
    ).toEqual([
      { label: "H.264 10-bit", tone: "problem" },
      { label: "TrueHD", tone: "problem" },
      { label: "Atmos", tone: "neutral" },
      { label: "WEIRD", tone: "neutral" },
      { label: "RMVB", tone: "problem" },
      { label: "DV", tone: "neutral" },
      { label: "HDR10", tone: "neutral" },
      { label: "REMUX", tone: "problem" },
    ]);
  });

  it("shows unknown video codecs as-is and skips missing fields", () => {
    expect(
      streamBadges(
        stream({
          videoCodec: "theora" as never,
          bitDepth: null,
          audio: [],
          container: null,
        }),
      ),
    ).toEqual([{ label: "theora", tone: "neutral" }]);
    expect(
      streamBadges(stream({ videoCodec: null, audio: [], container: "ts" })),
    ).toEqual([{ label: "TS", tone: "problem" }]);
  });
});

describe("buildVideoMeta edge cases", () => {
  it("keeps only http(s) posters, truncates long fields and has no imdb id for kitsu", () => {
    const long = "x".repeat(400);
    const meta = buildVideoMeta(
      {
        title: {
          ...show,
          id: "kitsu:11",
          kind: "anime",
          name: long,
          poster: "data:image/png;base64,AAAA",
        },
        episode: {
          id: "kitsu:11:3",
          season: 1,
          episode: 3,
          title: long,
          released: null,
          thumbnail: null,
        },
      },
      { bingeGroup: long },
    );
    expect(meta.poster).toBeNull();
    expect(meta.imdbId).toBeNull();
    expect(meta.title).toHaveLength(300);
    expect(meta.episodeTitle).toHaveLength(300);
    expect(meta.bingeGroup).toHaveLength(300);
    expect(meta.id).toBe("kitsu:11:3");
  });

  it("uses an explicit imdb id and null episode fields for movies", () => {
    const meta = buildVideoMeta(
      { title: { ...movie, poster: null }, imdbId: "tt9" },
      { bingeGroup: null },
    );
    expect(meta).toMatchObject({
      imdbId: "tt9",
      season: null,
      episode: null,
      episodeTitle: null,
      poster: null,
      bingeGroup: null,
    });
  });
});

describe("contextFromVideoMeta edge cases", () => {
  it("treats an episode without a season as season 1", () => {
    const ctx = contextFromVideoMeta({
      source: "aiostreams",
      type: "anime",
      id: "kitsu:11:4",
      imdbId: null,
      season: null,
      episode: 4,
      title: "Anime",
      episodeTitle: null,
      poster: null,
      bingeGroup: null,
    });
    expect(ctx.title).toMatchObject({ id: "kitsu:11", type: "series" });
    expect(ctx.episode).toMatchObject({ season: 1, episode: 4 });
  });
});

describe("air dates", () => {
  it("formats valid dates and ignores missing or broken ones", () => {
    expect(formatAirDate(null)).toBeNull();
    expect(formatAirDate("not a date")).toBeNull();
    expect(formatAirDate("2024-03-05T00:00:00Z")).toMatch(/2024/);
  });

  it("knows which episodes haven't aired yet", () => {
    const now = Date.parse("2024-06-01T00:00:00Z");
    expect(isFuture(null, now)).toBe(false);
    expect(isFuture("garbage", now)).toBe(false);
    expect(isFuture("2024-07-01T00:00:00Z", now)).toBe(true);
    expect(isFuture("2024-05-01T00:00:00Z", now)).toBe(false);
  });
});

describe("recent sources storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("ignores non-array data and unknown entries", () => {
    window.localStorage.setItem("wp-recent-sources", JSON.stringify({ a: 1 }));
    expect(loadRecents()).toEqual([]);
    window.localStorage.setItem(
      "wp-recent-sources",
      JSON.stringify([
        null,
        { kind: "other" },
        { kind: "url", url: "u", name: "n", at: 1 },
      ]),
    );
    expect(loadRecents()).toEqual([
      { kind: "url", url: "u", name: "n", at: 1 },
    ]);
  });

  it("de-duplicates titles by episode and survives a full storage", () => {
    const ep = {
      id: "tt0000002:1:2",
      season: 1,
      episode: 2,
      title: null,
      released: null,
      thumbnail: null,
    };
    saveRecent({ kind: "title", context: { title: show, episode: ep }, at: 1 });
    saveRecent({ kind: "title", context: { title: show, episode: ep }, at: 2 });
    saveRecent({ kind: "title", context: { title: show }, at: 3 });
    expect(loadRecents().map((r) => r.at)).toEqual([3, 2]);

    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    expect(() =>
      saveRecent({
        kind: "url",
        url: "https://v.example.com/a.mp4",
        name: "a",
        at: 4,
      }),
    ).not.toThrow();
    setItem.mockRestore();
  });
});
