import { describe, expect, it } from "vitest";
import {
  getCatchUpPlaybackRate,
  getEffectiveDuration,
  getLeaderTime,
  getLocalSeekTarget,
  shouldAutoSyncRate,
  toRoomTime,
} from "./sync";

describe("getLeaderTime", () => {
  it("uses the furthest-ahead time with two or fewer people", () => {
    expect(getLeaderTime(2, { a: 10, b: 12 })).toBe(12);
    expect(getLeaderTime(1, { a: 5 })).toBe(5);
  });

  it("uses the median with more than two people", () => {
    expect(getLeaderTime(3, { a: 10, b: 100, c: 12 })).toBe(12);
    expect(getLeaderTime(4, { a: 10, b: 20, c: 12, d: 14 })).toBe(13);
  });

  it("is -Infinity with no timestamps (no valid seek target)", () => {
    expect(getLeaderTime(0, {})).toBe(-Infinity);
  });
});

describe("getCatchUpPlaybackRate", () => {
  it("plays at 1x when in sync, ahead, or less than 0.5s behind", () => {
    expect(getCatchUpPlaybackRate(10, 10)).toBe(1);
    expect(getCatchUpPlaybackRate(10, 12)).toBe(1);
    expect(getCatchUpPlaybackRate(10, 9.6)).toBe(1);
  });

  it("adds 0.01 per 100ms behind", () => {
    expect(getCatchUpPlaybackRate(10, 9)).toBe(1.1);
    expect(getCatchUpPlaybackRate(10, 9.4)).toBe(1.06);
  });

  it("caps at 1.1", () => {
    expect(getCatchUpPlaybackRate(100, 10)).toBe(1.1);
  });

  it("is 1 when our own time is unknown", () => {
    expect(getCatchUpPlaybackRate(10, undefined as unknown as number)).toBe(1);
  });
});

describe("shouldAutoSyncRate", () => {
  const base = {
    roomPaused: false,
    isLiveStream: false,
    hasDuration: true,
    roomPlaybackRate: 0,
  };
  it("applies only to playing, non-live media with a duration and auto rate", () => {
    expect(shouldAutoSyncRate(base)).toBe(true);
    expect(shouldAutoSyncRate({ ...base, roomPaused: true })).toBe(false);
    expect(shouldAutoSyncRate({ ...base, isLiveStream: true })).toBe(false);
    expect(shouldAutoSyncRate({ ...base, hasDuration: false })).toBe(false);
    expect(shouldAutoSyncRate({ ...base, roomPlaybackRate: 1.5 })).toBe(false);
  });
});

describe("toRoomTime", () => {
  it("sends the plain time for VOD", () => {
    expect(toRoomTime(42, false, 100)).toBe(42);
  });
  it("sends the offset from the live edge for live streams", () => {
    expect(toRoomTime(90, true, 100)).toBe(-10);
  });
});

describe("getLocalSeekTarget", () => {
  it("seeks to the given room time, else the leader", () => {
    expect(
      getLocalSeekTarget({
        roomTime: 5,
        leaderTime: 50,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBe(5);
    expect(
      getLocalSeekTarget({
        leaderTime: 50,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBe(50);
  });

  it("maps live offsets onto our own live edge", () => {
    expect(
      getLocalSeekTarget({
        roomTime: -10,
        leaderTime: 0,
        isLiveStream: true,
        duration: 1000,
      }),
    ).toBe(990);
    expect(
      getLocalSeekTarget({ leaderTime: 0, isLiveStream: true, duration: 1000 }),
    ).toBe(1000);
  });

  it("returns undefined for invalid targets", () => {
    expect(
      getLocalSeekTarget({
        leaderTime: -Infinity,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBeUndefined();
    expect(
      getLocalSeekTarget({
        roomTime: -1,
        leaderTime: 0,
        isLiveStream: false,
        duration: 100,
      }),
    ).toBeUndefined();
    expect(
      getLocalSeekTarget({
        leaderTime: 0,
        isLiveStream: true,
        duration: Infinity,
      }),
    ).toBeUndefined();
  });
});

describe("getEffectiveDuration", () => {
  const seekable = { length: 2, end: (i: number) => [50, 120][i] };
  it("uses the end of the seekable range for infinite live durations", () => {
    expect(getEffectiveDuration(Infinity, true, seekable)).toBe(120);
  });
  it("keeps the reported duration otherwise", () => {
    expect(getEffectiveDuration(300, false, seekable)).toBe(300);
    expect(getEffectiveDuration(Infinity, false, seekable)).toBe(Infinity);
    expect(
      getEffectiveDuration(Infinity, true, { length: 0, end: () => 0 }),
    ).toBe(Infinity);
    expect(getEffectiveDuration(80, true)).toBe(80);
  });
});
