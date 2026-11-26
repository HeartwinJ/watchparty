import { describe, expect, it } from "vitest";
import {
  DURATION_REPORT_INTERVAL_MS,
  nextDurationReport,
} from "./durationReport";

const base = {
  media: "https://example.com/a.mp4",
  duration: 3600,
  isLive: false,
  hasDuration: true,
  now: 1000,
};

describe("nextDurationReport", () => {
  it("reports a new media's duration once, then again after the interval", () => {
    expect(nextDurationReport(null, base)).toBe(3600);
    const last = { media: base.media, duration: 3600, at: 1000 };
    expect(nextDurationReport(last, { ...base, now: 2000 })).toBeUndefined();
    expect(
      nextDurationReport(last, {
        ...base,
        now: 1000 + DURATION_REPORT_INTERVAL_MS,
      }),
    ).toBe(3600);
  });

  it("reports again when the media or duration changes", () => {
    const last = { media: base.media, duration: 3600, at: 1000 };
    expect(nextDurationReport(last, { ...base, duration: 1800 })).toBe(1800);
    expect(
      nextDurationReport(last, { ...base, media: "https://example.com/b.mp4" }),
    ).toBe(3600);
  });

  it("skips live streams, shares and unknown durations", () => {
    expect(nextDurationReport(null, { ...base, isLive: true })).toBeUndefined();
    expect(
      nextDurationReport(null, { ...base, hasDuration: false }),
    ).toBeUndefined();
    expect(
      nextDurationReport(null, { ...base, duration: NaN }),
    ).toBeUndefined();
    expect(
      nextDurationReport(null, { ...base, duration: Infinity }),
    ).toBeUndefined();
    expect(nextDurationReport(null, { ...base, duration: 0 })).toBeUndefined();
    expect(nextDurationReport(null, { ...base, media: "" })).toBeUndefined();
  });
});
