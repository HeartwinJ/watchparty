import { describe, expect, it } from "vitest";
import {
  classifyMedia,
  findSharer,
  getAttachedDisplayName,
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

  it("takes the sharer from the URL when the roster hasn't caught up", () => {
    const lagging = { ...ctx, participants: [], nameMap: { u2: "Sam" } };
    expect(getMediaDisplayName("screenshare://u2", lagging)).toBe(
      "Sam's screen",
    );
    expect(getMediaDisplayName("fileshare://u2@x", lagging)).toBe("Sam's file");
  });

  it("never shows undefined for an unknown sharer", () => {
    const empty = { ...ctx, participants: [], nameMap: {} };
    expect(getMediaDisplayName("screenshare://gone", empty)).toBe(
      "a shared screen",
    );
    expect(getMediaDisplayName("fileshare://gone", empty)).toBe(
      "a shared file",
    );
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

describe("getAttachedDisplayName edge cases", () => {
  it("ignores fragments without a name, empty names and broken encoding", () => {
    expect(
      getAttachedDisplayName("https://v.example.com/a.mp4"),
    ).toBeUndefined();
    expect(
      getAttachedDisplayName("https://v.example.com/a.mp4#t=10"),
    ).toBeUndefined();
    expect(
      getAttachedDisplayName("https://v.example.com/a.mp4#wp-name="),
    ).toBeUndefined();
    expect(
      getAttachedDisplayName("https://v.example.com/a.mp4#wp-name=%E0%A4%A"),
    ).toBeUndefined();
    expect(
      getAttachedDisplayName(
        "https://v.example.com/a.mp4#t=1&wp-name=Show%20%C2%B7%20S01E02",
      ),
    ).toBe("Show · S01E02");
  });

  it("names a file share after the roster's sharer when the URL's id is unknown", () => {
    expect(
      getMediaDisplayName("fileshare://", {
        roomMedia: "",
        participants: [{ id: "u9", isScreenShare: true } as User],
        nameMap: { u9: "Kim" },
      }),
    ).toBe("Kim's file");
  });
});
