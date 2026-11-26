import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS } from "../roomState";
import {
  countdownSeconds,
  describeNext,
  episodeLabel,
  nextEpisodeNotice,
  nextEpisodeOffset,
  shouldOfferNextEpisode,
} from "./logic";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:3",
  imdbId: "tt0000001",
  season: 1,
  episode: 3,
  title: "Example Show",
  episodeTitle: "Third",
  poster: "https://images.example/p.jpg",
  bingeGroup: null,
};

const base = {
  videoMeta: meta,
  playlistLength: 0,
  loop: false,
  nextState: "none" as const,
  currentTime: 1180,
  duration: 1200,
  offset: 25,
};

describe("shouldOfferNextEpisode", () => {
  it("offers inside the window", () => {
    expect(shouldOfferNextEpisode(base)).toBe(true);
    expect(shouldOfferNextEpisode({ ...base, currentTime: 1175 })).toBe(true);
    expect(shouldOfferNextEpisode({ ...base, currentTime: 1200 })).toBe(true);
  });

  it.each([
    ["before the window", { currentTime: 1100 }],
    ["a movie", { videoMeta: { ...meta, type: "movie", episode: null } }],
    ["no metadata", { videoMeta: null }],
    ["a queue", { playlistLength: 1 }],
    ["looping", { loop: true }],
    ["a card already", { nextState: "offered" }],
    ["cancelled", { nextState: "cancelled" }],
    ["unknown duration", { duration: Number.NaN }],
    ["live/infinite", { duration: Infinity }],
    ["not started", { currentTime: 0, duration: 10 }],
  ])("doesn't offer with %s", (_n, o) => {
    expect(
      shouldOfferNextEpisode({ ...base, ...(o as Partial<typeof base>) }),
    ).toBe(false);
  });
});

describe("countdown and labels", () => {
  it("counts down whole seconds to startAt", () => {
    expect(countdownSeconds(1200, 1180)).toBe(20);
    expect(countdownSeconds(1200, 1180.2)).toBe(20);
    expect(countdownSeconds(1200, 1199.9)).toBe(1);
    expect(countdownSeconds(1200, 1300)).toBe(0);
    expect(countdownSeconds(1200, Number.NaN)).toBe(0);
  });

  it("labels episodes", () => {
    expect(episodeLabel(meta)).toBe("S01E03");
    expect(episodeLabel({ season: null, episode: 7 })).toBe("E07");
  });

  it("describes the next episode", () => {
    expect(describeNext({ meta, thumbnail: null })).toEqual({
      heading: "Up next · S01E03 · Third",
      show: "Example Show",
      short: "Example Show · S01E03",
      image: "https://images.example/p.jpg",
    });
    expect(
      describeNext({
        meta: { ...meta, episodeTitle: null },
        thumbnail: "https://images.example/t.jpg",
      }),
    ).toMatchObject({
      heading: "Up next · S01E03",
      image: "https://images.example/t.jpg",
    });
  });

  it("reads the offset from the room settings", () => {
    expect(
      nextEpisodeOffset({ roomSettings: { ...DEFAULT_ROOM_SETTINGS } }),
    ).toBe(25);
    expect(
      nextEpisodeOffset({
        roomSettings: { ...DEFAULT_ROOM_SETTINGS, nextEpisodeOffset: 60 },
      }),
    ).toBe(60);
  });
});

describe("nextEpisodeNotice", () => {
  const ctx = { clientId: "me", nameMap: { b: "Sam" } };
  const next = { meta, thumbnail: null };
  it("says who cancelled", () => {
    expect(
      nextEpisodeNotice(
        { state: "cancelled", by: { id: "a", name: "Alex" } },
        ctx,
      ),
    ).toBe("Alex cancelled the next episode");
    expect(
      nextEpisodeNotice({ state: "cancelled", by: { id: "b" } }, ctx),
    ).toBe("Sam cancelled the next episode");
    expect(
      nextEpisodeNotice({ state: "cancelled", by: { id: "me" } }, ctx),
    ).toBe("Next episode cancelled");
  });

  it("announces the start and failures", () => {
    expect(nextEpisodeNotice({ state: "starting", next, by: null }, ctx)).toBe(
      "Up next: Example Show · S01E03",
    );
    expect(
      nextEpisodeNotice(
        { state: "starting", next, by: { id: "a", name: "Alex" } },
        ctx,
      ),
    ).toBe("Alex started Example Show · S01E03");
    expect(nextEpisodeNotice({ state: "failed", next: null }, ctx)).toBe(
      "Couldn't find the next episode",
    );
    expect(nextEpisodeNotice({ state: "none" }, ctx)).toBeNull();
    expect(
      nextEpisodeNotice({ state: "offered", next, startAt: 1 }, ctx),
    ).toBeNull();
  });
});
