import { describe, expect, it } from "vitest";
import {
  calculateMedian,
  formatSize,
  formatTimestamp,
  isDirectVideoUrl,
  isEmojiString,
  isHls,
  isYouTube,
} from "./utils";

describe("formatTimestamp", () => {
  it.each([
    [0, "00:00"],
    [5, "00:05"],
    [65, "01:05"],
    [3661, "1:01:01"],
    [-65, "-01:05"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatTimestamp(input)).toBe(expected);
  });

  it.each([null, undefined, false, NaN, Infinity])(
    "returns empty string for %s",
    (input) => {
      expect(formatTimestamp(input)).toBe("");
    },
  );
});

describe("formatSize", () => {
  it.each([
    [500, "500 B"],
    [1500, "2 KB"],
    [2_500_000, "2.50 MB"],
    [93_947_973_227, "93.95 GB"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatSize(input)).toBe(expected);
  });
});

describe("URL classification", () => {
  it("detects YouTube", () => {
    expect(isYouTube("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYouTube("https://youtu.be/abc")).toBe(true);
    expect(isYouTube("https://example.com/v.mp4")).toBe(false);
  });

  it("detects HLS", () => {
    expect(isHls("https://cdn.example.com/live/index.m3u8?token=1")).toBe(true);
    expect(isHls("https://example.com/v.mp4")).toBe(false);
  });

  it("classifies direct video URLs", () => {
    expect(isDirectVideoUrl("https://example.com/movie.mp4")).toBe(true);
    expect(isDirectVideoUrl("https://example.com/index.m3u8")).toBe(false);
    expect(isDirectVideoUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isDirectVideoUrl("https://www.reddit.com/r/x/comments/1")).toBe(
      false,
    );
    expect(isDirectVideoUrl("screenshare://abc")).toBe(false);
  });
});

describe("calculateMedian", () => {
  it("handles empty, odd and even arrays", () => {
    expect(calculateMedian([])).toBe(0);
    expect(calculateMedian([3, 1, 2])).toBe(2);
    expect(calculateMedian([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("isEmojiString", () => {
  it("accepts only-emoji strings", () => {
    expect(isEmojiString("😀")).toBe(true);
    expect(isEmojiString("😀🎉")).toBe(true);
  });

  it("rejects text and empty input", () => {
    expect(isEmojiString("hi 😀")).toBe(false);
    expect(isEmojiString("")).toBe(false);
    expect(isEmojiString(undefined)).toBe(false);
  });
});
