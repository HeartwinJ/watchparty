import { describe, expect, it } from "vitest";
import {
  classifyMedia,
  findSharer,
  getMediaDisplayName,
  hasDuration,
  isWebRTCShare,
  usesYouTube,
} from "./media";

describe("classifyMedia", () => {
  it.each([
    [undefined, "none"],
    ["", "none"],
    ["https://www.youtube.com/watch?v=abc", "youtube"],
    ["https://youtu.be/abc", "youtube"],
    ["screenshare://someone", "screenshare"],
    ["fileshare://someone", "fileshare"],
    ["https://example.com/live/manifest.mpd", "dash"],
    ["https://example.com/stream.m3u8", "hls"],
    ["https://example.com/movie.mp4", "direct"],
    ["https://example.com/movie.mkv?token=1", "direct"],
    ["https://example.com/x.mpegts", "other"],
    ["https://www.reddit.com/r/videos/comments/1", "other"],
    ["magnet:?xt=urn:btih:abc", "other"],
  ] as const)("classifies %s as %s", (url, kind) => {
    expect(classifyMedia(url)).toBe(kind);
  });
});

describe("predicates", () => {
  it("usesYouTube / hasDuration / isWebRTCShare", () => {
    expect(usesYouTube("https://youtu.be/x")).toBe(true);
    expect(usesYouTube("https://example.com/a.mp4")).toBe(false);
    expect(hasDuration("https://example.com/a.mp4")).toBe(true);
    expect(hasDuration("screenshare://a")).toBe(false);
    expect(isWebRTCShare("screenshare://a")).toBe(true);
    expect(isWebRTCShare("fileshare://a")).toBe(true);
    expect(isWebRTCShare("https://example.com/a.mp4")).toBe(false);
  });

  it("findSharer returns the participant sharing", () => {
    expect(findSharer([{ id: "a" }, { id: "b", isScreenShare: true }])).toEqual(
      {
        id: "b",
        isScreenShare: true,
      },
    );
    expect(findSharer([{ id: "a" }])).toBeUndefined();
  });
});

describe("getMediaDisplayName", () => {
  const ctx = {
    roomMedia: "https://example.com/a.mp4",
    participants: [{ id: "u1", isScreenShare: true }],
    nameMap: { u1: "Alex" },
  };

  it("returns empty for no input", () => {
    expect(getMediaDisplayName(undefined, ctx)).toBe("");
    expect(getMediaDisplayName("", ctx)).toBe("");
  });

  it("names screen and file shares after the sharer", () => {
    expect(getMediaDisplayName("screenshare://u1", ctx)).toBe("Alex's screen");
    expect(getMediaDisplayName("fileshare://u1", ctx)).toBe("Alex's file");
  });

  it("uses the displayName of proxied URLs", () => {
    expect(
      getMediaDisplayName(
        "https://host/proxy?url=x&displayName=My%20Movie",
        ctx,
      ),
    ).toBe("My Movie");
    expect(getMediaDisplayName("https://host/proxy?url=x", ctx)).toBe(
      "https://host/proxy?url=x",
    );
  });

  it("shows the whole URL while YouTube is playing", () => {
    expect(
      getMediaDisplayName("screenshare://u1", {
        ...ctx,
        roomMedia: "https://youtu.be/x",
      }),
    ).toBe("screenshare://u1");
  });

  it("returns other URLs unchanged", () => {
    expect(getMediaDisplayName("https://example.com/a.mp4", ctx)).toBe(
      "https://example.com/a.mp4",
    );
  });
});
