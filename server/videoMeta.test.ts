import { describe, expect, it } from "vitest";
import {
  createIssueLimiter,
  parsePlaybackIssue,
  parsePlaylistAdd,
  parseVideoMeta,
  parseVideoMetaCommand,
} from "./videoMeta.ts";

const valid = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:2:4",
  imdbId: "tt0000001",
  season: 2,
  episode: 4,
  title: "Example Show",
  episodeTitle: "Some Episode",
  poster: "https://images.example.com/poster.jpg",
  bingeGroup: "example|1080p|WEB-DL",
};

describe("parseVideoMeta", () => {
  it("accepts a valid payload and drops unknown fields", () => {
    const meta = parseVideoMeta({ ...valid, extra: "nope", url: "x" });
    expect(meta).toEqual(valid);
  });

  it("normalizes missing optional fields to null", () => {
    expect(
      parseVideoMeta({
        source: "aiostreams",
        type: "movie",
        id: "tt0000002",
        title: " A Movie ",
      }),
    ).toEqual({
      source: "aiostreams",
      type: "movie",
      id: "tt0000002",
      imdbId: null,
      season: null,
      episode: null,
      title: "A Movie",
      episodeTitle: null,
      poster: null,
      bingeGroup: null,
    });
  });

  it.each([
    ["non-object", "hello"],
    ["array", [valid]],
    ["wrong source", { ...valid, source: "other" }],
    ["bad type", { ...valid, type: "music" }],
    ["bad id", { ...valid, id: "../etc/passwd" }],
    ["bad imdb id", { ...valid, imdbId: "nm123" }],
    ["negative season", { ...valid, season: -1 }],
    ["fractional episode", { ...valid, episode: 1.5 }],
    ["string season", { ...valid, season: "2" }],
    ["empty title", { ...valid, title: "  " }],
    ["long title", { ...valid, title: "x".repeat(301) }],
    ["javascript poster", { ...valid, poster: "javascript:alert(1)" }],
    ["data poster", { ...valid, poster: "data:image/png;base64,AAAA" }],
    ["long binge group", { ...valid, bingeGroup: "x".repeat(301) }],
  ])("rejects %s", (_label, raw) => {
    expect(parseVideoMeta(raw)).toBeNull();
  });

  it("accepts every field at its own limit", () => {
    expect(
      parseVideoMeta({
        ...valid,
        title: "t".repeat(300),
        episodeTitle: "e".repeat(300),
        poster: "https://x.example.com/" + "p".repeat(970),
        bingeGroup: "b".repeat(300),
      }),
    ).not.toBeNull();
  });
});

describe("parseVideoMetaCommand", () => {
  it("requires a url", () => {
    expect(parseVideoMetaCommand({ meta: valid })).toBeNull();
    expect(parseVideoMetaCommand({ url: "", meta: valid })).toBeNull();
  });
  it("accepts null meta to clear", () => {
    expect(parseVideoMetaCommand({ url: "https://a", meta: null })).toEqual({
      url: "https://a",
      meta: null,
    });
  });
  it("rejects invalid meta", () => {
    expect(
      parseVideoMetaCommand({ url: "https://a", meta: { title: "x" } }),
    ).toBeNull();
  });
});

describe("parsePlaybackIssue", () => {
  it("trims, strips control characters and caps the length", () => {
    expect(parsePlaybackIssue({ reason: "  HEVC\nnot supported " })).toBe(
      "HEVC not supported",
    );
    expect(parsePlaybackIssue({ reason: "x".repeat(500) })).toHaveLength(200);
  });
  it.each([null, "reason", {}, { reason: 5 }, { reason: "   " }])(
    "rejects %j",
    (raw) => {
      expect(parsePlaybackIssue(raw)).toBeNull();
    },
  );
});

describe("createIssueLimiter", () => {
  it("allows one report per user per window", () => {
    const limiter = createIssueLimiter({ perUserMs: 1000 });
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 500)).toBe(false);
    expect(limiter.allow("b", 500)).toBe(true);
    expect(limiter.allow("a", 1000)).toBe(true);
  });
  it("caps reports for the whole room", () => {
    const limiter = createIssueLimiter({
      perUserMs: 0,
      roomMax: 2,
      roomWindowMs: 1000,
    });
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 1)).toBe(true);
    expect(limiter.allow("c", 2)).toBe(false);
    expect(limiter.allow("c", 1001)).toBe(true);
  });
});

describe("parsePlaylistAdd", () => {
  it("accepts a legacy string", () => {
    expect(parsePlaylistAdd("https://v.example.com/a.mp4")).toEqual({
      url: "https://v.example.com/a.mp4",
      name: null,
      img: null,
      meta: null,
    });
  });
  it("accepts an item with meta", () => {
    expect(
      parsePlaylistAdd({
        url: "https://v.example.com/a.mkv",
        name: "Example Show · S02E04",
        img: "https://images.example.com/p.jpg",
        meta: valid,
      }),
    ).toMatchObject({ name: "Example Show · S02E04", meta: valid });
  });
  it("rejects bad items", () => {
    expect(parsePlaylistAdd("")).toBeNull();
    expect(parsePlaylistAdd({ url: 5 })).toBeNull();
    expect(
      parsePlaylistAdd({ url: "https://a", img: "javascript:x" }),
    ).toBeNull();
    expect(parsePlaylistAdd({ url: "https://a", meta: { x: 1 } })).toBeNull();
  });
});
