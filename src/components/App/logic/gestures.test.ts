import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOUBLE_TAP_MS,
  TapDetector,
  getTapZone,
  seekForZone,
} from "./gestures";

describe("getTapZone", () => {
  it("splits 40 / 20 / 40", () => {
    expect(getTapZone(0, 1000)).toBe("left");
    expect(getTapZone(399, 1000)).toBe("left");
    expect(getTapZone(400, 1000)).toBe("center");
    expect(getTapZone(500, 1000)).toBe("center");
    expect(getTapZone(600, 1000)).toBe("center");
    expect(getTapZone(601, 1000)).toBe("right");
    expect(getTapZone(1000, 1000)).toBe("right");
  });
  it("is centre for an unknown width", () => {
    expect(getTapZone(10, 0)).toBe("center");
    expect(getTapZone(10, NaN)).toBe("center");
  });
  it("maps zones to seeks", () => {
    expect(seekForZone("left")).toBe(-10);
    expect(seekForZone("right")).toBe(10);
    expect(seekForZone("center")).toBe(0);
  });
});

describe("TapDetector", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires a single tap after the window", () => {
    const single = vi.fn();
    const double = vi.fn();
    const d = new TapDetector<string>(single, double);
    d.tap("a", 0);
    expect(single).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(single).toHaveBeenCalledWith("a");
    expect(double).not.toHaveBeenCalled();
  });

  it("fires a double tap immediately, and no single", () => {
    const single = vi.fn();
    const double = vi.fn();
    const d = new TapDetector<string>(single, double);
    d.tap("a", 0);
    d.tap("b", 200);
    expect(double).toHaveBeenCalledWith("b");
    vi.advanceTimersByTime(1000);
    expect(single).not.toHaveBeenCalled();
  });

  it("treats taps further apart as two singles", () => {
    const single = vi.fn();
    const double = vi.fn();
    const d = new TapDetector<string>(single, double);
    d.tap("a", 0);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    d.tap("b", 400);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(single.mock.calls).toEqual([["a"], ["b"]]);
    expect(double).not.toHaveBeenCalled();
  });

  it("can be cancelled", () => {
    const single = vi.fn();
    const d = new TapDetector<string>(single, vi.fn());
    d.tap("a", 0);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(single).not.toHaveBeenCalled();
  });
});
