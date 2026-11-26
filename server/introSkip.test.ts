import { describe, expect, it } from "vitest";
import {
  introSkipFits,
  introSkipStart,
  IntroSkipTracker,
  normalizeSkipIntro,
  SKIP_INTRO_UNDO_WINDOW,
} from "./introSkip.ts";

const VIDEO = "https://example.com/show/s01e02.mkv";

describe("normalizeSkipIntro", () => {
  it("rounds to whole seconds and clamps to 0–600", () => {
    expect(normalizeSkipIntro(90)).toBe(90);
    expect(normalizeSkipIntro(0)).toBe(0);
    expect(normalizeSkipIntro(29.6)).toBe(30);
    expect(normalizeSkipIntro(-5)).toBe(0);
    expect(normalizeSkipIntro(10_000)).toBe(600);
  });

  it("rejects non-numbers", () => {
    expect(normalizeSkipIntro("90")).toBeUndefined();
    expect(normalizeSkipIntro(NaN)).toBeUndefined();
    expect(normalizeSkipIntro(Infinity)).toBeUndefined();
    expect(normalizeSkipIntro(null)).toBeUndefined();
  });
});

describe("introSkipFits", () => {
  it("needs at least 5 minutes and twice the skip", () => {
    expect(introSkipFits(90, 1440)).toBe(true);
    expect(introSkipFits(90, 299)).toBe(false);
    expect(introSkipFits(90, 300)).toBe(true);
    expect(introSkipFits(400, 700)).toBe(false);
    expect(introSkipFits(400, 800)).toBe(true);
  });

  it("never fits an unknown or infinite duration", () => {
    expect(introSkipFits(90, Infinity)).toBe(false);
    expect(introSkipFits(90, NaN)).toBe(false);
  });
});

describe("introSkipStart", () => {
  it("starts a video from the beginning at the skip", () => {
    expect(introSkipStart({ skipIntro: 90, video: VIDEO })).toBe(90);
    expect(
      introSkipStart({
        skipIntro: 90,
        video: "https://www.youtube.com/watch?v=abc",
      }),
    ).toBe(90);
  });

  it("is 0 when the setting is off", () => {
    expect(introSkipStart({ skipIntro: 0, video: VIDEO })).toBe(0);
  });

  it("keeps a non-zero start position (history resume, preload)", () => {
    expect(introSkipStart({ skipIntro: 90, video: VIDEO, from: 1234 })).toBe(
      1234,
    );
    expect(introSkipStart({ skipIntro: 90, video: VIDEO, from: 5 })).toBe(5);
  });

  it("never skips into screen/file shares, empty or non-http media", () => {
    expect(introSkipStart({ skipIntro: 90, video: "screenshare://abc" })).toBe(
      0,
    );
    expect(introSkipStart({ skipIntro: 90, video: "fileshare://abc" })).toBe(0);
    expect(introSkipStart({ skipIntro: 90, video: "" })).toBe(0);
    expect(introSkipStart({ skipIntro: 90, video: null })).toBe(0);
    expect(introSkipStart({ skipIntro: 90, video: "magnet:?xt=abc" })).toBe(0);
  });

  it("doesn't skip when a known duration is too short, ignores unknown ones", () => {
    expect(
      introSkipStart({ skipIntro: 90, video: VIDEO, knownDuration: 200 }),
    ).toBe(0);
    expect(
      introSkipStart({ skipIntro: 90, video: VIDEO, knownDuration: 1500 }),
    ).toBe(90);
    expect(
      introSkipStart({ skipIntro: 90, video: VIDEO, knownDuration: 0 }),
    ).toBe(90);
    expect(
      introSkipStart({ skipIntro: 90, video: VIDEO, knownDuration: null }),
    ).toBe(90);
  });

  it("sanitizes a bad stored setting", () => {
    expect(introSkipStart({ skipIntro: 9999, video: VIDEO })).toBe(600);
    expect(introSkipStart({ skipIntro: NaN, video: VIDEO })).toBe(0);
  });
});

describe("IntroSkipTracker", () => {
  const started = (seconds = 90) => {
    const t = new IntroSkipTracker();
    t.start(VIDEO, seconds);
    return t;
  };

  it("knows the active skip for the current video only", () => {
    const t = started();
    expect(t.active(VIDEO)).toBe(90);
    expect(t.active("https://example.com/other.mp4")).toBe(0);
    t.start(VIDEO, 0);
    expect(t.active(VIDEO)).toBe(0);
  });

  it("keeps the skip when the duration fits, once", () => {
    const t = started();
    expect(t.duration(VIDEO, 1440, 91)).toBe("keep");
    // Settled: later reports (every 30 s) don't do anything
    expect(t.duration(VIDEO, 100, 92)).toBeNull();
  });

  it("undoes the skip for a short video nobody has touched", () => {
    const t = started();
    expect(t.duration(VIDEO, 200, 92)).toBe("undo");
  });

  it("doesn't undo after a play/pause or once the room is well past the skip point", () => {
    const t = started();
    t.interact();
    expect(t.duration(VIDEO, 200, 92)).toBe("keep");
    const late = started();
    expect(late.duration(VIDEO, 200, 90 + SKIP_INTRO_UNDO_WINDOW + 1)).toBe(
      "keep",
    );
  });

  it("ignores reports for another video, bad durations, and after clear()", () => {
    const t = started();
    expect(t.duration("https://example.com/old.mp4", 200, 92)).toBeNull();
    expect(t.duration(VIDEO, "200", 92)).toBeNull();
    expect(t.duration(VIDEO, -1, 92)).toBeNull();
    expect(t.duration(VIDEO, Infinity, 92)).toBeNull();
    expect(t.clear()).toBe(true);
    expect(t.clear()).toBe(false);
    expect(t.duration(VIDEO, 200, 92)).toBeNull();
  });

  it("does nothing for a video that wasn't skipped", () => {
    const t = started(0);
    expect(t.duration(VIDEO, 200, 2)).toBeNull();
    expect(t.clear()).toBe(false);
  });
});
