import { describe, expect, it } from "vitest";
import { nowPlayingChatLine, nowPlayingTitle } from "./nowPlaying.ts";

const meta: VideoMeta = {
  source: "aiostreams",
  type: "series",
  id: "tt0000001:1:3",
  imdbId: "tt0000001",
  season: 1,
  episode: 3,
  title: "Example Show",
  episodeTitle: "Third",
  poster: null,
  bingeGroup: null,
};
const STREAM = "https://aio.example.com/api/v1/debrid/playback/secret.mkv";

describe("nowPlayingTitle", () => {
  it("prefers the AIOStreams title and episode code", () => {
    expect(nowPlayingTitle(STREAM, meta)).toBe("Example Show · S01E03");
    expect(
      nowPlayingTitle(STREAM, {
        ...meta,
        type: "movie",
        season: null,
        episode: null,
        title: "Spring",
      }),
    ).toBe("Spring");
  });

  it("falls back to the display name, then the queue item's name", () => {
    expect(nowPlayingTitle(STREAM + "#wp-name=Spring%20(2014)", null)).toBe(
      "Spring (2014)",
    );
    expect(
      nowPlayingTitle(
        "https://youtube.com/watch?v=abc",
        null,
        "A YouTube title",
      ),
    ).toBe("A YouTube title");
  });

  it("gives nothing when the only name is the URL", () => {
    const url = "https://example.com/a.mp4";
    expect(nowPlayingTitle(url, null, url)).toBeUndefined();
    expect(nowPlayingTitle(url, null)).toBeUndefined();
  });
});

describe("nowPlayingChatLine", () => {
  it("has no person and never carries an AIOStreams URL", () => {
    const line = nowPlayingChatLine("nextEpisode", STREAM, meta);
    expect(line.id).toBe("");
    expect(line.cmd).toBe("nowPlaying");
    expect(JSON.parse(line.msg!)).toEqual({
      via: "nextEpisode",
      title: "Example Show · S01E03",
    });
    expect(line.msg).not.toContain("aio.example.com");
  });

  it("sends the URL only when there's no readable title", () => {
    const line = nowPlayingChatLine("queue", "https://example.com/a.mp4", null);
    expect(JSON.parse(line.msg!)).toEqual({
      via: "queue",
      url: "https://example.com/a.mp4",
    });
  });
});
