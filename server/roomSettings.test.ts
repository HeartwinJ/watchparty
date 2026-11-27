import { describe, expect, it } from "vitest";
import {
  applyRoomSettingsPatch,
  createSettingsLimiter,
  DEFAULT_ROOM_SETTINGS,
  diffRoomSettings,
  normalizeNextEpisodeOffset,
  normalizeRoomSettings,
  normalizeRoomTitle,
  parseRoomSettingsPatch,
} from "./roomSettings.ts";

describe("normalizeRoomTitle", () => {
  it("trims, collapses whitespace and strips control characters", () => {
    expect(normalizeRoomTitle("  Movie   night \n")).toBe("Movie night");
    expect(normalizeRoomTitle("a\u0000b\u0007c\u001b[31m")).toBe("a b c [31m");
    expect(normalizeRoomTitle("left\u202Eright")).toBe("left right");
    expect(normalizeRoomTitle("   ")).toBe("");
  });

  it("limits to 60 characters without splitting emoji", () => {
    expect(normalizeRoomTitle("x".repeat(100))).toBe("x".repeat(60));
    const emoji = "🍿".repeat(70);
    const out = normalizeRoomTitle(emoji)!;
    expect(Array.from(out)).toHaveLength(60);
    expect(out).toBe("🍿".repeat(60));
  });

  it("rejects non-strings", () => {
    expect(normalizeRoomTitle(42)).toBeUndefined();
    expect(normalizeRoomTitle(null)).toBeUndefined();
  });
});

describe("normalizeNextEpisodeOffset", () => {
  it("clamps to 5–300 and rounds to whole seconds", () => {
    expect(normalizeNextEpisodeOffset(30)).toBe(30);
    expect(normalizeNextEpisodeOffset(0)).toBe(5);
    expect(normalizeNextEpisodeOffset(-10)).toBe(5);
    expect(normalizeNextEpisodeOffset(500)).toBe(300);
    expect(normalizeNextEpisodeOffset(29.6)).toBe(30);
  });

  it("rejects non-numbers", () => {
    expect(normalizeNextEpisodeOffset("30")).toBeUndefined();
    expect(normalizeNextEpisodeOffset(NaN)).toBeUndefined();
    expect(normalizeNextEpisodeOffset(Infinity)).toBeUndefined();
  });
});

describe("parseRoomSettingsPatch", () => {
  it("keeps valid keys and drops unknown or mistyped ones", () => {
    expect(
      parseRoomSettingsPatch({
        title: " Hi ",
        readyCheck: "yes",
        nextEpisodeOffset: 400,
        __proto__: { readyCheck: true },
        extra: 1,
      }),
    ).toEqual({ title: "Hi", nextEpisodeOffset: 300 });
    expect(parseRoomSettingsPatch({ readyCheck: true })).toEqual({
      readyCheck: true,
    });
    expect(
      parseRoomSettingsPatch({ autoSyncSubtitles: true, readyCheck: 0 }),
    ).toEqual({ autoSyncSubtitles: true });
    expect(parseRoomSettingsPatch({ autoSyncSubtitles: "on" })).toBeUndefined();
  });

  it("normalizes skip intro to whole seconds in 0–600", () => {
    expect(parseRoomSettingsPatch({ skipIntro: 90 })).toEqual({
      skipIntro: 90,
    });
    expect(parseRoomSettingsPatch({ skipIntro: 0 })).toEqual({ skipIntro: 0 });
    expect(parseRoomSettingsPatch({ skipIntro: 89.6 })).toEqual({
      skipIntro: 90,
    });
    expect(parseRoomSettingsPatch({ skipIntro: 5000 })).toEqual({
      skipIntro: 600,
    });
    expect(parseRoomSettingsPatch({ skipIntro: -3 })).toEqual({
      skipIntro: 0,
    });
    expect(parseRoomSettingsPatch({ skipIntro: "90" })).toBeUndefined();
    expect(parseRoomSettingsPatch({ skipIntro: NaN })).toBeUndefined();
  });

  it("returns undefined when nothing valid is left", () => {
    expect(parseRoomSettingsPatch(null)).toBeUndefined();
    expect(parseRoomSettingsPatch("title")).toBeUndefined();
    expect(parseRoomSettingsPatch([])).toBeUndefined();
    expect(parseRoomSettingsPatch({ readyCheck: 1 })).toBeUndefined();
  });
});

describe("normalizeRoomSettings", () => {
  it("gives the default for old rooms and fills gaps", () => {
    expect(normalizeRoomSettings(undefined)).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(DEFAULT_ROOM_SETTINGS).toEqual({
      title: "",
      readyCheck: true,
      nextEpisodeOffset: 25,
      autoSyncSubtitles: false,
      skipIntro: 0,
    });
    expect(normalizeRoomSettings({ title: "Friday", junk: true })).toEqual({
      title: "Friday",
      readyCheck: true,
      nextEpisodeOffset: 25,
      autoSyncSubtitles: false,
      skipIntro: 0,
    });
  });
});

describe("applyRoomSettingsPatch / diffRoomSettings", () => {
  it("reports only keys that changed", () => {
    const current = { ...DEFAULT_ROOM_SETTINGS };
    const noop = applyRoomSettingsPatch(current, {
      title: "",
      readyCheck: true,
    });
    expect(noop.changed).toEqual([]);
    expect(noop.settings).toBe(current);

    const res = applyRoomSettingsPatch(current, {
      title: "",
      nextEpisodeOffset: 30,
    });
    expect(res.changed).toEqual(["nextEpisodeOffset"]);
    expect(res.settings).toEqual({ ...current, nextEpisodeOffset: 30 });
    expect(diffRoomSettings(current, res.settings)).toEqual([
      "nextEpisodeOffset",
    ]);
  });
});

describe("createSettingsLimiter", () => {
  it("allows a burst, then waits for the window", () => {
    const limiter = createSettingsLimiter({ max: 3, windowMs: 1000 });
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1)).toBe(true);
    expect(limiter.allow(2)).toBe(true);
    expect(limiter.allow(3)).toBe(false);
    expect(limiter.allow(1001)).toBe(true);
  });
});
