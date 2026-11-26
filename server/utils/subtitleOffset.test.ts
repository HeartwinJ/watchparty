import { describe, expect, it } from "vitest";
import {
  normalizeSubtitleOffset,
  normalizeSubtitleScale,
  parseSubtitleTiming,
  subtitleTimingChatMsg,
  subtitleOffsetKey,
} from "./subtitleOffset.ts";

describe("normalizeSubtitleOffset", () => {
  it("accepts finite numbers, rounded to 0.05", () => {
    expect(normalizeSubtitleOffset(0.3)).toBe(0.3);
    expect(normalizeSubtitleOffset(0.1 + 0.2)).toBe(0.3);
    expect(normalizeSubtitleOffset(1.234)).toBe(1.25);
    expect(normalizeSubtitleOffset(-0.26)).toBe(-0.25);
    expect(normalizeSubtitleOffset(-0.01)).toBe(0);
    expect(Object.is(normalizeSubtitleOffset(-0.01), -0)).toBe(false);
  });

  it("allows large offsets, with only a ±24 h sanity bound", () => {
    expect(normalizeSubtitleOffset(31)).toBe(31);
    expect(normalizeSubtitleOffset(-754.3)).toBe(-754.3);
    expect(normalizeSubtitleOffset(-1e9)).toBe(-86400);
  });

  it("rejects anything that isn't a finite number", () => {
    for (const bad of [
      NaN,
      Infinity,
      -Infinity,
      "0.3",
      null,
      undefined,
      {},
      [1],
      true,
    ]) {
      expect(normalizeSubtitleOffset(bad)).toBeUndefined();
    }
  });
});

describe("subtitleOffsetKey", () => {
  it("hashes the video URL", () => {
    const key = subtitleOffsetKey("https://example.com/a.mp4");
    expect(key).toMatch(/^url:[0-9a-f]{64}$/);
    expect(subtitleOffsetKey("https://example.com/a.mp4")).toBe(key);
    expect(subtitleOffsetKey("https://example.com/b.mp4")).not.toBe(key);
  });

  it("ignores the #fragment (display name) when hashing", () => {
    expect(subtitleOffsetKey("https://example.com/a.mp4#wp-name=Movie")).toBe(
      subtitleOffsetKey("https://example.com/a.mp4"),
    );
  });

  it("keys AIOStreams picks by title/episode id, not the URL", () => {
    const meta = { id: "tt0903747:2:4" };
    expect(subtitleOffsetKey("https://aio.example.com/x/1.mkv", meta)).toBe(
      "meta:tt0903747:2:4",
    );
    expect(subtitleOffsetKey("https://aio.example.com/y/2.mkv", meta)).toBe(
      "meta:tt0903747:2:4",
    );
    expect(subtitleOffsetKey("https://example.com/a.mp4", { id: "" })).toMatch(
      /^url:/,
    );
  });

  it("has no key for nothing playing or shares", () => {
    expect(subtitleOffsetKey("")).toBeUndefined();
    expect(subtitleOffsetKey(null)).toBeUndefined();
    expect(subtitleOffsetKey("screenshare://abc")).toBeUndefined();
    expect(subtitleOffsetKey("fileshare://abc")).toBeUndefined();
  });
});

describe("subtitle time scale", () => {
  it("accepts 0.9–1.1, rounded to 6 decimals", () => {
    expect(normalizeSubtitleScale(24 / 25)).toBe(0.96);
    expect(normalizeSubtitleScale(24000 / 1001 / 25)).toBe(0.959041);
    expect(normalizeSubtitleScale(1.0000001)).toBe(1);
    expect(normalizeSubtitleScale(0.9)).toBe(0.9);
    expect(normalizeSubtitleScale(1.1)).toBe(1.1);
  });

  it("rejects anything else", () => {
    for (const v of [0.89, 1.11, 0, -1, NaN, Infinity, "1", null, undefined]) {
      expect(normalizeSubtitleScale(v)).toBeUndefined();
    }
  });

  it("parses {offset, scale}", () => {
    expect(parseSubtitleTiming({ offset: 1.234, scale: 1 })).toEqual({
      offset: 1.25,
      scale: 1,
    });
    expect(parseSubtitleTiming({ offset: 1 })).toBeUndefined();
    expect(parseSubtitleTiming({ offset: 1, scale: 2 })).toBeUndefined();
    expect(parseSubtitleTiming([1, 1])).toBeUndefined();
    expect(parseSubtitleTiming(null)).toBeUndefined();
  });

  it("formats the chat line like before unless there's a scale", () => {
    expect(subtitleTimingChatMsg({ offset: 1.5, scale: 1 })).toBe("1.5");
    expect(subtitleTimingChatMsg({ offset: 1.5, scale: 0.96 })).toBe(
      '{"offset":1.5,"scale":0.96}',
    );
  });
});
