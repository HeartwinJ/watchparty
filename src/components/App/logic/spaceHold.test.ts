import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPACE_HOLD_MS, SpaceHold } from "./spaceHold";

function make(canHold = true) {
  const onTap = vi.fn();
  const onHoldStart = vi.fn(() => canHold);
  const onHoldEnd = vi.fn();
  return {
    hold: new SpaceHold({ onTap, onHoldStart, onHoldEnd }),
    onTap,
    onHoldStart,
    onHoldEnd,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SpaceHold", () => {
  it("a quick press is a tap", () => {
    const h = make();
    h.hold.down();
    expect(h.hold.active).toBe(true);
    vi.advanceTimersByTime(SPACE_HOLD_MS - 1);
    h.hold.up();
    expect(h.onTap).toHaveBeenCalledTimes(1);
    expect(h.onHoldStart).not.toHaveBeenCalled();
    expect(h.hold.active).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(h.onHoldStart).not.toHaveBeenCalled();
  });

  it("a long press holds, ignores repeats and ends on release", () => {
    const h = make();
    h.hold.down();
    vi.advanceTimersByTime(SPACE_HOLD_MS);
    h.hold.down();
    expect(h.onHoldStart).toHaveBeenCalledTimes(1);
    h.hold.up();
    expect(h.onHoldEnd).toHaveBeenCalledTimes(1);
    expect(h.onTap).not.toHaveBeenCalled();
  });

  it("a long press that can't hold counts as a tap", () => {
    const h = make(false);
    h.hold.down();
    vi.advanceTimersByTime(SPACE_HOLD_MS);
    h.hold.up();
    expect(h.onHoldEnd).not.toHaveBeenCalled();
    expect(h.onTap).toHaveBeenCalledTimes(1);
  });

  it("cancel ends a hold without a tap; up without down does nothing", () => {
    const h = make();
    h.hold.up();
    h.hold.cancel();
    h.hold.down();
    h.hold.cancel();
    vi.advanceTimersByTime(1000);
    expect(h.onHoldStart).not.toHaveBeenCalled();
    h.hold.down();
    vi.advanceTimersByTime(SPACE_HOLD_MS);
    h.hold.cancel();
    h.hold.up();
    expect(h.onHoldEnd).toHaveBeenCalledTimes(1);
    expect(h.onTap).not.toHaveBeenCalled();
  });
});
