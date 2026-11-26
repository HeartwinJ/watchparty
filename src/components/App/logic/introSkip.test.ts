import { describe, expect, it } from "vitest";
import {
  formatSkipIntro,
  INTRO_SKIP_NOTICE_MS,
  isSkipIntroPreset,
  showIntroSkipNotice,
  skipIntroPresetLabel,
} from "./introSkip";

describe("formatSkipIntro", () => {
  it("formats seconds as m:ss", () => {
    expect(formatSkipIntro(90)).toBe("1:30");
    expect(formatSkipIntro(45)).toBe("0:45");
    expect(formatSkipIntro(600)).toBe("10:00");
    expect(formatSkipIntro(65.4)).toBe("1:05");
    expect(formatSkipIntro(-3)).toBe("0:00");
  });
});

describe("skipIntroPresetLabel / isSkipIntroPreset", () => {
  it("labels the chips", () => {
    expect([0, 15, 30, 45, 60, 90, 120].map(skipIntroPresetLabel)).toEqual([
      "Off",
      "15s",
      "30s",
      "45s",
      "1:00",
      "1:30",
      "2:00",
    ]);
  });

  it("knows the presets", () => {
    expect(isSkipIntroPreset(90)).toBe(true);
    expect(isSkipIntroPreset(100)).toBe(false);
  });
});

describe("showIntroSkipNotice", () => {
  const info = { seconds: 90, at: 1000 };
  it("shows a fresh skip for a video with a duration", () => {
    expect(
      showIntroSkipNotice({ info, isLiveStream: false, now: 1000 + 500 }),
    ).toBe(true);
  });

  it("hides when there's none, after a while, or for a live stream", () => {
    expect(
      showIntroSkipNotice({ info: null, isLiveStream: false, now: 1000 }),
    ).toBe(false);
    expect(
      showIntroSkipNotice({
        info,
        isLiveStream: false,
        now: 1000 + INTRO_SKIP_NOTICE_MS,
      }),
    ).toBe(false);
    expect(showIntroSkipNotice({ info, isLiveStream: true, now: 1001 })).toBe(
      false,
    );
    expect(
      showIntroSkipNotice({
        info: { seconds: 0, at: 1000 },
        isLiveStream: false,
        now: 1001,
      }),
    ).toBe(false);
  });
});
